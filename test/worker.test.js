/* ============================================================
   Cloudflare Worker entry: routing, origin policy, optional stats.

   The Durable Object itself needs the workerd runtime (hibernation API,
   WebSocketPair, alarms) and is exercised by `wrangler dev`, but the
   fetch handler is plain code — the parts that decide who gets in are
   testable here, with fetch/Request/Response from Node's undici.
   ============================================================ */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
        return {
          bind: (...args) => {
            bound.push([sql, args]);
            return {
              first: async () => ({ games: 7, wins: 3, bidsWon: 2, bidsMade: 1 }),
              all: async () => ({ results: [] }), // no matches on record for the recent-form query
            };
          },
        };
      },
    },
  };
  const res = await (await worker.fetch(req("https://trump.example/stats?uid=player-1"), env)).json();
  assert.deepStrictEqual(res, { available: true, games: 7, wins: 3, bidsWon: 2, bidsMade: 1, recentForm: null });
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
    settings: { difficulty: "normal", targetDeals: 5, turnTimerSec: 45, coach: true },
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

test("writeMatchStats records the match's difficulty and whether it was mixed mid-match", async () => {
  const captured = [];
  const env = { DB: fakeD1(captured) };
  const room = {
    code: "TEST",
    settings: { difficulty: "hard", targetDeals: 5, turnTimerSec: 45, coach: true },
    seatOwner: [ "p0", "p1", "p2", "p3" ],
    players: { p0: { uid: "u0", name: "A" }, p1: { uid: "u1", name: "B" },
               p2: { uid: "u2", name: "C" }, p3: { uid: "u3", name: "D" } },
    G: {
      phase: "matchOver", matchId: "mix12345", scores: [3, 1, 3, 1],
      _difficultyMixed: true, // handlers.js sets this when the host switches tiers mid-match
      dealHistory: [
        { roundNumber: 1, declarer: 0, partner: 2, bid: 150, made: true, dPts: 160, winners: [0, 2] },
      ],
    },
  };
  await writeMatchStats(env, room);
  const seat0 = captured.find(r => r.uid === "u0");
  assert.equal(seat0.difficulty, "hard", "difficulty comes from room.settings, the value in effect at match end");
  assert.equal(seat0.difficulty_mixed, 1, "written as an integer, like won — D1/SQLite has no boolean type");

  // A match whose difficulty was never touched must write a clean 0, not an
  // undefined/falsy-but-wrong value — G._difficultyMixed is simply absent.
  const captured2 = [];
  const env2 = { DB: fakeD1(captured2) };
  const room2 = {
    code: "TEST",
    settings: { difficulty: "easy", targetDeals: 5, turnTimerSec: 45, coach: true },
    seatOwner: [ "p0", "p1", "p2", "p3" ],
    players: { p0: { uid: "u0", name: "A" }, p1: { uid: "u1", name: "B" },
               p2: { uid: "u2", name: "C" }, p3: { uid: "u3", name: "D" } },
    G: {
      phase: "matchOver", matchId: "clean1234", scores: [3, 1, 3, 1],
      dealHistory: [
        { roundNumber: 1, declarer: 0, partner: 2, bid: 150, made: true, dPts: 160, winners: [0, 2] },
      ],
    },
  };
  await writeMatchStats(env2, room2);
  const clean0 = captured2.find(r => r.uid === "u0");
  assert.equal(clean0.difficulty, "easy");
  assert.equal(clean0.difficulty_mixed, 0, "never marked mixed on G means a written 0, not undefined/null");
});

test("/stats recent form scopes to one difficulty instead of pooling — a fixture where pooling would read as improvement", async () => {
  const { default: worker } = await load();
  /* 5 EASY wins first (oldest), then 3 HARD matches most recently, won only
     once. Pooling all 8 reads like a strong 75% record; the truth for the
     tier the player is actually about to face (hard, since that's their most
     recent match) is 1-in-3 — exactly the "a run of easy matches would read
     as improvement" failure mode the brief warned about, just relocated from
     match length to difficulty. Already in ts-DESC order, as a real
     `ORDER BY ts DESC` would hand back. */
  const rows = [
    { ts: 3, difficulty: "hard", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
    { ts: 2, difficulty: "hard", difficulty_mixed: 0, won: 0, bids_won: 1, bids_made: 0 },
    { ts: 1, difficulty: "hard", difficulty_mixed: 0, won: 0, bids_won: 0, bids_made: 0 },
    { ts: -1, difficulty: "easy", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
    { ts: -2, difficulty: "easy", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
    { ts: -3, difficulty: "easy", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
    { ts: -4, difficulty: "easy", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
    { ts: -5, difficulty: "easy", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
  ];
  const totals = rows.reduce((a, r) => ({ games: a.games + 1, wins: a.wins + r.won,
    bidsWon: a.bidsWon + r.bids_won, bidsMade: a.bidsMade + r.bids_made }),
    { games: 0, wins: 0, bidsWon: 0, bidsMade: 0 });
  const env = { DB: {
    prepare() {
      return { bind: () => ({ first: async () => totals, all: async () => ({ results: rows }) }) };
    },
  } };
  const res = await (await worker.fetch(req("https://trump.example/stats?uid=player-1"), env)).json();
  assert.equal(res.available, true);
  assert.deepStrictEqual(res.recentForm, { difficulty: "hard", n: 3, wins: 1, bidsWon: 2, bidsMade: 1 },
    "scoped to the most recent tier only, not every row on record");
  assert.notEqual(res.recentForm.wins / res.recentForm.n, res.wins / res.games,
    "pooled and scoped must disagree, or this fixture proves nothing");
});

test("/stats recent form excludes matches flagged difficulty_mixed from the count", async () => {
  const { default: worker } = await load();
  const rows = [
    { ts: 4, difficulty: "hard", difficulty_mixed: 1, won: 1, bids_won: 1, bids_made: 1 }, // most recent, but mixed
    { ts: 3, difficulty: "hard", difficulty_mixed: 0, won: 0, bids_won: 0, bids_made: 0 },
    { ts: 2, difficulty: "hard", difficulty_mixed: 0, won: 0, bids_won: 0, bids_made: 0 },
    { ts: 1, difficulty: "hard", difficulty_mixed: 0, won: 0, bids_won: 0, bids_made: 0 },
  ];
  const env = { DB: {
    prepare() {
      return { bind: () => ({
        first: async () => ({ games: 4, wins: 1, bidsWon: 1, bidsMade: 1 }),
        all: async () => ({ results: rows }),
      }) };
    },
  } };
  const res = await (await worker.fetch(req("https://trump.example/stats?uid=player-1"), env)).json();
  assert.deepStrictEqual(res.recentForm, { difficulty: "hard", n: 3, wins: 0, bidsWon: 0, bidsMade: 0 },
    "the mixed match must not leak into the tier's count — n stays 3 (not 4), wins stays 0 (not 1)");
});

test("/stats recent form says nothing when the current tier does not have enough data yet", async () => {
  const { default: worker } = await load();
  const rows = [
    { ts: 12, difficulty: "hard", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
    { ts: 11, difficulty: "hard", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
    // only 2 "hard" matches — plenty of older "easy" history doesn't help,
    // since it isn't the tier a headline would even be about
    ...Array.from({ length: 10 }, (_, i) => ({ ts: i, difficulty: "easy", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 })),
  ];
  const env = { DB: {
    prepare() {
      return { bind: () => ({
        first: async () => ({ games: 12, wins: 12, bidsWon: 12, bidsMade: 12 }),
        all: async () => ({ results: rows }),
      }) };
    },
  } };
  const res = await (await worker.fetch(req("https://trump.example/stats?uid=player-1"), env)).json();
  // strictEqual, not equal: undefined == null is true under loose equality,
  // which would let this pass vacuously if the key were simply missing
  // instead of explicitly null.
  assert.strictEqual(res.recentForm, null, "2 same-tier matches is too little to say anything, even with 12 lifetime games");
});

/* ============================================================
   Fix round I2: /stats on a partially-migrated database.

   readRecentForm reads `difficulty`/`difficulty_mixed`, which
   migrations/0002-difficulty.sql adds. The totals query above it reads only
   columns 0001 already had. Awaiting both inside one try meant a database
   with 0001 but not 0002 threw out of a query that had already succeeded,
   and answered {available:false} — the pre-existing "Your record" line
   vanished, indistinguishable from having no database at all. That is the
   guaranteed state in any window between deploying the Worker and running
   0002, and the permanent state for anyone who applied only the migration
   the earlier era documented.

   The fake below knows exactly which columns its `matches` table has and
   fails a query naming any other, the way real D1 does — at execution, not
   at prepare. Real sqlite would be more faithful still, but node:sqlite
   does not exist on Node 20 and needs a flag on Node 22 (both in this
   repo's CI matrix) while `npm test` takes no flags — so the column sets
   are read straight out of schema.sql and the two migration files instead,
   which also means a third migration cannot leave this test describing a
   schema that no longer exists.

   It also honours ORDER BY and LIMIT rather than discarding the SQL: the
   older fakes in this file ignore their `prepare()` argument entirely, so
   deleting `ORDER BY ts DESC` from readRecentForm passed the whole suite
   even though "your most recent match's tier" is exactly what it rests on.
   ============================================================ */
const sqlRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sqlText = (f) => fs.readFileSync(path.join(sqlRoot, f), "utf8");
const addedBy = (f) => [...sqlText(f).matchAll(/ADD COLUMN\s+(\w+)/g)].map(m => m[1]);

// every column the current `matches` table has, off CREATE TABLE itself
const ALL_COLUMNS = (() => {
  const s = sqlText("schema.sql");
  const body = s.slice(s.indexOf("CREATE TABLE"), s.indexOf(");", s.indexOf("CREATE TABLE")));
  return [...body.matchAll(/^\s+(\w+)\s+(?:INTEGER|TEXT)\b/gm)].map(m => m[1]);
})();
const M0002 = addedBy("migrations/0002-difficulty.sql");
const M0001 = addedBy("migrations/0001-report-card.sql");
const AFTER_0002 = ALL_COLUMNS;
const AFTER_0001 = ALL_COLUMNS.filter(c => !M0002.includes(c));
const BEFORE_ANY = AFTER_0001.filter(c => !M0001.includes(c));

function migratedD1(columns, rows) {
  const have = new Set(columns);
  const seen = [];
  return {
    seen,
    prepare(sql) {
      seen.push(sql);
      const missing = ALL_COLUMNS.filter(c => new RegExp(`\\b${c}\\b`).test(sql) && !have.has(c));
      if (missing.length) {
        const fail = async () => { throw new Error(`D1_ERROR: no such column: ${missing[0]}`); };
        return { bind: () => ({ first: fail, all: fail, run: fail }) };
      }
      return { bind: () => ({
        first: async () => rows.reduce((a, r) => ({
          games: a.games + 1, wins: a.wins + r.won,
          bidsWon: a.bidsWon + r.bids_won, bidsMade: a.bidsMade + r.bids_made,
        }), { games: 0, wins: 0, bidsWon: 0, bidsMade: 0 }),
        // ORDER BY / LIMIT are the database's job, and readRecentForm trusts
        // it to have done it — rows[0] is "your most recent match". Modelled,
        // not assumed: with no ORDER BY in the SQL a real database is free to
        // hand back any order at all, which insertion order stands in for.
        all: async () => {
          let out = rows.slice();
          const ord = /ORDER BY (\w+) (ASC|DESC)/i.exec(sql);
          if (ord) out.sort((a, b) => (ord[2].toUpperCase() === "DESC" ? b[ord[1]] - a[ord[1]] : a[ord[1]] - b[ord[1]]));
          const lim = /LIMIT (\d+)/i.exec(sql);
          if (lim) out = out.slice(0, Number(lim[1]));
          return { results: out };
        },
      }) };
    },
  };
}

// Three of one tier and three of another, so both a scoped answer and a
// pooled one exist and differ — enough same-tier rows to clear
// MIN_RECENT_FORM either way, in ts-ascending (i.e. NOT query) order.
const FORM_ROWS = [
  { ts: 1, difficulty: "easy", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
  { ts: 2, difficulty: "easy", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
  { ts: 3, difficulty: "easy", difficulty_mixed: 0, won: 1, bids_won: 1, bids_made: 1 },
  { ts: 4, difficulty: "hard", difficulty_mixed: 0, won: 0, bids_won: 2, bids_made: 0 },
  { ts: 5, difficulty: "hard", difficulty_mixed: 0, won: 0, bids_won: 2, bids_made: 0 },
  { ts: 6, difficulty: "hard", difficulty_mixed: 0, won: 0, bids_won: 2, bids_made: 0 },
];

test("/stats keeps the totals when only the recent-form query's migration is missing", async () => {
  const { default: worker } = await load();
  const url = "https://trump.example/stats?uid=player-1";

  // Fully migrated: both halves answer. Establishes that this fixture WOULD
  // produce a recent-form line — without which the partial case below proves
  // nothing, since "absent" and "never there" would look identical.
  const full = await (await worker.fetch(req(url), { DB: migratedD1(AFTER_0002, FORM_ROWS) })).json();
  assert.strictEqual(full.available, true);
  assert.strictEqual(full.games, 6);
  assert.ok(full.recentForm, "the fixture must yield a recent-form line on a fully-migrated database");

  // 0001 but not 0002: the recent-form query fails, the totals query does not.
  const partial = await (await worker.fetch(req(url), { DB: migratedD1(AFTER_0001, FORM_ROWS) })).json();
  assert.strictEqual(partial.available, true,
    "a successful totals fetch must not be thrown away because the newer query failed — " +
    "the whole 'Your record' line disappears, reading exactly like no database at all");
  assert.strictEqual(partial.games, full.games);
  assert.strictEqual(partial.wins, full.wins);
  assert.strictEqual(partial.bidsWon, full.bidsWon);
  assert.strictEqual(partial.bidsMade, full.bidsMade);
  // …and the one line that genuinely could not be read is absent, not guessed.
  assert.strictEqual(partial.recentForm, null,
    "recent form must degrade to null on its own, never to a number the database could not supply");

  // No migrations at all: the totals query fails too, and {available:false}
  // is then the honest answer rather than a regression.
  const bare = await (await worker.fetch(req(url), { DB: migratedD1(BEFORE_ANY, FORM_ROWS) })).json();
  assert.deepStrictEqual(bare, { available: false });
});

test("the recent-form query asks the database for the ordering it then trusts", async () => {
  const { default: worker } = await load();
  const db = migratedD1(AFTER_0002, FORM_ROWS);
  const res = await (await worker.fetch(req("https://trump.example/stats?uid=player-1"), { DB: db })).json();

  const formSql = db.seen.find(s => /difficulty_mixed/.test(s));
  assert.ok(formSql, "the recent-form query never reached the database");
  assert.match(formSql, /ORDER BY ts DESC/,
    "readRecentForm reads rows[0].difficulty as 'your most recent match's tier' — " +
    "without ORDER BY ts DESC that is whichever row the database felt like returning first");
  assert.match(formSql, /WHERE uid = \?/, "the recent-form query must be parameterised too");

  /* And behaviourally, not only as text: FORM_ROWS is supplied oldest-first,
     so insertion order and ts order disagree about which tier is current.
     Ordered, the newest three are "hard" (0 wins of 3). Unordered, rows[0]
     is the oldest "easy" row and the answer would be the easy tier's 3-of-3
     instead — a different tier AND a different record. */
  assert.deepStrictEqual(res.recentForm, { difficulty: "hard", n: 3, wins: 0, bidsWon: 6, bidsMade: 0 },
    "the tier reported must be the most recent match's, not the oldest's");
});
