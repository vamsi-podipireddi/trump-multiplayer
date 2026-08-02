/* The coach's view→position adapter, checked against the server state it is
   reconstructing. If these two ever disagree, the browser's search is either
   weaker than the bot's (missing a public fact) or stronger than it should be. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "../src/core/room/index.js";
import * as E from "../app/js/core/engine/index.js";
import { shadowFromView } from "../app/js/coach/shadow.js";
import { tableRead, coachOn } from "../app/js/coach/read.js";
import { handleRequest, gradeOneDeal } from "../app/js/coach/worker.js";
import { reviewDeal, REVIEW_PLAY_BUDGET, MISTAKE_WIN_DELTA } from "../app/js/coach/review.js";
import { matchReport } from "../app/js/coach/report.js";
import { reviewAuction, MIN_REVIEW_WORLDS, auctionBudgetFor, bandFor, clampToBand, decide } from "../app/js/coach/auction.js";
/* Deliberate exception to "consumers import the barrel" (docs/STRUCTURE.md
   rule 1), the same one test/ai.test.js:16 already takes and for the same
   reason: worldsFor is a tuning-internal deliberately kept off the barrel,
   and it is exported from its own module precisely so nothing forks the
   formula — which the review's band guard did, until fix round I6. Importing
   the real one is the whole point. */
import { worldsFor } from "../app/js/core/engine/ai/bid-search.js";
import { snapshotOf } from "../app/js/util/deals.js";
import { describeReport, renderReport } from "../app/js/ui/coach.js";

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

/* A finished deal's view for the seat that declared it, driven by the engine's
   own AI so every action is legal. drive()'s own comment above explains why
   onStep never actually observes phase "roundEnd" (it is reached only through
   a fired timer, with no action — and so no onStep call — in between). Reaching
   the *match's* own end sidesteps that the same way review.js's finishedDeal()
   already does: capture (room, pids) once, on the very first step, and read
   them back only after drive() itself returns. By then room.G.phase is
   "matchOver" and room.G.declarer/G.auction/G.tricks still hold exactly the
   last deal played — a real, finished, fully public deal either way. */
function finishedDealView() {
  let ref = null;
  drive((room, pids) => { if (!ref) ref = { room, pids }; });
  assert.ok(ref, "a deal must have finished");
  const seat = ref.room.G.declarer;
  return { v: R.buildView(ref.room, ref.pids[seat], 0), seat };
}

/* Five consecutive passed-out auctions force the eldest to the minimum. */
function forcedBidView() {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  while (G.phase === "bidding") E.applyBid(G, E.findBidActor(G), null);
  assert.ok(G.auction.some(a => a.forced), "the auction must have been forced");
  const seat = G.declarer;
  E.applyTrump(G, E.SUITS[0]);
  E.applyCall(G, E.callableCards(G, seat)[0]);
  while (G.phase !== "roundEnd" && G.phase !== "matchOver") {
    if (G.phase === "trickEnd") { E.advanceTrick(G); continue; }
    const ra = E.requiredActor(G);
    E.applyPlay(G, ra.seat, E.legalCards(G, ra.seat)[0]);
  }
  return { v: E.publicView(G), seat };
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

/* The test above only samples phase "playing", where the auction's own fields
   are dead. The bid hint is not: worker.js searches the shadow mid-auction, and
   bid-search.js's playOutWith needs a contract to roll out against — it takes
   minNextBid(G) whenever G.bid is null, which it is for the whole auction.
   minNextBid is `G.highBid === null ? MIN_BID : G.highBid + BID_STEP`, and
   `undefined === null` is false, so a shadow missing the field does not fall
   back to the minimum: it returns NaN, silently, at every bidding turn. Checked
   against the server's own answer, which is the only thing that makes it a fact
   rather than a second opinion. */
test("the shadow answers minNextBid exactly as the server does, all through the auction", () => {
  let checked = 0;
  drive((room, pids) => {
    if (room.G.phase !== "bidding") return;
    const ra = E.requiredActor(room.G);
    if (!ra) return;
    const g = shadowFromView(R.buildView(room, pids[ra.seat], 0));
    assert.equal(E.minNextBid(g), E.minNextBid(room.G),
      "the shadow's next legal bid drifted from the server's — the bid hint rolls out against this number");
    checked++;
  });
  assert.ok(checked > 20, `expected many bidding turns, got ${checked}`);
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

/* The one invariant the room setting's design leans on hardest: a room persisted
   before `coach` existed has no key at all, and that must read the same as an
   explicit `true` — never as `false`. Direct assertions on the predicate itself,
   not on a room or a view, because this is the one thing about it that a DOM-only
   read site (lobby.js, game.js) can't be tested through at all. */
test("coachOn: absent — whether no settings object or no key — reads on; only strict false reads off", () => {
  assert.equal(coachOn(undefined), true, "no settings object at all");
  assert.equal(coachOn({}), true, "a room restored from storage predating this field");
  assert.equal(coachOn({ coach: true }), true);
  assert.equal(coachOn({ coach: false }), false, "the one value that actually turns hints off");
  assert.equal(coachOn({ coach: "yes" }), true, "a non-boolean is not a ban either — only strict false is");
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

/* Task 10: the hint branch above now answers bid/trump/call too, sharing
   ai/bid-search.js's search — a bidding/trump/call view has a real dealt hand
   and a real seat, shadowFromView happily builds a position from it, and
   neither bidValue nor aiPickTrumpSearch/aiPickPartnerSearch has a phase check
   of its own, so this is the one place the answer could quietly come from the
   wrong search entirely. One instance of each kind, not a full sweep: trump
   and call default to TRUMP_PLAY_BUDGET/CALL_PLAY_BUDGET-sized searches
   (bid-search.js's own tuning comment), and a full match's worth of those
   would make this test itself the slow one. */
test("the worker answers a bid/trump/call hint request from a view alone", () => {
  const seen = new Set();
  drive((room, pids) => {
    if (seen.size >= 3) return;
    const ra = E.requiredActor(room.G);
    if (!ra || ra.kind === "play" || seen.has(ra.kind)) return;
    const v = R.buildView(room, pids[ra.seat], 0);
    if (!v.you.toAct) return;
    assert.ok(Array.isArray(v.you.hand) && v.you.hand.length, "this decision point must carry a real hand");
    const res = handleRequest({ id: 3, kind: "hint", view: v, seed: 1 });
    assert.ok(res.ok, `${ra.kind} hint failed: ${res.error}`);
    assert.equal(res.result.kind, ra.kind);
    if (ra.kind === "bid") {
      assert.equal(res.result.target, v.you.minBid, "a bid hint must be about the bid actually on offer");
      assert.ok(res.result.makeProb >= 0 && res.result.makeProb <= 1, "makeProb must be a probability");
      assert.ok(Number.isFinite(res.result.median));
    }
    if (ra.kind === "trump") assert.ok(E.SUITS.includes(res.result.suit), "a trump hint must name a real suit");
    if (ra.kind === "call") {
      assert.ok(res.result.card && E.SUITS.includes(res.result.card.suit), "a call hint must name a real card");
      assert.ok(!v.you.hand.some(c => c.suit === res.result.card.suit && c.rank === res.result.card.rank),
        "a called card must never be one the caller already holds");
    }
    seen.add(ra.kind);
  });
  assert.deepEqual([...seen].sort(), ["bid", "call", "trump"], "expected to exercise all three auction decisions");
});

/* trickEnd/roundEnd/matchOver never hand anyone a decision (requiredActor()
   returns null or a timed phase, per flow.js), so PHASE_FOR_ACT admits none of
   them — this is what stops a stray request from one of those phases getting
   an answer built from whatever G.phase happened to be instead of a refusal. */
test("the worker refuses a hint request when no decision is on offer", () => {
  let checked = 0;
  drive((room, pids) => {
    if (checked > 3 || !["trickEnd", "roundEnd", "matchOver"].includes(room.G.phase)) return;
    const v = R.buildView(room, pids[0], 0);
    const res = handleRequest({ id: 9, kind: "hint", view: v, seed: 1 });
    assert.equal(res.ok, false, `"${room.G.phase}" must not answer a hint`);
    checked++;
  });
  assert.ok(checked > 0, "no dead-decision phase was exercised");
});

/* Capped per kind, not per run: a global "stop at 4 total" cap (one check per
   kind) would let a single "play" trial stand in for the dozens of distinct
   hands the pre-Task-10 version of this test actually exercised — breadth
   (four kinds) without depth (one trial each) is a strictly weaker test. Each
   kind gets its own budget instead, so "play" and "bid" — which recur many
   times over a drive() run — get checked repeatedly, while the once-per-deal
   kinds (trump/call) still get at least one and, on a long enough run, several. */
const REPRO_CAP_PER_KIND = 6;
test("a seeded hint repeats", () => {
  const seen = new Set();
  const checkedPerKind = { bid: 0, trump: 0, call: 0, play: 0 };
  drive((room, pids) => {
    const ra = E.requiredActor(room.G);
    if (!ra || checkedPerKind[ra.kind] >= REPRO_CAP_PER_KIND) return;
    const v = R.buildView(room, pids[ra.seat], 0);
    if (!v.you.toAct) return;
    const a = handleRequest({ id: 1, kind: "hint", view: v, seed: 9 });
    const b = handleRequest({ id: 2, kind: "hint", view: v, seed: 9 });
    assert.deepEqual(a.result, b.result, `same seed, same answer (${ra.kind})`);
    assert.ok(a.ok, `${ra.kind} hint failed: ${a.error}`);
    checkedPerKind[ra.kind]++;
    seen.add(ra.kind);
  });
  assert.deepEqual([...seen].sort(), ["bid", "call", "play", "trump"], "expected to exercise all four decision kinds");
  // play and bid recur often enough within a single match that the cap itself
  // must be what stops them, not the match running out first — pins the
  // depth restoration, not just the kind breadth the assertion above already
  // covers.
  assert.equal(checkedPerKind.play, REPRO_CAP_PER_KIND, "expected 'play' to be checked more than the single trial the Task 10 rewrite left it with");
  assert.equal(checkedPerKind.bid, REPRO_CAP_PER_KIND, "expected 'bid' to be checked more than once");
});

// ---------------------------------------------------------------------------
// review.js — post-deal review. A finished deal is fully public: v.tricks
// holds all 13 tricks x 4 cards, each tagged with its player, so a review
// reconstructs the position seat actually faced at each of its own decision
// points from that record alone and re-searches it. The tests below check
// three things: the shape of a review (every real decision, and only real
// decisions), that it is reproducible, and — the property review.js's whole
// claim to honesty rests on — that no position it hands the search ever
// carries a card, void, or count seat could not yet have known.

/* Play a deal to completion, then review it from seat 0's chair. drive()'s
   onStep only ever fires right after an action (bid/trump/call/play) — and
   reaching "roundEnd" happens through a fired timer instead, which is
   exactly why drive() itself stopped checking for "roundEnd" the same way
   (see its own comment above) — so there is no step at which onStep
   observes phase==="roundEnd". Driving to the *match's* own end instead
   sidesteps that: once drive() returns, room.G.phase is "matchOver" and
   room.G.tricks (reset at the start of every deal) holds exactly the last
   deal played — a real, finished, fully public deal either way. */
function finishedDeal() {
  let ref = null;
  drive((room, pids) => { if (!ref) ref = { room, pids }; });
  return R.buildView(ref.room, ref.pids[0], 0);
}

test("a review covers every real decision and nothing else", () => {
  const v = finishedDeal();
  assert.ok(v, "no finished deal was captured");
  const r = reviewDeal(v, 0, { seed: 3 });
  assert.ok(r.decisions.length > 0 && r.decisions.length <= 13, `implausible count ${r.decisions.length}`);
  for (const d of r.decisions) {
    assert.ok(d.trickNo >= 1 && d.trickNo <= 13);
    assert.ok(d.delta >= 0, "a decision cannot beat the search's own best");
    assert.ok(["blunder", "mistake", "fine"].includes(d.grade));
  }
  assert.ok(r.worst.length <= 2);
  assert.ok(r.samples > 0, "a review of a real deal must have sampled at least one world somewhere");
});

test("a review is reproducible", () => {
  const v = finishedDeal();
  assert.deepEqual(reviewDeal(v, 0, { seed: 5 }), reviewDeal(v, 0, { seed: 5 }));
});

/* Independent ground truth for "what seat actually knew, right before each of
   its own plays": shadowFromView applied to the *real* intermediate view built
   live during a drive, not anything review.js derives — the same trusted
   derivation the rest of this file checks against the server, not a second
   copy of review.js's own logic that could share its bugs.

   Unlike finishedDeal() above, this can't reuse drive()'s onStep: onStep
   fires only after an action, but the step where seat *becomes* a new
   trick's leader happens via a fired timer (advanceTrick), with no action —
   and so no onStep call — in between, and by the next onStep call seat has
   already led. So this drives the match itself, capturing right where
   drive() calls E.requiredActor(), before that action is applied. Keyed by
   trickNo using the identity shadow.js documents (trickNumber === completed
   tricks while phase is "playing"). */
function finishedDealWithLiveTruth(seat) {
  const room = R.createRoom("TEST");
  const pids = [];
  for (let i = 0; i < 4; i++) {
    const { pid } = R.join(room, { name: "P" + i }, 0);
    pids.push(pid);
    R.message(room, pid, { type: "sit", seat: i }, 0);
  }
  R.message(room, pids[0], { type: "start" }, 0);
  const live = {};
  for (let step = 0; step < 5000 && room.G.phase !== "matchOver"; step++) {
    if (room.G.phase === "roundEnd") { for (const pid of pids) R.message(room, pid, { type: "ready" }, 0); continue; }
    const ra = E.requiredActor(room.G);
    if (!ra) { R.fireTimers(room, 1e9); continue; }
    if (ra.kind === "play" && ra.seat === seat) {
      const v = R.buildView(room, pids[seat], 0);
      if (v.you.toAct) live[(v.tricks || []).length + 1] = shadowFromView(v);
    }
    R.message(room, pids[ra.seat], E.aiActionFor(room.G, ra.seat, "normal"), 0);
  }
  return { v: R.buildView(room, pids[0], 0), live };
}

test("the review never sees a card the player could not", () => {
  /* The brief's own version of this test only asserts a position's card
     count against the prefix it should carry — that rules out the crude
     leak (a position built from the whole deal instead of a prefix), but it
     would not catch a subtler one: an implementation that gets the count
     right while still smuggling in a fact only a later trick reveals — a
     void inferred one trick early, an opponent hand length that already
     reflects a card not yet played, or (what this file's own early draft
     actually had, caught by exactly this test) capturedPoints/tricksWon that
     already carry the deal's own final outcome, or a copied-through v.phase
     that silently turns every rollout into a no-op so every card grades
     identically. A count can't see any of that. So alongside the count
     check, tap compares every position against the real position seat held
     at that exact moment, captured live during an actual drive — not a
     second derivation that could share review.js's own bugs. */
  const { v, live } = finishedDealWithLiveTruth(0);
  assert.ok(v, "no finished deal was captured");
  const keys = cs => cs.map(c => (c ? c.suit + c.rank : "null")).sort(); // hand contents, not order: shadow.js's live hand is suit-sorted, review.js's is reconstructed in play order
  let compared = 0;
  const r = reviewDeal(v, 0, { seed: 5, _tap: (pos, trickNo) => {
    assert.ok(pos.playedCards.length <= (trickNo - 1) * 4 + 3,
      `position at trick ${trickNo} carried ${pos.playedCards.length} played cards — it saw the future`);
    for (const c of pos.hands[0]) assert.ok(c && c.suit, "my own hand must be real at every point");

    const truth = live[trickNo];
    assert.ok(truth, `no live snapshot captured for trick ${trickNo}`);
    // rolloutClone/playOutRound gate every simulated play on phase==="playing";
    // a leaked-through "roundEnd" would make every legal card score
    // identically instead of throwing, so nothing above would ever catch it.
    assert.equal(pos.phase, "playing");
    assert.equal(pos.phase, truth.phase);
    assert.deepEqual(pos.voids, truth.voids, `voids at trick ${trickNo} disagree with the live position`);
    assert.deepEqual(pos.playedCards, truth.playedCards, `playedCards at trick ${trickNo} disagree with the live position`);
    assert.deepEqual(pos.capturedPoints, truth.capturedPoints, `capturedPoints at trick ${trickNo} leaked the deal's own outcome`);
    assert.deepEqual(pos.tricksWon, truth.tricksWon, `tricksWon at trick ${trickNo} leaked the deal's own outcome`);
    // scores is inert to today's search (nothing in ai/pimc.js or ai/heuristic.js
    // reads it back), but preRoundScores() still exists to keep it that way
    // honestly rather than by accident — this is the one place that gets
    // codified instead of only checked out-of-band during review.
    assert.deepEqual(pos.scores, truth.scores, `scores at trick ${trickNo} leaked this round's own outcome`);
    assert.deepEqual(pos.trick, truth.trick, `the trick in progress at ${trickNo} disagrees with the live position`);
    assert.equal(pos.leadSuit, truth.leadSuit, `leadSuit at trick ${trickNo} disagrees with the live position`);
    assert.equal(pos.trickNumber, truth.trickNumber);
    assert.equal(pos.leader, truth.leader);
    assert.equal(pos.lastWinner, truth.lastWinner);
    for (const p of [0, 1, 2, 3]) assert.deepEqual(keys(pos.hands[p]), keys(truth.hands[p]),
      `seat ${p}'s hand at trick ${trickNo} disagrees with the live position`);
    compared++;
  } });
  assert.ok(r.decisions.length > 0);
  assert.ok(compared > 0, "no tapped position was checked against a live snapshot");
  assert.equal(compared, r.decisions.length, "every real decision must have a live snapshot to check it against");
});

/* evaluateMoves defaults timeMs to 25 and enforces it as a real wall-clock
   cutoff (ai/pimc.js) — a no-op on the server (Workers freeze Date.now()
   between I/O, per ROADMAP M9) but not in the browser Worker this file runs
   in, where a left-in-place default would silently shave determinizations
   off under load and make "a review is reproducible" above true only on a
   fast, unloaded machine. review.js passes timeMs: Infinity specifically so
   REVIEW_PLAY_BUDGET is the *only* thing governing search depth — which
   means, with no clock in the way, evaluateMoves' own affordable/maxDet
   formula predicts *exactly* how many determinizations every decision must
   have spent. This computes that prediction independently (the same
   arithmetic pimc.js does, not a call into it) for every real decision and
   checks it against what reviewDeal actually reports — a reintroduced clock
   cut would silently shave the reported count down instead of throwing, so
   only an exact per-decision equality check catches it. */
test("a review's determinization budget is not silently cut by a wall clock", () => {
  const v = finishedDeal();
  const perDecisionBudget = Math.max(1, Math.floor(REVIEW_PLAY_BUDGET / v.tricks.length));
  const expected = {}; // trickNo -> determinizations evaluateMoves' own formula affords that position
  const r = reviewDeal(v, 0, { seed: 7, _tap: (pos, trickNo) => {
    const cardsLeft = pos.hands.reduce((n, h) => n + h.length, 0) || 1;
    const legalCount = E.legalCards(pos, 0).length;
    const affordable = Math.max(1, Math.floor(perDecisionBudget / (Math.max(1, legalCount) * cardsLeft)));
    expected[trickNo] = Math.min(24, affordable); // 24: evaluateMoves' own default when opts.determinizations is unset, as reviewDeal leaves it
  } });
  assert.ok(r.decisions.length > 0, "no decisions to check");
  for (const d of r.decisions) {
    assert.equal(d.samples, expected[d.trickNo],
      `trick ${d.trickNo} spent ${d.samples} determinizations; evaluateMoves' own formula for this budget affords ${expected[d.trickNo]} — a wall-clock cutoff is shaving the search short`);
  }
  // the deal-wide minimum reported alongside decisions must be exactly the
  // smallest of those same per-decision counts, not a separately-tracked
  // figure that could drift from them
  assert.equal(r.samples, Math.min(...r.decisions.map(d => d.samples)));
});

/* D29's stated property is "one evaluator, two consumers, because two searchers
   that disagree about the same position is a bug generator". Scoring the moves
   is only half of what a searcher does, though — the other half is the ARGMAX,
   and `winProb * 1000 + meanPoints` used to be spelled out three separate times:
   in choosePIMCCard (what the bot plays), in worker.js's hint sort (what the
   tray recommends), and in review.js's `best` (what a played card is graded
   against). Nothing compared them, so editing one would have made the hint
   recommend a card the bot would not play, or the review grade against a
   different best — silently, with the suite green. They now share
   E.moveScore, and these are the checks that keep them sharing it.

   Three, because no one of them covers the others: (1) is the only one that
   catches a fourth consumer re-typing the rule tomorrow, and (2)/(3) are the
   only ones that catch a consumer keeping its own spelling while still
   importing the shared name. */
test("one argmax rule: the rule exists once, and the hint and the review both obey it", () => {
  // (1) exactly one definition of the fusion anywhere the browser ships
  const jsRoot = new URL("../app/js/", import.meta.url);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const owners = walk(fileURLToPath(jsRoot)).filter(f => f.endsWith(".js"))
    .filter(f => /winProb\s*\*\s*1000/.test(fs.readFileSync(f, "utf8")))
    .map(f => path.relative(fileURLToPath(new URL("../", import.meta.url)), f));
  assert.deepEqual(owners, ["app/js/core/engine/ai/pimc.js"],
    `the winProb*1000 + meanPoints fusion must exist in exactly one file — found it in ${owners.join(", ")}`);

  // (2) the hint's order is moveScore's order, and its `best` is that order's head
  let hints = 0;
  drive((room, pids) => {
    if (room.G.phase !== "playing" || hints > 3) return;
    const seat = room.G.turn;
    const v = R.buildView(room, pids[seat], 0);
    if (!v.you.toAct) return;
    const res = handleRequest({ id: 21, kind: "hint", view: v, seed: 42 });
    assert.ok(res.ok, `hint failed: ${res.error}`);
    assert.deepEqual(res.result.moves, res.result.moves.slice().sort((a, b) => E.moveScore(b) - E.moveScore(a)),
      "the hint tray's order must be the bot's own ranking, not a second spelling of it");
    assert.deepEqual(res.result.best, res.result.moves[0], "the recommended card must head that order");
    hints++;
  });
  assert.ok(hints > 0, "no play hint was exercised");

  /* (3) the review's `best` is moveScore's argmax over the exact evaluateMoves
     call it graded against — reproduced here from review.js's own exported
     budget and its documented per-decision seed (seed + trickNo), so this
     compares against the search that actually ran rather than a fresh one.

     tieBreaks counts decisions where meanPoints genuinely decided the winner:
     several moves tied on winProb with different meanPoints. Without at least
     one of those, this whole check would also pass for a review that ranked on
     winProb alone — the single most plausible way for the two rules to drift
     apart, since winProb is the number the review actually reports.

     All four seats of the one finished deal, not just seat 0 (a finished deal
     is fully public, so reviewDeal grades any seat from the same record). One
     seat's ~13 decisions leave a measured ~3% chance that none of them happened
     to be settled by the tie-break — 2 of 72 runs — which would fail the guard
     below for a reason that has nothing to do with the code. Four seats is
     ~52 decisions for ~90ms, and P(none) falls to ~1e-6. */
  const v = finishedDeal();
  const seed = 13;
  const perDecisionBudget = Math.max(1, Math.floor(REVIEW_PLAY_BUDGET / v.tricks.length));
  let graded = 0, tieBreaks = 0;
  for (const seat of [0, 1, 2, 3]) {
    const expected = {}; // trickNo -> { card, winProb, tie }
    const r = reviewDeal(v, seat, { seed, _tap: (pos, trickNo) => {
      const ev = E.evaluateMoves(pos, seat, { playBudget: perDecisionBudget, timeMs: Infinity, rnd: E.mulberry32(seed + trickNo) });
      const best = ev.moves.reduce((a, b) => (E.moveScore(b) > E.moveScore(a) ? b : a));
      const topProb = Math.max(...ev.moves.map(m => m.winProb));
      const tied = ev.moves.filter(m => m.winProb === topProb);
      expected[trickNo] = { card: best.card, winProb: best.winProb,
                            tie: tied.length > 1 && new Set(tied.map(m => m.meanPoints)).size > 1 };
    } });
    for (const d of r.decisions) {
      const e = expected[d.trickNo];
      assert.deepEqual(d.best, e.card, `seat ${seat}, trick ${d.trickNo}: the review's "best" is not the shared argmax`);
      assert.equal(d.bestWinProb, e.winProb, `seat ${seat}, trick ${d.trickNo}: bestWinProb belongs to a different move`);
      if (e.tie) tieBreaks++;
      graded++;
    }
  }
  assert.ok(graded > 0, "no decisions to check");
  assert.ok(tieBreaks > 0,
    `none of the ${graded} decisions checked was settled by the meanPoints tie-break, so the checks above ` +
    "cannot tell the shared rule apart from ranking on winProb alone");
});

test("the worker answers a review request from a view alone, and reopening it prints the same numbers", () => {
  const v = finishedDeal();
  assert.ok(v, "no finished deal was captured");
  // client.js mints a fresh random seed on *every* request (requestReview
  // rides the same request() as requestHint) — two different msg.seed values
  // here stand in for "the player closed and reopened the review". If the
  // worker branch forwarded msg.seed into reviewDeal instead of leaving it to
  // derive one from the deal, these would disagree.
  const a = handleRequest({ id: 1, kind: "review", view: v, seat: 0, seed: 111 });
  const b = handleRequest({ id: 2, kind: "review", view: v, seat: 0, seed: 222 });
  assert.ok(a.ok, `review failed: ${a.error}`);
  assert.ok(Array.isArray(a.result.decisions) && a.result.decisions.length > 0, "a review must find at least one decision");
  assert.deepEqual(a.result, b.result, "reopening a review — a fresh request seed — must print the same numbers");
});

test("the worker refuses a review request for a deal that has not finished", () => {
  let checked = 0;
  drive((room, pids) => {
    if (room.G.phase !== "playing" || checked > 3) return;
    const v = R.buildView(room, pids[0], 0);
    const res = handleRequest({ id: 4, kind: "review", view: v, seat: 0, seed: 1 });
    assert.equal(res.ok, false, "a deal still in progress must not be reviewable");
    assert.match(res.error, /finished/i);
    checked++;
  });
  assert.ok(checked > 0, "no in-progress view was exercised");
  const res = handleRequest({ id: 5, kind: "review", view: { you: {} }, seat: 0, seed: 1 });
  assert.equal(res.ok, false);
  assert.ok(typeof res.error === "string" && res.error.length, "a failure must explain itself");
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

/* Fix round I5: with no Worker, every OTHER kind still answers in one
   synchronous handleRequest(...) call (the two tests immediately around this
   one exercise exactly that, for hint and for review/generic failure) — cheap
   enough at FALLBACK_HINT_BUDGET that blocking this thread for it doesn't
   read as a stall. "report" grades a whole match's worth of deals at FULL
   (worker-quality, unreduced) budget, so left as a single synchronous call it
   would freeze the tab for the entire match, and — the specific bug named —
   would do so before modals.js's own "Analysing…" wait message ever got a
   chance to paint, since nothing yields back to the browser between that
   write and handleRequest running.
   The property checked: the promise must NOT settle on the very first
   event-loop turn (proving at least one real yield happens before any
   grading starts — the old code settled synchronously, indistinguishable
   from a `Promise.resolve(x)` already-resolved value, well before even one
   real setTimeout(0) could fire), and the eventual result must be BYTE
   IDENTICAL to a single direct handleRequest call over the same input —
   proving the chunking changes only WHEN the work happens, never WHAT gets
   computed (gradeOneDeal is called with no seed override on both paths, so
   both are deterministic functions of the same input). */
test("client.js: with no Worker, a multi-deal report yields to the event loop instead of blocking in one synchronous burst, and still answers correctly", async () => {
  delete globalThis.Worker;
  const { requestReport } = await import("../app/js/coach/client.js?t=report-chunked");
  const { v, seat } = finishedDealView();
  const snap = snapshotOf(v);
  const deals = [snap, snap, snap];
  const p = requestReport(deals, seat, 3);
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(settled, false,
    "a multi-deal report must not settle on the very first event-loop turn — the caller's own \"Analysing…\" paint needs a chance first");
  const res = await p;
  assert.ok(res.ok, `report failed: ${res.error}`);
  assert.equal(res.result.coverage.dealsGraded, 3);
  const direct = handleRequest({ id: 999, kind: "report", deals, seat, dealsInMatch: 3 });
  assert.deepEqual(res.result, direct.result,
    "the chunked fallback must grade identically to handleRequest's own single-shot report branch");
});

test("client.js: with no Worker, an empty report still refuses immediately rather than chunking nothing", async () => {
  delete globalThis.Worker;
  const { requestReport } = await import("../app/js/coach/client.js?t=report-chunked-empty");
  const res = await requestReport([], 0, 3);
  assert.equal(res.ok, false);
  assert.match(res.error, /no finished deal/i);
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

// ---------------------------------------------------------------------------
// Task 2: bid-search.js re-ranked onto make-probability (D42). driveToDeclarer
// below is deliberately not drive() above: drive() plays a full AI auction,
// but these tests want one declarer at one known contract as directly as
// possible. A single MIN_BID bid followed by three passes is enough — three
// applyBid(null) calls empty bidActive down to the bidder alone, findBidActor
// then returns null, and advanceBidding's own null branch calls
// finalizeDeclarer (bidding.js), landing on phase "trumpSelect" with
// G.declarer set. (A loop that instead re-bid minNextBid(G) on every turn
// would escalate the contract every single turn — findBidActor(G) names
// whoever is about to act, which during a fresh auction is always eligible to
// raise — and run straight past MAX_BID without ever finalizing.)
function driveToDeclarer(G) {
  E.applyBid(G, E.findBidActor(G), E.MIN_BID);
  while (G.phase === "bidding") E.applyBid(G, E.findBidActor(G), null);
}

/* D29's wrapper property, applied to the auction: the review reads per-candidate
   scores and the hint reads the winner, so they must come from one ranking. */
test("aiPickTrumpSearch is evaluateTrumps' argmax on makeProb", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  driveToDeclarer(G);
  assert.equal(G.phase, "trumpSelect");
  const seat = G.declarer;
  const opts = { rnd: E.mulberry32(7), playBudget: 24000 };
  const ev = E.evaluateTrumps(G, seat, opts);
  assert.ok(ev && ev.candidates.length === E.SUITS.length);
  assert.ok(ev.worlds > 0);
  for (const c of ev.candidates) {
    assert.ok(c.makeProb >= 0 && c.makeProb <= 1, "makeProb is a probability");
    assert.equal(typeof c.meanPoints, "number");
  }
  const best = ev.candidates.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));
  assert.equal(E.aiPickTrumpSearch(G, seat, { rnd: E.mulberry32(7), playBudget: 24000 }), best.suit);
});

test("aiPickPartnerSearch is evaluateCalls' argmax on makeProb", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  driveToDeclarer(G);
  E.applyTrump(G, E.SUITS[0]);
  assert.equal(G.phase, "partnerSelect");
  const seat = G.declarer;
  const ev = E.evaluateCalls(G, seat, { rnd: E.mulberry32(11), playBudget: 24000 });
  assert.ok(ev && ev.candidates.length > 0);
  const best = ev.candidates.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));
  const pick = E.aiPickPartnerSearch(G, seat, { rnd: E.mulberry32(11), playBudget: 24000 });
  assert.ok(E.sameCard(pick, best.card));
});

/* Task 2 review finding: the version of this test that shipped in 9dd8c38 only
   checked `candidates.length === 4` and `SUITS.includes(candidates[0].suit)`
   — both true unconditionally by construction (evaluateTrumps always builds 4
   suit candidates, and candidates[0].suit is always a member of SUITS), so it
   passed just as happily for a bestOf using `>=` instead of `>`, or with no
   tie-break at all. Fixed to assert the actual resolution: find a seed whose
   top makeProb is genuinely shared by 2+ candidates, then check that
   aiPickTrumpSearch returns the EARLIEST of those tied candidates — the one
   bestOf's strict `>` must leave standing — not merely a legal suit.
   evaluateTrumps builds cands as [heuristic, ...SUITS.filter(...)] and
   preserves that order all the way to ev.candidates, so filter() finds the
   tied subset without disturbing which one is earliest.

   makeProb is a count over one fixed, shared world sample per call, so two
   candidates tie exactly when their counts are exactly equal — comparing
   with `===` is exact, no floating-point tolerance needed.

   TIE_BUDGET is deliberately smaller than the 24000 (TRUMP_PLAY_BUDGET) the
   other two tests above use — not a mismatch, a different question. Measured
   while fixing this finding: at 24000 (~115 worlds/candidate) 0 of 60 sampled
   seeds produced a tie at all; at 1500 (~7 worlds/candidate) 17 of 60 did,
   and — checked directly — every one of those 17 would have resolved to a
   different suit under a `>=` mutant, so the assertion below has real bite.
   worldsFor/scoreCandidates/bestOf run identically regardless of which budget
   produced their worlds; a coarser sample only makes the tie this test wants
   easier to find, on the same code path the other two tests already cover at
   the shipped budget. */
test("the heuristic's own answer is evaluated first, so a tie leaves it standing", () => {
  const TIE_BUDGET = 1500; // ~7 worlds/candidate — coarse enough that exact ties are common, see comment above
  let tieFound = false;
  for (let seed = 0; seed < 60; seed++) {
    const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
    E.startMatch(G);
    driveToDeclarer(G);
    const seat = G.declarer;
    const ev = E.evaluateTrumps(G, seat, { rnd: E.mulberry32(seed), playBudget: TIE_BUDGET });
    assert.equal(ev.candidates.length, 4);
    const top = Math.max(...ev.candidates.map(c => c.makeProb));
    const tied = ev.candidates.filter(c => c.makeProb === top);   // filter() preserves cands' order
    if (tied.length < 2) continue;
    tieFound = true;
    assert.equal(E.aiPickTrumpSearch(G, seat, { rnd: E.mulberry32(seed), playBudget: TIE_BUDGET }), tied[0].suit,
      `seed ${seed}: a ${tied.length}-way tie at makeProb ${top} must resolve to the earliest tied candidate`);
    break;
  }
  assert.ok(tieFound, "no seed among the first 60 produced a tie at the top makeProb — the tie-break was never exercised");
});

/* Same property through evaluateCalls/aiPickPartnerSearch. Optional per the
   review finding (the trump test above is what it required) — added anyway
   because bestOf is the one function both consumers share, and the call side
   has its own candidate-construction order to pin
   (`cands = heuristic ? [heuristic, ...honours] : honours`). Kept at the
   literal 24000, not the CALL_PLAY_BUDGET constant (raised to 96000 by D36's
   correction — scripts/bench-auction-search.js `regret`): unlike trump, ties
   were already common at 24000 (9 of 60 sampled seeds), and a wider budget
   only makes an exact makeProb tie rarer, so this pins the coarse budget the
   tie-break needs to find one rather than tracking wherever the shipped
   default moves. */
test("evaluateCalls' tie leaves the earliest candidate standing too (bestOf is shared)", () => {
  let tieFound = false;
  for (let seed = 0; seed < 80; seed++) {
    const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
    E.startMatch(G);
    driveToDeclarer(G);
    E.applyTrump(G, E.SUITS[0]);
    const seat = G.declarer;
    const ev = E.evaluateCalls(G, seat, { rnd: E.mulberry32(seed), playBudget: 24000 });
    if (!ev) continue;
    const top = Math.max(...ev.candidates.map(c => c.makeProb));
    const tied = ev.candidates.filter(c => c.makeProb === top);
    if (tied.length < 2) continue;
    tieFound = true;
    const pick = E.aiPickPartnerSearch(G, seat, { rnd: E.mulberry32(seed), playBudget: 24000 });
    assert.ok(E.sameCard(pick, tied[0].card),
      `seed ${seed}: a ${tied.length}-way tie at makeProb ${top} must resolve to the earliest tied candidate`);
    break;
  }
  assert.ok(tieFound, "no seed among the first 80 produced a tie at the top makeProb — the tie-break was never exercised");
});

// ---------------------------------------------------------------------------
// report.js — the match-level aggregate. Pure arithmetic, no dependencies.

const dec = (kind, delta, grade) => ({ kind, delta, grade, roundNumber: 1 });

/* Fix round F1: headline used to be a mean over all four kinds, which
   averaged a genuine forgone-probability delta (play) together with a
   distance-from-the-decision-line delta (bid) into a third quantity that is
   neither. Strengthened from the original (which only ever used "play"
   decisions, so it would have passed just as happily with the bug still in
   place): every deal now also carries a large bid delta (0.9 — big enough
   that including it would obviously move the mean off 0.1), and the
   assertion pins the headline at exactly the same 0.1 either way. The
   length-invariance property itself is unchanged and still checked. */
test("matchReport's headline is a mean over the commensurable kinds only, so match length cannot move it and the bid cannot either", () => {
  const three = [1, 2, 3].map(n => ({ roundNumber: n, decisions: [dec("play", 0.2, "blunder"), dec("play", 0, "fine"), dec("bid", 0.9, "blunder")], skipped: [] }));
  const seven = [1, 2, 3, 4, 5, 6, 7].map(n => ({ roundNumber: n, decisions: [dec("play", 0.2, "blunder"), dec("play", 0, "fine"), dec("bid", 0.9, "blunder")], skipped: [] }));
  assert.ok(Math.abs(matchReport(three, 0, 3).headline - matchReport(seven, 0, 7).headline) < 1e-10);
  assert.ok(Math.abs(matchReport(three, 0, 3).headline - 0.1) < 1e-10, "the bid's own 0.9 delta must not enter the headline's mean");
});

/* Fix round F1: strengthened with a discriminating bid delta (0.9, distinct
   from the play decision's 0) so the headline assertion actually catches a
   regression back to blending — both deltas being 0 (the original version)
   would read as 0 whether or not the bid was wrongly included. counts stays
   the unified ordinal vocabulary across all four kinds (unchanged); only
   headline's own denominator narrows to the commensurable three. */
test("skipped decisions stay out of the denominator, band decisions stay in, and the bid stays out of headline's own denominator", () => {
  const deals = [{ roundNumber: 1, decisions: [dec("play", 0, "fine"), dec("bid", 0.9, "blunder")],
                   skipped: [{ kind: "trump", roundNumber: 1, reason: "not-declarer" }] }];
  const r = matchReport(deals, 0, 1);
  assert.equal(r.counts.fine, 1, "the band (fine) play decision counts");
  assert.equal(r.counts.blunder, 1, "the bid decision counts too — counts stays unified across all four kinds");
  assert.equal(r.byKind.trump.n, 0, "a skip is not a decision");
  assert.equal(r.headline, 0, "headline is the mean of only the commensurable (play) decision — the bid's own 0.9 delta must not enter it");
});

test("headline is null, not zero, when nothing was graded", () => {
  const r = matchReport([{ roundNumber: 1, decisions: [], skipped: [] }], 0, 1);
  assert.equal(r.headline, null);
  assert.equal(r.counts.fine, 0);
});

/* Fix round F1's own stated acceptance criterion: a match where you only ever
   bid, and never faced an open card-play, trump or call choice, has no
   headline — a flawless play/trump/call record (headline 0) is a real,
   different claim from "nothing commensurable was graded" (headline null),
   and the second must not print as the first just because the bid alone had
   something to say. */
test("headline is null when only the bid was graded — that is not the same as a flawless play/trump/call record", () => {
  const r = matchReport([{ roundNumber: 1, decisions: [dec("bid", 0.9, "blunder")], skipped: [] }], 0, 1);
  assert.equal(r.headline, null, "no commensurable decision was graded, even though a bid blunder was");
  assert.equal(r.counts.blunder, 1, "the bid still counts toward the shared ordinal grade vocabulary");
});

test("coverage reports missing deals rather than hiding them", () => {
  const r = matchReport([{ roundNumber: 2, decisions: [dec("play", 0.3, "blunder")], skipped: [] }], 0, 5);
  assert.equal(r.coverage.dealsGraded, 1);
  assert.equal(r.coverage.dealsInMatch, 5);
});

/* Fix round I2: strengthened with a bid delta (0.90) that is the single
   LARGEST delta in the whole match — the original version's bid delta (0.20)
   never contended for the top two either way, so it could not have told the
   old (buggy) behaviour, which ranked all four kinds in one list, apart from
   the new one, which ranks only play/trump/call. Under the old behaviour
   worst[0] would have been the bid at 0.90; under the fix it must be call at
   0.40, and the bid must surface only in worstBid. */
test("worst is the two costliest among the commensurable kinds across the whole match, not per deal, and never includes the bid", () => {
  const deals = [
    { roundNumber: 1, decisions: [dec("play", 0.30, "blunder"), dec("play", 0.05, "fine")], skipped: [] },
    { roundNumber: 2, decisions: [dec("call", 0.40, "blunder"), dec("bid", 0.90, "blunder")], skipped: [] },
  ];
  const r = matchReport(deals, 0, 2);
  assert.equal(r.worst.length, 2);
  assert.equal(r.worst[0].delta, 0.40);
  assert.equal(r.worst[1].delta, 0.30);
  assert.ok(r.worst.every(d => d.kind !== "bid"),
    "the bid's own 0.90 — the single largest delta in the whole match — must never enter worst");
  assert.equal(r.worstBid.length, 1);
  assert.equal(r.worstBid[0].delta, 0.90);
  assert.equal(r.worstBid[0].kind, "bid");
  assert.equal(r.worstBid[0].roundNumber, 2);
});

/* Fix round C1 (Critical): the shape check that actually matters.
   reviewDeal's own decisions (review.js:210-214) carry neither `kind` nor
   `roundNumber` — only trickNo/played/best/playedWinProb/bestWinProb/delta/
   grade/samples. Every other test in this file builds its decisions with
   dec(), which always supplies both fields — exactly why the original bug
   (every card-play entry in `worst` printing "undefined · deal undefined",
   confirmed by the reviewer running the real renderer) survived a full
   implementation pass, a self-review and a whole prior fix round unnoticed:
   every synthetic decision in this file was shaped unlike a real one. This
   one is not — it is reviewDeal's own literal shape, unmodified. */
const realPlayDecision = (delta, grade) => ({
  trickNo: 3, played: { suit: "♠", rank: 10 }, best: { suit: "♠", rank: 12 },
  playedWinProb: 0.5, bestWinProb: 0.5 + delta, delta, grade, samples: 24,
});

test("matchReport stamps kind and roundNumber onto a real reviewDeal-shaped decision, so worst never carries an undefined field", () => {
  const deals = [{ roundNumber: 7, decisions: [realPlayDecision(0.22, "mistake")], skipped: [] }];
  const r = matchReport(deals, 0, 1);
  assert.equal(r.worst.length, 1);
  assert.equal(r.worst[0].kind, "play", "a reviewDeal decision with no kind of its own must be inferred as play");
  assert.equal(r.worst[0].roundNumber, 7, "roundNumber must come from the owning deal record — the decision itself carries none");
});

/* Fix round C1's own reported symptom, reproduced at the renderer: the
   reviewer's transcript showed "rendered -> undefined · deal undefined" for
   exactly this shape. renderReport was untouched by any test before this
   fix round — the root cause C1 itself names — so this is deliberately the
   first test that calls it at all, and it checks the literal failure text
   rather than trusting the data-level assertion above to imply the render
   is fixed too. */
test("renderReport never prints an undefined kind or deal number for a real reviewDeal decision", () => {
  const deals = [{ roundNumber: 4, decisions: [realPlayDecision(0.22, "mistake"), dec("bid", 0.9, "blunder")], skipped: [] }];
  const report = matchReport(deals, 0, 1);
  const html = renderReport(report, { names: ["A", "B", "C", "D"] }, 0);
  assert.doesNotMatch(html, /undefined/, 'no field the panel prints may ever render as the literal string "undefined"');
  assert.match(html, /play · deal 4/);
});

/* Fix round I2, at the renderer: the bid's own worst must land in a visibly
   separate list from the commensurable "Costliest decisions" one, never a
   third row merged into it under the same "costliest" caption. */
test("renderReport prints the bid's own worst separately from the commensurable 'Costliest decisions' list, never merged", () => {
  const deals = [{ roundNumber: 1, decisions: [realPlayDecision(0.10, "mistake"), dec("bid", 0.30, "blunder")], skipped: [] }];
  const report = matchReport(deals, 0, 1);
  const html = renderReport(report, { names: ["A", "B", "C", "D"] }, 0);
  assert.match(html, /Costliest decisions/);
  assert.match(html, /Furthest off the line/);
  assert.equal((html.match(/rv-row/g) || []).length, 2,
    "one row for the commensurable decision, one for the bid — never combined into one list");
});

// ---------------------------------------------------------------------------
// auction.js — the auction's half of the post-deal review: grade the bid,
// the trump pick and the partner call from exactly what the player knew at
// the time, the same discipline review.js applies to card play. The tests
// below check the same three things review.js's own section does — shape,
// reproducibility, and (D32) that no position handed to the search ever
// carries a trump, call or partner the player had not yet chosen — plus the
// world floor's own arithmetic (D43/D44) and the forced-bid/non-declarer
// skip paths.

/* The call's shortlist ceiling, derived rather than measured: evaluateCalls
   (ai/bid-search.js) offers the heuristic's own pick plus every rank>=12 card
   the seat does not hold, with the heuristic deduped out of that list. There
   are exactly 12 such cards in a deck (Q/K/A x 4 suits), and aiPickPartner
   (ai/heuristic.js) returns an un-held ace, else an un-held king, else
   callableCards[0] — so it is itself one of those 12 on every hand except one
   holding all twelve honours, where it is a jack and the honour list is empty
   (1 candidate). Either way |candidates| <= 12; a 13-candidate shortlist
   describes an undealable hand. Pinned against real positions below, because
   this is the invariant D44's whole band guarantee rests on. */
const CALL_SHORTLIST_MAX = 12;

/* D43/D44 as arithmetic, not as a comment: the band must be able to express the
   finest grade there is, for the widest candidate list the call can offer. */
test("the review's world floor keeps the dead band under the mistake threshold", () => {
  assert.equal(MIN_REVIEW_WORLDS, Math.ceil(1 / MISTAKE_WIN_DELTA ** 2));
  for (const candidates of [1, 4, CALL_SHORTLIST_MAX]) {
    const budget = auctionBudgetFor(candidates);
    /* The engine's own worldsFor, never a second copy of it (fix round I6).
       ai/bid-search.js exports this precisely so nothing forks the formula,
       and docs/STRUCTURE.md advertises that protection — but this guard, of
       all places, re-typed it: change the 52 or the floor and the grader's
       real band would exceed MISTAKE_WIN_DELTA while its own guard went on
       passing against the old arithmetic. */
    const worlds = worldsFor(candidates, budget);
    assert.ok(bandFor(worlds) <= MISTAKE_WIN_DELTA,
      `band ${bandFor(worlds)} must not swallow the mistake grade at ${candidates} candidates`);
  }
});

/* …and the ceiling that guard is quantified over. Nothing asserted it before
   (fix round I6), so the band guarantee above held only for as wide a
   shortlist as someone had remembered to type into it. */
test("the call's shortlist never exceeds the ceiling the band guarantee is quantified over", () => {
  let widest = 0, checked = 0;
  for (let d = 0; d < 60; d++) {
    const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 5 });
    E.startMatch(G);
    for (let guard = 0; G.phase === "bidding" && guard < 60; guard++) {
      const seat = E.findBidActor(G);
      if (seat === null) break;
      const act = E.aiActionFor(G, seat, "normal");
      E.applyBid(G, seat, act && act.type === "bid" ? act.value : null);
    }
    if (G.phase !== "trumpSelect") continue;
    E.applyTrump(G, E.aiActionFor(G, G.declarer, "normal").suit);
    for (const seat of [0, 1, 2, 3]) {
      // playBudget 1 floors worldsFor at 4 worlds: the shortlist is what is
      // being measured here, not the quality of the search over it
      const ev = E.evaluateCalls(G, seat, { playBudget: 1, rnd: E.mulberry32(d * 10 + seat) });
      if (!ev) continue;
      checked++;
      widest = Math.max(widest, ev.candidates.length);
      assert.ok(ev.candidates.length <= CALL_SHORTLIST_MAX,
        `a ${ev.candidates.length}-candidate shortlist exceeds the ${CALL_SHORTLIST_MAX} the review's own band is derived for`);
    }
  }
  assert.ok(checked > 100, `expected many real partnerSelect positions, got ${checked}`);
  assert.ok(widest >= 10, `the sample must approach the ceiling to be worth anything, widest seen was ${widest}`);
});

/* D32, executable. Every auction position must be built from what the player
   knew then — never from the finished deal's own trump, call or partner. */
test("reviewAuction never lets a later fact reach an earlier position", () => {
  const finished = finishedDealView();          // helper below
  const seen = [];
  reviewAuction(finished.v, finished.seat, { _tap: (pos, kind) => seen.push({ pos, kind }) });
  // Review-round finding B1: "at least one" would still pass if a regression
  // stopped the trump or call tap from ever firing at all (e.g. only bid
  // positions got searched) — the property would go unverified while the
  // suite stayed green. Pin the actual set, the same idiom already used above
  // for the worker's bid/trump/call hint coverage.
  assert.deepEqual([...new Set(seen.map(s => s.kind))].sort(), ["bid", "call", "trump"],
    "expected to exercise all three auction decisions");

  /* Review-round finding B3: highBid — "the entire reason G.auction was
     added" — had no test of its own. Re-derive the same left-to-right fold
     gradeBids runs internally (auction.js), directly from v.auction rather
     than by calling into the module under test, and check it against every
     tapped "bid" position's own pos.highBid, in the order they were tapped.
     A regression to v.bid (the FINAL contract) here would grade every bid
     against the level the auction eventually settled at instead of the level
     actually on offer when it was faced — systematically harsh on early
     bidders, systematically lenient on whoever pushed the auction, and
     entirely plausible-looking output either way. */
  const expectedHighBids = [];
  let highBid = null;
  for (const entry of finished.v.auction) {
    if (entry.seat === finished.seat && !entry.forced) expectedHighBids.push(highBid);
    if (entry.value != null) highBid = entry.value;
  }
  const bidPositions = seen.filter(s => s.kind === "bid").map(s => s.pos);
  assert.equal(bidPositions.length, expectedHighBids.length,
    "every one of the seat's non-forced bidding turns must produce exactly one tapped position");
  bidPositions.forEach((pos, i) => assert.equal(pos.highBid, expectedHighBids[i],
    `bid position ${i}: highBid must be the auction log's own prefix, not the final contract`));

  for (const { pos, kind } of seen) {
    assert.equal(pos.partner, null, `${kind}: partner must not be known`);
    assert.equal(pos.teamsRevealed, false, `${kind}: teams must not be revealed`);
    assert.equal(pos.calledCard, null, `${kind}: the called card must not be known`);
    assert.deepEqual(pos.playedCards, [], `${kind}: no card has been played yet`);
    assert.equal(pos.trickNumber, 0);
    // Review-round finding B2: the call position's trump was previously exempted
    // from assertion entirely, so a regression to null there (falling through to
    // evaluateCalls' own aiPickTrump fallback, scoring every candidate under a
    // trump the player never chose) would pass silently. Assert what it must
    // actually be, not just that it's skipped.
    if (kind !== "call") assert.equal(pos.trump, null, `${kind}: trump must not be known`);
    else assert.deepEqual(pos.trump, finished.v.trump, "call: trump IS legitimately known by the time the call is being chosen");
    assert.equal(pos.hands[finished.seat].length, 13, `${kind}: the full starting hand`);
    assert.ok(pos.hands.filter((h, p) => p !== finished.seat).every(h => h.every(c => c === null)),
      `${kind}: other hands must be placeholders`);
  }
});

test("reviewAuction repeats exactly when asked twice", () => {
  const { v, seat } = finishedDealView();
  const a = reviewAuction(v, seat, {});
  const b = reviewAuction(v, seat, {});
  assert.deepEqual(a.decisions, b.decisions);
});

/* Review-round finding B10: the original body constructed neither a weak hand
   nor a pass, and `delta >= 0` is near-tautological — both of decide()'s and
   gradeBids' own formulas clamp at 0, so this passed even for an
   implementation that scored the RIGHT side of the line as anything >= 0.
   Pin the property the title actually claims: a decision on the correct side
   of the line — a pass the search agrees was right, or a bid the search
   agrees was right — costs exactly 0, however far past the line it sits, not
   merely "not negative". Graded across all four seats of the one finished
   deal, not just the declarer: gradeBids grades every bidding turn a seat
   took (forced entries aside), so a defender who bid and was later outbid has
   graded decisions of their own too — pooling them gives the check enough
   real bid decisions to be reliably non-vacuous without driving a second deal. */
test("a correct pass on a weak hand is not an error", () => {
  const { v } = finishedDealView();
  let onRightSide = 0;
  for (const seat of [0, 1, 2, 3]) {
    const r = reviewAuction(v, seat, {});
    for (const d of r.decisions) {
      assert.ok(d.delta >= 0, "delta is never negative");
      if (d.kind !== "bid") continue;
      // played == null is a pass, correct when p is at or under the line;
      // a real bid is correct when p is at or over it — bestProb is always
      // the 0.5 line itself for "bid" kind decisions (see auction.js).
      const correctSide = d.played == null ? d.playedProb <= d.bestProb : d.playedProb >= d.bestProb;
      if (!correctSide) continue;
      assert.equal(d.delta, 0,
        `a ${d.played == null ? "pass" : "bid"} on the right side of the line must cost nothing, however far past it`);
      onRightSide++;
    }
  }
  assert.ok(onRightSide > 0, "expected at least one bid decision on the correct side of the line to actually exercise the clamp");
});

/* Review-round finding B4: best used to be the unconditional opposite of what
   was played (null whenever you bid, target whenever you passed) — correct
   only when the play itself was wrong, so it named the WRONG suggestion
   whenever you were right (told to pass when you correctly bid, or to bid
   when you correctly passed). Fixed to mirror aiBidDecisionSearch's own
   threshold: best = p >= 0.5 ? target : null, unconditional on what was
   played. `target` is reconstructed independently here — E.minNextBid on the
   tapped position for a pass (need), or the played value itself for a real
   bid — rather than by re-deriving p, which would mean re-running the search
   and risking a second, possibly-drifting copy of its own seeding. Pooled
   across all four seats for enough decisions to see more than one of the
   four (action x side-of-line) combinations in a single run:
     played=bid,  p>=0.5 (right): target=played,  best=target  -> best===played
     played=bid,  p<0.5  (wrong): target=played,  best=null    -> best!==played
     played=pass, p>=0.5 (wrong): target=need,    best=target  -> best!==played
     played=pass, p<0.5  (right): target=need,    best=null    -> best===played */
test("a bid decision's best mirrors the search's own threshold, not the opposite of what was played", () => {
  const { v } = finishedDealView();
  let checked = 0;
  for (const seat of [0, 1, 2, 3]) {
    const positions = [];
    const r = reviewAuction(v, seat, { _tap: (pos, kind) => { if (kind === "bid") positions.push(pos); } });
    const bidDecisions = r.decisions.filter(d => d.kind === "bid");
    assert.equal(bidDecisions.length, positions.length,
      "every graded bid decision must have exactly one tapped position, in the same order");
    bidDecisions.forEach((d, i) => {
      const need = E.minNextBid(positions[i]);
      const target = d.played == null ? need : d.played;
      const expectedBest = d.playedProb >= d.bestProb ? target : null;
      assert.equal(d.best, expectedBest,
        `seat ${seat}: best does not match aiBidDecisionSearch's own p >= 0.5 threshold`);
      // best equals played exactly on the side where that specific action (bid
      // needs p>=0.5, pass needs p<0.5) was the right call — never merely the
      // unconditional opposite of what was played.
      const correctForThisAction = d.played == null ? d.playedProb < d.bestProb : d.playedProb >= d.bestProb;
      assert.equal(d.best === d.played, correctForThisAction,
        `seat ${seat}: best must equal played exactly when that play was on its own correct side of the line`);
      checked++;
    });
  }
  assert.ok(checked > 0, "no bid decisions to check");
});

test("a forced minimum bid is skipped, not graded", () => {
  const { v, seat } = forcedBidView();           // helper below
  const r = reviewAuction(v, seat, {});
  assert.ok(r.skipped.some(s => s.kind === "bid" && s.reason === "forced"));
  /* forceBid() (bidding.js) APPENDS its synthetic entry to the round's own
     auction log rather than replacing it, and bidActive only empties out —
     the precondition for the redeal that can end in a force — once every
     seat, including the one about to be forced, has already passed of its
     own accord in that same round. So the forced seat also owns one genuine,
     un-forced pass immediately before its forced entry: a real decision,
     taken before anyone knew the round would be forced, which reviewAuction
     is right to grade. What must never happen is the SYNTHETIC entry itself
     doubling as a graded decision — checked structurally rather than by
     assuming "zero", which this seat's own real pass would always violate. */
  const gradable = v.auction.filter(a => a.seat === seat && !a.forced).length;
  assert.equal(r.decisions.filter(d => d.kind === "bid").length, gradable,
    "only the seat's non-forced auction entries may surface as bid decisions");
});

test("trump and call are skipped for a seat that did not declare", () => {
  const { v, seat } = finishedDealView();
  const other = [0, 1, 2, 3].find(s => s !== v.declarer);
  const r = reviewAuction(v, other, {});
  assert.ok(r.skipped.some(s => s.kind === "trump" && s.reason === "not-declarer"));
  assert.ok(r.skipped.some(s => s.kind === "call" && s.reason === "not-declarer"));
});

// ---------------------------------------------------------------------------
// util/deals.js — finished deals kept on this device, so the match-over
// report card has something to grade without a server round-trip.

test("a snapshot carries exactly what the graders read, and no hand", () => {
  const { v } = finishedDealView();
  const s = snapshotOf(v);
  for (const k of ["tricks", "auction", "trump", "calledCard", "declarer", "partner",
                   "bid", "bonusSuit", "dealer", "roundNumber", "names", "scores",
                   "lastResult", "teamsRevealed", "consts"])
    assert.ok(k in s, `snapshot must carry ${k}`);
  assert.equal(s.you, undefined, "a snapshot never carries a hand");
  assert.equal(s.chat, undefined, "a snapshot never carries chat");
  // and it must still be enough to grade with
  const r = reviewAuction(s, s.declarer, {});
  assert.ok(r.decisions.length || r.skipped.length);
  const rd = reviewDeal(s, s.declarer, {});
  assert.ok(Array.isArray(rd.decisions));
});

// ---------------------------------------------------------------------------
// Task 7 — the worker's "report" branch (worker.js), wiring reviewDeal and
// reviewAuction's per-deal grades into report.js's matchReport, plus the
// pure wording half of the match-over panel (ui/coach.js's describeReport).

test("the worker's report branch grades every deal it is given", () => {
  const { v, seat } = finishedDealView();
  const res = handleRequest({ id: 1, kind: "report", deals: [snapshotOf(v)], seat, dealsInMatch: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.result.coverage.dealsGraded, 1);
  assert.equal(res.result.coverage.dealsInMatch, 3);
  assert.ok(res.result.counts.fine + res.result.counts.mistake + res.result.counts.blunder >= 0);
});

test("the worker refuses a report with no deals rather than reporting zero", () => {
  const res = handleRequest({ id: 2, kind: "report", deals: [], seat: 0, dealsInMatch: 3 });
  assert.equal(res.ok, false);
  assert.match(res.error, /no finished deal/i);
});

test("describeReport states coverage even when it is complete", () => {
  const report = matchReport([{ roundNumber: 1, decisions: [dec("play", 0, "fine")], skipped: [] }], 0, 1);
  const s = describeReport(report, { names: ["A", "B", "C", "D"] }, 0);
  assert.match(s.coverage, /1 of 1/);
});

/* Fix round I3: pins the two strings F1/F1's own extended ruling actually
   constrain, neither of which any test touched before this round. A
   regression back to counts.fine+mistake+blunder as headline's own
   denominator would print "over 2 decisions" here — wrong, since the
   headline percentage itself is a mean over only the one commensurable
   (play) decision; the bid decision is graded but not part of that mean. */
test("describeReport's headline states its own commensurable count, not the unified counts sum", () => {
  const report = matchReport([{ roundNumber: 1, decisions: [dec("play", 0.1, "mistake"), dec("bid", 0.9, "blunder")], skipped: [] }], 0, 1);
  const s = describeReport(report, { names: ["A", "B", "C", "D"] }, 0);
  assert.match(s.headline, /over 1 decision\./,
    "the headline's own count must be the one commensurable (play) decision, not both graded decisions");
});

/* Fix round I3: pins bidNote's wording directly — "off the search's line",
   never "probability given away" (the headline's own phrase, reserved for
   the three genuinely commensurable kinds). A regression that reused the
   headline's phrasing for the bid would misstate what byKind.bid.meanDelta
   actually measures. */
test("describeReport words the bid's own line as distance from the line, never as probability given away", () => {
  const report = matchReport([{ roundNumber: 1, decisions: [dec("bid", 0.3, "blunder")], skipped: [] }], 0, 1);
  const s = describeReport(report, { names: ["A", "B", "C", "D"] }, 0);
  assert.match(s.bidNote, /off the search's line/);
  assert.doesNotMatch(s.bidNote, /probability given away/i);
});

// ---------------------------------------------------------------------------
// Fix round: the seam mutation testing found open.
//
// Every test above this line either grades ONE deal, or aggregates SYNTHETIC
// decisions built by dec()/realPlayDecision(). Nothing joined the two halves
// of the pipeline end to end over real data, so a whole family of edits broke
// the report card visibly while the suite stayed green: dropping either half
// of gradeOneDeal's merge, hardcoding its roundNumber, emptying snapshotOf's
// tricks, and — on the no-worker path — grading the same deal repeatedly or
// losing dealsInMatch. The four tests below close it.

/* One driven match, kept: every finished deal's view, each paired with the
   seat that declared it. Memoised because driving a match and grading its
   deals at MIN_REVIEW_WORLDS is the expensive part of this file, and every
   test below wants the same thing — several REAL, DISTINCT finished deals,
   which finishedDealView() above cannot give (it returns only the last one).
   Nothing here mutates a view; the tests that vary one spread it first. */
let _matchDeals = null;
function finishedDealViews() {
  if (_matchDeals) return _matchDeals;
  const room = R.createRoom("TEST");
  const pids = [];
  for (let i = 0; i < 4; i++) {
    const { pid } = R.join(room, { name: "P" + i }, 0);
    pids.push(pid);
    R.message(room, pid, { type: "sit", seat: i }, 0);
  }
  R.message(room, pids[0], { type: "start" }, 0);
  const out = [];
  /* Captured at roundEnd, BEFORE readying up — drive()'s own comment above
     explains why its onStep can never observe that phase, which is exactly
     why this is a second driver rather than a callback on the first. */
  for (let step = 0; step < 50000 && room.G.phase !== "matchOver"; step++) {
    if (room.G.phase === "roundEnd") {
      out.push({ v: R.buildView(room, pids[room.G.declarer], 0), seat: room.G.declarer });
      for (const pid of pids) R.message(room, pid, { type: "ready" }, 0);
      continue;
    }
    const ra = E.requiredActor(room.G);
    if (!ra) { R.fireTimers(room, 1e9); continue; }
    R.message(room, pids[ra.seat], E.aiActionFor(room.G, ra.seat, "normal"), 0);
  }
  // the deal that ends the match never reaches roundEnd — the same gap
  // screens/game.js's own snapshot site exists to close
  if (room.G.phase === "matchOver")
    out.push({ v: R.buildView(room, pids[room.G.declarer], 0), seat: room.G.declarer });
  assert.ok(out.length >= 2, "a match must have produced at least two finished deals");
  _matchDeals = out;
  return out;
}

/* (1) The whole pipeline, on real data, in one test: a deal the engine
   actually played -> snapshotOf -> the worker's own report branch ->
   renderReport. Every intermediate fixture in this file is a place a real
   value can be replaced by a plausible-looking one and nothing notices;
   this test has none. realPlayDecision above was the last fix round's
   answer to the same seam and is still hand-written — it can only ever be
   as right as whoever typed it. */
test("end to end: a real finished deal grades and renders with real numbers on both sides of the merge", () => {
  const { v, seat } = finishedDealViews()[0];
  const res = handleRequest({ id: 1, kind: "report", deals: [snapshotOf(v)], seat, dealsInMatch: 4 });
  assert.ok(res.ok, `report failed: ${res.error}`);
  const r = res.result;

  /* Both halves of gradeOneDeal's merge must have survived into the
     aggregate. Dropping either one leaves a report that still renders, still
     states coverage and still prints a headline — just silently over half the
     decisions, which is the shape of the bug this closes. */
  assert.ok(r.byKind.play.n > 0,
    "reviewDeal's card-play decisions must reach the report — an emptied snapshot or a dropped merge half both land here");
  assert.ok(r.byKind.bid.n + r.byKind.trump.n + r.byKind.call.n > 0,
    "reviewAuction's bid/trump/call decisions must reach the report too");

  const html = renderReport(r, v, seat);
  assert.doesNotMatch(html, /undefined/, 'no field the panel prints may ever render as the literal string "undefined"');
  assert.doesNotMatch(html, /NaN/, "nor as NaN");
  assert.match(html, /graded 1 of 4 deals/, "coverage must be stated from the numbers actually passed in");
  assert.match(html, /\d+\.\d%/, "a real, computed percentage must reach the panel — not a dash and not a placeholder");
  assert.match(html, /Card play/, "the card-play row is what a dropped play.decisions removes");
});

/* (2) gradeOneDeal's merge itself, against its two halves computed
   separately. The count equality is what makes "both are present" exact
   rather than "at least one of each kind appeared". */
test("gradeOneDeal merges both halves under the deal's own round number, not a hardcoded one", () => {
  const later = finishedDealViews().find(d => d.v.roundNumber !== 1);
  assert.ok(later, "the match must have played more than one deal");
  const snap = snapshotOf(later.v);
  const merged = gradeOneDeal(snap, later.seat);

  assert.notEqual(later.v.roundNumber, 1,
    "this fixture must not be deal 1, or a hardcoded roundNumber: 1 would pass unnoticed");
  assert.equal(merged.roundNumber, later.v.roundNumber,
    "the merged record must carry the deal's own round number — report.js stamps it onto every decision, and the panel prints it");

  // Both graders are deterministic (seedFromDeal), so these are exactly the
  // two lists the merge is supposed to concatenate.
  const play = reviewDeal(snap, later.seat, {});
  const auction = reviewAuction(snap, later.seat, {});
  assert.ok(play.decisions.length > 0, "the fixture must contain real card-play decisions");
  assert.ok(auction.decisions.length > 0, "…and real auction decisions, or neither half proves anything");
  assert.equal(merged.decisions.length, play.decisions.length + auction.decisions.length,
    "the merge must keep BOTH halves — dropping either leaves a shorter list that still looks like a valid report");
  const kinds = new Set(merged.decisions.map(d => d.kind || "play"));
  assert.ok(kinds.has("play"), "card-play decisions must survive the merge");
  assert.ok(["bid", "trump", "call"].some(k => kinds.has(k)), "auction decisions must survive the merge");
});

/* (3) The no-worker chunked path, over two GENUINELY DIFFERENT deals with a
   dealsInMatch that is not deals.length. The existing chunked test above
   passes three copies of one snapshot and dealsInMatch === deals.length, so
   per-deal identity and coverage are both invisible to it: grading deals[0]
   three times, or letting dealsInMatch fall through as undefined, changes
   nothing it asserts. */
test("client.js: the chunked report grades each deal it is given, and reports the match's own deal count", async () => {
  delete globalThis.Worker;
  const { requestReport } = await import("../app/js/coach/client.js?t=report-distinct");
  const all = finishedDealViews();
  const seat = 0;                        // one seat across both deals, whoever declared them
  const a = snapshotOf(all[0].v);
  const b = snapshotOf(all.find(d => d.v.roundNumber !== all[0].v.roundNumber).v);
  const DEALS_IN_MATCH = all.length + 3; // the match played more deals than this device stored

  const direct = handleRequest({ id: 7, kind: "report", deals: [a, b], seat, dealsInMatch: DEALS_IN_MATCH });
  const firstTwice = handleRequest({ id: 8, kind: "report", deals: [a, a], seat, dealsInMatch: DEALS_IN_MATCH });
  assert.notDeepEqual(direct.result, firstTwice.result,
    "the two snapshots must grade differently, or this test could not tell a per-deal walk from grading the first one twice");

  const res = await requestReport([a, b], seat, DEALS_IN_MATCH);
  assert.ok(res.ok, `report failed: ${res.error}`);
  assert.equal(res.result.coverage.dealsGraded, 2);
  assert.equal(res.result.coverage.dealsInMatch, DEALS_IN_MATCH,
    "dealsInMatch is the server's own count and must ride through untouched — falling back to deals.length reports full coverage over a partial set (D45)");
  assert.notEqual(res.result.coverage.dealsInMatch, res.result.coverage.dealsGraded,
    "…and the fixture must make those two differ, or the fallback would be indistinguishable");
  assert.deepEqual(res.result, direct.result,
    "the chunked fallback must walk the deals it was given, in order, exactly once each");
});

/* (4) D43's dead band, which nothing asserted: a raw distance the sampler
   cannot resolve is reported as exactly 0, and the decision still appears,
   graded fine. Both halves — the rule itself at its own boundary, and the
   consequence a reader actually sees, that a fine decision is never
   presented as a cost. */
test("a distance inside its own band grades fine at exactly zero, and never surfaces as a cost", () => {
  const band = bandFor(MIN_REVIEW_WORLDS);
  assert.ok(band > 0 && band < 1, `band must be a real probability distance, got ${band}`);

  // strictly inside, exactly on the edge, and just outside
  assert.equal(clampToBand(band / 2, band), 0, "a distance the sampler cannot resolve is reported as none at all");
  assert.equal(clampToBand(band, band), 0, "a distance EQUAL to the band is still inside it");
  assert.equal(clampToBand(band * 1.5, band), band * 1.5, "…and one outside it passes through unchanged, unrounded");
  // the bid's own quantity is signed — being far from the line on the right
  // side of it is not an error, and must never read as a negative cost
  assert.equal(clampToBand(-0.3, band), 0, "distance on the correct side of the bid line is zero cost, never negative");

  /* And through decide(), which is where a trump or call decision actually
     acquires its delta: a graded decision is still RETURNED for a band
     distance (dropping it would inflate the denominator's quality, D43) —
     it just carries no cost. */
  const inBand = decide("trump", 5, "♠", "♥", 0.50, 0.50 + band / 2, MIN_REVIEW_WORLDS);
  assert.equal(inBand.delta, 0, "a trump pick the search cannot separate from its own best costs nothing");
  assert.equal(inBand.grade, "fine");
  assert.equal(inBand.band, band, "the decision must carry the band it was judged against");
  assert.equal(inBand.roundNumber, 5, "…and its own deal number, which the panel prints");
  const outside = decide("call", 5, "♠", "♥", 0.50, 0.50 + band * 2, MIN_REVIEW_WORLDS);
  assert.ok(Math.abs(outside.delta - band * 2) < 1e-12, "a distance outside the band passes through unchanged");
  assert.notEqual(outside.grade, "fine", "…and is graded as the error it is");

  /* The same rule where a reader meets it. matchReport ranks only decisions
     graded worse than fine, so a flawless match must render no costliest
     list at all — not one row at 0.0%, which reads as a cost that was
     measured and found to be zero rather than a decision that was fine. */
  const flawless = matchReport(
    [{ roundNumber: 1, decisions: [dec("play", 0, "fine"), dec("trump", 0, "fine"), dec("bid", 0, "fine")], skipped: [] }], 0, 1);
  assert.equal(flawless.worst.length, 0);
  assert.equal(flawless.worstBid.length, 0);
  const html = renderReport(flawless, { names: ["A", "B", "C", "D"] }, 0);
  assert.doesNotMatch(html, /Costliest decisions/, "a flawless match has no costliest decision to name");
  assert.doesNotMatch(html, /Furthest off the line/, "…nor a bid furthest off the line");
  assert.equal((html.match(/rv-row/g) || []).length, 0, "and so renders no ranked row at all");
});

/* The band as a property of every decision a real match produces, not just
   of the helper in isolation: no graded delta may ever be negative, and none
   may be a positive value at or below its own band. The bid supplies the
   negative side in bulk (most passes are correct passes, i.e. on the far
   side of the line), which is what makes this robust rather than lucky. */
test("no decision from a real match reports a cost its own sampler could not measure", () => {
  let checked = 0, fineAtZero = 0;
  for (const { v } of finishedDealViews()) {
    for (const s of [0, 1, 2, 3]) {
      for (const d of reviewAuction(v, s, {}).decisions) {
        checked++;
        assert.ok(d.delta >= 0, `${d.kind} delta ${d.delta} is negative — being on the right side of the line is not a cost`);
        assert.ok(d.delta === 0 || d.delta > d.band,
          `${d.kind} delta ${d.delta} sits inside its own band ${d.band} — a distance the sampler cannot resolve`);
        if (d.delta === 0) { assert.equal(d.grade, "fine"); fineAtZero++; }
      }
    }
  }
  assert.ok(checked > 20, `expected a real match's worth of auction decisions, got ${checked}`);
  assert.ok(fineAtZero > 0, "a match with no band decision at all would leave this property unexercised");
});

/* Fix round I4: the panel prints what was actually decided, not only how
   much it cost. Every graded decision has carried `played` and `best` since
   Task 4 — whose own best-gating fix was ruled must-fix specifically on the
   premise that this would render them — and renderReport printed neither, so
   a reader got "Deal 4 — 30.0% off the search's line" with no way to know
   what they bid or what the search wanted, while the single-deal review one
   toggle away says "You played ♠J … The search preferred ♥3." */
const playDec = (trickNo, delta, grade, played, best) => ({
  trickNo, played, best, playedWinProb: 0.5, bestWinProb: 0.5 + delta, delta, grade, samples: 24,
});
const S10 = { suit: "♠", rank: 10 }, SQ = { suit: "♠", rank: 12 }, HA = { suit: "♥", rank: 14 };

test("renderReport names the card play the reader made and the one the search preferred", () => {
  const report = matchReport([{ roundNumber: 4, samples: 24, skipped: [],
    decisions: [playDec(3, 0.22, "mistake", S10, SQ)] }], 0, 1);
  const html = renderReport(report, { names: ["A", "B", "C", "D"] }, 0);
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /You played 10 of spades; the search preferred queen of spades\./);
  assert.match(html, /play · deal 4 · trick 3/, "the trick has to be named — a deal number alone cannot tell two card plays apart");
});

test("renderReport tells two card plays from one deal apart", () => {
  const report = matchReport([{ roundNumber: 5, samples: 24, skipped: [],
    decisions: [playDec(2, 0.30, "blunder", S10, SQ), playDec(9, 0.25, "mistake", HA, SQ)] }], 0, 1);
  const html = renderReport(report, { names: ["A", "B", "C", "D"] }, 0);
  assert.match(html, /play · deal 5 · trick 2/);
  assert.match(html, /play · deal 5 · trick 9/);
  assert.equal((html.match(/rv-row/g) || []).length, 2);
  assert.notEqual(html.match(/play · deal 5[^<]*/g)[0], html.match(/play · deal 5[^<]*/g)[1],
    "two card plays from one deal must not render as identical rows");
});

test("renderReport names the trump and the call in each kind's own vocabulary", () => {
  const trumpR = matchReport([{ roundNumber: 2, skipped: [], decisions: [
    { kind: "trump", roundNumber: 2, played: "♠", best: "♥", playedProb: 0.4, bestProb: 0.7, delta: 0.3, band: 0.07, grade: "blunder", worlds: 205 }] }], 0, 1);
  assert.match(renderReport(trumpR, { names: ["A", "B", "C", "D"] }, 0),
    /You chose spades; the search preferred hearts\./);

  const callR = matchReport([{ roundNumber: 2, skipped: [], decisions: [
    { kind: "call", roundNumber: 2, played: S10, best: HA, playedProb: 0.4, bestProb: 0.7, delta: 0.3, band: 0.07, grade: "blunder", worlds: 205 }] }], 0, 1);
  const html = renderReport(callR, { names: ["A", "B", "C", "D"] }, 0);
  assert.match(html, /You called 10 of spades; the search preferred ace of hearts\./);
  assert.doesNotMatch(html, /You played/, "a call is called, not played — the review's own vocabulary");
});

test("renderReport says what was bid and what the search's line was, in the bid's own unit", () => {
  const bid = (roundNumber, played, best, delta) => ({
    kind: "bid", roundNumber, played, best, playedProb: 0.5 + delta, bestProb: 0.5,
    delta, band: 0.07, grade: "blunder", worlds: 205,
  });
  // passed on a hand the search would have bid, and bid on one it would have passed
  const report = matchReport([{ roundNumber: 3, skipped: [], decisions: [bid(3, null, 180, 0.30)] },
                              { roundNumber: 6, skipped: [], decisions: [bid(6, 200, null, 0.25)] }], 0, 2);
  const html = renderReport(report, { names: ["A", "B", "C", "D"] }, 0);
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /You passed; the search&#39;s line was to bid 180\./);
  assert.match(html, /You bid 200; the search&#39;s line was to pass\./);
  assert.doesNotMatch(html, /Costliest decisions/, "a bid is never a commensurable 'costliest' decision (fix round I2)");
});

/* Fix round I3, presentation half only — card play is deliberately NOT
   re-banded, that exemption stands. What was wrong is that describeReport
   pooled auction deltas (noise-floored by construction, D44) with card-play
   deltas that have no floor and are sampled at whatever evaluateMoves
   affords — measurably as few as 11 determinizations on a wide-open early
   lead, a band of ~0.30 — and said nothing, while describeReview says
   exactly this about the same numbers one toggle away. Same THIN_SAMPLES
   boundary, checked from both sides the way renderReview's own caveat test
   in test/client.test.js is. */
test("describeReport caveats a thinly-sampled card play and doesn't caveat a full one, right at the boundary", () => {
  const at = (samples) => describeReport(
    matchReport([{ roundNumber: 1, samples, skipped: [], decisions: [dec("play", 0.1, "mistake")] }], 0, 1),
    { names: ["A", "B", "C", "D"] }, 0);

  const thin = at(19);
  assert.equal(thin.thin, true);
  assert.match(thin.note, /Rough read/);
  assert.match(thin.note, /as few as 19 sampled deals/);
  assert.match(thin.note, /auction/i, "…and says which half of the panel is the better-sampled one");

  const full = at(20);
  assert.equal(full.thin, false, "20 is THIN_SAMPLES itself — inside the full read, not the rough one");
  assert.doesNotMatch(full.note, /Rough read/);
  assert.match(full.note, /at least 20 sampled deals/);

  // and a report with no card play graded at all says nothing about sampling
  const none = describeReport(
    matchReport([{ roundNumber: 1, skipped: [], decisions: [dec("bid", 0.3, "blunder")] }], 0, 1),
    { names: ["A", "B", "C", "D"] }, 0);
  assert.strictEqual(none.note, null, "a caveat about card-play sample size means nothing next to a report with no card play in it");

  /* …and it has to actually reach the panel. A caveat computed and then not
     painted is exactly the state this fix round found describeReport in. */
  const thinReport = matchReport([{ roundNumber: 1, samples: 19, skipped: [], decisions: [dec("play", 0.1, "mistake")] }], 0, 1);
  assert.match(renderReport(thinReport, { names: ["A", "B", "C", "D"] }, 0), /Rough read/,
    "the caveat must be rendered, not merely described");
});

test("a real match's report carries the thinnest card-play sample all the way to the panel", () => {
  const { v, seat } = finishedDealViews()[0];
  const res = handleRequest({ id: 3, kind: "report", deals: [snapshotOf(v)], seat, dealsInMatch: 1 });
  assert.ok(res.ok, `report failed: ${res.error}`);
  const play = reviewDeal(snapshotOf(v), seat, {});
  assert.ok(play.samples > 0, "the fixture must contain real card-play decisions");
  assert.equal(res.result.samples, play.samples,
    "reviewDeal's own deal-level minimum must survive gradeOneDeal's merge — describeReport has nowhere else to get it");
  const s = describeReport(res.result, v, seat);
  assert.ok(s.note, "a report over real card play must always state what its card-play numbers are worth");
});
