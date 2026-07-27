# Project structure — design

**Date:** 2026-07-27
**Status:** approved design, ready for an implementation plan
**Supersedes:** ROADMAP.md decision D12 (see "Decision log")

## Problem

The backend core is well factored — `engine.js` and `room.js` are pure state machines and the
`server.js` / `src/worker.js` adapters only execute effects. Everything around that core is not:

| Problem | Evidence |
|---|---|
| The client is one unmaintainable file | `public/index.html` = 1921 lines: ~675 CSS, ~125 markup, **1094 lines of JS** covering networking, routing, SVG card drawing, board render, lobby, chat, layout fitting and PWA |
| The solo game duplicates the engine | root `index.html` re-implements `buildDeck`/`shuffle`/`beats`/`legalCards`/`cardPoints`/AI against a mutable `state` global. It has drifted: `Math.random()` deals instead of the CSPRNG, no `hard`/PIMC AI, no `targetDeals` |
| Flat root | `engine.js`, `room.js`, `server.js`, `index.html`, `schema.sql` all at top level next to config |
| Two module systems | CommonJS at root, ESM in `src/`, glued by a `src/package.json` marker |
| Client logic is untestable | `client.test.js` and `pwa.test.js` regex the HTML **as text**, because no client code can be imported |

Goals, in the user's stated priority: make adding client features tractable; make the repo navigable;
kill the engine duplication; make client logic testable.

Non-goals: changing gameplay rules, the wire protocol, the effects/adapter architecture, or the
hibernation/persistence design (D1–D11 stand).

## Target layout

```
app/                          ← Cloudflare [assets] dir; everything the browser is served
  index.html                  multiplayer shell — markup only
  solo.html                   single-player shell — markup only
  sw.js
  manifest.webmanifest
  icon-192.png  icon-512.png  icon-maskable-512.png  apple-touch-icon.png  favicon-32.png
  css/
    tokens.css                custom properties, colour system, 4-colour deck overrides
    base.css                  reset, typography, buttons, form controls, toast
    table.css                 felt, medallion, trick cross, hand, cards
    panels.css                lobby, scoreboard, log, chat, bottom sheet
    responsive.css            media queries, safe areas, coarse pointer
  js/
    core/engine/              ← SHARED with server + worker. One copy, no build step.
      constants.js  random.js  cards.js  scoring.js  log.js
      match.js  bidding.js  contract.js  play.js
      ai/heuristic.js  ai/pimc.js  ai/index.js
      flow.js  index.js
    session.js  net.js  main.js  solo.js  pwa.js  share.js
    screens/  join.js  lobby.js  game.js
    ui/       hand.js  actionbar.js  chat.js  log.js  modals.js  layout.js
    cards/    deck.js  icons.js  labels.js
    util/     dom.js  prefs.js

src/
  core/room/  constants.js  ids.js  seats.js  timers.js  drive.js
              membership.js  handlers.js  view.js  index.js
  server/     index.js  config.js  http.js  registry.js  sockets.js
  worker/     index.js  origin.js  stats.js  room-do.js

test/  scripts/  docs/  schema.sql  wrangler.toml  package.json
```

Deleted: root `index.html`, `public/` (renamed), `src/package.json`, `src/worker.js`,
`engine.js`, `room.js`, `server.js`.

### Why the engine lives under `app/`

Without a bundler, anything the browser imports must be reachable over HTTP, and the Cloudflare
`[assets]` directory is the only thing served. Putting the engine there means **one file on disk**,
imported by the browser as `/js/core/engine/index.js` and by Node/Worker as a relative path. The
alternative — authoritative copy in `src/`, generated copy in the served dir — would reintroduce
exactly the two-copies-drift problem this work exists to remove.

`src/core/room/` deliberately does **not** move into `app/`: the room state machine is server-only
and must never ship to a client.

## Module boundaries

### `app/js/core/engine/` — game rules and AI

Split from today's `engine.js` (514 lines). Strictly acyclic; each layer may import only from
layers above it.

| Layer | Module | Contents |
|---|---|---|
| L0 | `constants.js` | `SUITS RANKS NUM_PLAYERS MIN_BID MAX_BID BID_STEP TOTAL_POINTS TARGET_GAMES MAX_REDEALS` |
| L1 | `random.js` | `randomInt` (CSPRNG), `shuffle`, `shuffleFast` |
| L1 | `cards.js` | `buildDeck sameCard rankLabel cardStr sortHand beats winningIndex` |
| L1 | `log.js` | `logG`, `name` |
| L2 | `scoring.js` | `cardPoints trickPoints sideOf defenders` |
| L3 | `match.js` | `createMatch startMatch nextDeal deal endRound publicView` |
| L4 | `bidding.js` | `findBidActor minNextBid bidIsLegal applyBid advanceBidding forceBid finalizeDeclarer` **and `redeal`** |
| L4 | `contract.js` | `applyTrump callableCards callIsLegal applyCall beginPlay` |
| L4 | `play.js` | `legalCards playIsLegal applyPlay advanceTrick`; `resolveTrick` is module-private (`applyPlay` calls it; nothing outside does) |
| L5 | `ai/heuristic.js` | `aiBidEstimate aiBidDecision aiPickTrump aiPickPartner chooseAICard` |
| L5 | `ai/pimc.js` | `cardKey determinize rolloutClone playOutRound choosePIMCCard PIMC_PLAY_BUDGET` |
| L6 | `flow.js` | `requiredActor` |
| L7 | `ai/index.js` | `aiActionFor` (imports `flow.js` and both AI modules) |
| L8 | `index.js` | barrel — re-exports today's exact public surface |

Two relocations are what make the graph acyclic, and both must be done:

1. **`redeal` moves from the match-lifecycle group into `bidding.js`.** Today `advanceBidding()`
   calls `redeal()` and `redeal()` calls `forceBid()` — a cycle between the two groups. `redeal`
   is the everyone-passed auction path, so it belongs with bidding; it then needs only `deal` from
   `match.js`, leaving a single edge `bidding → match`.
2. **`requiredActor` and `aiActionFor` move to a top dispatch layer.** Both switch on `G.phase`
   and reach into every phase module, so they cannot sit inside one of them.

`index.js` must re-export exactly this surface, unchanged, so `src/core/room/` and the engine tests
need no edits beyond the import path:

```js
SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP, TOTAL_POINTS, TARGET_GAMES, MAX_REDEALS,
createMatch, startMatch, nextDeal,
applyBid, bidIsLegal, minNextBid, findBidActor,
applyTrump, applyCall, callIsLegal, callableCards,
applyPlay, playIsLegal, advanceTrick, legalCards,
aiActionFor, requiredActor, publicView,
cardPoints, sameCard, sideOf, defenders, cardStr, rankLabel,
choosePIMCCard, randomInt, _determinize
```

**Consumers outside the engine** — `src/core/room/`, `app/js/solo.js`, the tests — import the barrel
(`import * as E from ".../core/engine/index.js"`) and never a leaf module. **Modules inside the
engine** always import leaves directly; importing the barrel from within would create a cycle.

### `src/core/room/` — room state machine

Split from `room.js` (550 lines). The public surface (`index.js` barrel) is unchanged:

```js
createRoom, join, disconnect, message, fireTimers, nextTimerDue, buildView, reconcile,
normCode, randId, cleanName,
SEAT_LABEL, EMOTES, DIFFICULTIES, TARGET_DEAL_CHOICES, TURN_TIMER_CHOICES,
MAX_PLAYERS_PER_ROOM, DEFAULT_DELAYS
```

| Module | Contents |
|---|---|
| `constants.js` | `SEAT_LABEL EMOTES DIFFICULTIES TARGET_DEAL_CHOICES TURN_TIMER_CHOICES MAX_PLAYERS_PER_ROOM CHAT_MAX_LEN CHAT_RING NAME_MAX MAX_KICKED DEFAULT_DELAYS` |
| `ids.js` | `codePoints cleanName normCode randId` |
| `seats.js` | `playerList connectedCount seatIsLiveHuman seatedHumans reassignHost promoteSpectators releaseSeat resetReady freeSeatFor applyPendingSeats` |
| `timers.js` | `setTimer clearTimersOfKind sameData nextTimerDue fireTimers GAME_TIMER_KINDS` |
| `drive.js` | `drive aiAct dealNext` |
| `membership.js` | `createRoom join disconnect reconcile isKicked recordKick` |
| `handlers.js` | `message handleSettings handleSit handleKick handleGameAction startMatch` |
| `view.js` | `buildView` |

### `src/server/` and `src/worker/`

| Module | Contents |
|---|---|
| `server/config.js` | env parsing (`PORT MAX_ROOMS ALLOW_ORIGIN TRUST_PROXY DELAYS MSG_RATE MAX_SOCKETS_PER_IP JOIN_GRACE_MS`), `clientIp` |
| `server/http.js` | static file serving from `app/`, MIME map, `/health` |
| `server/registry.js` | rooms `Map`, `newRoomCode getOrCreateRoom reclaimEmptyRoom deleteRoom armTimer applyFx` |
| `server/sockets.js` | `WebSocketServer` lifecycle, origin check, per-IP cap, rate limit, `detach handleMessage handleClose`, keep-alive ping |
| `server/index.js` | bootstrap: create server, wire the above, listen, print LAN address |
| `worker/origin.js` | `okOrigin` |
| `worker/stats.js` | D1 read/write, `/stats` handler |
| `worker/room-do.js` | `RoomDO` class (hibernation, alarms, persistence) |
| `worker/index.js` | default export `fetch`, routing; re-exports `RoomDO` |

`server/http.js` keeps the existing traversal guard (`path.normalize` + prefix check) and MIME map
verbatim — both already handle nested paths and `.js`/`.css`. Only `PUB` changes to `app/`. One fix:
`Cache-Control: no-cache` currently applies to `index.html` by exact name; it must apply to **any**
`.html` so `solo.html` is not served stale.

### `app/js/` — client

~1094 lines of JS become 20 modules (19 in M4; `solo.js` lands in M5).

| Module | Contents |
|---|---|
| `session.js` | the mutable session object `S` (below), `myUid`, session-token persistence, `leaveRoom`, `mintCode` |
| `net.js` | `connect scheduleReconnect send serverNow onMsg` dispatch, backoff constants |
| `screens/join.js` | `doJoin doSolo`, lifetime-stats fetch, leave notices |
| `screens/lobby.js` | `renderLobby renderSettings miniBtn` |
| `screens/game.js` | `render renderGame renderMedallion renderScoreboard`, `sideOf activeSeat roleOf`, orientation helpers (`orient seatAtPos posOfSeat`) |
| `ui/hand.js` | `renderHand fitHand` |
| `ui/actionbar.js` | `renderActionBar bannerForPlay addBanner divStatus phaseLabel` |
| `ui/chat.js` | `renderChat showEmote noteChatActivity updateChatBadge openSheet closeSheet`, iOS keyboard handling |
| `ui/log.js` | `renderLog syncWindow` |
| `ui/modals.js` | `showMatchOver showHelp showSettingsModal setModal hideOverlay` |
| `ui/layout.js` | `fitTable`, resize re-measure, `tickTimers` live countdowns |
| `cards/deck.js` | `suitPath courtFigure cardFace cardEl`, pip layout constants |
| `cards/icons.js` | `ICONS REACTIONS icon reactionIcon reactionName paintIcons` |
| `cards/labels.js` | `RANK_NAME SUIT_NAME SUIT_KEY cardName suitSvg suitSpan cardSpan textWithCards` |
| `util/dom.js` | `$ esc toast nameHue paintAvatar avatarHtml` |
| `util/prefs.js` | `setFourColor` and localStorage-backed preferences |
| `share.js` | `inviteUrl`, copy/share |
| `pwa.js` | service worker registration, install prompt |
| `main.js` | bootstrap, first paint, `?room=` handling, `paintIcons`, global listeners |
| `solo.js` | single-player controller over `core/engine` (M5) |

#### Shared mutable state: the `S` object

Today's client keeps `let ws, view, myPid, mySeat, roomCode, humanBidValue, bidCtxKey,
reconnectTimer, wantConnected, autoStartSolo, startingSolo, serverSkew, creating, createPrivate,
createTries, myName` as file-scope globals that every function reads and writes.

ESM `let` exports are live but **read-only for importers**, so they cannot be reassigned across
module boundaries. `session.js` therefore exports one mutable object:

```js
export const S = {
  ws: null, view: null, myPid: null, mySeat: null, roomCode: null,
  humanBidValue: null, bidCtxKey: null, reconnectTimer: null, wantConnected: false,
  autoStartSolo: false, startingSolo: false, serverSkew: 0,
  creating: false, createPrivate: false, createTries: 0, myName: "",
};
```

Call sites become `S.view`, `S.mySeat`, … — a mechanical rename, not a rewrite. Purely local state
(`reconnectDelay`, `toastT`, `ringEl`, `tickHandle`, `unreadChat`, `lastChatLen`) stays module-scoped
in whichever module owns it, and is **not** added to `S`.

### CSS

The ~675-line `<style>` block splits into the five files listed above, loaded as five ordered
`<link>` tags — not `@import`, which serialises requests. Cascade order is
`tokens → base → table → panels → responsive` and must be preserved in both HTML shells.

## Module system

The whole repo becomes ESM: `"type": "module"` in the root `package.json`, and `src/package.json`
deleted. This is forced rather than chosen — the browser needs the engine as ESM, and CommonJS
cannot reliably `require()` ESM on Node 20, which the CI matrix still tests.

All relative imports use explicit `.js` extensions (required by Node's ESM resolver and by browsers).

## Build pipeline

`scripts/build-assets.js` changes job. It no longer byte-copies `index.html → solo.html`; `solo.html`
becomes a real source file. Instead it:

1. Walks `app/`, skipping `sw.js` itself, to produce the service worker's `SHELL` array.
2. Hashes each shell file's path + contents into `VERSION`.
3. Rewrites both constants in `app/sw.js`.

Exports stay `{ shellVersion, check, build, SHELL }` so `test/pwa.test.js` keeps working, and
`--check` still fails CI when the generated constants are stale.

This is a net improvement: today a new client file could be silently omitted from the precache;
auto-walking makes that impossible.

Config updates: `wrangler.toml` `[assets] directory = "./app"` and `main = "src/worker/index.js"`;
`package.json` `start` → `node src/server/index.js`, `test` → `node --test test/`.

## Tests

Existing suites convert to ESM imports. Beyond path edits:

| File | Change |
|---|---|
| `engine.test.js`, `ai.test.js`, `room.test.js` | import path only — the barrels preserve the API |
| `client.test.js` | scans `app/js/**/*.js` instead of `public/index.html` for the protocol-vocabulary comparison against `src/core/room/**` |
| `pwa.test.js` | reads `app/*.html` and `app/css/*.css`; the `solo.html ≡ index.html` byte-equality test is **deleted** |
| `worker.test.js` | import path only |

New tests the split makes possible:

- **Unit tests on pure client modules** — `cards/labels.js` (card and suit text), `cards/deck.js`
  (SVG output for each rank and suit), `util/dom.js` (`esc` covers `& < > " '`).
- **Engine drift guard** (replaces the byte-equality test): `app/solo.html` and `app/js/solo.js`
  must import `core/engine` and must not themselves define `buildDeck`, `shuffle`, `beats`,
  `legalCards` or `cardPoints`. This is what keeps the dedup from silently regressing.
- **Precache completeness**: every `.js` and `.css` file under `app/` appears in the SW `SHELL`.

Optional ratchet, easy to drop if it becomes noise: assert no file under `app/js/` or `src/` exceeds
300 lines.

## Migration stages

Each stage is independently committable with the full suite green. Work may stop after any stage.

### M1 — Rename and module system

- `git mv public app` (verbatim; no content changes).
- Root `package.json` gains `"type": "module"`; `src/package.json` deleted.
- Convert `engine.js`, `room.js`, `server.js`, `src/worker.js` and all of `test/` from CJS to ESM
  (`require` → `import`, `module.exports` → `export`), files otherwise unchanged.
- Update `wrangler.toml` `[assets]`, `server.js`'s `PUB`, `scripts/build-assets.js` paths,
  test paths.
- **Done when:** `npm test` green, `npm start` serves the game, `wrangler dev` serves the game.

### M2 — Engine split

- `engine.js` → `app/js/core/engine/**` per the layer table, including the `redeal` and
  `requiredActor` / `aiActionFor` relocations.
- `index.js` barrel re-exports the surface listed above.
- Room, server and worker update their import path only.
- **Done when:** `npm test` green with zero changes to `engine.test.js` / `ai.test.js` beyond the
  import path.

### M3 — Room and adapter split

- `room.js` → `src/core/room/**`; `server.js` → `src/server/**`; `src/worker.js` → `src/worker/**`.
- Apply the `.html` `Cache-Control` fix in `server/http.js`.
- **Done when:** `npm test` green; both backends serve a full match end to end.

### M4 — Client split

Highest-risk stage: the suite is thin on client rendering, so behaviour preservation leans partly on
manual play. Extract in dependency order, keeping the page runnable and committing after each step:

1. `util/dom.js`, `util/prefs.js`, `cards/labels.js`, `cards/icons.js`, `cards/deck.js` (leaves, no
   dependency on session state)
2. `session.js` (the `S` object) and the mechanical rename of all globals to `S.*`
3. `net.js`, `share.js`, `pwa.js`
4. `ui/*`, then `screens/*`, then `main.js`
5. `<style>` → `app/css/*.css`, five ordered `<link>` tags
6. `scripts/build-assets.js` rewritten to walk `app/`; `client.test.js` and `pwa.test.js` rewritten;
   new unit tests added

- **Done when:** `npm test` green, and a manual pass covers join, create private room, lobby
  settings, sit/stand/kick, a full deal (bid → trump → call → 13 tricks), chat, emotes, 4-colour
  deck, mobile bottom sheet, offline reload.

### M5 — Solo on the shared engine

- Rewrite `app/solo.html` (markup) and `app/js/solo.js` (controller) against `core/engine`,
  reusing `cards/*`, `ui/*` and `css/*`.
- Delete root `index.html`.
- Add the engine drift guard test.
- **Behaviour changes, intentionally:** solo deals come off the CSPRNG rather than `Math.random()`;
  `hard`/PIMC AI becomes selectable; `targetDeals` (3/5/7) becomes selectable.
- **Done when:** `npm test` green; solo plays a full match offline through the service worker.

### M6 — Documentation

- README gains a repo-structure section; run/deploy commands updated.
- ROADMAP records D12 as superseded and adds the decisions below.
- A short structure map for future sessions (which module owns what).

## Decision log

| # | Decision | Why | Rejected alternative |
|---|---|---|---|
| S1 | Native ES modules, no bundler | ~1100 lines of client JS does not need one; keeps edit-and-reload dev and zero-build deploy; HTTP/2 makes ~19 files free; the SW precaches them on first visit anyway | esbuild bundle to `public/app.js` — adds a devDependency, a mandatory pre-deploy build, and generated files in the deploy dir |
| S2 | Engine lives inside the served dir (`app/js/core/engine/`) | Without a bundler, anything the browser imports must be served. One file on disk means drift is structurally impossible | Authoritative `src/core/engine/` + generated copy in `public/` — reintroduces two copies, and edits to the wrong one get silently overwritten |
| S3 | `public/` renamed to `app/` | It now holds real application source, not static junk | Keeping the name `public/` — misleading once the engine lives there |
| S4 | Whole repo goes ESM | Forced: the browser needs ESM, and CJS cannot reliably `require()` ESM on Node 20 (still in the CI matrix) | Dual CJS/ESM via the `src/package.json` marker — the current hack, doesn't scale to a browser consumer |
| S5 | Shared client state in one exported mutable object `S` | ESM `let` exports are read-only for importers; an object keeps the diff mechanical and makes state ownership explicit | Getter/setter pairs per field (ceremony), or a full store/observer layer (over-engineered for this size) |
| S6 | `src/core/room/` stays out of `app/` | Room logic is server-only and must never ship to a client | Putting all core under `app/` for symmetry |
| S7 | Five ordered `<link>` tags for CSS | `@import` serialises requests | One ~675-line stylesheet — same problem the JS had |
| S8 | SW `SHELL` auto-generated by walking `app/` | A hand-maintained list would silently omit new modules | Hand-maintained array |
| S9 | Root `index.html` deleted; solo served from `app/solo.html` | Removes the duplicated engine; offline play still works via the service worker | Keeping it as a self-contained file — that *is* the duplication |
| S10 | D12 ("root `index.html` stays untouched") superseded | The user chose correctness/dedup as an explicit driver; the duplicate has already drifted (`Math.random()` deals, no hard AI, no `targetDeals`) | Leaving D12 in force — leaves a known-drifted rules copy in the repo |

## Known costs

- **`file://` play is lost.** Root `index.html` can currently be opened directly from disk with no
  server; ES modules are blocked over `file://`, so solo play requires a real origin. Offline play is
  unaffected — the service worker already serves it from cache, which is how the PWA works today. This
  workflow is not documented in the README, so nothing shipped depends on it.
- **Solo behaviour changes** (M5) as listed above. All three changes are improvements, but they are
  changes.
- **M4 carries real regression risk** in client rendering, mitigated by incremental extraction and a
  manual pass checklist rather than by tests alone.
