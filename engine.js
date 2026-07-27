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
import { randomInt, shuffle, shuffleFast } from "./app/js/core/engine/random.js";
import { buildDeck, sameCard, rankLabel, cardStr, sortHand, beats, winningIndex } from "./app/js/core/engine/cards.js";
import { logG, name } from "./app/js/core/engine/log.js";
import { cardPoints, trickPoints, sideOf, defenders } from "./app/js/core/engine/scoring.js";

function legalCards(G, p) {
  const hand = G.hands[p];
  if (G.trick.length === 0) return hand.slice();
  const hasLead = hand.some(c => c.suit === G.leadSuit);
  return hasLead ? hand.filter(c => c.suit === G.leadSuit) : hand.slice();
}

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
function redeal(G) {
  G.redealCount++;
  if (G.redealCount > MAX_REDEALS) { forceBid(G); return; }
  logG(G, `Everyone passed — redealing (${G.redealCount}).`, "bid");
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

// ============================================================
//  Auction
// ============================================================
function findBidActor(G) {
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const p = (G.bidTurn + i) % NUM_PLAYERS;
    if (G.bidActive.includes(p) && p !== G.highBidder) return p;
  }
  return null;
}
function minNextBid(G) { return G.highBid === null ? MIN_BID : G.highBid + BID_STEP; }
function bidIsLegal(G, p, value) {
  if (G.phase !== "bidding" || findBidActor(G) !== p) return false;
  if (value === null) return true;
  return Number.isInteger(value) && value >= minNextBid(G) && value <= MAX_BID && (value - MIN_BID) % BID_STEP === 0;
}
function applyBid(G, p, value) {
  if (value === null) { G.bidActive = G.bidActive.filter(x => x !== p); logG(G, `${name(G, p)} passes`, "bid"); }
  /* A pass deliberately does not write to `bids` — leaving `bidActive` is what marks
     a seat as folded. That keeps bids[p] number-or-null, so the table can tell
     "passed" from "hasn't acted yet" without a sentinel value. */
  else { G.highBid = value; G.highBidder = p; G.bids[p] = value; logG(G, `${name(G, p)} bids ${value}`, "bid"); }
  G.bidTurn = (p + 1) % NUM_PLAYERS;
  advanceBidding(G);
}
function advanceBidding(G) {
  if (G.bidActive.length === 0) { redeal(G); return; }
  const actor = findBidActor(G);
  if (actor === null) { finalizeDeclarer(G); return; }
  G.bidTurn = actor;
}
function forceBid(G) {
  const eldest = (G.dealer + 1) % NUM_PLAYERS;
  G.highBidder = eldest; G.highBid = MIN_BID;
  logG(G, `${name(G, eldest)} is forced to take the minimum bid of ${MIN_BID}.`, "bid");
  finalizeDeclarer(G);
}
function finalizeDeclarer(G) {
  G.declarer = G.highBidder; G.bid = G.highBid; G.redealCount = 0;
  logG(G, `★ ${name(G, G.declarer)} wins the bid at ${G.bid} — choosing trump…`, "bid");
  G.phase = "trumpSelect";
}

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
  if (!G._silent) logG(G, `★ ${name(G, winner)} wins the trick (${cardStr(G.trick[wIdx].card)})${tp ? " +" + tp + " pts" : ""}`, "win");
  G.phase = "trickEnd";
}
function advanceTrick(G) {
  const winner = G.lastWinner;
  G.trick = []; G.leadSuit = null; G.lastWinnerSlot = -1;
  G.trickNumber++; G.leader = winner; G.turn = winner;
  if (G.hands.every(h => h.length === 0)) endRound(G);
  else G.phase = "playing";
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
