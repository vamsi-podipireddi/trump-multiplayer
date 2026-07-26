"use strict";
/* ============================================================
   TRUMP — Cloudflare Worker + Durable Object adapter.

   One Durable Object per room (addressed by room code via idFromName).
   Room/game logic lives in room.js (shared with server.js); this file
   owns the platform bits:

   - WebSocket HIBERNATION API (ctx.acceptWebSocket + webSocketMessage/
     Close/Error handlers): the DO is evicted between events instead of
     burning duration for a whole match. Each socket carries its pid in
     a serialized attachment, so identity survives hibernation.
   - PERSISTENCE: the whole room state (pure JSON) is written to
     ctx.storage after every event and restored on wake — matches
     survive deploys, evictions, and restarts.
   - ALARMS: room.js models timers as data; we arm one storage alarm
     for the earliest due timer. Alarms fire even while hibernated.
   ============================================================ */

import R from "../room.js";

const MSG_RATE = 100; // msgs/sec per socket

function okOrigin(request, url, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // non-browser client
  try { if (new URL(origin).host === url.host) return true; } catch {}
  const allow = (env && env.ALLOW_ORIGIN ? String(env.ALLOW_ORIGIN) : "").split(",").map(s => s.trim()).filter(Boolean);
  return allow.includes(origin);
}

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
    if (url.pathname === "/stats") return statsResponse(url, env);
    if (env.ASSETS) return env.ASSETS.fetch(request); // single-Worker deploy serves the client
    return new Response("not found", { status: 404 });
  },
};

/* Optional player stats, backed by D1 when a DB binding exists (see schema.sql). */
async function statsResponse(url, env) {
  const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
  if (!env.DB) return json({ available: false });
  const uid = String(url.searchParams.get("uid") || "").slice(0, 32);
  if (!uid) return json({ error: "missing uid" }, 400);
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS games, SUM(won) AS wins, SUM(was_declarer) AS bidsWon, SUM(bid_made) AS bidsMade FROM matches WHERE uid = ?"
    ).bind(uid).first();
    return json({ available: true, games: row.games | 0, wins: row.wins | 0, bidsWon: row.bidsWon | 0, bidsMade: row.bidsMade | 0 });
  } catch {
    return json({ available: false });
  }
}

// ============================================================
//  RoomDO — hibernating, persistent room
// ============================================================
export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.rl = new WeakMap(); // per-socket rate limiter; resets on wake (fine)
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) || null;
      if (!this.room) return;
      /* The live sockets are the source of truth for who is connected; the
         stored state may predate a crash. R.reconcile also re-arms the empty-room
         expiry, so a room whose players all vanished mid-hibernation still gets
         collected instead of sitting in storage forever. */
      const live = [];
      for (const ws of ctx.getWebSockets()) {
        const att = this.att(ws);
        if (att && att.pid) live.push(att.pid);
      }
      R.reconcile(this.room, live, Date.now());
      await this.persist();
      await this.armAlarm();
    });
  }

  att(ws) { try { return ws.deserializeAttachment(); } catch { return null; } }
  sockFor(pid) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.att(ws);
      if (att && att.pid === pid) return ws;
    }
    return null;
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 });
    if (!this.room) this.room = R.createRoom(R.normCode(url.searchParams.get("room")) || "ROOM");
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server); // hibernation API — DO may sleep between events
    return new Response(null, { status: 101, webSocket: client });
  }

  async persist() {
    if (this.room) await this.ctx.storage.put("room", this.room);
  }
  async armAlarm() {
    if (!this.room) return;
    const due = R.nextTimerDue(this.room);
    if (due != null) await this.ctx.storage.setAlarm(due);
    else await this.ctx.storage.deleteAlarm();
  }

  async applyFx(fx, ws) {
    if (!fx) return;
    if (fx.sends) for (const s of fx.sends) {
      if (s.pid == null) { if (ws) this.send(ws, s.obj); }
      else { const t = this.sockFor(s.pid); if (t) this.send(t, s.obj); }
    }
    if (fx.closes) for (const pid of fx.closes) {
      const t = this.sockFor(pid);
      if (t) { try { t.serializeAttachment({ pid: null }); t.close(1000, "kicked"); } catch {} }
    }
    if (fx.emote) {
      const msg = JSON.stringify({ type: "emote", seat: fx.emote.seat, e: fx.emote.e });
      for (const sock of this.ctx.getWebSockets()) { try { sock.send(msg); } catch {} }
    }
    if (fx.broadcast && this.room) {
      const now = Date.now();
      for (const sock of this.ctx.getWebSockets()) {
        const att = this.att(sock);
        if (att && att.pid && this.room.players[att.pid])
          this.send(sock, { type: "state", view: R.buildView(this.room, att.pid, now) });
      }
    }
    if (fx.deleteRoom) {
      for (const sock of this.ctx.getWebSockets()) { try { sock.close(1000, "room expired"); } catch {} }
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.room = null;
    }
  }

  /* `phaseBefore` opts this event into the end-of-match stats write. It has to
     happen before persist(), because recordStats() stamps its own idempotency
     flag onto G — written afterwards it would never reach storage. */
  async afterEvent(fx, ws, phaseBefore) {
    await this.applyFx(fx, ws);
    if (phaseBefore !== undefined && this.room && this.room.started &&
        this.room.G.phase === "matchOver" && phaseBefore !== "matchOver") await this.recordStats();
    if (this.room) { await this.persist(); await this.armAlarm(); }
  }

  // ---- hibernation event handlers ----
  async webSocketMessage(ws, data) {
    if (!this.room) return;
    let rl = this.rl.get(ws);
    const wall = Date.now();
    if (!rl || wall - rl.ts > 1000) { rl = { ts: wall, n: 0 }; this.rl.set(ws, rl); }
    if (++rl.n > MSG_RATE) return; // drop floods
    let msg; try { msg = JSON.parse(typeof data === "string" ? data : "{}"); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    try {
      if (msg.type === "join") {
        /* A socket that joins again is switching identity, not reconnecting.
           Retire the old pid first: nothing would map to it afterwards, yet the
           room would still count it connected — holding its seat and blocking
           the empty-room expiry forever. */
        const prev = this.att(ws);
        if (prev && prev.pid && this.room.players[prev.pid]) {
          ws.serializeAttachment({ pid: null });
          await this.applyFx(R.disconnect(this.room, prev.pid, wall, { immediate: true }), null);
        }
        const { pid, resumed, fx } = R.join(this.room, msg, wall);
        if (pid == null) { await this.applyFx(fx, ws); return; }
        if (resumed) {
          for (const other of this.ctx.getWebSockets()) {
            const att = this.att(other);
            if (other !== ws && att && att.pid === pid) {
              try { other.serializeAttachment({ pid: null }); other.close(1000, "superseded"); } catch {}
            }
          }
        }
        ws.serializeAttachment({ pid });
        await this.afterEvent(fx, ws);
        return;
      }
      const att = this.att(ws);
      if (!att || !att.pid) return;
      const before = this.room.started ? this.room.G.phase : null;
      const fx = R.message(this.room, att.pid, msg, wall);
      await this.afterEvent(fx, ws, before);
    } catch {
      this.send(ws, { type: "error", message: "server error" });
    }
  }

  async webSocketClose(ws) { await this.dropSocket(ws); }
  async webSocketError(ws) { await this.dropSocket(ws); }
  async dropSocket(ws) {
    const att = this.att(ws);
    if (!att || !att.pid || !this.room) return;
    // ignore if a newer socket owns this pid
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && (this.att(other) || {}).pid === att.pid) return;
    }
    const fx = R.disconnect(this.room, att.pid, Date.now());
    await this.afterEvent(fx, null);
  }

  async alarm() {
    if (!this.room) { await this.ctx.storage.deleteAlarm(); return; }
    const before = this.room.started ? this.room.G.phase : null;
    const fx = R.fireTimers(this.room, Date.now());
    await this.afterEvent(fx, null, before);
  }

  /* One row per human seat at matchOver, when a D1 binding exists (M8/D10). */
  async recordStats() {
    if (!this.env.DB || !this.room || this.room.G.phase !== "matchOver") return;
    if (this.room.G._statsRecorded) return;
    this.room.G._statsRecorded = true; // lives on G: a rematch swaps in a fresh G, clearing it
    const G = this.room.G;
    const max = Math.max(...G.scores);
    try {
      const stmts = [];
      for (let seat = 0; seat < 4; seat++) {
        const owner = this.room.seatOwner[seat];
        const p = owner != null ? this.room.players[owner] : null;
        if (!p || !p.uid) continue;
        const r = G.lastResult || {};
        stmts.push(this.env.DB.prepare(
          "INSERT INTO matches (uid, name, room, won, was_declarer, bid_made, ts) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(p.uid, p.name, this.room.code, G.scores[seat] === max ? 1 : 0,
               r.declarer === seat ? 1 : 0, r.declarer === seat && r.made ? 1 : 0, Date.now()));
      }
      if (stmts.length) await this.env.DB.batch(stmts);
    } catch { /* stats are best-effort */ }
  }
}
