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
const MAX_ROOMS = 500, MSG_RATE = 100, MAX_SOCKETS_PER_IP = 20, JOIN_GRACE_MS = 30000;
const DELAYS = {};
if (+process.env.AI_DELAY) DELAYS.ai = +process.env.AI_DELAY;
if (+process.env.TRICK_DELAY) DELAYS.trick = +process.env.TRICK_DELAY;
if (+process.env.ROUND_DELAY) DELAYS.round = +process.env.ROUND_DELAY;
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);

// ---- HTTP: serve the static client from public/ ----
const PUB = path.join(__dirname, "public");
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
function getOrCreateRoom(codeRaw, priv) {
  let code = R.normCode(codeRaw);
  if (!code) code = newRoomCode(priv ? 8 : 4);
  let entry = rooms.get(code);
  if (!entry) {
    if (rooms.size >= MAX_ROOMS) return null;
    entry = { state: R.createRoom(code, { delays: DELAYS }), socks: new Map(), timer: null };
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
    for (const [pid, sock] of entry.socks) send(sock, { type: "state", view: R.buildView(entry.state, pid) });
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
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const fx = R.fireTimers(entry.state, Date.now());
    applyFx(entry, fx);
    if (!fx.deleteRoom) armTimer(entry);
  }, Math.max(0, due - Date.now()));
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
  const ip = req.socket.remoteAddress || "?";
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

function handleMessage(ws, msg) {
  if (!msg || typeof msg.type !== "string") return;
  const now = Date.now();
  if (msg.type === "join") {
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
  const entry = ws._code != null ? rooms.get(ws._code) : null;
  if (!entry || !ws._pid) return;
  if (entry.socks.get(ws._pid) !== ws) return; // a newer socket owns this player
  const pid = ws._pid;
  entry.socks.delete(pid);
  const fx = R.disconnect(entry.state, pid, Date.now());
  applyFx(entry, fx);
  armTimer(entry);
}

// keep-alive ping (drop dead sockets)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch {}
  });
}, 30000);

httpServer.listen(PORT, () => {
  console.log(`\n  TRUMP multiplayer server running.`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Friends on your network join via your machine's LAN IP, e.g. http://<your-ip>:${PORT}`);
  console.log(`  Create or share a room code on the join screen.\n`);
});
