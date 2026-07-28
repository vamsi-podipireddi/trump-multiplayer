import * as E from "../../../app/js/core/engine/index.js";
import { SEAT_LABEL, CHAT_RING } from "./constants.js";
import { playerList, seatedHumans } from "./seats.js";

// ---- per-viewer redacted view (the security boundary: no foreign hands) ----
/* `now` is echoed as v.now so the client can measure clock skew and render
   the turn/round deadlines (absolute server ms) as honest countdowns. */
function buildView(room, pid, now) {
  const G = room.G;
  const player = room.players[pid];
  const seat = player ? player.seat : null;
  const v = E.publicView(G);
  const claimed = new Set(playerList(room).map(([, p]) => p.wantSeat).filter(s => s != null));
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
      claimed: owner == null && claimed.has(s), // someone is waiting to be dealt in here
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
  v.you = {
    seat, playerId: pid, spectator: seat == null,
    away: player ? !!player.away : false, ready: player ? !!player.ready : false,
    pendingSeat: player && player.wantSeat != null ? player.wantSeat : null,
  };
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

export { buildView };
