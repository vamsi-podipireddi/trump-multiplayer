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

/* D43 itself, as one expression rather than two. A raw distance the sampler
   cannot resolve is reported as exactly 0 — not as a small number the panel
   would then print, rank in "Costliest decisions" and average into the
   headline as if the search had actually measured it. Strict `>`: a distance
   equal to the band is still inside it.
   Extracted (fix round) because both graded quantities clamp the same way and
   neither had a test: `decide`'s forgone make-probability, and gradeBids'
   signed distance from the 0.5 line — which is why this takes the raw value
   already in each caller's own unit rather than recomputing either. */
const clampToBand = (raw, band) => (raw > band ? raw : 0);

/* The bots run budget -> worlds, which is right for a decision billed per
   invocation. A grader has the opposite constraint. Bid (always 1
   candidate) and trump (always 4) fail it on every hand: worldsFor(1, 3000)
   = 57 worlds (band 0.1325), worldsFor(4, 24000) = 115 (band 0.0933) — both
   above MISTAKE_WIN_DELTA (0.07). The call is not unconditional: its
   shortlist averages ~8 candidates (bid-search.js's own measured figure),
   where CALL_PLAY_BUDGET's 96000 is actually enough — worldsFor(8, 96000) =
   230 worlds, band ~0.0659, under the line — but the shortlist runs up to
   12 (the honours the seat does not hold, at most all 12 of them, with the
   heuristic's own pick deduped into that same list rather than added to
   it), where the same budget gives only 153 worlds, band ~0.0808, over it
   again. So inheriting doesn't fail every
   call, only the widest hands — exactly where a fixed budget is weakest.
   Deriving the budget from the precision needed instead guarantees the
   same band (205 worlds, ~0.0698) on every position the review might
   grade, typical or not, which no inherited constant can promise. So the
   review runs precision -> worlds -> budget, and the floor is derived from
   the finest grade it has to express rather than chosen: change
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
   the denominator's quality (D43).
   Exported for the tests, the same reason worker.js exports gradeOneDeal:
   reaching this through reviewAuction alone means waiting for a real search
   to happen to land two candidates inside one band, which most matches never
   do — so the one rule this function exists to apply would be asserted only
   on the runs that got lucky. */
function decide(kind, roundNumber, played, best, playedProb, bestProb, worlds) {
  const band = bandFor(worlds);
  const raw = Math.max(0, bestProb - playedProb);
  const delta = clampToBand(raw, band);
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
        const delta = clampToBand(wrongBy, band);
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
  /* 13, one above the real 12-candidate ceiling (see this file's header): a
     budget only ever buys MORE worlds than the floor needs, never fewer —
     evaluateCalls divides it by the shortlist it actually built — so the
     one-candidate margin costs a little search and cannot cost precision.
     Left as-is deliberately rather than tightened to 12, since changing it
     would move every graded call's numbers for no gain in what the band
     guarantees. */
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

export { reviewAuction, MIN_REVIEW_WORLDS, auctionBudgetFor, bandFor, clampToBand, decide };
