import { SUITS, RANKS } from "./constants.js";

// ---- card helpers ----
function buildDeck() { const d = []; for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r }); return d; }
function sameCard(a, b) { return !!a && !!b && a.suit === b.suit && a.rank === b.rank; }
function rankLabel(r) { return ({14:"A",13:"K",12:"Q",11:"J"})[r] || String(r); }
function cardStr(c) { return rankLabel(c.rank) + c.suit; }
function sortHand(hand, trump) {
  const order = SUITS.filter(s => s !== trump).concat(trump ? [trump] : []);
  hand.sort((a, b) => { const sa = order.indexOf(a.suit), sb = order.indexOf(b.suit); return sa !== sb ? sa - sb : b.rank - a.rank; });
}
function beats(a, b, lead, trump) {
  const aT = a.suit === trump, bT = b.suit === trump;
  if (aT !== bT) return aT;
  if (aT && bT) return a.rank > b.rank;
  const aL = a.suit === lead, bL = b.suit === lead;
  if (aL !== bL) return aL;
  if (aL && bL) return a.rank > b.rank;
  return false;
}
function winningIndex(trick, lead, trump) { let best = 0; for (let i = 1; i < trick.length; i++) if (beats(trick[i].card, trick[best].card, lead, trump)) best = i; return best; }

export { buildDeck, sameCard, rankLabel, cardStr, sortHand, beats, winningIndex };
