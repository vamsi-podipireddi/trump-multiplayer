import * as E from "../../../app/js/core/engine/index.js";
import { SEAT_LABEL, EMOTES, DIFFICULTIES, TARGET_DEAL_CHOICES, TURN_TIMER_CHOICES,
         CHAT_MAX_LEN, CHAT_RING } from "./constants.js";
import { codePoints } from "./ids.js";
import { applyPendingSeats, resetReady, releaseSeat, promoteSpectators, reassignHost } from "./seats.js";
import { clearTimersOfKind } from "./timers.js";
import { drive } from "./drive.js";
import { recordKick } from "./membership.js";

// ---- match lifecycle ----
function startMatch(room, now, fx) {
  applyPendingSeats(room); // anyone who asked for a seat during the last match gets it now
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
  if (DIFFICULTIES.includes(msg.difficulty)) {
    /* A mid-match switch means the finished match was played at more than one
       tier, so no single difficulty can honestly describe it — flagged here
       (before s.difficulty is overwritten) rather than recomputed later,
       because "did it change" cannot be reconstructed after the fact from the
       final value alone. Lives on G, exactly where _statsRecorded lives and
       for the same reason: a rematch swaps in a fresh G, clearing it. */
    if (room.started && msg.difficulty !== s.difficulty) room.G._difficultyMixed = true;
    s.difficulty = msg.difficulty; // allowed anytime
  }
  if (typeof msg.coach === "boolean") s.coach = msg.coach;   // a table agreement, not an enforcement boundary
  if (!room.started && TARGET_DEAL_CHOICES.includes(msg.targetDeals)) s.targetDeals = msg.targetDeals;
  if (TURN_TIMER_CHOICES.includes(msg.turnTimerSec) && msg.turnTimerSec !== s.turnTimerSec) {
    s.turnTimerSec = msg.turnTimerSec;   // timer tweaks mid-match are harmless…
    clearTimersOfKind(room, ["turn"]);   // …but must re-arm, or the turn in flight keeps the old length
  }
  drive(room, now, fx);
  return fx;
}

function handleSit(room, pid, msg, now, fx) {
  const player = room.players[pid];
  const seat = Number(msg.seat);
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) return fx;
  if (room.seatOwner[seat] != null) return fx;                  // taken
  if (room.started) {
    if (player.seat != null) return fx;                         // no mid-match seat hopping
    player.wantSeat = seat;                                     // dealt in at the next deal
    drive(room, now, fx);
    return fx;
  }
  if (player.seat != null) { room.seatOwner[player.seat] = null; } // lobby move
  room.seatOwner[seat] = pid; player.seat = seat; player.ready = false;
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
  recordKick(room, target, room.players[target] && room.players[target].uid); // and stays out
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

export { message };
