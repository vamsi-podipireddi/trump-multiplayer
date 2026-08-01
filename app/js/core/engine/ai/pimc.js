import { TOTAL_POINTS } from "../constants.js";
import { sameCard, buildDeck } from "../cards.js";
import { shuffleFast } from "../random.js";
import { sideOf } from "../scoring.js";
import { legalCards, applyPlay, advanceTrick } from "../play.js";
import { chooseAICard } from "./heuristic.js";

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
function determinize(G, me, rnd = Math.random) {
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
    const pool = shuffleFast(unseen.slice(), rnd); // AI-internal sampling: no need for the CSPRNG
    let ok = true;
    if (forcedTo != null && need[forcedTo] > 0) {
      const i = pool.findIndex(c => sameCard(c, G.calledCard));
      out[forcedTo].push(pool.splice(i, 1)[0]); need[forcedTo]--;
    }
    pool.sort((a, b) => allowedCount(a) - allowedCount(b)); // most-constrained cards first
    for (const c of pool) {
      const cand = others.filter(p => need[p] > 0 && !(useVoids && voids[p][c.suit]));
      if (!cand.length) { ok = false; break; }
      const p = cand[Math.floor(rnd() * cand.length)];
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
function playOutRound(sim, rnd = Math.random) {
  for (let guard = 0; guard < 300; guard++) {
    if (sim.phase === "trickEnd") { advanceTrick(sim); continue; }
    if (sim.phase !== "playing") return;
    applyPlay(sim, sim.turn, chooseAICard(sim, sim.turn, false, rnd));
  }
}

/* Work budget in *simulated card plays*, not milliseconds. Cloudflare freezes
   Date.now() between I/O operations, so a wall-clock cutoff never trips inside a
   Durable Object and the search would always run its full width — the widest
   position (13 legal moves, 52 cards live) is also the most expensive one. This
   bound is deterministic, so node and Workers spend the same effort, and it
   spends it where PIMC actually pays: the endgame. */
const PIMC_PLAY_BUDGET = 8000;

/* Score every legal move. Split out of choosePIMCCard so the bot and the
   browser-side coach share one evaluator: two searchers that disagree about the
   same position would be a bug generator, and this is the one that is tuned.
   Returns null when the sampler cannot build a consistent world — the caller
   falls back to the heuristic, exactly as before. */
function evaluateMoves(G, me, opts) {
  const legal = legalCards(G, me);
  const rnd = (opts && opts.rnd) || Math.random;
  const timeMs = (opts && opts.timeMs) || 25;
  const budget = (opts && opts.playBudget) || PIMC_PLAY_BUDGET;
  const cardsLeft = G.hands.reduce((n, h) => n + h.length, 0) || 1;
  const affordable = Math.max(1, Math.floor(budget / (Math.max(1, legal.length) * cardsLeft)));
  const maxDet = Math.min((opts && opts.determinizations) || 24, affordable);
  const started = Date.now();
  const iAmDeclaring = sideOf(G, me) === "D";
  const wins = legal.map(() => 0), pts = legal.map(() => 0), counts = legal.map(() => 0);
  let dets = 0;

  for (let d = 0; d < maxDet; d++) {
    if (d >= 4 && Date.now() - started > timeMs) break; // secondary guard; a no-op on Workers
    const world = determinize(G, me, rnd);
    if (!world) return null;
    dets++;
    for (let i = 0; i < legal.length; i++) {
      const sim = rolloutClone(G);
      for (const p of [0, 1, 2, 3]) if (p !== me) sim.hands[p] = world[p].slice();
      applyPlay(sim, me, legal[i]);
      playOutRound(sim, rnd);
      const dPts = sim.capturedPoints[sim.declarer] + sim.capturedPoints[sim.partner];
      const made = dPts >= sim.bid;
      /* winProb and meanPoints are stated from MY side's point of view, which is
         what makes them readable in a hint. Their fusion below is algebraically
         the old win*1000 + margin, so the bot's choice is unchanged. */
      wins[i] += (iAmDeclaring === made) ? 1 : 0;
      pts[i] += iAmDeclaring ? dPts : TOTAL_POINTS - dPts;
      counts[i]++;
    }
  }
  return {
    determinizations: dets,
    moves: legal.map((card, i) => ({
      card,
      winProb: counts[i] ? wins[i] / counts[i] : 0,
      meanPoints: counts[i] ? pts[i] / counts[i] : 0,
      samples: counts[i],
    })),
  };
}

/* The argmax rule, exported beside evaluateMoves and for exactly the same
   reason (D29). Scoring the moves is only half of "what the search would have
   played"; RANKING them is the other half, and it is the half three files were
   each spelling out for themselves — this one, coach/worker.js's hint sort and
   coach/review.js's "best". Edit one and the hint recommends a card the bot
   would not play, or the review grades against a different best, with nothing
   erroring and nothing failing. winProb dominates by 1000:1 — a move that wins
   more sampled worlds always ranks first — so meanPoints is purely the
   tie-break between moves that win equally often, which over a few dozen
   integer-counted determinizations is common rather than exotic. */
const moveScore = m => m.winProb * 1000 + m.meanPoints;

function choosePIMCCard(G, me, opts) {
  const legal = legalCards(G, me);
  if (legal.length <= 1) return legal[0];
  const ev = evaluateMoves(G, me, opts);
  if (!ev) return chooseAICard(G, me, false, (opts && opts.rnd) || Math.random);
  let best = 0, bestScore = -Infinity;
  ev.moves.forEach((m, i) => {
    if (!m.samples) return;
    const score = moveScore(m);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return legal[best];
}

/* rolloutClone/playOutRound are exported for ai/bid-search.js, which simulates
   whole deals from the auction. Copying this object's 20 fields a second time is
   how two searches quietly start disagreeing about the same position. */
export { determinize, rolloutClone, playOutRound, PIMC_PLAY_BUDGET, evaluateMoves, moveScore, choosePIMCCard };
