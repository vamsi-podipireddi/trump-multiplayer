import * as E from "../../../app/js/core/engine/index.js";
import { releaseSeat, promoteSpectators, reassignHost, connectedCount, seatIsLiveHuman } from "./seats.js";
/* Cyclic with drive.js: fireTimers below calls drive/dealNext/aiAct, and
   drive.js calls back here for setTimer/clearTimersOfKind/GAME_TIMER_KINDS/
   sameData. Safe only because every such reference, on both sides, is read
   inside a function body — never at either file's top level. */
import { drive, dealNext, aiAct } from "./drive.js";

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
    else if (g.kind === "round" && G.phase === "roundEnd") dealNext(room);
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

export { setTimer, clearTimersOfKind, sameData, nextTimerDue, GAME_TIMER_KINDS, fireTimers };
