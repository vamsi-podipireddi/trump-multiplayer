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
   fewer. bid's row is unaffected by anything below: bidValue was already a
   make-probability threshold, never a points argmax, so it is scored as
   decisions that differ from a near-ground-truth oracle call, not as a regret.
   trump and call are scored against a wide oracle (scripts/bench-auction-search.js
   `regret`) as mean regret in make-probability — the unit aiPickTrumpSearch/
   aiPickPartnerSearch have ranked candidates by since D42, evaluateTrumps/
   evaluateCalls's own scoreCandidates — against the best available candidate
   (lower is better; the hand-count these replace is the bar to beat). meanPoints
   rides alongside each regret in parens so this run can still be read against
   the mean-points rows it replaces:

     bid    1 candidate     3000 ->  57 worlds  6 of 250 decisions differ from a
                                                2000-world oracle (6000 gives 4),
                                                all on hands within 0.08 of the
                                                0.5 line, where the decision is
                                                near-indifferent by construction.
                                                Halving 6000 -> 3000 ends 17.3%
                                                of auctions differently and
                                                changes deals won by -0.09 +/-
                                                0.38 pp over 7998 paired deals:
                                                nothing, for 29% of the auction's
                                                whole compute. A threshold test
                                                needs far less than an argmax
                                                does, and this is the one that
                                                runs on every bidding turn
                                                (~10.7 an auction, all seats).
     trump  4 candidates    hand-count regret 0.010 (1.00 pts)
                            6000 -> ~28 worlds  regret 0.010 (0.91 pts)  gain
                                                +0.000 +/- 0.008 (+0.09 +/- 0.78
                                                pts)
                           24000 -> ~115 worlds regret 0.002 (0.20 pts)  gain
                                                +0.008 +/- 0.006 (+0.80 +/- 0.58
                                                pts)  <- shipped
                           96000 -> ~461 worlds regret 0.001 (0.06 pts)  gain
                                                +0.010 +/- 0.006 (+0.94 +/- 0.55
                                                pts). What 96000 adds over
                                                24000 is small enough not to
                                                buy, not flat throughout: the
                                                real movement is 6000 -> 24000
                                                (regret 0.010 -> 0.002); paired
                                                24000->96000, same deals, is
                                                +0.001 +/- 0.002 make-prob
                                                (+0.14 +/- 0.18 pts, n=150) —
                                                tighter than the marginal CIs
                                                above because 96000's worlds
                                                are a superset of 24000's (same
                                                seed), not an independent
                                                sample — ranged +0.001 to
                                                +0.004 paired across four
                                                independent 150-deal runs. A
                                                one-off 384000 (16x) check
                                                landed at the same regret 0.001
                                                and gain +0.013 as that run's
                                                own 96000: the curve does
                                                flatten, just starting around
                                                24000, not from 6000. 24000
                                                stands.
     call  ~8 candidates    hand-count regret 0.039 (3.19 pts)
                            6000 -> ~14 worlds  regret 0.044 (3.83 pts)  gain
                                                -0.005 +/- 0.012 (-0.64 +/- 1.09
                                                pts) — at this width the call
                                                search cannot beat the
                                                hand-count it replaces.
                           24000 -> ~57 worlds  regret 0.014 (1.18 pts)  gain
                                                +0.025 +/- 0.011 (+2.01 +/- 0.99
                                                pts)
                           96000 -> ~229 worlds regret 0.006 (0.40 pts)  gain
                                                +0.034 +/- 0.009 (+2.79 +/- 0.84
                                                pts)  <- NOW shipped. Unlike
                                                trump this is a real further
                                                gain, not noise: paired
                                                24000->96000, same deals, is
                                                +0.008 +/- 0.005 make-prob
                                                (+0.78 +/- 0.52 pts, n=150) —
                                                never crossed zero in any of
                                                four independent 150-deal runs
                                                (+0.008 to +0.013 paired each
                                                time — an order of magnitude
                                                tighter than the marginal CIs,
                                                which DO overlap run to run;
                                                the paired difference is what
                                                this decision actually rests
                                                on, not the marginal ranges). A
                                                one-off 384000 check (regret
                                                0.002, gain +0.043) shows that
                                                curve flattening from 96000 on,
                                                which is why the constant stops
                                                there rather than higher.

   The trump and call rows above are each a 150-deal run
   (`node scripts/bench-auction-search.js regret`; deals come off the platform
   CSPRNG unseeded, so a rerun is an independent replication, not a replay —
   see the four-run ranges above). Both are evaluated at trumpSelect, from the
   real declarer against the real winning contract — toTrumpSelect drives to
   the hand-count-bid auction, not the search's own heavier bidding, so this
   is the same contract distribution the hand-count table plays at (ROADMAP
   Task 8: mean 150.3); checked directly on 300 fresh deals here: mean 149.8,
   observed range 130-195. trump used to be evaluated from an arbitrary
   pre-auction seat, targeting a fresh deal's 130-point minimum bid rather
   than the contract it would actually be asked about. That barely mattered
   under mean points; under make-probability the target IS the statistic, so
   it was a bench bug, not a stylistic choice, and every trump figure above is
   measured post-fix.
   Confirmed out of model on 9991 played deals: +2.08 +/- 1.25 pts to the
   declaring side, +0.56 +/- 0.42 pp of deals won. Both are asked once a deal
   and only of the seat that won it. That 9991-deal figure is ROADMAP D35's,
   not D36's: it predates both D42's re-ranking and CALL_PLAY_BUDGET's raise
   to 96000 and was not re-measured by this task — read it as the history
   behind D35's own cut, not as current evidence for these two constants.

   WHERE EACH OF THESE ACTUALLY RUNS, which the rows above do not say. Only
   aiBidDecisionSearch is routed server-side (ai/index.js, "hard" only). Trump
   and the call are the browser's alone: the coach's auction advisor
   (app/js/coach/worker.js) is their sole caller, and it passes its own, wider
   playBudget — so TRUMP_PLAY_BUDGET/CALL_PLAY_BUDGET are this module's tuned
   defaults and the bench's and tests' basis, not a figure any shipped call
   spends. ROADMAP D35 has the reasoning: a Durable Object bills per invocation,
   trump and call are one alarm each at ~8 ms where the alternative is ~0.01 ms,
   and +0.56 +/- 0.42 pp (D35's figure, not re-measured by this task — see
   above) is not distinguishable from zero. The bid buys +2.77 +/- 0.91 pp for
   ~1.3 ms on a turn that is otherwise near-free.

   The bid alone costs the DO ~32000 plays a deal against PIMC's measured
   ~124500 for the same deal's card play (+25%); all three together now come
   to ~151000 (+120%, `DEALS=60 node scripts/bench-auction-search.js cost`) —
   was ~79500 (+64%) at the pre-raise CALL_PLAY_BUDGET=24000 this comment
   quoted before CALL_PLAY_BUDGET became 96000. PIMC's figure is measured, not
   8000 x 13: 8000 is a per-
   decision CAP, not a per-decision spend — evaluateMoves divides it by
   legal.length x cardsLeft, so maxDet GROWS toward its 24 ceiling as the deal
   empties while the per-decision cost falls, and a forced play short-circuits
   before evaluateMoves is called at all.
   scripts/bench-auction-search.js re-derives every number in this comment. */
const BID_PLAY_BUDGET = 3000;
const TRUMP_PLAY_BUDGET = 24000;
// Raised from 24000 (D36 correction, node scripts/bench-auction-search.js
// regret): re-measured in make-probability, 24000 still left real regret on
// the table that trump's equivalent budget did not — see the comment above.
const CALL_PLAY_BUDGET = 96000;
/* Exported for scripts/bench-auction-search.js, which prints the world counts
   this comment block quotes: a bench carrying its own copy of the formula would
   keep printing numbers after a change here, and those numbers are pasted into
   this comment and into ROADMAP D35/D36 as if they were measured. */
const worldsFor = (candidates, budget) => Math.max(4, Math.floor(budget / (candidates * 52)));

/* aiPickPartner reads G.trump to decide which ace to call; during the auction no
   trump has been named yet, so handing it G unchanged makes it call the "null"
   ace. Every candidate trump therefore gets scored with the call it implies.
   Exported for the bench alongside worldsFor, same reason: its copy there had
   silently dropped the identity short-circuit. */
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

/* Common random numbers, unchanged (D36): every candidate is scored on the SAME
   sampled worlds, so the comparison is a true paired one.
   What changed is the statistic. Candidates used to be ranked on mean captured
   points; D35 retired that objective — a deal is scored made or set, so points
   past the contract line buy nothing — and D42 is this function's own switch
   to ranking by it. makeProb is the fraction of shared worlds
   in which the declaring side reaches the contract, i.e. the same unit
   evaluateMoves already reports card play in. meanPoints is retained because
   scripts/bench-auction-search.js reports in it and D36's history is written
   in it. */
function scoreCandidates(G, seat, cands, worlds, toPlay, rnd) {
  const target = G.bid == null ? minNextBid(G) : G.bid;
  return cands.map(cand => {
    const { trump, call } = toPlay(cand);
    const pts = worlds.map(w => playOutWith(G, seat, w, trump, call, rnd));
    return {
      cand,
      makeProb: pts.filter(p => p >= target).length / pts.length,
      meanPoints: pts.reduce((s, p) => s + p, 0) / pts.length,
    };
  });
}

/* Strict `>`, and the heuristic's own answer sits at index 0 — so a tie leaves
   the heuristic's choice standing, exactly as argmaxCandidate did. */
const bestOf = (scored) => scored.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));

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

/* One evaluator, two consumers — D29's move applied to the auction. The coach's
   review needs every candidate's score to size a grade, not just the winner. */
function evaluateTrumps(G, seat, opts) {
  const rnd = (opts && opts.rnd) || Math.random;
  const budget = (opts && opts.playBudget) || TRUMP_PLAY_BUDGET;
  const heuristic = aiPickTrump(G, seat);
  const worlds = sampleWorlds(G, seat, worldsFor(SUITS.length, budget), rnd);
  if (!worlds.length) return null;
  const cands = [heuristic, ...SUITS.filter(s => s !== heuristic)];
  const scored = scoreCandidates(G, seat, cands, worlds,
    suit => ({ trump: suit, call: aiPickPartner(withTrump(G, suit), seat) }), rnd);
  return {
    candidates: scored.map(s => ({ suit: s.cand, makeProb: s.makeProb, meanPoints: s.meanPoints })),
    worlds: worlds.length,
  };
}

function aiPickTrumpSearch(G, seat, opts) {
  const ev = evaluateTrumps(G, seat, opts);
  return ev ? bestOf(ev.candidates).suit : aiPickTrump(G, seat);
}

/* callableCards offers up to 39 cards and nobody calls a seven, so the shortlist
   is the Q/K/A the seat does not hold — at most 12 — plus the heuristic's own
   pick, which makes that answer *reachable* (so the search converges to at least
   the heuristic as worlds -> infinity) and covers the barely-possible hand
   holding all twelve honours. Reachable is all it is: an argmax over noisy
   estimates is biased upward and will sometimes select a truly worse card, which
   is exactly what the 6000-world row above measures. Cutting the shortlist
   further would be the cheap way to buy precision, and it does not work: over
   100 deals the best call was an ace 70% of the time but a king 23% and a queen
   7%, and an aces-only shortlist forfeits 2.09 of the 3.33 points the full one
   wins back. The kings and queens are where the heuristic is wrong. */
function evaluateCalls(G, seat, opts) {
  const rnd = (opts && opts.rnd) || Math.random;
  const budget = (opts && opts.playBudget) || CALL_PLAY_BUDGET;
  const trump = G.trump || aiPickTrump(G, seat);
  const heuristic = aiPickPartner(withTrump(G, trump), seat);
  const honours = callableCards(G, seat).filter(c => c.rank >= 12 && !sameCard(c, heuristic));
  const cands = heuristic ? [heuristic, ...honours] : honours;
  if (!cands.length) return null;
  const worlds = sampleWorlds(G, seat, worldsFor(cands.length, budget), rnd);
  if (!worlds.length) return null;
  const scored = scoreCandidates(G, seat, cands, worlds, card => ({ trump, call: card }), rnd);
  return {
    candidates: scored.map(s => ({ card: s.cand, makeProb: s.makeProb, meanPoints: s.meanPoints })),
    worlds: worlds.length,
  };
}

function aiPickPartnerSearch(G, seat, opts) {
  const ev = evaluateCalls(G, seat, opts);
  if (ev) return bestOf(ev.candidates).card;
  const trump = G.trump || aiPickTrump(G, seat);
  return aiPickPartner(withTrump(G, trump), seat);
}

export { bidValue, aiBidDecisionSearch, aiPickTrumpSearch, aiPickPartnerSearch,
         evaluateTrumps, evaluateCalls,
         BID_PLAY_BUDGET, TRUMP_PLAY_BUDGET, CALL_PLAY_BUDGET, worldsFor, withTrump };
