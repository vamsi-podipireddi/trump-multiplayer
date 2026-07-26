# TRUMP — Online Multiplayer

A 250-point bid & capture trick-taking card game for 2–4 people. Empty seats are played by AI, so a
half-full table still plays a proper game. No accounts, no install — share a 4-letter room code.

Two interchangeable backends run the same game core: a small **node + ws** server for LAN/self-hosting,
and **Cloudflare Workers + Durable Objects** for a free global deploy.

## Run it

```bash
npm install      # one dependency (ws)
npm start        # or: node server.js
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
| **Seats** | Sit, stand, and swap seats in the lobby; the host can kick. Extra people spectate and are promoted automatically when a seat frees up. |
| **AI skill** | `easy` / `normal` / `hard`. Hard is Perfect-Information Monte Carlo: it samples deals consistent with everything it has seen (voids, the called card) and rolls each candidate move out. Changeable mid-match. |
| **Match length** | First to **3, 5 or 7** deals. |
| **Turn timer** | Off / 15 / 30 / 45 / 60 / 90s. When it expires the AI plays your turn and marks you *away*; the next thing you do (or the **I'm back** button) takes you off autopilot. |
| **Between deals** | The next deal starts when every present player clicks **ready**, or after 30s — whichever comes first. |
| **Chat & emotes** | Chat panel with a 50-message ring, plus six reactions that float over your seat. |
| **Reconnect** | Your seat is held and AI-played while you're gone; the newest connection for a session wins, so a second tab or a phone takes over cleanly. |
| **Offline** | Installable PWA. With no network, it falls back to the self-contained single-player build. |
| **Accessibility** | Cards are real buttons (Tab / Enter), labelled "play ace of spades"; the table log and chat are live regions; optional 4-colour deck (♦ blue, ♣ green). |
| **Mobile** | Below 900px the sidebar becomes a bottom sheet with **Score / Log / Chat** tabs — nothing is hidden. |

Room codes are 4 characters; ticking **Private room** mints an 8-character one instead.

## Deploy to Cloudflare (free)

One Durable Object per room holds the authoritative state, so it works globally with nothing to manage.

```bash
npm install
npx wrangler login      # one-time
npm run deploy
```

This deploys a single Worker that serves both the static client (`public/`) and the realtime backend on
one origin. Local preview: `npm run dev` (Worker + DO under workerd at `127.0.0.1:8787`).

The DO uses the **WebSocket Hibernation API**, so it is evicted between messages instead of billing for a
whole match, **persists** room state to DO storage after every event (matches survive deploys and
evictions), and schedules turn/trick/deal timers as a single **alarm** — which fires even while hibernated.

**Pages + separate Worker (optional split):** remove the `[assets]` block from `wrangler.toml`, set
`WS_BASE` near the top of `public/index.html` to your Worker URL (e.g. `wss://trump.<you>.workers.dev`),
deploy the Worker, and publish `public/` to Pages.

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
engine.js   pure game rules + AI          ─┐
room.js     pure room state machine        ├─ no I/O, fully JSON-serializable
                                          ─┘
server.js       node adapter: ws sockets, setTimeout, static files, per-IP caps
src/worker.js   Cloudflare adapter: hibernating DO, storage, alarms, D1 stats
public/         the networked client (single file) + PWA assets
index.html      the original offline single-player game (untouched; copied to public/solo.html)
```

- **`engine.js`** — deal, auction, trump and partner call, trick play, scoring, and the three AI levels.
  Pure functions over a game object.
- **`room.js`** — everything around the game: seats, host, settings, chat, ready gate, timers, and the
  **redacted per-viewer view**. Every function is `(room, …, now) -> effects`; it never touches a socket,
  a clock or storage. Timers are *data* (`room.timers`), so the adapter arms exactly one
  `setTimeout`/alarm for the earliest one — that is what lets the same core hibernate on Cloudflare.
- **Adapters** own sockets, rate limits, persistence and origin checks, and apply the effects
  (`broadcast`, `sends`, `closes`, `emote`, `deleteRoom`) the core returns.
- **`public/index.html`** — the client: a thin view of server state, rotated so you always sit at the
  bottom, plus the lobby, chat and PWA wiring.

## Tests

```bash
npm test          # node --test, no dependencies
```

Covers: engine invariants over random full matches (250 points accounted for per deal, follow-suit,
bidding terminates, forced bid after five passes), the hard AI's legality and strength versus easy, the
**redaction property** (a view built for one seat never contains another seat's cards) across full
simulated games, 5k-message fuzzing, room flows (reconnect, host reassign, kick, sit/stand, ready gate,
turn-timer autopilot, chat ring, expiry), the Worker's routing/origin/stats behaviour, and contract tests
that pin the client to the core protocol and the PWA/a11y wiring. CI runs it on node 20 and 22.

## Security / trust model

A friendly party game, not a hardened service — but the server is **authoritative**: it validates every
move and never sends a player another hand (asserted by tests, not just by construction).

- Sessions are a random `playerId` bearer token in `localStorage`, expiring after 3h and cleared on
  **Leave**. The newest connection for a token supersedes older ones.
- WebSocket upgrades are rejected when a browser presents a cross-site `Origin` (allow-list via
  `ALLOW_ORIGIN`); non-browser clients without the header still connect.
- Caps: message size and rate, sockets per IP, rooms per server, players per room, chat length.
- **Create Room** refuses a code that is already in use and mints another, so you can never be dropped
  into a stranger's lobby by a collision.
- Don't leave a session on a shared machine if you care about someone resuming your seat.

## Config

`PORT` (default 3000), `ALLOW_ORIGIN` (comma-separated extra origins), and `AI_DELAY`, `TRICK_DELAY`,
`ROUND_DELAY` in milliseconds.

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
