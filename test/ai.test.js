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
import { chooseAICard as legacyChooseAICard } from "../app/js/core/engine/ai/heuristic.js";

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
