/* PIMC hard-AI tests: legality, determinizer soundness, budget, strength sanity. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../app/js/core/engine/index.js";
import { mulberry32 } from "../app/js/core/engine/random.js";

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
  const a = mulberry32(12345), b = mulberry32(12345);
  const xs = Array.from({ length: 200 }, () => a());
  const ys = Array.from({ length: 200 }, () => b());
  assert.deepEqual(xs, ys, "same seed must produce the same stream");
  for (const x of xs) assert.ok(x >= 0 && x < 1, `out of range: ${x}`);
  assert.notDeepEqual(xs, Array.from({ length: 200 }, mulberry32(999)), "different seeds must differ");
});

test("a seeded search is reproducible on one position", () => {
  const G = E.createMatch(); E.startMatch(G);
  while (G.phase !== "playing") stepAI(G);          // helper already in this file
  const seat = G.turn;
  const a = E.choosePIMCCard(G, seat, { rnd: mulberry32(7), determinizations: 8 });
  const b = E.choosePIMCCard(G, seat, { rnd: mulberry32(7), determinizations: 8 });
  assert.deepEqual(a, b, "same seed, same position, same card");
});

test("determinize honours a supplied rng and stays legal", () => {
  const G = E.createMatch(); E.startMatch(G);
  while (G.phase !== "playing") stepAI(G);
  const seat = G.turn;
  // the barrel exports this as `_determinize` (app/js/core/engine/index.js:23)
  const w1 = E._determinize(G, seat, mulberry32(3));
  const w2 = E._determinize(G, seat, mulberry32(3));
  assert.deepEqual(w1, w2, "seeded determinization must repeat");
  for (const p of [0, 1, 2, 3]) if (p !== seat)
    assert.equal(w1[p].length, G.hands[p].length, `seat ${p} got the wrong number of cards`);
});
