# Coach — design

Turn the search the hard AI already runs into something the player can use: a hint, a post-deal
review, a table-read panel, and — the same machinery pointed back at the bots — an auction that
actually thinks.

Status: design approved 2026-07-29. Implementation plan: `docs/superpowers/plans/2026-07-29-coach.md`.

## Why

`ai/pimc.js` is a working Perfect-Information Monte Carlo searcher, and today it does exactly one
job: pick a bot's card. Two consequences:

1. **The player gets nothing from it.** No hint, no post-mortem, no "why did that deal go wrong".
2. **The bots only half-use it.** `aiActionFor` (`ai/index.js:13-15`) routes `bid`, `trump` *and*
   `call` to `heuristic.js` at **every** difficulty. A hard bot plays a brilliant endgame after
   bidding by a linear hand-count with ±8 noise and a hardcoded `pts += 60`. Difficulty currently
   means "card play only".

## The load-bearing property

**The search never needs a hand it isn't entitled to see.** `determinize()` (`ai/pimc.js:20`) reads
only `G.hands[me]`, `G.playedCards`, `G.voids`, `G.calledCard`, `G.partner`, and the other seats'
hand *counts*. Every one of those is in the redacted per-viewer view (`src/core/room/view.js`) or is
derivable from `v.tricks` + `v.trick`.

So the coach runs **in the browser, from the redacted view, with no protocol change**. It cannot
cheat, because it is never given the information required to cheat. That is a structural property,
not a promise — and it is the reason the coach is client-side rather than a Durable Object feature.

Two corollaries the design leans on:

- **Teams are public during play.** `applyCall` sets `G.teamsRevealed = true` at call time, so the
  client holds `partner` and `calledCard` from the moment the call lands. The client's determinizer
  therefore gets exactly the same constraints the server's does — no weaker sampling.
- **A finished deal is fully public.** 13 tricks × 4 cards = all 52, each tagged with its player
  (D27). The client can reconstruct any past position exactly, which is what makes the review
  possible with no new server state.

## Architecture

```
app/js/core/engine/
  random.js          + mulberry32; shuffleFast(a, rnd)
  ai/heuristic.js    + rnd parameter on chooseAICard / aiBidDecision
  ai/pimc.js         + evaluateMoves(); choosePIMCCard becomes its argmax wrapper
  ai/bid-search.js   NEW — sampled auction: bid / trump / call
  ai/index.js        hard difficulty routes bid/trump/call to bid-search

app/js/coach/        NEW — browser-only, pure, no DOM
  shadow.js          redacted view -> a search-ready position
  read.js            table read (derivation only, no search)
  review.js          replay a finished deal's decision points
  worker.js          module-worker entry (guarded; exports {})
  client.js          main-thread facade: spawn, request/response, sync fallback

app/js/ui/
  coach.js           NEW — hint affordance, table-read block, review panel
```

`app/js/coach/` sits beside `ui/`, not inside `core/`: `core/` means "shared by the browser, the node
server and the Worker", and none of this ships to a server. It stays pure and DOM-free so
`test/client-modules.test.js` can import it and real tests can execute it.

### Why a Web Worker

A hint costs ~150 ms of search and a review costs ~1.5–2.5 s. Both would visibly stall the
turn-timer ring and the card animations on the main thread. The alternative — making the search
yield mid-rollout — trades message plumbing for reentrancy inside the one piece of code that is
currently a clean pure loop.

Rejected: computing hints in the Durable Object. It bills CPU per hint, dies in solo and offline,
and would force the DO — which holds all four hands — to redact *itself* before searching. That is
the single invariant this repo has been most careful about (D18, `test/room.test.js`'s redaction
property); it is not worth re-opening for a hint button.

**Node-importability constraint.** `test/client-modules.test.js:22` imports every `.js` under
`app/js` in Node. `worker.js` therefore registers its handler behind
`typeof self !== "undefined" && typeof window === "undefined"` and ends with `export {}` — which
that test's line 23 already permits.

**Fallback.** If `new Worker(url, { type: "module" })` throws (or `Worker` is absent), `client.js`
runs the same functions synchronously on the main thread at a reduced budget. The feature degrades
in responsiveness, never in availability.

## Interface contracts

### `core/engine/random.js`

```js
function mulberry32(seed)                  // -> () => float in [0,1); deterministic
function shuffleFast(a, rnd = Math.random) // unchanged when rnd is omitted
```

`randomInt` and `shuffle` (the CSPRNG path, D9a) are **not touched**. Deals stay cryptographically
seeded; only the AI's internal sampling becomes seedable.

### `core/engine/ai/heuristic.js`

```js
function chooseAICard(G, p, easy, rnd = Math.random)
function aiBidDecision(G, p, easy, rnd = Math.random)
```

Two call sites change (`heuristic.js:29` noise, `heuristic.js:90` tie-break). Defaults preserve
today's behaviour exactly.

### `core/engine/ai/pimc.js`

```js
function determinize(G, me, rnd = Math.random)

function evaluateMoves(G, me, opts) -> {
  moves: [{ card, winProb, meanPoints, samples }],   // one entry per legal card, in legalCards order
  determinizations,                                   // how many worlds were actually sampled
}
// opts: { determinizations = 24, playBudget = PIMC_PLAY_BUDGET, timeMs = 25, rnd = Math.random }

function choosePIMCCard(G, me, opts)   // unchanged signature and behaviour
```

- `winProb` — fraction of sampled worlds in which **my side wins the deal** (declaring side makes
  the bid if I am declaring; defenders set it if I am not).
- `meanPoints` — mean points captured by **my side** across sampled worlds.

**The refactor is provably behaviour-preserving.** Today's score is
`win * 1000 + margin` where `win = (iAmDeclaring === made)` and
`margin = iAmDeclaring ? dPts : TOTAL_POINTS - dPts` — i.e. `margin` *is* "points my side captured"
and `win` *is* "my side won the deal". Averaged, that is exactly
`winProb * 1000 + meanPoints`. `choosePIMCCard` becomes the argmax of that expression over
`evaluateMoves(...).moves`, keeping every existing early-out: `legal.length <= 1` returns the only
card, a `null` determinization falls back to `chooseAICard`, and the `d >= 4 && elapsed > timeMs`
secondary guard stays (a no-op on Workers, per M9).

### `core/engine/ai/bid-search.js` (new)

```js
const BID_PLAY_BUDGET = 6000;   // simulated card plays, not milliseconds (D3 discipline)

function auctionSamples(G, seat, opts) -> [{ hands, trumpBySuit }]  // K sampled worlds, reused
function bidValue(G, seat, opts)       -> { samples: number[], makeProb(target), median }
function aiBidDecisionSearch(G, seat, opts)  -> number | null
function aiPickTrumpSearch(G, seat, opts)    -> suit
function aiPickPartnerSearch(G, seat, opts)  -> card
```

Method, for a seat holding 13 known cards:

1. Sample **K worlds once** (`determinize` over the 39 unseen cards, no voids/called-card
   constraints exist yet at bid time) and reuse the same K worlds for every candidate. Common random
   numbers: the comparison between candidates is what matters, and shared worlds cut its variance
   far more cheaply than more samples would.
2. For each world, simulate the contract this seat would actually reach: name a trump, call a card,
   resolve the partner from that world's deal, play the deal out with the heuristic AI, and record
   the points **my side** captured.
3. `bidValue` returns the empirical distribution. `aiBidDecisionSearch` bids `minNextBid(G)` when
   `makeProb(minNextBid(G)) >= 0.5`, else passes — same incremental shape as today's bidder, a real
   probability instead of `pts += 60`.
4. `aiPickTrumpSearch` scores all four suits on the shared worlds; argmax of mean captured points.
5. `aiPickPartnerSearch` scores a **shortlist** — every unheld card of rank ≥ 12 (Q/K/A: at most 12
   candidates) plus `aiPickPartner`'s heuristic pick — on the shared worlds. `callableCards` returns
   up to 39 cards; searching all of them buys nothing, because nobody calls a seven.

Wall-clock is bounded the same way PIMC's is — in simulated card plays, because Workers freeze
`Date.now()` between I/O (M9). One full deal is ~52 plays, so `BID_PLAY_BUDGET = 6000` buys ~115
deal-simulations, split across candidates.

**Server cost.** Bid/trump/call search runs at most ~6 times per deal at 6000 plays ≈ 36k plays,
against a play phase that already spends up to 13 × 4 × 8000 ≈ 416k. Roughly a 9% increase in the
DO's per-deal search work, and only at `hard`.

### `core/engine/ai/index.js`

```js
if (ra.kind === "bid")   return { type: "bid",   value: hard ? aiBidDecisionSearch(G, seat) : aiBidDecision(G, seat, easy) };
if (ra.kind === "trump") return { type: "trump", suit:  hard ? aiPickTrumpSearch(G, seat)   : aiPickTrump(G, seat) };
if (ra.kind === "call")  return { type: "call",  card:  hard ? aiPickPartnerSearch(G, seat) : aiPickPartner(G, seat) };
```

`easy` and `normal` keep the heuristic auction — that is what the three tiers now mean, and it gives
`normal` a real identity instead of "hard, but worse at cards".

### `coach/shadow.js`

```js
function shadowFromView(v) -> G | null   // null when the view has no hand (spectator / pre-deal)
```

Builds a search-ready position from a redacted view:

- `hands[seat] = v.you.hand.slice()`; every other seat is a placeholder array of length
  `v.handCounts[s]` — `determinize` reads only `.length` for those seats, and `choosePIMCCard`
  overwrites them wholesale before any rollout.
- `playedCards` = every card in `v.tricks`, in order, then `v.trick`.
- `voids[p][suit] = true` when `p` played off-suit to a trick whose lead was `suit`. Derived from
  `t.cards[0].card.suit` for completed tricks and `v.leadSuit` for the in-flight one — which
  excludes the leader exactly as `applyPlay`'s `G.trick.length > 0` guard does.
- Everything else copies straight across from the public view.

**Correctness test (the crux):** over randomly simulated deals, `shadowFromView(buildView(room, pid,
now)).playedCards` and `.voids` must equal the server's `room.G.playedCards` / `room.G.voids`
exactly, at every position. If that holds, the client's search sees precisely the public facts the
server's does, and nothing else.

### `coach/read.js`

```js
function tableRead(v) -> {
  pointsLive,                       // 250 minus every point already captured
  captured: { mine, theirs },
  needed,                           // bid minus the declaring side's captured points, or null
  bonus: { suit, fallen, takenBy },
  voids: [{ seat, suits: [] }],
  outstanding: { "♠": { count, top }, ... },   // cards of each suit neither played nor in my hand
  trumpLeft,
}
```

Pure derivation from public state — no search. `rails.js:36` already has `bonusTakenBy`; it moves
here and the rail imports it, rather than a second copy.

### `coach/review.js`

```js
const BLUNDER_WIN_DELTA = 0.15;   // >= 15 points of win probability
const MISTAKE_WIN_DELTA = 0.07;

function reviewDeal(v, seat, opts) -> {
  decisions: [{ trickNo, played, best, playedWinProb, bestWinProb, delta, grade }],
  worst: [ ...up to 2 decisions, by delta ],
  bid: { yourAction, searchValue, comment } | null,
  samples,                          // determinizations actually afforded, for an honest caveat
}
```

Walks the finished deal from `v.tricks` and, at each position where `seat` had a choice, rebuilds
**the information set as it stood at that moment** — my hand then, the cards played then, the voids
known then — and runs `evaluateMoves` on it with a `mulberry32` seeded from the deal.

This judges **the decision, not the outcome**. The reconstruction is used only to recover what the
player themselves knew; it deliberately never feeds the search a card the player could not see, so
the review cannot scold someone for a correct play that lost to a hidden queen. Seeding from the
deal means reopening the review prints the same numbers — which is the entire reason the RNG
refactor is in scope.

Positions with one legal card are skipped (no decision was made). Budget: a total simulated-play
cap, divided across the decision points, degrading `determinizations` rather than running long;
`samples` is reported so the UI can caveat a thin search.

### `coach/client.js` / `coach/worker.js`

```js
// client.js
function requestHint(view)   -> Promise<{ moves, best, kind }>
function requestReview(view, seat) -> Promise<ReviewResult>
function coachAvailable()    -> boolean
```

One long-lived worker, lazily spawned on first use. Request/response correlated by an incrementing
`id`; the whole view is structured-cloned across (a few KB — not worth a bespoke wire format).
Worker protocol: `{ id, kind: "hint" | "review", view, seat }` →
`{ id, ok: true, result } | { id, ok: false, error }`. On worker construction failure, both
functions run the same code synchronously at a reduced budget.

### Room setting: `coach`

```js
settings: { difficulty: "normal", targetDeals: 5, turnTimerSec: 45, coach: true }
```

Host-controlled, changeable any time (like `difficulty`), surfaced in the lobby settings panel and
in `v.settings.coach`. When false, the client hides the hint affordance.

**This is a table agreement, not an enforcement boundary, and the design says so out loud.** The
engine is served to the browser; anyone with a devtools console can run the search regardless. What
the setting buys is that a table can *agree* to play without hints and can *see* that it has —
which is the honest version of what a client-side hint can offer. Pretending otherwise would mean
moving the search server-side, which we rejected above for better reasons.

The **table-read panel is not gated** by it: every number in it is public information the player
watched happen, and hiding a scoreboard behind a competitive setting would be theatre. It gets a
local show/hide preference like the 4-colour deck.

## User-facing behaviour

**Hint.** A button in the header tool row beside `#btn-sound`, enabled only when `v.you.toAct` and
`v.settings.coach !== false`. It marks the recommended card in your hand and prints one line of
justification — *"♠7 — holds the contract in 68% of sampled deals"*. During the auction the same
button gives the bid advisor — *"worth about 165 · you make 130 in 92%"* — and during
trump/partner selection it recommends the suit or the call. Never auto-fires; always one click.

**Table read.** A block in the left rail under "tricks you won", and appended to the **Score** tab
of the mobile bottom sheet rather than adding a fourth tab (three tabs already fill the width at
360px).

**Review.** A `Review this deal ▸` button on the existing round-result modal (`showRoundResult`,
`modals.js:119`). Opens as a second view inside the same overlay with a back button, computed
lazily on click. **The ready button stays reachable the whole time** — a review that blocks the ready
gate would stall three other people, and the 30 s fallback would fire under them.

**Solo.** Everything above works identically and offline; `solo.js` passes a view through the same
shared renderers (D25), and the service worker precaches `app/js/coach/*` automatically because
`scripts/build-assets.js` walks `app/`.

## Testing

| Area | Assertion |
|---|---|
| RNG refactor | `mulberry32(s)` reproduces its stream; `shuffleFast(a)` with no `rnd` is unchanged; two seeded searches on one position return identical results |
| `evaluateMoves` | one entry per legal card; `choosePIMCCard` equals argmax of `winProb*1000+meanPoints` on the same seed — the behaviour-preservation claim, asserted, not asserted-in-prose |
| `shadow.js` | over simulated deals, derived `playedCards`/`voids` equal the server's exactly; no placeholder `null` ever reaches a rollout |
| `read.js` | `pointsLive` + captured = 250 at every position; `bonus.fallen` agrees with the trick history |
| `review.js` | seeded review is byte-identical across two runs; a deliberately terrible play grades worse than the search's pick; single-legal-card positions produce no decision |
| `bid-search.js` | returns legal bids/trumps/calls; stays inside `BID_PLAY_BUDGET`; searching bots beat heuristic bots over N seeded matches |
| AI strength | `test/ai.test.js`'s head-to-head becomes **deterministic** under a seed instead of tolerance-checked; hard-with-search-auction does not regress against today's hard |
| Protocol | `test/client.test.js` pins `coach` in the settings vocabulary; host-only and boolean-validated in `room.test.js` |
| Modules | every new file under `app/js` imports cleanly in Node (`client-modules.test.js`), including the worker entry |

## Decision log

- **C1. The coach runs client-side, from the redacted view.** It is structurally unable to cheat,
  costs the DO nothing, and works offline. Rejected: a DO-side coach — billed CPU per hint, no solo,
  and it would have to redact itself before searching.
- **C2. One evaluator, two consumers.** `evaluateMoves` is factored out of `choosePIMCCard` so bots
  and coach share an implementation. Rejected: a separate coach evaluator — two searchers that
  disagree about the same position is a bug generator, and the bot's search is the one that has been
  tuned.
- **C3. A seeded RNG is threaded through the search** (`rnd` parameter, defaulting to `Math.random`).
  Bought for review reproducibility; it also converts `test/ai.test.js`'s tolerance-checked
  head-to-head into an exact assertion. Rejected: accepting a review whose numbers drift between
  openings — a coach that contradicts itself on refresh is not believed.
- **C4. The deal RNG is untouched.** Only AI-internal sampling becomes seedable; `randomInt`/`shuffle`
  keep the CSPRNG (D9a). Rejected: one seedable RNG for everything — that is exactly the shared
  stream D9a was written to eliminate.
- **C5. The review judges the decision, not the outcome.** Each position is re-searched from the
  player's information set at that moment, never from the reconstructed full deal. Rejected:
  hindsight analysis — cheaper and much easier to build, but it flags correct plays as blunders
  whenever the cards were unkind, which is precisely the advice that teaches people wrong.
- **C6. `coach` is a host setting defaulting to on, and it is signalling rather than enforcement.**
  Documented as such. Rejected: silently pretending it is enforced; rejected: no setting at all,
  which leaves a table unable to agree to play clean.
- **C7. The table-read panel is ungated public information.** Rejected: hiding it behind the coach
  setting — every number in it is something the player watched happen at the table.
- **C8. Bid/trump/call search is `hard`-only.** Gives the three difficulty tiers a real meaning
  beyond card play, and keeps the added DO cost on the tier that opts into it.
- **C9. Common random numbers in the auction search.** Candidates are compared on one shared set of
  sampled worlds. Rejected: independent sampling per candidate — same cost, strictly more variance
  in exactly the comparison the decision turns on.
- **C10. The review opens on demand from the round-result modal, never automatically.** Rejected:
  auto-opening — it would sit on top of the ready gate that three other players are waiting on.
