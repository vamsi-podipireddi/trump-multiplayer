/* ============================================================
   TRUMP — Cloudflare Worker + Durable Object adapter.

   One Durable Object per room (addressed by room code via idFromName).
   Room/game logic lives in src/core/room/ (shared with src/server/); this file
   owns the platform bits:

   - WebSocket HIBERNATION API (ctx.acceptWebSocket + webSocketMessage/
     Close/Error handlers): the DO is evicted between events instead of
     burning duration for a whole match. Each socket carries its pid in
     a serialized attachment, so identity survives hibernation.
   - PERSISTENCE: the whole room state (pure JSON) is written to
     ctx.storage after every event and restored on wake — matches
     survive deploys, evictions, and restarts.
   - ALARMS: the room core models timers as data; we arm one storage alarm
     for the earliest due timer. Alarms fire even while hibernated.
   ============================================================ */
import * as R from "../core/room/index.js";
import { okOrigin } from "./origin.js";
import { readStats } from "./stats.js";

// ============================================================
//  Worker entry: static assets + WebSocket routing (+ /stats in M8)
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      if (!okOrigin(request, url, env))
        return new Response("forbidden origin", { status: 403 });
      const code = R.normCode(url.searchParams.get("room"));
      if (!code) return new Response("missing room code", { status: 400 });
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }
    if (url.pathname === "/health")
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/stats")
      return readStats(env, String(url.searchParams.get("uid") || "").slice(0, 32));
    if (env.ASSETS) return env.ASSETS.fetch(request); // single-Worker deploy serves the client
    return new Response("not found", { status: 404 });
  },
};

// Re-exported so Wrangler can resolve the "RoomDO" class named in wrangler.toml's
// Durable Object binding and [[migrations]] block — the class itself lives in room-do.js.
export { RoomDO } from "./room-do.js";
