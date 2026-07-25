"use strict";
/* ============================================================
   Client <-> core protocol contract.

   The client is a single hand-written HTML file, so nothing but a test
   stops it drifting from room.js: a renamed message type or a new emote
   would fail silently at runtime (the server ignores unknown types).
   These tests read both files as text and compare the two vocabularies.
   ============================================================ */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const R = require("../room");

const CLIENT = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const CORE = fs.readFileSync(path.join(__dirname, "..", "room.js"), "utf8");

const uniq = a => [...new Set(a)].sort();
function matchAll(text, re, group) {
  const out = []; let m;
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = rx.exec(text))) out.push(m[group]);
  return out;
}

test("every message type the client sends is handled by the room core", () => {
  const sent = uniq(matchAll(CLIENT, /send\(\{\s*type:\s*"([a-zA-Z]+)"/, 1)
    .concat(matchAll(CLIENT, /ws\.send\(JSON\.stringify\(\{\s*type:\s*"([a-zA-Z]+)"/, 1)));
  const handled = new Set(matchAll(CORE, /case "([a-zA-Z]+)":/, 1).concat(["join"]));
  assert.ok(sent.length >= 12, `expected the client to speak the full protocol, saw: ${sent.join(",")}`);
  for (const t of sent) assert.ok(handled.has(t), `client sends "${t}" but room.js has no handler`);
});

test("client covers every server->client message kind", () => {
  // room.js/adapters only ever push these four shapes
  for (const kind of ["joined", "state", "emote", "error"])
    assert.ok(new RegExp(`m\\.type === "${kind}"`).test(CLIENT), `client onMsg ignores "${kind}"`);
});

test("client option lists match the core's validated choices", () => {
  const clientEmotes = matchAll(
    (CLIENT.match(/const EMOTES = \[([^\]]+)\]/) || [, ""])[1], /"([^"]+)"/, 1);
  assert.deepStrictEqual(clientEmotes, R.EMOTES, "emote bar must match room.js EMOTES exactly");

  const diffs = matchAll((CLIENT.match(/const DIFF_OPTS = (\[.*\]);/) || [, ""])[1], /\["([a-z]+)",/, 1);
  assert.deepStrictEqual(diffs, R.DIFFICULTIES);

  const deals = (CLIENT.match(/const DEAL_OPTS = \[([^\]]+)\]/) || [, ""])[1].split(",").map(Number);
  assert.deepStrictEqual(deals, R.TARGET_DEAL_CHOICES);

  const timers = (CLIENT.match(/const TIMER_OPTS = \[([^\]]+)\]/) || [, ""])[1].split(",").map(Number);
  assert.deepStrictEqual(timers, R.TURN_TIMER_CHOICES);
});

test("client only reads view fields the core actually publishes", () => {
  const room = R.createRoom("TEST");
  const { pid } = R.join(room, { name: "A" }, 1000);
  R.message(room, pid, { type: "start" }, 1000);
  const v = R.buildView(room, pid, 1000);
  // fields the M6 client depends on beyond the engine's own publicView
  for (const f of ["seats", "room", "settings", "chat", "now", "turnDeadline", "roundDeadline", "you"])
    assert.ok(f in v, `view is missing ${f}`);
  for (const f of ["code", "started", "isHost", "hostName", "hostSeat", "humans", "spectators"])
    assert.ok(f in v.room, `view.room is missing ${f}`);
  for (const f of ["seat", "label", "name", "isHuman", "connected", "away", "ready", "you"])
    assert.ok(f in v.seats[0], `view.seats[0] is missing ${f}`);
  for (const f of ["seat", "playerId", "spectator", "away", "ready"])
    assert.ok(f in v.you, `view.you is missing ${f}`);
  assert.strictEqual(v.now, 1000, "view.now must echo the caller's clock for skew correction");
});

test("no leftover debug hooks in the shipped client", () => {
  assert.ok(!/console\.log\(/.test(CLIENT), "client should not ship console.log calls");
  assert.ok(!/\bdebugger\b/.test(CLIENT), "client should not ship a debugger statement");
});
