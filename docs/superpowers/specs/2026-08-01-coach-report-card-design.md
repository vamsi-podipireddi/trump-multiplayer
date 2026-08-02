# Coach report card — design

A match-level debrief built on M10's search: aggregate every decision you made across a match —
card play, bid, trump and call — into one graded report on the match-over modal, and fix the
per-deal record the D1 stats table was supposed to hold all along.

Companion to `2026-07-29-coach-design.md`, which this extends rather than replaces. Decisions here
continue the ROADMAP's numbering from D37 and are written to be pasted into it.

## The problem

Three separate gaps, one feature:

1. **`reviewDeal` grades one deal and then forgets it.** It returns `{decisions, worst, samples}`
   per deal per seat, and nothing aggregates across a match. The most useful question a player has
   after a match — *am I getting better, and at what?* — has no answer.
2. **The auction is ungraded.** `reviewDeal` walks tricks only. The bid, trump pick and partner call
   are never judged, even though `ai/bid-search.js` already searches all three for the hint.
3. **"Your record" measures something other than what it says.** `writeMatchStats`
   (`src/worker/stats.js`) derives `was_declarer` and `bid_made` from `G.lastResult` — *the final
   deal only*. The join screen presents the sums as career `bidsWon` / `bidsMade`. A player who won
   four bids and made all four, then lost the fifth deal, records `bidsWon: 0`.

## Scope

**In.** Engine deal/auction history; grading all four decision types in one unit; a match-level
aggregate; the match-over report card; the stats fix and its schema migration; re-measurement of the
trump/call search objective.

**Out.** The join screen's career trend is designed for (metric stability, `match_id`, the columns)
but shipped last and separably — Milestone 10. No new server-side search. No change to what the bots
play: `aiPickTrump`/`aiPickPartner` (the hand-count) remain every tier's trump and call, per D35.

## Decisions

- **D38. The report card is a client-side aggregate over a server-side deal record.** The cheap,
  public half — which side won each deal, at what contract, made or set — lives in the engine and
  arrives in the view, so it survives refresh, reconnect, a phone takeover and spectating. The
  expensive half — graded decisions — is computed in the browser from locally retained deal
  snapshots, per D28 (the coach costs the Durable Object nothing).
  Rejected: computing the report in the DO — it breaks D28 and would add ~170 ms of CPU per player
  per match to an object whose entire cost model (D35) rests on the worst *single* invocation being
  3.3–8.1 ms.
  Rejected: keeping the deal record only in `src/core/room/` — solo would get nothing, the contract
  half would die with the browser tab alongside the graded half, and the room would re-derive at
  `endRound` what the engine already knows there.

- **D39. Two new public engine fields, `G.auction` and `G.dealHistory`.** Both follow D27's rule that
  history belongs in the engine: a client that reconstructs the auction by parsing `G.log` is a
  client that breaks the next time the wording changes.
  `applyBid` deliberately does not write a pass to `G.bids` (it filters `bidActive` instead), and
  `advanceBidding` loops until only the high bidder remains — so `bids[]` holds each seat's *latest*
  bid and the auction sequence is genuinely unrecoverable from the view. `G.auction` is not
  convenience; it is the only way to know which target a bidder faced at their turn.
  Neither field adds redaction surface: every bid is announced aloud, and `dealHistory` carries only
  what the round-result modal already shows.

- **D40. `G.matchId`.** Minted in `createMatch` from `randomInt` (the CSPRNG — same stream the deal
  uses; there is nothing here to protect, but there is also no reason to introduce a second source).
  It earns its place twice: it keys the client's deal snapshots, so a rematch in the same room cannot
  read the previous match's deals, and it closes a second gap in the stats table, which today has no
  way to tell that four rows came from one match.

- **D41. One unit for all four decision types: probability the declaring side makes the contract.**
  `evaluateMoves` already reports card play in exactly this unit (`winProb`), and
  `bidValue().makeProb(t)` is the same quantity for a bid. Trump and call are re-ranked onto it
  (D42). The payoff: `BLUNDER_WIN_DELTA` (0.15) and `MISTAKE_WIN_DELTA` (0.07) apply table-wide, one
  fine/mistake/blunder vocabulary covers the whole card, and the headline number is coherent instead
  of being a mean over three incommensurable scales.
  Rejected: grading trump/call in their own unit (mean captured points) on a separate advisory line —
  honest, but it leaves the card with a section users must convert in their heads, and it preserves
  the objective D35 concluded was the wrong one.

- **D42. Trump and call are re-ranked by make-probability, inside `ai/bid-search.js`.** They rank by
  mean captured points today, which is precisely the objective D35 retired: *"a deal is scored made
  or set — a binary — so points captured beyond the contract line buy nothing… points per deal was
  the wrong objective to have designed against; deals won is the scoring unit."*
  This is safe to change in one place because these two functions have exactly one caller. D35 cut
  them from the server; `ai/index.js` routes only the bid, and `app/js/coach/worker.js` is their sole
  consumer (stated at `ai/bid-search.js:69`). So the hint and the review inherit one implementation
  and cannot disagree — the "two spellings of one rule" failure `coach/review.js:203` warns about
  never arises.
  Bots are unaffected: they call `aiPickTrump`/`aiPickPartner`, not these.
  **Obligation, not a footnote:** every tuned number attached to these two functions was measured
  under the points objective — D36's regret figures (trump 0.48 vs the heuristic's 2.96; call 1.06 vs
  3.65) and its hold-out (+2.47 ± 0.95 and +2.60 ± 0.87 points/deal), and the
  `TRUMP_PLAY_BUDGET`/`CALL_PLAY_BUDGET` of 24,000 those rest on. Re-ranking makes them stale.
  `scripts/bench-auction-search.js` exists to re-derive exactly these; Milestone 3 re-runs it and
  D36 gets measured replacements in the ROADMAP's own "CORRECTED, measured" style. This project has a
  standing rule against re-arguing a number that can be re-measured.

- **D43. A decision is graded only outside a dead band derived from its own sampling error.**
  A make-probability is a binomial proportion over `worlds` sampled deals, so its standard error is
  `√(0.25/worlds)` and a two-SE band is `2·√(0.25/worlds)` = **`1/√worlds`**. Inside that band the
  search cannot tell the candidates apart, and grading anyway would assert precision the sampler does
  not have. For the bid there is a second reason: D35's own counterfactual measured the marginal bid
  at **−0.35 ± 1.40 pp**, leaving the 0.50 and 0.55 thresholds statistically indistinguishable — the
  line itself is not known sharply enough to call a near-miss a blunder.
  Common random numbers (D36) make the trump/call comparisons paired, so the variance of the
  *difference* is below the unpaired binomial SE and the band is conservative there. Conservative is
  the right direction for a grader.
  Band decisions grade **`fine`**, they are not skipped. They were real decisions that were not
  errors; dropping them from the denominator would silently inflate the score.

- **D44. The review sizes its budget from the precision it needs, inverting the bots' rule.**
  `worldsFor(candidates, budget) = max(4, floor(budget / (candidates·52)))` runs budget → worlds,
  which is right for a bot deciding under a per-invocation CPU bill. A grader has the opposite
  constraint, and inheriting the bots' budgets breaks it outright: at `CALL_PLAY_BUDGET = 24000` with
  ~10 candidates, `worldsFor` yields 46 worlds and a band of `1/√46` = **0.147** — wider than
  `MISTAKE_WIN_DELTA` (0.07) by more than double, and effectively at `BLUNDER_WIN_DELTA` (0.15). The
  mistake grade for calls would be unreachable: any delta large enough to escape the band is already
  a blunder.
  So the review inverts it. The band must clear the finest grade it has to express:

      1/√worlds ≤ MISTAKE_WIN_DELTA   →   worlds ≥ 1 / MISTAKE_WIN_DELTA²

      MIN_REVIEW_WORLDS = Math.ceil(1 / MISTAKE_WIN_DELTA ** 2)     // 205
      auctionBudgetFor(candidates) = MIN_REVIEW_WORLDS * candidates * 52

  Derived, not chosen: change `MISTAKE_WIN_DELTA` and the world count follows. Bounded by
  construction — the call's candidate list is at most 13 (12 honours plus the heuristic), so the
  widest question costs `205 · 13 · 52` = 138,580 simulated plays.
  Rejected: a fixed `REVIEW_AUCTION_BUDGET` split across a deal's auction decisions, mirroring
  `REVIEW_PLAY_BUDGET` — it reintroduces exactly the fault D36 found in the single shared budget,
  where precision falls as the candidate list grows and the argmax ends up ranking its own noise.

- **D45. The card prints its own coverage and never presents a partial mean as a whole one.**
  Snapshots are device-local (D46), so a second device, private browsing, a storage quota or joining
  mid-match all yield an incomplete graded half. The card reads *"graded 4 of 5 deals"* in every
  case, including the complete one. Same discipline as `coach/worker.js:115`'s honest refusal rather
  than a review of a partial deal.

- **D46. Deal snapshots are client-side, in `localStorage`, keyed by room and `matchId`.**
  Zero server cost and no protocol change; survives a refresh or a reconnect on the same device.
  Accepted cost: a different device cannot grade deals it did not play, which D45 makes visible
  rather than silent.
  Rejected: shipping every finished deal back in the view — complete and device-independent, but it
  puts the whole match's tricks on the wire and into DO storage for a feature only the owning player
  reads.
  Rejected: in-memory only — a refresh mid-match is common enough (and a PWA tab eviction likelier
  still) that the graded half would be missing more often than present.

## Interface contracts

### Engine (`app/js/core/engine/`)

```js
// match.js — createMatch() sets the shape, startMatch() resets it: exactly the
// pattern `scores` already follows (createMatch's [0,0,0,0] and startMatch's
// G.scores = [0,0,0,0]). startMatch is the "a match begins" function and is
// exported, so a caller reusing a G must not inherit the last match's history.
G.matchId: string            // 8 hex chars from randomInt; stable for the life of the match
G.dealHistory: []            // persists across deals, dies with the match

// match.js — deal()
G.auction = []               // reset every deal, so a redealt auction correctly vanishes

// bidding.js — applyBid(G, p, value), appended before advanceBidding()
G.auction.push({ seat: p, value })          // value: number | null (null = pass)

// bidding.js — forceBid(G), appended so a forced minimum is distinguishable from a chosen one
G.auction.push({ seat: eldest, value: MIN_BID, forced: true })

// match.js — endRound(G), appended after winners are computed
G.dealHistory.push({
  roundNumber, declarer, partner, bid, made,
  dPts,                      // declaring side's captured points
  winners,                   // seats that took the deal (copy, not alias)
})

// match.js — publicView(G)
matchId, auction, dealHistory              // all three published verbatim
```

`publicView` copies `auction` and `dealHistory` out rather than aliasing, for the reason
`match.js:74` already gives about `tricks`: a viewer must never hold a reference into `G`.

### `ai/bid-search.js` — the D42 refactor

Mirrors D29 exactly (`evaluateMoves` factored out of `choosePIMCCard`, which became its argmax
wrapper). Per-candidate scores stop being discarded inside `argmaxCandidate`:

```js
// New, exported. `worlds` is the shared CRN sample set (D36) — one set per question.
evaluateTrumps(G, seat, opts) -> {
  candidates: [{ suit, makeProb, meanPoints }],   // heuristic's own pick first, so ties leave it standing
  worlds: number,                                 // sample count actually achieved
} | null

evaluateCalls(G, seat, opts) -> {
  candidates: [{ card, makeProb, meanPoints }],
  worlds: number,
} | null

// Both become argmax wrappers over the above, ranking on makeProb (D42).
aiPickTrumpSearch(G, seat, opts)   -> suit
aiPickPartnerSearch(G, seat, opts) -> card | null
```

`makeProb` for a candidate is the fraction of shared worlds in which `playOutWith` returns at least
`G.bid`. `playOutWith` already returns per-world captured points, so both statistics come from one
pass — `meanPoints` is retained because the bench reports in it and D36's history is written in it.

`argmaxCandidate`'s tie rule is preserved verbatim: the heuristic's own answer is scored first and
only a strictly better estimate displaces it.

### `app/js/coach/auction.js` — new, sibling of `review.js`

```js
reviewAuction(v, seat, opts) -> {
  decisions: [{
    kind: "bid" | "trump" | "call",
    roundNumber,
    played,            // number | null for a bid (null = pass); suit for trump; card for call
    best,              // the same shape — what the search would have chosen
    playedProb, bestProb,
    delta,             // max(0, bestProb - playedProb), or the bid's distance past the band
    band,              // 1/√worlds for this decision
    grade,             // "fine" | "mistake" | "blunder"
    worlds,
  }],
  skipped: [{ kind, roundNumber, reason }],   // "forced" | "not-declarer" | "no-world"
}
```

`opts.seed` defaults to `review.js`'s `seedFromDeal(v)` — the same deal-derived seed, so reopening a
report prints the same numbers (D30's whole purpose). `opts._tap(pos, kind, roundNumber)` mirrors
`reviewDeal`'s tap and is what makes D32 checkable against real positions rather than trusted.

**Position reconstruction — the D32 discipline, and the specific trap.** `bidValue` reads
`G.trump || aiPickTrump(...)` and `G.calledCard || aiPickPartner(...)`. A position rebuilt from a
*finished* deal's view has `v.trump` and `v.calledCard` filled in, so a naive reconstruction would
grade your bid using the trump you had not yet picked. Every auction position therefore sets:

| field | bid position | trump position | call position |
|---|---|---|---|
| `phase` | `"bidding"` | `"trumpSelect"` | `"partnerSelect"` |
| `trump` | `null` | `null` | `v.trump` (known by then) |
| `calledCard` | `null` | `null` | `null` |
| `partner` | `null` | `null` | `null` |
| `teamsRevealed` | `false` | `false` | `false` |
| `bid` | `null` | `v.bid` | `v.bid` |
| `highBid` | from the `auction` prefix | `v.bid` | `v.bid` |
| `hands[seat]` | `startingHand(v.tricks, seat)` — all 13 | same | same |
| `hands[other]` | `new Array(13).fill(null)` | same | same |
| `scores` | `preRoundScores(v)` | same | same |
| `playedCards`, `voids`, `tricks` | empty | empty | empty |

`startingHand` and `preRoundScores` are imported from `review.js`, not restated — both are
module-private today, so Milestone 4 adds them to its export list alongside the existing four names.

### `app/js/coach/report.js` — new, pure, no search

```js
matchReport(deals, seat, dealsInMatch) -> {
  headline,                  // mean delta over play/trump/call ONLY — the commensurable
                              // three (D41); null when none of them were graded, even if
                              // counts/byKind.bid are nonzero. The bid shares the
                              // fine/mistake/blunder thresholds (ordinal comparability)
                              // but is excluded from this mean: its delta measures
                              // distance from the search's own 0.5 line, not forgone win
                              // probability, so averaging it in would average two
                              // different quantities into a third that is neither (see
                              // Grading rules, below — cardinal commensurability is a
                              // stronger requirement than the shared threshold implies).
  counts: { fine, mistake, blunder },     // unified across all four kinds, bid included
  byKind: { play, bid, trump, call },     // each { n, meanDelta, blunders }
  worst: [decision, decision],            // top 2 by delta, play/trump/call only — same
                                           // split as headline, for the same reason
  worstBid: [decision, decision],         // the bid's own costliest, kept in its own list
                                           // rather than ranked against the other three
  coverage: { dealsGraded, dealsInMatch, seat },
}
```

`deals` is an array of `{ roundNumber, decisions }` per finished deal — the concatenation of
`reviewDeal` and `reviewAuction` output for that snapshot. `dealsInMatch` is a third argument rather
than derived from `deals.length`, because `coverage.dealsInMatch` is exactly the number a partial or
missing set of snapshots cannot answer for itself. `matchReport` runs no search and touches no storage,
so it is directly unit-testable over synthetic decisions.

**Headline is a mean, not a sum.** Sums are not comparable across 3-, 5- and 7-deal matches, and the
metric has to survive into a career trend. It is invariant to match length; it is *not* invariant to
bot difficulty or to how often you declared, which is why a career view must slice by difficulty
rather than pool (recorded on the card itself, and the reason `matches` gains no pooled lifetime
average in this milestone).

### `app/js/util/deals.js` — new, snapshot storage

```js
snapshotOf(v) -> {}          // the projection reviewDeal + reviewAuction read, nothing more
saveDeal(room, matchId, snapshot) -> void
loadDeals(room, matchId) -> [snapshot]
```

Key: `trump_deals:<room>:<matchId>`. Written at `roundEnd`. On write, evict other `matchId` keys for
that room and cap retained matches at 3 by stored timestamp. Every access is wrapped exactly as
`util/prefs.js` wraps its own — *"storage is a privilege, not a guarantee"* — so `QuotaExceededError`
and Safari private mode degrade to in-memory and can never stop a render. No `localStorage` reference
at module top level (STRUCTURE.md rule 5).

`snapshotOf` projects only: `tricks`, `auction`, `trump`, `calledCard`, `declarer`, `partner`, `bid`,
`bonusSuit`, `dealer`, `roundNumber`, `names`, `scores`, `lastResult`, `teamsRevealed`, and
`consts.TARGET_GAMES`. ~2–3 KB per deal; ~20 KB for a seven-deal match.

### `app/js/ui/coach.js` — presentation

Follows the file's existing pure-describe / render pair, both directly executable in tests:

```js
describeReport(report, v, seat) -> {}    // pure: the numbers turned into wording
renderReport(report, v, seat) -> string  // the panel's HTML
```

Attaches to the match-over modal as a third sibling in the body/action split Task 14 established
(`matchAction` / `matchReviewOpen` in `ui/modals.js`) — next to, never replacing, the rematch button,
per D37. Computed on click, never automatically.

## Data flow

```
roundEnd   ─ client ─ snapshotOf(view) ─→ localStorage  (trump_deals:<room>:<matchId>)
           └ server ─ endRound() pushes G.dealHistory ─→ publicView ─→ every viewer

matchOver  ─ click "Report card"
             ├ contract half  ← v.dealHistory            (always present)
             └ graded half    ← loadDeals(room, matchId)
                                  └ per snapshot, in the existing coach worker:
                                       reviewDeal(snapshot, seat)      → play decisions
                                       reviewAuction(snapshot, seat)   → bid/trump/call decisions
                                  → matchReport(...) → describeReport → renderReport

matchOver  ─ server ─ writeMatchStats folds G.dealHistory ─→ D1
```

## Grading rules

**Delta is always the raw probability difference; the band decides only whether the decision is
graded at all.** Subtracting the band from the delta would make the same mistake read as different
sizes at different sample counts, which is the opposite of what D43 is for.

| type | graded when | delta |
|---|---|---|
| card play | `legalCards(pos, seat).length > 1` | `max(0, bestWinProb − playedWinProb)` (unchanged) |
| bid | you were the actor, the bid was not `forced`, and `delta > band` | one-sided: `max(0, p − 0.5)` if you passed, `max(0, 0.5 − p)` if you bid |
| trump | you were declarer, and `bestProb − yoursProb > band` | `max(0, bestProb − yoursProb)` |
| call | you were declarer, and `bestProb − yoursProb > band` | `max(0, bestProb − yoursProb)` |

The bid's delta is **one-sided by construction**: being far from the line on the *correct* side is not
an error, so a pass on a hand the search gives a 0.1 make-probability scores 0, not 0.4. Only the
wrong side of the line accumulates.

**What the bid's delta is, and is not.** It is in the same unit as the other three — a probability —
but it measures *distance from the decision boundary*, not forgone win probability. Those coincide
for card play, trump and call, where "best" and "what you did" are two candidates scored on one
shared world set. They do not for the bid: passing does not end the deal, it hands the auction to
somebody else, so the true counterfactual requires simulating an auction that continues without you.
D35's `counterfactual` section is exactly that exercise, and it is a measurement project in its own
right. The card must therefore word the bid row as *how far the search says the call was from the
line*, never as points or contracts given away — and `byKind.bid`'s mean is not interchangeable with
the other three even though it shares their scale.

**Jump bids.** `bidIsLegal` admits any value ≥ `minNextBid`, but the bot only ever considers `need`.
The decision space is therefore `{pass} ∪ {need, need+5, …}`, and a bid of V is graded against
`makeProb(V)` — an overbid two steps beyond the hand registers as the error it is, rather than being
scored as though the minimum had been bid.

**Never graded, and excluded from the denominator:** forced plays (`legalCards ≤ 1`, already skipped
by `reviewDeal`); the `forceBid` minimum after five passes; trump and call when you were not
declarer; deals you were not seated for; and positions where the sampler built no consistent world
(`reviewDeal` already skips rather than fabricating a grade). Redealt auctions vanish with `G.auction`
and are not graded — they were unanimous passes on hands nobody wanted.

## Stats (③) and migration

`writeMatchStats` folds `G.dealHistory` instead of reading `G.lastResult`:

```sql
ALTER TABLE matches ADD COLUMN match_id  TEXT;
ALTER TABLE matches ADD COLUMN deals     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN bids_won  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN bids_made INTEGER NOT NULL DEFAULT 0;
```

`was_declarer` and `bid_made` stop being written and are marked deprecated in `schema.sql`, with a
note that pre-migration rows carry final-deal-only semantics. `readStats` sums the new columns under
`COALESCE(…, 0)`, so historical rows keep contributing their still-correct `games` and `wins` and
contribute zero — rather than a wrong number — to the bid counters. `won` is unchanged.

The feature is opt-in; a deployment with no `DB` binding is unaffected, and `readStats` still answers
`{available:false}`.

## Testing

Acceptance criteria, in the repo's three existing kinds. Each is a property or an exact assertion,
not a smoke test.

**Engine (`test/engine.test.js`)**
1. Folding `G.auction` left-to-right reproduces the `highBid`/`highBidder` that `finalizeDeclarer`
   set, on every deal of every simulated match.
2. `G.dealHistory.length` equals the number of completed deals at every `roundEnd`/`matchOver`.
3. For every entry, `dPts === capturedPoints[declarer] + capturedPoints[partner]` as of that deal,
   and `made === (dPts >= bid)`.
4. `deal()` leaves `G.auction` empty, so a redeal discards the passed-out auction.
5. A `forceBid` auction's last entry carries `forced: true`; no chosen bid does.
6. `G.matchId` is stable across every deal of a match and differs across a rematch.
7. `publicView` still has no `hands` key, and its `auction`/`dealHistory` are copies — mutating them
   does not touch `G`.

**Coach (`test/coach.test.js`)**
8. **D32 as an executable check:** `_tap` over every position `reviewAuction` builds asserts
   `trump`/`calledCard`/`partner` are null where the table above says null, `teamsRevealed` is false,
   `playedCards` is empty, and the position's `highBid` matches the auction prefix — never a later
   bid, and never the final contract.
9. Re-running `reviewAuction` on the same snapshot returns identical grades (the `seedFromDeal`
   default, as `reviewDeal` is already tested for).
10. `evaluateTrumps(...)` ranked by `makeProb` has `aiPickTrumpSearch(...)` as its argmax, and
    likewise for calls — the D29 wrapper property, so the hint and the review cannot diverge.
11. Dead band: a synthetic candidate set whose spread is inside `1/√worlds` grades `fine` on both
    sides of the line; one outside it grades by the shared thresholds.
12. `MIN_REVIEW_WORLDS` actually delivers a band below `MISTAKE_WIN_DELTA` for the widest candidate
    list (13 calls), asserted against `worldsFor`'s own formula rather than a pasted number.
13. A bid of V > `need` is graded against `makeProb(V)`, not `makeProb(need)`.

**Aggregation (`test/coach.test.js`)**
14. `matchReport` denominators exclude skipped decisions and include band decisions; `worst`
    (play/trump/call, top 2 by delta) and `worstBid` (the bid's own top 2) are ranked separately and
    never merged into one list.
15. `headline` is invariant to match length for the same per-decision distribution, and `null` — not
    `0` — when nothing commensurable was graded (a match of bid-only decisions has a null headline
    even though `counts` and `byKind.bid` are nonzero).
16. `coverage` reports `dealsGraded < dealsInMatch` when snapshots are missing.

**Adapter (`test/worker.test.js`)**
17. `writeMatchStats` over a match with a known `dealHistory` writes the correct `deals`,
    `bids_won`, `bids_made` per seat, and one shared `match_id`.
18. `readStats` over a mix of legacy and migrated rows sums `games`/`wins` across both and bid
    counters only across migrated ones.

**Client**
19. `test/client-modules.test.js` covers the three new modules automatically (relative imports, no
    top-level DOM). `npm run build:assets` must be re-run — `test/pwa.test.js` fails a stale precache.

## Milestones

Each is one commit, PR-sized, in order.

1. **Engine history.** `G.auction`, `G.dealHistory`, `G.matchId`; `publicView` publishes all three.
   Tests 1–7. No consumer yet.
2. **`bid-search` refactor + re-rank (D42).** `evaluateTrumps`/`evaluateCalls` factored out;
   `aiPickTrumpSearch`/`aiPickPartnerSearch` become argmax wrappers on `makeProb`. Test 10.
3. **Re-measurement (D42's obligation).** Re-run `scripts/bench-auction-search.js`; re-derive
   trump/call regret under the new objective and re-check the 24,000 budgets. Rewrite D36's numbers
   with measured replacements. No code change unless the bench says so.
4. **`coach/auction.js`.** Position reconstruction and the three graders. Tests 8, 9, 11, 12, 13.
5. **`coach/report.js`.** Pure aggregation. Tests 14–16.
6. **Snapshot storage.** `util/deals.js`; write at `roundEnd`. Quota and private-mode degradation.
7. **The card.** `describeReport`/`renderReport`; the match-over sibling; worker wiring for a
   multi-deal request. `npm run build:assets`.
8. **Stats fix (③).** `writeMatchStats` folds `dealHistory`; schema migration; `readStats`. Tests
   17–18.
9. **Docs.** README, `docs/STRUCTURE.md` file table, ROADMAP M11 + D38–D46.
10. **Career trend** (separable). Join-screen line sliced by difficulty, off the new columns.

## Cost

Card play is unchanged at `REVIEW_PLAY_BUDGET` = 104,000 plays per deal. The auction adds
`205 · candidates · 52` per question: 10,660 per bidding turn (every deal, for every seat that bid),
42,640 for trump and up to 138,580 for the call (only for the seat that declared).

A five-deal match in which you declared twice: 520,000 for card play, ~128,000 for roughly a dozen
bidding turns, and 362,440 for two trump-and-call pairs — about **1.0 M simulated plays**. At the
bench's measured ~3,100 plays per millisecond that is ~330 ms of worker CPU on desktop and a few
seconds on a phone, behind an explicit click, off the main thread, with the panel showing progress.
Nothing here runs on the server.
