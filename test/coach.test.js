/* The coach's view→position adapter, checked against the server state it is
   reconstructing. If these two ever disagree, the browser's search is either
   weaker than the bot's (missing a public fact) or stronger than it should be. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/core/room/index.js";
import * as E from "../app/js/core/engine/index.js";
import { shadowFromView } from "../app/js/coach/shadow.js";
import { tableRead } from "../app/js/coach/read.js";
import { handleRequest } from "../app/js/coach/worker.js";

/* Seat four humans and drive the match with the engine's own AI, so every
   action is legal, sampling every seat's view after each event. */
function drive(onStep) {
  const room = R.createRoom("TEST");
  const pids = [];
  for (let i = 0; i < 4; i++) {
    const { pid } = R.join(room, { name: "P" + i }, 0);
    pids.push(pid);
    R.message(room, pid, { type: "sit", seat: i }, 0);
  }
  R.message(room, pids[0], { type: "start" }, 0);
  for (let step = 0; step < 5000 && room.G.phase !== "matchOver"; step++) {
    /* requiredActor() is null for "roundEnd" (it is a timed phase, not an actor
       one), so this has to run before that check, unconditionally — the ready
       gate lives inside drive(), which both message() and fireTimers() call,
       but only a "ready" message actually sets a player's ready flag. Checking
       this after taking an action (as the brief's version did) never fires: once
       the round ends there is no more action to take, so that branch is dead. */
    if (room.G.phase === "roundEnd") { for (const pid of pids) R.message(room, pid, { type: "ready" }, 0); continue; }
    const ra = E.requiredActor(room.G);
    if (!ra) { R.fireTimers(room, 1e9); continue; }
    const act = E.aiActionFor(room.G, ra.seat, "normal");
    R.message(room, pids[ra.seat], act, 0);
    onStep(room, pids);
  }
}

test("the shadow's public facts match the server's exactly", () => {
  let checked = 0;
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    for (let seat = 0; seat < 4; seat++) {
      const g = shadowFromView(R.buildView(room, pids[seat], 0));
      assert.ok(g, "a seated player's view must produce a position");
      assert.deepEqual(g.playedCards, room.G.playedCards, "playedCards drifted from the server's");
      assert.deepEqual(g.voids, room.G.voids, "derived voids drifted from the server's");
      assert.deepEqual(g.hands[seat], room.G.hands[seat], "my own hand must come through intact");
      for (const p of [0, 1, 2, 3]) assert.equal(g.hands[p].length, room.G.hands[p].length,
        `seat ${p}'s hand count is wrong`);
      checked++;
    }
  });
  assert.ok(checked > 200, `expected many sampled positions, got ${checked}`);
});

test("the shadow carries no foreign card", () => {
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const seat = 0;
    const g = shadowFromView(R.buildView(room, pids[seat], 0));
    const played = new Set(room.G.playedCards.map(c => c.suit + c.rank));
    for (const p of [1, 2, 3]) for (const c of g.hands[p])
      assert.equal(c, null, `seat ${p}'s placeholder held a real card`);
    for (const c of g.playedCards)
      assert.ok(played.has(c.suit + c.rank), "playedCards contains a card nobody played");
  });
});

test("a determinization off the shadow is legal and complete", () => {
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const g = shadowFromView(R.buildView(room, pids[1], 0));
    const world = E._determinize(g, 1, E.mulberry32(5));   // the barrel's name for determinize
    if (!world) return;                                   // rare, and the caller falls back
    for (const p of [0, 2, 3]) {
      assert.equal(world[p].length, room.G.hands[p].length, `seat ${p} dealt the wrong count`);
      for (const c of world[p]) assert.ok(c && c.suit && c.rank, "a placeholder survived into a world");
    }
  });
});

test("a spectator view yields no position", () => {
  const room = R.createRoom("TEST");
  const { pid } = R.join(room, { name: "watcher" }, 0);
  assert.equal(shadowFromView(R.buildView(room, pid, 0)), null);
});

test("a seated player yields no position before the match starts", () => {
  const room = R.createRoom("TEST");
  const { pid } = R.join(room, { name: "P0" }, 0);
  R.message(room, pid, { type: "sit", seat: 0 }, 0);
  const v = R.buildView(room, pid, 0);
  assert.equal(v.you.hand, undefined, "buildView only deals out a hand once room.started");
  assert.equal(shadowFromView(v), null);
});

test("points live plus points captured is always 250", () => {
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const r = tableRead(R.buildView(room, pids[0], 0));
    const taken = room.G.capturedPoints.reduce((a, b) => a + b, 0);
    assert.equal(r.pointsLive + taken, 250, "the table read lost points");
    assert.equal(r.captured.mine + r.captured.theirs, taken, "sides do not sum to what was captured");
  });
});

/* fallen tracks playedCards, which includes the trick still in flight; takenBy
   names a trick's winner, which nothing can before that trick resolves. So
   there is a real window — the bonus three led or sitting mid-trick, not yet
   the trick's last card — where fallen is true and takenBy is honestly still
   null. midTrickSamples pins that this window is actually exercised by the
   drive, not just theoretically possible: a branch a property test never
   reaches is a branch it never actually checked. */
test("the bonus three is reported exactly when it has fallen, and taken only once its trick resolves", () => {
  let midTrickSamples = 0;
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const v = R.buildView(room, pids[0], 0);
    const r = tableRead(v);
    const played = shadowFromView(v).playedCards.some(c => c.rank === 3 && c.suit === v.bonusSuit);
    // the trick that actually holds the bonus three, not just "some trick is settled" —
    // a wrong-trick winner would slip past a bare non-null check
    const bonusTrick = (v.tricks || []).find(t => t.cards.some(c => c.card.rank === 3 && c.card.suit === v.bonusSuit));
    assert.equal(r.bonus.fallen, played, "bonus.fallen must track the played cards, in-flight trick included");
    if (bonusTrick) {
      assert.ok(r.bonus.takenBy != null && r.bonus.takenBy >= 0, "a settled bonus must name its taker");
      assert.equal(r.bonus.takenBy, bonusTrick.winner, "the bonus must be credited to the trick it actually fell in");
    } else {
      assert.equal(r.bonus.takenBy, null, "nobody has taken the bonus until its trick resolves");
      if (played) midTrickSamples++;
    }
  });
  assert.ok(midTrickSamples > 0, "expected the fallen-but-unresolved window to occur at least once in this run");
});

test("outstanding counts exclude my own hand and everything played", () => {
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const v = R.buildView(room, pids[2], 0);
    const r = tableRead(v);
    for (const s of ["♠", "♥", "♦", "♣"]) {
      const mine = v.you.hand.filter(c => c.suit === s).length;
      const gone = room.G.playedCards.filter(c => c.suit === s).length;
      assert.equal(r.outstanding[s].count, 13 - mine - gone, `${s} outstanding count is wrong`);
    }
  });
});

/* captured.mine/.theirs, voids, outstanding.top and trumpLeft previously had no
   value-level regression coverage. The two identities the suite already checked
   (points live + captured == 250, mine + theirs == captured) hold no matter which
   side "mine" names — a mine/theirs swap would sail through both. This pins the
   side assignment against the view's own declarer/partner, and spot-checks
   outstanding.top / trumpLeft against values computed a different way than
   read.js computes them, so a shared bug in read.js can't hide behind a shared
   formula in the test. */
test("captured sides, voids, outstanding.top and trumpLeft are independently correct", () => {
  let checked = 0;
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const seat = 2;
    const v = R.buildView(room, pids[seat], 0);
    if (!v.teamsRevealed) return;
    const r = tableRead(v);
    const shadow = shadowFromView(v);

    const declaring = new Set([v.declarer, v.partner]);
    const declPts = [...declaring].reduce((s, p) => s + v.capturedPoints[p], 0);
    const restPts = [0, 1, 2, 3].filter(p => !declaring.has(p)).reduce((s, p) => s + v.capturedPoints[p], 0);
    const onDeclaringSide = declaring.has(seat);
    assert.equal(r.captured.mine, onDeclaringSide ? declPts : restPts,
      "captured.mine must be my own declarer/partner side's total");
    assert.equal(r.captured.theirs, onDeclaringSide ? restPts : declPts,
      "captured.theirs must be the opposing side's total");

    for (const entry of r.voids) {
      assert.notEqual(entry.seat, seat, "my own seat must never be reported as a known void");
      const want = E.SUITS.filter(s => shadow.voids[entry.seat][s]);
      assert.deepEqual(entry.suits.slice().sort(), want.slice().sort(), `voids for seat ${entry.seat} drifted`);
    }

    for (const s of E.SUITS) {
      const accounted = new Set();
      for (const c of v.you.hand) if (c.suit === s) accounted.add(c.rank);
      for (const c of shadow.playedCards) if (c.suit === s) accounted.add(c.rank);
      const remaining = E.RANKS.filter(rk => !accounted.has(rk));
      // Math.max rather than read.js's "RANKS is ascending, take the last
      // element" — a different technique, so an index bug there wouldn't
      // also be baked into this expectation.
      const wantTop = remaining.length ? Math.max(...remaining) : null;
      assert.equal(r.outstanding[s].top, wantTop, `${s}'s outstanding top drifted`);
    }

    if (v.trump) {
      const mine = v.you.hand.filter(c => c.suit === v.trump).length;
      const gone = shadow.playedCards.filter(c => c.suit === v.trump).length;
      assert.equal(r.trumpLeft, 13 - mine - gone, "trumpLeft drifted from an independently computed count");
    } else {
      assert.equal(r.trumpLeft, null, "trumpLeft must be null with no trump suit");
    }
    checked++;
  });
  assert.ok(checked > 0, "no positions with a revealed team were exercised");
});

test("the worker answers a hint request from a view alone", () => {
  let answered = 0;
  drive((room, pids) => {
    if (room.G.phase !== "playing" || answered > 3) return;
    const seat = room.G.turn;
    const v = R.buildView(room, pids[seat], 0);
    if (!v.you.toAct) return;
    const res = handleRequest({ id: 7, kind: "hint", view: v, seed: 42 });
    assert.equal(res.id, 7);
    assert.ok(res.ok, `hint failed: ${res.error}`);
    assert.ok(res.result.best && res.result.best.card, "a hint must name a card");
    const legal = v.you.legal.map(c => c.suit + c.rank);
    assert.ok(legal.includes(res.result.best.card.suit + res.result.best.card.rank),
      "the hint must be a legal card");
    answered++;
  });
  assert.ok(answered > 0, "no hint request was exercised");
});

test("the worker refuses a request it cannot serve", () => {
  const res = handleRequest({ id: 1, kind: "hint", view: { you: {} }, seed: 1 });
  assert.equal(res.ok, false);
  assert.ok(typeof res.error === "string" && res.error.length, "a failure must explain itself");
});

/* A bidding/trump/call view has a real dealt hand and a real seat — shadowFromView
   happily builds a position from it — so only an explicit phase/actKind check stops
   evaluateMoves from rolling out a non-"playing" position and quietly handing back an
   all-zero "best" card instead of refusing (playOutRound no-ops the instant
   sim.phase !== "playing", per ai/pimc.js). */
test("the worker refuses a hint request outside a card-play decision, even with a real dealt hand", () => {
  let checked = 0;
  drive((room, pids) => {
    if (room.G.phase === "playing" || checked > 3) return;
    const ra = E.requiredActor(room.G);
    if (!ra || ra.kind === "play") return;   // only the pre-play decisions: bid, trump, call
    const v = R.buildView(room, pids[ra.seat], 0);
    if (!v.you.toAct) return;
    assert.ok(Array.isArray(v.you.hand) && v.you.hand.length, "this decision point must carry a real hand");
    const res = handleRequest({ id: 3, kind: "hint", view: v, seed: 1 });
    assert.equal(res.ok, false, `a "${ra.kind}" decision must not answer a card-play hint`);
    assert.match(res.error, /card-play/i);
    checked++;
  });
  assert.ok(checked > 0, "no bid/trump/call decision point was exercised");
});

test("a seeded hint repeats", () => {
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const seat = room.G.turn;
    const v = R.buildView(room, pids[seat], 0);
    if (!v.you.toAct) return;
    const a = handleRequest({ id: 1, kind: "hint", view: v, seed: 9 });
    const b = handleRequest({ id: 2, kind: "hint", view: v, seed: 9 });
    assert.deepEqual(a.result, b.result, "same seed, same answer");
  });
});

// ---------------------------------------------------------------------------
// client.js — the promise facade itself. Every test above exercises
// handleRequest() directly; none of them touch client.js's own reason to
// exist: lazy construction, id correlation, timeout/error rejection, and the
// synchronous fallback. Node has no global Worker, so the fallback path is
// reachable with a plain import; the worker path needs a stand-in installed
// as globalThis.Worker before client.js's lazy getWorker() ever runs.
//
// client.js keeps module-scoped state (the pending Map, the cached worker),
// so every test below imports it through a uniquely-querystringed specifier
// — a distinct URL is a distinct ES module instance in Node, with its own
// fresh top-level state — rather than sharing the one import the rest of
// this file never even makes. That is what makes these tests independent of
// each other and of execution order, without needing a reset hook client.js
// itself has no other reason to export.
function oneToActView() {
  let found = null;
  drive((room, pids) => {
    if (found || room.G.phase !== "playing") return;
    const seat = room.G.turn;
    const v = R.buildView(room, pids[seat], 0);
    if (v.you.toAct) found = v;
  });
  return found;
}

/* A minimal stand-in for the real Worker API — just enough (postMessage,
   settable onmessage/onerror) for getWorker() to accept it as the real
   thing. .last always points at the most recently constructed instance, so
   a test can reach in and drive its callbacks by hand. */
class FakeWorker {
  constructor() { this.sent = []; FakeWorker.last = this; }
  postMessage(msg) { this.sent.push(msg); }
}

/* globalThis.Worker is a real global, shared by the whole process — unlike
   client.js's own state, a querystring import can't isolate it. Every test
   that sets it restores whatever was there before (nothing, in plain Node),
   so an earlier test's fake never leaks into a later one. */
async function withFakeWorker(WorkerClass, fn) {
  const saved = globalThis.Worker;
  globalThis.Worker = WorkerClass;
  try { await fn(); } finally {
    if (saved === undefined) delete globalThis.Worker; else globalThis.Worker = saved;
  }
}

/* assert.rejects on its own can hang forever if the promise under test never
   settles at all — a real failure mode, not a hypothetical one: writing the
   onError tests below, a mutation that dropped its p.reject(err) call hung
   the whole suite rather than failing one test. Racing against a short real
   timer (client.js's own timeouts are all mocked in these tests, so this
   never fires on a passing run) turns that into a fast, clear failure. */
async function rejectsWithin(promise, pattern, ms = 1000) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`expected a rejection within ${ms}ms, got none`)), ms));
  await Promise.race([pattern ? assert.rejects(promise, pattern) : assert.rejects(promise), timeout]);
}

test("client.js: with no Worker in this environment, coachAvailable is false and requests resolve via the sync fallback", async () => {
  delete globalThis.Worker; // Node has none anyway; explicit for a self-contained test
  const { requestHint, requestReview, coachAvailable } = await import("../app/js/coach/client.js?t=fallback-basic");
  assert.equal(coachAvailable(), false, "no Worker global means no live worker");
  const hint = await requestHint({ you: {} });
  assert.equal(hint.ok, false);
  assert.ok(typeof hint.error === "string" && hint.error.length, "a failed hint must explain itself");
  const review = await requestReview({ you: {} }, 0);
  assert.equal(review.ok, false);
  assert.ok(typeof review.error === "string" && review.error.length, "a failed review must explain itself");
});

test("client.js: requestHint resolves a real recommendation through the sync fallback end to end", async () => {
  delete globalThis.Worker;
  const { requestHint } = await import("../app/js/coach/client.js?t=fallback-happy");
  const v = oneToActView();
  assert.ok(v, "no to-act view captured");
  const res = await requestHint(v);
  assert.ok(res.ok, `hint failed: ${res.error}`);
  const legal = v.you.legal.map(c => c.suit + c.rank);
  assert.ok(legal.includes(res.result.best.card.suit + res.result.best.card.rank),
    "the fallback's hint must be a legal card");
});

test("client.js: a worker response resolves the correlated request, even answered out of order", async () => {
  await withFakeWorker(FakeWorker, async () => {
    const { requestHint } = await import("../app/js/coach/client.js?t=correlate");
    const pA = requestHint({ you: {}, tag: "A" });
    const pB = requestHint({ you: {}, tag: "B" });
    const w = FakeWorker.last;
    assert.equal(w.sent.length, 2, "both requests must reach the worker");
    const [msgA, msgB] = w.sent;
    assert.notEqual(msgA.id, msgB.id, "each request gets its own correlation id");
    // answer B first, then A: cross-wiring would show up as a swapped result
    w.onmessage({ data: { id: msgB.id, ok: true, result: { tag: "answerB" } } });
    w.onmessage({ data: { id: msgA.id, ok: true, result: { tag: "answerA" } } });
    const [resA, resB] = await Promise.all([pA, pB]);
    assert.equal(resA.result.tag, "answerA", "A's promise must resolve to A's own answer");
    assert.equal(resB.result.tag, "answerB", "B's promise must resolve to B's own answer");
  });
});

test("client.js: a duplicate or late worker message is a silent no-op, not a double-settle", async () => {
  await withFakeWorker(FakeWorker, async () => {
    const { requestHint } = await import("../app/js/coach/client.js?t=noop");
    const p = requestHint({ you: {} });
    const w = FakeWorker.last;
    const id = w.sent[0].id;
    const answer = { id, ok: true, result: { tag: "first" } };
    w.onmessage({ data: answer });
    const res = await p;
    assert.equal(res.result.tag, "first");
    // duplicate: pending no longer has this id, so a replay must be inert
    assert.doesNotThrow(() => w.onmessage({ data: answer }));
    // late: a stray id, as if some other already-settled request's answer arrived
    assert.doesNotThrow(() => w.onmessage({ data: { id: id + 999, ok: true, result: {} } }));
  });
});

test("client.js: a wedged worker's request rejects once the timeout elapses, not before", async (t) => {
  class HangingWorker { postMessage() {} } // never calls onmessage — simulates a stuck worker
  await withFakeWorker(HangingWorker, async () => {
    const { requestHint } = await import("../app/js/coach/client.js?t=timeout");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const p = requestHint({ you: {} });
    let settled = false;
    p.catch(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false, "must not settle before the timeout elapses");
    t.mock.timers.tick(10000);
    await assert.rejects(p, /timed out/, "a wedged worker must reject, not hang forever");
  });
});

test("client.js: a worker error event rejects the pending request instead of hanging", async () => {
  await withFakeWorker(FakeWorker, async () => {
    const { requestHint } = await import("../app/js/coach/client.js?t=error");
    const p = requestHint({ you: {} });
    const w = FakeWorker.last;
    w.onerror(new Error("simulated worker crash"));
    await rejectsWithin(p, /simulated worker crash/);
  });
});

/* Regression for a review finding: onError must discard the dead worker, not
   just reject what was pending — otherwise every request after a crash keeps
   posting into a worker that will never answer again, and pays the full
   timeout for it instead of falling back. Mock timers make that failure mode
   fast to detect here: if the fix ever regresses, request 2 goes back through
   the (dead) worker path and this test's own tick(10000) rejects it instead
   of silently hanging for 10 real seconds. */
test("client.js: after a worker error, the next request falls back to the synchronous path instead of hanging", async (t) => {
  await withFakeWorker(FakeWorker, async () => {
    const { requestHint, coachAvailable } = await import("../app/js/coach/client.js?t=fallback-after-error");
    assert.equal(coachAvailable(), true, "a fake worker is present, so the facade must report it live");
    const p1 = requestHint({ you: {} });
    const w = FakeWorker.last;
    w.onerror(new Error("crash"));
    await rejectsWithin(p1);
    assert.equal(coachAvailable(), false, "a worker that has errored must not still read as available");

    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sentBefore = w.sent.length;
    const p2 = requestHint({ you: {} });
    t.mock.timers.tick(10000); // a no-op if request 2 took the sync fallback; would fire the dead worker's timeout otherwise
    const res2 = await p2;
    assert.equal(w.sent.length, sentBefore, "the dead worker must never receive another postMessage");
    assert.equal(res2.ok, false); // { you: {} } isn't a real view — the point is it answered at all, synchronously
  });
});
