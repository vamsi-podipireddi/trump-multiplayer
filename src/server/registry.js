import * as R from "../core/room/index.js";
import { MAX_ROOMS, DELAYS } from "./config.js";

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

export { rooms, newRoomCode, getOrCreateRoom, send, applyFx, deleteRoom, armTimer };
