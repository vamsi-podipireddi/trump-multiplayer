"use strict";
/* ============================================================
   TRUMP — Cloudflare Worker + Durable Object backend.

   One Durable Object instance per room (addressed by its room code
   via idFromName). The Worker serves the static client (env.ASSETS)
   and forwards WebSocket upgrades on /ws?room=CODE to that room's DO.

   Game logic lives in engine.js (pure, reused verbatim). We use the
   NON-hibernation WebSocket API (server.accept()), so the DO stays
   resident while a game is live — which means the original
   setTimeout-driven game loop from server.js ports almost unchanged.

   Deploy topologies (same code works for both):
     A) Single Worker + static assets  → set [assets] in wrangler.toml,
        client connects same-origin (WS_BASE = "").  [recommended]
     B) Pages (static) + this Worker    → drop [assets]; client sets
        WS_BASE to this Worker's wss:// URL.
   ============================================================ */

import E from "../engine.js";

const AI_DELAY = 800;              // ms an AI "thinks" before acting
const TRICK_DELAY = 1600;          // pause showing a completed trick
const ROUND_DELAY = 6000;          // pause showing round results
const LOBBY_GRACE_MS = 15 * 1000;  // hold a lobby seat through a brief disconnect
const MAX_PLAYERS_PER_ROOM = 12, MSG_RATE = 100; // basic abuse caps
const SEAT_LABEL = ["South", "West", "North", "East"];

function randId(n, alpha) {
  const chars = alpha ? "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" : "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function normCode(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); }
function codePoints(s, n) { return [...s].slice(0, n).join(""); } // truncate by code point (don't split emoji)

// ============================================================
//  Worker entry: static assets + WebSocket routing
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      const code = normCode(url.searchParams.get("room"));
      if (!code) return new Response("missing room code", { status: 400 });
      const id = env.ROOMS.idFromName(code);     // code -> one DO, globally
      return env.ROOMS.get(id).fetch(request);   // hand the upgrade to the room
    }
    if (url.pathname === "/health")
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    if (env.ASSETS) return env.ASSETS.fetch(request); // single-Worker deploy serves the client
    return new Response("not found", { status: 404 }); // Pages deploy serves the client itself
  },
};

// ============================================================
//  RoomDO — one room (authoritative game state + realtime)
// ============================================================
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.code = null;
    this.G = E.createMatch();
    this.started = false;
    this.difficulty = "normal";
    this.seatOwner = [null, null, null, null]; // playerId per seat
    this.players = new Map();                   // playerId -> {name, seat|null, connected, ws, _dropTimer}
    this.host = null;
    this.timers = [];
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!this.code) this.code = normCode(url.searchParams.get("room")) || "ROOM";
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept(); // non-hibernation: DO stays resident while open, so timers fire
    this.wire(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- socket plumbing ----
  wire(ws) {
    ws._pid = null;
    ws._rl = null;
    ws.addEventListener("message", (ev) => {
      const now = Date.now();
      if (!ws._rl || now - ws._rl.ts > 1000) ws._rl = { ts: now, n: 0 };
      if (++ws._rl.n > MSG_RATE) return; // drop floods
      let msg; try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : "{}"); } catch { return; }
      try { this.handleMessage(ws, msg); } catch { this.send(ws, { type: "error", message: "server error" }); }
    });
    const bye = () => this.handleClose(ws);
    ws.addEventListener("close", bye);
    ws.addEventListener("error", bye);
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast() {
    for (const [pid, p] of this.players)
      if (p.connected && p.ws) this.send(p.ws, { type: "state", view: this.buildView(pid) });
  }

  // ---- room helpers ----
  seatIsHuman(seat) {
    const owner = this.seatOwner[seat];
    const p = owner != null ? this.players.get(owner) : null;
    return !!(p && p.connected);
  }
  connectedCount() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }
  clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; }
  schedule(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
  reassignHost() {
    const cur = this.host != null ? this.players.get(this.host) : null;
    if (cur && cur.connected) return;
    let next = null;
    for (const [pid, p] of this.players) { if (p.connected && p.seat != null) { next = pid; break; } }
    if (!next) for (const [pid, p] of this.players) { if (p.connected) { next = pid; break; } }
    this.host = next;
  }
  promoteSpectatorToSeat() {
    if (this.started) return;
    for (let s = 0; s < 4; s++) if (this.seatOwner[s] == null) {
      for (const [pid2, p2] of this.players) if (p2.connected && p2.seat == null) { this.seatOwner[s] = pid2; p2.seat = s; break; }
    }
  }

  // ---- per-viewer redacted view (the security boundary: no foreign hands) ----
  buildView(pid) {
    const G = this.G;
    const player = this.players.get(pid);
    const seat = player ? player.seat : null;
    const v = E.publicView(G);
    v.seats = [0, 1, 2, 3].map(s => {
      const owner = this.seatOwner[s];
      const op = owner != null ? this.players.get(owner) : null;
      return {
        seat: s,
        label: SEAT_LABEL[s],
        name: this.started ? G.names[s] : (op ? op.name : null),
        isHuman: owner != null,
        connected: op ? op.connected : false,
        you: s === seat,
      };
    });
    v.room = {
      code: this.code, started: this.started,
      isHost: this.host != null && this.host === pid,
      hostName: this.host != null && this.players.get(this.host) ? this.players.get(this.host).name : null,
      humans: [...this.players.values()].filter(p => p.seat != null).length,
    };
    v.you = { seat, playerId: pid, spectator: seat === null };
    if (this.started && seat != null) {
      v.you.hand = G.hands[seat].slice(); // ONLY this viewer's hand
      const ra = E.requiredActor(G);
      if (ra && ra.seat === seat && this.seatIsHuman(seat)) {
        v.you.toAct = true; v.you.actKind = ra.kind;
        if (ra.kind === "play") v.you.legal = E.legalCards(G, seat);
        else if (ra.kind === "call") v.you.callable = E.callableCards(G, seat);
        else if (ra.kind === "bid") v.you.minBid = E.minNextBid(G);
      }
    }
    return v;
  }

  // ---- game driver: broadcast, then schedule AI / timed transitions ----
  drive() {
    this.clearTimers();
    this.broadcast();
    if (!this.started) return;
    if (this.connectedCount() === 0) return; // pause when nobody is connected
    const G = this.G;
    if (G.phase === "trickEnd") { this.schedule(TRICK_DELAY, () => { E.advanceTrick(G); this.drive(); }); return; }
    if (G.phase === "roundEnd") { this.schedule(ROUND_DELAY, () => { E.nextDeal(G); this.drive(); }); return; }
    if (G.phase === "matchOver") return; // host starts a new match
    const ra = E.requiredActor(G);
    if (!ra) return;
    if (this.seatIsHuman(ra.seat)) return; // wait for that human's action
    this.schedule(AI_DELAY, () => {
      const act = E.aiActionFor(G, ra.seat, this.difficulty === "easy");
      if (act) this.applyEngineAction(ra.seat, act);
      this.drive();
    });
  }
  applyEngineAction(seat, act) {
    const G = this.G;
    if (act.type === "bid") E.applyBid(G, seat, act.value);
    else if (act.type === "trump") E.applyTrump(G, act.suit);
    else if (act.type === "call") E.applyCall(G, act.card);
    else if (act.type === "play") E.applyPlay(G, seat, act.card);
  }
  startMatch() {
    this.G.names = [0, 1, 2, 3].map(s => {
      const owner = this.seatOwner[s];
      const op = owner != null ? this.players.get(owner) : null;
      return op ? op.name : `Bot-${SEAT_LABEL[s][0]}`;
    });
    this.started = true;
    E.startMatch(this.G);
    this.drive();
  }

  // ---- messages ----
  handleMessage(ws, msg) {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "join") return this.handleJoin(ws, msg);
    const pid = ws._pid;
    if (!pid) return;
    const player = this.players.get(pid);
    if (!player) return;

    if (msg.type === "start") { if (this.host === pid && !this.started) this.startMatch(); return; }
    if (msg.type === "newMatch") { if (this.host === pid && this.started && this.G.phase === "matchOver") this.startMatch(); return; }

    // gameplay actions — must be the seated player whose turn it is
    if (!this.started || player.seat == null) return;
    const G = this.G, seat = player.seat;
    const ra = E.requiredActor(G);
    if (!ra || ra.seat !== seat) return; // not your turn
    if (msg.type === "bid" && ra.kind === "bid") {
      const value = msg.value === null || msg.value === undefined ? null : Number(msg.value);
      if (!E.bidIsLegal(G, seat, value)) { this.send(ws, { type: "error", message: "illegal bid" }); return; }
      E.applyBid(G, seat, value); this.drive();
    } else if (msg.type === "trump" && ra.kind === "trump") {
      if (!E.SUITS.includes(msg.suit)) return;
      E.applyTrump(G, msg.suit); this.drive();
    } else if (msg.type === "call" && ra.kind === "call") {
      const card = msg.card && { suit: msg.card.suit, rank: Number(msg.card.rank) };
      if (!E.callIsLegal(G, card)) { this.send(ws, { type: "error", message: "illegal call" }); return; }
      E.applyCall(G, card); this.drive();
    } else if (msg.type === "play" && ra.kind === "play") {
      const card = msg.card && { suit: msg.card.suit, rank: Number(msg.card.rank) };
      if (!card || !E.playIsLegal(G, seat, card)) { this.send(ws, { type: "error", message: "illegal play" }); return; }
      E.applyPlay(G, seat, card); this.drive();
    }
  }

  handleJoin(ws, msg) {
    const name = codePoints(String(msg.name || "").trim(), 16) || "Player";
    let pid = typeof msg.playerId === "string" ? msg.playerId : null;
    let player = pid ? this.players.get(pid) : null;
    if (player) {
      // reconnect: newest socket wins. Retire any prior socket and detach its
      // identity so its later 'close' can never clobber this live session.
      const old = player.ws;
      if (old && old !== ws) { old._pid = null; try { old.close(1000, "superseded"); } catch {} }
      if (player._dropTimer) { clearTimeout(player._dropTimer); player._dropTimer = null; }
      player.connected = true; player.ws = ws; player.name = name;
      if (this.started && player.seat != null) this.G.names[player.seat] = name;
    } else {
      if (this.players.size >= MAX_PLAYERS_PER_ROOM) { this.send(ws, { type: "error", message: "room is full" }); return; }
      pid = randId(16, false);
      let seat = null;
      for (let s = 0; s < 4; s++) if (this.seatOwner[s] == null) { seat = s; break; }
      if (seat != null) {
        this.seatOwner[seat] = pid;
        if (this.started) this.G.names[seat] = name; // a human taking over an AI seat mid-match
      }
      player = { name, seat, connected: true, ws, _dropTimer: null };
      this.players.set(pid, player);
    }
    if (this.host == null) this.host = pid; else this.reassignHost();

    ws._pid = pid;
    this.send(ws, { type: "joined", playerId: pid, room: this.code, seat: player.seat });
    this.drive(); // broadcast + (re)start the loop if it was paused
  }

  handleClose(ws) {
    const pid = ws._pid;
    if (!pid) return;
    const player = this.players.get(pid);
    if (!player) return;
    if (player.ws && player.ws !== ws) return; // a newer socket already owns this player — ignore stale close
    player.connected = false; player.ws = null;

    if (player.seat == null) {
      this.players.delete(pid); // spectators carry no reconnect value; drop them
    } else if (!this.started) {
      // lobby: hold the seat through a brief blip, then release + promote a waiting spectator
      if (player._dropTimer) clearTimeout(player._dropTimer);
      player._dropTimer = setTimeout(() => {
        player._dropTimer = null;
        if (player.connected) return;
        this.seatOwner[player.seat] = null; this.players.delete(pid);
        this.promoteSpectatorToSeat(); this.reassignHost();
        if (this.connectedCount() > 0) this.drive();
      }, LOBBY_GRACE_MS);
    }
    // (started + seated: keep the record so the seat is held and AI plays until they return)
    this.reassignHost();
    if (this.connectedCount() === 0) this.clearTimers(); // pause; DO is evicted when fully idle
    else this.drive();
  }
}
