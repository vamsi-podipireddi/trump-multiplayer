/* The auction's half of the post-deal review: grade the bid, the trump pick and
   the partner call from exactly the information the player had at the time —
   the sibling of review.js, which does the same for card play.

   The trap this file exists to avoid: bidValue reads `G.trump || aiPickTrump(G)`
   and `G.calledCard || aiPickPartner(G)`. A position rebuilt from a FINISHED
   deal's view has both filled in, so a naive reconstruction would grade your bid
   using the trump you had not yet chosen. Every position below nulls them. Same
   class of bug as review.js's `phase: "playing"`, and just as invisible without
   the _tap check in test/coach.test.js. */
import * as E from "../core/engine/index.js";
import { startingHand, preRoundScores, seedFromDeal, gradeOf, MISTAKE_WIN_DELTA } from "./review.js";

/* A make-probability is a binomial proportion over `worlds` sampled deals, so
   its two-standard-error band is 2*sqrt(0.25/worlds) — which is exactly
   1/sqrt(worlds). Inside it the search cannot tell two candidates apart, and
   grading anyway would assert precision the sampler does not have (D43). */
const bandFor = (worlds) => 1 / Math.sqrt(worlds);

/* The bots run budget -> worlds, which is right for a decision billed per
   invocation. A grader has the inverse constraint, and inheriting the bots'
   budgets breaks it — though by less than this comment used to claim.
   CALL_PLAY_BUDGET is now 96000 (raised from 24000, D36), and
   worldsFor(10, 96000) = 184 worlds over ~10 candidates gives a band of
   1/sqrt(184) = ~0.0737 — still wider than MISTAKE_WIN_DELTA (0.07), but by
   about 5% now, not the >2x margin this comment argued at the old
   24000/46-worlds/0.147. A delta just past today's band already clears
   "mistake" outright, where it used to have to clear almost the whole way to
   "blunder" first — so an inherited budget no longer makes "mistake"
   unreachable, only less precise than the review's own floor below (205
   worlds by construction, band ~0.0698, for any candidate count). The case
   for deriving a budget instead of inheriting one is thinner than it was, not
   gone. So the review runs precision -> worlds -> budget, and the floor is
   derived from the finest grade it has to express rather than chosen: change
   MISTAKE_WIN_DELTA and this follows (D44). */
const MIN_REVIEW_WORLDS = Math.ceil(1 / MISTAKE_WIN_DELTA ** 2);   // 205
const auctionBudgetFor = (candidates) => MIN_REVIEW_WORLDS * candidates * 52;

/* The position `seat` faced at one auction decision. `highBid` is the auction
   log's own prefix — never v.bid, which is where the contract ENDED. */
function auctionPosition(v, seat, kind, highBid) {
  const hand = startingHand(v.tricks || [], seat);
  return {
    _silent: true,
    phase: kind === "bid" ? "bidding" : kind === "trump" ? "trumpSelect" : "partnerSelect",
    // the whole point of this file: nothing from after the decision reaches it
    trump: kind === "call" ? v.trump : null,
    calledCard: null, partner: null, teamsRevealed: false,
    bid: kind === "bid" ? null : v.bid,
    highBid: kind === "bid" ? highBid : v.bid,
    declarer: kind === "bid" ? null : seat,
    bonusSuit: v.bonusSuit, dealer: v.dealer, roundNumber: v.roundNumber,
    names: v.names.slice(), scores: preRoundScores(v),
    targetGames: v.consts ? v.consts.TARGET_GAMES : 5,
    hands: [0, 1, 2, 3].map(p => p === seat
      ? hand.map(c => ({ suit: c.suit, rank: c.rank }))
      : new Array(13).fill(null)),
    trick: [], leadSuit: null, turn: seat, leader: seat, trickNumber: 0,
    tricksWon: [0, 0, 0, 0], capturedPoints: [0, 0, 0, 0],
    lastWinner: -1, lastWinnerSlot: -1, lastResult: null,
    log: [], playedCards: [], voids: [{}, {}, {}, {}],
  };
}

/* A graded decision — band decisions still return one, graded "fine": they
   were real decisions that were not errors, and dropping them would inflate
   the denominator's quality (D43). */
function decide(kind, roundNumber, played, best, playedProb, bestProb, worlds) {
  const band = bandFor(worlds);
  const raw = Math.max(0, bestProb - playedProb);
  const delta = raw > band ? raw : 0;
  return { kind, roundNumber, played, best, playedProb, bestProb, delta, band,
           grade: gradeOf(delta), worlds };
}

/* Every bidding turn this seat took. `highBid` folds the log left-to-right, so
   each position sees exactly the target that seat faced — the reason G.auction
   exists at all (D39): G.bids holds only each seat's LATEST bid, and a pass is
   not written to it, so the sequence is unrecoverable without the log. */
function gradeBids(v, seat, seed, tap, decisions, skipped) {
  let highBid = null;
  (v.auction || []).forEach((entry, i) => {
    if (entry.seat !== seat) { if (entry.value != null) highBid = entry.value; return; }
    if (entry.forced) {
      skipped.push({ kind: "bid", roundNumber: v.roundNumber, reason: "forced" });
    } else {
      const pos = auctionPosition(v, seat, "bid", highBid);
      if (tap) tap(pos, "bid", v.roundNumber);
      const need = E.minNextBid(pos);
      /* bidIsLegal admits any value >= minNextBid, but the bot only ever weighs
         `need` — so an overbid is graded against the level actually bid, not the
         minimum it could have bid. */
      const target = entry.value == null ? need : entry.value;
      const bv = E.bidValue(pos, seat, { rnd: E.mulberry32(seed + 100 + i), playBudget: auctionBudgetFor(1) });
      const worlds = bv.samples.length;
      if (!worlds) {
        skipped.push({ kind: "bid", roundNumber: v.roundNumber, reason: "no-world" });
      } else {
        const p = bv.makeProb(target);
        /* One-sided: being far from the line on the RIGHT side is not an error.
           A pass is wrong only when p is high; a bid only when p is low. */
        const wrongBy = entry.value == null ? p - 0.5 : 0.5 - p;
        const band = bandFor(worlds);
        const delta = wrongBy > band ? wrongBy : 0;
        decisions.push({
          kind: "bid", roundNumber: v.roundNumber,
          /* best mirrors aiBidDecisionSearch's own threshold (ai/bid-search.js):
             bid `target` when makeProb(target) >= 0.5, else pass. Not the
             unconditional opposite of what was played — that only names the
             right alternative when the play itself was wrong, and otherwise
             prints the WRONG suggestion (told to pass when you correctly bid,
             or to bid when you correctly passed). This equals `played` exactly
             when you were on the right side of the line, and names the other
             action only when you were not. */
          played: entry.value, best: p >= 0.5 ? target : null,
          /* bestProb is the decision LINE (0.5), not a candidate's own win
             probability — deliberately: this delta measures distance from the
             bid/pass boundary, not forgone make-probability. Passing hands the
             auction on rather than ending the deal, so the true counterfactual
             to a bid would mean simulating an auction that continues without
             you; the line is the number that's actually available. Do not
             "fix" this into a candidate's makeProb. */
          playedProb: p, bestProb: 0.5, delta, band,
          grade: gradeOf(delta), worlds,
        });
      }
    }
    if (entry.value != null) highBid = entry.value;
  });
}

function gradeTrump(v, seat, seed, tap, decisions, skipped) {
  if (v.declarer !== seat) { skipped.push({ kind: "trump", roundNumber: v.roundNumber, reason: "not-declarer" }); return; }
  const pos = auctionPosition(v, seat, "trump", null);
  if (tap) tap(pos, "trump", v.roundNumber);
  const ev = E.evaluateTrumps(pos, seat, { rnd: E.mulberry32(seed + 200), playBudget: auctionBudgetFor(E.SUITS.length) });
  if (!ev) { skipped.push({ kind: "trump", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  const best = ev.candidates.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));
  const yours = ev.candidates.find(c => c.suit === v.trump);
  if (!yours) { skipped.push({ kind: "trump", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  decisions.push(decide("trump", v.roundNumber, v.trump, best.suit, yours.makeProb, best.makeProb, ev.worlds));
}

function gradeCall(v, seat, seed, tap, decisions, skipped) {
  if (v.declarer !== seat) { skipped.push({ kind: "call", roundNumber: v.roundNumber, reason: "not-declarer" }); return; }
  if (!v.calledCard) { skipped.push({ kind: "call", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  const pos = auctionPosition(v, seat, "call", null);
  if (tap) tap(pos, "call", v.roundNumber);
  const ev = E.evaluateCalls(pos, seat, { rnd: E.mulberry32(seed + 300), playBudget: auctionBudgetFor(13) });
  if (!ev) { skipped.push({ kind: "call", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  const best = ev.candidates.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));
  const yours = ev.candidates.find(c => E.sameCard(c.card, v.calledCard));
  /* The shortlist is the honours plus the heuristic's pick, so a called seven is
     legitimately absent — that is a decision outside the search's candidate set,
     not a sampling failure, and it is skipped rather than graded against a set
     it was never in. */
  if (!yours) { skipped.push({ kind: "call", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  decisions.push(decide("call", v.roundNumber, v.calledCard, best.card, yours.makeProb, best.makeProb, ev.worlds));
}

/* v: a finished deal's view (phase roundEnd/matchOver). seat: whose auction to
   grade. opts.seed overrides the deal-derived default (tests only). opts._tap
   (pos, kind, roundNumber) sees every position before it reaches the search —
   the affordance that makes this file's D32 promise checkable. */
function reviewAuction(v, seat, opts) {
  const seed = (opts && opts.seed != null) ? opts.seed : seedFromDeal(v);
  const tap = opts && opts._tap;
  const decisions = [], skipped = [];
  gradeBids(v, seat, seed, tap, decisions, skipped);
  gradeTrump(v, seat, seed, tap, decisions, skipped);
  gradeCall(v, seat, seed, tap, decisions, skipped);
  return { decisions, skipped };
}

export { reviewAuction, MIN_REVIEW_WORLDS, auctionBudgetFor, bandFor };
