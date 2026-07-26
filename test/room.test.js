"use strict";
/* Room-core tests: redaction property, message fuzzing, lifecycle flows.
   Everything runs on a simulated clock — the core never calls Date.now(). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../room");
const E = require("../engine");

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

function mkRoom(opts) { return R.createRoom("TEST", opts); }
function joinN(room, n, now) {
  const pids = [];
  for (let i = 0; i < n; i++) {
    const { pid, fx } = R.join(room, { name: "P" + i }, now);
    assert.ok(pid, "join produced a pid");
    assert.ok(fx.sends && fx.sends[0].obj.type === "joined");
    pids.push(pid);
  }
  return pids;
}

/* The redaction property: a viewer's serialized view must never contain
   another seat's current hand cards. `you.callable` is excluded — it is the
   exact complement of the viewer's own hand (52 minus their 13), so it
   necessarily "contains" every other card without revealing who holds what. */
function assertRedacted(room, pids) {
  for (const pid of pids) {
    const v = R.buildView(room, pid);
    const clone = JSON.parse(JSON.stringify(v));
    if (clone.you) delete clone.you.callable;
    const s = JSON.stringify(clone);
    const mySeat = room.players[pid] ? room.players[pid].seat : null;
    for (let seat = 0; seat < 4; seat++) {
      if (seat === mySeat) continue;
      for (const c of room.G.hands[seat]) {
        const frag = JSON.stringify({ suit: c.suit, rank: c.rank });
        assert.ok(!s.includes(frag), `view for ${pid} leaked seat ${seat} card ${c.suit}${c.rank}`);
      }
    }
    assert.ok(!("hands" in clone), "no hands array in any view");
  }
}

/* Drive a started room to matchOver on the simulated clock.
   Humans act with the engine's own AI so every action is legal. */
function driveToMatchOver(room, pids, now, onStep) {
  for (let step = 0; step < 100000; step++) {
    if (room.G.phase === "matchOver") return now;
    let acted = false;
    for (const pid of pids) {
      const v = R.buildView(room, pid);
      if (v.you && v.you.toAct) {
        const act = E.aiActionFor(room.G, v.you.seat, "normal");
        assert.ok(act, "actionable seat has an AI action");
        const fx = R.message(room, pid, act, now);
        assert.ok(fx.broadcast, "game action broadcasts");
        acted = true;
        break;
      }
    }
    if (!acted) {
      if (room.G.phase === "roundEnd") {
        for (const pid of pids) R.message(room, pid, { type: "ready" }, now); // everyone readies up
        if (room.G.phase !== "roundEnd") { if (onStep) onStep(now); continue; }
      }
      const due = R.nextTimerDue(room);
      assert.ok(due != null, `stalled with no timer in phase ${room.G.phase}`);
      now = due;
      R.fireTimers(room, now);
    }
    if (onStep) onStep(now);
  }
  assert.fail("match did not finish");
}

test("full 4-human match: every view redacted at every step", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const pids = joinN(room, 4, now);
  R.message(room, pids[0], { type: "start" }, now); // pids[0] is host
  assert.equal(room.started, true);
  driveToMatchOver(room, pids, now, () => assertRedacted(room, pids));
  assert.equal(room.G.phase, "matchOver");
});

test("solo (1 human + 3 AI) match completes on timers alone", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const pids = joinN(room, 1, now);
  R.message(room, pids[0], { type: "start" }, now);
  now = driveToMatchOver(room, pids, now, () => {});
  assert.equal(room.G.phase, "matchOver");
  // host can start a rematch
  const fx = R.message(room, pids[0], { type: "newMatch" }, now);
  assert.equal(room.started, true);
  assert.equal(room.G.phase, "bidding");
  assert.ok(fx.broadcast);
});

test("message fuzzing: 5k garbage messages never throw or leak", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const pids = joinN(room, 2, now);
  R.message(room, pids[0], { type: "start" }, now);
  const types = ["join", "start", "newMatch", "bid", "trump", "call", "play", "sit", "stand", "kick",
    "settings", "ready", "chat", "emote", "back", "zzz", "", null, 42, {}];
  const junk = () => pick([null, undefined, 0, -1, 3.14, 1e308, "", "x".repeat(300), "♠", [], {},
    { suit: "♠", rank: 14 }, { suit: "??", rank: "A" }, [1, 2], true, false, { nested: { deep: [{}] } }]);
  for (let i = 0; i < 5000; i++) {
    const msg = { type: pick(types), value: junk(), suit: junk(), card: junk(), seat: junk(),
      e: junk(), text: junk(), difficulty: junk(), targetDeals: junk(), turnTimerSec: junk() };
    const pid = Math.random() < 0.8 ? pick(pids) : "not-a-player";
    R.message(room, pid, msg, now);
    if (i % 250 === 0) {
      assertRedacted(room, pids);
      assert.ok(["bidding", "trumpSelect", "partnerSelect", "playing", "trickEnd", "roundEnd", "matchOver"]
        .includes(room.G.phase), "phase stays sane: " + room.G.phase);
    }
    if (Math.random() < 0.02) { const due = R.nextTimerDue(room); if (due != null) { now = due; R.fireTimers(room, now); } }
  }
  assertRedacted(room, pids);
});

test("reconnect: same playerId resumes seat; live duplicate flags resumed", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const [p1] = joinN(room, 1, now);
  const seat1 = room.players[p1].seat;
  assert.equal(seat1, 0);
  // duplicate join while still connected → resumed (adapter closes the old socket)
  const dup = R.join(room, { name: "P0", playerId: p1 }, now);
  assert.equal(dup.pid, p1);
  assert.equal(dup.resumed, true);
  // disconnect, then rejoin within grace: seat kept, not resumed
  R.disconnect(room, p1, now);
  assert.equal(room.players[p1].connected, false);
  const back = R.join(room, { name: "P0 back", playerId: p1 }, now + 1000);
  assert.equal(back.pid, p1);
  assert.equal(back.resumed, false);
  assert.equal(room.players[p1].seat, 0);
  assert.equal(room.players[p1].name, "P0 back");
});

test("lobby drop timer releases the seat and promotes a spectator", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const pids = joinN(room, 5, now); // 4 seated + 1 spectator
  assert.equal(room.players[pids[4]].seat, null);
  R.disconnect(room, pids[1], now);
  const due = R.nextTimerDue(room);
  assert.ok(due >= now + R.DEFAULT_DELAYS.drop - 1);
  const fx = R.fireTimers(room, due);
  assert.ok(fx.broadcast);
  assert.equal(room.players[pids[1]], undefined, "dropped player removed");
  assert.equal(room.players[pids[4]].seat, 1, "spectator promoted into the seat");
});

test("host reassigns to a connected seated player on disconnect", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const pids = joinN(room, 3, now);
  assert.equal(room.host, pids[0]);
  R.disconnect(room, pids[0], now);
  assert.notEqual(room.host, pids[0]);
  assert.ok([pids[1], pids[2]].includes(room.host));
});

test("kick: host frees the seat, target removed and closed", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const pids = joinN(room, 2, now);
  const targetSeat = room.players[pids[1]].seat;
  // non-host cannot kick
  R.message(room, pids[1], { type: "kick", seat: room.players[pids[0]].seat }, now);
  assert.ok(room.players[pids[0]]);
  // host kicks
  const fx = R.message(room, pids[0], { type: "kick", seat: targetSeat }, now);
  assert.deepEqual(fx.closes, [pids[1]]);
  assert.equal(room.players[pids[1]], undefined);
  assert.equal(room.seatOwner[targetSeat], null);
});

test("sit and stand", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const [p1, p2] = joinN(room, 2, now);
  assert.equal(room.players[p1].seat, 0);
  // move to an empty seat in the lobby
  R.message(room, p1, { type: "sit", seat: 3 }, now);
  assert.equal(room.players[p1].seat, 3);
  assert.equal(room.seatOwner[0], null);
  // cannot sit on an occupied seat
  R.message(room, p2, { type: "sit", seat: 3 }, now);
  assert.equal(room.players[p2].seat, 1);
  // stand → spectator; seat freed
  R.message(room, p1, { type: "stand" }, now);
  assert.equal(room.players[p1].seat, null);
  assert.equal(room.seatOwner[3], null);
  // mid-match: a spectator may take an AI seat, seated players may not hop
  R.message(room, p2, { type: "start" }, now); // p2 is a seated player; host may have moved
});

test("settings: host-only, validated, difficulty switchable any time", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const [host, other] = joinN(room, 2, now);
  R.message(room, other, { type: "settings", difficulty: "hard" }, now);
  assert.equal(room.settings.difficulty, "normal", "non-host ignored");
  R.message(room, host, { type: "settings", difficulty: "hard", targetDeals: 3, turnTimerSec: 30 }, now);
  assert.deepEqual(room.settings, { difficulty: "hard", targetDeals: 3, turnTimerSec: 30 });
  R.message(room, host, { type: "settings", difficulty: "impossible", targetDeals: 4, turnTimerSec: 7 }, now);
  assert.deepEqual(room.settings, { difficulty: "hard", targetDeals: 3, turnTimerSec: 30 }, "invalid values ignored");
  R.message(room, host, { type: "start" }, now);
  R.message(room, host, { type: "settings", targetDeals: 7, difficulty: "easy" }, now);
  assert.equal(room.settings.targetDeals, 3, "targetDeals locked once started");
  assert.equal(room.settings.difficulty, "easy", "difficulty still switchable");
  assert.equal(room.G.targetGames, 3, "match uses the lobby-time target");
});

test("turn timer: AFK human is put on autopilot and the AI acts", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const [pid] = joinN(room, 1, now);
  R.message(room, pid, { type: "settings", turnTimerSec: 15 }, now);
  R.message(room, pid, { type: "start" }, now);
  // let AI seats act until it's the human's turn
  for (let i = 0; i < 50 && !(R.buildView(room, pid).you || {}).toAct; i++) {
    const due = R.nextTimerDue(room);
    assert.ok(due != null);
    now = due; R.fireTimers(room, now);
  }
  const v = R.buildView(room, pid);
  assert.equal(v.you.toAct, true, "human's turn reached");
  assert.ok(v.turnDeadline > now, "turn deadline exposed to the client");
  const before = JSON.stringify([room.G.phase, room.G.bidTurn, room.G.turn, room.G.trick.length]);
  now = v.turnDeadline;
  R.fireTimers(room, now);
  assert.equal(room.players[pid].away, true, "AFK marked away");
  const after = JSON.stringify([room.G.phase, room.G.bidTurn, room.G.turn, room.G.trick.length]);
  assert.notEqual(before, after, "AI acted for the AFK human");
  // while away, their turns are AI-scheduled, and any message brings them back
  R.message(room, pid, { type: "back" }, now);
  assert.equal(room.players[pid].away, false);
});

test("ready gate: round advances when all live humans are ready", () => {
  let now = 1_000_000;
  const room = mkRoom({ delays: { round: 30000 } });
  const pids = joinN(room, 2, now);
  R.message(room, pids[0], { type: "start" }, now);
  // play a full deal
  for (let step = 0; step < 5000 && room.G.phase !== "roundEnd" && room.G.phase !== "matchOver"; step++) {
    let acted = false;
    for (const pid of pids) {
      const v = R.buildView(room, pid);
      if (v.you.toAct) { R.message(room, pid, E.aiActionFor(room.G, v.you.seat, "normal"), now); acted = true; break; }
    }
    if (!acted) { const due = R.nextTimerDue(room); assert.ok(due != null); now = due; R.fireTimers(room, now); }
  }
  if (room.G.phase !== "roundEnd") return; // deal ended the match — gate not reachable this run
  const round = room.G.roundNumber;
  R.message(room, pids[0], { type: "ready" }, now);
  assert.equal(room.G.roundNumber, round, "one of two ready — still waiting");
  R.message(room, pids[1], { type: "ready" }, now);
  assert.equal(room.G.roundNumber, round + 1, "all ready — advanced immediately");
});

test("chat: ring capped at 50, text capped at 200 code points", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const [pid] = joinN(room, 1, now);
  for (let i = 0; i < 60; i++) R.message(room, pid, { type: "chat", text: "msg " + i }, now);
  assert.equal(room.chat.length, 50);
  assert.equal(room.chat[49].text, "msg 59");
  R.message(room, pid, { type: "chat", text: "y".repeat(500) }, now);
  assert.equal([...room.chat[49].text].length, 200);
  const v = R.buildView(room, pid);
  assert.equal(v.chat.length, 50);
});

test("emote: allowed set only, spectators excluded", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const pids = joinN(room, 5, now);
  const ok = R.message(room, pids[0], { type: "emote", e: "🔥" }, now);
  assert.deepEqual(ok.emote, { seat: 0, e: "🔥" });
  const bad = R.message(room, pids[0], { type: "emote", e: "<script>" }, now);
  assert.equal(bad.emote, undefined);
  const spec = R.message(room, pids[4], { type: "emote", e: "🔥" }, now);
  assert.equal(spec.emote, undefined);
});

test("empty room expires via timer", () => {
  let now = 1_000_000;
  const room = mkRoom();
  const pids = joinN(room, 2, now);
  R.disconnect(room, pids[0], now);
  R.disconnect(room, pids[1], now);
  const due = R.nextTimerDue(room);
  assert.ok(due != null);
  let fx = null;
  for (let guard = 0; guard < 10; guard++) {
    fx = R.fireTimers(room, R.nextTimerDue(room));
    if (fx.deleteRoom) break;
  }
  assert.equal(fx.deleteRoom, true, "room reports expiry");
});

test("room capacity: 13th player rejected", () => {
  let now = 1_000_000;
  const room = mkRoom();
  joinN(room, 12, now);
  const { pid, fx } = R.join(room, { name: "extra" }, now);
  assert.equal(pid, null);
  assert.equal(fx.sends[0].obj.type, "error");
});

test("create refuses an occupied code so nobody lands in a stranger's room", () => {
  const now = 1_000_000;
  const room = mkRoom();

  // creating an empty room is fine
  const first = R.join(room, { name: "Ann", create: true }, now);
  assert.ok(first.pid);

  // a second "create" that happens to mint the same code is refused, not merged
  const clash = R.join(room, { name: "Bob", create: true }, now);
  assert.equal(clash.pid, null);
  assert.equal(clash.fx.sends[0].obj.code, "code-taken");
  assert.equal(Object.keys(room.players).length, 1, "the refused create must not create a player");

  // ...while a plain join with the shared code still works
  const guest = R.join(room, { name: "Bob" }, now);
  assert.ok(guest.pid);
  assert.equal(room.players[guest.pid].seat, 1);

  // ...and the creator's own reconnect is never mistaken for a fresh create
  R.disconnect(room, first.pid, now);
  const back = R.join(room, { name: "Ann", playerId: first.pid, create: true }, now);
  assert.equal(back.pid, first.pid, "reconnect with a stale create flag must still resume");
  assert.equal(room.players[first.pid].seat, 0);
});

test("stats identity: uid is stored on the player, capped, and never in another player's view", () => {
  const now = 1_000_000;
  const room = mkRoom();
  const a = R.join(room, { name: "Ann", uid: "u".repeat(80) }, now);
  const b = R.join(room, { name: "Bob", uid: "bob-uid" }, now);
  assert.equal(room.players[a.pid].uid.length, 32, "uid is truncated");
  const view = JSON.stringify(R.buildView(room, a.pid, now));
  assert.ok(!view.includes("bob-uid"), "uids must never be broadcast");
  assert.ok(!view.includes(room.players[a.pid].uid), "not even your own uid needs to ride in the view");
});
