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
export { createRoom, join, disconnect, reconcile } from "./membership.js";
export { message } from "./handlers.js";
export { fireTimers, nextTimerDue } from "./timers.js";
export { buildView } from "./view.js";
export { normCode, randId, cleanName } from "./ids.js";
export { SEAT_LABEL, EMOTES, DIFFICULTIES, TARGET_DEAL_CHOICES,
         TURN_TIMER_CHOICES, MAX_PLAYERS_PER_ROOM, DEFAULT_DELAYS } from "./constants.js";
