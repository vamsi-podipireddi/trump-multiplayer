/* The match-level aggregate over decisions review.js and auction.js have
   already graded. Pure arithmetic: no search, no storage, no DOM — which is
   what makes every rule below directly testable over synthetic decisions.

   The headline is a MEAN, not a sum. A sum is not comparable across 3-, 5- and
   7-deal matches, and this number is meant to survive into a career trend. It
   is invariant to match length; it is NOT invariant to bot difficulty or to how
   often you declared, which is why a career view has to slice by difficulty
   rather than pool, and why the card says so. It is also a mean over three of
   the four decision kinds, not all four — see HEADLINE_KINDS below for why the
   bid is counted but not averaged in. */

const KINDS = ["play", "bid", "trump", "call"];

/* reviewDeal's own decisions carry no `kind` — they are all card play — so one
   is inferred rather than requiring review.js to change shape. */
const kindOf = (d) => d.kind || "play";

/* headline's own denominator — deliberately NOT the same as KINDS.
   Card play, trump and the call are genuinely commensurable: each delta is a
   forgone-probability difference between two candidates scored on one shared
   set of sampled worlds, so averaging them together averages one quantity.
   The bid is not: its delta measures distance from the search's own 0.5
   decision line, not forgone win probability — passing does not end the
   deal, it hands the auction to someone else, so there is no candidate
   counterfactual to subtract, only a line to be some distance from (D35's
   `counterfactual` section is the measurement project that would actually
   answer "forgone win probability" for a pass, and it is not this one).
   Folding it into headline's mean would average two different quantities
   into a third that is neither.
   Ordinal comparability does not imply cardinal commensurability: the bid
   still grades "fine"/"mistake"/"blunder" off the same thresholds as the
   other three (which is why it stays in `counts`, and why `byKind.bid` gets
   its own real meanDelta), but that shared vocabulary is a classification
   against a threshold, not a license to average it in with quantities it
   isn't. Excluded from `headline` alone — this was originally shipped
   inverted (Task 5/Task 7 fix round), the bug being exactly "the design spec
   states the distinction and then contradicts itself by defining the
   headline as a mean over all four." */
const HEADLINE_KINDS = new Set(["play", "trump", "call"]);

function matchReport(deals, seat, dealsInMatch) {
  const all = [];
  for (const d of (deals || [])) for (const dec of (d.decisions || [])) all.push(dec);

  const counts = { fine: 0, mistake: 0, blunder: 0 };
  for (const d of all) if (counts[d.grade] !== undefined) counts[d.grade]++;

  const byKind = {};
  for (const k of KINDS) {
    const mine = all.filter(d => kindOf(d) === k);
    byKind[k] = {
      n: mine.length,
      meanDelta: mine.length ? mine.reduce((s, d) => s + d.delta, 0) / mine.length : null,
      blunders: mine.filter(d => d.grade === "blunder").length,
    };
  }

  /* Null, not 0, when nothing commensurable was graded — the same
     never-a-flawless-zero rule the empty-match case already applies. A
     match where you only ever bid and never faced an open card-play, trump
     or call choice (never declared, and every card you played was forced)
     has no headline, even though `counts`/`byKind.bid` may be nonzero. */
  const commensurable = all.filter(d => HEADLINE_KINDS.has(kindOf(d)));

  return {
    headline: commensurable.length ? commensurable.reduce((s, d) => s + d.delta, 0) / commensurable.length : null,
    counts,
    byKind,
    worst: all.filter(d => d.grade !== "fine").sort((a, b) => b.delta - a.delta).slice(0, 2),
    coverage: {
      dealsGraded: (deals || []).length,
      dealsInMatch: dealsInMatch != null ? dealsInMatch : (deals || []).length,
      seat,
    },
  };
}

export { matchReport, KINDS, HEADLINE_KINDS };
