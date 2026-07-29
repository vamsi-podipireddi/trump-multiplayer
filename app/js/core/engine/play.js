import { NUM_PLAYERS } from "./constants.js";
import { sameCard, cardStr, winningIndex } from "./cards.js";
import { trickPoints } from "./scoring.js";
import { logG, name } from "./log.js";
import { endRound } from "./match.js";

function legalCards(G, p) {
  const hand = G.hands[p];
  if (G.trick.length === 0) return hand.slice();
  const hasLead = hand.some(c => c.suit === G.leadSuit);
  return hasLead ? hand.filter(c => c.suit === G.leadSuit) : hand.slice();
}
// ============================================================
//  Play
// ============================================================
function playIsLegal(G, p, card) {
  if (G.phase !== "playing" || G.turn !== p || G.trick.length >= NUM_PLAYERS) return false;
  return legalCards(G, p).some(c => sameCard(c, card));
}
function applyPlay(G, p, card) {
  const hand = G.hands[p];
  const idx = hand.findIndex(c => sameCard(c, card));
  if (idx === -1) return;
  hand.splice(idx, 1);
  if (G.trick.length > 0 && card.suit !== G.leadSuit && G.voids) G.voids[p][G.leadSuit] = true; // public: p is out of the led suit
  if (G.playedCards) G.playedCards.push(card);
  if (G.trick.length === 0) G.leadSuit = card.suit;
  G.trick.push({ player: p, card });
  G.turn = (p + 1) % NUM_PLAYERS;
  if (!G._silent) logG(G, `${name(G, p)} plays ${cardStr(card)}${sameCard(card, G.calledCard) ? " (the called card!)" : ""}`);
  if (G.trick.length === NUM_PLAYERS) resolveTrick(G);
}
function resolveTrick(G) {
  const wIdx = winningIndex(G.trick, G.leadSuit, G.trump);
  const winner = G.trick[wIdx].player;
  const tp = trickPoints(G, G.trick);
  G.tricksWon[winner]++; G.capturedPoints[winner] += tp;
  G.lastWinnerSlot = wIdx; G.lastWinner = winner;
  if (!G._silent) {
    /* The rails and the deal review still show this trick after advanceTrick()
       has emptied G.trick, so keep a copy — copied, not aliased, because the
       AI's rollouts reuse the very card objects G.trick holds. Recorded only
       when the log is, for the same reason: a PIMC search resolves thousands of
       tricks nobody will ever read, and its clone of G carries no history. */
    if (!G.tricks) G.tricks = [];      // a room restored from storage predating this field
    G.tricks.push({
      no: G.tricks.length + 1, winner, pts: tp,
      cards: G.trick.map(t => ({ player: t.player, card: { suit: t.card.suit, rank: t.card.rank } })),
      winCard: { suit: G.trick[wIdx].card.suit, rank: G.trick[wIdx].card.rank },
    });
    logG(G, `★ ${name(G, winner)} wins the trick (${cardStr(G.trick[wIdx].card)})${tp ? " +" + tp + " pts" : ""}`, "win");
  }
  G.phase = "trickEnd";
}
function advanceTrick(G) {
  const winner = G.lastWinner;
  G.trick = []; G.leadSuit = null; G.lastWinnerSlot = -1;
  G.trickNumber++; G.leader = winner; G.turn = winner;
  if (G.hands.every(h => h.length === 0)) endRound(G);
  else G.phase = "playing";
}

export { legalCards, playIsLegal, applyPlay, advanceTrick };
