"use strict";
/* ============================================================
   TRUMP — node adapter (HTTP static + WebSocket realtime).
   All room/game logic lives in room.js (shared with the Cloudflare
   Durable Object adapter). This file owns: sockets, timers, static
   files, rate limits, Origin checks, per-IP caps, room registry.
   Run:  npm install && node server.js   then open the printed URL.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const R = require("./room");

const PORT = process.env.PORT || 3000;
const MAX_ROOMS = +process.env.MAX_ROOMS || 500;
const MSG_RATE = 100, MAX_SOCKETS_PER_IP = 20, JOIN_GRACE_MS = 30000;
const DELAYS = {};
if (+process.env.AI_DELAY) DELAYS.ai = +process.env.AI_DELAY;
if (+process.env.TRICK_DELAY) DELAYS.trick = +process.env.TRICK_DELAY;
if (+process.env.ROUND_DELAY) DELAYS.round = +process.env.ROUND_DELAY;
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
/* Off by default: X-Forwarded-For is caller-controlled, so trusting it without a
   proxy in front lets anyone forge their way past the per-IP cap. Set TRUST_PROXY=1
   when something upstream (nginx, Cloudflare, a tunnel) actually sets the header —
   otherwise every player behind it shares one socket budget. */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "?";
}

// ---- HTTP: serve the static client from app/ ----
const PUB = path.join(__dirname, "app");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".css": "text/css",
};
const httpServer = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  const rel = url === "/" ? "index.html" : url.slice(1);
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep) || rel.includes("..")) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": file.endsWith("sw.js") ? "no-cache" : (rel === "index.html" ? "no-cache" : "public, max-age=3600"),
    });
    res.end(buf);
  });
});

// ============================================================
//  Rooms registry: code -> { state, socks: Map(pid->ws), timer }
// ============================================================
const rooms = new Map();

function newRoomCode(len) { let c; do { c = R.randId(len || 4, true); } while (rooms.has(c)); return c; }
/* Rooms sit empty for `expire` (30m) so people can come back to them. That is a
   generous thing to hand an abuser, so at the room cap we recycle the room that
   has been empty longest instead of turning real players away. A room with a
   live socket is never touched. */
function reclaimEmptyRoom() {
  let victim = null;
  for (const [, e] of rooms) {
    if (e.socks.size > 0) continue;
    if (!victim || (e.emptiedAt || 0) < (victim.emptiedAt || 0)) victim = e;
  }
  if (victim) deleteRoom(victim);
  return !!victim;
}
function getOrCreateRoom(codeRaw, priv) {
  let code = R.normCode(codeRaw);
  if (!code) code = newRoomCode(priv ? 8 : 4);
  let entry = rooms.get(code);
  if (!entry) {
    if (rooms.size >= MAX_ROOMS && !reclaimEmptyRoom()) return null;
    entry = { state: R.createRoom(code, { delays: DELAYS }), socks: new Map(), timer: null, emptiedAt: Date.now() };
    rooms.set(code, entry);
  }
  return entry;
}

function send(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }

function applyFx(entry, fx, ws) {
  if (!fx) return;
  if (fx.sends) for (const s of fx.sends) {
    if (s.pid == null) send(ws, s.obj);
    else send(entry.socks.get(s.pid), s.obj);
  }
  if (fx.closes) for (const pid of fx.closes) {
    const t = entry.socks.get(pid);
    if (t) { t._pid = null; t._code = null; try { t.close(1000, "kicked"); } catch {} }
    entry.socks.delete(pid);
  }
  if (fx.emote) for (const [, sock] of entry.socks) send(sock, { type: "emote", seat: fx.emote.seat, e: fx.emote.e });
  if (fx.broadcast) {
    const now = Date.now();
    for (const [pid, sock] of entry.socks) send(sock, { type: "state", view: R.buildView(entry.state, pid, now) });
  }
  if (fx.deleteRoom) deleteRoom(entry);
}
function deleteRoom(entry) {
  if (entry.timer) clearTimeout(entry.timer);
  for (const [, sock] of entry.socks) { try { sock.close(1000, "room expired"); } catch {} }
  rooms.delete(entry.state.code);
}
function armTimer(entry) {
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  if (!rooms.has(entry.state.code)) return;
  const due = R.nextTimerDue(entry.state);
  if (due == null) return;
  // unref'd: the listening server is what keeps the process alive, not a room
  // waiting 30 minutes to expire — otherwise shutdown blocks on the last timer
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const fx = R.fireTimers(entry.state, Date.now());
    applyFx(entry, fx);
    if (!fx.deleteRoom) armTimer(entry);
  }, Math.max(0, due - Date.now()));
  if (entry.timer.unref) entry.timer.unref();
}

// ============================================================
//  WebSocket lifecycle
// ============================================================
const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });
const ipCount = new Map();

wss.on("connection", (ws, req) => {
  // same-origin check: browsers send Origin; non-browser clients (no header) pass
  const origin = req.headers.origin;
  if (origin) {
    let host = null; try { host = new URL(origin).host; } catch {}
    if (host !== req.headers.host && !ALLOW_ORIGIN.includes(origin)) {
      ws.close(1008, "bad origin"); return;
    }
  }
  const ip = clientIp(req);
  const n = (ipCount.get(ip) || 0) + 1;
  if (n > MAX_SOCKETS_PER_IP) { ws.close(1008, "too many connections"); return; }
  ipCount.set(ip, n);
  ws._ip = ip;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // sockets that never join get dropped
  ws._joinGrace = setTimeout(() => { if (!ws._pid) ws.terminate(); }, JOIN_GRACE_MS);

  ws.on("message", (data) => {
    const now = Date.now();
    if (!ws._rl || now - ws._rl.ts > 1000) ws._rl = { ts: now, n: 0 };
    if (++ws._rl.n > MSG_RATE) return; // drop floods
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    try { handleMessage(ws, msg); } catch (e) { send(ws, { type: "error", message: "server error" }); }
  });
  ws.on("close", () => handleClose(ws));
});

/* Release whatever room/player this socket is currently bound to. A socket that
   joins twice would otherwise strand its previous identity: nothing maps to that
   pid any more, but the room still counts it as connected — so the seat stays
   claimed and the empty-room expiry never arms. One socket could then hold every
   seat in a room, or pin MAX_ROOMS rooms open until restart. */
function detach(ws, immediate) {
  const entry = ws._code != null ? rooms.get(ws._code) : null;
  const pid = ws._pid;
  ws._pid = null; ws._code = null;
  if (!entry || !pid) return;
  if (entry.socks.get(pid) !== ws) return; // a newer socket owns this player
  entry.socks.delete(pid);
  if (entry.socks.size === 0) entry.emptiedAt = Date.now(); // reclaim order at the room cap
  applyFx(entry, R.disconnect(entry.state, pid, Date.now(), { immediate }));
  armTimer(entry);
}

function handleMessage(ws, msg) {
  if (!msg || typeof msg.type !== "string") return;
  const now = Date.now();
  if (msg.type === "join") {
    if (ws._pid) detach(ws, true); // this socket is switching identity, not reconnecting
    const entry = getOrCreateRoom(msg.room, !!msg.private);
    if (!entry) { send(ws, { type: "error", message: "server is busy (too many rooms)" }); return; }
    const { pid, resumed, fx } = R.join(entry.state, msg, now);
    if (pid == null) { applyFx(entry, fx, ws); return; }
    if (resumed) {
      const old = entry.socks.get(pid);
      if (old && old !== ws) { old._pid = null; old._code = null; try { old.terminate(); } catch {} }
    }
    entry.socks.set(pid, ws);
    ws._pid = pid; ws._code = entry.state.code;
    if (ws._joinGrace) { clearTimeout(ws._joinGrace); ws._joinGrace = null; }
    applyFx(entry, fx, ws);
    armTimer(entry);
    return;
  }
  const entry = ws._code != null ? rooms.get(ws._code) : null;
  if (!entry || !ws._pid) return;
  const fx = R.message(entry.state, ws._pid, msg, now);
  applyFx(entry, fx, ws);
  armTimer(entry);
}

function handleClose(ws) {
  if (ws._joinGrace) { clearTimeout(ws._joinGrace); ws._joinGrace = null; }
  if (ws._ip) {
    const n = (ipCount.get(ws._ip) || 1) - 1;
    if (n <= 0) ipCount.delete(ws._ip); else ipCount.set(ws._ip, n);
  }
  detach(ws, false); // a real drop: seats keep their reconnect grace
}

// keep-alive ping (drop dead sockets); unref'd so it never holds a test process open
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch {}
  });
}, 30000).unref();

// Importable so test/server.test.js can drive the real adapter in-process.
module.exports = { httpServer, wss, rooms };

if (require.main === module) {
  httpServer.listen(PORT, () => {
    console.log(`\n  TRUMP multiplayer server running.`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Friends on your network join via your machine's LAN IP, e.g. http://<your-ip>:${PORT}`);
    console.log(`  Create or share a room code on the join screen.\n`);
  });
}
