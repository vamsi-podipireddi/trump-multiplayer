import { SUITS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP, TOTAL_POINTS, TARGET_GAMES } from "./constants.js";
import { randomInt, shuffle } from "./random.js";
import { buildDeck, cardStr, sortHand } from "./cards.js";
import { logG, name } from "./log.js";
import { defenders } from "./scoring.js";

// ============================================================
//  Lifecycle
// ============================================================
function createMatch(names, opts) {
  return {
    targetGames: opts && [3, 5, 7].includes(opts.targetDeals) ? opts.targetDeals : TARGET_GAMES,
    phase: "lobby", dealer: 0, roundNumber: 0, scores: [0,0,0,0],
    names: names ? names.slice() : ["South","West","North","East"],
    hands: [[],[],[],[]],
    bidActive: [], bidTurn: 0, highBid: null, highBidder: null, bids: [null,null,null,null], redealCount: 0,
    declarer: null, bid: null, trump: null, calledCard: null, partner: null,
    teamsRevealed: false, bonusSuit: null,
    trick: [], leadSuit: null, turn: 0, leader: 0, trickNumber: 0,
    tricksWon: [0,0,0,0], capturedPoints: [0,0,0,0], lastWinner: -1, lastWinnerSlot: -1,
    lastResult: null, log: [], playedCards: [], voids: [{}, {}, {}, {}],
  };
}
function startMatch(G) {
  G.scores = [0,0,0,0]; G.dealer = randomInt(NUM_PLAYERS);
  G.roundNumber = 0; G.redealCount = 0; G.log = []; G.lastResult = null;
  nextDeal(G);
}
function nextDeal(G) {
  G.dealer = G.roundNumber === 0 ? G.dealer : (G.dealer + 1) % NUM_PLAYERS;
  G.roundNumber++; G.redealCount = 0;
  deal(G);
}
function deal(G) {
  const deck = shuffle(buildDeck());
  G.hands = [[],[],[],[]];
  for (let i = 0; i < 52; i++) G.hands[(G.dealer + 1 + i) % NUM_PLAYERS].push(deck[i]);
  G.trump = null; G.calledCard = null; G.partner = null; G.declarer = null;
  G.bid = null; G.teamsRevealed = false; G.lastResult = null;
  G.bonusSuit = SUITS[randomInt(SUITS.length)];
  G.trick = []; G.leadSuit = null; G.trickNumber = 0; G.tricksWon = [0,0,0,0]; G.capturedPoints = [0,0,0,0];
  G.lastWinner = -1; G.lastWinnerSlot = -1;
  G.playedCards = []; G.voids = [{}, {}, {}, {}]; // public inference facts (for the PIMC AI)
  G.hands.forEach(h => sortHand(h, null));
  G.bidActive = [0,1,2,3]; G.highBid = null; G.highBidder = null; G.bids = [null,null,null,null];
  G.bidTurn = (G.dealer + 1) % NUM_PLAYERS; G.phase = "bidding";
  logG(G, `Round ${G.roundNumber} · ${name(G, G.dealer)} deals · bonus card ${cardStr({ suit: G.bonusSuit, rank: 3 })} = 30 pts`, "round");
  logG(G, `Bidding starts with ${name(G, G.bidTurn)} — bid the points (of ${TOTAL_POINTS}) your side will capture.`);
}
function endRound(G) {
  G.teamsRevealed = true;
  const dPts = G.capturedPoints[G.declarer] + G.capturedPoints[G.partner];
  const made = dPts >= G.bid;
  const winners = made ? [G.declarer, G.partner] : defenders(G);
  winners.forEach(p => G.scores[p]++);
  if (!G._silent) logG(G, `${name(G, G.declarer)} & ${name(G, G.partner)} captured ${dPts}/${G.bid} pts → ${made ? "CONTRACT MADE" : "SET"}. ${winners.map(p => name(G, p)).join(" & ")} win the deal.`, "round");
  G.lastResult = { made, dPts, bid: G.bid, winners: winners.slice(), declarer: G.declarer, partner: G.partner };
  G.phase = G.scores.some(s => s >= (G.targetGames || TARGET_GAMES)) ? "matchOver" : "roundEnd";
}
/* Public, hand-free snapshot safe to send to anyone. */
function publicView(G) {
  return {
    phase: G.phase, dealer: G.dealer, roundNumber: G.roundNumber, scores: G.scores.slice(),
    capturedPoints: G.capturedPoints.slice(), tricksWon: G.tricksWon.slice(),
    bonusSuit: G.bonusSuit, trump: G.trump, declarer: G.declarer,
    partner: G.teamsRevealed ? G.partner : null, teamsRevealed: G.teamsRevealed, bid: G.bid,
    highBid: G.highBid, highBidder: G.highBidder, bids: G.bids.slice(), bidActive: G.bidActive.slice(), bidTurn: G.bidTurn,
    leader: G.leader, turn: G.turn, leadSuit: G.leadSuit,
    trick: G.trick.map(t => ({ player: t.player, card: t.card })),
    lastWinner: G.lastWinner, lastWinnerSlot: G.lastWinnerSlot,
    handCounts: G.hands.map(h => h.length), names: G.names.slice(),
    log: G.log.slice(-40), lastResult: G.lastResult || null,
    consts: { MIN_BID, MAX_BID, BID_STEP, TOTAL_POINTS, TARGET_GAMES: G.targetGames || TARGET_GAMES, NUM_PLAYERS },
  };
}

export { createMatch, startMatch, nextDeal, deal, endRound, publicView };
