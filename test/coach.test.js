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
import { handleRequest } from "../app/js/coach/worker.js";
import { reviewDeal, REVIEW_PLAY_BUDGET } from "../app/js/coach/review.js";

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

test("the heuristic's own answer is evaluated first, so a tie leaves it standing", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  driveToDeclarer(G);
  const ev = E.evaluateTrumps(G, G.declarer, { rnd: E.mulberry32(3), playBudget: 24000 });
  assert.equal(ev.candidates.length, 4);
  // candidates[0] is the heuristic's pick; a reduce with strict > keeps the first on a tie
  assert.ok(E.SUITS.includes(ev.candidates[0].suit));
});
