import { SEAT_LABEL } from "./constants.js";

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

/* ---- deferred seating (the hand-secrecy boundary) ----
   Sitting down reveals that seat's hand. Mid-match that has to wait for a deal
   boundary: otherwise one player can stand, sit somewhere else, and read a
   second hand — repeat and they see the whole table. Joiners and sitters are
   parked in `wantSeat` and dealt in by applyPendingSeats() on the next deal. */
function freeSeatFor(room) {
  const wanted = new Set(playerList(room).map(([, p]) => p.wantSeat).filter(s => s != null));
  for (let s = 0; s < 4; s++) if (room.seatOwner[s] == null && !wanted.has(s)) return s;
  return null;
}
function applyPendingSeats(room) {
  for (const [pid, p] of playerList(room)) {
    if (p.wantSeat == null) continue;
    const seat = p.wantSeat;
    p.wantSeat = null;
    if (p.seat != null || !p.connected || room.seatOwner[seat] != null) continue; // lost the race
    room.seatOwner[seat] = pid; p.seat = seat; p.ready = false;
    if (room.started) room.G.names[seat] = p.name;
  }
}

export {
  playerList, connectedCount, seatIsLiveHuman, seatedHumans, reassignHost,
  promoteSpectators, releaseSeat, resetReady, freeSeatFor, applyPendingSeats,
};
