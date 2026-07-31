/* The coach's view→position adapter, checked against the server state it is
   reconstructing. If these two ever disagree, the browser's search is either
   weaker than the bot's (missing a public fact) or stronger than it should be. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/core/room/index.js";
import * as E from "../app/js/core/engine/index.js";
import { shadowFromView } from "../app/js/coach/shadow.js";
import { tableRead } from "../app/js/coach/read.js";

/* Seat four humans and drive the match with the engine's own AI, so every
   action is legal, sampling every seat's view after each event. */
function drive(onStep) {
  const room = R.createRoom("TEST");
  const pids = [];
  for (let i = 0; i < 4; i++) {
    const { pid } = R.join(room, { name: "P" + i }, 0);
    pids.push(pid);
    R.message(room, pid, { type: "sit", seat: i }, 0);
  }
  R.message(room, pids[0], { type: "start" }, 0);
  for (let step = 0; step < 5000 && room.G.phase !== "matchOver"; step++) {
    /* requiredActor() is null for "roundEnd" (it is a timed phase, not an actor
       one), so this has to run before that check, unconditionally — the ready
       gate lives inside drive(), which both message() and fireTimers() call,
       but only a "ready" message actually sets a player's ready flag. Checking
       this after taking an action (as the brief's version did) never fires: once
       the round ends there is no more action to take, so that branch is dead. */
    if (room.G.phase === "roundEnd") { for (const pid of pids) R.message(room, pid, { type: "ready" }, 0); continue; }
    const ra = E.requiredActor(room.G);
    if (!ra) { R.fireTimers(room, 1e9); continue; }
    const act = E.aiActionFor(room.G, ra.seat, "normal");
    R.message(room, pids[ra.seat], act, 0);
    onStep(room, pids);
  }
}

test("the shadow's public facts match the server's exactly", () => {
  let checked = 0;
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    for (let seat = 0; seat < 4; seat++) {
      const g = shadowFromView(R.buildView(room, pids[seat], 0));
      assert.ok(g, "a seated player's view must produce a position");
      assert.deepEqual(g.playedCards, room.G.playedCards, "playedCards drifted from the server's");
      assert.deepEqual(g.voids, room.G.voids, "derived voids drifted from the server's");
      assert.deepEqual(g.hands[seat], room.G.hands[seat], "my own hand must come through intact");
      for (const p of [0, 1, 2, 3]) assert.equal(g.hands[p].length, room.G.hands[p].length,
        `seat ${p}'s hand count is wrong`);
      checked++;
    }
  });
  assert.ok(checked > 200, `expected many sampled positions, got ${checked}`);
});

test("the shadow carries no foreign card", () => {
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const seat = 0;
    const g = shadowFromView(R.buildView(room, pids[seat], 0));
    const played = new Set(room.G.playedCards.map(c => c.suit + c.rank));
    for (const p of [1, 2, 3]) for (const c of g.hands[p])
      assert.equal(c, null, `seat ${p}'s placeholder held a real card`);
    for (const c of g.playedCards)
      assert.ok(played.has(c.suit + c.rank), "playedCards contains a card nobody played");
  });
});

test("a determinization off the shadow is legal and complete", () => {
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const g = shadowFromView(R.buildView(room, pids[1], 0));
    const world = E._determinize(g, 1, E.mulberry32(5));   // the barrel's name for determinize
    if (!world) return;                                   // rare, and the caller falls back
    for (const p of [0, 2, 3]) {
      assert.equal(world[p].length, room.G.hands[p].length, `seat ${p} dealt the wrong count`);
      for (const c of world[p]) assert.ok(c && c.suit && c.rank, "a placeholder survived into a world");
    }
  });
});

test("a spectator view yields no position", () => {
  const room = R.createRoom("TEST");
  const { pid } = R.join(room, { name: "watcher" }, 0);
  assert.equal(shadowFromView(R.buildView(room, pid, 0)), null);
});

test("a seated player yields no position before the match starts", () => {
  const room = R.createRoom("TEST");
  const { pid } = R.join(room, { name: "P0" }, 0);
  R.message(room, pid, { type: "sit", seat: 0 }, 0);
  const v = R.buildView(room, pid, 0);
  assert.equal(v.you.hand, undefined, "buildView only deals out a hand once room.started");
  assert.equal(shadowFromView(v), null);
});

test("points live plus points captured is always 250", () => {
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const r = tableRead(R.buildView(room, pids[0], 0));
    const taken = room.G.capturedPoints.reduce((a, b) => a + b, 0);
    assert.equal(r.pointsLive + taken, 250, "the table read lost points");
    assert.equal(r.captured.mine + r.captured.theirs, taken, "sides do not sum to what was captured");
  });
});

/* fallen tracks playedCards, which includes the trick still in flight; takenBy
   names a trick's winner, which nothing can before that trick resolves. So
   there is a real window — the bonus three led or sitting mid-trick, not yet
   the trick's last card — where fallen is true and takenBy is honestly still
   null. midTrickSamples pins that this window is actually exercised by the
   drive, not just theoretically possible: a branch a property test never
   reaches is a branch it never actually checked. */
test("the bonus three is reported exactly when it has fallen, and taken only once its trick resolves", () => {
  let midTrickSamples = 0;
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const v = R.buildView(room, pids[0], 0);
    const r = tableRead(v);
    const played = shadowFromView(v).playedCards.some(c => c.rank === 3 && c.suit === v.bonusSuit);
    const settled = (v.tricks || []).some(t => t.cards.some(c => c.card.rank === 3 && c.card.suit === v.bonusSuit));
    assert.equal(r.bonus.fallen, played, "bonus.fallen must track the played cards, in-flight trick included");
    if (settled) {
      assert.ok(r.bonus.takenBy != null && r.bonus.takenBy >= 0, "a settled bonus must name its taker");
    } else {
      assert.equal(r.bonus.takenBy, null, "nobody has taken the bonus until its trick resolves");
      if (played) midTrickSamples++;
    }
  });
  assert.ok(midTrickSamples > 0, "expected the fallen-but-unresolved window to occur at least once in this run");
});

test("outstanding counts exclude my own hand and everything played", () => {
  drive((room, pids) => {
    if (room.G.phase !== "playing") return;
    const v = R.buildView(room, pids[2], 0);
    const r = tableRead(v);
    for (const s of ["♠", "♥", "♦", "♣"]) {
      const mine = v.you.hand.filter(c => c.suit === s).length;
      const gone = room.G.playedCards.filter(c => c.suit === s).length;
      assert.equal(r.outstanding[s].count, 13 - mine - gone, `${s} outstanding count is wrong`);
    }
  });
});
