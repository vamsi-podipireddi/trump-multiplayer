# Table UX redesign — design

Date: 2026-07-26 · Branch: `feat/next-level` · Target file: `public/index.html` (+ 3 lines in `engine.js`)

The networked client is one hand-written file with no module boundary and no build step. This spec is
written to be implemented straight into it, section by section, without re-deriving any decision.

## 1. Problem

The in-game screen (desktop, >900px) reads as an empty room with the useful state pushed to its edges.

1. **The hand is clipped.** `#game` declares `grid-template-rows:auto 1fr` but has three row children —
   `header`, `#table-wrap`, `#bottom`. `#bottom` carries an explicit `grid-column:1/2` and no row, so grid
   auto-placement drops it into an **unsized implicit row 3**; row 2 (`1fr`) has already eaten the height.
   With `body{overflow:hidden}` the bottom of every card is cut off. The `@media (max-width:900px)` block
   sets `auto 1fr auto`, so this is a desktop-only regression that mobile hid.
2. **The felt is ~65% of the screen and carries no information.** `#table` is `width:100%;height:100%`,
   so on a wide monitor it becomes a stadium with the seats flung to its rim and a dead centre.
3. **State is scattered.** High bid lives in a header badge, whose turn it is in a 14px line above the hand,
   what happened in a sidebar log. Nothing is where the eye rests.
4. **No type scale.** Almost every string is 10–14px, so nothing reads as primary.
5. **Facts already on the wire are never shown.** `tricksWon[]` ships in every view and is never rendered.
   Seats that pass during the auction render as *nothing at all* (`roleOf()` returns `null`).
6. **Undifferentiated controls.** `4-Color`, `How to Play`, `Stand Up`, `Leave` are four identical gold
   ghost buttons: two settings, one that gives away your seat, one that exits.

## 2. Decisions (fixed — do not re-litigate)

- **DX1. Keep the identity.** Green felt, gold accents, Georgia card faces. This is a restructure, not a
  re-skin. No new palette, no new fonts, no redrawn card art.
- **DX2. Restructure the table.** Compact felt, a centre medallion carrying the contract, a loud action
  zone, a real type scale. (Chosen over "refine in place" and over a full new visual identity.)
- **DX3. Add derived information**, not motion. Everything the view already carries gets shown: tricks won,
  who passed, contract progress, trump and bonus always visible. **No** trick-slide-to-winner, no points-fly,
  no deal animation beyond the existing `dealIn`.
- **DX4. Scope is all four surfaces**: in-game table, sidebar panels, join + lobby, mobile/tablet.
- **DX5. One exception to "no server changes": `G.bids`.** Per-seat bid values are not tracked by the engine
  (`engine.js` keeps only `highBid`/`highBidder`/`bidActive`). Three lines add them, because the auction is
  the emptiest phase on screen and the one the redesign most needs to fill. See §9.
- **DX6. No new dependencies, no build step, still one file.** `npm test` has no dependencies and stays that
  way. No dropdown/menu widget — nothing that needs focus trapping or click-outside handling.
- **DX7. Every commit that touches `public/index.html` must run `npm run build:assets`.** The service
  worker's cache `VERSION` is a hash of the shell, and `public/index.html` is in the shell
  (`scripts/build-assets.js:28`). `npm test` fails if it is stale.

## 3. Design tokens

Added to `:root`, alongside the existing variables (which keep their names and values — nothing that
already references `--gold`, `--felt-1`, `--team-d` etc. changes):

```css
/* type scale */
--t-xs:11px; --t-sm:12.5px; --t-md:14px; --t-lg:16px; --t-xl:20px; --t-2xl:26px; --t-3xl:34px;
/* text */
--txt:#f3f3f3; --txt-2:rgba(243,243,243,.72); --txt-3:rgba(243,243,243,.5);
/* surfaces & lines */
--surface-1:#102a1b; --surface-2:#0a1d12; --surface-3:rgba(0,0,0,.35);
--line:rgba(255,255,255,.10); --line-gold:rgba(232,196,90,.28);
/* radii */
--r-sm:8px; --r-md:12px; --r-lg:16px; --r-pill:999px;
/* semantic */
--gold-dim:#b9942f; --danger:#ff8080; --ok:#7fd6a0;
```

Rule for the implementation: any *new* rule uses tokens. Existing rules are converted only where they are
being touched anyway. A find-and-replace sweep is explicitly not wanted — it would bloat the diff for no
visible gain.

## 4. Layout spine

```css
#game { height:100vh; height:100dvh; display:none;
        grid-template-columns:1fr clamp(300px,22vw,340px);
        grid-template-rows:auto 1fr auto; }
aside { grid-row:2/4; grid-column:2/3; }
```

- Three explicit rows: header (auto) / table (1fr) / bottom (auto). This is the clipped-hand fix.
- `aside` must move from `grid-row:2/3` to `2/4` or the sidebar stops at the table row.
- Both `height` declarations stay, in this order — `test/pwa.test.js:170` asserts the winning height is `dvh`.
- The `@media (max-width:900px)` override keeps `grid-template-columns:1fr` and `grid-template-rows:auto 1fr auto`.

The felt stops sprawling:

```css
#table { width:min(100%,980px); aspect-ratio:1.55; height:auto; max-height:100%;
         border-radius:50%/42%; /* unchanged */ }
```

When `max-height` clamps on a short viewport the oval simply flattens; that degrades correctly. Seat
positions (`.seat.north/.east/.south/.west`) do not change — the seats read as a group again because the
felt is the right size, not because they moved.

## 5. Centre medallion

New markup inside `#table`, **before** `#trick` so played cards stack above it:

```html
<div id="medallion" data-mode="full" aria-hidden="true">
  <div class="med-label"></div>
  <div class="med-main"></div>
  <div class="med-sub"></div>
  <div class="med-bar"><i></i></div>
  <div class="med-chips"></div>
</div>
<div id="trick-count" aria-hidden="true"></div>
```

`aria-hidden` on both: the action bar and the `aria-live` table log already narrate this state, and a screen
reader must not hear it twice. This matches how `cardEl()` treats non-interactive cards.

New `renderMedallion()`, called from `renderGame()` before `renderHand()`. Two modes on `data-mode`:

| phase | mode | label | main | sub | bar | chips |
|---|---|---|---|---|---|---|
| `bidding` | full | `AUCTION` | `highBid` or `—` | `held by <name>` / `no bid yet` | hidden | bonus `3♦ = 30`, `min next <n>`\* |
| `trumpSelect` | full | `BID WON` | `<bid>` | `<declarer> is choosing trump` | hidden | bonus |
| `partnerSelect` | full | `TRUMP <suit>` | `<bid>` | `<declarer> is calling a partner` | hidden | bonus |
| `playing`, `trickEnd` | strip | `<suit> TRUMP` | `<bid> to make` | — | `dPts / bid` | bonus |
| `roundEnd` | full | `DEAL OVER` | `MADE` / `SET` | `<names> captured <dPts>/<bid>` | `dPts / bid` | — |
| `matchOver` | full | unchanged from `roundEnd` (the modal covers it) | | | | |

\* The minimum next bid is only on the wire as `view.you.minBid`, and only while *you* are the required
bidder (`buildView` sets it under `ra.kind === "bid"`). Render that chip when `view.you.minBid != null` and
omit it otherwise — do **not** recompute it client-side.

- **full** — centred plaque, `translate(-50%,-50%)`, vertical stack, `--t-3xl` main.
- **strip** — one horizontal line pinned at `top:20%` of the felt (under the north seat, above the trick
  cross), `--t-md`, so the four played cards own the centre. Cross-fade between modes with
  `transition:opacity .18s`; no layout animation.
- Progress bar `i` width = `min(1, dPts/bid) * 100%`, where `dPts = capturedPoints[declarer] + capturedPoints[partner]`.
  Only computed when `teamsRevealed` — `playing` cannot be reached before that, so the guard is cheap.
- `#trick-count` sits below the cross: `Trick <n> / 13`, where
  `done = tricksWon.reduce((a,b)=>a+b,0)` and `n = Math.min(13, done + (phase === "playing" ? 1 : 0))`.
  Hidden outside `playing`/`trickEnd`.

**The header's `.contract-badge` is deleted** — markup, CSS and the `#trump-sym`/`#contract-text` writes in
`renderGame()`. Its content now lives in the medallion.

## 6. Seats

Changes inside the existing `for (let pos = 0; pos < 4; pos++)` loop in `renderGame()`:

- **Stat line** (`.seat .meta`): `<b>{capturedPoints[seat]}</b> pts · {tricksWon[seat]} tricks`.
  Deal-wins move out — the scoreboard shows them as pips against the target, which is what "first to 3" needs.
- **Bid chip** — new `.seat .bidchip`, rendered only while `phase === "bidding"`:
  - `!bidActive.includes(seat)` → `PASSED`, class `.out` (dimmed, struck-through weight)
  - `seat === highBidder` → `<b>{bids[seat]}</b> HIGH`, class `.high` (gold)
  - `bids[seat] != null` → `bid {bids[seat]}`
  - else → nothing (has not acted yet)
- **`roleOf()`** returns `{c:"passed", t:"passed"}` instead of `null` for a seat dropped from `bidActive`
  during bidding. Today such a seat renders as blank and looks identical to one that has not acted.
- **Turn indication** upgrades from a box-shadow to: gold ring + 2px lift + the existing timer ring inline
  in the nameplate. The lift goes on `.seat.active .nameplate` — **never on `.seat` itself**, whose
  `transform` is load-bearing for centring (`.seat.west/.east` use `translateY(-50%)`,
  `.north/.south` use `translateX(-50%)`) and would be silently overwritten.
- **Card backs**: keep the stacks and their overlaps; add `<span class="backs-count">{n}</span>` so the
  count is read, not counted. Back face gets a border + inner motif instead of the flat stripe.

## 7. Action zone

`#action-bar` becomes the raised card. No wrapper element — restyle in place so `renderActionBar()` keeps
its current shape.

- `#action-bar { min-height:96px }` (desktop) / `min-height:76px` (≤900px) so phase changes never jump the
  layout. A 4px cue rail on the left edge: gold when `dataset.turn === "you"`, `--line` otherwise.
- `renderActionBar()` sets `bar.dataset.turn = view.you.toAct ? "you" : "other"` as its first act.
- `.prompt` → `--t-lg`/700. `.status` → `--t-md`/`--txt-2`.
- Bid stepper: `.bidval` → `--t-2xl`; `Pass` visually secondary (ghost), `Bid <n>` primary gold.
- Trump picker: four 56×56 tiles, glyph + suit name beneath, keeping the existing `aria-label`s.
- Call-a-card grid: **drop `max-height:150px; overflow-y:auto`** — the action row is `auto`-sized now, so the
  grid can breathe. One labelled row per suit, mini-cards at 44×58 (which is also the `pointer:coarse` size,
  so the two stop disagreeing).

## 8. Hand

- Un-clipped by §4. Desktop cards 72×102 → 78×110.
- **Arc.** `renderHand()` sets two custom properties per card after the loop:
  ```js
  const n = wrap.children.length;
  [...wrap.children].forEach((el, i) => {
    const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;          // -1 … +1
    el.style.setProperty("--rot", (t * 7).toFixed(2) + "deg");
    el.style.setProperty("--dy", (t * t * 10).toFixed(1) + "px");
  });
  ```
- **One composed transform**, so the hover lift cannot fight the rotation:
  ```css
  #my-hand .card { --lift:0px; transform-origin:50% 130%;
                   transform:rotate(var(--rot,0deg)) translateY(calc(var(--dy,0px) + var(--lift))); }
  #my-hand .card.playable { --lift:-8px; }                       /* legal cards sit proud */
  @media (hover:hover) { #my-hand .card.playable:hover { --lift:-26px; } }
  #my-hand .card.playable:focus-visible { --lift:-26px; }
  #my-hand .card.playable:active { --lift:-14px; }
  ```
  The hover rule stays inside `@media (hover:hover)` — `test/pwa.test.js:196` checks that, and on iOS the
  state sticks after a tap.
- **Legal set reads instantly**: `.playable` gets the 8px lift above plus
  `filter:drop-shadow(0 0 8px rgba(232,196,90,.55))`. Deliberately `filter`, not `box-shadow` — `.trumpcard`
  and `.bonuscard` already own `box-shadow` for their rings and must keep it. `.illegal` keeps its grayscale
  and drops to `opacity:.8`.
- **Suit seams**: while building, a card whose suit differs from the previous card gets `.suit-start`
  → `margin-left:-6px` instead of `-22px`. Hands arrive sorted by suit then rank (`engine.js:41`), so this is
  a pure read of existing order.

## 9. Engine — `G.bids` (the one server-side change)

```
engine.js:77   state init      → add  bids:[null,null,null,null]
engine.js:112  startBidding    → add  G.bids = [null,null,null,null];
engine.js:136  applyBid (bid)  → add  G.bids[p] = value;
engine.js:492  publicView      → add  bids: G.bids.slice(),
```

A pass does **not** write to `bids`; the seat leaving `bidActive` is what marks it passed. That keeps
`bids[p]` a number-or-null and lets the client tell "passed" from "hasn't acted yet" without a sentinel.
A player who raises overwrites their own entry — latest bid is what the table wants to see.

`redeal()` routes through the same `startBidding` reset, so bids clear between deals for free. This is the
only change outside `public/index.html`; `room.js` and both adapters are untouched, because `publicView`
flows through `buildView` verbatim.

## 10. Sidebar

- **Scoreboard** keeps `<table class="score">` — a table is the right element for standings and screen
  readers already handle it. Additions: a `.pips` cell rendering deal-wins as `● ● ○` against
  `consts.TARGET_GAMES` — pips when `TARGET_GAMES <= 5`, plain `n / K` text at 7 where seven glyphs would
  not fit the column — and rows tinted by side (`.side-d`/`.side-o` left accent rail) once
  `teamsRevealed`, replacing the current `.dot`.
- **`#contract-line`** becomes the contract progress bar (same data, bar instead of prose).
- **`#settings-line`** renders as small chips; the `⚙ Change` mini-button stays.
- **Log** gets a left accent rail per entry class and `--t-sm` line height 1.55. `syncWindow()` is untouched.
- **Chat stops claiming half the panel when empty**: `#sec-log { flex:1.4 1 0; min-height:140px }`,
  `#chat-section { flex:1 1 0; min-height:180px }`.

## 11. Header

- `.contract-badge` deleted (§5).
- Title block: `TRUMP` + a live line replacing the static tagline — `Deal {roundNumber} · first to {TARGET_GAMES}`.
- Weight hierarchy instead of four identical gold buttons: `4-Color` and `?` as quiet icon toggles
  (`aria-pressed` preserved on 4-Color), `Stand Up` muted, `Leave` outlined in `--danger`.
- The elements stay `<button>` inside `<header>`, so the `header button` sizing rules — including the
  `pointer:coarse` 44px floor — keep applying unchanged.

## 12. Join + lobby

- **Join**: the solo path and the friends path become two sibling `.panel` cards instead of two `<h2>`s
  separated by a hand-rolled divider inside one panel. Name field sits above both. `#join-record` keeps its
  place and its silent-failure behaviour.
- **Lobby**: room code as a copy-ticket (code + `Copy invite link` inline, `Share…` beside it when
  `navigator.share` exists); seat rows gain a circular initial avatar; host-only actions group to the right
  of the row, away from `Sit here`/`Stand`.
- No behavioural change: every `send()` call, `confirm()` guard and control id stays as it is.

## 13. Mobile / tablet

- Bottom sheet, tab bar and `--kb` keyboard lift are untouched.
- Medallion: full mode scales to `--t-xl` main; strip mode stays a single line.
- `#action-bar` capped at `min-height:76px` so it never eats the felt.
- Every new control inherits the existing `@media (pointer:coarse)` floors; new controls that do not match
  an existing selector (`.hdr-btn`, `.med-*`, `.bidchip`) get explicit 44px min-heights where tappable.
  Non-interactive additions (`.bidchip`, `.backs-count`, `#trick-count`) need no floor.

## 14. Constraints the redesign must not break

`test/pwa.test.js` parses the stylesheet's **declarations** per media context, so these are load-bearing:

| assertion | requirement |
|---|---|
| `pwa.test.js:170` | `#game` declares `height` twice, ending in `dvh` |
| `pwa.test.js:173` | no `height:min(<n>vh…)` anywhere — sheets use `dvh` |
| `pwa.test.js:159` | `aside` is never `display:none` inside `(max-width:900px)` |
| `pwa.test.js:178` | `#conn`, `#awaybar`, `#sheet-tabs`, `header` reference `env(safe-area-inset-*)` |
| `pwa.test.js:182` | `aside` bottom inside the phone query references `safe-area-inset-bottom` **and** `--kb` |
| `pwa.test.js:186` | `#bottom` `padding-bottom` references `safe-area-inset-bottom` |
| `pwa.test.js:~87` | winning `min-height` ≥40px (phone) / ≥44px (coarse) for `.btn`, `.act-btn`, `.mini-btn`, `.segbtn`, `.emote-btn`, `#chat-input`, `#chat-send`, `header button` |
| `pwa.test.js:196` | hover effects live inside `@media (hover:hover)` |
| `pwa.test.js:151` | suit colours come from CSS classes, never inline styles |
| `pwa.test.js:219` | `#chat-empty` stays outside `#chat-log` (the live region holds only real messages) |
| `client.test.js` | the client's protocol vocabulary still matches `room.js` — message types, `EMOTES`, option lists, view fields |

Behavioural invariants that are easy to break while moving DOM around, and must survive:

- `renderHand()`'s `_sig` short-circuit and focus restoration (an `aria-live` rebuild mid-turn drops the
  user out to `<body>`).
- `syncWindow()` diffing for `#log` and `#chat-log`.
- `aria-label`s on cards (`"Play ace of spades"`), call-grid cards and emote buttons.
- The card `<button>` elements — cards are keyboard-operable controls, not clickable divs.

## 15. New tests

- `test/engine.test.js` — `publicView().bids` is length 4; after an auction `bids[highBidder] === highBid`;
  a seat that passed is absent from `bidActive`; `bids` is cleared at the start of each deal.
- `test/client.test.js` — `bids` joins the pinned view-field vocabulary.
- `test/pwa.test.js` — **regression pin for the bug this redesign fixes**: `#game`'s winning
  `grid-template-rows` declares three tracks, and `aside`'s `grid-row` ends at line 4. Structural, not
  formatting: parse the declaration, count the tracks.

## 16. Verification

`npm test` cannot see layout — there is no DOM harness and adding one would mean a dependency. So each
milestone is verified twice:

1. `npm run build:assets && npm test` — green (currently 67 tests).
2. **Visual check in a real browser** via the Playwright MCP against `node server.js` on `:3000`:
   solo game (`Play vs 3 Bots`) screenshotted at **1920×1080** and **390×844**, in the phases
   `bidding`, `playing`, `roundEnd`. Confirm per milestone: no clipped hand, no horizontal scroll, the
   medallion is legible and does not collide with the trick cross, the action card does not jump between
   phases, and the bottom sheet still opens over the table on the phone viewport.

This closes the gap ROADMAP M7 left open ("NOT visually verified on a device — no browser here").

## 17. Milestones

Each is one commit, each ends with `npm run build:assets && npm test` green plus the screenshots in §16.

| # | scope | files |
|---|---|---|
| **M1** | Layout spine: 3-row grid, `aside` row span, felt sizing, tokens, header restyle + `.contract-badge` removal | `public/index.html` |
| **M2** | Medallion (both modes) + `#trick-count` + `renderMedallion()` | `public/index.html` |
| **M3** | `G.bids` + engine tests; seat bid chips, `PASSED` role, tricks-won stat line, backs count | `engine.js`, `test/engine.test.js`, `test/client.test.js`, `public/index.html` |
| **M4** | Action zone (cue rail, min-height, stepper, trump tiles, un-scrolled call grid) + hand (arc, composed transform, playable glow, suit seams) | `public/index.html` |
| **M5** | Sidebar: standings + pips + contract bar + log rails + chat/log flex | `public/index.html` |
| **M6** | Join + lobby screens | `public/index.html` |
| **M7** | Mobile/tablet pass, `pwa.test.js` grid regression pin, full-matrix screenshots | `public/index.html`, `test/pwa.test.js` |

M1 alone fixes the clipped hand and is worth shipping even if the rest slips.

## 18. Out of scope

Motion beyond the existing `dealIn` and the medallion cross-fade (DX3); any new palette or typeface (DX1);
sound; card art; spectator-specific views; anything touching `room.js`, `server.js`, `src/worker.js` or the
protocol; the root `index.html` single-player game (D12 — it stays untouched and byte-identical to
`public/solo.html`).
