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
- **D11. Tests**: `node --test test/`. Engine invariant playouts + rule edges; room-core redaction property
  (serialized view for seat A never contains seat B's hand), message fuzzing, flow tests. CI = GitHub Actions.
- **D12. Root `index.html` (offline game) stays untouched**; copied to `public/solo.html` as the PWA offline fallback.

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
