import { SUITS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP, TOTAL_POINTS, TARGET_GAMES } from "./constants.js";
import { randomInt, shuffle } from "./random.js";
import { buildDeck, cardStr, sortHand } from "./cards.js";
import { logG, name } from "./log.js";
import { defenders } from "./scoring.js";

// ============================================================
//  Lifecycle
// ============================================================
/* 8 hex chars off the same CSPRNG the deal uses. There is nothing here to
   protect — a match id is public — but there is also no reason to introduce a
   second source of randomness for it. */
function mintMatchId() {
  let s = "";
  for (let i = 0; i < 8; i++) s += randomInt(16).toString(16);
  return s;
}
function createMatch(names, opts) {
  return {
    targetGames: opts && [3, 5, 7].includes(opts.targetDeals) ? opts.targetDeals : TARGET_GAMES,
    phase: "lobby", dealer: 0, roundNumber: 0, scores: [0,0,0,0],
    matchId: mintMatchId(), dealHistory: [], auction: [],
    names: names ? names.slice() : ["South","West","North","East"],
    hands: [[],[],[],[]],
    bidActive: [], bidTurn: 0, highBid: null, highBidder: null, bids: [null,null,null,null], redealCount: 0,
    declarer: null, bid: null, trump: null, calledCard: null, partner: null,
    teamsRevealed: false, bonusSuit: null,
    trick: [], leadSuit: null, turn: 0, leader: 0, trickNumber: 0, tricks: [],
    tricksWon: [0,0,0,0], capturedPoints: [0,0,0,0], lastWinner: -1, lastWinnerSlot: -1,
    lastResult: null, log: [], playedCards: [], voids: [{}, {}, {}, {}],
  };
}
function startMatch(G) {
  G.scores = [0,0,0,0]; G.dealer = randomInt(NUM_PLAYERS);
  G.matchId = mintMatchId(); G.dealHistory = [];
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
  G.trick = []; G.leadSuit = null; G.trickNumber = 0; G.tricks = []; G.tricksWon = [0,0,0,0]; G.capturedPoints = [0,0,0,0];
  G.lastWinner = -1; G.lastWinnerSlot = -1;
  G.playedCards = []; G.voids = [{}, {}, {}, {}]; // public inference facts (for the PIMC AI)
  G.auction = [];   // a redealt auction correctly vanishes with the hand it was bid on
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
  /* Guarded exactly as resolveTrick's own history push is: a PIMC search runs
     endRound thousands of times on rollout clones, and none of those deals is
     one anybody will read. */
  if (!G._silent) {
    if (!G.dealHistory) G.dealHistory = [];   // a room restored from storage predating this field
    G.dealHistory.push({
      roundNumber: G.roundNumber, declarer: G.declarer, partner: G.partner,
      bid: G.bid, made, dPts, winners: winners.slice(),
    });
  }
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
    // the called card names the partner, so it is a secret until the reveal
    calledCard: G.teamsRevealed ? G.calledCard : null,
    highBid: G.highBid, highBidder: G.highBidder, bids: G.bids.slice(), bidActive: G.bidActive.slice(), bidTurn: G.bidTurn,
    leader: G.leader, turn: G.turn, leadSuit: G.leadSuit,
    trick: G.trick.map(t => ({ player: t.player, card: t.card })),
    /* Every seat watched these cards fall, so replaying them redacts nothing —
       and nobody can rebuild them from G.trick, which advanceTrick() empties.
       Copied out rather than aliased so a viewer can never reach into G, and
       `|| []` covers a room restored from storage written before this field. */
    tricks: (G.tricks || []).map(t => ({
      no: t.no, winner: t.winner, pts: t.pts,
      cards: t.cards.map(c => ({ player: c.player, card: { suit: c.card.suit, rank: c.card.rank } })),
      winCard: { suit: t.winCard.suit, rank: t.winCard.rank },
    })),
    matchId: G.matchId || null,
    /* Copied, not aliased, for the same reason tricks is: a viewer must never
       hold a reference into G. `|| []` covers a room restored from storage
       written before these fields existed. */
    auction: (G.auction || []).map(a => a.forced
      ? { seat: a.seat, value: a.value, forced: true }
      : { seat: a.seat, value: a.value }),
    /* Published whole, not as a count, even though the report card's coverage
       line reads only its length: this IS D38's cheap public half — which side
       won each deal, at what contract, made or set — and the reason it rides
       the view at all is that it survives what the graded half cannot (a
       refresh, a reconnect, a phone takeover, spectating, a browser that
       cannot store snapshots). ui/coach.js's renderMatchRecord prints it in
       exactly that case. Trimming it to a number would save a few hundred
       bytes and delete the only half of the card that always works. */
    dealHistory: (G.dealHistory || []).map(d => ({
      roundNumber: d.roundNumber, declarer: d.declarer, partner: d.partner,
      bid: d.bid, made: d.made, dPts: d.dPts, winners: d.winners.slice(),
    })),
    lastWinner: G.lastWinner, lastWinnerSlot: G.lastWinnerSlot,
    handCounts: G.hands.map(h => h.length), names: G.names.slice(),
    log: G.log.slice(-40), lastResult: G.lastResult || null,
    consts: { MIN_BID, MAX_BID, BID_STEP, TOTAL_POINTS, TARGET_GAMES: G.targetGames || TARGET_GAMES, NUM_PLAYERS },
  };
}

export { createMatch, startMatch, nextDeal, deal, endRound, publicView };
