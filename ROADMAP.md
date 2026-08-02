# Next-Level Roadmap — implementation tracker

Working branch: `feat/next-level`. Each milestone = one commit. Check items off as completed.
This file is the source of truth for the in-progress upgrade; resume from the first unchecked item.

## Design decisions (fixed — do not re-litigate)

- **D1. Shared room core**: all room logic (join/seats/host/settings/timers/messages/views) lives in
  `room.js` as a pure state machine: functions take `(room, ...) -> effects`, no I/O, no timers, no sockets.
  Adapters (`server.js` node/ws, `src/worker.js` DO) execute effects.
  - Effects shape: `{ broadcast?: true, sends?: [{pid, obj}], closes?: [pid], deleteRoom?: true }`.
    Timers are NOT effects: after every event the adapter calls `nextTimer(room, now)` →
    `{due, kind} | null` and arms exactly ONE timer/alarm for the min due. On fire it calls
    `fireTimers(room, now) -> effects` which handles every due timer and reschedules.
    Room state keeps `timers: [{kind, due, data?}]` (serializable).
  - `room` state is 100% JSON-serializable: `{ code, G, started, difficulty, settings, seatOwner[4],
    players: {pid: {name, seat, connected, away, ready}}, host, chat: [{from,text,ts}] (ring 50),
    timers: [] }`. No ws refs in core.
- **D2. Cloudflare backend uses WebSocket Hibernation API** (`state.acceptWebSocket`, `webSocketMessage/Close/Error`
  handlers, `serializeAttachment({pid})`) + **DO alarms** (single `storage.setAlarm` armed to min timer due)
  + **persistence**: room state JSON at `storage.put('room', state)` after every mutating event; restored in
  constructor via `blockConcurrencyWhile`. `connected` reconciled from live sockets on restore.
- **D3. Difficulty levels**: `"easy" | "normal" | "hard"` (string replaces old boolean).
  Hard = PIMC (Perfect Information Monte Carlo): sample N determinizations of unseen cards consistent with
  observed voids + called-card holder, roll out each legal move with the heuristic AI, pick best mean score.
  Budget: `{determinizations: 24, timeMs: 25}` server-side. Bid/trump/call keep heuristics at all levels.
  (Superseded in part by D35: `hard` now searches the **bid** too. Trump and the call kept their
  heuristics at every level, which is where this decision ended up after M10 measured the alternative.)
- **D4. Turn timer**: room setting `turnTimerSec` (0=off, default 45). Runs whenever required actor is a
  connected, non-away human. On expiry: AI acts for them, player marked `away: true` (AI keeps playing their
  turns instantly-ish with normal AI_DELAY). Any message from that player clears `away`.
- **D5. Round flow**: `roundEnd` advances when ALL connected seated non-away humans sent `{type:"ready"}`,
  or 30s fallback timer, whichever first. `trickEnd` stays fixed short delay (1.6s).
- **D6. Protocol additions** (client->server): `sit {seat}`, `stand {}`, `kick {seat}` (host; addressed by
  seat, not pid — the client never learns other players' pids),
  `settings {difficulty?, targetDeals?, turnTimerSec?}` (host, lobby only; difficulty also allowed mid-match),
  `ready {}`, `chat {text ≤200}`, `emote {e}` (allowed set: 👏 😂 😱 🔥 🤝 💀), `back {}` (clear away).
  Server->client: `chat` entries ride in view (`v.chat`), `{type:"emote", seat, e}` transient,
  `{type:"joined"}` unchanged + `uid` echo.
- **D7. Engine params**: `createMatch(names, opts)` with `opts.targetDeals` (3|5|7, default 5) stored as
  `G.targetGames`. `aiActionFor(G, seat, difficulty)` takes the string level.
- **D8. Room codes**: default 4 chars; "private" rooms 8 chars. `normCode` accepts up to 8. Client checkbox on Create.
- **D9. Security**: WS upgrade rejected when `Origin` header present AND its host ≠ request host
  (unless `ALLOW_ORIGIN` env lists it). Non-browser clients (no Origin) allowed. Node: per-IP socket cap (20).
- **D10. Stats (CF only, optional)**: client sends stable `uid` (localStorage `trump_uid`, minted once) in join.
  At `matchOver` the DO writes one row per human seat into D1 `matches` (schema.sql) IF `env.DB` bound;
  silently skipped otherwise. `GET /stats?uid=` returns `{games, wins, bidsWon, bidsMade}`. Node backend: no stats.
- **D11. Tests**: ~~`node --test test/`~~ — CORRECTED 2026-07-28: that path-argument form fails on Node 24
  with `MODULE_NOT_FOUND` (it tries to `require()` the directory as an entry point). The form that
  actually works, and what `package.json`'s `test` script runs, is the bare `node --test` — no path
  argument — which discovers the same suite on Node 20, 22 and 24. Engine invariant playouts + rule
  edges; room-core redaction property (serialized view for seat A never contains seat B's hand), message
  fuzzing, flow tests. CI = GitHub Actions.
- **D12. ~~Root `index.html` (offline game) stays untouched~~** — SUPERSEDED 2026-07-27 by
  `docs/superpowers/specs/2026-07-27-project-structure-design.md`. The copy had drifted from the
  engine (`Math.random` deals instead of the CSPRNG, no hard AI, no `targetDeals`), so it was deleted and the solo game
  rebuilt on the shared engine at `app/js/core/engine/`. `app/solo.html` is precached by
  the service worker and playable offline when navigated to directly; the generic
  offline-navigation fallback is the precached app shell (`index.html`), not solo.html.
- **D13. Native ES modules, no bundler.** ~1100 lines of client JS doesn't need one; keeps edit-and-reload
  dev and a zero-build deploy; HTTP/2 makes ~19 small files free, and the service worker precaches them
  on first visit anyway. Rejected: an esbuild bundle to a single `public/app.js` — adds a devDependency, a
  mandatory pre-deploy build step, and generated files inside the deploy directory.
- **D14. The engine lives inside the served directory** (`app/js/core/engine/`), not in `src/`. Without a
  bundler, anything the browser imports must be served, so one file on disk makes drift structurally
  impossible. Rejected: an authoritative copy under `src/` plus a generated copy in `app/` —
  reintroduces the two-copies-drift problem this whole restructure exists to remove.
- **D15. `public/` renamed to `app/`.** It now holds real application source (the shared engine), not
  static junk. Rejected: keeping the name `public/` — misleading once game logic lives there.
- **D16. Whole repo goes ESM** (root `package.json` `"type": "module"`; `src/package.json` marker
  deleted). Forced, not chosen: the browser needs the engine as ESM, and CommonJS cannot reliably
  `require()` ESM on Node 20, which the CI matrix still tests. Rejected: dual CJS/ESM via the
  `src/package.json` marker — the old hack, and it doesn't scale to a browser consumer.
- **D17. Shared client state lives in one exported mutable object, `S`** (`app/js/session.js`). ESM `let`
  exports are live but read-only for importers, so they can't be reassigned across module boundaries; an
  object keeps the diff mechanical and state ownership explicit. Rejected: getter/setter pairs per field
  (ceremony), or a full store/observer layer (over-engineered at this size).
- **D18. `src/core/room/` stays out of `app/`.** Room logic — every seat's hand, host/kick/settings — is
  server-only and must never ship to a client. Rejected: putting all core state machines under `app/` for
  symmetry with the engine.
- **D19. Five ordered `<link>` stylesheets** (cascade `tokens → base → table → panels → responsive`),
  not one block or `@import`. Rejected: `@import` — it serialises requests, the same problem the original
  ~675-line stylesheet had.
- **D20. The service worker's precache `SHELL` is auto-generated** by `scripts/build-assets.js` walking
  `app/`, rather than hand-maintained. Rejected: a hand-maintained array — it silently omits new modules,
  and an omitted module is a broken offline load.
- **D21. Root `index.html` deleted; solo now served from `app/solo.html`.** Removes the duplicated engine
  while offline play keeps working via the service worker. Rejected: keeping it as a self-contained file
  — that self-containment *is* the duplication this work removes.
- **D22. D12 ("root `index.html` stays untouched") superseded**, not deleted from this list — see the
  amendment above. The duplicate had already drifted (`Math.random()` deals, no hard AI, no
  `targetDeals`); leaving D12 in force would have left a known-drifted rules copy in the repo.
- **D23. The table is a rounded slab with two rails, not an oval with one sidebar.** Adopts the
  `TRUMP.dc.html` design wholesale (`docs/superpowers/specs/2026-07-29-design-integration.md` is the
  module contract). Contract + scoreboard + your own tricks go left, log + chat go right, and
  whatever you have to decide rides a tray *out of flow* above the hand — the auction's five controls
  and the 20-card call grid used to grow the action bar and resize the felt on every phase change.
  Rejected: keeping the oval and restyling it — at 16:9 the oval flung the seats to its rim, left a
  dead centre, and wasted exactly the two corners a 13-card hand needs.
- **D24. One team colour, and it is the bidding side's.** The pair that bought the contract is lit
  (`--acc` / `--teambd` / `--teamtint`); defenders are simply everyone who isn't. Rejected: the old
  gold/blue pair — a second accent competing with the brass made four seats read as two pairs of
  strangers, and the felt already carries enough colour.
- **D25. Shared renderers, parameterised on the view.** Everything under `app/js/ui/` takes the view
  as its first argument and an action-handler object as its second, so `screens/game.js` (handlers =
  `send()`) and `solo.js` (handlers = engine call + repaint) paint one implementation. This is what
  removes solo's private copy of the seats, medallion, scoreboard and action bar. See
  `docs/STRUCTURE.md` rule 6. Rejected: sharing by having solo populate `session.js`'s `S` — that
  couples two clients that must stay independent, which is the coupling the parameterisation avoids.
- **D26. The webfonts are a progressive enhancement, never a dependency.** Instrument Sans / Instrument
  Serif / IBM Plex Mono load from Google Fonts with `display=swap`; every `--f*` token names a real
  system fallback because the service worker cannot precache a cross-origin response, so an offline
  load gets the system grotesk/serif/mono. Rejected: self-hosting woff2 subsets — ~300 KB of committed
  binary for a case the fallback stack already covers legibly.
- **D27. Trick history is public engine state.** `G.tricks` (winner, points, the four cards) is pushed
  by `resolveTrick()` and published by `publicView()`, which is what feeds the piles in front of each
  seat, the "tricks you won" rail and the deal-result review. Every card in it was played face-up in
  front of all four seats, so it adds no redaction surface. Rejected: reconstructing it on the client
  from the log — the log is prose, and a client that has to parse prose to draw the table is a client
  that breaks the next time the wording changes.
- **D28. The coach runs client-side, from the redacted view.** `determinize()` (`ai/pimc.js`) reads only
  `G.hands[me]`, `G.playedCards`, `G.voids`, `G.calledCard`, `G.partner` and the other seats' hand
  *counts* — every one of those is already in the redacted per-viewer view (`src/core/room/view.js`) or
  derivable from it. So the coach is structurally unable to cheat, costs the DO nothing, and works
  offline. Rejected: a DO-side coach — billed CPU per hint, no solo, and it would have to redact itself
  before searching.
- **D29. One evaluator, two consumers.** `evaluateMoves` is factored out of `choosePIMCCard`
  (`ai/pimc.js`) so bots and the coach share one implementation; `choosePIMCCard` becomes its argmax
  wrapper, and the refactor is behaviour-preserving by construction (`winProb*1000 + meanPoints` is
  exactly the old `win*1000 + margin`, averaged) — pinned by a frozen pre-refactor oracle, not merely
  argued in prose. Rejected: a separate coach evaluator — two searchers that disagree about the same
  position is a bug generator, and the bot's search is the one that has been tuned.
- **D30. A seeded RNG is threaded through the search** (`mulberry32`, a `rnd` parameter defaulting to
  `Math.random`). Bought for review reproducibility — reopening a review must print the same numbers —
  and it also converts `test/ai.test.js`'s tolerance-checked head-to-head into an exact assertion.
  Rejected: accepting a review whose numbers drift between openings — a coach that contradicts itself on
  refresh is not believed.
- **D31. The deal RNG is untouched.** Only AI-internal sampling becomes seedable; `randomInt`/`shuffle`
  keep the CSPRNG (D9a). Rejected: one seedable RNG for everything — that is exactly the shared stream
  D9a was written to eliminate.
- **D32. The review judges the decision, not the outcome.** Each position (`coach/review.js`) is
  re-searched from the player's own information set at that moment — never from the reconstructed full
  deal, and never carrying a later trick's cards into an earlier trick's position (mirrors `applyPlay`'s
  own void rule). Rejected: hindsight analysis — cheaper and much easier to build, but it flags correct
  plays as blunders whenever the cards were unkind, which is precisely the advice that teaches people
  wrong.
- **D33. `coach` is a host setting defaulting to on, and it is signalling rather than enforcement.**
  Documented everywhere it surfaces — the lobby's settings row reads "a table agreement — the engine runs
  in every browser," and a mid-match settings chip shows the current agreement to every seat, not just the
  host. Rejected: silently pretending it is enforced; rejected: no setting at all, which leaves a table
  unable to agree to play clean.
- **D34. The table-read panel is ungated public information.** Rejected: hiding it behind the `coach`
  setting — every number in it (points live, captured split, the bonus three, known voids, outstanding
  cards) is something the player watched happen at the table, sourced from the same derivation
  (`shadowFromView`) the search itself uses to stay honest.
- **D35. The auction search is `hard`-only, and — after re-measuring in the unit the platform bills —
  ~~bid/trump/call~~ the *bid alone* server-side.** Gives the three difficulty tiers a real meaning
  beyond card play, and keeps the added DO cost on the tier that opts into it.
  ~~Estimated cost: "at most ~6 times per deal at 6000 plays ≈ 36k plays, against a play phase that
  already spends up to 13 × 4 × 8000 ≈ 416k. Roughly a 9% increase in the DO's per-deal search work."~~ —
  **CORRECTED, measured** (`scripts/bench-auction-search.js cost`): PIMC's real per-deal cost is
  **~124,500** simulated plays, not ~416,000. `evaluateMoves` (`ai/pimc.js:95-97`) computes
  `affordable = budget / (legal.length × cardsLeft)`, with `cardsLeft` (all four hands combined) in the
  *denominator* — so `affordable`, and therefore `maxDet = Math.min(24, affordable)`, is *small* early
  in a deal when `cardsLeft` is large and *grows* as the deal empties, until it hits and then sits
  pinned at its 24 ceiling; it does not shrink as the deal progresses (traced on a real deal:
  `legal=13, cardsLeft=52` → `affordable=11`, `maxDet=11`; `legal=2, cardsLeft=8` → `affordable=500`,
  `maxDet` pinned at 24). The saving is in the *per-decision cost* (`maxDet × legal.length ×
  cardsLeft`): while `maxDet` is still under 24 the afford formula caps that cost at roughly the 8000
  budget (the same traced early decision costs 7,436 plays), but once the ceiling binds, cost keeps
  falling as `legal.length`/`cardsLeft` keep shrinking through the endgame even though `maxDet` itself
  is flat at 24 (the same traced late decision costs 384 plays). On top of that, `choosePIMCCard`
  spends nothing at all on a forced play (`legal.length <= 1`) — `evaluateMoves` is never even called
  for one. The full auction search's real cost was **~79,500** plays/deal: **+64%, not +9%** — an order
  of magnitude off in relative terms. Recorded so the next person to reason about DO cost starts from the
  measured mechanism, not the interface contract's arithmetic.

  ~~"the absolute cost (tens of ms, warm, in a DO idle between messages) is still small enough that the
  recommendation is unchanged"~~ — **the unit was wrong too.** Every figure above is *per deal*, and a
  Durable Object does not bill per deal: it bills **per invocation**. WebSocket hibernation
  (`ctx.acceptWebSocket`, `src/worker/room-do.js`) makes each inbound message its own invocation instead
  of accumulating across a connection, and each alarm fires exactly **one** bot action
  (`src/core/room/timers.js` → `drive.js`'s `aiAct` → `aiActionFor`). So trump and call were not "~16 ms
  spread across a deal": they were two *separate* invocations of ~8 ms each, in a slot that would
  otherwise cost ~0.01 ms. Measured through the real router
  (`node scripts/bench-auction-search.js cost`, all four seats on `hard`, ~8,500 invocations):

  | | before (bid+trump+call) | after (bid only) |
  |---|---|---|
  | trump invocation | 8.4 ms median, 10.1 max | **0.00 ms** (hand-count) |
  | call invocation | 7.5 ms median, 11.7 max | **0.01 ms** (hand-count) |
  | bid invocation | 1.3 ms median, p95 2.3 | unchanged |
  | card invocation (PIMC) | 0.5 ms median, p95 1.9 | unchanged |
  | worst single invocation | ~19 ms | **3.3–8.1 ms**, always a card decision |
  | whole deal, all four seats | 68 ms | **48–54 ms** |
  | auction plays/deal | ~79,500 (+64% of PIMC) | **~32,000 (+25%)** |

  **What that bought, and what it cost.** The auction search's two halves are not equally valuable.
  Paired A/B on real outcomes — deals won, the game's own scoring unit — found the **bid** worth
  **+2.77 ± 0.91 pp** (n=5998) for ~40% of the auction's compute, while **trump and call together** are
  worth only **+0.56 ± 0.42 pp** (n=9991) for the other ~60% (independently reproduced by review at
  +2.80 ± 0.80 pp, n=7993). Why: a deal is scored **made or set** — a binary — so points captured beyond
  the contract line buy nothing. Trump and call raise mean captured points by ~2.5/deal in-model, which
  mostly lands as margin a binary score discards; the bid changes *whether the contract is won at all*.
  Points per deal was the wrong objective to have designed against; deals won is the scoring unit.

  ~~Rejected (after measurement): cutting trump/call for their smaller deals-won yield — they still
  measure as a real, positive, cheap improvement (~16 ms/deal) and also feed the hint's trump/call
  advisor, which the bot-outcome analysis alone does not price.~~ — **REVERSED.** 43% of the added
  compute, delivered as two of the four most expensive invocations a deal has, bought an effect
  indistinguishable from zero. `ai/index.js` now routes only the bid; every tier takes trump and the call
  from `aiPickTrump`/`aiPickPartner`. The advisor argument survives intact and is the reason nothing was
  deleted: `aiPickTrumpSearch`/`aiPickPartnerSearch` and all of `ai/bid-search.js` still answer the
  coach's auction advisor (`app/js/coach/worker.js`) — in the player's own browser, off the main thread,
  at a budget of its own and at zero server cost. Only the server-side routing was cut.

  This project is on **Workers Paid**, so the 30 s per-invocation CPU limit was never a blocker and none
  of the above was forced. It is a cost decision taken on measurement: `wrangler.toml` now carries a
  `[limits] cpu_ms = 300` runaway guard sized from the table above, per Cloudflare's own recommendation
  to bound denial-of-wallet rather than leave the default in place.

  **Checked against an all-hard table, on re-review — nothing above had.** `outcome`'s pairs are one
  searching seat against three hand-counters; an all-`hard` table is four, which is what four `hard`
  bots actually produce. Paired fork: an identical searched-bid auction, then two branches from the same
  position with the same seeds after the fork — trump/call from the search (the pre-cut policy) against
  trump/call from the hand-count (what ships) — n=2000. Under the card play that ships, PIMC: set rate
  32.3% → 32.5%, **+0.15 ± 1.77 pp** — indistinguishable from zero, so **the cut is safe as shipped**.
  Under the heuristic card play `outcome` itself uses (`runDeal`, `scripts/bench-auction-search.js:87`,
  which hardcodes `chooseAICard` unconditionally): 32.7% → 36.1%, **+3.42 ± 2.16 pp** — significant. The
  mechanism: `aiPickTrumpSearch`/`aiPickPartnerSearch` score each candidate by rolling the rest of the
  deal out with `chooseAICard` (`playOutWith` → `pimc.js`'s `playOutRound`, unconditionally — never
  PIMC), so whatever edge the search has over the hand-count is real only when the deal actually gets
  finished that way, which shipped `hard` play never does. That cuts backward, too: the **+0.56 ± 0.42
  pp** figure this decision rests on came from that same `outcome` arm, under that same heuristic card
  play — not the PIMC that `hard` ships. It is not overturned: the PIMC-measured, all-hard-table result
  above independently lands in the same place, indistinguishable from zero, which is the confirmation
  the original number could not give by itself. But the honest record is that the figure this cut was
  decided on carries the identical methodological caveat as everything else `outcome` measures, and this
  is the first place that caveat was actually checked rather than merely true in principle.
- **D36. Common random numbers in the auction search.** Candidates are compared on one shared set of
  sampled worlds. Rejected: independent sampling per candidate — same cost, strictly more variance in
  exactly the comparison the decision turns on.
  ~~One shared `BID_PLAY_BUDGET = 6000` for the bid, trump and call.~~ — **CORRECTED, measured:** a
  single budget splits the three questions exactly backwards. `worldsFor` divides the budget by the
  candidate count, so precision *falls* as the candidate list grows — but an argmax over more near-equal
  candidates needs *more* samples, not fewer, to tell them apart. At a uniform 6000, the bid (1
  candidate, ~115 worlds) was already over-provisioned, while the call (~10 candidates, ~11 worlds) was
  measurably no better than the hand-count it was meant to replace (regret 3.60 vs. the heuristic's own
  3.33). Shipped: three separate budgets — `BID_PLAY_BUDGET = 3000` (halving it from 6000 cost nothing
  measurable: −0.09 ± 0.38 pp of deals won over 7998 paired deals), ~~`TRUMP_PLAY_BUDGET =
  CALL_PLAY_BUDGET = 24000` (a 150-deal hold-out on seeds disjoint from tuning: +2.47 ± 0.95 and
  +2.60 ± 0.87 points/deal respectively)~~ — **CORRECTED, measured** (`node scripts/bench-auction-search.js
  regret`): the struck pair was a *mean-points* hold-out, and the auction search stopped ranking trump/call
  candidates by mean points shortly after (make-probability instead, the coach report card's D42). A
  budget tuned against one statistic is not guaranteed right for the other — a binomial outcome's variance
  is p(1−p), not a points mean's — so both were re-measured rather than assumed. Both re-measured at
  trumpSelect, from the real declarer against the real winning contract — an earlier pass of this
  re-measurement evaluated trump from an arbitrary pre-auction seat targeting a fresh deal's 130-point
  minimum bid instead, which barely mattered under mean points but not under make-probability, where the
  target *is* the statistic; fixed before these numbers were written down. `TRUMP_PLAY_BUDGET`
  **stays 24000**: regret against a wide oracle is 0.002 make-prob (0.20 pts) there against 0.001
  (0.06 pts) at 4x the budget (96000) — the real movement is between 6000 and 24000 (regret 0.010 → 0.002);
  what's left at 96000 is small enough not to buy, not simply flat throughout. The paired within-deal
  24000→96000 difference (96000's worlds are a superset of 24000's, same seed, so this is tighter than a
  marginal comparison) is +0.001 ± 0.002 make-prob (+0.14 ± 0.18 pts, n=150), ranging +0.001 to +0.004
  paired across four independent 150-deal runs — never enough to argue for raising it. A one-off 16x check
  (384000, not a swept point) landed at the same regret (0.001) and gain (+0.013) as that run's own 96000,
  confirming the curve does flatten, just starting around 24000, not from 6000.
  `CALL_PLAY_BUDGET` **raised 24000 → 96000**: at 24000 it still gave up 0.014 make-prob (1.18 pts) of
  regret against the wide oracle and beat the hand-count by only +0.025 ± 0.011 make-prob
  (+2.01 ± 0.99 pts); at 96000 regret fell to 0.006 (0.40 pts) and the gain rose to +0.034 ± 0.009
  (+2.79 ± 0.84 pts). Unlike trump this is a real further gain: the paired within-deal 24000→96000
  difference is +0.008 ± 0.005 make-prob (+0.78 ± 0.52 pts, n=150) and never crossed zero across four
  independent 150-deal runs (+0.008 to +0.013 paired each time — deals are unseeded CSPRNG hands, so each
  rerun is a fresh sample, not a replay) — an order of magnitude tighter than the marginal per-run CIs,
  which *do* overlap (the canonical run above: 24000's make-prob-gain CI is [0.014, 0.036], 96000's is
  [0.025, 0.043]), so the paired difference, not the marginal ranges, is what this decision rests on. A one-off 384000 check (regret 0.002, gain +0.043 ± 0.009 / +3.93 ± 0.91 pts) shows the curve
  itself flattening from 96000 on — unlike trump, call had not reached that point at 24000. Rejected, once
  measured: a single shared budget for all three questions. Common random numbers itself is unaffected —
  worlds are still shared within each question's own candidate set — only their count stopped being one
  constant across all three.
- **D37. The review opens on demand from the round-result modal, never automatically.** Rejected:
  auto-opening — it would sit on top of the ready gate that three other players are waiting on.
  **Extended by Task 14:** a deal that wins the match never reaches `roundEnd` (`match.js`'s `endRound`
  routes it straight to `matchOver`), so the deal that decides the match — plausibly the one a player
  most wants to review — had no review affordance at all. The identical on-demand contract (never
  automatic, computed lazily, never displacing the modal's primary action — rematch, here, rather than
  ready) now also lives on the match-over modal, via the same body/action sibling split Task 12 proved on
  the round-result modal.
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
  **Narrower in practice than "one unit" implies, found during implementation:** a shared unit makes
  the four kinds *comparable* against the fine/mistake/blunder thresholds; comparable turned out not
  to mean *poolable*. The bid's probability is the search's own distance from its 0.5 decision line,
  not a forgone win probability — passing does not end the deal the way playing a worse card does, so
  there is no shared-world candidate to subtract it from. `headline` (`app/js/coach/report.js`)
  therefore averages only `play`/`trump`/`call` (its `HEADLINE_KINDS`); the bid keeps the shared
  thresholds — it still grades fine/mistake/blunder, still counts toward `counts`, and still gets its
  own `byKind.bid.meanDelta` — but is excluded from the mean itself, and from `worst` (its own worst
  is `worstBid`, ranked separately). Ordinal comparability (a shared pass/fail line) does not imply
  cardinal commensurability (a shared quantity worth averaging). Caught before review, not after:
  Task 7's implementer found `headline` shipped blended on its own first pass and disclosed it rather
  than silently shipping the spec's own text.
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
  `TRUMP_PLAY_BUDGET`/`CALL_PLAY_BUDGET` of 24,000 those rest on. Re-ranking made them stale.
  `scripts/bench-auction-search.js` exists to re-derive exactly these, and Milestone 3 (Task 3) did:
  `node scripts/bench-auction-search.js regret` reswept both budgets under make-probability, and D36
  above now carries the measured replacements, in the ROADMAP's own "CORRECTED, measured" style —
  `TRUMP_PLAY_BUDGET` held at 24000, `CALL_PLAY_BUDGET` raised 24000 → 96000; see D36 itself for the
  regret figures and the paired-difference evidence behind each. This project has a standing rule
  against re-arguing a number that can be re-measured — discharged here, not merely stated.
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
  constraint, and inheriting the bots' budgets breaks it: ~~at `CALL_PLAY_BUDGET = 24000` with
  ~10 candidates, `worldsFor` yields 46 worlds and a band of `1/√46` = **0.147** — wider than
  `MISTAKE_WIN_DELTA` (0.07) by more than double, and effectively at `BLUNDER_WIN_DELTA` (0.15). The
  mistake grade for calls would be unreachable: any delta large enough to escape the band is already
  a blunder.~~ — **CORRECTED, re-derived from `worldsFor`'s own formula
  (`app/js/core/engine/ai/bid-search.js`) after Task 3 raised `CALL_PLAY_BUDGET` 24000 → 96000 (D36
  above):** at 96000 with ~10 candidates, `worldsFor(10, 96000) = floor(96000/520)` = **184** worlds,
  band `1/√184` = **0.0737** — still wider than `MISTAKE_WIN_DELTA` (0.07), so the conclusion is
  unchanged, but the margin the retracted arithmetic claimed ("more than double", "effectively at
  `BLUNDER_WIN_DELTA`") has collapsed to about **5%**. The practical consequence shrank with it: a
  delta just past 0.0737 already reads "mistake" (it is well under 0.15), so an inherited budget no
  longer makes the mistake grade *unreachable* the way it did at 0.147 — only *less precise* than the
  review's own floor.
  That floor beats every one of the bots' three budgets, not just the call's: inheriting
  `BID_PLAY_BUDGET` (3000, 1 candidate) gives `worldsFor(1, 3000)` = 57 worlds, band **0.1325**;
  inheriting `TRUMP_PLAY_BUDGET` (24000, 4 candidates) gives `worldsFor(4, 24000)` = 115 worlds, band
  **0.0933**; inheriting `CALL_PLAY_BUDGET` (96000, ~10 candidates) gives the 184 worlds and **0.0737**
  band above. (At the call's 13-candidate maximum: `worldsFor(13, 96000)` = 142, band **0.0839**.) All
  three exceed `MISTAKE_WIN_DELTA`; none beats the 205-world floor derived below (band **0.0698**, by
  construction, for any candidate count). The design conclusion — derive the budget from the precision
  needed, rather than inherit any of the bots' three — holds. Only the call example's illustrative
  margin was ever this thin, and it is thin again, not gone.
  So the review inverts it. The band must clear the finest grade it has to express:

      1/√worlds ≤ MISTAKE_WIN_DELTA   →   worlds ≥ 1 / MISTAKE_WIN_DELTA²

      MIN_REVIEW_WORLDS = Math.ceil(1 / MISTAKE_WIN_DELTA ** 2)     // 205
      auctionBudgetFor(candidates) = MIN_REVIEW_WORLDS * candidates * 52

  Derived, not chosen: change `MISTAKE_WIN_DELTA` and the world count follows — and this formula was
  never actually a function of any `*_PLAY_BUDGET` constant, so `CALL_PLAY_BUDGET`'s raise (which
  shrank the illustration above) left `MIN_REVIEW_WORLDS`/`auctionBudgetFor` themselves untouched.
  Bounded by construction — the call's candidate list is at most 13 (12 honours plus the heuristic),
  so the widest question costs `205 · 13 · 52` = 138,580 simulated plays.
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

## Milestones

### M1 — Tests + CI (engine)
- [x] `test/engine.test.js`: random full-match playouts (≥30 matches) asserting per-deal invariants:
      captured points sum to 250 at each roundEnd, 13 tricks/deal, exactly 2 seats gain a deal-win,
      follow-suit enforced, hands start 13, bidding terminates, forced bid after 5 all-pass redeals at 130,
      deck totals 250 for every bonus suit, `beats()` unit truths, `publicView` has no `hands` key,
      callable cards exclude declarer's own holdings.
- [x] `package.json` `"test": "node --test test/"`; CI workflow `.github/workflows/ci.yml` (node 20 + 22).
- [x] Commit M1.

### M2 — room.js extraction (node backend on shared core)
- [x] `room.js` per D1 with: createRoom, join, disconnect, handleMessage (all existing + new types stubbed),
      buildView, nextTimer/fireTimers (ai/trick/round/lobbyDrop/turnLimit/roundReady kinds), host reassign,
      spectator promotion, seat release.
- [x] `server.js` rewritten as adapter (ws + setTimeout + rooms Map + per-IP cap + Origin check + static
      serving of `public/*` incl. manifest/sw).
- [x] `test/room.test.js`: redaction property over full simulated games with 4 fake clients; fuzz
      handleMessage with 5k garbage messages (no throw, no foreign-hand leak); host reassign; reconnect
      newest-socket-wins; kick; sit/stand.
- [x] Commit M2.

### M3 — Durable Object: hibernation + persistence + alarms
- [x] `src/worker.js` rewritten per D2 on room.js. Rate-limit via in-memory WeakMap (resets on wake — fine).
- [x] Newest-socket-wins via attachment pid scan.
- [x] Manual check: `npx wrangler dev` boots, ws round-trip works (curl upgrade smoke or unit-level).
- [x] Commit M3.

### M4 — Engine: difficulty levels + PIMC hard AI + targetDeals
- [x] D3 + D7 implemented in `engine.js` (determinize with void/called-card constraints, rollout, argmax).
- [x] `test/ai.test.js`: hard AI returns legal moves under budget; determinizer respects voids/known cards;
      hard beats easy in ≥60% of 40 head-to-head matches (seeded by Math.random, tolerance-checked).
- [x] Commit M4.

### M5 — Protocol features (turn timer, ready flow, chat, seats, kick, settings)
- [x] D4, D5, D6 in room.js + both adapters; tests for: timer fires -> AI move + away; ready gate; chat ring;
      emote broadcast; settings validation (host-only, ranges); kick closes socket + frees seat.
- [x] Commit M5.

### M6 — Client: lobby settings, chat, ready, seats, away
- [x] Lobby: settings panel (host), sit/stand on seat rows, kick buttons, difficulty/target/timer display for all.
- [x] Game: chat panel + emote bar + floating emotes, "Next deal — ready ✓/n" button, away banner ("I'm back"),
      turn-timer countdown ring on active nameplate, stand-up in menu.
- [x] `view.now` added so the client can de-skew `turnDeadline`/`roundDeadline`; `test/client.test.js` pins the
      client↔core protocol vocabulary (message types, emote set, option lists, view fields) against drift.
- [x] Commit M6.

### M7 — Client: mobile + PWA + a11y + share polish
- [x] Mobile ≤900px: scoreboard/log/chat as bottom-sheet tabs (no lost info), touch targets ≥40px.
- [x] PWA: `public/manifest.webmanifest` (not `.json` — the `.webmanifest` extension is what makes both node
      and the Workers asset handler serve `application/manifest+json`), `public/sw.js` (precache / + /solo.html,
      offline → solo), SW registration, `public/solo.html` = copy of root offline game; icons generated by
      `scripts/gen-icons.js` (dependency-free PNG encoder); node server serves public/* correctly.
- [x] A11y: cards focusable buttons with aria-labels ("play ace of spades"), Enter/Space to play, log as
      aria-live polite, 4-color deck toggle (♦ blue ♣ green) persisted in localStorage.
- [x] Share: copy-link button + Web Share API in lobby; OpenGraph/meta tags.
- [x] `test/pwa.test.js` pins manifest↔icons↔sw↔client wiring, the D12 byte-identical solo copy, the a11y
      affordances and the 40px touch-target floor.
- [x] Commit M7.
- [x] iOS/iPad follow-up: `100dvh` (Safari's toolbars make `100vh` overflow), safe-area insets on every
      fixed bar and on the sheet/hand, `@media (pointer:coarse)` so iPad — which is *above* the 900px
      phone breakpoint — still gets 44px controls, hover effects gated behind `hover:hover` (sticky
      tap state on iOS), `touch-action:manipulation`, and a `visualViewport` lift so the on-screen
      keyboard can't cover the chat sheet. NOT visually verified on a device — no browser here.

### M8 — Stats (D1, optional) + hardening + README + final
- [x] D10: `schema.sql`, guarded writes at matchOver, `/stats` endpoint, client "Your record" line on join
      screen when available; wrangler.toml commented `[[d1_databases]]` block + README setup steps.
- [x] D9 hardening in both adapters (Origin, per-IP cap node, private codes client+server).
- [x] Extra beyond D8: `create` refuses an occupied code (`{code:"code-taken"}`) and the client re-mints —
      without it a 4-char collision silently dropped you into a stranger's lobby.
- [x] `test/worker.test.js` covers the Worker entry (upgrade/origin/room routing, D1-optional stats,
      parameterised query, asset fallthrough); `src/package.json` marks the Worker subtree as ESM so
      `node --test` can import it.
- [x] README rewritten: features, settings, difficulty, PWA, stats setup, updated architecture section,
      test instructions ("verified by tests" now true).
- [x] Full `npm test` green (45); `node server.js` smoke (settings/seats/chat/emotes/ready/redaction);
      `wrangler dev` smoke (assets + MIME, 403 on cross-origin upgrade, DO alarms driving play,
      persistence across reconnect).
- [x] Commit M8. Loop complete → stop.

### M9 — full-project review fixes

Findings from a review of the finished branch. Three of them contradicted claims the README made, so
they amend the decisions above rather than extending them.

**Amendments to the fixed decisions**

- **D6 (protocol) amended — deferred seating.** `sit` mid-match no longer seats immediately; it parks the
  request in `player.wantSeat`, applied by `applyPendingSeats()` at the next deal (and at match start).
  A new joiner mid-match is queued the same way instead of taking over an AI seat mid-hand. Reason: taking
  a seat is what reveals a hand, and the old `room.started && player.seat != null` guard only blocked
  hopping *while seated* — standing up first walked straight past it, and one player could read all four
  hands in a deal. View gains `you.pendingSeat` and `seats[].claimed`.
- **D9 (security) amended.** (a) The deal and every id/token now come off the platform CSPRNG, not
  `Math.random` — V8's `xorshift128+` state is recoverable from the cards a player sees, which shared a
  stream with `playerId` minting and private room codes. (b) A kicked player stays out (by pid and uid)
  for the life of the room. (c) `TRUST_PROXY=1` gates reading `X-Forwarded-For` for the per-IP cap.
- **D12 amended.** `public/solo.html` is still byte-identical to the root game, but is now *generated* by
  `scripts/build-assets.js` instead of copied by hand, alongside the service worker's cache `VERSION`
  (a hash of the shell — it was a hard-coded constant that no deploy ever bumped). `npm test` fails stale.

**Fixes**

- [x] Adapters: a socket that sends a second `join` retires its previous identity
      (`R.disconnect(..., {immediate:true})`) instead of stranding it. Without this, one socket left a
      "connected" player in every room it touched — seats stayed claimed, the empty-room expiry never
      armed, and `MAX_ROOMS` could be pinned until restart. Node reclaims an empty room at the cap rather
      than refusing; the DO reconciles + re-arms expiry on wake via the new `R.reconcile`.
- [x] `drive()`: the ready gate no longer reads "no live humans" as unanimous consent, and the
      nobody-connected check moved above it — a deal used to advance unseen when everyone dropped at once.
- [x] PIMC bounds itself on simulated card plays, not wall clock: Workers freeze `Date.now()` between I/O,
      so the cutoff never fired inside a DO. Worst case ~2–3 ms warm (was ~10 ms+ and unbounded in principle).
- [x] Client a11y: the table log and chat diff their sliding window (`syncWindow`) instead of being cleared
      and refilled — an `aria-live` region rebuilt wholesale re-announces the entire backlog on every state
      message. The hand skips no-op rebuilds and restores keyboard focus when it does rebuild.
- [x] `esc()` escapes `'`; turn-timer changes re-arm the turn in flight; the DO writes stats before
      persisting (its idempotency flag never reached storage); reconnect backs off exponentially with jitter.
- [x] Tests: 46 → 67. New `test/server.test.js` covers the adapter-level socket bookkeeping the core cannot
      see; hand secrecy is now asserted across a *sequence* of views; the PWA/mobile assertions read parsed
      CSS declarations per context instead of matching the stylesheet's exact bytes; `syncWindow` and `esc`
      are lifted out of the HTML and executed for real. Regression-checked by reverting each fix.

### M10 — Coach: hints, table read, deal review, and an auction that thinks

Turns the hard AI's Perfect-Information Monte Carlo search into player-facing help — a hint, a table
read, a post-deal review — and points the same machinery back at the bots' own auction, which previously
bid, named trump and called a partner by a linear hand-count at every difficulty. Design:
`docs/superpowers/specs/2026-07-29-coach-design.md`. Plan: `docs/superpowers/plans/2026-07-29-coach.md`.
Decisions D28–D37 above are this milestone's design log (C1–C10 in the spec); D35 and D36 record where
measurement corrected the plan's numbers, not just its conclusions.

- [x] Task 1: seedable RNG (`mulberry32`) threaded through the AI's internal sampling (D30); deals
      themselves keep the CSPRNG untouched (D31).
- [x] Task 2: `evaluateMoves` factored out of `choosePIMCCard` (D29) — one evaluator, two consumers.
- [x] Task 3: `coach/shadow.js` — a redacted view rebuilt as a search-ready position (D28); its
      `playedCards`/`voids` checked equal to the server's own exactly, across hundreds of sampled live
      positions per run.
- [x] Task 4: `coach/read.js`'s table read (D34) — points live, captured split, the bonus three, voids,
      outstanding cards; `bonusTakenBy` relocated out of `rails.js` so there is one implementation.
- [x] Task 5: `coach/worker.js` + `coach/client.js` — one lazily-spawned module worker, request/response
      correlated by id, synchronous reduced-budget fallback when a worker cannot be built.
- [x] Task 6: the `coach` room setting (D33) — host-controlled, defaults on; `coachOn()` is the one
      predicate the lobby, the mid-match settings chip and the hint button all read, so they cannot
      disagree about what a table has agreed to.
- [x] Task 7: `ai/bid-search.js`, the auction search — samples whole deals to answer the bid, trump and
      partner call. Shipped with three budgets rather than the plan's one (D36).
- [x] Task 8: `hard` routes ~~bid/trump/call~~ **the bid** through the search; `easy`/`normal` keep the
      hand-count, and so does every tier for trump and the call (D35 — cut on the whole-branch review,
      once the cost was re-measured per *invocation* rather than per deal). The all-`hard` regime
      measured healthy: contract settles higher (163.5 vs. 150.3) but no runaway — 0 of 4000 deals at
      the 250 ceiling, redeal rate unchanged at 0.0%. That result is unaffected by the cut: the contract
      level is decided entirely by the bidding, which still searches.
- [x] Task 9: `coach/review.js` — re-searches each decision from the information the player had at the
      time (D32). Its cross-checking test (against a live `shadowFromView` snapshot, not a second copy of
      its own logic) caught two real bugs a bare card-count check would have missed: a copied-through
      `phase` that made every rollout a no-op, and the deal's own final outcome leaking into the search
      baseline.
- [x] Task 10: the hint affordance (`#btn-hint`, `app/js/ui/coach.js`) in both shells.
- [x] Task 11: the table-read panel in the rail and the mobile Score tab (D34).
- [x] Task 12: the review panel on the round-result modal (D37) — a body/action sibling split makes "a
      review can never displace the ready gate" true by DOM construction, not by discipline.
- [x] Task 13: this documentation and decision log, plus the tooling fix below.
- [x] Task 14: review the match-clinching deal (D37) — a deal that wins the match routes straight to
      `matchOver` and never reaches `roundEnd`, so it had no review affordance; ported Task 12's
      body/action split onto `showMatchOver`, next to (never replacing) the rematch button.

**`scripts/bench-auction-search.js` fixed to stop asserting a retracted claim.** The tool behind D35/D36
used to print a "break-even" — `(1/3)(1-set) + (2/3)(set)` — as the crux of whether the bid's 0.5
make-probability threshold was well calibrated. That expression is an algebraic identity: exactly two of
four seats win every deal, so it equals 50% for every set rate, which made every threshold from 0.5 to
0.65 read as conservative. It was replaced by a genuine same-hand fork (the script's `counterfactual`
section, which snapshots a marginal bidding decision and finishes the deal twice — once bidding, once
passing): the marginal bid measured at **−0.35 ± 1.40 pp**, no detectable effect, leaving 0.50 and 0.55
statistically indistinguishable and 0.50 kept as the measured incumbent, not as a winner. Task 13 deleted
the retracted computation from the script rather than merely annotating it, so nobody re-derives a
withdrawn argument from the tool.

### M11 — The report card: a match graded, not just a deal

Aggregates M10's per-deal review across an entire match — card play, the bid, the trump pick and the
partner call — into one graded report on the match-over modal, and fixes the D1 stats table's per-deal
bid counters, which had silently measured only the match's final deal. Design:
`docs/superpowers/specs/2026-08-01-coach-report-card-design.md`. Plan:
`docs/superpowers/plans/2026-08-01-coach-report-card.md`. Decisions D38–D46 above are this milestone's
design log (continuing M10's D28–D37); D41, D42 and D44 record where implementation and measurement
corrected the spec's own numbers and contracts, not just its conclusions.

- [x] Task 1: engine history — `G.auction`, `G.dealHistory`, `G.matchId` (D39, D40). `auction` resets
      every `deal()` so a redeal's passed-out auction correctly vanishes; `publicView` publishes
      `auction`/`dealHistory` as copies, never aliases, so a viewer can never hold a reference into `G`.
- [x] Task 2: `ai/bid-search.js`'s `evaluateTrumps`/`evaluateCalls` factored out of
      `aiPickTrumpSearch`/`aiPickPartnerSearch`, which become argmax wrappers over them, re-ranked
      onto make-probability (D42) — mirrors D29's evaluator/wrapper split exactly. Bots unaffected:
      `ai/index.js` still calls the plain heuristics.
- [x] Task 3: re-measured what the re-ranking invalidated (D42's own obligation) —
      `TRUMP_PLAY_BUDGET` held at 24000, `CALL_PLAY_BUDGET` raised 24000 → 96000 (D36 above, corrected
      in place rather than left to go stale).
- [x] Task 4: `coach/auction.js` — grades the bid, the trump pick and the call from the auction log;
      review.js's sibling for the half of a deal that happens before a card is played. Dead-band
      grading (D43) sized from the precision the review itself needs (D44), not inherited from the
      bots' budgets.
- [x] Task 5: `coach/report.js` — the pure match-wide aggregate (D41). `headline` means only
      play/trump/call; the bid keeps the shared thresholds without entering the mean.
- [x] Task 6: finished-deal snapshots kept client-side, `app/js/util/deals.js` (D46), keyed by room
      and `matchId`, capped at 3 retained matches, degrading to a no-op rather than throwing under a
      storage quota or private browsing.
- [x] Task 7: the report card itself — worker/`client.js` wiring for a multi-deal request, and the
      match-over modal's `Report card ▸` toggle, a third sibling next to rematch and
      `Review this deal ▸` (D37) — always states its own coverage and never presents a partial mean as
      a whole one (D45).
- [x] Task 8: fixed what "Your record" measures (③) — `writeMatchStats` now folds every deal in
      `G.dealHistory` instead of reading only `G.lastResult`, so a player who won four bids and made
      all four then lost the fifth deal no longer records zero; migration for existing D1 databases at
      `migrations/0001-report-card.sql`.
- [x] Task 9: this documentation and decision log — plus three corrections to shipped text the
      earlier tasks' own measurements had already outrun: `coach/auction.js`'s dead-band comment
      (D44, re-derived above), the design spec's headline/costliest-decisions contract (D41), and
      this log itself, which shipped source had been citing since Task 4 while it still stopped at
      D37.
- [ ] Task 10: career trend on the join screen, sliced by difficulty, off `deals`/`bids_won`/
      `bids_made` — separable and deferred (spec Scope: "shipped last and separably").
