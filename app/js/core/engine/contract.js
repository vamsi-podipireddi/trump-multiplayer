import { SUITS, RANKS } from "./constants.js";
import { sameCard, cardStr, sortHand } from "./cards.js";
import { logG, name } from "./log.js";
import { defenders } from "./scoring.js";

// ============================================================
//  Trump + partner
// ============================================================
function applyTrump(G, suit) {
  G.trump = suit; G.hands.forEach(h => sortHand(h, suit));
  logG(G, `${name(G, G.declarer)} names ${suit} as trump.`);
  G.phase = "partnerSelect";
}
function callableCards(G, p) {
  const have = new Set(G.hands[p].map(c => c.suit + c.rank));
  const out = [];
  for (const s of SUITS) for (let r = 14; r >= 2; r--) if (!have.has(s + r)) out.push({ suit: s, rank: r });
  return out;
}
function callIsLegal(G, card) {
  if (G.phase !== "partnerSelect" || !card || !SUITS.includes(card.suit) || !RANKS.includes(card.rank)) return false;
  return !G.hands[G.declarer].some(c => sameCard(c, card)); // must be a card the declarer doesn't hold
}
function applyCall(G, card) {
  G.calledCard = card;
  G.partner = [0,1,2,3].find(pl => G.hands[pl].some(c => sameCard(c, card)));
  if (G.partner === undefined) G.partner = G.declarer; // unreachable safety
  G.teamsRevealed = true;
  logG(G, `${name(G, G.declarer)} calls ${cardStr(card)} — partner is ${name(G, G.partner)}.`);
  logG(G, `Teams: ${name(G, G.declarer)} & ${name(G, G.partner)} (need ${G.bid} pts) vs ${defenders(G).map(p => name(G, p)).join(" & ")}.`, "round");
  beginPlay(G);
}
function beginPlay(G) {
  G.phase = "playing"; G.leader = G.declarer; G.turn = G.declarer;
  G.trick = []; G.leadSuit = null; G.trickNumber = 0;
  logG(G, `Play begins — ${name(G, G.leader)} (bid winner) leads.`);
}

export { applyTrump, callableCards, callIsLegal, applyCall, beginPlay };
