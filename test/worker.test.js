/* ============================================================
   Cloudflare Worker entry: routing, origin policy, optional stats.

   The Durable Object itself needs the workerd runtime (hibernation API,
   WebSocketPair, alarms) and is exercised by `wrangler dev`, but the
   fetch handler is plain code — the parts that decide who gets in are
   testable here, with fetch/Request/Response from Node's undici.
   ============================================================ */
import test from "node:test";
import assert from "node:assert";
import { writeMatchStats } from "../src/worker/stats.js";

const load = () => import("../src/worker/index.js");
const req = (url, headers) => new Request(url, { headers: headers || {} });

/* A minimal D1 fake for the batched INSERT ... VALUES (?, ...) writeMatchStats
   issues: it reads the column list straight out of the SQL text and zips it
   with the bound args, so each captured row is a plain object keyed by
   column name — no column this fake wasn't told about ever appears on it. */
function fakeD1(captured) {
  return {
    prepare(sql) {
      const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map(s => s.trim());
      return {
        bind: (...args) => ({
          run: async () => { captured.push(Object.fromEntries(cols.map((c, i) => [c, args[i]]))); },
        }),
      };
    },
    batch: (stmts) => Promise.all(stmts.map(s => s.run())),
  };
}

test("/ws requires an upgrade header", async () => {
  const { default: worker } = await load();
  const res = await worker.fetch(req("https://trump.example/ws?room=ABCD"), {});
  assert.strictEqual(res.status, 426);
});

test("/ws rejects a cross-site origin but allows same-origin and non-browser clients", async () => {
  const { default: worker } = await load();
  const upgrade = { Upgrade: "websocket" };
  const hostile = await worker.fetch(
    req("https://trump.example/ws?room=ABCD", { ...upgrade, Origin: "https://evil.example" }), {});
  assert.strictEqual(hostile.status, 403, "an off-origin browser must not open a socket");

  // ALLOW_ORIGIN opts a specific site back in.
  // (The real DO answers 101; undici's Response can't construct that, so the stub answers 200.)
  let routed = false;
  const env = { ALLOW_ORIGIN: "https://evil.example", ROOMS: { idFromName: () => "id", get: () => ({ fetch: async () => { routed = true; return new Response(null, { status: 200 }); } }) } };
  const allowed = await worker.fetch(
    req("https://trump.example/ws?room=ABCD", { ...upgrade, Origin: "https://evil.example" }), env);
  assert.strictEqual(allowed.status, 200);
  assert.ok(routed, "allowed origin should reach the Durable Object");

  routed = false;
  await worker.fetch(req("https://trump.example/ws?room=ABCD", upgrade), // no Origin: CLI clients
    { ROOMS: env.ROOMS });
  assert.ok(routed, "non-browser clients (no Origin header) must still connect");
});

test("/ws needs a room code, and routes one DO per normalised code", async () => {
  const { default: worker } = await load();
  const upgrade = { Upgrade: "websocket" };
  const bad = await worker.fetch(req("https://trump.example/ws", upgrade), {});
  assert.strictEqual(bad.status, 400);

  const names = [];
  const env = { ROOMS: { idFromName: (n) => { names.push(n); return n; }, get: () => ({ fetch: async () => new Response(null, { status: 200 }) }) } };
  await worker.fetch(req("https://trump.example/ws?room=ab-cd", upgrade), env);
  await worker.fetch(req("https://trump.example/ws?room=ABCD", upgrade), env);
  assert.deepStrictEqual(names, ["ABCD", "ABCD"], "codes must normalise to one room");
});

test("/stats degrades to unavailable without a D1 binding, and reports totals with one", async () => {
  const { default: worker } = await load();
  const off = await (await worker.fetch(req("https://trump.example/stats?uid=abc"), {})).json();
  assert.deepStrictEqual(off, { available: false });

  const bound = [];
  const env = {
    DB: {
      prepare(sql) {
        return { bind: (...args) => { bound.push([sql, args]); return { first: async () => ({ games: 7, wins: 3, bidsWon: 2, bidsMade: 1 }) }; } };
      },
    },
  };
  const res = await (await worker.fetch(req("https://trump.example/stats?uid=player-1"), env)).json();
  assert.deepStrictEqual(res, { available: true, games: 7, wins: 3, bidsWon: 2, bidsMade: 1 });
  assert.strictEqual(bound[0][1][0], "player-1", "uid must be bound as a parameter, never interpolated");
  assert.ok(/WHERE uid = \?/.test(bound[0][0]), "stats query must be parameterised");

  const noUid = await worker.fetch(req("https://trump.example/stats"), env);
  assert.strictEqual(noUid.status, 400);

  // a D1 outage must not take the join screen down with it
  const brokenRes = await worker.fetch(req("https://trump.example/stats?uid=x"), {
    DB: { prepare() { throw new Error("d1 down"); } },
  });
  assert.deepStrictEqual(await brokenRes.json(), { available: false });
});

test("everything else falls through to static assets", async () => {
  const { default: worker } = await load();
  const env = { ASSETS: { fetch: async () => new Response("index", { status: 200 }) } };
  assert.strictEqual((await worker.fetch(req("https://trump.example/"), env)).status, 200);
  assert.strictEqual((await worker.fetch(req("https://trump.example/"), {})).status, 404); // no asset binding
  const health = await (await worker.fetch(req("https://trump.example/health"), env)).json();
  assert.deepStrictEqual(health, { ok: true });
});

test("stats count every deal's bids, not just the last one's", async () => {
  const captured = [];
  const env = { DB: fakeD1(captured) };
  const room = {
    code: "TEST",
    seatOwner: [ "p0", "p1", "p2", "p3" ],
    players: { p0: { uid: "u0", name: "A" }, p1: { uid: "u1", name: "B" },
               p2: { uid: "u2", name: "C" }, p3: { uid: "u3", name: "D" } },
    G: {
      phase: "matchOver", matchId: "abc12345", scores: [3, 1, 3, 1],
      dealHistory: [
        { roundNumber: 1, declarer: 0, partner: 2, bid: 150, made: true,  dPts: 160, winners: [0, 2] },
        { roundNumber: 2, declarer: 0, partner: 1, bid: 170, made: false, dPts: 140, winners: [2, 3] },
        { roundNumber: 3, declarer: 1, partner: 3, bid: 130, made: true,  dPts: 200, winners: [1, 3] },
      ],
      lastResult: { declarer: 1, made: true },
    },
  };
  await writeMatchStats(env, room);
  const seat0 = captured.find(r => r.uid === "u0");
  assert.equal(seat0.bids_won, 2, "seat 0 declared twice");
  assert.equal(seat0.bids_made, 1, "seat 0 made one of them");
  assert.equal(seat0.deals, 3);
  assert.equal(seat0.match_id, "abc12345");
  const seat1 = captured.find(r => r.uid === "u1");
  assert.equal(seat1.bids_won, 1);
  assert.equal(seat1.bids_made, 1);
  // the old columns must no longer be written at all
  assert.equal("was_declarer" in seat0, false);
});
