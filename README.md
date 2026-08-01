# TRUMP — Online Multiplayer

A 250-point bid & capture trick-taking card game for 2–4 people. Empty seats are played by AI, so a
half-full table still plays a proper game. No accounts, no install — share a 4-letter room code.

Two interchangeable backends run the same game core: a small **node + ws** server for LAN/self-hosting,
and **Cloudflare Workers + Durable Objects** for a global deploy that fits inside Cloudflare's free tier
([caveats](#deploy-to-cloudflare)).

## Run it

```bash
npm install      # one dependency (ws)
npm start        # runs src/server/index.js
```

Open **http://localhost:3000**.

- **With friends on your network:** they open `http://<your-LAN-IP>:3000` (printed on start). One person
  hits **Create Room** and shares the code — or just the page URL, which carries `?room=CODE`.
- **Over the internet:** host it anywhere reachable (VPS, `ngrok http 3000`, Cloudflare Tunnel), or deploy
  to Cloudflare (below).
- **Solo:** **Play vs 3 Bots** deals immediately, no lobby.

## What's in the game

| | |
|---|---|
| **Seats** | Sit, stand, and swap seats freely in the lobby; the host can kick (removed players stay out for the life of the room). Extra people spectate and are promoted automatically when a seat frees up. |
| **Joining mid-match** | You can walk into a game in progress and take over an AI seat — but you are dealt in at the **next deal**, not mid-hand. Taking a seat is what reveals a hand, so handing one out mid-deal would let a player stand up, sit elsewhere, and read the table. Standing up mid-match gives your seat to the AI immediately. |
| **AI skill** | `easy` / `normal` / `hard`. Hard's card play is Perfect-Information Monte Carlo: it samples deals consistent with everything it has seen (voids, the called card) and rolls each candidate move out, under a fixed budget of simulated card plays. Hard also searches **the bid** the same way — sampling whole deals and bidding on a real make-probability instead of the linear hand-count `easy`/`normal` use — which is what gives the three tiers an identity beyond card play. Naming trump and calling a partner stay on the hand-count at every tier: searching them measured as worth +0.56 ± 0.42 pp of deals won, indistinguishable from zero, for 43% of the auction's server CPU (ROADMAP D35). Changeable mid-match. |
| **Hints** | A button suggests the strongest bid, trump, call or card, with one line of reasoning from the same search the `hard` bots run. Host-controlled from the lobby or mid-match settings, defaults on, and shown to every seat as a settings chip. This is a table agreement, not an enforcement boundary: the engine ships to every browser, so nothing stops a determined player from running the identical search in a console regardless of what the setting says. |
| **Table read** | A rail panel (folded into the mobile Score tab) showing points still live, what your side still needs, the bonus three's status, known voids, and outstanding cards per suit. Public information the whole table already watched happen, so — unlike hints — it is never gated by a setting. |
| **Deal review** | A `Review this deal ▸` toggle on the round-result modal, and on the match summary for the deal that clinches it, replays your own decision points against the same search and grades what you played against what it preferred. Computed on click; never blocks the ready gate or the rematch button. |
| **Match length** | First to **3, 5 or 7** deals. |
| **Turn timer** | Off / 15 / 30 / 45 / 60 / 90s. When it expires the AI plays your turn and marks you *away*; the next thing you do (or the **I'm back** button) takes you off autopilot. |
| **Between deals** | The next deal starts when every present player clicks **ready**, or after 30s — whichever comes first. |
| **Chat & emotes** | Chat panel with a 50-message ring, plus six reactions that float over your seat. |
| **Reconnect** | Your seat is held and AI-played while you're gone; the newest connection for a session wins, so a second tab or a phone takes over cleanly. |
| **Offline** | Installable PWA. The app shell is precached and keeps working with no network at all — that's the generic offline fallback for any navigation. The standalone solo game (`app/solo.html`) is precached too and playable offline if you navigate to it directly (a link, a bookmark, the manifest shortcut), but it does not replace the shell as the fallback. Either way, the page needs to have been loaded once while online first. |
| **Accessibility** | Cards are real buttons (Tab / Enter), labelled "play ace of spades"; the table log and chat are live regions; optional 4-colour deck (♦ blue, ♣ green). |
| **Mobile** | Below 900px the sidebar becomes a bottom sheet with **Score / Log / Chat** tabs — nothing is hidden. |

Room codes are 4 characters; ticking **Private room** mints an 8-character one instead.

## Deploy to Cloudflare

One Durable Object per room holds the authoritative state, so it works globally with nothing to manage.

**Free plan or paid?** Both work — the DO is SQLite-backed (`new_sqlite_classes`), which is the backend
Workers Free supports. Two things to know before deploying on the free plan:

- Free-plan Workers are capped at **10 ms of CPU per invocation** (paid: 30 s by default). The `hard`
  tier's worst single decision measures 3.3–8.1 ms here, so it fits — but with less headroom than paid,
  and a busier machine can eat it. `easy`/`normal` never search at all.
- The `[limits]` block in `wrangler.toml` is a paid-plan feature (Standard Usage Model). **Delete it** if
  you deploy on the free plan; it is a denial-of-wallet guard, and the free plan has no wallet to defend.

```bash
npm install
npx wrangler login      # one-time
npm run deploy
```

This deploys a single Worker that serves both the static client (`app/`) and the realtime backend on
one origin. Local preview: `npm run dev` (Worker + DO under workerd at `127.0.0.1:8787`).

The DO uses the **WebSocket Hibernation API**, so it is evicted between messages instead of billing for a
whole match, **persists** room state to DO storage after every event (matches survive deploys and
evictions), and schedules turn/trick/deal timers as a single **alarm** — which fires even while hibernated.
On wake it reconciles `connected` against the live sockets and re-arms the empty-room expiry, so a room
whose players vanished mid-hibernation is still collected.

The hard AI budgets itself in *simulated card plays*, not milliseconds: Workers freeze `Date.now()` between
I/O operations, so a wall-clock cutoff never fires inside a Durable Object and the widest search position
(13 legal moves, 52 cards live) would run at full width on every deal.

**What that costs, in the unit the platform bills.** Hibernation makes every inbound message its own
invocation, and each alarm fires exactly one bot action — so the number that matters is the worst *single*
decision, not a per-deal total. Measured through the real router (`node scripts/bench-auction-search.js
cost`, all four seats on `hard`, ~8,500 invocations): median 0.5 ms, p95 ~2 ms, worst 3.3–8.1 ms run to
run; a whole deal's four seats come to ~50 ms spread over ~53 separate invocations. `wrangler.toml` sets
`[limits] cpu_ms = 300` as a runaway guard well clear of that.

**Pages + separate Worker (optional split):** remove the `[assets]` block from `wrangler.toml`, set
`WS_BASE` in `app/js/net.js` to your Worker URL (e.g. `wss://trump.<you>.workers.dev`), deploy the
Worker, and publish `app/` to Pages.

### Optional player stats (D1)

Entirely opt-in. Without a DB binding nothing is written and the join screen simply shows no record.

```bash
npx wrangler d1 create trump-stats
npx wrangler d1 execute trump-stats --remote --file=./schema.sql
# then uncomment the [[d1_databases]] block in wrangler.toml and paste the printed database_id
```

At match end the DO writes one row per human seat (`schema.sql`), keyed by a random `uid` the browser
mints into `localStorage` — no accounts and no personal data. `GET /stats?uid=…` returns
`{games, wins, bidsWon, bidsMade}`, which the join screen shows as *"Your record"*. The node backend has
no stats endpoint; the line just stays hidden.

## How it works

```
app/js/core/engine/   pure game rules + AI          ─┐
src/core/room/        pure room state machine        ├─ no I/O, fully JSON-serializable
                                                     ─┘
src/server/     node adapter: ws sockets, setTimeout, static files, per-IP caps
src/worker/     Cloudflare adapter: hibernating DO, storage, alarms, D1 stats
app/            everything the browser is served: the client (multiplayer + solo shells, PWA
                assets) AND the shared engine, which the browser must fetch too
scripts/        build-assets.js (regenerates the service worker's precache list + cache
                version by walking app/), gen-icons.js
```

- **`app/js/core/engine/`** — deal, auction, trump and partner call, trick play, scoring, and the three
  AI levels. Pure functions over a game object, split into 14 acyclic modules behind one barrel
  `index.js`. It lives under `app/`, not `src/`, because the browser has to fetch it — see
  `docs/STRUCTURE.md` for the full layer table and why.
- **`src/core/room/`** — everything around the game: seats, host, settings, chat, ready gate, timers, and
  the **redacted per-viewer view**. Every function is `(room, …, now) -> effects`; it never touches a
  socket, a clock or storage. Timers are *data* (`room.timers`), so the adapter arms exactly one
  `setTimeout`/alarm for the earliest one — that is what lets the same core hibernate on Cloudflare.
  This subtree holds every seat's hand and is never served to a client.
- **Adapters** (`src/server/`, `src/worker/`) own sockets, rate limits, persistence and origin checks,
  and apply the effects (`broadcast`, `sends`, `closes`, `emote`, `deleteRoom`) the core returns.
- **`scripts/build-assets.js`** walks `app/` to regenerate `app/sw.js`'s precache list and cache
  `VERSION` (a hash of the shell, so a deploy actually evicts the old precache). Run
  `npm run build:assets` after touching anything under `app/` — `npm test` fails if it's stale.
- **`app/index.html`** / **`app/solo.html`** — thin markup shells that load the client's ~20 JS modules
  and 5 stylesheets: a rendering of server (or, for solo, in-browser engine) state, rotated so you
  always sit at the bottom, plus the lobby, chat and PWA wiring.

## Repo structure

The client, the shared game engine, the room state machine and both server adapters each live in their
own small modules instead of one big file per concern. `docs/STRUCTURE.md` has the full map: every
file's responsibility, the engine's acyclic layer table, and the import rules (barrel vs. leaf module,
relative vs. absolute) worth knowing before touching anything under `app/` or `src/`.

## Tests

```bash
npm test              # node --test, no dependencies (bare — no path argument, see docs/STRUCTURE.md)
npm run build:assets  # after touching anything under app/: refreshes the sw precache list + cache version
```

Three kinds of test, worth telling apart:

- **Property tests over real simulations** (`engine`, `ai`, `room`) — the substantive ones. Random and
  AI-driven full matches asserting the deck/trick/score laws (250 points accounted for per deal,
  follow-suit, bidding terminates, forced bid after five passes); the determinizer's soundness and the
  hard AI's legality, budget and strength; the **hand-secrecy property** — not just that one view is
  redacted, but that no player can *collect* two hands in a deal by standing, sitting, or rejoining;
  5k-message fuzzing; the room flows (reconnect, host reassign, kick-and-stay-kicked, ready gate,
  turn-timer autopilot, chat ring, expiry) on a simulated clock.
- **Adapter tests over real sockets and a real Worker** (`server`, `worker`) — the socket↔player
  bookkeeping the core never sees (a connection that re-joins must not strand its old identity), path
  traversal, and the Worker's routing/origin/stats behaviour.
- **Tests over the client** (`client`, `client-modules`, `cards`, `pwa`, `solo`) — the client is real ES
  modules now, so most of this group imports them directly: `client-modules` loads every file under
  `app/js/` as a real module and asserts every import specifier resolves and is relative, never absolute;
  `cards` unit-tests `cards/labels.js` and `cards/deck.js` for real; `solo` asserts `app/solo.html` +
  `app/js/solo.js` import `core/engine` and re-implement none of its rules functions, and that the
  deleted root `index.html` stays gone. `client` and `pwa` still read some things as text — the protocol
  vocabulary (message types, emote set, option lists) never meets as a runtime value on both sides, so
  there is nothing to import and compare directly — and `pwa` reads the stylesheets' *declarations* (not
  their formatting) for touch-target floors, safe areas and dynamic viewport, and calls
  `scripts/build-assets.js`'s `check()` so a stale precache fails the suite. Self-contained functions
  (`syncWindow`, `esc`) are lifted out and executed for real either way. There is no DOM harness — that
  would mean a dependency, and `npm test` deliberately has none.

CI runs the suite on node 20 and 22.

## Security / trust model

A friendly party game, not a hardened service — but the server is **authoritative**: it validates every
move, and no player can be shown more than their own hand for a deal (asserted by tests, not just by
construction).

- **Hand secrecy** is a property of seating, not just of the view: seats are handed out at deal boundaries
  once a match is under way, so standing up and sitting elsewhere — or leaving and rejoining under a fresh
  identity — cannot show you a second hand.
- **The deal comes off the platform CSPRNG**, not `Math.random`. V8's generator is `xorshift128+` and its
  state is recoverable from a handful of outputs — and the cards you are dealt *are* outputs. Sharing that
  stream would leak future deals and, since they are minted the same way, other players' session tokens.
- Sessions are a random `playerId` bearer token in `localStorage`, expiring after 3h and cleared on
  **Leave**. The newest connection for a token supersedes older ones; a connection that re-joins retires
  its previous identity instead of stranding it.
- WebSocket upgrades are rejected when a browser presents a cross-site `Origin` (allow-list via
  `ALLOW_ORIGIN`); non-browser clients without the header still connect.
- Caps: message size and rate, sockets per IP, rooms per server, players per room, chat length. At the room
  cap the node server recycles an empty room rather than turning real players away.
- **Create Room** refuses a code that is already in use and mints another, so you can never be dropped
  into a stranger's lobby by a collision.
- Don't leave a session on a shared machine if you care about someone resuming your seat.

## Config

`PORT` (default 3000), `ALLOW_ORIGIN` (comma-separated extra origins), `MAX_ROOMS` (default 500), and
`AI_DELAY`, `TRICK_DELAY`, `ROUND_DELAY` in milliseconds.

`TRUST_PROXY=1` makes the per-IP socket cap read `X-Forwarded-For`. Leave it off unless something upstream
(nginx, Cloudflare, a tunnel) actually sets that header — it is caller-controlled, so trusting it without a
proxy in front lets anyone forge past the cap. With it off behind a proxy, everyone shares one budget.

## Rules (quick)

- The deck holds **250 points**: A/K/Q/J/10 = 10 each, every 5 = 5, and one **random suit's 3 = 30**
  (announced before bidding).
- **Bid** the points your side will capture (min 130, steps of 5) or pass; highest bidder wins.
- The bid winner picks **trump** and **calls a card they don't hold** — its holder becomes their partner,
  and teams are revealed at once.
- The bid winner leads. Follow suit if you can; highest trump wins a trick, else the highest card of the
  led suit; the winner captures its point-cards and leads next.
- Make the bid → the bidding side wins the deal; fall short → the defenders win it. First to the target
  number of deals wins the match.
