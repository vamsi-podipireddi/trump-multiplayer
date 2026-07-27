/* ============================================================
   TRUMP — authoritative game engine (server-side, no I/O)
   250-point bid/capture trick game. All functions operate on an
   explicit game object G (no globals), so one process can run many
   rooms. The server drives timing + networking; this file is pure logic.
   Seats: 0,1,2,3 clockwise. Card points total 250:
   A/K/Q/J/10=10, each 5=5, one random suit's 3 = 30.
   ============================================================ */

import { SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP,
         TOTAL_POINTS, TARGET_GAMES, MAX_REDEALS } from "./app/js/core/engine/constants.js";
import { randomInt, shuffleFast } from "./app/js/core/engine/random.js";
import { buildDeck, sameCard, rankLabel, cardStr, beats, winningIndex } from "./app/js/core/engine/cards.js";
import { cardPoints, trickPoints, sideOf, defenders } from "./app/js/core/engine/scoring.js";
import { createMatch, startMatch, nextDeal, publicView } from "./app/js/core/engine/match.js";
import { findBidActor, minNextBid, bidIsLegal, applyBid } from "./app/js/core/engine/bidding.js";
import { applyTrump, callableCards, callIsLegal, applyCall } from "./app/js/core/engine/contract.js";
import { legalCards, playIsLegal, applyPlay, advanceTrick } from "./app/js/core/engine/play.js";

// ============================================================
//  AI
// ============================================================
function aiBidEstimate(G, p) {
  const h = G.hands[p];
  const bySuit = {}; SUITS.forEach(s => bySuit[s] = 0); h.forEach(c => bySuit[c.suit]++);
  let best = SUITS[0]; SUITS.forEach(s => { if (bySuit[s] > bySuit[best]) best = s; });
  const trumpLen = bySuit[best];
  let pts = 0;
  for (const c of h) {
    const cp = cardPoints(G, c);
    if (cp === 30) { pts += 22; continue; }
    if (c.suit === best) { if (c.rank >= 13) pts += cp + 12; else if (c.rank >= 11) pts += cp + 6; else pts += cp * 0.5 + 3; }
    else { if (c.rank === 14) pts += cp + 8; else if (c.rank === 13) pts += cp * 0.6 + 2; else pts += cp * 0.3; }
  }
  if (trumpLen >= 5) pts += (trumpLen - 4) * 12;
  pts += 60;
  return { suit: best, points: pts };
}
function aiBidDecision(G, p, easy) {
  const est = aiBidEstimate(G, p);
  const noisy = est.points + (easy ? -18 : 0) + (Math.random() * 16 - 8);
  const target = Math.round(noisy / BID_STEP) * BID_STEP;
  const need = minNextBid(G);
  return (need <= MAX_BID && target >= need) ? need : null;
}
function aiPickTrump(G, p) {
  const h = G.hands[p];
  const bySuit = {}; SUITS.forEach(s => bySuit[s] = { len: 0, pts: 0 });
  h.forEach(c => { bySuit[c.suit].len++; bySuit[c.suit].pts += c.rank; });
  let best = SUITS[0];
  for (const s of SUITS) { const a = bySuit[s], b = bySuit[best]; if (a.len > b.len || (a.len === b.len && a.pts > b.pts)) best = s; }
  return best;
}
function aiPickPartner(G, p) {
  const have = new Set(G.hands[p].map(c => c.suit + c.rank));
  const trump = G.trump;
  const bySuit = {}; SUITS.forEach(s => bySuit[s] = 0); G.hands[p].forEach(c => bySuit[c.suit]++);
  if (!have.has(trump + 14)) return { suit: trump, rank: 14 };
  const sideSuits = SUITS.filter(s => s !== trump).sort((a, b) => bySuit[b] - bySuit[a]);
  for (const s of sideSuits) if (!have.has(s + 14)) return { suit: s, rank: 14 };
  if (!have.has(trump + 13)) return { suit: trump, rank: 13 };
  for (const s of sideSuits) if (!have.has(s + 13)) return { suit: s, rank: 13 };
  return callableCards(G, p)[0];
}
function chooseAICard(G, p, easy) {
  const legal = legalCards(G, p);
  if (legal.length === 1) return legal[0];
  const trump = G.trump, lead = G.leadSuit;
  const pts = c => cardPoints(G, c);
  const keepValue = c => c.rank + (c.suit === trump ? 50 : 0);
  const lowestBy = (cs, f) => cs.reduce((m, c) => (f(c) < f(m) ? c : m), cs[0]);
  const highestBy = (cs, f) => cs.reduce((m, c) => (f(c) > f(m) ? c : m), cs[0]);
  const dumpLow = () => lowestBy(legal, c => pts(c) * 1000 + (c.suit === trump ? 1000 : 0) + c.rank);

  if (G.trick.length === 0) {
    if (easy) return legal[Math.floor(Math.random() * legal.length)];
    const myTrumps = legal.filter(c => c.suit === trump);
    if (sideOf(G, p) === "D" && myTrumps.length >= 4) return highestBy(myTrumps, c => c.rank);
    const nonTrump = legal.filter(c => c.suit !== trump);
    const aces = nonTrump.filter(c => c.rank === 14);
    if (aces.length) return highestBy(aces, c => c.rank);
    const safeNon = nonTrump.filter(c => pts(c) === 0);
    if (safeNon.length) return lowestBy(safeNon, c => c.rank);
    const lowTrumps = legal.filter(c => c.suit === trump && pts(c) === 0);
    if (lowTrumps.length) return lowestBy(lowTrumps, c => c.rank);
    return lowestBy(legal, c => pts(c) * 100 + c.rank);
  }

  const wIdx = winningIndex(G.trick, lead, trump);
  const winnerPlayer = G.trick[wIdx].player;
  const bestCard = G.trick[wIdx].card;
  const allyWinning = winnerPlayer !== p && sideOf(G, winnerPlayer) === sideOf(G, p);
  const winners = legal.filter(c => beats(c, bestCard, lead, trump));
  const isLast = G.trick.length === NUM_PLAYERS - 1;
  const tp = trickPoints(G, G.trick);

  if (easy) {
    const sameSuitWins = winners.filter(c => c.suit === lead);
    if (!allyWinning && sameSuitWins.length) return lowestBy(sameSuitWins, c => c.rank);
    const pool = allyWinning ? legal.filter(c => !beats(c, bestCard, lead, trump)) : legal;
    const pick = pool.length ? pool : legal;
    return pick[Math.floor(Math.random() * pick.length)];
  }

  if (allyWinning) {
    if (!isLast && bestCard.suit !== trump) {
      const myTrumps = legal.filter(c => c.suit === trump);
      if (myTrumps.length) return lowestBy(myTrumps, c => c.rank);
    }
    if (isLast) {
      const isBonus = c => c.rank === 3 && c.suit === G.bonusSuit;
      const bankable = legal.filter(c => pts(c) > 0 && c.rank !== 14 && (c.suit !== trump || isBonus(c)));
      if (bankable.length) return highestBy(bankable, pts);
    }
    return lowestBy(legal, keepValue);
  }
  if (winners.length) {
    const leadWins = winners.filter(c => c.suit === lead);
    const pool = leadWins.length ? leadWins : winners;
    if (!leadWins.length && pool.every(c => c.suit === trump) && tp < 10 && !isLast) return dumpLow();
    return lowestBy(pool, c => c.rank);
  }
  return dumpLow();
}

// ============================================================
//  Driver helpers (server queries)
// ============================================================
/* Who must act now and what kind of action; null if the phase is a
   timed transition (trickEnd/roundEnd/matchOver/lobby). */
function requiredActor(G) {
  switch (G.phase) {
    case "bidding": { const s = findBidActor(G); return s === null ? null : { seat: s, kind: "bid" }; }
    case "trumpSelect": return { seat: G.declarer, kind: "trump" };
    case "partnerSelect": return { seat: G.declarer, kind: "call" };
    case "playing": return G.trick.length < NUM_PLAYERS ? { seat: G.turn, kind: "play" } : null;
    default: return null;
  }
}
/* The action an AI would take for the seat that currently must act.
   difficulty: "easy" | "normal" | "hard" (legacy boolean easy also accepted). */
function aiActionFor(G, seat, difficulty) {
  const easy = difficulty === true || difficulty === "easy";
  const hard = difficulty === "hard";
  const ra = requiredActor(G);
  if (!ra || ra.seat !== seat) return null;
  if (ra.kind === "bid") return { type: "bid", value: aiBidDecision(G, seat, easy) };
  if (ra.kind === "trump") return { type: "trump", suit: aiPickTrump(G, seat) };
  if (ra.kind === "call") return { type: "call", card: aiPickPartner(G, seat) };
  if (ra.kind === "play") return { type: "play", card: hard ? choosePIMCCard(G, seat) : chooseAICard(G, seat, easy) };
  return null;
}
// ============================================================
//  Hard AI — PIMC (Perfect Information Monte Carlo)
//  Sample determinizations of the unseen cards consistent with the
//  public facts (played cards, revealed voids, the called card's
//  holder), roll every legal move out with the heuristic AI, and
//  pick the move with the best mean outcome for our side.
// ============================================================
const cardKey = c => c.suit + c.rank;

/* Deal the unseen cards to the other three seats, honoring hand counts,
   observed voids, and the called card's known holder. Falls back to
   ignoring voids if constrained sampling keeps failing (rare). */
function determinize(G, me) {
  const seen = new Set(G.hands[me].map(cardKey));
  for (const c of (G.playedCards || [])) seen.add(cardKey(c));
  const unseen = buildDeck().filter(c => !seen.has(cardKey(c)));
  const others = [0, 1, 2, 3].filter(p => p !== me);
  const voids = G.voids || [{}, {}, {}, {}];

  let forcedTo = null;
  if (G.calledCard && G.partner != null && G.partner !== me &&
      unseen.some(c => sameCard(c, G.calledCard))) forcedTo = G.partner;

  for (let attempt = 0; attempt < 24; attempt++) {
    const useVoids = attempt < 20;
    const allowedCount = (c) => others.reduce((n, p) => n + (useVoids && voids[p][c.suit] ? 0 : 1), 0);
    const need = {}; others.forEach(p => { need[p] = G.hands[p].length; });
    const out = {}; others.forEach(p => { out[p] = []; });
    const pool = shuffleFast(unseen.slice()); // AI-internal sampling: no need for the CSPRNG
    let ok = true;
    if (forcedTo != null && need[forcedTo] > 0) {
      const i = pool.findIndex(c => sameCard(c, G.calledCard));
      out[forcedTo].push(pool.splice(i, 1)[0]); need[forcedTo]--;
    }
    pool.sort((a, b) => allowedCount(a) - allowedCount(b)); // most-constrained cards first
    for (const c of pool) {
      const cand = others.filter(p => need[p] > 0 && !(useVoids && voids[p][c.suit]));
      if (!cand.length) { ok = false; break; }
      const p = cand[Math.floor(Math.random() * cand.length)];
      out[p].push(c); need[p]--;
    }
    if (ok && others.every(p => need[p] === 0)) return out;
  }
  return null; // pathological; caller falls back to the heuristic
}

function rolloutClone(G) {
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
function playOutRound(sim) {
  for (let guard = 0; guard < 300; guard++) {
    if (sim.phase === "trickEnd") { advanceTrick(sim); continue; }
    if (sim.phase !== "playing") return;
    applyPlay(sim, sim.turn, chooseAICard(sim, sim.turn, false));
  }
}

/* Work budget in *simulated card plays*, not milliseconds. Cloudflare freezes
   Date.now() between I/O operations, so a wall-clock cutoff never trips inside a
   Durable Object and the search would always run its full width — the widest
   position (13 legal moves, 52 cards live) is also the most expensive one. This
   bound is deterministic, so node and Workers spend the same effort, and it
   spends it where PIMC actually pays: the endgame. */
const PIMC_PLAY_BUDGET = 8000;

function choosePIMCCard(G, me, opts) {
  const legal = legalCards(G, me);
  if (legal.length <= 1) return legal[0];
  const timeMs = (opts && opts.timeMs) || 25;
  const budget = (opts && opts.playBudget) || PIMC_PLAY_BUDGET;
  const cardsLeft = G.hands.reduce((n, h) => n + h.length, 0) || 1;
  const affordable = Math.max(1, Math.floor(budget / (legal.length * cardsLeft)));
  const maxDet = Math.min((opts && opts.determinizations) || 24, affordable);
  const started = Date.now();
  const iAmDeclaring = sideOf(G, me) === "D";
  const totals = legal.map(() => 0), counts = legal.map(() => 0);

  for (let d = 0; d < maxDet; d++) {
    if (d >= 4 && Date.now() - started > timeMs) break; // secondary guard; a no-op on Workers
    const world = determinize(G, me);
    if (!world) return chooseAICard(G, me, false);
    for (let i = 0; i < legal.length; i++) {
      const sim = rolloutClone(G);
      for (const p of [0, 1, 2, 3]) if (p !== me) sim.hands[p] = world[p].slice();
      applyPlay(sim, me, legal[i]);
      playOutRound(sim);
      const dPts = sim.capturedPoints[sim.declarer] + sim.capturedPoints[sim.partner];
      const made = dPts >= sim.bid;
      const win = (iAmDeclaring === made) ? 1 : 0;
      const margin = iAmDeclaring ? dPts : TOTAL_POINTS - dPts;
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

export {
  SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP, TOTAL_POINTS, TARGET_GAMES, MAX_REDEALS,
  createMatch, startMatch, nextDeal,
  applyBid, bidIsLegal, minNextBid, findBidActor,
  applyTrump, applyCall, callIsLegal, callableCards,
  applyPlay, playIsLegal, advanceTrick, legalCards,
  aiActionFor, requiredActor, publicView,
  cardPoints, sameCard, sideOf, defenders, cardStr, rankLabel,
  choosePIMCCard, randomInt, determinize as _determinize,
};
