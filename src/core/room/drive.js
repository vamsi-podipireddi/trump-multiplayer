import * as E from "../../../app/js/core/engine/index.js";
import { resetReady, applyPendingSeats, seatIsLiveHuman, connectedCount, seatedHumans } from "./seats.js";
/* Cyclic with timers.js: this file reads setTimer/clearTimersOfKind/
   GAME_TIMER_KINDS/sameData from there; timers.js's fireTimers calls back
   into drive/dealNext/aiAct here. Safe only because every such reference is
   read inside a function body — never at either file's top level. */
import { setTimer, clearTimersOfKind, GAME_TIMER_KINDS, sameData } from "./timers.js";

/* Everything that starts a new deal must hand out the parked seats with it. */
function dealNext(room) { E.nextDeal(room.G); resetReady(room); applyPendingSeats(room); }

/* Recompute which single game timer should be pending, preserving an
   already-armed matching timer so repeated drives don't push deadlines out. */
function drive(room, now, fx) {
  fx.broadcast = true;
  if (!room.started) { clearTimersOfKind(room, GAME_TIMER_KINDS); return; }
  const G = room.G;

  // nobody home: freeze the match exactly where it is until someone comes back
  if (connectedCount(room) === 0) { clearTimersOfKind(room, GAME_TIMER_KINDS); return; }

  /* Ready gate: advance as soon as every live seated human has readied up.
     "No live humans" is NOT unanimous consent — with everyone away or gone the
     deal has to be paced by the round timer, or the result flashes past the
     spectators (and past the players, when a shared blip disconnects them all). */
  let guard = 0;
  while (G.phase === "roundEnd" && guard++ < 4) {
    const live = seatedHumans(room).filter(([, p]) => p.connected && !p.away);
    if (!live.length || !live.every(([, p]) => p.ready)) break;
    dealNext(room);
  }

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

export { dealNext, drive, aiAct };
