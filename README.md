# TRUMP — Online Multiplayer

A 250-point bid & capture trick-taking card game for 2–4 players (empty seats are played by AI).

## Run it

```bash
npm install      # installs the one dependency (ws)
npm start        # or: node server.js
```

Then open **http://localhost:3000** in a browser.

- **Play with friends on the same network:** they open `http://<your-LAN-IP>:3000` (the server prints a hint on start). On the join screen, one person clicks **Create New Room** and shares the 4‑letter **room code** (or the page URL — it includes `?room=CODE`); the others enter that code.
- **Play over the internet:** run the server on a host reachable by the others (a VPS, or a tunnel such as `ngrok http 3000` / Cloudflare Tunnel) and share that URL.
- **Solo:** create a room and just click **Start** — the three empty seats become AI.

## Deploy to Cloudflare (online, free)

The realtime backend also runs on **Cloudflare Workers + Durable Objects** — one Durable Object per room holds the authoritative state, so it works globally with no server to manage. The free plan covers it.

```bash
npm install
npx wrangler login      # one-time
npm run deploy          # wrangler deploy
```

That deploys a single Worker that serves the **static client** (`public/`) *and* the realtime backend on the same origin — open the printed `*.workers.dev` URL and play. Local preview: `npm run dev` (runs the Worker + Durable Object under Miniflare at `127.0.0.1:8787`).

**Pages + separate Worker (optional split):** if you'd rather host the client on Cloudflare **Pages** and run only the backend as a Worker: remove the `[assets]` block from `wrangler.toml`, set `WS_BASE` near the top of `public/index.html` to your Worker's URL (e.g. `wss://trump-multiplayer.<you>.workers.dev`), `npm run deploy` the Worker, and deploy `public/` to Pages.

> Notes: rooms are addressed by their 4‑letter code (`/ws?room=CODE`), which the client mints on **Create**/**Solo** — a code collision across two simultaneous "create" actions is ~1-in-900k and just joins you to the same room. Game state lives in the Durable Object's memory; if **everyone** disconnects mid-match the room is cleaned up (same as restarting the local server). `node server.js` still works unchanged for LAN play.

## How it works

- **`engine.js`** — the authoritative game logic (deal, auction, trump/partner call, trick play, AI, scoring). Pure functions over a game object; no I/O.
- **`server.js`** — HTTP (serves the client) + WebSocket. Holds the authoritative state per room, assigns seats, fills empty/disconnected seats with AI, and sends each client a **redacted view that contains only their own hand** (opponents are card counts). Validates every action server-side.
- **`public/index.html`** — the networked client. A thin view rendered from server state, rotated so you always sit at the bottom. Lobby with room codes; reconnect is automatic (your seat is held and AI-played while you're away).
- **`src/worker.js`** + **`wrangler.toml`** — the Cloudflare deploy. `worker.js` reuses `engine.js` verbatim and ports `server.js`'s room logic into a `RoomDO` Durable Object (one per room); the Worker routes `/ws?room=CODE` to it and serves the static client. `server.js` remains the equivalent backend for local/LAN play.

The original offline single-player version remains at **`index.html`** in the repo root (double-click to play vs. AI with no server).

## Rules (quick)

- The deck holds **250 points**: A/K/Q/J/10 = 10 each, every 5 = 5, and one **random suit's 3 = 30** (announced before bidding).
- **Bid** the points your side will capture (min 130, steps of 5) or pass; highest bidder wins.
- The bid winner picks **trump** and **calls a card they don't hold** — its holder becomes their partner (teams shown immediately).
- The bid winner leads. Follow suit if you can; highest trump wins a trick, else the highest card of the led suit; the winner captures its point-cards and leads next.
- Make the bid → bidding side wins the deal; fall short → defenders win it. **First player to 5 deals won wins the match.**

## Security / trust model

This is a friendly party game, not a hardened service. The server is **authoritative** — it validates every move and never sends a player another hand (verified by tests). Sessions use a random `playerId` as a bearer token (stored in `localStorage`, auto-expires after 3h, cleared on **Leave**); the **newest connection for a token wins** and supersedes any older one, so reconnects "just work" and a second tab takes over the first. Don't share your room on an untrusted/shared machine if you care about someone resuming your seat. Basic abuse caps are in place (per-message size, message rate, rooms, and players per room).

## Config

Environment variables (optional): `PORT` (default 3000), `AI_DELAY`, `TRICK_DELAY`, `ROUND_DELAY` (milliseconds).
