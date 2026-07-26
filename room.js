"use strict";
/* ============================================================
   TRUMP — shared room core (backend-agnostic, no I/O).

   One room = lobby + seats + settings + chat + the engine game.
   Every function here is a pure state transition over a fully
   JSON-serializable `room` object; callers pass `now` (ms) in and
   receive an *effects* object out:

     { broadcast?: true,            // re-send each connected player their view
       sends?:   [{pid, obj}],      // targeted messages
       closes?:  [pid],             // sockets the adapter must close
       emote?:   {seat, e},         // transient broadcast (not in view/state)
       deleteRoom?: true }          // room expired — adapter frees storage

   Timers are data, not callbacks: `room.timers` is a list of
   {kind, due, data?}. After any transition the adapter reads
   nextTimerDue(room) and arms ONE timer/alarm; when it fires it calls
   fireTimers(room, now) and applies the returned effects. This is what
   lets the same core run on node setTimeout and on Durable Object
   alarms (which survive hibernation).

   Adapters own: sockets, rate limiting, persistence, Origin checks.
   ============================================================ */

const E = require("./engine");

const SEAT_LABEL = ["South", "West", "North", "East"];
const EMOTES = ["👏", "😂", "😱", "🔥", "🤝", "💀"];
const DIFFICULTIES = ["easy", "normal", "hard"];
const TARGET_DEAL_CHOICES = [3, 5, 7];
const TURN_TIMER_CHOICES = [0, 15, 30, 45, 60, 90];
const MAX_PLAYERS_PER_ROOM = 12;
const CHAT_MAX_LEN = 200, CHAT_RING = 50, NAME_MAX = 16;

const DEFAULT_DELAYS = {
  ai: 800,          // AI "thinking" pause
  trick: 1600,      // show a completed trick
  round: 30000,     // roundEnd fallback when not everyone clicks ready
  drop: 15000,      // hold a lobby seat through a brief disconnect
  expire: 30 * 60 * 1000, // delete a room this long after it empties
};

// ---- small helpers ----
function codePoints(s, n) { return [...String(s)].slice(0, n).join(""); } // don't split emoji
function cleanName(s) { return codePoints(String(s || "").trim(), NAME_MAX) || "Player"; }
function normCode(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8); }
function randId(n, alpha, rng) {
  const chars = alpha ? "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" : "abcdefghijklmnopqrstuvwxyz0123456789";
  const r = rng || Math.random;
  let out = ""; for (let i = 0; i < n; i++) out += chars[Math.floor(r() * chars.length)];
  return out;
}

function createRoom(code, opts) {
  return {
    code,
    G: E.createMatch(),
    started: false,
    settings: { difficulty: "normal", targetDeals: 5, turnTimerSec: 45 },
    seatOwner: [null, null, null, null],   // pid per seat (null = AI / open)
    players: {},                            // pid -> {name, uid, seat|null, connected, away, ready}
    host: null,
    chat: [],                               // ring buffer of {from, seat, text, ts}
    timers: [],                             // [{kind, due, data?}]
    delays: Object.assign({}, DEFAULT_DELAYS, (opts && opts.delays) || {}),
  };
}

function playerList(room) { return Object.entries(room.players); }
function connectedCount(room) { let n = 0; for (const [, p] of playerList(room)) if (p.connected) n++; return n; }
function seatIsLiveHuman(room, seat) {
  const owner = room.seatOwner[seat];
  const p = owner != null ? room.players[owner] : null;
  return !!(p && p.connected && !p.away);
}
function seatedHumans(room) {
  return playerList(room).filter(([, p]) => p.seat != null);
}

function reassignHost(room) {
  const cur = room.host != null ? room.players[room.host] : null;
  if (cur && cur.connected) return;
  let next = null;
  for (const [pid, p] of playerList(room)) if (p.connected && p.seat != null) { next = pid; break; }
  if (!next) for (const [pid, p] of playerList(room)) if (p.connected) { next = pid; break; }
  room.host = next;
}
function promoteSpectators(room, excludePid) {
  if (room.started) return;
  for (let s = 0; s < 4; s++) if (room.seatOwner[s] == null) {
    for (const [pid, p] of playerList(room))
      if (p.connected && p.seat == null && pid !== excludePid) { room.seatOwner[s] = pid; p.seat = s; break; }
  }
}
function releaseSeat(room, pid) {
  const p = room.players[pid];
  if (!p || p.seat == null) return;
  const seat = p.seat;
  room.seatOwner[seat] = null;
  p.seat = null; p.ready = false;
  if (room.started) room.G.names[seat] = `Bot-${SEAT_LABEL[seat][0]}`;
}
function resetReady(room) { for (const [, p] of playerList(room)) p.ready = false; }

// ---- timers ----
function setTimer(room, kind, delayMs, now, data) {
  room.timers = room.timers.filter(t => !(t.kind === kind && sameData(t.data, data)));
  room.timers.push({ kind, due: now + delayMs, data: data || null });
}
function clearTimersOfKind(room, kinds) { room.timers = room.timers.filter(t => !kinds.includes(t.kind)); }
function sameData(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }
function nextTimerDue(room) {
  let min = null;
  for (const t of room.timers) if (min === null || t.due < min) min = t.due;
  return min;
}

const GAME_TIMER_KINDS = ["ai", "trick", "round", "turn"];

/* Recompute which single game timer should be pending, preserving an
   already-armed matching timer so repeated drives don't push deadlines out. */
function drive(room, now, fx) {
  fx.broadcast = true;
  if (!room.started) { clearTimersOfKind(room, GAME_TIMER_KINDS); return; }
  const G = room.G;

  // ready-gate: advance the round as soon as every live seated human is ready
  let guard = 0;
  while (G.phase === "roundEnd" && guard++ < 4) {
    const live = seatedHumans(room).filter(([, p]) => p.connected && !p.away);
    if (live.length && !live.every(([, p]) => p.ready)) break;
    E.nextDeal(G); resetReady(room);
  }

  if (connectedCount(room) === 0) { clearTimersOfKind(room, GAME_TIMER_KINDS); return; } // paused

  let desired = null; // {kind, delay, data}
  if (G.phase === "trickEnd") desired = { kind: "trick", delay: room.delays.trick };
  else if (G.phase === "roundEnd") desired = { kind: "round", delay: room.delays.round };
  else if (G.phase !== "matchOver") {
    const ra = E.requiredActor(G);
    if (ra) {
      if (seatIsLiveHuman(room, ra.seat)) {
        const tt = room.settings.turnTimerSec;
        if (tt > 0) desired = { kind: "turn", delay: tt * 1000, data: { seat: ra.seat } };
      } else desired = { kind: "ai", delay: room.delays.ai, data: { seat: ra.seat } };
    }
  }

  const existing = room.timers.find(t => GAME_TIMER_KINDS.includes(t.kind));
  if (existing && desired && existing.kind === desired.kind && sameData(existing.data, desired.data)) return; // keep due
  clearTimersOfKind(room, GAME_TIMER_KINDS);
  if (desired) setTimer(room, desired.kind, desired.delay, now, desired.data);
}

function aiAct(room, seat) {
  const G = room.G;
  const act = E.aiActionFor(G, seat, room.settings.difficulty);
  if (!act) return;
  if (act.type === "bid") E.applyBid(G, seat, act.value);
  else if (act.type === "trump") E.applyTrump(G, act.suit);
  else if (act.type === "call") E.applyCall(G, act.card);
  else if (act.type === "play") E.applyPlay(G, seat, act.card);
}

/* Fire every due timer. Adapter calls this when its armed timer/alarm rings. */
function fireTimers(room, now) {
  const fx = {};
  const due = room.timers.filter(t => t.due <= now);
  if (!due.length) return fx;
  room.timers = room.timers.filter(t => t.due > now);
  const G = room.G;

  for (const t of due) {
    if (t.kind === "drop") {
      const p = room.players[t.data && t.data.pid];
      if (p && !p.connected) {
        releaseSeat(room, t.data.pid);
        delete room.players[t.data.pid];
        promoteSpectators(room);
        reassignHost(room);
        fx.broadcast = true;
      }
    } else if (t.kind === "expire") {
      if (connectedCount(room) === 0) { fx.deleteRoom = true; return fx; }
    }
  }

  const g = due.find(t => GAME_TIMER_KINDS.includes(t.kind));
  if (g && room.started) {
    if (g.kind === "trick" && G.phase === "trickEnd") E.advanceTrick(G);
    else if (g.kind === "round" && G.phase === "roundEnd") { E.nextDeal(G); resetReady(room); }
    else if (g.kind === "ai") {
      const ra = E.requiredActor(G);
      if (ra && !seatIsLiveHuman(room, ra.seat)) aiAct(room, ra.seat);
    } else if (g.kind === "turn") {
      const ra = E.requiredActor(G);
      if (ra && g.data && ra.seat === g.data.seat && seatIsLiveHuman(room, ra.seat)) {
        const owner = room.seatOwner[ra.seat];
        if (owner != null && room.players[owner]) room.players[owner].away = true; // AFK → autopilot
        aiAct(room, ra.seat);
      }
    }
  }
  drive(room, now, fx);
  return fx;
}

// ---- join / disconnect ----
/* Returns {pid, resumed, fx}. Adapter binds pid to the socket, closes any
   superseded socket for the same pid, and sends the "joined" ack. */
function join(room, msg, now) {
  const fx = {};
  const name = cleanName(msg.name);
  const uid = typeof msg.uid === "string" ? msg.uid.slice(0, 32) : null;

  let pid = typeof msg.playerId === "string" ? msg.playerId : null;
  let player = pid ? room.players[pid] : null;
  let resumed = false;

  /* "Create room" mints its code on the client, so it can collide with a
     live room; landing a stranger in someone else's lobby is worse than a
     retry. Only a fresh create is refused — reconnects never set `create`. */
  if (msg.create && !player && Object.keys(room.players).length > 0) {
    return { pid: null, resumed: false, fx: { sends: [{ pid: null,
      obj: { type: "error", code: "code-taken", message: "that room code is already in use" } }] } };
  }
  if (player) {
    resumed = player.connected; // an old live socket exists — adapter must close it
    room.timers = room.timers.filter(t => !(t.kind === "drop" && t.data && t.data.pid === pid));
    player.connected = true; player.away = false; player.name = name;
    if (uid) player.uid = uid;
    if (room.started && player.seat != null) room.G.names[player.seat] = name;
  } else {
    if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
      return { pid: null, resumed: false, fx: { sends: [{ pid: null, obj: { type: "error", message: "room is full" } }] } };
    }
    pid = randId(16, false);
    let seat = null;
    for (let s = 0; s < 4; s++) if (room.seatOwner[s] == null) { seat = s; break; }
    if (seat != null) {
      room.seatOwner[seat] = pid;
      if (room.started) room.G.names[seat] = name; // human takes over an AI seat mid-match
    }
    player = { name, uid, seat, connected: true, away: false, ready: false };
    room.players[pid] = player;
  }
  clearTimersOfKind(room, ["expire"]);
  if (room.host == null) room.host = pid; else reassignHost(room);
  fx.sends = [{ pid, obj: { type: "joined", playerId: pid, room: room.code, seat: player.seat } }];
  drive(room, now, fx);
  return { pid, resumed, fx };
}

function disconnect(room, pid, now) {
  const fx = {};
  const player = room.players[pid];
  if (!player) return fx;
  player.connected = false;

  if (player.seat == null) {
    delete room.players[pid]; // spectators carry no reconnect value
  } else if (!room.started) {
    setTimer(room, "drop", room.delays.drop, now, { pid }); // hold lobby seat briefly
  }
  // started + seated: keep the record; seat is held and AI-played until they return
  reassignHost(room);
  if (connectedCount(room) === 0) setTimer(room, "expire", room.delays.expire, now);
  drive(room, now, fx);
  return fx;
}

// ---- match lifecycle ----
function startMatch(room, now, fx) {
  room.G = E.createMatch(
    [0, 1, 2, 3].map(s => {
      const owner = room.seatOwner[s];
      const op = owner != null ? room.players[owner] : null;
      return op ? op.name : `Bot-${SEAT_LABEL[s][0]}`;
    }),
    { targetDeals: room.settings.targetDeals }
  );
  room.started = true;
  resetReady(room);
  E.startMatch(room.G);
  drive(room, now, fx);
}

// ---- messages ----
function message(room, pid, msg, now) {
  const fx = {};
  if (!msg || typeof msg.type !== "string") return fx;
  const player = room.players[pid];
  if (!player) return fx;

  // any activity from an AFK player hands control back to them
  if (player.away) { player.away = false; drive(room, now, fx); }

  switch (msg.type) {
    case "start":
      if (room.host === pid && !room.started) startMatch(room, now, fx);
      return fx;
    case "newMatch":
      if (room.host === pid && room.started && room.G.phase === "matchOver") startMatch(room, now, fx);
      return fx;
    case "settings": return handleSettings(room, pid, msg, now, fx);
    case "sit": return handleSit(room, pid, msg, now, fx);
    case "stand":
      if (player.seat != null) { releaseSeat(room, pid); promoteSpectators(room, pid); reassignHost(room); drive(room, now, fx); }
      return fx;
    case "kick": return handleKick(room, pid, msg, now, fx);
    case "ready":
      if (room.started && room.G.phase === "roundEnd" && player.seat != null) { player.ready = true; drive(room, now, fx); }
      return fx;
    case "back": // away flag already cleared above; just re-broadcast
      fx.broadcast = true;
      return fx;
    case "chat": {
      const text = codePoints(String(msg.text || "").trim(), CHAT_MAX_LEN);
      if (!text) return fx;
      room.chat.push({ from: player.name, seat: player.seat, text, ts: now });
      if (room.chat.length > CHAT_RING) room.chat.shift();
      fx.broadcast = true;
      return fx;
    }
    case "emote":
      if (player.seat != null && EMOTES.includes(msg.e)) fx.emote = { seat: player.seat, e: msg.e };
      return fx;
    case "bid": case "trump": case "call": case "play":
      return handleGameAction(room, pid, msg, now, fx);
    default:
      return fx;
  }
}

function handleSettings(room, pid, msg, now, fx) {
  if (room.host !== pid) return fx;
  const s = room.settings;
  if (DIFFICULTIES.includes(msg.difficulty)) s.difficulty = msg.difficulty; // allowed anytime
  if (!room.started) {
    if (TARGET_DEAL_CHOICES.includes(msg.targetDeals)) s.targetDeals = msg.targetDeals;
    if (TURN_TIMER_CHOICES.includes(msg.turnTimerSec)) s.turnTimerSec = msg.turnTimerSec;
  } else if (TURN_TIMER_CHOICES.includes(msg.turnTimerSec)) {
    s.turnTimerSec = msg.turnTimerSec; // timer tweaks mid-match are harmless
  }
  drive(room, now, fx);
  return fx;
}

function handleSit(room, pid, msg, now, fx) {
  const player = room.players[pid];
  const seat = Number(msg.seat);
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) return fx;
  if (room.seatOwner[seat] != null) return fx;                  // taken
  if (room.started && player.seat != null) return fx;           // no mid-match seat hopping
  if (player.seat != null) { room.seatOwner[player.seat] = null; } // lobby move
  room.seatOwner[seat] = pid; player.seat = seat; player.ready = false;
  if (room.started) room.G.names[seat] = player.name;
  reassignHost(room);
  drive(room, now, fx);
  return fx;
}

function handleKick(room, pid, msg, now, fx) {
  if (room.host !== pid) return fx;
  const seat = Number(msg.seat);
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) return fx;
  const target = room.seatOwner[seat];
  if (target == null || target === pid) return fx;
  releaseSeat(room, target);
  delete room.players[target];
  fx.closes = [target];
  promoteSpectators(room);
  reassignHost(room);
  drive(room, now, fx);
  return fx;
}

function handleGameAction(room, pid, msg, now, fx) {
  const player = room.players[pid];
  if (!room.started || player.seat == null) return fx;
  const G = room.G, seat = player.seat;
  const ra = E.requiredActor(G);
  if (!ra || ra.seat !== seat) return fx; // not your turn

  if (msg.type === "bid" && ra.kind === "bid") {
    const value = msg.value === null || msg.value === undefined ? null : Number(msg.value);
    if (!E.bidIsLegal(G, seat, value)) { fx.sends = [{ pid, obj: { type: "error", message: "illegal bid" } }]; return fx; }
    E.applyBid(G, seat, value);
  } else if (msg.type === "trump" && ra.kind === "trump") {
    if (!E.SUITS.includes(msg.suit)) return fx;
    E.applyTrump(G, msg.suit);
  } else if (msg.type === "call" && ra.kind === "call") {
    const card = msg.card && { suit: msg.card.suit, rank: Number(msg.card.rank) };
    if (!E.callIsLegal(G, card)) { fx.sends = [{ pid, obj: { type: "error", message: "illegal call" } }]; return fx; }
    E.applyCall(G, card);
  } else if (msg.type === "play" && ra.kind === "play") {
    const card = msg.card && { suit: msg.card.suit, rank: Number(msg.card.rank) };
    if (!card || !E.playIsLegal(G, seat, card)) { fx.sends = [{ pid, obj: { type: "error", message: "illegal play" } }]; return fx; }
    E.applyPlay(G, seat, card);
  } else {
    return fx;
  }
  drive(room, now, fx);
  return fx;
}

// ---- per-viewer redacted view (the security boundary: no foreign hands) ----
/* `now` is echoed as v.now so the client can measure clock skew and render
   the turn/round deadlines (absolute server ms) as honest countdowns. */
function buildView(room, pid, now) {
  const G = room.G;
  const player = room.players[pid];
  const seat = player ? player.seat : null;
  const v = E.publicView(G);
  v.seats = [0, 1, 2, 3].map(s => {
    const owner = room.seatOwner[s];
    const op = owner != null ? room.players[owner] : null;
    return {
      seat: s,
      label: SEAT_LABEL[s],
      name: room.started ? G.names[s] : (op ? op.name : null),
      isHuman: owner != null,
      connected: op ? op.connected : false,
      away: op ? !!op.away : false,
      ready: op ? !!op.ready : false,
      you: s === seat,
    };
  });
  v.room = {
    code: room.code, started: room.started,
    isHost: room.host != null && room.host === pid,
    hostName: room.host != null && room.players[room.host] ? room.players[room.host].name : null,
    hostSeat: room.host != null && room.players[room.host] ? room.players[room.host].seat : null,
    humans: seatedHumans(room).length,
    spectators: playerList(room).filter(([, p]) => p.seat == null && p.connected).length,
  };
  v.settings = Object.assign({}, room.settings);
  v.chat = room.chat.slice(-CHAT_RING);
  v.now = typeof now === "number" ? now : null;
  const turnT = room.timers.find(t => t.kind === "turn");
  v.turnDeadline = turnT ? turnT.due : null;
  const roundT = room.timers.find(t => t.kind === "round");
  v.roundDeadline = roundT ? roundT.due : null;
  v.you = { seat, playerId: pid, spectator: seat == null, away: player ? !!player.away : false, ready: player ? !!player.ready : false };
  if (room.started && seat != null) {
    v.you.hand = G.hands[seat].slice(); // ONLY this viewer's hand
    const ra = E.requiredActor(G);
    if (ra && ra.seat === seat && player.connected && !player.away) {
      v.you.toAct = true; v.you.actKind = ra.kind;
      if (ra.kind === "play") v.you.legal = E.legalCards(G, seat);
      else if (ra.kind === "call") v.you.callable = E.callableCards(G, seat);
      else if (ra.kind === "bid") v.you.minBid = E.minNextBid(G);
    }
  }
  return v;
}

module.exports = {
  createRoom, join, disconnect, message, fireTimers, nextTimerDue, buildView,
  normCode, randId, cleanName,
  SEAT_LABEL, EMOTES, DIFFICULTIES, TARGET_DEAL_CHOICES, TURN_TIMER_CHOICES,
  MAX_PLAYERS_PER_ROOM, DEFAULT_DELAYS,
};
