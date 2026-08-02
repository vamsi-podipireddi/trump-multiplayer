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
  /* Normalised once, here, rather than left for each consumer below (or
     worse, each consumer of THIS function's own return value) to
     rediscover: reviewDeal's own decisions carry neither `kind` nor
     `roundNumber` (review.js:210-214 — trickNo, played, best, ..., nothing
     else), only reviewAuction's do. Every entry in `all` is a fresh object
     (never the caller's own decision, mutated) with both stamped on — kind
     via kindOf, roundNumber off the owning deal record — so every field
     built from `all` below, worst/worstBid included, can read `d.kind`/
     `d.roundNumber` directly and trust it. Fix round C1: the original
     shipped `worst` without this, reading the raw decision straight through,
     so every card-play entry in it printed "undefined · deal undefined". */
  const all = [];
  for (const d of (deals || [])) for (const dec of (d.decisions || []))
    all.push({ ...dec, kind: kindOf(dec), roundNumber: d.roundNumber });

  const counts = { fine: 0, mistake: 0, blunder: 0 };
  for (const d of all) if (counts[d.grade] !== undefined) counts[d.grade]++;

  const byKind = {};
  for (const k of KINDS) {
    const mine = all.filter(d => d.kind === k);
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
  const commensurable = all.filter(d => HEADLINE_KINDS.has(d.kind));

  return {
    headline: commensurable.length ? commensurable.reduce((s, d) => s + d.delta, 0) / commensurable.length : null,
    counts,
    byKind,
    /* Fix round I2: ranked separately, on HEADLINE_KINDS' own split — the
       same reason headline is. Sorting a bid's distance-from-the-line
       together with a card play's forgone win probability by raw magnitude
       is the same cardinal comparison headline was fixed to stop making,
       just moved from a mean into a ranking: a bid at 0.30 (well off the
       line) would otherwise outrank a card play at 0.22 (real forgone win
       probability) in one list captioned "costliest", inviting exactly the
       reading bidNote (ui/coach.js) exists to prevent. worst: the two
       costliest among play/trump/call — empty, not merged into worstBid,
       when nothing commensurable was graded. worstBid: the costliest bid(s)
       alone, in their own unit, never interleaved with the first list. */
    worst: commensurable.filter(d => d.grade !== "fine").sort((a, b) => b.delta - a.delta).slice(0, 2),
    worstBid: all.filter(d => !HEADLINE_KINDS.has(d.kind) && d.grade !== "fine").sort((a, b) => b.delta - a.delta).slice(0, 2),
    /* The thinnest card-play search behind any number above (fix round I3).
       reviewDeal reports its own per-deal minimum and worker.js's
       gradeOneDeal threads it up; this is the minimum across the deals that
       actually had a card play to grade. 0 means "no card play was graded
       at all" — a deal of nothing but forced cards, or a synthetic report —
       and is deliberately not the same as "sampled zero times": describeReport
       says nothing rather than caveat a number that isn't there. Only card
       play needs this. The auction's own band is its sample statement, and
       it is floored by construction (D44). */
    samples: (() => {
      const n = (deals || []).map(d => d.samples).filter(s => typeof s === "number" && s > 0);
      return n.length ? Math.min(...n) : 0;
    })(),
    coverage: {
      dealsGraded: (deals || []).length,
      dealsInMatch: dealsInMatch != null ? dealsInMatch : (deals || []).length,
      seat,
    },
  };
}

export { matchReport, KINDS, HEADLINE_KINDS };
