"use strict";
/* ============================================================
   Cloudflare Worker entry: routing, origin policy, optional stats.

   The Durable Object itself needs the workerd runtime (hibernation API,
   WebSocketPair, alarms) and is exercised by `wrangler dev`, but the
   fetch handler is plain code — the parts that decide who gets in are
   testable here, with fetch/Request/Response from Node's undici.
   ============================================================ */
const test = require("node:test");
const assert = require("node:assert");

const load = () => import("../src/worker.js");
const req = (url, headers) => new Request(url, { headers: headers || {} });

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
