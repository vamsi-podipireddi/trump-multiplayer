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
const vm = require("node:vm");
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

/* ------------------------------------------------------------------
   Behavioural tests. The client is one hand-written HTML file, so there
   is no module to import — but a self-contained function can be lifted
   out of the <script> by name and run for real in a vm with a toy DOM.
   That beats asserting on its source text, which proves nothing.
   ------------------------------------------------------------------ */
function lift(name) {
  const at = CLIENT.indexOf(`function ${name}(`);
  assert.ok(at > 0, `client has no function ${name}`);
  let depth = 0, i = CLIENT.indexOf("{", at);
  const start = i;
  for (; i < CLIENT.length; i++) {
    if (CLIENT[i] === "{") depth++;
    else if (CLIENT[i] === "}" && --depth === 0) break;
  }
  const src = CLIENT.slice(at, i + 1);
  assert.ok(src.length > start - at, "extracted a body");
  const ctx = { module: {} };
  vm.runInNewContext(`${src}; module.fn = ${name};`, ctx);
  return ctx.module.fn;
}

/* Minimal stand-in for the handful of node operations syncWindow touches. */
function fakeBox() {
  const kids = [];
  return {
    children: kids,
    get firstChild() { return kids[0] || null; },
    set textContent(v) { if (v === "") kids.length = 0; },
    appendChild(n) { kids.push(n); return n; },
    removeChild(n) { const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1); return n; },
    text() { return kids.map(k => k.v); },
  };
}

test("syncWindow appends only what is new (aria-live must not re-announce the backlog)", () => {
  const syncWindow = lift("syncWindow");
  const box = fakeBox();
  const build = keys => i => ({ v: keys[i] });

  let keys = ["a", "b", "c"];
  assert.equal(syncWindow(box, keys, build(keys)), 3, "first paint inserts everything");
  assert.deepStrictEqual(box.text(), ["a", "b", "c"]);

  // the same window again: the common case, and it must touch nothing at all
  const before = box.children.map(k => k);
  keys = ["a", "b", "c"];
  assert.equal(syncWindow(box, keys, () => assert.fail("must not rebuild an unchanged window")), 0);
  assert.deepStrictEqual(box.children, before, "identical nodes are kept, so nothing is re-announced");

  // one new entry appended
  keys = ["a", "b", "c", "d"];
  assert.equal(syncWindow(box, keys, build(keys)), 1, "only the new row is inserted");
  assert.deepStrictEqual(box.text(), ["a", "b", "c", "d"]);
  assert.equal(box.children[0], before[0], "existing rows are the same nodes");

  // the window slides: oldest entries scroll off the top, one arrives
  keys = ["b", "c", "d", "e"];
  assert.equal(syncWindow(box, keys, build(keys)), 1);
  assert.deepStrictEqual(box.text(), ["b", "c", "d", "e"]);

  // a jump with no overlap (new deal, reconnect) falls back to a full redraw
  keys = ["x", "y"];
  assert.equal(syncWindow(box, keys, build(keys)), 2);
  assert.deepStrictEqual(box.text(), ["x", "y"]);

  // emptying works, and so does refilling from empty
  keys = [];
  syncWindow(box, keys, build(keys));
  assert.deepStrictEqual(box.text(), []);
  keys = ["z"];
  assert.equal(syncWindow(box, keys, build(keys)), 1);
  assert.deepStrictEqual(box.text(), ["z"]);
});

test("syncWindow survives a whole match's worth of log windows", () => {
  const syncWindow = lift("syncWindow");
  const box = fakeBox();
  const all = [];
  for (let i = 0; i < 500; i++) {
    all.push("entry " + i);
    const win = all.slice(-40);                 // exactly what publicView sends
    syncWindow(box, win, j => ({ v: win[j] }));
    assert.deepStrictEqual(box.text(), win, `window desynced after ${i} entries`);
  }
});

test("esc() neutralises every character that can break out of markup", () => {
  const esc = lift("esc");
  assert.equal(esc(`<script>alert(1)</script>`), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(esc(`" onerror="x`), "&quot; onerror=&quot;x");
  assert.equal(esc(`' onerror='x`), "&#39; onerror=&#39;x", "single quotes matter: names land in attributes");
  assert.equal(esc("a & b"), "a &amp; b");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  // a name is the realistic attacker-controlled string; no markup delimiter survives
  // (& is excluded: its escape *is* "&amp;", which necessarily starts with one)
  for (const ch of ["<", ">", '"', "'"]) assert.ok(!esc(`x${ch}y`).includes(ch), `${ch} not escaped`);
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
  for (const f of ["seat", "label", "name", "isHuman", "connected", "away", "ready", "claimed", "you"])
    assert.ok(f in v.seats[0], `view.seats[0] is missing ${f}`);
  for (const f of ["seat", "playerId", "spectator", "away", "ready", "pendingSeat"])
    assert.ok(f in v.you, `view.you is missing ${f}`);
  assert.strictEqual(v.now, 1000, "view.now must echo the caller's clock for skew correction");
});

test("client handles every error code the core can send", () => {
  const codes = matchAll(
    fs.readFileSync(path.join(__dirname, "..", "room.js"), "utf8"),
    /code: "([a-z-]+)"/, 1);
  assert.ok(codes.length >= 2, "expected the core to define error codes");
  for (const c of uniq(codes))
    assert.ok(new RegExp(`m\\.code === "${c}"`).test(CLIENT), `client ignores error code "${c}"`);
});

test("no leftover debug hooks in the shipped client", () => {
  assert.ok(!/console\.log\(/.test(CLIENT), "client should not ship console.log calls");
  assert.ok(!/\bdebugger\b/.test(CLIENT), "client should not ship a debugger statement");
});
