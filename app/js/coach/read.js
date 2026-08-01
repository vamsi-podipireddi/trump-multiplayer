/* The table read — points still live, what your side needs, the bonus
   three's status, known voids, and how many cards of each suit remain
   unaccounted for. Pure derivation from public state, no search: every
   number here is something every seat at the table already watched
   happen, which is also why this is never gated behind the coach setting. */
import { SUITS, RANKS, TOTAL_POINTS } from "../core/engine/index.js";
import { shadowFromView } from "./shadow.js";

/* A room restored from storage predating this setting has no `coach` key, and a
   missing agreement is not a ban: absent reads as on. One predicate, so the lobby,
   the table and the hint affordance can never disagree about what a table agreed to. */
function coachOn(settings) { return !settings || settings.coach !== false; }

/* The 30 goes to whoever captured the trick the 3 fell in. The wire carries no
   "bonus taken by", so the trick history is where that is written down.
   Answers only once that trick has resolved: a bonus that has fallen but
   whose trick is still in progress is a real, honest "nobody yet" — not
   something to paper over with a guess at who is currently ahead in it. */
function bonusTakenBy(v) {
  for (const t of v.tricks) {
    if (t.cards.some(p => p.card.rank === 3 && p.card.suit === v.bonusSuit)) return t.winner;
  }
  return null;
}

function tableRead(v) {
  /* shadowFromView is the one derivation of "what has been played" (and of
     voids) — null only pre-deal or for a spectator, where nothing has fallen. */
  const shadow = shadowFromView(v);
  const playedCards = shadow ? shadow.playedCards : [];
  const voidsBySeat = shadow ? shadow.voids : [{}, {}, {}, {}];
  const hand = v.you && Array.isArray(v.you.hand) ? v.you.hand : [];
  const mySeat = v.you ? v.you.seat : null;

  const pointsLive = TOTAL_POINTS - v.capturedPoints.reduce((a, b) => a + b, 0);

  // before the reveal, "my side" would be a guess — hide the split rather than invent one
  let captured = { mine: 0, theirs: 0 };
  let needed = null;
  if (v.teamsRevealed && v.declarer != null && v.partner != null) {
    const decl = new Set([v.declarer, v.partner]);  // a Set, not a sum: partner === declarer is one seat, not two
    const declPts = [...decl].reduce((s, p) => s + v.capturedPoints[p], 0);
    const restPts = [0, 1, 2, 3].filter(p => !decl.has(p)).reduce((s, p) => s + v.capturedPoints[p], 0);
    captured = decl.has(mySeat) ? { mine: declPts, theirs: restPts } : { mine: restPts, theirs: declPts };
    if (v.bid != null) needed = Math.max(0, v.bid - declPts);
  }

  const fallen = playedCards.some(c => c.rank === 3 && c.suit === v.bonusSuit);
  const bonus = { suit: v.bonusSuit, fallen, takenBy: bonusTakenBy(v) };

  // reshaped from the shadow's per-seat suit->bool map; your own seat isn't a "known void", it's just your hand
  const voids = [0, 1, 2, 3]
    .filter(s => s !== mySeat)
    .map(s => ({ seat: s, suits: SUITS.filter(suit => voidsBySeat[s][suit]) }));

  const outstanding = {};
  for (const s of SUITS) {
    const accounted = new Set();
    for (const c of hand) if (c.suit === s) accounted.add(c.rank);
    for (const c of playedCards) if (c.suit === s) accounted.add(c.rank);
    const remaining = RANKS.filter(r => !accounted.has(r));  // RANKS is ascending, so the last entry is the top
    outstanding[s] = { count: remaining.length, top: remaining.length ? remaining[remaining.length - 1] : null };
  }
  const trumpLeft = v.trump ? outstanding[v.trump].count : null;

  return { pointsLive, captured, needed, bonus, voids, outstanding, trumpLeft };
}

export { coachOn, bonusTakenBy, tableRead };
