/* PIMC hard-AI tests: legality, determinizer soundness, budget, strength sanity. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../app/js/core/engine/index.js";
/* Deliberate exception to "consumers import the barrel" (docs/STRUCTURE.md rule 1):
   chooseAICard has no barrel export path (only aiActionFor does, and it never
   forwards a seedable rnd for the "play" case — see ai/index.js), and at ~60
   lines of live trick-following strategy it's exactly the kind of thing the
   frozen oracle below must NOT duplicate. It is unmodified by this task, so
   importing the live function is safe: only the oracle's own accumulator math
   needs to be frozen, not everything it calls. */
import { chooseAICard as legacyChooseAICard, aiPickTrump, aiPickPartner, aiBidDecision } from "../app/js/core/engine/ai/heuristic.js";
/* Same exception, same reason: the auction budgets are internal tuning constants
   deliberately kept off the barrel (as PIMC_PLAY_BUDGET is), but they encode a
   measured result and a silent reset of them would undo this task's content. */
import { BID_PLAY_BUDGET, TRUMP_PLAY_BUDGET, CALL_PLAY_BUDGET } from "../app/js/core/engine/ai/bid-search.js";

const key = c => c.suit + c.rank;

/* Drive whichever actor is currently due, one action at a time, via
   aiActionFor. Unlike gameAtPlay() below (which loops internally straight
   through to "playing"), this takes a single step so a caller can halt on
   any phase boundary — the seeded-search tests below stop as soon as play
   begins, without caring how the auction went. */
function stepAI(G) {
  const ra = E.requiredActor(G);
  const act = E.aiActionFor(G, ra.seat, "normal");
  if (act.type === "bid") E.applyBid(G, ra.seat, act.value);
  else if (act.type === "trump") E.applyTrump(G, act.suit);
  else if (act.type === "call") E.applyCall(G, act.card);
  else if (act.type === "play") E.applyPlay(G, ra.seat, act.card);
}

/* Drive a fresh match to the start of play with the heuristic AI. */
function gameAtPlay() {
  const G = E.createMatch();
  E.startMatch(G);
  let guard = 0;
  while (G.phase !== "playing" && guard++ < 200) {
    const ra = E.requiredActor(G);
    const act = E.aiActionFor(G, ra.seat, "normal");
    if (act.type === "bid") E.applyBid(G, ra.seat, act.value);
    else if (act.type === "trump") E.applyTrump(G, act.suit);
    else if (act.type === "call") E.applyCall(G, act.card);
  }
  assert.equal(G.phase, "playing");
  return G;
}
function stepRound(G, chooser) {
  if (G.phase === "trickEnd") { E.advanceTrick(G); return; }
  const p = G.turn;
  const card = chooser(G, p);
  assert.equal(E.playIsLegal(G, p, card), true, "chooser produced an illegal card");
  E.applyPlay(G, p, card);
}

test("PIMC always returns a legal card, throughout whole rounds", () => {
  for (let g = 0; g < 3; g++) {
    const G = gameAtPlay();
    let guard = 0;
    while (G.phase === "playing" || G.phase === "trickEnd") {
      assert.ok(guard++ < 300);
      stepRound(G, (g2, p) => E.choosePIMCCard(g2, p, { determinizations: 6, timeMs: 10 }));
    }
    assert.ok(["roundEnd", "matchOver"].includes(G.phase));
  }
});

test("determinizer: exact partition of unseen cards, honors voids and called card", () => {
  const G = gameAtPlay();
  // play a few tricks so voids and played cards accumulate
  let guard = 0;
  while (G.trickNumber < 5 && guard++ < 100) stepRound(G, (g2, p) => E.aiActionFor(g2, p, "normal").card);
  assert.equal(G.phase === "playing" || G.phase === "trickEnd", true);
  if (G.phase === "trickEnd") E.advanceTrick(G);
  const me = G.turn;
  for (let s = 0; s < 20; s++) {
    const world = E._determinize(G, me);
    assert.ok(world, "determinizer produced a world");
    const seen = new Set([...G.hands[me].map(key), ...G.playedCards.map(key)]);
    const dealt = [];
    for (const p of [0, 1, 2, 3]) {
      if (p === me) continue;
      assert.equal(world[p].length, G.hands[p].length, `seat ${p} hand size`);
      for (const c of world[p]) {
        dealt.push(key(c));
        assert.ok(!seen.has(key(c)), "dealt card is not a seen card");
        if (G.voids[p][c.suit]) assert.fail(`seat ${p} was void in ${c.suit} but got ${key(c)}`);
      }
    }
    assert.equal(new Set(dealt).size, dealt.length, "no duplicate cards dealt");
    assert.equal(dealt.length, 52 - seen.size, "all unseen cards dealt");
    if (G.calledCard && G.partner !== me && !G.playedCards.some(c => E.sameCard(c, G.calledCard)))
      assert.ok(world[G.partner].some(c => E.sameCard(c, G.calledCard)), "called card with partner");
  }
});

test("PIMC respects its time budget", () => {
  const G = gameAtPlay();
  const t0 = Date.now();
  E.choosePIMCCard(G, G.turn, { determinizations: 1000, timeMs: 30 });
  assert.ok(Date.now() - t0 < 400, "budget cutoff works (first-trick worst case)");
});

/* Cloudflare freezes Date.now() between I/O operations, so inside a Durable
   Object a wall-clock cutoff never fires. The search has to bound itself on
   work done, or the widest position runs at full width and burns the CPU
   budget. Simulate the frozen clock and check the bound still holds. */
test("PIMC bounds its work with a clock that never advances (Workers)", () => {
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const G = gameAtPlay();                 // first trick: 13 legal moves, 52 cards live
    const t0 = realNow();
    const card = E.choosePIMCCard(G, G.turn, { determinizations: 1000, timeMs: 30 });
    const spent = realNow() - t0;
    assert.equal(E.playIsLegal(G, G.turn, card), true, "still returns a legal card");
    assert.ok(spent < 150, `frozen clock must not uncap the search (took ${spent}ms)`);

    // and the budget must scale: the endgame is cheap, so it may search deeper
    let guard = 0;
    while (G.trickNumber < 10 && guard++ < 200) {
      if (G.phase === "trickEnd") { E.advanceTrick(G); continue; }
      if (G.phase !== "playing") break;
      E.applyPlay(G, G.turn, E.aiActionFor(G, G.turn, "normal").card);
    }
    if (G.phase === "trickEnd") E.advanceTrick(G);
    if (G.phase === "playing") {
      const late = realNow();
      E.choosePIMCCard(G, G.turn, { determinizations: 24, timeMs: 30 });
      assert.ok(realNow() - late < 150, "late-trick search stays bounded too");
    }
  } finally { Date.now = realNow; }
});

test("hard AI is not weaker than the heuristic (paired-deal comparison)", () => {
  // Same dealt round played twice from the identical position: once all-heuristic,
  // once with the declaring side on PIMC. Paired deals kill most variance; assert
  // the PIMC side is at least as good within a small tolerance.
  let heurPts = 0, pimcPts = 0;
  const DEALS = 16;
  for (let d = 0; d < DEALS; d++) {
    const base = gameAtPlay();
    const snap = JSON.stringify(base);
    const run = (usePimc) => {
      const G = JSON.parse(snap);
      let guard = 0;
      while (G.phase === "playing" || G.phase === "trickEnd") {
        assert.ok(guard++ < 300);
        stepRound(G, (g2, p) => {
          const declSide = E.sideOf(g2, p) === "D";
          if (usePimc && declSide) return E.choosePIMCCard(g2, p, { determinizations: 10, timeMs: 12 });
          return E.aiActionFor(g2, p, "normal").card;
        });
      }
      return G.capturedPoints[G.declarer] + G.capturedPoints[G.partner];
    };
    heurPts += run(false);
    pimcPts += run(true);
  }
  const heurAvg = heurPts / DEALS, pimcAvg = pimcPts / DEALS;
  // tolerance: paired but still stochastic — require "not clearly worse"
  assert.ok(pimcAvg >= heurAvg - 8,
    `PIMC declaring side averaged ${pimcAvg.toFixed(1)} vs heuristic ${heurAvg.toFixed(1)}`);
});

test("mulberry32 is deterministic and in range", () => {
  const a = E.mulberry32(12345), b = E.mulberry32(12345);
  const xs = Array.from({ length: 200 }, () => a());
  const ys = Array.from({ length: 200 }, () => b());
  assert.deepEqual(xs, ys, "same seed must produce the same stream");
  for (const x of xs) assert.ok(x >= 0 && x < 1, `out of range: ${x}`);
  assert.notDeepEqual(xs, Array.from({ length: 200 }, E.mulberry32(999)), "different seeds must differ");
});

test("a seeded search is reproducible on one position", () => {
  const G = E.createMatch(); E.startMatch(G);
  while (G.phase !== "playing") stepAI(G);          // helper already in this file
  const seat = G.turn;
  const a = E.choosePIMCCard(G, seat, { rnd: E.mulberry32(7), determinizations: 8 });
  const b = E.choosePIMCCard(G, seat, { rnd: E.mulberry32(7), determinizations: 8 });
  assert.deepEqual(a, b, "same seed, same position, same card");
});

test("determinize honours a supplied rng and stays legal", () => {
  const G = E.createMatch(); E.startMatch(G);
  while (G.phase !== "playing") stepAI(G);
  const seat = G.turn;
  // the barrel exports this as `_determinize` (app/js/core/engine/index.js:23)
  const w1 = E._determinize(G, seat, E.mulberry32(3));
  const w2 = E._determinize(G, seat, E.mulberry32(3));
  assert.deepEqual(w1, w2, "seeded determinization must repeat");
  for (const p of [0, 1, 2, 3]) if (p !== seat)
    assert.equal(w1[p].length, G.hands[p].length, `seat ${p} got the wrong number of cards`);
});

test("evaluateMoves scores every legal card", () => {
  const G = E.createMatch(); E.startMatch(G);
  while (G.phase !== "playing") stepAI(G);
  const seat = G.turn;
  const ev = E.evaluateMoves(G, seat, { rnd: E.mulberry32(11), determinizations: 6 });
  assert.equal(ev.moves.length, E.legalCards(G, seat).length);
  for (const m of ev.moves) {
    assert.ok(m.winProb >= 0 && m.winProb <= 1, `winProb out of range: ${m.winProb}`);
    assert.ok(m.meanPoints >= 0 && m.meanPoints <= 250, `meanPoints out of range: ${m.meanPoints}`);
    assert.ok(m.samples > 0, "every legal card must be sampled");
  }
});

test("choosePIMCCard is exactly the argmax of winProb*1000 + meanPoints", () => {
  for (let trial = 0; trial < 12; trial++) {
    const G = E.createMatch(); E.startMatch(G);
    while (G.phase !== "playing") stepAI(G);
    const seat = G.turn;
    const opts = { rnd: E.mulberry32(100 + trial), determinizations: 8 };
    const ev = E.evaluateMoves(G, seat, { ...opts, rnd: E.mulberry32(100 + trial) });
    let best = ev.moves[0];
    for (const m of ev.moves) if (m.winProb * 1000 + m.meanPoints > best.winProb * 1000 + best.meanPoints) best = m;
    const picked = E.choosePIMCCard(G, seat, { ...opts, rnd: E.mulberry32(100 + trial) });
    assert.deepEqual(picked, best.card, "the wrapper must pick what the evaluator ranks first");
  }
});

test("choosePIMCCard still short-circuits a forced play", () => {
  const G = E.createMatch(); E.startMatch(G);
  while (G.phase !== "playing") stepAI(G);
  const seat = G.turn;
  G.hands[seat] = [G.hands[seat][0]];                       // exactly one card
  assert.deepEqual(E.choosePIMCCard(G, seat), G.hands[seat][0]);
});

/* ---- the auction search (ai/bid-search.js) ---- */

test("the auction search returns legal decisions", () => {
  for (let trial = 0; trial < 10; trial++) {
    const G = E.createMatch(); E.startMatch(G);
    const seat = E.findBidActor(G);
    const bid = E.aiBidDecisionSearch(G, seat, { rnd: E.mulberry32(trial) });
    assert.ok(bid === null || E.bidIsLegal(G, seat, bid), `illegal bid ${bid}`);
    while (G.phase !== "trumpSelect") stepAI(G);
    const suit = E.aiPickTrumpSearch(G, G.declarer, { rnd: E.mulberry32(trial) });
    assert.ok(["♠", "♥", "♦", "♣"].includes(suit), `not a suit: ${suit}`);
    E.applyTrump(G, suit);
    const call = E.aiPickPartnerSearch(G, G.declarer, { rnd: E.mulberry32(trial) });
    assert.ok(E.callIsLegal(G, call), `illegal call ${JSON.stringify(call)}`);
  }
});

test("bidValue produces a monotone make-probability", () => {
  const G = E.createMatch(); E.startMatch(G);
  const seat = E.findBidActor(G);
  const val = E.bidValue(G, seat, { rnd: E.mulberry32(4) });
  assert.ok(val.samples.length > 0, "no deals were sampled");
  assert.ok(val.makeProb(130) >= val.makeProb(250) , "a higher target cannot be easier to make");
  assert.ok(val.makeProb(0) === 1, "every deal captures at least nothing");
  assert.ok(val.median >= 0 && val.median <= 250);
});

test("the auction search is seed-reproducible", () => {
  const G = E.createMatch(); E.startMatch(G);
  const seat = E.findBidActor(G);
  const a = E.aiBidDecisionSearch(G, seat, { rnd: E.mulberry32(77) });
  const b = E.aiBidDecisionSearch(G, seat, { rnd: E.mulberry32(77) });
  assert.equal(a, b);
  /* The decision above is near-binary, so two runs on *different* seeds would
     agree most of the time too — it barely discriminates against an unseeded
     Math.random leaking in. The sample vector costs the same and cannot. */
  assert.deepEqual(E.bidValue(G, seat, { rnd: E.mulberry32(77) }).samples,
                   E.bidValue(G, seat, { rnd: E.mulberry32(77) }).samples,
                   "same seed, same position, same sampled deals");
  assert.notDeepEqual(E.bidValue(G, seat, { rnd: E.mulberry32(77) }).samples,
                      E.bidValue(G, seat, { rnd: E.mulberry32(78) }).samples,
                      "a different seed must sample different deals");
});

test("the search bids more sanely than the hand-count on a strong hand", () => {
  /* A hand with four aces and long trumps should not pass at the minimum.
     Build it explicitly rather than hoping a random deal produces one. */
  const G = E.createMatch(); E.startMatch(G);
  const seat = E.findBidActor(G);
  G.hands[seat] = [
    { suit: "♠", rank: 14 }, { suit: "♠", rank: 13 }, { suit: "♠", rank: 12 }, { suit: "♠", rank: 11 },
    { suit: "♠", rank: 10 }, { suit: "♠", rank: 9 }, { suit: "♠", rank: 5 },
    { suit: "♥", rank: 14 }, { suit: "♥", rank: 13 }, { suit: "♦", rank: 14 },
    { suit: "♦", rank: 13 }, { suit: "♣", rank: 14 }, { suit: "♣", rank: 13 },
  ];
  assert.notEqual(E.aiBidDecisionSearch(G, seat, { rnd: E.mulberry32(2) }), null,
    "a hand like this must not pass at 130");
});

/* The auction search must bound itself the way PIMC does — on simulated plays,
   never on the clock — because Date.now() is frozen between I/O operations
   inside a Durable Object. Unlike PIMC this search has no wall-clock guard at
   all, so the sample count is exactly the budget divided by a deal's worth of
   plays, and a frozen clock changes nothing. */
test("the auction search bounds itself in simulated plays, not milliseconds", () => {
  const G = E.createMatch(); E.startMatch(G);
  const seat = E.findBidActor(G);
  assert.equal(E.bidValue(G, seat, { rnd: E.mulberry32(9), playBudget: 5200 }).samples.length, 100);
  assert.equal(E.bidValue(G, seat, { rnd: E.mulberry32(9), playBudget: 1040 }).samples.length, 20);

  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const t0 = realNow(), need = E.minNextBid(G);
    const bid = E.aiBidDecisionSearch(G, seat, { rnd: E.mulberry32(9) });
    assert.ok(bid === null || bid === need, "a bidder takes the next step or passes");
    while (G.phase !== "trumpSelect") stepAI(G);
    const suit = E.aiPickTrumpSearch(G, G.declarer, { rnd: E.mulberry32(9) });
    E.applyTrump(G, suit);
    const call = E.aiPickPartnerSearch(G, G.declarer, { rnd: E.mulberry32(9) });
    assert.ok(E.SUITS.includes(suit) && E.callIsLegal(G, call), "a frozen clock must not break the search");
    assert.ok(realNow() - t0 < 2000, "a frozen clock must not uncap the search");
  } finally { Date.now = realNow; }
});

/* The four tests above are plumbing: legality, determinism, and the shape of
   makeProb. Every one of them passes for a searcher that returns a random legal
   answer, so none of them would notice this task being undone. This is the
   strength test — the same paired-deal idiom as "hard AI is not weaker than the
   heuristic" above, moved to the auction.

   One shared set of sampled deals judges both answers (bidValue plays out
   whatever trump and call it is handed), so the comparison is exactly paired and
   far tighter than replaying two realised deals would be.

   Calibrated, not guessed: over 40 runs the statistic sits at +2.8 (sd 1.5) as
   shipped and at -32 (sd 7.3) for a searcher answering at random, so -5 is ~5 sd
   below shipped and ~4 sd above random. It is a catastrophe detector and nothing
   finer — a budget reset to 6000 lands at +0.4 (sd 2.1), which no assertion this
   cheap can separate from +2.8. That regression is caught by the constants
   below, and quantified by scripts/bench-auction-search.js. */
test("the searched trump and call are not weaker than the hand-count (paired deals)", () => {
  const DEALS = 12;
  let searched = 0, heuristic = 0;
  for (let d = 0; d < DEALS; d++) {
    const G = E.createMatch(); E.startMatch(G);
    while (G.phase !== "trumpSelect") stepAI(G);
    const seat = G.declarer;
    const hT = aiPickTrump(G, seat), hC = aiPickPartner({ ...G, trump: hT }, seat);
    const sT = E.aiPickTrumpSearch(G, seat, { rnd: E.mulberry32(d) });
    const sC = E.aiPickPartnerSearch({ ...G, trump: sT }, seat, { rnd: E.mulberry32(d) });
    const value = (trump, call) => {
      const s = E.bidValue({ ...G, trump, calledCard: call }, seat,
                           { rnd: E.mulberry32(9000 + d), playBudget: 6000 }).samples;
      return s.reduce((a, b) => a + b, 0) / s.length;
    };
    searched += value(sT, sC); heuristic += value(hT, hC);
  }
  const gain = (searched - heuristic) / DEALS;
  assert.ok(gain > -5, `searched trump+call averaged ${gain.toFixed(2)} pts against the hand-count`);
});

/* The budgets are the content of this task, and the in-suite strength test above
   provably cannot see them change. Assert the quantity that actually matters —
   worlds per candidate, the thing worldsFor computes — so that either a budget
   reset or a change to the formula fails loudly and lands the reader here.

   Measured basis (scripts/bench-auction-search.js): at 11 worlds the call search
   buys nothing measurable over the hand-count it replaces (-0.27 +/- 0.96 pts a
   deal); at ~46 it is worth +2.60 +/- 0.87. Lower these and the search stops
   being an improvement — that is a real result, not a stylistic preference. */
test("the auction budgets still buy enough worlds per candidate to beat the hand-count", () => {
  const worldsPer = (candidates, budget) => Math.max(4, Math.floor(budget / (candidates * 52)));
  assert.ok(worldsPer(1, BID_PLAY_BUDGET) >= 50,
    `the bid threshold test needs ~57 worlds, got ${worldsPer(1, BID_PLAY_BUDGET)}`);
  assert.ok(worldsPer(4, TRUMP_PLAY_BUDGET) >= 100,
    `the trump argmax needs ~115 worlds a suit, got ${worldsPer(4, TRUMP_PLAY_BUDGET)}`);
  assert.ok(worldsPer(10, CALL_PLAY_BUDGET) >= 40,
    `the call argmax needs ~46 worlds a card, got ${worldsPer(10, CALL_PLAY_BUDGET)}`);
  // and the budget really is what sizes the sample, not a coincidence of defaults
  const G = E.createMatch(); E.startMatch(G);
  assert.equal(E.bidValue(G, E.findBidActor(G), { rnd: E.mulberry32(5) }).samples.length,
               worldsPer(1, BID_PLAY_BUDGET));
});

/* ---- the difficulty tiers (ai/index.js) ---- */

test("every difficulty produces a legal auction action", () => {
  for (let trial = 0; trial < 8; trial++) {
    const G = E.createMatch(); E.startMatch(G);
    const seat = E.findBidActor(G);
    for (const level of ["easy", "normal", "hard"]) {
      const act = E.aiActionFor(G, seat, level);
      assert.equal(act.type, "bid");
      assert.ok(act.value === null || E.bidIsLegal(G, seat, act.value), `${level} produced an illegal bid`);
    }
    let guard = 0;
    // an all-pass auction redeals and stays in "bidding", so this is not one pass of four
    while (G.phase !== "partnerSelect") { assert.ok(guard++ < 200, "the auction never declared"); stepAI(G); }
    const call = E.aiActionFor(G, G.declarer, "hard");
    assert.equal(call.type, "call");
    assert.ok(E.callIsLegal(G, call.card), "hard called a card it already holds");
  }
});

/* The three routing tests below are the content of this task. Each one is
   written so that the *unwired* engine — hard answering the auction with the
   hand-count, as every tier did before — scores exactly zero on the statistic,
   rather than merely scoring lower. That is what makes them fail before the
   change instead of passing marginally.

   The bid needs the extra care: aiBidDecision adds rnd()*16-8 to its estimate,
   so an unwired `hard` and a `normal` disagree on their own a few percent of the
   time and a naive difference count would pass without the wiring. Pinning the
   noise to each end of its range instead gives the two verdicts the hand-count
   *cannot* contradict however the die falls — and an unwired hard is the
   hand-count, so it contradicts them zero times by construction.

   Measured over 400 opening positions: the search contradicts a forced verdict
   16.3% of the time (22.6% across every turn of a live auction, where the target
   is higher and the hand-count's flat +60 hurts most). At 80 positions the
   expected count is ~13; requiring 2 is ~5 sd low, P(fail) ~ 2e-5. */
test("hard bids from the search: it contradicts verdicts the hand-count cannot", () => {
  const POSITIONS = 80;
  let forced = 0, contradicted = 0;
  for (let t = 0; t < POSITIONS; t++) {
    const G = E.createMatch(); E.startMatch(G);
    const seat = E.findBidActor(G);
    const bids = (v) => v !== null;
    // rnd() = 0 is the estimate's floor (-8), rnd() ~ 1 its ceiling (+8)
    const floorBids = bids(aiBidDecision(G, seat, false, () => 0));
    const ceilBids = bids(aiBidDecision(G, seat, false, () => 1 - 1e-9));
    if (floorBids === ceilBids) {                       // the hand-count is forced either way
      forced++;
      if (bids(E.aiActionFor(G, seat, "hard").value) !== floorBids) contradicted++;
    }
  }
  assert.ok(forced > POSITIONS / 4, `too few forced hand-count verdicts to test (${forced})`);
  assert.ok(contradicted >= 2,
    `hard's bid left the hand-count's forced verdict only ${contradicted} times of ${forced} — the search is not wired in`);
});

/* Unlike the bid, aiPickTrump and aiPickPartner are deterministic, so any
   disagreement at all proves the search answered. Measured over 60 declared
   deals: the searched trump differs 20% of the time and the searched call 50%,
   so 16 deals expect ~11 of 32 decisions to move; requiring 3 is ~3 sd low.
   The easy/normal assertions are exact — those tiers must not drift. */
test("hard picks trump and the call from the search; easy and normal keep the hand-count", () => {
  const DEALS = 16;
  let differ = 0;
  for (let d = 0; d < DEALS; d++) {
    const G = E.createMatch(); E.startMatch(G);
    let guard = 0;
    while (G.phase !== "trumpSelect") { assert.ok(guard++ < 200, "the auction never declared"); stepAI(G); }
    const seat = G.declarer;
    const hT = aiPickTrump(G, seat);
    for (const level of ["easy", "normal"])
      assert.equal(E.aiActionFor(G, seat, level).suit, hT, `${level} must keep the hand-count's trump`);
    if (E.aiActionFor(G, seat, "hard").suit !== hT) differ++;
    E.applyTrump(G, hT);                                // both tiers judged on one position
    const hC = aiPickPartner(G, seat);
    for (const level of ["easy", "normal"])
      assert.deepEqual(E.aiActionFor(G, seat, level).card, hC, `${level} must keep the hand-count's call`);
    if (!E.sameCard(E.aiActionFor(G, seat, "hard").card, hC)) differ++;
  }
  assert.ok(differ >= 3,
    `hard's trump and call never left the hand-count (${differ} of ${2 * DEALS} decisions) — the search is not wired in`);
});

/* Difficulty is one room setting applied to every bot, so the shape that ships
   is four searching seats bidding against each other, not one against three
   hand-counters. Deals won is structurally blind to that — exactly two of four
   seats win every deal, so an all-hard table scores 50% against itself whatever
   the seats do — and the auction's own level is the statistic that is not.

   Paired on the dealt hands and stopped at the declaration, so this costs four
   auctions a deal and no card play at all. Calibrated the way the budgets above
   were: over 40 runs of 20 paired deals the difference sits at +13.7 (sd 2.4,
   min 6.8) as wired, and at +0.2 (sd 1.2, max 2.3) for the unwired engine
   (normal against normal, which is what hard *was*). +5 is 3.6 sd below shipped
   and 4.1 sd above the null.

   That the extra ambition is *paid for* — set 33.8% against the hand-count's
   26.9%, buying 13 points of contract with 8.6 points of margin that a binary
   score wastes anyway — is scripts/bench-auction-search.js `table`'s result over
   4000 deals a side. No test cheap enough for `npm test` can see it. */
test("an all-hard table bids the auction up, where an all-normal one does not", () => {
  const DEALS = 20;
  const auctionLevel = (snap, level) => {
    const G = JSON.parse(snap);
    let guard = 0;
    while (G.phase === "bidding" && guard++ < 80) {
      const seat = E.findBidActor(G);
      if (seat === null) break;
      E.applyBid(G, seat, E.aiActionFor(G, seat, level).value);
    }
    return G.phase === "trumpSelect" ? G.bid : null;    // an all-pass redeal has no contract
  };
  const diffs = [];
  for (let d = 0; d < DEALS; d++) {
    const snap = JSON.stringify((() => { const G = E.createMatch(); E.startMatch(G); return G; })());
    const hard = auctionLevel(snap, "hard"), normal = auctionLevel(snap, "normal");
    if (hard !== null && normal !== null) diffs.push(hard - normal);
  }
  assert.ok(diffs.length >= DEALS - 2, `${DEALS - diffs.length} of ${DEALS} auctions never declared`);
  const lift = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  assert.ok(lift >= 5,
    `an all-hard auction settled only ${lift.toFixed(1)} pts above an all-normal one over ${diffs.length} paired deals`);
});

/* ============================================================
   Frozen oracle — pre-refactor choosePIMCCard, for a one-time equivalence
   proof against the post-refactor evaluateMoves/choosePIMCCard split.
   Copied verbatim from commit 1dd30ad (Task 1's accepted rnd-threading
   baseline — the correct "before" to diff against, since that threading is
   not itself in question here). This is NOT a second implementation to
   maintain: nobody should ever "fix" it to track pimc.js again. Its only
   job is to run its own independent determinize+rollout+accumulate loop —
   using the OLD fused `totals[i] += win*1000 + margin` accumulator instead
   of evaluateMoves' split wins[]/pts[] — so that a bug inside evaluateMoves'
   loop (swapped wins/pts, a flipped iAmDeclaring branch, a broken split-vs-
   fused identity) would move only ONE side of the comparison and actually
   get caught. (The existing "argmax of winProb*1000 + meanPoints" test above
   cannot catch those: both its sides call evaluateMoves itself, so a bug
   there moves both sides together and the test stays green regardless.)

   rolloutClone/playOutRound are copied alongside it, byte-identical to
   pimc.js's current versions (diffed against HEAD to confirm), because
   pimc.js exports neither of them anywhere and adding exports solely to
   serve this test isn't warranted for ~20 lines of object-shape plumbing
   with no game-strategy logic in it — low risk to freeze. chooseAICard is
   the one piece imported live rather than duplicated; see the import
   comment above for why. */
function legacyRolloutClone(G) {
  return {
    _silent: true,
    phase: G.phase, trump: G.trump, bonusSuit: G.bonusSuit,
    declarer: G.declarer, partner: G.partner, teamsRevealed: true, bid: G.bid,
    calledCard: G.calledCard, dealer: G.dealer, roundNumber: G.roundNumber,
    hands: G.hands.map(h => h.slice()),
    trick: G.trick.map(t => ({ player: t.player, card: t.card })),
    leadSuit: G.leadSuit, turn: G.turn, leader: G.leader, trickNumber: G.trickNumber,
    tricksWon: G.tricksWon.slice(), capturedPoints: G.capturedPoints.slice(),
    scores: G.scores.slice(), names: G.names, log: [],
    lastWinner: G.lastWinner, lastWinnerSlot: G.lastWinnerSlot, lastResult: null,
    targetGames: G.targetGames,
  };
}
function legacyPlayOutRound(sim, rnd) {
  for (let guard = 0; guard < 300; guard++) {
    if (sim.phase === "trickEnd") { E.advanceTrick(sim); continue; }
    if (sim.phase !== "playing") return;
    E.applyPlay(sim, sim.turn, legacyChooseAICard(sim, sim.turn, false, rnd));
  }
}
const LEGACY_PIMC_PLAY_BUDGET = 8000; // pimc.js's PIMC_PLAY_BUDGET at 1dd30ad — still 8000 today, unchanged by this task

function legacyChoosePIMCCard(G, me, opts) {
  const legal = E.legalCards(G, me);
  if (legal.length <= 1) return legal[0];
  const timeMs = (opts && opts.timeMs) || 25;
  const budget = (opts && opts.playBudget) || LEGACY_PIMC_PLAY_BUDGET;
  const rnd = (opts && opts.rnd) || Math.random;
  const cardsLeft = G.hands.reduce((n, h) => n + h.length, 0) || 1;
  const affordable = Math.max(1, Math.floor(budget / (legal.length * cardsLeft)));
  const maxDet = Math.min((opts && opts.determinizations) || 24, affordable);
  const started = Date.now();
  const iAmDeclaring = E.sideOf(G, me) === "D";
  const totals = legal.map(() => 0), counts = legal.map(() => 0);

  for (let d = 0; d < maxDet; d++) {
    if (d >= 4 && Date.now() - started > timeMs) break; // secondary guard; a no-op on Workers
    const world = E._determinize(G, me, rnd);
    if (!world) return legacyChooseAICard(G, me, false);
    for (let i = 0; i < legal.length; i++) {
      const sim = legacyRolloutClone(G);
      for (const p of [0, 1, 2, 3]) if (p !== me) sim.hands[p] = world[p].slice();
      E.applyPlay(sim, me, legal[i]);
      legacyPlayOutRound(sim, rnd);
      const dPts = sim.capturedPoints[sim.declarer] + sim.capturedPoints[sim.partner];
      const made = dPts >= sim.bid;
      const win = (iAmDeclaring === made) ? 1 : 0;
      const margin = iAmDeclaring ? dPts : E.TOTAL_POINTS - dPts;
      totals[i] += win * 1000 + margin; counts[i]++;
    }
  }
  let best = 0, bestAvg = -Infinity;
  for (let i = 0; i < legal.length; i++) {
    if (!counts[i]) continue;
    const avg = totals[i] / counts[i];
    if (avg > bestAvg) { bestAvg = avg; best = i; }
  }
  return legal[best];
}

test("choosePIMCCard agrees with a frozen pre-refactor oracle (genuine equivalence, not read-back)", () => {
  for (let trial = 0; trial < 12; trial++) {
    const G = E.createMatch(); E.startMatch(G);
    while (G.phase !== "playing") stepAI(G);
    const seat = G.turn;
    // each call gets its own freshly-seeded generator — sharing one instance
    // would desynchronise the two streams and fail this for the wrong reason
    const a = E.choosePIMCCard(G, seat, { rnd: E.mulberry32(500 + trial) });
    const b = legacyChoosePIMCCard(G, seat, { rnd: E.mulberry32(500 + trial) });
    assert.deepEqual(a, b, "refactored search must agree with the pre-refactor fused-accumulator oracle");
  }
});
