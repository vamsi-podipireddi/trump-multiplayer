import { SUITS, MAX_BID } from "../constants.js";
import { sameCard, sortHand } from "../cards.js";
import { minNextBid } from "../bidding.js";
import { callableCards } from "../contract.js";
import { aiPickTrump, aiPickPartner } from "./heuristic.js";
import { determinize, rolloutClone, playOutRound } from "./pimc.js";

// ============================================================
//  Hard AI — the auction search
//  PIMC's idea moved one phase earlier. The bots answer all three
//  auction questions with a linear hand-count that never simulates a
//  card: aiBidEstimate adds a flat 60 to a weighted point sum,
//  aiPickTrump ignores card points entirely, aiPickPartner calls the
//  highest ace it lacks. Here we instead sample whole deals from the
//  seat's own 13 cards, play each one out with the heuristic AI, and
//  answer from what the declaring side actually captured.
// ============================================================

/* Work budgets in *simulated card plays*, for the same reason ai/pimc.js counts
   them: Cloudflare freezes Date.now() between I/O operations, so a wall-clock
   cutoff never fires inside a Durable Object and the search would run its full
   width anyway. There is deliberately no clock guard here at all; the play count
   is the whole bound, so node and Workers spend identical effort.

   One budget per question rather than one shared by all three, because a shared
   one splits them exactly backwards: worldsFor divides by the candidate count,
   so the more candidates a question has the fewer worlds each is judged on — yet
   an argmax over C near-equal candidates needs MORE samples as C grows, not
   fewer. Scored against a 300-world oracle as mean regret in captured points
   against the best available candidate (lower is better; the hand-count these
   replace is the bar to beat):

     bid    1 candidate     6000 -> 115 worlds  0 of 120 decisions differ from a
                                                2000-world oracle. A 0.5
                                                threshold test needs far less
                                                than an argmax does, and this is
                                                the one that runs on every
                                                bidding turn (~10.7 an auction,
                                                all four seats together).
     trump  4 candidates    6000 ->  28 worlds  regret 1.02 vs heuristic 2.28
                           24000 -> 115 worlds  regret 0.48 vs heuristic 2.96
     call  ~10 candidates   6000 ->  11 worlds  regret 3.60 vs heuristic 3.33 —
                                                WORSE than the hand-count it
                                                replaces. Eleven worlds cannot
                                                rank ten cards whose true spread
                                                is ~20 points, so the argmax is
                                                mostly ranking its own sampling
                                                noise, and the winner's curse
                                                does the rest.
                           24000 ->  46 worlds  regret 1.06 vs heuristic 3.65

   The 24000 rows are a 150-deal hold-out on seeds disjoint from the tuning runs:
   +2.47 +/- 0.95 pts a deal for trump, +2.60 +/- 0.87 for the call. Both are
   asked once a deal and only of the seat that won the auction, so 24000 plays
   (~16ms) sits against the 104000 (8000 x 13 cards) the same bot already spends
   playing that deal out under PIMC. */
const BID_PLAY_BUDGET = 6000;
const TRUMP_PLAY_BUDGET = 24000;
const CALL_PLAY_BUDGET = 24000;
const worldsFor = (candidates, budget) => Math.max(4, Math.floor(budget / (candidates * 52)));

/* aiPickPartner reads G.trump to decide which ace to call; during the auction no
   trump has been named yet, so handing it G unchanged makes it call the "null"
   ace. Every candidate trump therefore gets scored with the call it implies. */
const withTrump = (G, trump) => (G.trump === trump ? G : { ...G, trump });

/* At bid time nothing has been played, no void is known and no card has been
   called, so this is an unconstrained deal of the other 39 cards and never
   fails — but determinize is allowed to return null, so drop those. */
function sampleWorlds(G, seat, k, rnd) {
  const out = [];
  for (let i = 0; i < k; i++) { const w = determinize(G, seat, rnd); if (w) out.push(w); }
  return out;
}

/* One sampled deal, played out as if `seat` had won the auction: it names
   `trump`, calls `call`, and leads. Whoever holds the called card in THIS world
   is the partner — different worlds legitimately hand it to different seats, and
   that spread is the uncertainty the search exists to measure, not a bug.
   Returns the points the declaring side captured. */
function playOutWith(G, seat, world, trump, call, rnd) {
  const sim = rolloutClone(G);
  for (const p of [0, 1, 2, 3]) if (p !== seat) sim.hands[p] = world[p].slice();
  const holder = [0, 1, 2, 3].find(p => sim.hands[p].some(c => sameCard(c, call)));
  const partner = holder === undefined ? seat : holder; // unreachable: every unseen card is dealt
  sim.trump = trump; sim.calledCard = call;
  sim.declarer = seat; sim.partner = partner;
  /* applyTrump sorts every hand by trump before play starts, and the rollout
     policy breaks its ties on hand order — so an unsorted sim is a subtly
     different game from the one being bid on. */
  sim.hands.forEach(h => sortHand(h, trump));
  sim.phase = "playing"; sim.leader = seat; sim.turn = seat;
  sim.trick = []; sim.leadSuit = null; sim.trickNumber = 0;
  sim.tricksWon = [0, 0, 0, 0]; sim.capturedPoints = [0, 0, 0, 0];
  /* Inert for the rollout — chooseAICard never reads the contract — but endRound
     compares against it when the last trick falls, and `>= null` is a trap. */
  sim.bid = G.bid == null ? minNextBid(G) : G.bid;
  playOutRound(sim, rnd);
  return partner === seat ? sim.capturedPoints[seat]
                          : sim.capturedPoints[seat] + sim.capturedPoints[partner];
}

/* Common random numbers: every candidate is scored on the SAME sampled worlds.
   Which 39 cards the other seats hold swamps the difference between two
   candidates, and sharing the worlds cancels it exactly — the rollout policy
   consumes no randomness of its own (chooseAICard only draws for `easy`), so a
   world plus a candidate is a deterministic number and the comparison is a true
   paired one. Fresh worlds per candidate would cost the same and be strictly
   noisier. */
const meanOver = (G, seat, worlds, trump, call, rnd) =>
  worlds.reduce((s, w) => s + playOutWith(G, seat, w, trump, call, rnd), 0) / worlds.length;

/* Pick the argmax of mean captured points, with the heuristic's own answer
   evaluated first so that a tie — these are means of integer point totals over
   a few dozen worlds, so exact ties do happen — leaves the heuristic's choice
   standing. The search must earn a strict improvement to depart from the answer
   it replaces. */
function argmaxCandidate(cands, score) {
  let best = cands[0], bestMean = score(cands[0]);
  for (let i = 1; i < cands.length; i++) {
    const mean = score(cands[i]);
    if (mean > bestMean) { bestMean = mean; best = cands[i]; }
  }
  return best;
}

/* What this hand is worth if it wins the auction, as a distribution rather than
   a number: `samples` is the captured-points total from each sampled deal
   (ascending), and makeProb(t) is the fraction of them that reach t. A bid is a
   claim about a threshold, so a threshold is what the caller gets to ask about.
   Trump and call come from the heuristic here — the bidder has not chosen them
   yet, and searching them too would cost the samples this estimate needs. */
function bidValue(G, seat, opts) {
  const rnd = (opts && opts.rnd) || Math.random;
  const budget = (opts && opts.playBudget) || BID_PLAY_BUDGET;
  const trump = G.trump || aiPickTrump(G, seat);
  const call = G.calledCard || aiPickPartner(withTrump(G, trump), seat);
  const worlds = sampleWorlds(G, seat, worldsFor(1, budget), rnd);
  const samples = worlds.map(w => playOutWith(G, seat, w, trump, call, rnd)).sort((a, b) => a - b);
  const n = samples.length, mid = n >> 1;
  return {
    samples,
    median: !n ? 0 : (n % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2),
    makeProb: (t) => n ? samples.filter(s => s >= t).length / n : 0,
  };
}

/* A bidder only ever takes the next legal step or passes, so the decision is a
   single yes/no: does this hand reach `need` in at least half the worlds? That
   replaces aiBidDecision's `pts += 60` fudge and its ±8 of noise with a real
   make-probability against the actual target. */
function aiBidDecisionSearch(G, seat, opts) {
  const need = minNextBid(G);
  if (need > MAX_BID) return null;
  return bidValue(G, seat, opts).makeProb(need) >= 0.5 ? need : null;
}

/* Four candidates on ~115 shared worlds each. aiPickTrump ranks suits on length
   and then the raw sum of ranks — card points never enter it, so the 30-point
   bonus 3 is worth 3 to it and a 10 is worth 10. Length is a better proxy than
   that sounds (it beats the search's own choice often enough that this only
   moves ~30% of deals), so the search scores the suit by what the side actually
   captures with it, including the ace it would then call. */
function aiPickTrumpSearch(G, seat, opts) {
  const rnd = (opts && opts.rnd) || Math.random;
  const budget = (opts && opts.playBudget) || TRUMP_PLAY_BUDGET;
  const heuristic = aiPickTrump(G, seat);
  const worlds = sampleWorlds(G, seat, worldsFor(SUITS.length, budget), rnd);
  if (!worlds.length) return heuristic;
  const cands = [heuristic, ...SUITS.filter(s => s !== heuristic)];
  return argmaxCandidate(cands, suit =>
    meanOver(G, seat, worlds, suit, aiPickPartner(withTrump(G, suit), seat), rnd));
}

/* callableCards offers up to 39 cards and nobody calls a seven, so the shortlist
   is the Q/K/A the seat does not hold — at most 12 — plus the heuristic's own
   pick, which keeps the search's floor at the answer it replaces and covers the
   (barely possible) hand holding all twelve honours. Cutting the shortlist
   further would be the cheap way to buy precision, and it does not work: over
   100 deals the best call was an ace 70% of the time but a king 23% and a queen
   7%, and an aces-only shortlist forfeits 2.09 of the 3.33 points the full one
   wins back. The kings and queens are where the heuristic is wrong. */
function aiPickPartnerSearch(G, seat, opts) {
  const rnd = (opts && opts.rnd) || Math.random;
  const budget = (opts && opts.playBudget) || CALL_PLAY_BUDGET;
  const trump = G.trump || aiPickTrump(G, seat); // the call is only asked after trump is named
  const heuristic = aiPickPartner(withTrump(G, trump), seat);
  const honours = callableCards(G, seat).filter(c => c.rank >= 12 && !sameCard(c, heuristic));
  const cands = heuristic ? [heuristic, ...honours] : honours;
  if (!cands.length) return heuristic;
  const worlds = sampleWorlds(G, seat, worldsFor(cands.length, budget), rnd);
  if (!worlds.length) return heuristic;
  return argmaxCandidate(cands, card => meanOver(G, seat, worlds, trump, card, rnd));
}

export { bidValue, aiBidDecisionSearch, aiPickTrumpSearch, aiPickPartnerSearch,
         BID_PLAY_BUDGET, TRUMP_PLAY_BUDGET, CALL_PLAY_BUDGET };
