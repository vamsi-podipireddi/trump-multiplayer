#!/usr/bin/env node
/* Re-derives every number in ai/bid-search.js's budget comment.
 *
 * Two load-bearing constants (TRUMP_PLAY_BUDGET, CALL_PLAY_BUDGET) were set from
 * measurement rather than taste, and the in-suite strength test provably cannot
 * see them regress — the effect is ~2.5 points a deal against ~25 points of
 * per-deal noise, so a test fast enough for `npm test` has no power over it.
 * This script is where that evidence lives, so the constants can be re-checked
 * whenever the rollout policy (ai/heuristic.js chooseAICard) is tuned, which is
 * what would silently invalidate them.
 *
 * Not run by `npm test` — it takes minutes. Run it deliberately:
 *
 *   node scripts/bench-auction-search.js              # everything, ~4 min
 *   node scripts/bench-auction-search.js cost regret  # named sections only
 *   DEALS=40 node scripts/bench-auction-search.js     # smaller/faster
 *
 * Sections: cost | regret | shortlist | calibration | outcome
 */
import * as E from "../app/js/core/engine/index.js";
import { chooseAICard, aiPickTrump, aiPickPartner, aiBidDecision } from "../app/js/core/engine/ai/heuristic.js";
import { aiBidDecisionSearch, aiPickTrumpSearch, aiPickPartnerSearch,
         BID_PLAY_BUDGET, TRUMP_PLAY_BUDGET, CALL_PLAY_BUDGET } from "../app/js/core/engine/ai/bid-search.js";
import { sortHand } from "../app/js/core/engine/cards.js";

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const ci = xs => 1.96 * sd(xs) / Math.sqrt(xs.length);
const key = c => c.suit + c.rank;
const withTrump = (G, t) => ({ ...G, trump: t });
const fresh = () => { const G = E.createMatch(); E.startMatch(G); return G; };
const worldsFor = (c, b) => Math.max(4, Math.floor(b / (c * 52)));
const pm = (xs) => `${mean(xs) >= 0 ? "+" : ""}${mean(xs).toFixed(2)} +/- ${ci(xs).toFixed(2)}`;

/* Deliberately NOT bid-search.js's playOutWith: an oracle that shares the code
   under test cannot catch that code being wrong. The `cost` section asserts the
   two still agree, so this staying independent is checked, not assumed. */
function evalDeal(G, seat, world, trump, call) {
  const hands = [0, 1, 2, 3].map(p => (p === seat ? G.hands[seat].slice() : world[p].slice()));
  let partner = [0, 1, 2, 3].find(p => hands[p].some(c => E.sameCard(c, call)));
  if (partner === undefined) partner = seat;
  hands.forEach(h => sortHand(h, trump));
  const sim = {
    _silent: true, phase: "playing", trump, bonusSuit: G.bonusSuit, declarer: seat, partner,
    teamsRevealed: true, bid: 130, calledCard: call, dealer: G.dealer, roundNumber: 1, hands,
    trick: [], leadSuit: null, turn: seat, leader: seat, trickNumber: 0,
    tricksWon: [0, 0, 0, 0], capturedPoints: [0, 0, 0, 0], scores: [0, 0, 0, 0],
    names: G.names, log: [], lastWinner: -1, lastWinnerSlot: -1, lastResult: null, targetGames: 99,
  };
  for (let g = 0; g < 300; g++) {
    if (sim.phase === "trickEnd") { E.advanceTrick(sim); continue; }
    if (sim.phase !== "playing") break;
    E.applyPlay(sim, sim.turn, chooseAICard(sim, sim.turn, false, Math.random));
  }
  return partner === seat ? sim.capturedPoints[seat]
                          : sim.capturedPoints[seat] + sim.capturedPoints[partner];
}
const worldsOf = (G, seat, n, rnd) => Array.from({ length: n }, () => E._determinize(G, seat, rnd));
const truth = (G, seat, trump, call, ws) => mean(ws.map(w => evalDeal(G, seat, w, trump, call)));

/* Drive a whole deal, one seat's auction answers swapped for the search's. */
function runDeal(snap, bidFor, trumpFor, callFor) {
  const G = JSON.parse(snap);
  let guard = 0;
  while (G.phase === "bidding" && guard++ < 40) {
    const seat = E.findBidActor(G);
    if (seat === null) break;
    E.applyBid(G, seat, bidFor(G, seat));
    if (G.redealCount > 0) return null;           // a redeal reshuffles; the pairing is gone
  }
  if (G.phase !== "trumpSelect") return null;
  E.applyTrump(G, trumpFor(G, G.declarer));
  E.applyCall(G, callFor(G, G.declarer));
  let g2 = 0;
  while ((G.phase === "playing" || G.phase === "trickEnd") && g2++ < 300) {
    if (G.phase === "trickEnd") { E.advanceTrick(G); continue; }
    E.applyPlay(G, G.turn, chooseAICard(G, G.turn, false, Math.random));
  }
  return G;
}
const toTrumpSelect = (G) => {
  let guard = 0;
  while (G.phase === "bidding" && guard++ < 40) {
    const seat = E.findBidActor(G);
    if (seat === null) break;
    E.applyBid(G, seat, aiBidDecision(G, seat, false, Math.random));
  }
  return G.phase === "trumpSelect";
};

const DEALS = Number(process.env.DEALS || 150);
const EW = Number(process.env.EW || 300);
const want = process.argv.slice(2);
const on = (s) => !want.length || want.includes(s);

// ---------------------------------------------------------------- cost
if (on("cost")) {
  /* PIMC's own arithmetic (pimc.js:95-97): maxDet x legal x cardsLeft plays per
     card decision, and nothing at all when the play is forced. 8000 x 13 is the
     wrong figure — maxDet shrinks with cardsLeft. */
  const pimcFor = (G) => {
    let tot = 0, g = 0;
    while ((G.phase === "playing" || G.phase === "trickEnd") && g++ < 400) {
      if (G.phase === "trickEnd") { E.advanceTrick(G); continue; }
      const legal = E.legalCards(G, G.turn);
      const left = G.hands.reduce((n, h) => n + h.length, 0) || 1;
      if (legal.length > 1) tot += Math.min(24, Math.max(1, Math.floor(8000 / (legal.length * left)))) * legal.length * left;
      E.applyPlay(G, G.turn, chooseAICard(G, G.turn, false, Math.random));
    }
    return tot;
  };
  const pimc = [], nbids = [], sls = [], contracts = [];
  let mismatch = 0, checked = 0;
  for (let d = 0; d < Math.min(DEALS, 60); d++) {
    const G = fresh();
    let n = 0, guard = 0;
    while (G.phase === "bidding" && guard++ < 60) {
      const seat = E.findBidActor(G);
      if (seat === null) break;
      n++;
      E.applyBid(G, seat, aiBidDecisionSearch(G, seat, { rnd: E.mulberry32(d * 100 + n) }));
    }
    if (G.phase !== "trumpSelect") continue;
    nbids.push(n); contracts.push(G.bid);
    sls.push(1 + E.callableCards(G, G.declarer).filter(c => c.rank >= 12).length);
    // the oracle above must still agree with the module's own playOutWith
    const seat = G.declarer, h = aiPickPartner(withTrump(G, aiPickTrump(G, seat)), seat);
    const list = [h, ...E.callableCards(G, seat).filter(c => c.rank >= 12 && !E.sameCard(c, h))];
    const ws = worldsOf(withTrump(G, aiPickTrump(G, seat)), seat, worldsFor(list.length, CALL_PLAY_BUDGET), E.mulberry32(d));
    let best = list[0], bestM = truth(G, seat, aiPickTrump(G, seat), list[0], ws);
    for (const c of list.slice(1)) { const m = truth(G, seat, aiPickTrump(G, seat), c, ws); if (m > bestM) { bestM = m; best = c; } }
    const mod = aiPickPartnerSearch(withTrump(G, aiPickTrump(G, seat)), seat, { rnd: E.mulberry32(d) });
    checked++; if (!E.sameCard(best, mod)) mismatch++;
    E.applyTrump(G, aiPickTrump(G, G.declarer));
    E.applyCall(G, aiPickPartner(G, G.declarer));
    pimc.push(pimcFor(G));
  }
  const P = mean(pimc), nb = mean(nbids), sl = Math.round(mean(sls));
  const bid = nb * worldsFor(1, BID_PLAY_BUDGET) * 52;
  const trump = worldsFor(4, TRUMP_PLAY_BUDGET) * 4 * 52;
  const call = worldsFor(sl, CALL_PLAY_BUDGET) * sl * 52;
  console.log(`== cost (${pimc.length} deals) ==`);
  console.log(`  independent oracle vs the module's own search: ${mismatch}/${checked} disagreements (must be 0)`);
  console.log(`  mean contract ${mean(contracts).toFixed(1)}, ${nb.toFixed(2)} bid decisions an auction, call shortlist ~${mean(sls).toFixed(1)}`);
  console.log(`  PIMC, all four seats, one deal : ${Math.round(P)} plays (${Math.round(P / 4)}/bot)`);
  console.log(`  auction: bid ${Math.round(bid)} + trump ${trump} + call ${Math.round(call)} = ${Math.round(bid + trump + call)} plays  (+${(100 * (bid + trump + call) / P).toFixed(1)}% of PIMC)`);
}

// -------------------------------------------------------------- regret
if (on("regret")) {
  const BUDGETS = [6000, 12000, 24000, 96000];
  console.log(`\n== regret vs the best available candidate (${DEALS} deals, ${EW}-world oracle; lower is better) ==`);
  for (const what of ["trump", "call"]) {
    const reg = {}, gain = {}; BUDGETS.forEach(b => { reg[b] = []; gain[b] = []; });
    const regH = [], spread = [];
    for (let d = 0; d < DEALS; d++) {
      const G = fresh();
      let seat, cands, valOf;
      if (what === "trump") {
        seat = E.findBidActor(G);
        const ws = worldsOf(G, seat, EW, E.mulberry32(900000 + d));
        cands = E.SUITS;
        const v = {}; for (const t of cands) v[t] = truth(G, seat, t, aiPickPartner(withTrump(G, t), seat), ws);
        valOf = (t) => v[t];
      } else {
        if (!toTrumpSelect(G)) continue;
        seat = G.declarer;
        E.applyTrump(G, aiPickTrump(G, seat));
        const h = aiPickPartner(G, seat);
        cands = [h, ...E.callableCards(G, seat).filter(c => c.rank >= 12 && !E.sameCard(c, h))];
        const ws = worldsOf(G, seat, EW, E.mulberry32(800000 + d));
        const v = {}; for (const c of cands) v[key(c)] = truth(G, seat, G.trump, c, ws);
        valOf = (c) => v[key(c)];
      }
      const vals = cands.map(valOf), best = Math.max(...vals);
      spread.push(best - Math.min(...vals));
      const h = what === "trump" ? aiPickTrump(G, seat) : aiPickPartner(G, seat);
      regH.push(best - valOf(h));
      for (const b of BUDGETS) {
        const s = what === "trump" ? aiPickTrumpSearch(G, seat, { rnd: E.mulberry32(1000 + d), playBudget: b })
                                   : aiPickPartnerSearch(G, seat, { rnd: E.mulberry32(2000 + d), playBudget: b });
        reg[b].push(best - valOf(s)); gain[b].push(valOf(s) - valOf(h));
      }
    }
    const shipped = what === "trump" ? TRUMP_PLAY_BUDGET : CALL_PLAY_BUDGET;
    const nc = what === "trump" ? 4 : 10;
    console.log(`  ${what}: best-worst spread ${mean(spread).toFixed(1)} pts · hand-count regret ${mean(regH).toFixed(2)}`);
    for (const b of BUDGETS)
      console.log(`    ${String(b).padStart(6)} (~${String(worldsFor(nc, b)).padStart(3)} worlds/cand) regret ${mean(reg[b]).toFixed(2)}  gain vs hand-count ${pm(gain[b])}${b === shipped ? "   <- shipped" : ""}`);
  }
}

// ----------------------------------------------------------- shortlist
if (on("shortlist")) {
  const rank = {}; const aceCeil = [], regH = [];
  for (let d = 0; d < DEALS; d++) {
    const G = fresh();
    if (!toTrumpSelect(G)) continue;
    const seat = G.declarer;
    E.applyTrump(G, aiPickTrump(G, seat));
    const h = aiPickPartner(G, seat);
    const full = [h, ...E.callableCards(G, seat).filter(c => c.rank >= 12 && !E.sameCard(c, h))];
    const ws = worldsOf(G, seat, EW, E.mulberry32(800000 + d));
    const v = {}; for (const c of full) v[key(c)] = truth(G, seat, G.trump, c, ws);
    const best = Math.max(...full.map(c => v[key(c)]));
    const bc = full.find(c => v[key(c)] === best);
    rank[bc.rank] = (rank[bc.rank] || 0) + 1;
    const aces = full.filter(c => c.rank === 14);
    aceCeil.push(best - (aces.length ? Math.max(...aces.map(c => v[key(c)])) : v[key(h)]));
    regH.push(best - v[key(h)]);
  }
  console.log(`\n== call shortlist: why rank >= 12 and not aces only ==`);
  console.log(`  best call's rank (14=A 13=K 12=Q): ${JSON.stringify(rank)}`);
  console.log(`  an aces-only shortlist forfeits ${mean(aceCeil).toFixed(2)} of the ${mean(regH).toFixed(2)} pts the full one wins back`);
}

// --------------------------------------------------------- calibration
if (on("calibration")) {
  const N = Math.min(DEALS, 250);
  const wrong = { 3000: 0, 6000: 0 }; let near = 0, differ = 0;
  for (let d = 0; d < N; d++) {
    const G = fresh();
    const seat = E.findBidActor(G), need = E.minNextBid(G);
    const t = aiPickTrump(G, seat), c = aiPickPartner(withTrump(G, t), seat);
    const ws = worldsOf(G, seat, 2000, E.mulberry32(700000 + d));
    const p = ws.map(w => evalDeal(G, seat, w, t, c)).filter(x => x >= need).length / ws.length;
    if (Math.abs(p - 0.5) < 0.08) near++;
    const dec = {};
    for (const b of [3000, 6000]) {
      dec[b] = aiBidDecisionSearch(G, seat, { rnd: E.mulberry32(3000 + d), playBudget: b }) !== null;
      if (dec[b] !== (p >= 0.5)) wrong[b]++;
    }
    if (dec[3000] !== dec[6000]) differ++;
  }
  console.log(`\n== bid calibration vs a 2000-world oracle (${N} hands, ${near} within 0.08 of the 0.5 line) ==`);
  console.log(`  wrong at 3000: ${wrong[3000]}   at 6000: ${wrong[6000]}   opening decisions that differ: ${differ}`);
}

// ------------------------------------------------------------- outcome
if (on("outcome")) {
  /* The end metric: deals won. endRound scores made-or-set, so passing and
     setting the other side counts as a win — a bidder cannot game this by
     simply buying more contracts. Paired on the dealt hand; seat 0 swaps
     policy, seats 1-3 always hand-count. */
  const N = Number(process.env.ODEALS || 4000);
  const heur = (d) => (G, seat) => aiBidDecision(G, seat, false, E.mulberry32(d * 31 + seat + G.bidTurn * 7));
  const arms = {
    "bid only": (isS, d) => [
      (G, s) => (s === 0 && isS) ? aiBidDecisionSearch(G, s, { rnd: E.mulberry32(d * 97 + G.bidTurn) }) : heur(d)(G, s),
      (G, s) => aiPickTrump(G, s), (G, s) => aiPickPartner(G, s)],
    "trump+call only": (isS, d) => [heur(d),
      (G, s) => (s === 0 && isS) ? aiPickTrumpSearch(G, s, { rnd: E.mulberry32(d * 13 + 1) }) : aiPickTrump(G, s),
      (G, s) => (s === 0 && isS) ? aiPickPartnerSearch(G, s, { rnd: E.mulberry32(d * 17 + 2) }) : aiPickPartner(G, s)],
    "full auction": (isS, d) => [
      (G, s) => (s === 0 && isS) ? aiBidDecisionSearch(G, s, { rnd: E.mulberry32(d * 97 + G.bidTurn) }) : heur(d)(G, s),
      (G, s) => (s === 0 && isS) ? aiPickTrumpSearch(G, s, { rnd: E.mulberry32(d * 13 + 1) }) : aiPickTrump(G, s),
      (G, s) => (s === 0 && isS) ? aiPickPartnerSearch(G, s, { rnd: E.mulberry32(d * 17 + 2) }) : aiPickPartner(G, s)],
  };
  console.log(`\n== outcome: deals won by seat 0, search vs hand-count (${N} paired deals each) ==`);
  for (const [label, mk] of Object.entries(arms)) {
    const win = [], lvl = []; let extra = 0, extraWon = 0;
    for (let d = 0; d < N; d++) {
      const base = fresh(), snap = JSON.stringify(base);
      const S = runDeal(snap, ...mk(true, d)), H = runDeal(snap, ...mk(false, d));
      if (!S || !H) continue;
      const ws = S.lastResult.winners.includes(0) ? 1 : 0;
      win.push(ws - (H.lastResult.winners.includes(0) ? 1 : 0));
      lvl.push(S.bid - H.bid);
      if (S.declarer === 0 && H.declarer !== 0) { extra++; extraWon += ws; }
    }
    const pp = win.map(x => x * 100);
    console.log(`  ${label.padEnd(16)}: ${pm(pp)} pp  ${Math.abs(mean(pp)) > ci(pp) ? "(significant)" : "(CI spans 0)"}  contract ${mean(lvl) >= 0 ? "+" : ""}${mean(lvl).toFixed(1)} pts` +
      (extra ? `, bought ${extra} contracts the hand-count did not and won ${(100 * extraWon / extra).toFixed(1)}% of them` : ""));
  }
}
