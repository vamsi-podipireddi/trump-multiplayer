/* The match-level aggregate over decisions review.js and auction.js have
   already graded. Pure arithmetic: no search, no storage, no DOM — which is
   what makes every rule below directly testable over synthetic decisions.

   The headline is a MEAN, not a sum. A sum is not comparable across 3-, 5- and
   7-deal matches, and this number is meant to survive into a career trend. It
   is invariant to match length; it is NOT invariant to bot difficulty or to how
   often you declared, which is why a career view has to slice by difficulty
   rather than pool, and why the card says so. */

const KINDS = ["play", "bid", "trump", "call"];

/* reviewDeal's own decisions carry no `kind` — they are all card play — so one
   is inferred rather than requiring review.js to change shape. */
const kindOf = (d) => d.kind || "play";

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

  return {
    headline: all.length ? all.reduce((s, d) => s + d.delta, 0) / all.length : null,
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

export { matchReport, KINDS };
