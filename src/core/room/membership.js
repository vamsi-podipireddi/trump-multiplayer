import * as E from "../../../app/js/core/engine/index.js";
import { MAX_KICKED, MAX_PLAYERS_PER_ROOM, DEFAULT_DELAYS } from "./constants.js";
import { cleanName, randId } from "./ids.js";
import { playerList, reassignHost, releaseSeat, promoteSpectators, connectedCount, freeSeatFor } from "./seats.js";
import { setTimer, clearTimersOfKind } from "./timers.js";
import { drive } from "./drive.js";

function createRoom(code, opts) {
  return {
    code,
    G: E.createMatch(),
    started: false,
    settings: { difficulty: "normal", targetDeals: 5, turnTimerSec: 45, coach: true },
    seatOwner: [null, null, null, null],   // pid per seat (null = AI / open)
    players: {},                            // pid -> {name, uid, seat|null, wantSeat|null, connected, away, ready}
    host: null,
    chat: [],                               // ring buffer of {from, seat, text, ts}
    kicked: {},                             // pid / "uid:…" of players the host removed
    timers: [],                             // [{kind, due, data?}]
    delays: Object.assign({}, DEFAULT_DELAYS, (opts && opts.delays) || {}),
  };
}

// tolerant of a room restored from storage written before `kicked` existed
function isKicked(room, pid, uid) {
  const k = room.kicked;
  return !!(k && ((pid && k[pid]) || (uid && k["uid:" + uid])));
}
function recordKick(room, pid, uid) {
  if (!room.kicked) room.kicked = {};
  const keys = Object.keys(room.kicked);
  if (keys.length > MAX_KICKED) delete room.kicked[keys[0]]; // bounded; a party game, not a ban list
  room.kicked[pid] = true;
  if (uid) room.kicked["uid:" + uid] = true;
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
  if (isKicked(room, pid, uid)) {
    return { pid: null, resumed: false, fx: { sends: [{ pid: null,
      obj: { type: "error", code: "kicked", message: "the host removed you from this table" } }] } };
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
    player = { name, uid, seat: null, wantSeat: null, connected: true, away: false, ready: false };
    room.players[pid] = player;
    const seat = freeSeatFor(room);
    if (seat != null) {
      /* Mid-match a newcomer waits for the next deal before taking over an AI
         seat — being dealt in mid-hand would show them a hand they could then
         trade away by leaving and rejoining into the next open seat. */
      if (room.started) player.wantSeat = seat;
      else { room.seatOwner[seat] = pid; player.seat = seat; }
    }
  }
  clearTimersOfKind(room, ["expire"]);
  if (room.host == null) room.host = pid; else reassignHost(room);
  fx.sends = [{ pid, obj: { type: "joined", playerId: pid, room: room.code, seat: player.seat } }];
  drive(room, now, fx);
  return { pid, resumed, fx };
}

/* `opts.immediate` = the socket abandoned this identity on purpose (it sent a
   second `join`), rather than dropping off the network. There is nothing to
   reconnect to, so skip the grace period entirely — otherwise one socket can
   re-join in a loop and pin every seat and player slot in a room behind
   15-second holds it renews forever. */
function disconnect(room, pid, now, opts) {
  const fx = {};
  const player = room.players[pid];
  if (!player) return fx;
  player.connected = false;

  if (player.seat == null) {
    delete room.players[pid]; // spectators carry no reconnect value
  } else if (opts && opts.immediate) {
    releaseSeat(room, pid);
    delete room.players[pid];
    promoteSpectators(room);
  } else if (!room.started) {
    setTimer(room, "drop", room.delays.drop, now, { pid }); // hold lobby seat briefly
  }
  // started + seated: keep the record; seat is held and AI-played until they return
  reassignHost(room);
  if (connectedCount(room) === 0) setTimer(room, "expire", room.delays.expire, now);
  drive(room, now, fx);
  return fx;
}

/* Adapter-facing: after a wake-from-hibernation (or a crash) the live sockets
   are the truth about who is connected — the stored snapshot may predate it.
   Doing this in the core, not the adapter, is what keeps the empty-room expiry
   armed for a room whose players all vanished while it was asleep. */
function reconcile(room, livePids, now) {
  const live = new Set(livePids || []);
  for (const [pid, p] of playerList(room)) {
    p.connected = live.has(pid);
    if (!p.connected && p.seat == null) delete room.players[pid]; // orphaned spectators
  }
  reassignHost(room);
  if (connectedCount(room) === 0) setTimer(room, "expire", room.delays.expire, now);
  else clearTimersOfKind(room, ["expire"]);
}

export { createRoom, recordKick, join, disconnect, reconcile };
