import { SUITS, NUM_PLAYERS, MAX_BID, BID_STEP } from "../constants.js";
import { beats, winningIndex } from "../cards.js";
import { cardPoints, sideOf, trickPoints } from "../scoring.js";
import { legalCards } from "../play.js";
import { callableCards } from "../contract.js";
import { minNextBid } from "../bidding.js";

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
function aiBidDecision(G, p, easy, rnd = Math.random) {
  const est = aiBidEstimate(G, p);
  const noisy = est.points + (easy ? -18 : 0) + (rnd() * 16 - 8);
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
function chooseAICard(G, p, easy, rnd = Math.random) {
  const legal = legalCards(G, p);
  if (legal.length === 1) return legal[0];
  const trump = G.trump, lead = G.leadSuit;
  const pts = c => cardPoints(G, c);
  const keepValue = c => c.rank + (c.suit === trump ? 50 : 0);
  const lowestBy = (cs, f) => cs.reduce((m, c) => (f(c) < f(m) ? c : m), cs[0]);
  const highestBy = (cs, f) => cs.reduce((m, c) => (f(c) > f(m) ? c : m), cs[0]);
  const dumpLow = () => lowestBy(legal, c => pts(c) * 1000 + (c.suit === trump ? 1000 : 0) + c.rank);

  if (G.trick.length === 0) {
    if (easy) return legal[Math.floor(rnd() * legal.length)];
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
    return pick[Math.floor(rnd() * pick.length)];
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

export { aiBidEstimate, aiBidDecision, aiPickTrump, aiPickPartner, chooseAICard };
