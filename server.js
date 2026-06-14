"use strict";
/* ============================================================
   TRUMP — multiplayer server (HTTP static + WebSocket realtime)
   Authoritative game state lives here (engine.js). Each client gets
   a redacted view (own hand only). Empty/disconnected seats are AI.
   Run:  npm install && node server.js   then open the printed URL.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const E = require("./engine");

const PORT = process.env.PORT || 3000;
const AI_DELAY = +process.env.AI_DELAY || 800;
const TRICK_DELAY = +process.env.TRICK_DELAY || 1600;
const ROUND_DELAY = +process.env.ROUND_DELAY || 6000;
const ROOM_TTL_MS = 10 * 60 * 1000;   // delete an empty room after 10 min
const LOBBY_GRACE_MS = 15 * 1000;     // hold a lobby seat through a brief disconnect
const MAX_ROOMS = 500, MAX_PLAYERS_PER_ROOM = 12, MSG_RATE = 100; // basic abuse caps (well above human action rates)

const CLIENT_PATH = path.join(__dirname, "public", "index.html");

// ---- HTTP: serve the single-page client ----
const httpServer = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    fs.readFile(CLIENT_PATH, (err, buf) => {
      if (err) { res.writeHead(500); res.end("client not found — expected public/index.html"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(buf);
    });
  } else if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  } else {
    res.writeHead(404); res.end("not found");
  }
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 }); // game messages are tiny

// ============================================================
//  Rooms
// ============================================================
const rooms = new Map(); // code -> room

function randId(n, alpha) {
  const chars = alpha ? "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" : "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function newRoomCode() { let c; do { c = randId(4, true); } while (rooms.has(c)); return c; }

function getOrCreateRoom(code) {
  code = (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  if (!code) code = newRoomCode();
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null;
    room = {
      code,
      G: E.createMatch(),
      started: false,
      difficulty: "normal",
      seatOwner: [null, null, null, null], // playerId per seat
      players: new Map(),                  // playerId -> {name, seat|null, connected, ws}
      host: null,
      timers: [],
      cleanupTimer: null,
    };
    rooms.set(code, room);
  }
  return room;
}

const SEAT_LABEL = ["South", "West", "North", "East"];
function seatIsHuman(room, seat) {
  const owner = room.seatOwner[seat];
  const p = owner != null ? room.players.get(owner) : null;
  return !!(p && p.connected);
}
function connectedCount(room) { let n = 0; for (const p of room.players.values()) if (p.connected) n++; return n; }
function clearTimers(room) { room.timers.forEach(clearTimeout); room.timers = []; }
function schedule(room, ms, fn) { room.timers.push(setTimeout(fn, ms)); }

function reassignHost(room) {
  const cur = room.host != null ? room.players.get(room.host) : null;
  if (cur && cur.connected) return;
  let next = null;
  for (const [pid, p] of room.players) { if (p.connected && p.seat != null) { next = pid; break; } }
  if (!next) for (const [pid, p] of room.players) { if (p.connected) { next = pid; break; } }
  room.host = next;
}
function promoteSpectatorToSeat(room) {
  if (room.started) return;
  for (let s = 0; s < 4; s++) if (room.seatOwner[s] == null) {
    for (const [pid2, p2] of room.players) if (p2.connected && p2.seat == null) { room.seatOwner[s] = pid2; p2.seat = s; break; }
  }
}
function armCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => { if (connectedCount(room) === 0) rooms.delete(room.code); }, ROOM_TTL_MS);
}
function codePoints(s, n) { return [...s].slice(0, n).join(""); } // truncate by code point (don't split emoji)

// ============================================================
//  Per-viewer redacted view (the security boundary: no foreign hands)
// ============================================================
function buildView(room, pid) {
  const G = room.G;
  const player = room.players.get(pid);
  const seat = player ? player.seat : null;
  const v = E.publicView(G);
  v.seats = [0,1,2,3].map(s => {
    const owner = room.seatOwner[s];
    const op = owner != null ? room.players.get(owner) : null;
    return {
      seat: s,
      label: SEAT_LABEL[s],
      name: room.started ? G.names[s] : (op ? op.name : null),
      isHuman: owner != null,
      connected: op ? op.connected : false,
      you: s === seat,
    };
  });
  v.room = {
    code: room.code, started: room.started,
    isHost: room.host != null && room.host === pid,
    hostName: room.host != null && room.players.get(room.host) ? room.players.get(room.host).name : null,
    humans: [...room.players.values()].filter(p => p.seat != null).length,
  };
  v.you = { seat, playerId: pid, spectator: seat === null };
  if (room.started && seat != null) {
    v.you.hand = G.hands[seat].slice(); // ONLY this viewer's hand
    const ra = E.requiredActor(G);
    if (ra && ra.seat === seat && seatIsHuman(room, seat)) {
      v.you.toAct = true; v.you.actKind = ra.kind;
      if (ra.kind === "play") v.you.legal = E.legalCards(G, seat);
      else if (ra.kind === "call") v.you.callable = E.callableCards(G, seat);
      else if (ra.kind === "bid") v.you.minBid = E.minNextBid(G);
    }
  }
  return v;
}
function send(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room) {
  for (const [pid, p] of room.players) if (p.connected && p.ws) send(p.ws, { type: "state", view: buildView(room, pid) });
}

// ============================================================
//  Game driver: broadcast, then schedule AI / timed transitions
// ============================================================
function drive(room) {
  clearTimers(room);
  broadcast(room);
  if (!room.started) return;
  if (connectedCount(room) === 0) return; // pause when nobody is connected
  const G = room.G;
  if (G.phase === "trickEnd") { schedule(room, TRICK_DELAY, () => { E.advanceTrick(G); drive(room); }); return; }
  if (G.phase === "roundEnd") { schedule(room, ROUND_DELAY, () => { E.nextDeal(G); drive(room); }); return; }
  if (G.phase === "matchOver") return; // host starts a new match
  const ra = E.requiredActor(G);
  if (!ra) return;
  if (seatIsHuman(room, ra.seat)) return; // wait for that human's action
  schedule(room, AI_DELAY, () => {
    const act = E.aiActionFor(G, ra.seat, room.difficulty === "easy");
    if (act) applyEngineAction(G, ra.seat, act);
    drive(room);
  });
}
function applyEngineAction(G, seat, act) {
  if (act.type === "bid") E.applyBid(G, seat, act.value);
  else if (act.type === "trump") E.applyTrump(G, act.suit);
  else if (act.type === "call") E.applyCall(G, act.card);
  else if (act.type === "play") E.applyPlay(G, seat, act.card);
}

function startMatch(room) {
  // name each seat: human's name, or a bot label
  room.G.names = [0,1,2,3].map(s => {
    const owner = room.seatOwner[s];
    const op = owner != null ? room.players.get(owner) : null;
    return op ? op.name : `Bot-${SEAT_LABEL[s][0]}`;
  });
  room.started = true;
  E.startMatch(room.G);
  drive(room);
}

// ============================================================
//  Connection lifecycle
// ============================================================
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
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
  if (msg.type === "join") return handleJoin(ws, msg);
  const room = ws._room, pid = ws._pid;
  if (!room || !pid || !rooms.has(room.code)) return;
  const player = room.players.get(pid);
  if (!player) return;

  if (msg.type === "start") {
    if (room.host === pid && !room.started) startMatch(room);
    return;
  }
  if (msg.type === "newMatch") {
    if (room.host === pid && room.started && room.G.phase === "matchOver") startMatch(room);
    return;
  }
  // gameplay actions — must be the seated player whose turn it is
  if (!room.started || player.seat == null) return;
  const G = room.G, seat = player.seat;
  const ra = E.requiredActor(G);
  if (!ra || ra.seat !== seat) return; // not your turn
  if (msg.type === "bid" && ra.kind === "bid") {
    const value = msg.value === null || msg.value === undefined ? null : Number(msg.value);
    if (!E.bidIsLegal(G, seat, value)) { send(ws, { type: "error", message: "illegal bid" }); return; }
    E.applyBid(G, seat, value); drive(room);
  } else if (msg.type === "trump" && ra.kind === "trump") {
    if (!E.SUITS.includes(msg.suit)) return;
    E.applyTrump(G, msg.suit); drive(room);
  } else if (msg.type === "call" && ra.kind === "call") {
    const card = msg.card && { suit: msg.card.suit, rank: Number(msg.card.rank) };
    if (!E.callIsLegal(G, card)) { send(ws, { type: "error", message: "illegal call" }); return; }
    E.applyCall(G, card); drive(room);
  } else if (msg.type === "play" && ra.kind === "play") {
    const card = msg.card && { suit: msg.card.suit, rank: Number(msg.card.rank) };
    if (!card || !E.playIsLegal(G, seat, card)) { send(ws, { type: "error", message: "illegal play" }); return; }
    E.applyPlay(G, seat, card); drive(room);
  }
}

function handleJoin(ws, msg) {
  const room = getOrCreateRoom(msg.room);
  if (!room) { send(ws, { type: "error", message: "server is busy (too many rooms)" }); return; }
  if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
  const name = codePoints(String(msg.name || "").trim(), 16) || "Player";

  let pid = typeof msg.playerId === "string" ? msg.playerId : null;
  let player = pid ? room.players.get(pid) : null;
  if (player) {
    // reconnect: newest socket wins. Cleanly retire any prior socket and detach its
    // identity so its later 'close' can never clobber this live session.
    const old = player.ws;
    if (old && old !== ws) { old._pid = null; old._room = null; try { old.terminate(); } catch {} }
    if (player._dropTimer) { clearTimeout(player._dropTimer); player._dropTimer = null; }
    player.connected = true; player.ws = ws; player.name = name;
    if (room.started && player.seat != null) room.G.names[player.seat] = name;
  } else {
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) { send(ws, { type: "error", message: "room is full" }); return; }
    pid = randId(16, false);
    let seat = null;
    for (let s = 0; s < 4; s++) if (room.seatOwner[s] == null) { seat = s; break; }
    if (seat != null) {
      room.seatOwner[seat] = pid;
      if (room.started) room.G.names[seat] = name; // a human taking over an AI seat mid-match
    }
    player = { name, seat, connected: true, ws, _dropTimer: null };
    room.players.set(pid, player);
  }
  if (room.host == null) room.host = pid; else reassignHost(room);

  ws._room = room; ws._pid = pid;
  send(ws, { type: "joined", playerId: pid, room: room.code, seat: player.seat });
  drive(room); // broadcast + (re)start the loop if it was paused
}

function handleClose(ws) {
  const room = ws._room, pid = ws._pid;
  if (!room || !pid) return;
  const player = room.players.get(pid);
  if (!player) return;
  if (player.ws && player.ws !== ws) return; // a newer socket already owns this player — ignore stale close
  player.connected = false; player.ws = null;

  if (player.seat == null) {
    room.players.delete(pid); // spectators carry no reconnect value; drop them (bounds room.players)
  } else if (!room.started) {
    // lobby: hold the seat through a brief blip, then release + promote a waiting spectator
    if (player._dropTimer) clearTimeout(player._dropTimer);
    player._dropTimer = setTimeout(() => {
      player._dropTimer = null;
      if (player.connected) return;
      room.seatOwner[player.seat] = null; room.players.delete(pid);
      promoteSpectatorToSeat(room); reassignHost(room);
      if (connectedCount(room) === 0) armCleanup(room); else drive(room);
    }, LOBBY_GRACE_MS);
  }
  // (started + seated: keep the record so the seat is held and AI plays until they return)
  reassignHost(room);
  if (connectedCount(room) === 0) { clearTimers(room); armCleanup(room); }
  else drive(room);
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
