# Project Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 1921-line client, 514-line engine and 550-line room core into focused ES modules, unify the repo on ESM, and delete the duplicated game engine in the solo game.

**Architecture:** Every split uses **extract-and-delegate**: create the new module, have the old file import and re-export from it, run the tests, commit. The old file shrinks to a re-export shim, then consumers are repointed and the shim is deleted. This keeps `npm test` green at every single commit and makes every task independently revertable.

**Tech Stack:** Node 20/22, ES modules (no bundler, no transpiler), `node --test`, `ws`, Cloudflare Workers + Durable Objects, Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-07-27-project-structure-design.md`

## Global Constraints

- **No new runtime dependencies.** `ws` stays the only one. No bundler, no transpiler, no framework.
- **No new devDependencies.** `wrangler` stays the only one.
- **ES modules everywhere.** Root `package.json` has `"type": "module"`. Every relative import carries an explicit `.js` extension — required by both Node's ESM resolver and browsers.
- **`npm test` must pass at the end of every task.** A task is not done until it does.
- **No gameplay, protocol, or wire-format changes** in Tasks 1–20. The only intentional behaviour change in the whole plan is Task 21 (solo on the shared engine).
- **Engine import discipline:** consumers outside `app/js/core/engine/` import the barrel `index.js`; modules inside the engine import leaf modules directly (importing the barrel from inside creates a cycle).
- **Comments are load-bearing.** This codebase documents *why* in block comments above the code they explain. When moving code, move its comment with it. Never drop one.
- **Commit after every task**, using the message given in the task's final step.

---

## File Structure

| Path | Responsibility |
|---|---|
| `app/index.html` | Multiplayer shell — markup only |
| `app/solo.html` | Single-player shell — markup only |
| `app/sw.js` | Service worker (SHELL + VERSION generated) |
| `app/css/tokens.css` | Custom properties, colour system, 4-colour deck |
| `app/css/base.css` | Reset, typography, buttons, form controls, toast |
| `app/css/table.css` | Felt, medallion, trick, card, hand |
| `app/css/panels.css` | Lobby, scoreboard, log, chat, bottom sheet |
| `app/css/responsive.css` | All `@media` blocks |
| `app/js/core/engine/*` | Game rules + AI. Shared by browser, Node server and Worker |
| `app/js/session.js` | Mutable session state `S`, uid, token, `leaveRoom`, `mintCode` |
| `app/js/net.js` | Socket connect/reconnect/send, message dispatch |
| `app/js/screens/*` | Join, lobby, game — one module per screen |
| `app/js/ui/*` | Hand, action bar, chat, log, modals, layout |
| `app/js/cards/*` | SVG deck, icons, text labels |
| `app/js/util/*` | DOM helpers, persisted preferences |
| `app/js/main.js` | Bootstrap, first paint, `?room=` handling |
| `app/js/solo.js` | Single-player controller over `core/engine` |
| `src/core/room/*` | Room state machine — server-only, never shipped |
| `src/server/*` | Node + ws adapter |
| `src/worker/*` | Cloudflare Worker + Durable Object adapter |

---

# Milestone 1 — Rename and module system

## Task 1: Rename `public/` to `app/`

**Files:**
- Rename: `public/` → `app/` (git mv, contents unchanged)
- Modify: `wrangler.toml:12` (`[assets] directory`)
- Modify: `server.js:38` (`PUB`)
- Modify: `scripts/build-assets.js:29-31,38` (paths)
- Modify: `test/pwa.test.js:16` (`PUB`)
- Modify: `test/client.test.js:17` (`CLIENT` path)

**Interfaces:**
- Consumes: nothing
- Produces: the `app/` directory that every later task writes into

- [ ] **Step 1: Rename the directory**

```bash
git mv public app
```

- [ ] **Step 2: Update every path that referred to `public/`**

`wrangler.toml` line 12:
```toml
directory = "./app"
```

`server.js` line 38:
```js
const PUB = path.join(__dirname, "app");
```

`scripts/build-assets.js` — lines 29-31 and the `SHELL` entries:
```js
const SOLO_DST = path.join(ROOT, "app", "solo.html");
const SW = path.join(ROOT, "app", "sw.js");

const SHELL = [
  "app/index.html", "app/solo.html", "app/manifest.webmanifest",
  "app/icon-192.png", "app/icon-512.png", "app/icon-maskable-512.png",
  "app/apple-touch-icon.png", "app/favicon-32.png",
];
```

`test/pwa.test.js` line 16:
```js
const PUB = path.join(ROOT, "app");
```

`test/client.test.js` line 17:
```js
const CLIENT = fs.readFileSync(path.join(__dirname, "..", "app", "index.html"), "utf8");
```

- [ ] **Step 3: Regenerate the service worker constants**

The `SHELL` paths changed, so `VERSION` (a hash over path + contents) changes too.

Run: `npm run build:assets`
Expected: prints `built assets · sw cache version trump-<hex>`

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Verify both backends still serve the client**

Run: `npm start`, open `http://localhost:3000`, confirm the join screen renders and the card fan wordmark draws. Stop the server.
Run: `npx wrangler dev`, open the printed URL, confirm the same. Stop it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rename public/ to app/

It now holds application source, not static assets."
```

---

## Task 2: Convert the repo to ES modules

CommonJS and ESM cannot be mixed here — `engine.js`, `room.js`, `server.js` and the tests form one `require` graph, and `src/worker.js` already imports across it. The flip is therefore one atomic commit.

**Files:**
- Modify: `package.json` (add `"type": "module"`, update `start`)
- Delete: `src/package.json`
- Modify: `engine.js`, `room.js`, `server.js`, `src/worker.js`
- Modify: `scripts/build-assets.js`, `scripts/gen-icons.js`
- Modify: all 7 files in `test/`

**Interfaces:**
- Consumes: `app/` from Task 1
- Produces: an all-ESM repo. Every later task uses `import`/`export` exclusively.

- [ ] **Step 1: Declare the package type**

`package.json` — add `"type": "module"` (replacing `"type": "commonjs"`) and leave scripts alone for now:
```json
  "type": "module",
```

- [ ] **Step 2: Delete the ESM marker that is now redundant**

```bash
git rm src/package.json
```

- [ ] **Step 3: Convert `engine.js`**

Delete `"use strict";` (modules are always strict). Replace the `module.exports = {...}` block at the end with a named export list of exactly the same symbols:

```js
export {
  SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP, TOTAL_POINTS, TARGET_GAMES, MAX_REDEALS,
  createMatch, startMatch, nextDeal,
  applyBid, bidIsLegal, minNextBid, findBidActor,
  applyTrump, applyCall, callIsLegal, callableCards,
  applyPlay, playIsLegal, advanceTrick, legalCards,
  aiActionFor, requiredActor, publicView,
  cardPoints, sameCard, sideOf, defenders, cardStr, rankLabel,
  choosePIMCCard, randomInt, determinize as _determinize,
};
```

The `crypto` require near the top becomes:
```js
import crypto from "node:crypto";
```

Note: `randomInt` must keep working in a browser in Milestone 2. Leave that for Task 8 — for now `node:crypto` is correct, since only Node and the Worker import it.

- [ ] **Step 4: Convert `room.js`**

Delete `"use strict";`. Replace `const E = require("./engine");` with:
```js
import * as E from "./engine.js";
```
Replace the `module.exports = {...}` block with:
```js
export {
  createRoom, join, disconnect, message, fireTimers, nextTimerDue, buildView, reconcile,
  normCode, randId, cleanName,
  SEAT_LABEL, EMOTES, DIFFICULTIES, TARGET_DEAL_CHOICES, TURN_TIMER_CHOICES,
  MAX_PLAYERS_PER_ROOM, DEFAULT_DELAYS,
};
```

- [ ] **Step 5: Convert `server.js`**

Delete `"use strict";`. Replace the requires (lines 10-14) with:
```js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as R from "./room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

`__dirname` does not exist in ESM — the two lines above restore it, and `PUB` on line 38 keeps working unchanged.

- [ ] **Step 6: Convert `src/worker.js`**

One line changes — the default import of a now-named-export module:
```js
import * as R from "../room.js";
```

- [ ] **Step 7: Convert the two scripts**

`scripts/build-assets.js`: replace the requires with imports, add the `__dirname` shim (same three lines as Step 5, minus `http`/`ws`), and replace `module.exports = { shellVersion, check, build, SHELL };` with:
```js
export { shellVersion, check, build, SHELL };
```

Replace the CLI entry guard at the bottom:
```js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
```

Apply the same four transformations to `scripts/gen-icons.js`.

- [ ] **Step 8: Convert the tests**

In all 7 files under `test/`, replace requires with imports. Node's built-in test runner is fully ESM-capable. Examples:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as E from "../engine.js";
import * as R from "../room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

Two call sites need care:
- `test/engine.test.js:117` has a lazy `const R = require("../room")` inside a test body. Hoist it to a top-level `import * as R from "../room.js";` and delete the inline require.
- `test/pwa.test.js:257` has a lazy `const { check } = require("../scripts/build-assets")`. Hoist it to a top-level `import { check } from "../scripts/build-assets.js";`.

- [ ] **Step 9: Point `npm start` at the ESM entry**

No path change yet (that is Task 12), but confirm `package.json` scripts read:
```json
    "start": "node server.js",
    "test": "node --test test/",
```

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: all tests pass. If you see `ERR_REQUIRE_ESM` or `require is not defined`, a file was missed — grep for stragglers:

```bash
grep -rn "require(\|module.exports" --include=*.js . | grep -v node_modules
```
Expected: no output.

- [ ] **Step 11: Verify both backends boot**

Run: `npm start` → join screen loads, "Play vs 3 Bots" deals a hand. Stop.
Run: `npx wrangler dev` → same. Stop.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: convert the repo to ES modules

The browser needs the engine as ESM in M2, and CJS cannot reliably
require() ESM on Node 20, which CI still tests. Drops the
src/package.json type marker."
```

---

# Milestone 2 — Engine split

Built bottom-up. After each task `engine.js` imports from the new leaves and re-exports them, so the public surface never changes and the tests never move.

## Task 3: Extract engine constants, randomness and cards

**Files:**
- Create: `app/js/core/engine/constants.js`
- Create: `app/js/core/engine/random.js`
- Create: `app/js/core/engine/cards.js`
- Create: `app/js/core/engine/log.js`
- Create: `app/js/core/engine/scoring.js`
- Modify: `engine.js` (delete the moved definitions, import them instead)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `constants.js` → `SUITS: string[]`, `RANKS: number[]`, `NUM_PLAYERS: 4`, `MIN_BID: 130`, `MAX_BID: 250`, `BID_STEP: 5`, `TOTAL_POINTS: 250`, `TARGET_GAMES: 5`, `MAX_REDEALS: 4`
  - `random.js` → `randomInt(n: number): number`, `shuffle(a: T[]): T[]`, `shuffleFast(a: T[]): T[]`
  - `cards.js` → `buildDeck(): Card[]`, `sameCard(a, b): boolean`, `rankLabel(r: number): string`, `cardStr(c: Card): string`, `sortHand(hand: Card[], trump: string|null): Card[]`, `beats(a, b, lead, trump): boolean`, `winningIndex(trick, lead, trump): number`
  - `log.js` → `logG(G, text: string, cls?: string): void`, `name(G, p: number): string`
  - `scoring.js` → `cardPoints(G, c): number`, `trickPoints(G, trick): number`, `sideOf(G, p): "D"|"O"`, `defenders(G): number[]`
  - `Card` is `{ suit: string, rank: number }` throughout.

- [ ] **Step 1: Create `constants.js`**

Move `engine.js` lines 11-14 verbatim, adding `export`:

```js
export const SUITS = ["♠", "♥", "♦", "♣"];
export const RANKS = [2,3,4,5,6,7,8,9,10,11,12,13,14];
export const NUM_PLAYERS = 4;
export const MIN_BID = 130, MAX_BID = 250, BID_STEP = 5,
             TOTAL_POINTS = 250, TARGET_GAMES = 5, MAX_REDEALS = 4;
```

- [ ] **Step 2: Create `random.js`**

Move `engine.js` lines 16-37 — the `randomInt` function **and the block comment above it explaining why dealing must not use `Math.random`** — plus `shuffle` and `shuffleFast`. Keep `import crypto from "node:crypto";` for now; Task 8 makes it browser-safe.

Export `randomInt`, `shuffle`, `shuffleFast`.

- [ ] **Step 3: Create `cards.js`**

Move `buildDeck` (line 35), `sameCard` (38), `rankLabel` (39), `cardStr` (40), `sortHand` (41-44), `beats` (47-55), `winningIndex` (56). Import what it needs:

```js
import { SUITS, RANKS } from "./constants.js";
import { shuffle } from "./random.js";
```

`buildDeck` returns the unshuffled deck, so it does not need `shuffle` — include the import only if the moved code actually references it, and delete it otherwise. Unused imports are an error in review, not a warning.

- [ ] **Step 4: Create `log.js`**

Move `name` (line 65) and `logG` (line 66), with its 80-entry ring comment.

- [ ] **Step 5: Create `scoring.js`**

Move `cardPoints` (45), `trickPoints` (46), `sideOf` (63), `defenders` (64).

```js
import { NUM_PLAYERS } from "./constants.js";
```

- [ ] **Step 6: Delete the moved code from `engine.js` and import it back**

At the top of `engine.js`, replacing the deleted definitions:

```js
import { SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP,
         TOTAL_POINTS, TARGET_GAMES, MAX_REDEALS } from "./app/js/core/engine/constants.js";
import { randomInt, shuffle, shuffleFast } from "./app/js/core/engine/random.js";
import { buildDeck, sameCard, rankLabel, cardStr, sortHand, beats, winningIndex } from "./app/js/core/engine/cards.js";
import { logG, name } from "./app/js/core/engine/log.js";
import { cardPoints, trickPoints, sideOf, defenders } from "./app/js/core/engine/scoring.js";
```

The `export {...}` list at the bottom is unchanged — re-exporting an imported binding is legal and is exactly what keeps the tests passing.

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: all tests pass, unchanged. `test/engine.test.js` and `test/ai.test.js` were not edited.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: extract engine constants, randomness, cards, scoring"
```

---

## Task 4: Extract the match lifecycle

**Files:**
- Create: `app/js/core/engine/match.js`
- Modify: `engine.js`

**Interfaces:**
- Consumes: `constants.js`, `random.js`, `cards.js`, `log.js`, `scoring.js` (Task 3)
- Produces: `createMatch(names: string[], opts?: {targetDeals?: number}): G`, `startMatch(G): void`, `nextDeal(G): void`, `deal(G): void`, `endRound(G): void`, `publicView(G, seat): object`

- [ ] **Step 1: Create `match.js`**

Move `createMatch` (71-84), `startMatch` (85-89), `nextDeal` (90-94), `deal` (101-117), `endRound` (230-240) and `publicView` (489-504).

**Do not move `redeal` (95-100)** — it goes to `bidding.js` in Task 5. That relocation is what breaks the `match ↔ bidding` cycle, and is mandatory.

```js
import { SUITS, NUM_PLAYERS, TARGET_GAMES, TOTAL_POINTS } from "./constants.js";
import { randomInt, shuffle } from "./random.js";
import { buildDeck, cardStr, sortHand } from "./cards.js";
import { logG, name } from "./log.js";
import { defenders } from "./scoring.js";
```

- [ ] **Step 2: Delete the moved code from `engine.js` and import it back**

```js
import { createMatch, startMatch, nextDeal, deal, endRound, publicView } from "./app/js/core/engine/match.js";
```

`redeal` stays in `engine.js` for now and still calls the imported `deal` and the local `forceBid` — that works fine as an intermediate state.

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: extract the engine match lifecycle"
```

---

## Task 5: Extract bidding, contract and play

**Files:**
- Create: `app/js/core/engine/bidding.js`
- Create: `app/js/core/engine/contract.js`
- Create: `app/js/core/engine/play.js`
- Modify: `engine.js`

**Interfaces:**
- Consumes: Tasks 3-4
- Produces:
  - `bidding.js` → `findBidActor(G): number|null`, `minNextBid(G): number`, `bidIsLegal(G, p, value): boolean`, `applyBid(G, p, value): void`, `advanceBidding(G): void`, `forceBid(G): void`, `finalizeDeclarer(G): void`, `redeal(G): void`
  - `contract.js` → `applyTrump(G, suit): void`, `callableCards(G, p): Card[]`, `callIsLegal(G, card): boolean`, `applyCall(G, card): void`, `beginPlay(G): void`
  - `play.js` → `legalCards(G, p): Card[]`, `playIsLegal(G, p, card): boolean`, `applyPlay(G, p, card): void`, `resolveTrick(G): void`, `advanceTrick(G): void`

- [ ] **Step 1: Create `bidding.js`**

Move `findBidActor` (121-127), `minNextBid` (128), `bidIsLegal` (129-133), `applyBid` (134-142), `advanceBidding` (143-148), `forceBid` (149-154), `finalizeDeclarer` (155-160), **and `redeal` (95-100)**.

```js
import { NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP, MAX_REDEALS } from "./constants.js";
import { logG, name } from "./log.js";
import { deal } from "./match.js";
```

The cycle is now gone: `bidding → match` only. Verify by reading `match.js` — it must contain **no** import from `bidding.js`, `contract.js` or `play.js`.

- [ ] **Step 2: Create `contract.js`**

Move `applyTrump` (164-168), `callableCards` (169-174), `callIsLegal` (175-178), `applyCall` (179-187), `beginPlay` (188-193).

```js
import { SUITS, RANKS, NUM_PLAYERS } from "./constants.js";
import { sameCard, cardStr, sortHand } from "./cards.js";
import { logG, name } from "./log.js";
```

- [ ] **Step 3: Create `play.js`**

Move `legalCards` (57-62), `playIsLegal` (197-200), `applyPlay` (201-213), `resolveTrick` (214-222), `advanceTrick` (223-229).

```js
import { NUM_PLAYERS } from "./constants.js";
import { sameCard, cardStr, winningIndex } from "./cards.js";
import { trickPoints } from "./scoring.js";
import { logG, name } from "./log.js";
import { endRound } from "./match.js";
```

`advanceTrick` calls `endRound` — direction `play → match`, which is allowed.

- [ ] **Step 4: Delete the moved code from `engine.js` and import it back**

```js
import { findBidActor, minNextBid, bidIsLegal, applyBid, advanceBidding, forceBid, finalizeDeclarer, redeal } from "./app/js/core/engine/bidding.js";
import { applyTrump, callableCards, callIsLegal, applyCall, beginPlay } from "./app/js/core/engine/contract.js";
import { legalCards, playIsLegal, applyPlay, resolveTrick, advanceTrick } from "./app/js/core/engine/play.js";
```

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: all tests pass. `test/engine.test.js` covers full playouts, so a broken phase transition fails loudly here.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: extract engine bidding, contract and play phases

redeal moves into bidding.js: advanceBidding called redeal and redeal
called forceBid, which was a cycle between the lifecycle and auction
groups. It is the everyone-passed auction path, so it belongs there."
```

---

## Task 6: Extract the AI and the dispatch layer

**Files:**
- Create: `app/js/core/engine/ai/heuristic.js`
- Create: `app/js/core/engine/ai/pimc.js`
- Create: `app/js/core/engine/flow.js`
- Create: `app/js/core/engine/ai/index.js`
- Modify: `engine.js`

**Interfaces:**
- Consumes: Tasks 3-5
- Produces:
  - `heuristic.js` → `aiBidEstimate(G, p)`, `aiBidDecision(G, p, easy: boolean)`, `aiPickTrump(G, p)`, `aiPickPartner(G, p)`, `chooseAICard(G, p, easy: boolean)`
  - `pimc.js` → `choosePIMCCard(G, me, opts?)`, `determinize(G, me)`, `PIMC_PLAY_BUDGET`
  - `flow.js` → `requiredActor(G): {seat: number, kind: "bid"|"trump"|"call"|"play"} | null`
  - `ai/index.js` → `aiActionFor(G, seat, difficulty: "easy"|"normal"|"hard"|true): object|null`

- [ ] **Step 1: Create `ai/heuristic.js`**

Move `aiBidEstimate` (244-259), `aiBidDecision` (260-266), `aiPickTrump` (267-274), `aiPickPartner` (275-285), `chooseAICard` (286-346). Note the `../` prefix — this file is one directory deeper:

```js
import { SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP } from "../constants.js";
import { sameCard, cardStr, beats, winningIndex } from "../cards.js";
import { cardPoints, sideOf } from "../scoring.js";
import { legalCards } from "../play.js";
import { callableCards } from "../contract.js";
import { minNextBid } from "../bidding.js";
```

Include only the imports the moved code actually references.

- [ ] **Step 2: Create `ai/pimc.js`**

Move `cardKey` (381), `determinize` (386-419), `rolloutClone` (420-434), `playOutRound` (435-448), `PIMC_PLAY_BUDGET` (449), `choosePIMCCard` (451-488), **with the section header comment explaining Perfect Information Monte Carlo**.

```js
import { NUM_PLAYERS } from "../constants.js";
import { sameCard, winningIndex } from "../cards.js";
import { shuffleFast } from "../random.js";
import { cardPoints, trickPoints, sideOf } from "../scoring.js";
import { legalCards, applyPlay, resolveTrick, advanceTrick } from "../play.js";
import { chooseAICard } from "./heuristic.js";
```

- [ ] **Step 3: Create `flow.js`**

Move `requiredActor` (352-362).

```js
import { NUM_PLAYERS } from "./constants.js";
import { findBidActor } from "./bidding.js";
```

This is why `requiredActor` cannot live in `match.js`: it needs `findBidActor` from a lower layer.

- [ ] **Step 4: Create `ai/index.js`**

Move `aiActionFor` (363-380) with its difficulty-string comment.

```js
import { requiredActor } from "../flow.js";
import { aiBidDecision, aiPickTrump, aiPickPartner, chooseAICard } from "./heuristic.js";
import { choosePIMCCard } from "./pimc.js";
```

- [ ] **Step 5: Delete the moved code from `engine.js` and import it back**

```js
import { requiredActor } from "./app/js/core/engine/flow.js";
import { aiActionFor } from "./app/js/core/engine/ai/index.js";
import { choosePIMCCard, determinize } from "./app/js/core/engine/ai/pimc.js";
```

`engine.js` is now nothing but imports and one `export {...}` block.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: all pass. `test/ai.test.js` exercises PIMC directly, including `_determinize`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: extract engine AI and cross-phase dispatch

requiredActor and aiActionFor switch on G.phase and reach into every
phase module, so they cannot live inside one of them."
```

---

## Task 7: Add the barrel and delete `engine.js`

**Files:**
- Create: `app/js/core/engine/index.js`
- Delete: `engine.js`
- Modify: `room.js`, `test/engine.test.js`, `test/ai.test.js`

**Interfaces:**
- Consumes: Tasks 3-6
- Produces: `app/js/core/engine/index.js` — the sole public entry point to the engine

- [ ] **Step 1: Create the barrel**

`app/js/core/engine/index.js` must re-export exactly the surface `engine.js` had — no more, no less:

```js
/* The engine's public surface. Consumers import this file, never a leaf
   module; leaves import each other directly (the barrel would be a cycle). */
export { SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP,
         TOTAL_POINTS, TARGET_GAMES, MAX_REDEALS } from "./constants.js";
export { randomInt } from "./random.js";
export { sameCard, cardStr, rankLabel } from "./cards.js";
export { cardPoints, sideOf, defenders } from "./scoring.js";
export { createMatch, startMatch, nextDeal, publicView } from "./match.js";
export { applyBid, bidIsLegal, minNextBid, findBidActor } from "./bidding.js";
export { applyTrump, applyCall, callIsLegal, callableCards } from "./contract.js";
export { applyPlay, playIsLegal, advanceTrick, legalCards } from "./play.js";
export { requiredActor } from "./flow.js";
export { aiActionFor } from "./ai/index.js";
export { choosePIMCCard, determinize as _determinize } from "./ai/pimc.js";
```

- [ ] **Step 2: Repoint every consumer**

`room.js`:
```js
import * as E from "./app/js/core/engine/index.js";
```

`test/engine.test.js` and `test/ai.test.js`:
```js
import * as E from "../app/js/core/engine/index.js";
```

- [ ] **Step 3: Delete the shim**

```bash
git rm engine.js
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Prove the surface did not drift**

Run:
```bash
node -e "import('./app/js/core/engine/index.js').then(m => console.log(Object.keys(m).sort().join(' ')))"
```
Expected: exactly these 36 names, and no others —

```
BID_STEP MAX_BID MAX_REDEALS MIN_BID NUM_PLAYERS RANKS SUITS TARGET_GAMES TOTAL_POINTS
_determinize advanceTrick aiActionFor applyBid applyCall applyPlay applyTrump bidIsLegal
callIsLegal callableCards cardPoints cardStr choosePIMCCard createMatch defenders
findBidActor legalCards minNextBid nextDeal playIsLegal publicView rankLabel randomInt
requiredActor sameCard sideOf startMatch
```

Compare name by name, not by count — a missing export and an accidental extra one cancel out in a count.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: engine.js becomes app/js/core/engine/"
```

---

## Task 8: Make the engine's randomness browser-safe

`random.js` imports `node:crypto`, which no browser can resolve. The solo game imports the engine in Milestone 5, so this must be fixed before then — and fixing it now keeps `import` graphs honest.

**Files:**
- Modify: `app/js/core/engine/random.js`
- Test: `test/engine.test.js`

**Interfaces:**
- Consumes: Task 3
- Produces: `randomInt(n)` with identical semantics, working in Node, workerd and browsers

- [ ] **Step 1: Write the failing test**

Add to `test/engine.test.js`:

```js
test("randomInt is uniform over [0,n) and uses no node-only import", async () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app", "js", "core", "engine", "random.js"), "utf8");
  assert.ok(!/node:crypto|require\(/.test(src),
    "random.js must not import node:crypto — the browser cannot resolve it");

  const counts = new Array(6).fill(0);
  for (let i = 0; i < 60000; i++) counts[E.randomInt(6)]++;
  for (const c of counts) assert.ok(c > 8000 && c < 12000, `skewed bucket: ${counts}`);
  for (let i = 0; i < 1000; i++) assert.strictEqual(E.randomInt(1), 0);
});
```

`test/engine.test.js` needs `fs`, `path` and the `__dirname` shim at the top if it does not already have them.

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/engine.test.js`
Expected: FAIL — "random.js must not import node:crypto".

- [ ] **Step 3: Switch to the Web Crypto API**

`globalThis.crypto.getRandomValues` is available in browsers, in workerd, and in Node 20+ as a global. Replace the `node:crypto` import and the body of `randomInt`, **keeping the existing block comment about V8's `Math.random` being recoverable from observed outputs**:

```js
/* Rejection sampling over a 32-bit window: taking `x % n` directly would bias
   the low residues whenever n does not divide 2^32. */
export function randomInt(n) {
  if (n <= 1) return 0;
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  let x;
  do { globalThis.crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % n;
}
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: all pass, including the new uniformity test.

- [ ] **Step 5: Confirm the Worker still deals**

Run: `npx wrangler dev`, create a room, click through to a dealt hand. Stop.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: engine randomness uses Web Crypto, not node:crypto

The browser imports the engine from M5 onward and cannot resolve
node:crypto. getRandomValues is global in browsers, workerd and Node 20+."
```

---

# Milestone 3 — Room and adapter split

## Task 9: Extract room constants, ids and seats

**Files:**
- Create: `src/core/room/constants.js`
- Create: `src/core/room/ids.js`
- Create: `src/core/room/seats.js`
- Modify: `room.js`

**Interfaces:**
- Consumes: Task 7 (engine barrel)
- Produces:
  - `constants.js` → `SEAT_LABEL`, `EMOTES`, `DIFFICULTIES`, `TARGET_DEAL_CHOICES`, `TURN_TIMER_CHOICES`, `MAX_PLAYERS_PER_ROOM`, `CHAT_MAX_LEN`, `CHAT_RING`, `NAME_MAX`, `MAX_KICKED`, `DEFAULT_DELAYS`
  - `ids.js` → `codePoints(s, n)`, `cleanName(s)`, `normCode(s)`, `randId(n, alpha, rng)`
  - `seats.js` → `playerList(room)`, `connectedCount(room)`, `seatIsLiveHuman(room, seat)`, `seatedHumans(room)`, `reassignHost(room)`, `promoteSpectators(room, excludePid)`, `releaseSeat(room, pid)`, `resetReady(room)`, `freeSeatFor(room)`, `applyPendingSeats(room)`

- [ ] **Step 1: Create `constants.js`**

Move `room.js` lines 28-44 (`SEAT_LABEL` through `DEFAULT_DELAYS`), adding `export` to each.

- [ ] **Step 2: Create `ids.js`**

Move `codePoints` (45), `cleanName` (46), `normCode` (47), `randId` (48-57), keeping the comment above `randId`.

```js
import { NAME_MAX } from "./constants.js";
```

- [ ] **Step 3: Create `seats.js`**

Move `playerList` (74), `connectedCount` (75), `seatIsLiveHuman` (76-80), `seatedHumans` (81-84), `reassignHost` (85-92), `promoteSpectators` (93-99), `releaseSeat` (100-107), `resetReady` (108), `freeSeatFor` (115-119), `applyPendingSeats` (120-130), with all their comments.

```js
import { SEAT_LABEL } from "./constants.js";
```

- [ ] **Step 4: Delete the moved code from `room.js` and import it back**

```js
import { SEAT_LABEL, EMOTES, DIFFICULTIES, TARGET_DEAL_CHOICES, TURN_TIMER_CHOICES,
         MAX_PLAYERS_PER_ROOM, CHAT_MAX_LEN, CHAT_RING, NAME_MAX, MAX_KICKED,
         DEFAULT_DELAYS } from "./src/core/room/constants.js";
import { codePoints, cleanName, normCode, randId } from "./src/core/room/ids.js";
import { playerList, connectedCount, seatIsLiveHuman, seatedHumans, reassignHost,
         promoteSpectators, releaseSeat, resetReady, freeSeatFor,
         applyPendingSeats } from "./src/core/room/seats.js";
```

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: all pass. `test/room.test.js` is 523 lines of flow and redaction tests — it will catch a mis-moved seat helper.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: extract room constants, ids and seat helpers"
```

---

## Task 10: Extract room timers, drive, membership, handlers and view

**Files:**
- Create: `src/core/room/timers.js`
- Create: `src/core/room/drive.js`
- Create: `src/core/room/membership.js`
- Create: `src/core/room/handlers.js`
- Create: `src/core/room/view.js`
- Create: `src/core/room/index.js`
- Delete: `room.js`
- Modify: `server.js`, `src/worker.js`, `test/room.test.js`, `test/engine.test.js`, `test/client.test.js`

**Interfaces:**
- Consumes: Task 9
- Produces: `src/core/room/index.js` re-exporting `createRoom, join, disconnect, message, fireTimers, nextTimerDue, buildView, reconcile, normCode, randId, cleanName, SEAT_LABEL, EMOTES, DIFFICULTIES, TARGET_DEAL_CHOICES, TURN_TIMER_CHOICES, MAX_PLAYERS_PER_ROOM, DEFAULT_DELAYS`

- [ ] **Step 1: Create `timers.js`**

Move `setTimer` (147-150), `clearTimersOfKind` (151), `sameData` (152), `nextTimerDue` (153-158), `GAME_TIMER_KINDS` (159), `fireTimers` (212-256).

`fireTimers` calls `drive` and `dealNext`, so import them from `drive.js`.

- [ ] **Step 2: Create `drive.js`**

Move `dealNext` (131), `drive` (163-200), `aiAct` (201-211), with the comment block above `drive`.

```js
import * as E from "../../../app/js/core/engine/index.js";
import { DEFAULT_DELAYS } from "./constants.js";
import { resetReady, applyPendingSeats, seatIsLiveHuman } from "./seats.js";
import { setTimer, clearTimersOfKind } from "./timers.js";
```

`timers.js` and `drive.js` reference each other. ES module cycles resolve correctly for hoisted `function` declarations, which is what both files use — do not convert them to `const` arrow functions.

- [ ] **Step 3: Create `membership.js`**

Move `createRoom` (58-73), `isKicked` (134-137), `recordKick` (138-146), `join` (257-310), `disconnect` (311-336), `reconcile` (337-348).

- [ ] **Step 4: Create `handlers.js`**

Move `startMatch` (349-365), `message` (366-411), `handleSettings` (412-424), `handleSit` (425-442), `handleKick` (443-458), `handleGameAction` (459-490).

- [ ] **Step 5: Create `view.js`**

Move `buildView` (491-544). This is the hand-redaction boundary — `test/room.test.js` has a property test asserting seat A's serialized view never contains seat B's hand. Move it verbatim, comments included.

- [ ] **Step 6: Create the barrel**

`src/core/room/index.js`:
```js
export { createRoom, join, disconnect, reconcile } from "./membership.js";
export { message } from "./handlers.js";
export { fireTimers, nextTimerDue } from "./timers.js";
export { buildView } from "./view.js";
export { normCode, randId, cleanName } from "./ids.js";
export { SEAT_LABEL, EMOTES, DIFFICULTIES, TARGET_DEAL_CHOICES,
         TURN_TIMER_CHOICES, MAX_PLAYERS_PER_ROOM, DEFAULT_DELAYS } from "./constants.js";
```

- [ ] **Step 7: Repoint consumers and delete the shim**

`server.js`: `import * as R from "./src/core/room/index.js";`
`src/worker.js`: `import * as R from "./core/room/index.js";`
`test/room.test.js`, `test/engine.test.js`, `test/client.test.js`: `import * as R from "../src/core/room/index.js";`

`test/client.test.js` also reads `room.js` as text (lines 18 and 180). Point both at the whole directory instead:
```js
const CORE = fs.readdirSync(path.join(__dirname, "..", "src", "core", "room"))
  .filter(f => f.endsWith(".js"))
  .map(f => fs.readFileSync(path.join(__dirname, "..", "src", "core", "room", f), "utf8"))
  .join("\n");
```

```bash
git rm room.js
```

- [ ] **Step 8: Run the suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 9: Verify a full match end to end**

Run: `npm start`, click "Play vs 3 Bots", play a complete deal (bid → trump → call partner → 13 tricks) and confirm the round-over panel shows. Stop.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: room.js becomes src/core/room/"
```

---

## Task 11: Split the Node server

**Files:**
- Create: `src/server/config.js`, `src/server/http.js`, `src/server/registry.js`, `src/server/sockets.js`, `src/server/index.js`
- Delete: `server.js`
- Modify: `package.json` (`start` script)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: Task 10 (`src/core/room/index.js`)
- Produces:
  - `config.js` → `PORT`, `MAX_ROOMS`, `MSG_RATE`, `MAX_SOCKETS_PER_IP`, `JOIN_GRACE_MS`, `ALLOW_ORIGIN`, `TRUST_PROXY`, `DELAYS`, `clientIp(req): string`
  - `http.js` → `createHttpServer(getRoomCount: () => number): http.Server`
  - `registry.js` → `rooms: Map`, `getOrCreateRoom(codeRaw, priv)`, `newRoomCode(len)`, `deleteRoom(entry)`, `armTimer(entry)`, `applyFx(entry, fx, ws)`, `send(ws, obj)`
  - `sockets.js` → `attachSockets(httpServer): WebSocketServer`
  - `index.js` → bootstrap only, no exports

- [ ] **Step 1: Read the current file end to end**

Run: `cat server.js`

The split follows its existing section banners exactly. Nothing is rewritten — only relocated.

- [ ] **Step 2: Create `config.js`**

Move lines 16-35: `PORT`, `MAX_ROOMS`, `MSG_RATE`, `MAX_SOCKETS_PER_IP`, `JOIN_GRACE_MS`, `DELAYS`, `ALLOW_ORIGIN`, `TRUST_PROXY`, `clientIp`. **Keep the comment explaining why `TRUST_PROXY` defaults off** — X-Forwarded-For is caller-controlled.

- [ ] **Step 3: Create `http.js`**

Move lines 37-62. `PUB` becomes:
```js
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
```

The `/health` handler needs the room count, which lives in `registry.js`. Rather than importing it (which would couple the HTTP layer to the registry), take it as a parameter:
```js
export function createHttpServer(getRoomCount) {
```
and inside the `/health` branch use `rooms: getRoomCount()`.

**Apply the `Cache-Control` fix from the spec.** Currently only the literal `index.html` is `no-cache`, so `solo.html` would be served stale for an hour. Change the header line to:
```js
"Cache-Control": file.endsWith("sw.js") || file.endsWith(".html")
  ? "no-cache" : "public, max-age=3600",
```

Keep the traversal guard (`!file.startsWith(PUB + path.sep) || rel.includes("..")`) and the MIME map exactly as they are — both already handle nested paths, `.js` and `.css`.

- [ ] **Step 4: Create `registry.js`**

Move lines 64-135: `rooms`, `newRoomCode`, `reclaimEmptyRoom`, `getOrCreateRoom`, `send`, `applyFx`, `deleteRoom`, `armTimer`, with the comment explaining the 30-minute empty-room grace.

- [ ] **Step 5: Create `sockets.js`**

Move lines 136-231: the `WebSocketServer`, `ipCount`, connection handler, `detach`, `handleMessage`, `handleClose`, and the unref'd keep-alive ping. Wrap in:
```js
export function attachSockets(httpServer) {
```
returning the `wss`. Keep the comment on why the ping interval is unref'd (so it never holds a test process open).

- [ ] **Step 6: Create `index.js`**

```js
/* Node + ws adapter: wires the HTTP file server, the room registry and the
   socket lifecycle together, then listens. */
import os from "node:os";
import { PORT } from "./config.js";
import { createHttpServer } from "./http.js";
import { rooms } from "./registry.js";
import { attachSockets } from "./sockets.js";

const httpServer = createHttpServer(() => rooms.size);
attachSockets(httpServer);
httpServer.listen(PORT, () => { /* keep the existing LAN-address log verbatim */ });
```

Move the existing listen callback body (lines 232-243) in unchanged, including the LAN IP discovery.

- [ ] **Step 7: Delete the old file and repoint the start script**

```bash
git rm server.js
```

`package.json`:
```json
    "start": "node src/server/index.js",
```

- [ ] **Step 8: Update `test/server.test.js`**

Point its imports at the new modules. If it spawns the server as a subprocess, change the path to `src/server/index.js`.

- [ ] **Step 9: Run the suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 10: Verify the server end to end**

Run: `npm start`. Confirm: the join screen loads; `curl -s localhost:3000/health` returns `{"ok":true,"rooms":0}`; a created room plays a deal; `curl -sI localhost:3000/solo.html | grep -i cache-control` shows `no-cache`. Stop.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor: server.js becomes src/server/

Also fixes Cache-Control: only the literal index.html was no-cache, so
solo.html would have been served stale for an hour."
```

---

## Task 12: Split the Worker

**Files:**
- Create: `src/worker/origin.js`, `src/worker/stats.js`, `src/worker/room-do.js`, `src/worker/index.js`
- Delete: `src/worker.js`
- Modify: `wrangler.toml:5` (`main`)
- Test: `test/worker.test.js`

**Interfaces:**
- Consumes: Task 10
- Produces:
  - `origin.js` → `okOrigin(request, url, env): boolean`
  - `stats.js` → `readStats(env, uid): Promise<Response>`, `writeMatchStats(env, room): Promise<void>`
  - `room-do.js` → `class RoomDO`
  - `index.js` → `export default { fetch }` and `export { RoomDO }`

- [ ] **Step 1: Create `origin.js`**

Move `okOrigin` (lines 24-31) with its comment.

- [ ] **Step 2: Create `stats.js`**

Move the D1 block (lines 56-71) plus the `matchOver` write path currently inside `RoomDO`. Keep the invariant intact: **with no `DB` binding every stats path is a silent no-op and `/stats` answers `{"available":false}`.**

- [ ] **Step 3: Create `room-do.js`**

Move `class RoomDO` (lines 72-257) unchanged, with its hibernation/alarm/persistence comments. Import the room core and stats:
```js
import * as R from "../core/room/index.js";
import { writeMatchStats } from "./stats.js";
```

- [ ] **Step 4: Create `index.js`**

Move the header comment (lines 1-19), `MSG_RATE` (22) and the `export default { fetch }` block (32-55). Re-export the DO class so Wrangler can find it from the entry point:
```js
export { RoomDO } from "./room-do.js";
```

- [ ] **Step 5: Repoint Wrangler and delete the old file**

`wrangler.toml` line 5:
```toml
main = "src/worker/index.js"
```

```bash
git rm src/worker.js
```

- [ ] **Step 6: Update `test/worker.test.js`**

Its `load()` helper imports the worker module — point it at `../src/worker/index.js`.

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: all pass, including the origin-rejection tests (426 for missing upgrade, 403 for a hostile origin, 200 when `ALLOW_ORIGIN` opts it back in).

- [ ] **Step 8: Verify the Worker end to end**

Run: `npx wrangler dev`. Create a room, play a full deal, then reload the page mid-match and confirm the state is restored from Durable Object storage. Stop.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: src/worker.js becomes src/worker/"
```

---

# Milestone 4 — Client split

The highest-risk milestone: the suite is thin on client rendering. Extract in dependency order and keep the page working after every task.

## Task 13: Make the client script a module and extract the leaves

**Files:**
- Modify: `app/index.html` (line 825 `<script>`, and the extracted regions)
- Create: `app/js/util/dom.js`, `app/js/util/prefs.js`, `app/js/cards/labels.js`, `app/js/cards/icons.js`, `app/js/cards/deck.js`
- Modify: `scripts/build-assets.js` (SHELL)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `util/dom.js` → `$(id): Element`, `esc(s): string`, `toast(msg): void`, `nameHue(name): number`, `paintAvatar(el, name, isAI): void`, `avatarHtml(name, isAI): string`
  - `util/prefs.js` → `setFourColor(on: boolean): void`, `initPrefs(): void`
  - `cards/labels.js` → `RANK_NAME`, `SUIT_NAME`, `SUIT_KEY`, `rankLabel(r)`, `cardStr(c)`, `cardName(c)`, `suitSvg(s)`, `suitSpan(s)`, `cardSpan(c)`, `textWithCards(t)`, `SUITS`, `RED`
  - `cards/icons.js` → `ICONS`, `REACTIONS`, `EMOTES`, `icon(name, cls)`, `reactionIcon(e)`, `reactionName(e)`, `paintIcons(root)`
  - `cards/deck.js` → `suitPath(s, cx, cy, size, flip)`, `courtFigure(rank)`, `cardFace(card, compact)`, `cardEl(card, asButton)`, `COL`, `ROW_TOP`, `ROW_BOT`, `PIP_SIZE`

- [ ] **Step 1: Turn the inline script into a module**

`app/index.html` line 825: `<script>` → `<script type="module">`.

Run: `npm start`, load the page.
Expected: it still works. Module scripts are deferred, so any code that assumed synchronous execution before `DOMContentLoaded` now runs later — if the first paint breaks, that is the reason, and the fix is to keep the existing first-paint block at the very bottom of the script where it already is.

- [ ] **Step 2: Extract `util/dom.js`**

Move `$` and `esc` from the helpers section (~lines 1802-1816), `toast` and its `toastT` module-local, and the avatar helpers `nameHue`/`paintAvatar`/`avatarHtml` (~1225-1242).

**Keep the comment above `esc` explaining that it escapes `'` as well as `"`**, because everything is interpolated into `innerHTML` and a name landing in a single-quoted attribute must not break out.

- [ ] **Step 3: Extract `cards/labels.js`**

Move `SUITS`/`RED` (828), `rankLabel`/`cardStr` (830-831), `RANK_NAME`/`SUIT_NAME`/`SUIT_KEY`/`cardName` (~1112-1116), `suitSvg` (~1132), `suitSpan`/`cardSpan`/`textWithCards` (~1807-1814).

Keep the comment noting suit colours come from CSS classes, not inline styles — `client.test.js` asserts on that behaviour and the comment is why.

- [ ] **Step 4: Extract `cards/icons.js`**

Move `ICONS` (839), `icon` (855), `REACTIONS` (862), `reactionIcon` (870), `reactionName` (874), `paintIcons` (876), `EMOTES` (832).

`EMOTES` must stay a single flat array literal of string literals — `client.test.js` matches `const EMOTES = [...]` against `room.js`'s list. Write it as:
```js
export const EMOTES = ["👏","😂","😱","🔥","🤝","💀"];   // must match src/core/room/constants.js EMOTES
```

- [ ] **Step 5: Extract `cards/deck.js`**

Move the deck-drawing region (~1116-1224): `suitPath`, the pip layout constants `COL`/`ROW_TOP`/`ROW_BOT`/`PIP_SIZE`, `courtFigure`, `cardFace`, `cardEl`. Move the long block comments about the Rouen pattern and the compact 44px call-partner card with them.

```js
import { SUITS, RED, SUIT_KEY, rankLabel, cardName } from "./labels.js";
```

- [ ] **Step 6: Extract `util/prefs.js`**

Move `setFourColor` (~1857-1865) and the localStorage read that applies it at boot. Export `initPrefs()` wrapping that read.

- [ ] **Step 7: Import them from the inline script**

At the very top of the `<script type="module">` block:
```js
import { $, esc, toast, nameHue, paintAvatar, avatarHtml } from "/js/util/dom.js";
import { setFourColor, initPrefs } from "/js/util/prefs.js";
import { SUITS, RED, RANK_NAME, SUIT_NAME, SUIT_KEY, rankLabel, cardStr, cardName,
         suitSvg, suitSpan, cardSpan, textWithCards } from "/js/cards/labels.js";
import { ICONS, REACTIONS, EMOTES, icon, reactionIcon, reactionName, paintIcons } from "/js/cards/icons.js";
import { suitPath, courtFigure, cardFace, cardEl } from "/js/cards/deck.js";
```

Absolute `/js/...` paths, not relative — both shells live at the root, and `solo.html` will use the same specifiers.

- [ ] **Step 8: Add the new files to the precache**

`scripts/build-assets.js` — add the five new paths to `SHELL`. Task 19 automates this; for now extend the array by hand.

Run: `npm run build:assets`

- [ ] **Step 9: Run the suite**

Run: `npm test`
Expected: `client.test.js` **fails** on the EMOTES assertion — it scans `app/index.html` as text, and `EMOTES` has just moved out of it into `cards/icons.js`.

Fix it now by making `CLIENT` span the module tree as well as the markup. Add near the top of `test/client.test.js`, keeping the existing `CLIENT` name so no assertion below changes:

```js
const jsFiles = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
})(path.join(__dirname, "..", "app", "js"))
  .filter(f => f.endsWith(".js") && !f.includes(`${path.sep}core${path.sep}`));

const CLIENT = [fs.readFileSync(path.join(__dirname, "..", "app", "index.html"), "utf8"),
                ...jsFiles.map(f => fs.readFileSync(f, "utf8"))].join("\n");
```

`core/` is excluded — that is the engine, not client code. Task 20 refines this further; for now it just has to make the existing assertions true again.

Re-run: `npm test`
Expected: all pass.

- [ ] **Step 10: Verify in the browser**

Run: `npm start`. Confirm: the wordmark card fan draws; "Play vs 3 Bots" deals; card faces render pips and court figures; the 4-colour deck toggle works; a toast appears on invite-copy. Check DevTools console for zero errors. Stop.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor: extract client leaf modules (dom, prefs, labels, icons, deck)"
```

---

## Task 14: Extract the session state object

**Files:**
- Create: `app/js/session.js`
- Modify: `app/index.html`

**Interfaces:**
- Consumes: `util/dom.js` (Task 13)
- Produces: `session.js` → `S` (mutable state object), `myUid(): string`, `leaveRoom(reason?: string): void`, `mintCode(len?: number): string`, `takeNotice(): string|null`

- [ ] **Step 1: Create `session.js` with the state object**

```js
/* Every module that renders reads this object and several write it. ESM `let`
   exports are read-only for importers, so the shared state has to be a single
   mutable object rather than a set of exported bindings. */
export const S = {
  ws: null, view: null, myPid: null, mySeat: null, roomCode: null,
  humanBidValue: null, bidCtxKey: null, reconnectTimer: null, wantConnected: false,
  autoStartSolo: false, startingSolo: false, serverSkew: 0,
  creating: false, createPrivate: false, createTries: 0, myName: "",
};
```

These are exactly the 16 globals declared at `app/index.html` lines 888-892. Do **not** add `reconnectDelay`, `toastT`, `ringEl`, `tickHandle`, `unreadChat` or `lastChatLen` — those are local to one module each and stay there.

- [ ] **Step 2: Move the session helpers in**

Move `myUid` (~903-909), `mintCode` (~901), `leaveRoom` (~1011-1021) and the leave-notice read (~1007) into `session.js`. Export the notice read as `takeNotice()`.

Keep the comments on both: the uid is random with no account and never leaves as PII; the notice must survive the reload that `leaveRoom` triggers.

- [ ] **Step 3: Delete the global declarations and rewrite every reference**

Delete lines 888-892 from the inline script. Add:
```js
import { S, myUid, leaveRoom, mintCode, takeNotice } from "/js/session.js";
```

Then rewrite every read and write of the 16 names to go through `S.`. This is mechanical but must be exhaustive — a missed one becomes an implicit global that silently works until two modules disagree.

Find them all:
```bash
grep -nE '\b(ws|view|myPid|mySeat|roomCode|humanBidValue|bidCtxKey|reconnectTimer|wantConnected|autoStartSolo|startingSolo|serverSkew|creating|createPrivate|createTries|myName)\b' app/index.html
```

Beware false positives: `view` also appears in `buildView`, `publicView` and `viewport`; `ws` appears in `wss`. Match whole identifiers only.

- [ ] **Step 4: Prove no implicit globals remain**

Add `"use strict";` is not needed — modules are strict, so an assignment to an undeclared variable throws `ReferenceError` rather than creating a global. That is the safety net.

Run: `npm start`, open the page, and exercise join → lobby → deal while watching the console.
Expected: zero `ReferenceError`.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: client session state moves into an exported S object

ESM let-exports are read-only for importers, so shared mutable client
state has to live on one object."
```

---

## Task 15: Extract networking, share and PWA

**Files:**
- Create: `app/js/net.js`, `app/js/share.js`, `app/js/pwa.js`
- Modify: `app/index.html`

**Interfaces:**
- Consumes: `session.js` (Task 14), `util/dom.js` (Task 13)
- Produces:
  - `net.js` → `connect(name, code): void`, `send(o: object): void`, `serverNow(): number`, `scheduleReconnect(name): void`, `onMsg(m): void`, `WS_BASE`
  - `share.js` → `inviteUrl(): string`, `copyInvite(): void`
  - `pwa.js` → `registerServiceWorker(): void`, `initInstallPrompt(): void`

- [ ] **Step 1: Create `net.js`**

Move the networking region (~894-969): `WS_BASE`, `connect`, `RECONNECT_MIN`/`reconnectDelay`/`scheduleReconnect`, `onMsg`, `serverNow`, `send`.

Keep both comments: the one explaining the `WS_BASE` split-deploy option, and the one explaining exponential backoff with jitter.

`onMsg` calls `render()` and other UI functions that do not exist yet as modules. Until Task 17, accept them via a registered callback rather than importing upward:
```js
let onView = () => {};
export function setViewHandler(fn) { onView = fn; }
```
and call `onView()` where `onMsg` currently calls `render()`. Task 17 wires the real renderer in.

- [ ] **Step 2: Create `share.js`**

Move `inviteUrl` and the copy/share handler (~1817-1832).

- [ ] **Step 3: Create `pwa.js`**

Move the service worker registration and install-prompt block (~1915-1919).

- [ ] **Step 4: Import them and wire the view handler**

In the inline script:
```js
import { connect, send, serverNow, scheduleReconnect, setViewHandler } from "/js/net.js";
import { inviteUrl, copyInvite } from "/js/share.js";
import { registerServiceWorker, initInstallPrompt } from "/js/pwa.js";

setViewHandler(render);
```

- [ ] **Step 5: Add the three files to `SHELL` and rebuild**

Run: `npm run build:assets`

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Verify reconnection actually works**

Run: `npm start`, create a room, then stop the server with Ctrl-C. The client should show its disconnected state and retry with growing delays. Restart `npm start` — the client must reconnect and restore the room without a manual reload.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: extract client networking, share and PWA modules"
```

---

## Task 16: Extract the UI modules

**Files:**
- Create: `app/js/ui/log.js`, `app/js/ui/chat.js`, `app/js/ui/modals.js`, `app/js/ui/actionbar.js`, `app/js/ui/hand.js`, `app/js/ui/layout.js`
- Modify: `app/index.html`

**Interfaces:**
- Consumes: Tasks 13-15
- Produces:
  - `ui/log.js` → `syncWindow(box, keys, build): number`, `renderLog(): void`
  - `ui/chat.js` → `renderChat(): void`, `showEmote(seat, e): void`, `noteChatActivity(): void`, `updateChatBadge(): void`, `openSheet(tab): void`, `closeSheet(): void`
  - `ui/modals.js` → `setModal(kind, html): void`, `hideOverlay(): void`, `showMatchOver(): void`, `showHelp(): void`, `showSettingsModal(): void`
  - `ui/actionbar.js` → `renderActionBar(): void`, `bannerForPlay(myTurn): void`, `addBanner(html): void`, `divStatus(html): Element`, `phaseLabel(): string`
  - `ui/hand.js` → `renderHand(): void`, `fitHand(wrap): void`
  - `ui/layout.js` → `fitTable(): void`, `tickTimers(): void`, `startTicking(): void`

- [ ] **Step 1: Extract `ui/log.js`**

Move `syncWindow` (~1560-1582) **with its full comment about aria-live not re-announcing the backlog**, and `renderLog` (~1654-1667).

`syncWindow` is pure apart from DOM calls and is directly unit-tested in Task 20 — keep it free of `S` references.

- [ ] **Step 2: Extract `ui/chat.js`**

Move `renderChat` (~1583-1609), `showEmote` (~1610-1631), the bottom-sheet block `openSheet`/`closeSheet`/`updateChatBadge`/`noteChatActivity` and the iOS keyboard handler (~1866-1914), plus the `unreadChat`/`lastChatLen` module-locals.

Keep the comment explaining that iOS floats the keyboard over fixed elements instead of resizing the layout.

- [ ] **Step 3: Extract `ui/modals.js`**

Move `showMatchOver` (~1773-1786), `showHelp` (~1787-1799), `setModal` (~1800), `hideOverlay` (~1801), `showSettingsModal` (~1649-1653).

- [ ] **Step 4: Extract `ui/actionbar.js`**

Move `renderActionBar` (~1668-1757), `bannerForPlay` (~1757-1769), `addBanner` (~1770), `divStatus` (~1771), `phaseLabel` (~1772).

Keep the comment about `Pass` being quiet but still tappable, and the one about the steppers flanking the bid number.

- [ ] **Step 5: Extract `ui/hand.js`**

Move `renderHand` (~1404-1472) and `fitHand` (~1477-1500), with the comment explaining that thirteen cards at the CSS overlap are ~564px wide — wider than any phone — so the fan is measured and scaled.

- [ ] **Step 6: Extract `ui/layout.js`**

Move `fitTable` (~1501-1521) with its fixed-pixel trick-cross comment, the "both fits are measured, so a resize has to re-measure them" resize handler (~1522-1524), and the live-countdown block `ringEl`/`tickHandle`/`tickTimers` (~1632-1648).

- [ ] **Step 7: Import them all in the inline script**

```js
import { syncWindow, renderLog } from "/js/ui/log.js";
import { renderChat, showEmote, noteChatActivity, updateChatBadge, openSheet, closeSheet } from "/js/ui/chat.js";
import { setModal, hideOverlay, showMatchOver, showHelp, showSettingsModal } from "/js/ui/modals.js";
import { renderActionBar, bannerForPlay, addBanner, divStatus, phaseLabel } from "/js/ui/actionbar.js";
import { renderHand, fitHand } from "/js/ui/hand.js";
import { fitTable, tickTimers, startTicking } from "/js/ui/layout.js";
```

- [ ] **Step 8: Add to `SHELL`, rebuild, run the suite**

Run: `npm run build:assets && npm test`
Expected: all pass.

- [ ] **Step 9: Verify the whole game surface**

Run: `npm start`. Confirm every extracted surface: the table log scrolls and appends without re-announcing; chat sends and the unread badge counts; each emote floats over the right seat; the help and match-over modals open and close; the action bar renders for bid, trump, call and play; the hand fans and scales when the window narrows; the trick cross stays centred on resize; the turn-timer ring counts down.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: extract client UI modules"
```

---

## Task 17: Extract the screens and `main.js`

**Files:**
- Create: `app/js/screens/join.js`, `app/js/screens/lobby.js`, `app/js/screens/game.js`, `app/js/main.js`
- Modify: `app/index.html` (the inline script becomes a single `<script type="module" src="/js/main.js">`)

**Interfaces:**
- Consumes: Tasks 13-16
- Produces:
  - `screens/join.js` → `doJoin(create: boolean): void`, `doSolo(): void`, `loadStats(): void`, `showNotice(): void`
  - `screens/lobby.js` → `renderLobby(): void`, `renderSettings(hostEl, isHost): void`, `miniBtn(label, cls, fn, ic): Element`, `DIFF_OPTS`, `DEAL_OPTS`, `TIMER_OPTS`
  - `screens/game.js` → `render(): void`, `renderGame(): void`, `renderMedallion(): void`, `renderScoreboard(): void`, `sideOf(seat)`, `activeSeat()`, `roleOf(seat)`, `orient()`, `seatAtPos(pos)`, `posOfSeat(seat)`
  - `main.js` → no exports; the entry module

- [ ] **Step 1: Extract `screens/join.js`**

Move `doJoin` (~971-980), `doSolo` (~981-991), the lifetime-stats fetch (~992-1006) and the notice display (~1007-1010).

Keep the comment noting the stats block is optional and depends on a D1 binding.

- [ ] **Step 2: Extract `screens/lobby.js`**

Move `renderLobby` (~1045-1082), `miniBtn` (~1083-1089), `renderSettings` (~1090-1111) and the `DIFF_OPTS`/`DEAL_OPTS`/`TIMER_OPTS` constants.

Those three must keep their exact literal shapes — `client.test.js` regexes them and compares against `src/core/room/constants.js`:
```js
const DIFF_OPTS = [["easy","Easy"],["normal","Normal"],["hard","Hard"]];
const DEAL_OPTS = [3,5,7];
const TIMER_OPTS = [0,15,30,45,60,90];
```
Preserve whatever the current values are — copy them across verbatim rather than retyping from this plan.

- [ ] **Step 3: Extract `screens/game.js`**

Move `render` (~1028-1044), the orientation helpers `orient`/`seatAtPos`/`posOfSeat` (~1023-1026), `sideOf`/`activeSeat`/`roleOf` (~1244-1263), `renderGame` (~1264-1348), `renderMedallion` (~1349-1403) and `renderScoreboard` (~1525-1559).

Keep the medallion comment about `width:max-content` being load-bearing, and the scoreboard comment about deals-won as readable counters.

- [ ] **Step 4: Create `main.js`**

Everything left in the inline script: the imports, `setViewHandler(render)`, the first-paint block (~1833-1856), `?room=` handling, `paintIcons(document)`, `initPrefs()`, `registerServiceWorker()`, `initInstallPrompt()`, `startTicking()` and the global event listeners.

Keep the first-paint comment block intact.

- [ ] **Step 5: Replace the inline script with a src reference**

`app/index.html` — delete everything between `<script type="module">` and `</script>` and replace the whole element with:
```html
<script type="module" src="/js/main.js"></script>
```

`app/index.html` is now markup only.

- [ ] **Step 6: Confirm the size**

Run: `wc -l app/index.html`
Expected: roughly 130 lines — head plus the three screen sections. If it is still over 200, markup was left behind that belongs in a screen module's template.

- [ ] **Step 7: Add to `SHELL`, rebuild, run the suite**

Run: `npm run build:assets && npm test`
Expected: all pass.

- [ ] **Step 8: Full manual pass**

Run: `npm start`. Walk the whole app: join by name; create a private room and confirm the 8-character code; open the invite link in a second tab and join; sit, stand and swap seats; change difficulty, target deals and turn timer as host; kick the second player and confirm they stay out; ready up; play a complete deal end to end; chat and emote; toggle the 4-colour deck; resize to phone width and use the bottom sheet; reload mid-match and confirm the state returns.

Check the DevTools console and Network tab: zero errors, every `/js/**` request 200.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: extract client screens; index.html is markup only"
```

---

## Task 18: Split the stylesheet

The split must be a **pure partition** — every line lands in exactly one file, source order preserved. `test/pwa.test.js` parses the concatenated CSS and asserts on cascade order, so any reordering silently breaks ~200 lines of layout assertions.

**Files:**
- Create: `app/css/tokens.css`, `app/css/base.css`, `app/css/table.css`, `app/css/panels.css`, `app/css/responsive.css`
- Modify: `app/index.html` (remove `<style>`, add 5 `<link>`s)
- Modify: `test/pwa.test.js` (CSS source)

**Interfaces:**
- Consumes: Task 17
- Produces: five stylesheets whose concatenation in the order tokens → base → table → panels → responsive equals today's `<style>` contents

- [ ] **Step 1: Save the current stylesheet as the reference**

```bash
node -e "
const fs=require('fs');
const h=fs.readFileSync('app/index.html','utf8');
fs.writeFileSync('/tmp/css-before.txt', h.match(/<style>([\s\S]*?)<\/style>/)[1]);
" && wc -l /tmp/css-before.txt
```

- [ ] **Step 2: Partition the stylesheet along its existing section comments**

The file already carries `/* ---- ... ---- */` banners. Cut on them:

| File | Takes |
|---|---|
| `tokens.css` | the `:root` block and every custom property, the global box-sizing/reset, the `--icon` size, the 4-colour deck overrides |
| `base.css` | typography, buttons, form controls, the toast, the wordmark |
| `table.css` | `/* ---- Game ---- */` through the card, medallion, trick and hand sections |
| `panels.css` | `/* ---- Join / Lobby screens ---- */`, `/* ---- lobby settings ---- */`, the sidebar, scoreboard, log, chat and sheet sections |
| `responsive.css` | **every** `@media` block, in the order it appeared |

Two rules that override the table above when they conflict:
1. A rule goes where its **selector's subject** lives, not where it was authored.
2. Relative order within the concatenation must not change. If moving a block would reorder it against a rule it overrides, leave it where it is and note why in a comment.

- [ ] **Step 3: Prove the partition is lossless**

```bash
node -e "
const fs=require('fs');
const files=['tokens','base','table','panels','responsive'].map(n=>'app/css/'+n+'.css');
const got=files.map(f=>fs.readFileSync(f,'utf8')).join('\n');
const want=fs.readFileSync('/tmp/css-before.txt','utf8');
const norm=s=>s.replace(/\s+/g,' ').trim();
if(norm(got)===norm(want)) console.log('IDENTICAL');
else { console.log('DIFFERS'); console.log('before',norm(want).length,'after',norm(got).length); process.exit(1); }
"
```
Expected: `IDENTICAL`.

If it prints `DIFFERS`, a rule was dropped, duplicated or reordered. Fix it before continuing — this check is the only thing standing between you and a subtly broken layout.

- [ ] **Step 4: Link the stylesheets**

Replace the `<style>` element in `app/index.html` with, in this exact order:
```html
<link rel="stylesheet" href="/css/tokens.css" />
<link rel="stylesheet" href="/css/base.css" />
<link rel="stylesheet" href="/css/table.css" />
<link rel="stylesheet" href="/css/panels.css" />
<link rel="stylesheet" href="/css/responsive.css" />
```

Five `<link>`s, not `@import` — `@import` serialises the requests.

- [ ] **Step 5: Point `pwa.test.js` at the files**

Replace line 35:
```js
const CSS = ["tokens", "base", "table", "panels", "responsive"]
  .map(n => read(path.join("css", n + ".css")))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");
```

Cascade order must match the `<link>` order exactly — `BASE`, `PHONE` and `COARSE` are derived from this string, and `declared()` returns values in source order with the last one winning.

- [ ] **Step 6: Add to `SHELL`, rebuild, run the suite**

Run: `npm run build:assets && npm test`
Expected: all pass, including every layout assertion in `pwa.test.js` — the three-row game grid, the dvh heights, the safe-area insets, and the 40px/44px touch-target floors.

- [ ] **Step 7: Verify visually at three widths**

Run: `npm start`. Compare against the pre-split appearance at desktop (1440px), tablet (900px) and phone (390px) widths. Check specifically: the felt gradient and rail shadows; card faces and the 4-colour toggle; the medallion strip position; the bottom sheet and its tab bar; safe-area padding.

- [ ] **Step 8: Clean up and commit**

```bash
rm /tmp/css-before.txt
git add -A
git commit -m "refactor: split the stylesheet into five cascade-ordered files"
```

---

## Task 19: Generate the precache list from the filesystem

**Files:**
- Modify: `scripts/build-assets.js`
- Modify: `app/sw.js`
- Test: `test/pwa.test.js`

**Interfaces:**
- Consumes: Tasks 13-18
- Produces: `scripts/build-assets.js` → `shellFiles(): string[]`, `shellVersion(files: string[]): string`, `check(): string[]`, `build(): string`

  Note the signature change: `shellVersion` now takes the file list, because `shellFiles()` discovers it rather than a module-level constant declaring it. Update the export list and `test/pwa.test.js`'s import accordingly.

- [ ] **Step 1: Write the failing test**

Add to `test/pwa.test.js`:

```js
test("every shipped js and css file is precached", () => {
  const shell = (SW.match(/const SHELL = \[([\s\S]*?)\];/) || [, ""])[1]
    .match(/"([^"]+)"/g).map(s => s.slice(1, -1));
  const walk = (dir, base = "") => fs.readdirSync(path.join(PUB, dir), { withFileTypes: true })
    .flatMap(e => e.isDirectory()
      ? walk(path.join(dir, e.name), base + e.name + "/")
      : [base + e.name]);
  for (const rel of [...walk("js").map(f => "/js/" + f), ...walk("css").map(f => "/css/" + f)])
    assert.ok(shell.includes(rel), `sw does not precache ${rel}`);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/pwa.test.js`
Expected: FAIL — a hand-maintained `SHELL` will be missing at least one file.

- [ ] **Step 3: Walk the tree in `build-assets.js`**

Replace the hardcoded `SHELL` array with a walk of `app/`, and drop the `solo.html` byte-copy entirely — `solo.html` becomes a real source file in Task 21, so `SOLO_SRC`/`SOLO_DST` and `copyFileSync` all go.

```js
/* The shipped shell, discovered rather than declared: a hand-maintained list
   silently omits new modules, and an omitted module is a broken offline load. */
const SKIP = new Set(["sw.js"]);   // hashing the file we are about to stamp never reaches a fixed point

function shellFiles(dir = APP, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    if (e.isDirectory()) out.push(...shellFiles(path.join(dir, e.name), base + e.name + "/"));
    else out.push(base + e.name);
  }
  return out;
}
```

Sorting is required: `readdirSync` order is filesystem-dependent, and an unstable order would make `VERSION` differ between machines and CI.

- [ ] **Step 4: Stamp both constants**

`build()` now rewrites `SHELL` as well as `VERSION`:

```js
const SHELL_RE = /const SHELL = \[[\s\S]*?\];/;

function build() {
  const files = shellFiles();
  const urls = ["/", ...files.map(f => "/" + f)];
  const want = shellVersion(files);
  let sw = fs.readFileSync(SW, "utf8");
  sw = sw.replace(SHELL_RE, "const SHELL = [\n  " +
    urls.map(u => JSON.stringify(u)).join(", ") + ",\n];");
  sw = sw.replace(VERSION_RE, `const VERSION = "${want}";`);
  fs.writeFileSync(SW, sw);
  return want;
}
```

`shellVersion(files)` hashes each file's relative path and contents, exactly as before.

`check()` must now report a stale `SHELL` as well as a stale `VERSION` — compare the regenerated text against what is in the file and push `"app/sw.js (SHELL)"` when they differ.

- [ ] **Step 5: Regenerate and inspect**

Run: `npm run build:assets`
Run: `grep -A5 'const SHELL' app/sw.js`
Expected: every `/js/**` and `/css/**` file listed, plus the two HTML shells, the manifest and the icons.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: all pass, including the new precache-completeness test and the existing `--check` staleness gate.

- [ ] **Step 7: Verify offline actually works**

Run: `npm start`, load the page, then in DevTools → Application → Service Workers confirm it is activated. Tick "Offline" and reload.
Expected: the app shell loads from cache and the offline fallback game is reachable.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "build: generate the sw precache list by walking app/

A hand-maintained SHELL silently omits new modules, and an omitted
module is a broken offline load."
```

---

## Task 20: Rewrite the client tests against real modules

`client.test.js` currently lifts functions out of HTML source text and runs them in a `vm`, because there was no module to import. There is now.

**Files:**
- Modify: `test/client.test.js`
- Create: `test/cards.test.js`

**Interfaces:**
- Consumes: Tasks 13-19
- Produces: no new source interfaces — test-only

- [ ] **Step 1: Import `syncWindow` and `esc` instead of lifting them**

Delete the `lift()` helper (lines ~59-78 of `client.test.js`) and the `vm` import. Replace the two call sites:

```js
import { syncWindow } from "../app/js/ui/log.js";
import { esc } from "../app/js/util/dom.js";
```

Delete `const syncWindow = lift("syncWindow");` at lines 93 and 133, and `const esc = lift("esc");` at line 145. The assertions themselves — including the `fakeBox()` stand-in and every aria-live case — stay exactly as they are.

- [ ] **Step 2: Point the source scans at the module tree**

```js
const jsFiles = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
})(path.join(__dirname, "..", "app", "js"))
  .filter(f => f.endsWith(".js") && !f.includes(`${path.sep}core${path.sep}`));

const CLIENT = jsFiles.map(f => fs.readFileSync(f, "utf8")).join("\n");
const MARKUP = fs.readFileSync(path.join(__dirname, "..", "app", "index.html"), "utf8");
```

`core/` is excluded — that is the engine, not client code.

The markup assertions (`id="sheet-tabs"`, `data-tab="score|log|chat"`) must read `MARKUP`; the protocol and constant scans read `CLIENT`.

- [ ] **Step 3: Import the option lists directly instead of regexing them**

The EMOTES/DIFF_OPTS/DEAL_OPTS/TIMER_OPTS test no longer needs text matching:

```js
import { EMOTES } from "../app/js/cards/icons.js";
import { DIFF_OPTS, DEAL_OPTS, TIMER_OPTS } from "../app/js/screens/lobby.js";

test("client option lists match the core's validated choices", () => {
  assert.deepStrictEqual(EMOTES, R.EMOTES, "emote bar must match room constants exactly");
  assert.deepStrictEqual(DIFF_OPTS.map(o => o[0]), R.DIFFICULTIES);
  assert.deepStrictEqual(DEAL_OPTS, R.TARGET_DEAL_CHOICES);
  assert.deepStrictEqual(TIMER_OPTS, R.TURN_TIMER_CHOICES);
});
```

`screens/lobby.js` must therefore `export` those three constants. If importing it pulls in DOM access at module scope, move that access into a function — module top level must stay side-effect free.

- [ ] **Step 4: Write `test/cards.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankLabel, cardStr, cardName, SUIT_KEY } from "../app/js/cards/labels.js";
import { cardFace } from "../app/js/cards/deck.js";

test("rank labels cover courts and pips", () => {
  assert.equal(rankLabel(14), "A");
  assert.equal(rankLabel(13), "K");
  assert.equal(rankLabel(12), "Q");
  assert.equal(rankLabel(11), "J");
  for (let r = 2; r <= 10; r++) assert.equal(rankLabel(r), String(r));
});

test("cardStr and cardName agree on every card in the deck", () => {
  for (const suit of ["♠", "♥", "♦", "♣"]) {
    assert.ok(SUIT_KEY[suit], `no CSS key for ${suit}`);
    for (let rank = 2; rank <= 14; rank++) {
      assert.equal(cardStr({ suit, rank }), rankLabel(rank) + suit);
      const name = cardName({ suit, rank });
      assert.ok(/ of /.test(name), `unreadable screen-reader name: ${name}`);
    }
  }
});

test("cardFace draws every card without throwing, and marks its suit", () => {
  for (const suit of ["♠", "♥", "♦", "♣"]) {
    for (let rank = 2; rank <= 14; rank++) {
      const svg = cardFace({ suit, rank });
      assert.ok(typeof svg === "string" && svg.length > 0, `empty face for ${rank}${suit}`);
      assert.ok(svg.includes(SUIT_KEY[suit]), `${rank}${suit} carries no suit class`);
    }
  }
});
```

`cardFace` must return a string and touch no DOM. If it currently builds elements, have it return markup and let `cardEl` do the DOM work — that separation is what makes it testable.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: all pass, with 52 cards exercised through `cardFace`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: import real client modules instead of lifting source text

syncWindow and esc are now importable, so the vm-based lift() helper
is gone. Adds direct unit tests for the card label and deck modules."
```

---

# Milestone 5 — Solo on the shared engine

## Task 21: Rewrite the solo game against `core/engine`

The only intentional behaviour change in this plan.

**Files:**
- Create: `app/js/solo.js`
- Rewrite: `app/solo.html`
- Delete: `index.html` (repo root)
- Modify: `test/pwa.test.js` (delete the byte-equality test)
- Test: `test/solo.test.js`

**Interfaces:**
- Consumes: `app/js/core/engine/index.js` (Task 7), `cards/*`, `ui/*`, `util/*` (Tasks 13-18)
- Produces: `solo.js` → `startSolo(opts: {difficulty: "easy"|"normal"|"hard", targetDeals: 3|5|7}): void`

- [ ] **Step 1: Write the drift guard first**

Create `test/solo.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const solo = ["app/solo.html", "app/js/solo.js"]
  .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");

test("the solo game uses the shared engine and re-implements none of it", () => {
  assert.match(solo, /core\/engine/, "solo must import the shared engine");
  for (const fn of ["buildDeck", "shuffle", "beats", "legalCards", "cardPoints",
                    "winningIndex", "trickPoints", "sortHand"])
    assert.ok(!new RegExp(`function\\s+${fn}\\s*\\(`).test(solo),
      `solo defines its own ${fn}() — that is the duplication this replaced`);
});

test("the root single-player copy is gone", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "index.html")),
    "root index.html held a drifted engine copy and must not come back");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/solo.test.js`
Expected: FAIL on both — `app/js/solo.js` does not exist yet and root `index.html` still does.

- [ ] **Step 3: Write `app/js/solo.js`**

The controller drives the engine directly, with no server. It replaces the old mutable `state` global with the engine's `G`:

```js
/* Single-player: the same engine the server runs, driven in-page. There is no
   room, no socket and no redaction — the local player is always seat 0. */
import * as E from "/js/core/engine/index.js";

let G = null, difficulty = "normal";
const ME = 0;

export function startSolo(opts) {
  difficulty = opts.difficulty;
  G = E.createMatch(["You", "West", "North", "East"], { targetDeals: opts.targetDeals });
  E.startMatch(G);
  step();
}
```

`step()` is the whole controller — it replaces the old file's hand-rolled phase dispatch:

```js
const AI_DELAY = 700, TRICK_DELAY = 1600;   // copy the old file's actual values

function step() {
  const ra = E.requiredActor(G);

  if (G.phase === "trickEnd") { setTimeout(() => { E.advanceTrick(G); paint(); step(); }, TRICK_DELAY); return; }
  if (G.phase === "roundEnd") { paint(); return; }    // player clicks "next deal" -> E.nextDeal(G); paint(); step();
  if (G.phase === "matchOver") { paint(); showMatchOver(); return; }

  if (!ra) { paint(); return; }
  if (ra.seat === ME) { paint(); return; }            // wait for input; the click handlers call step() again

  setTimeout(() => {
    const a = E.aiActionFor(G, ra.seat, difficulty);
    apply(ra.seat, a);
    paint();
    step();
  }, AI_DELAY);
}

/* One place where an action reaches the engine, whether it came from a click
   or from the AI — so the legality guard cannot be bypassed by one path. */
function apply(seat, a) {
  if (!a) return;
  if (a.type === "bid")   { if (a.value === null || E.bidIsLegal(G, seat, a.value)) E.applyBid(G, seat, a.value); }
  if (a.type === "trump") E.applyTrump(G, a.suit);
  if (a.type === "call")  { if (E.callIsLegal(G, a.card)) E.applyCall(G, a.card); }
  if (a.type === "play")  { if (E.playIsLegal(G, seat, a.card)) E.applyPlay(G, seat, a.card); }
}
```

`resolveTrick` is deliberately absent — `applyPlay` calls it itself once the fourth card lands, which is why it is not in the engine's public surface. Do not look for it; the only trick-level call the controller makes is `advanceTrick`.

This mirrors `drive()` in `src/core/room/drive.js`, which paces the server the same way (trickEnd delay, roundEnd gate, otherwise `requiredActor` + AI delay). Read that function first — it is the proven version of this loop.

Read `AI_DELAY` and `TRICK_DELAY` off the deleted root `index.html` (recover it with `git show HEAD~1:index.html` if you have already removed it) so the pacing is unchanged. The player's click handlers call `apply(ME, …)` then `paint()` then `step()` — the same path the AI takes.

`paint()` calls `E.publicView(G, ME)` and hands the result to the render modules. Reuse `cards/deck.js`, `cards/labels.js`, `ui/hand.js`, `ui/log.js`, `ui/modals.js` and `util/dom.js` rather than re-deriving them. Where a UI module currently reads `S.view`, pass the view in as an argument instead of populating `S` — solo has no session, and writing to `S` from here would couple the two clients.

- [ ] **Step 4: Write `app/solo.html`**

Markup only, mirroring `app/index.html`: the same five `<link>` tags in the same cascade order, the game markup, a difficulty select offering **easy / normal / hard** (the old file offered only easy and normal) and a target-deals select offering **3 / 5 / 7** (the old file was fixed at 5), and:
```html
<script type="module" src="/js/solo.js"></script>
```

- [ ] **Step 5: Delete the root copy**

```bash
git rm index.html
```

- [ ] **Step 6: Delete the byte-equality test**

Remove the `offline fallback is the untouched root single-player game (D12)` test from `test/pwa.test.js` (~lines 122-128) along with its `rootGame`/`solo` reads. `test/solo.test.js` replaces it and asserts something stronger.

- [ ] **Step 7: Rebuild and run the suite**

Run: `npm run build:assets && npm test`
Expected: all pass, including both new solo tests.

- [ ] **Step 8: Play a full solo match**

Run: `npm start`, open `http://localhost:3000/solo.html`. Play a complete match to the target: bidding with all three AI seats, trump selection, partner call, thirteen tricks, the round-over panel, then subsequent deals until someone reaches the target. Repeat once on **hard** and confirm the AI takes visibly longer to play (that is PIMC searching) without freezing the page.

- [ ] **Step 9: Confirm offline still reaches the solo game**

Run: `npm start`, load the page, let the service worker activate, tick DevTools "Offline", then navigate to a URL that is not cached.
Expected: the offline fallback serves `/solo.html` and it is playable.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: solo game runs on the shared engine

Deletes the root index.html copy, which had drifted: Math.random deals
instead of the CSPRNG, no hard/PIMC AI, no targetDeals. Solo now
inherits all three. Supersedes ROADMAP D12."
```

---

# Milestone 6 — Documentation

## Task 22: Update the docs

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Create: `docs/STRUCTURE.md`

**Interfaces:**
- Consumes: Tasks 1-21
- Produces: no code interfaces

- [ ] **Step 1: Update `README.md`**

- "Run it": `npm start` is unchanged, but note the entry is now `src/server/index.js`.
- "How it works": replace references to `engine.js`, `room.js`, `server.js` and `src/worker.js` with the new directories.
- "Tests": `node --test test/` is unchanged; mention `npm run build:assets` must run after touching anything under `app/`.
- Add a short repo-structure section pointing at `docs/STRUCTURE.md`.
- Remove any claim that the solo game is a self-contained file openable from disk — it is not, as of Task 21.

- [ ] **Step 2: Update `ROADMAP.md`**

Amend D12 in place rather than deleting it, so the history stays readable:

```markdown
- **D12. ~~Root `index.html` (offline game) stays untouched~~** — SUPERSEDED 2026-07-27 by
  `docs/superpowers/specs/2026-07-27-project-structure-design.md`. The copy had drifted from the
  engine (`Math.random` deals, no hard AI, no `targetDeals`), so it was deleted and the solo game
  rebuilt on the shared engine at `app/js/core/engine/`. The offline fallback is now
  `app/solo.html`, served by the service worker.
```

Add the S1-S10 decisions from the spec's decision log as D13-D22, so future sessions do not re-litigate the bundler, the `app/` naming or the `S` object.

- [ ] **Step 3: Write `docs/STRUCTURE.md`**

A navigation map, not prose: the file-structure table from this plan's header, the engine layer table from the spec, and three rules — consumers import barrels; the engine lives under `app/` because the browser must fetch it; `src/core/room/` must never ship to a client.

- [ ] **Step 4: Verify every path mentioned in the docs exists**

```bash
grep -ohE '(app|src|test|scripts|docs)/[A-Za-z0-9_./-]+' README.md ROADMAP.md docs/STRUCTURE.md \
  | sort -u | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
```
Expected: no output.

- [ ] **Step 5: Run the suite one last time**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Confirm the restructure hit its goal**

```bash
find app/js src -name '*.js' | xargs wc -l | sort -rn | head -12
```
Expected: no file over ~300 lines. The largest should be `screens/game.js` and `src/core/room/handlers.js`. If something is still over 400, it needs a further split — note it rather than leaving it silent.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: repo structure, superseded D12, decision log"
```

---

## Verification checklist

Run before considering the plan complete:

- [ ] `npm test` — all suites pass
- [ ] `npm run build:assets -- --check` — prints "generated assets are up to date"
- [ ] `npm start` — full multiplayer match, two browser tabs
- [ ] `npx wrangler dev` — full match, plus a mid-match reload restoring from DO storage
- [ ] `http://localhost:3000/solo.html` — full solo match on hard difficulty
- [ ] DevTools offline mode — shell loads from cache, solo game reachable
- [ ] `grep -rn "require(\|module.exports" --include=*.js . | grep -v node_modules` — no output
- [ ] `find app/js src -name '*.js' | xargs wc -l | sort -rn | head -3` — nothing over ~300 lines
- [ ] Phone width (390px) — bottom sheet, touch targets, safe areas all correct
