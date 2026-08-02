/* ============================================================
   Client <-> core protocol contract.

   Nothing but a test stops the client drifting from the room core: a renamed
   message type or a new emote would fail silently at runtime (the server
   ignores unknown types). The client and the room core are both real,
   importable modules now, but the vocabularies compared below — message
   types sent vs. handled, option lists, error codes — never meet as values
   at runtime, so there is nothing to import and compare directly; these
   tests read both sides as text instead.
   ============================================================ */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "../src/core/room/index.js";
import { syncWindow } from "../app/js/ui/log.js";
import { esc } from "../app/js/util/dom.js";
import { EMOTES } from "../app/js/cards/icons.js";
import { DIFF_OPTS, DEAL_OPTS, TIMER_OPTS, COACH_OPTS } from "../app/js/screens/lobby.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const jsFiles = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
})(path.join(__dirname, "..", "app", "js"))
  .filter(f => f.endsWith(".js") && !f.includes(`${path.sep}core${path.sep}`));

// The client is index.html (markup only) plus a tree of leaf modules under
// app/js/ (core/ excluded — that's the shared engine, not client code). CLIENT
// is the JS side: the protocol, option-list and error-code scans below read it.
const CLIENT = jsFiles.map(f => fs.readFileSync(f, "utf8")).join("\n");
const CORE = fs.readdirSync(path.join(__dirname, "..", "src", "core", "room"))
  .filter(f => f.endsWith(".js"))
  .map(f => fs.readFileSync(path.join(__dirname, "..", "src", "core", "room", f), "utf8"))
  .join("\n");

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
  for (const t of sent) assert.ok(handled.has(t), `client sends "${t}" but the room core has no handler`);
});

test("client covers every server->client message kind", () => {
  // the room core/adapters only ever push these four shapes
  for (const kind of ["joined", "state", "emote", "error"])
    assert.ok(new RegExp(`m\\.type === "${kind}"`).test(CLIENT), `client onMsg ignores "${kind}"`);
});

test("client option lists match the core's validated choices", () => {
  assert.deepStrictEqual(EMOTES, R.EMOTES, "emote bar must match room constants exactly");
  assert.deepStrictEqual(DIFF_OPTS.map(o => o[0]), R.DIFFICULTIES);
  assert.deepStrictEqual(DEAL_OPTS, R.TARGET_DEAL_CHOICES);
  assert.deepStrictEqual(TIMER_OPTS, R.TURN_TIMER_CHOICES);
  // coach validates by typeof, not membership, so there is no R.COACH_CHOICES to pin against —
  // the vocabulary IS the boolean type, and this pins the toggle to exactly its two values
  assert.deepStrictEqual(COACH_OPTS.map(o => o[0]), [true, false]);
});

/* ------------------------------------------------------------------
   Behavioural tests. syncWindow and esc are real exports now (imported
   above), so they run for real here instead of being lifted out of source
   text and sandboxed in a vm — that beats asserting on source text, which
   proves nothing about whether the code actually works.
   ------------------------------------------------------------------ */

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
  // the table renders these directly; they used to ship unused (tricksWon) or not at all (bids)
  for (const f of ["tricksWon", "bids", "bidActive", "highBidder", "capturedPoints"])
    assert.ok(f in v, `view is missing ${f}`);
  assert.equal(v.bids.length, 4, "one bid slot per seat");
  assert.strictEqual(v.now, 1000, "view.now must echo the caller's clock for skew correction");
});

test("client handles every error code the core can send", () => {
  const codes = matchAll(
    fs.readdirSync(path.join(__dirname, "..", "src", "core", "room"))
      .filter(f => f.endsWith(".js"))
      .map(f => fs.readFileSync(path.join(__dirname, "..", "src", "core", "room", f), "utf8"))
      .join("\n"),
    /code: "([a-z-]+)"/, 1);
  assert.ok(codes.length >= 2, "expected the core to define error codes");
  for (const c of uniq(codes))
    assert.ok(new RegExp(`m\\.code === "${c}"`).test(CLIENT), `client ignores error code "${c}"`);
});

test("no leftover debug hooks in the shipped client", () => {
  assert.ok(!/console\.log\(/.test(CLIENT), "client should not ship console.log calls");
  assert.ok(!/\bdebugger\b/.test(CLIENT), "client should not ship a debugger statement");
});

test("the hint button exists in both shells and is gated on the coach setting", async () => {
  for (const shell of ["app/index.html", "app/solo.html"]) {
    const html = fs.readFileSync(path.join(root, shell), "utf8");
    assert.ok(/id="btn-hint"/.test(html), `${shell} has no hint button`);
    assert.ok(/aria-label="[^"]*[Hh]int/.test(html), `${shell}'s hint button has no accessible name`);
  }
  const { hintEnabled } = await import("../app/js/ui/coach.js");
  assert.equal(hintEnabled({ settings: {}, you: { toAct: true } }), true, "a room predating the setting must allow hints");
  assert.equal(hintEnabled({ settings: { coach: false }, you: { toAct: true } }), false);
  assert.equal(hintEnabled({ settings: { coach: true }, you: { toAct: false } }), false, "no hint when it is not your turn");
});

/* describeHint is pure and produces every user-facing hint string — the
   easiest thing in coach.js to unit-test, and previously untested. Both
   sides of the "holds"/"sets" ternary are pinned separately: invert it and a
   defender's own success reads as "holding the contract," which is
   backwards, not just mis-worded — a mutation node --test must not let
   through silently. The bid branch's "of sampled deals" hedge is pinned too
   (makeProb is a model estimate over sampled deals, not a calibrated
   frequency — see the play branch's identical hedge), so a later edit can't
   quietly drop it. */
test("describeHint: text and card mark for each decision kind, including both sides of holds/sets", async () => {
  const { describeHint } = await import("../app/js/ui/coach.js");

  const declarer = { you: { seat: 0 }, declarer: 0, partner: 2 };
  const holds = describeHint(declarer, { kind: "play", best: { card: { suit: "♠", rank: 5 }, winProb: 0.60 } });
  assert.equal(holds.cardKey, "♠5");
  assert.equal(holds.text, "5 of spades — holds the contract in 60% of sampled deals");

  // same shape, opposite side: v.you.seat (0) is neither declarer nor partner
  const defender = { you: { seat: 0 }, declarer: 1, partner: 3 };
  const sets = describeHint(defender, { kind: "play", best: { card: { suit: "♥", rank: 4 }, winProb: 0.17 } });
  assert.equal(sets.cardKey, "♥4");
  assert.equal(sets.text, "4 of hearts — sets the contract in 17% of sampled deals");

  // bid/trump/call carry no card to mark
  const bid = describeHint({}, { kind: "bid", median: 175, target: 140, makeProb: 0.84 });
  assert.equal(bid.cardKey, null);
  assert.equal(bid.text, "Worth about 175 · you make 140 in 84% of sampled deals");

  const trump = describeHint({}, { kind: "trump", suit: "♦" });
  assert.equal(trump.cardKey, null);
  assert.equal(trump.text, "Diamonds — the search's pick for trump");

  const call = describeHint({}, { kind: "call", card: { suit: "♠", rank: 14 } });
  assert.equal(call.cardKey, null);
  assert.equal(call.text, "Ace of spades — the search's pick to call");
});

/* recentFormLine is pure and produces the join screen's second stats line
   (Task 10) — /stats' own recentForm field is already scoped to one
   difficulty and excludes mixed matches server-side (src/worker/stats.js's
   readRecentForm); this only has to render what it is handed, or nothing. */
test("recentFormLine: a second line scoped to one difficulty, or nothing when there's too little to say", async () => {
  const { recentFormLine } = await import("../app/js/screens/join.js");
  assert.equal(recentFormLine(null), "",
    "readStats sends null when a tier doesn't have enough matches yet — render nothing, not a stray label");
  assert.equal(recentFormLine(undefined), "", "an older client talking to a pre-Task-10 worker gets no field at all");

  const line = recentFormLine({ difficulty: "hard", n: 5, wins: 3, bidsWon: 4, bidsMade: 2 });
  assert.match(line, /^<br>/, "a second line under Your record, not a replacement for it");
  assert.match(line, /Hard/, "the difficulty is spelled out (DIFF_OPTS' label), not the raw settings key");
  assert.match(line, /<b>3<\/b>/, "wins");
  assert.match(line, /<b>5<\/b>/, "n");
  assert.match(line, /<b>4<\/b>/, "bidsWon");
  assert.match(line, /<b>2<\/b>/, "bidsMade");

  // escaped like every other interpolation on this line: server-derived
  // values land in innerHTML (join.js's loadStats), so an unrecognised
  // difficulty string must not be trusted verbatim.
  const unsafe = recentFormLine({ difficulty: "<img onerror=alert(1)>", n: 3, wins: 1, bidsWon: 1, bidsMade: 1 });
  assert.ok(!unsafe.includes("<img"), "an unrecognised difficulty must be escaped, not injected");
});

test("the table read lives in the left rail and inside the Score sheet tab", () => {
  const html = fs.readFileSync(path.join(root, "app/index.html"), "utf8");
  assert.ok(/id="tableread"/.test(html), "no table-read container");
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(tabs)].sort(), ["chat", "log", "score"],
    "the bottom sheet must stay at three tabs — the read belongs inside Score");
});

/* ---------------------------------------------------------------------------
   describeTableRead(v, o) — the pure half of the table-read panel. It calls
   the already-tested tableRead(v) (test/coach.test.js owns tableRead's own
   numbers) and layers the panel's own presentation decisions on top: hiding
   the side split, wording the bonus three's three states, dropping voidless
   seats. Real engine views throughout, not hand-built fixtures: shadowFromView
   reads enough of a view's shape (tricks, trick, handCounts, leadSuit) that a
   fixture assembled by hand risks silently drifting from what the wire
   actually sends. Each scenario instead starts from one real, dealt view and
   overrides only the fields that scenario is about — deterministic, unlike
   searching a live drive() for a rare window (coach.test.js's own approach,
   justified there by testing tableRead's derivation itself; here the
   derivation is a given and only describeTableRead's own wording is new). */
function freshRoom() {
  const room = R.createRoom("TEST");
  const pids = [];
  for (let i = 0; i < 4; i++) {
    const { pid } = R.join(room, { name: "P" + i }, 0);
    pids.push(pid);
    R.message(room, pid, { type: "sit", seat: i }, 0);
  }
  return { room, pids };
}
const namedCtx = { seatInfo: s => ({ name: "P" + s }) };

test("describeTableRead hides the side split before the reveal, and for a seatless viewer even after it", async () => {
  const { describeTableRead } = await import("../app/js/ui/coach.js");
  const { room, pids } = freshRoom();
  R.message(room, pids[0], { type: "start" }, 0);
  const mid = R.buildView(room, pids[0], 0);   // real, dealt, still bidding
  assert.equal(mid.teamsRevealed, false, "test setup: expected to still be bidding");
  assert.equal(describeTableRead(mid, namedCtx).side, null, "pre-reveal must hide the split");

  // bid set explicitly so `needed` would be non-null but for the seat check below —
  // otherwise this passes for the wrong reason (no bid yet) instead of the one it's pinning
  const noSeat = { ...mid, teamsRevealed: true, declarer: 0, partner: 2, bid: 130, you: { ...mid.you, seat: null } };
  assert.equal(describeTableRead(noSeat, namedCtx).side, null,
    "a viewer with no seat has no 'my side' to report, even once teams are revealed");
});

test("describeTableRead reports the side split from the viewing seat's own side, once revealed", async () => {
  const { describeTableRead } = await import("../app/js/ui/coach.js");
  const { room, pids } = freshRoom();
  R.message(room, pids[0], { type: "start" }, 0);
  // declarer(0)+partner(2) captured 60 between them, the rest (1,3) captured 15
  const overrides = { teamsRevealed: true, declarer: 0, partner: 2, bid: 150, capturedPoints: [40, 10, 20, 5] };
  const view = seat => ({ ...R.buildView(room, pids[seat], 0), ...overrides });

  // mineLabel/theirsLabel name every seat on each side (never a bare pronoun) —
  // see the dedicated labelling test below for why that matters and the
  // lone-declarer 1-vs-3 shape; this test is only pinning mine/theirs/needed.
  assert.deepEqual(describeTableRead(view(0), namedCtx).side,
    { mine: 60, theirs: 15, needed: 90, mineLabel: "You & P2", theirsLabel: "P1 & P3" }, "the declarer");
  assert.deepEqual(describeTableRead(view(2), namedCtx).side,
    { mine: 60, theirs: 15, needed: 90, mineLabel: "P0 & You", theirsLabel: "P1 & P3" }, "the called partner");
  assert.deepEqual(describeTableRead(view(1), namedCtx).side,
    { mine: 15, theirs: 60, needed: 90, mineLabel: "You & P3", theirsLabel: "P0 & P2" }, "a defender");
});

/* Review finding (Minor): side.mine/theirs are partnership totals, and a bare
   "you"/"them" pronoun let a called partner misread "you 60" as their own
   personal capture. mineLabel/theirsLabel name every seat on the relevant
   side instead — this test is the one that actually exercises the 1-seat and
   3-seat shapes (a lone declarer has no partner; their defenders are three,
   not two), which the 2v2 test above never reaches. */
test("describeTableRead names every seat on a side, including the 1-vs-3 shape when the declarer plays alone", async () => {
  const { describeTableRead } = await import("../app/js/ui/coach.js");
  const { room, pids } = freshRoom();
  R.message(room, pids[0], { type: "start" }, 0);
  const overrides = { teamsRevealed: true, declarer: 0, partner: 2, bid: 150, capturedPoints: [40, 10, 20, 5] };
  const view = seat => ({ ...R.buildView(room, pids[seat], 0), ...overrides });

  const alone = { ...view(0), partner: 0 };   // applyCall()'s "declarer === partner" case
  const aloneSide = describeTableRead(alone, namedCtx).side;
  assert.equal(aloneSide.mineLabel, "You", "a lone declarer's own side is just them — no '&'");
  assert.equal(aloneSide.theirsLabel, "P1 & P2 & P3",
    "three defenders against a lone declarer, the same 3-way join modals.js's showReveal() uses for this exact case");

  const aloneDefender = describeTableRead({ ...view(1), declarer: 0, partner: 0 }, namedCtx).side;
  assert.equal(aloneDefender.mineLabel, "You & P2 & P3", "one of three defenders, 'You' substituted in seat order");
  assert.equal(aloneDefender.theirsLabel, "P0", "a lone declarer's side is a single name, no '&'");
});

test("describeTableRead words the bonus three's status through all three states", async () => {
  const { describeTableRead } = await import("../app/js/ui/coach.js");
  const { room, pids } = freshRoom();
  R.message(room, pids[0], { type: "start" }, 0);
  const base = R.buildView(room, pids[0], 0);

  const notFallen = { ...base, bonusSuit: "♠", tricks: [], trick: [] };
  assert.equal(describeTableRead(notFallen, namedCtx).bonusStatus, "still to fall");

  // led but not yet resolved: bonusTakenBy (read.js) only ever looks at v.tricks,
  // while shadowFromView folds v.trick into playedCards too — the real,
  // documented "fallen but nobody has taken it yet" window, engineered here
  // rather than hoped for out of a live drive.
  const midTrick = { ...base, bonusSuit: "♠", tricks: [],
    leadSuit: "♠", trick: [{ player: 1, card: { suit: "♠", rank: 3 } }] };
  assert.equal(describeTableRead(midTrick, namedCtx).bonusStatus, "fallen — trick in progress");

  const settled = { ...base, bonusSuit: "♠", trick: [],
    tricks: [{ no: 1, winner: 2, pts: 30, winCard: { suit: "♠", rank: 3 },
               cards: [{ player: 1, card: { suit: "♠", rank: 3 } }] }] };
  assert.equal(describeTableRead(settled, namedCtx).bonusStatus, "taken by P2");
});

test("describeTableRead's voids list drops seats with no known void and names the rest", async () => {
  const { describeTableRead } = await import("../app/js/ui/coach.js");
  const { room, pids } = freshRoom();
  R.message(room, pids[0], { type: "start" }, 0);
  const base = R.buildView(room, pids[0], 0);   // viewer is seat 0

  // seat 1 shows out of the led suit — a known void; seats 2/3 haven't played at all
  const v = { ...base, leadSuit: "♠",
    trick: [{ player: 0, card: { suit: "♠", rank: 5 } }, { player: 1, card: { suit: "♥", rank: 4 } }] };
  assert.deepEqual(describeTableRead(v, namedCtx).voids, [{ seat: 1, name: "P1", suits: ["♠"] }],
    "only the seat that actually showed out belongs in the list");
});

/* ---------------------------------------------------------------------------
   tableReadRows(s) / voidsHtml(voids) / suitsHtml(outstanding, trump) — the
   rest of the panel's pure logic (review finding: these touch neither
   `document` nor `localStorage`, so — like describeTableRead/describeHint
   above — there is no reason they can't be checked without a DOM). Fed plain
   objects/arrays in describeTableRead's own output shape directly: unlike a
   view, this is a shape only this file produces and consumes, so a hand-built
   fixture carries none of the wire-drift risk describeTableRead's own tests
   avoid by using real engine views. */

test("tableReadRows: points live always shows; the side and bonus rows only when their data exists", async () => {
  const { tableReadRows } = await import("../app/js/ui/coach.js");

  const bare = { pointsLive: 250, side: null, bonusSuit: null, bonusStatus: "still to fall" };
  assert.deepEqual(tableReadRows(bare), [{ kind: "num", label: "Points live", value: 250, mine: false }],
    "no side (pre-reveal or no seat), no bonus suit assigned yet — just the one row");

  const withBonus = { ...bare, bonusSuit: "♠" };
  assert.deepEqual(tableReadRows(withBonus), [
    { kind: "num", label: "Points live", value: 250, mine: false },
    { kind: "text", label: "Bonus", suit: "♠", value: "still to fall", mine: false },
  ], "a bonus suit assigned adds exactly one row, after points live");

  const withSide = { ...bare, side: { mine: 60, theirs: 15, needed: 90, mineLabel: "You & P2", theirsLabel: "P1 & P3" } };
  assert.deepEqual(tableReadRows(withSide), [
    { kind: "num", label: "Points live", value: 250, mine: false },
    { kind: "num", label: "You & P2", value: 60, mine: true },
    { kind: "num", label: "P1 & P3", value: 15, mine: false },
    { kind: "num", label: "Still needed", value: 90, mine: false },
  ], "revealed: my side's row is flagged mine:true, theirs is not, needed is a plain count");
});

test('tableReadRows: "made it" once the contract is already there, not a bare 0', async () => {
  const { tableReadRows } = await import("../app/js/ui/coach.js");
  const made = { pointsLive: 10, side: { mine: 150, theirs: 90, needed: 0, mineLabel: "You", theirsLabel: "P1 & P2 & P3" },
                 bonusSuit: null, bonusStatus: "" };
  assert.deepEqual(tableReadRows(made).find(r => r.label === "Still needed"),
    { kind: "text", label: "Still needed", value: "made it", mine: false });

  const notYet = { ...made, side: { ...made.side, needed: 5 } };
  assert.deepEqual(tableReadRows(notYet).find(r => r.label === "Still needed"),
    { kind: "num", label: "Still needed", value: 5, mine: false });
});

test("voidsHtml: an empty-state note when nothing is known, escaped rows when something is", async () => {
  const { voidsHtml } = await import("../app/js/ui/coach.js");
  assert.match(voidsHtml([]), /No voids spotted yet\./);
  assert.doesNotMatch(voidsHtml([]), /tr-void-row/);

  const html = voidsHtml([{ seat: 1, name: "West", suits: ["♠", "♦"] }]);
  assert.doesNotMatch(html, /No voids spotted yet\./);
  assert.match(html, /<b>West<\/b>/);
  assert.equal((html.match(/class="sc /g) || []).length, 2, "one suit icon per known-void suit");

  // the one untrusted value voidsHtml ever prints — a player's own chosen name
  const unsafe = voidsHtml([{ seat: 2, name: "<img src=x onerror=alert(1)>", suits: ["♥"] }]);
  assert.ok(!unsafe.includes("<img"), "an unescaped name would inject markup into the rail");
  assert.match(unsafe, /&lt;img/);
});

test('suitsHtml: "gone" vs the top card, and the trump suit is the only tile marked .trump', async () => {
  const { suitsHtml } = await import("../app/js/ui/coach.js");
  const outstanding = { "♠": { count: 0, top: null }, "♥": { count: 3, top: 12 }, "♦": { count: 1, top: 5 }, "♣": { count: 13, top: 14 } };
  const html = suitsHtml(outstanding, "♥");

  assert.match(html, /<span class="top">gone<\/span>/, "a suit with nothing left says 'gone', not 'top null'");
  assert.match(html, /<span class="top">top Q<\/span>/, "rankLabel formats the top card (12 -> Q)");
  assert.match(html, /<span class="top">top A<\/span>/, "14 -> A, not the raw number");

  // exactly one tile carries .trump, and it's the suit passed in — not e.g.
  // the first suit, or every suit if the equality check were ever inverted
  assert.equal((html.match(/tr-suit trump/g) || []).length, 1, "exactly one suit tile is marked trump");
  const spadesIdx = html.indexOf('class="tr-suit">');        // ♠ — not trump here — renders plain
  const heartsIdx = html.indexOf('class="tr-suit trump">');  // ♥ — trump here
  assert.ok(spadesIdx >= 0 && heartsIdx >= 0 && spadesIdx < heartsIdx,
    "♠ (plain) renders before ♥ (trump), matching SUITS' own fixed order");
});

test("the round-result modal offers a review without hiding ready", async () => {
  const src = fs.readFileSync(path.join(root, "app/js/ui/modals.js"), "utf8");
  assert.ok(/review/i.test(src), "showRoundResult never mentions a review");
  const { renderReview } = await import("../app/js/ui/coach.js");
  const html = renderReview({ decisions: [], worst: [], samples: 12 }, { names: ["A","B","C","D"] }, 0);
  assert.ok(/clean|no mistakes|nothing/i.test(String(html)),
    "a spotless deal must say so rather than render an empty list");
});

/* ---------------------------------------------------------------------------
   describeReview(result, v, seat) / renderReview(result, v, seat) — the pure
   half of the deal-review panel (coach.js), same split as describeHint and
   describeTableRead/tableReadRows above. result is reviewDeal's own settled
   shape ({decisions, worst, samples}); its own correctness (the search, the
   grading thresholds, reproducibility) is coach.test.js's job — these tests
   are only about what this panel says given a result, so plain hand-built
   fixtures in that output shape are used throughout, the same call
   describeTableRead's own tests make for a shape only this subsystem
   produces and consumes. */
const declarerView = { names: ["A","B","C","D"], declarer: 0, partner: 2 };
const defenderView = { names: ["A","B","C","D"], declarer: 1, partner: 3 };
const decision = (over) => ({ trickNo: 3, played: { suit: "♠", rank: 5 }, best: { suit: "♠", rank: 12 },
  playedWinProb: 0.52, bestWinProb: 0.71, delta: 0.19, grade: "blunder", samples: 24, ...over });

test("describeReview: no real decisions at all is distinct from a clean deal among real ones", async () => {
  const { describeReview } = await import("../app/js/ui/coach.js");
  const forced = describeReview({ decisions: [], worst: [], samples: 0 }, declarerView, 0);
  assert.deepEqual(forced, { clean: true, thin: false, samples: 0, count: 0, worst: [] });

  const cleanAmongReal = describeReview(
    { decisions: [decision(), decision({ grade: "fine" })], worst: [], samples: 24 }, declarerView, 0);
  assert.equal(cleanAmongReal.clean, true);
  assert.equal(cleanAmongReal.count, 2, "count reflects every real decision, not just worst");
});

test("renderReview: forced (no decisions) and clean-among-real print different, both honest, lines", async () => {
  const { renderReview } = await import("../app/js/ui/coach.js");
  const forced = renderReview({ decisions: [], worst: [], samples: 0 }, declarerView, 0);
  assert.match(forced, /forced/i);
  assert.doesNotMatch(forced, /Based on|Rough read/, "no decisions means no sample-size caveat to print");

  const clean = renderReview({ decisions: [decision(), decision()], worst: [], samples: 24 }, declarerView, 0);
  assert.match(clean, /Clean deal.*\b2\b decisions/i);
  assert.doesNotMatch(clean, /forced/i);

  // singular vs. plural: every other clean-deal check above uses count 2 and
  // so never reaches the "1 decision" (no trailing s) branch on its own
  const one = renderReview({ decisions: [decision()], worst: [], samples: 24 }, declarerView, 0);
  assert.match(one, /1 decision cost the contract/i);
  assert.doesNotMatch(one, /decisions/i, "one real decision must read as singular, not '1 decisions'");
});

test("renderReview: caveats a thin search and doesn't caveat a full one, right at the boundary", async () => {
  const { renderReview } = await import("../app/js/ui/coach.js");
  const thin = renderReview({ decisions: [decision()], worst: [decision({ samples: 19 })], samples: 19 }, declarerView, 0);
  assert.match(thin, /Rough read/i);
  assert.match(thin, /19 sampled deals/);

  const full = renderReview({ decisions: [decision()], worst: [decision({ samples: 20 })], samples: 20 }, declarerView, 0);
  assert.doesNotMatch(full, /Rough read/i, "20 samples is review's own ordinary case, not a thin one");
  assert.match(full, /Based on 20 sampled deals per decision/);
});

test("renderReview: prints trick, both cards, both percentages and the grade for up to two decisions, worst first", async () => {
  const { renderReview } = await import("../app/js/ui/coach.js");
  const worst = [
    decision({ trickNo: 5, grade: "blunder", played: { suit: "♠", rank: 5 }, best: { suit: "♠", rank: 14 }, playedWinProb: 0.3, bestWinProb: 0.8 }),
    decision({ trickNo: 9, grade: "mistake", played: { suit: "♥", rank: 4 }, best: { suit: "♥", rank: 11 }, playedWinProb: 0.5, bestWinProb: 0.6 }),
  ];
  const html = renderReview({ decisions: worst, worst, samples: 24 }, declarerView, 0);

  assert.match(html, /Trick 5/); assert.match(html, /Trick 9/);
  assert.match(html, /class="dr-tag blunder">blunder/); assert.match(html, /class="dr-tag mistake">mistake/);
  // lowercase, unlike describeHint's own "Ace of spades" above: RANK_NAME
  // (cards/labels.js) is itself lowercase ("ace","king","queen","jack"), and
  // describeHint only reads capitalised because cap() capitalises the whole
  // string and the card name happens to lead it there. Here it sits
  // mid-sentence ("you played the ace of spades"), where capitalising it
  // would be wrong, so renderReview never calls cap() on it.
  assert.match(html, /5 of spades/); assert.match(html, /ace of spades/);
  assert.match(html, /4 of hearts/); assert.match(html, /jack of hearts/);
  assert.match(html, /30%/); assert.match(html, /80%/); assert.match(html, /50%/); assert.match(html, /60%/);
  // worst's own order (reviewDeal sorts by delta descending) is preserved, not re-sorted here
  assert.ok(html.indexOf("Trick 5") < html.indexOf("Trick 9"));

  // a third entry is never shown even if a caller hands one in — reviewDeal
  // itself already caps worst at two; this pins describeReview's own
  // .slice(0, 2) defence of that contract rather than trusting the caller
  // to have honoured it
  const three = [worst[0], worst[1], decision({ trickNo: 11 })];
  assert.doesNotMatch(renderReview({ decisions: three, worst: three, samples: 24 }, declarerView, 0), /Trick 11/);
});

test("renderReview: the win percentages read as holds for a declarer and sets for a defender, same seat and numbers", async () => {
  const { renderReview } = await import("../app/js/ui/coach.js");
  const result = { decisions: [decision()], worst: [decision()], samples: 24 };
  assert.match(renderReview(result, declarerView, 0), /which holds the contract/);
  assert.match(renderReview(result, defenderView, 0), /which sets the contract/,
    "seat 0 is neither declarer(1) nor partner(3) in defenderView — a defender's own success is 'sets', not 'holds'");
});

test("renderReview escapes a card label the same way voidsHtml escapes a name", async () => {
  const { renderReview } = await import("../app/js/ui/coach.js");
  // cardName() falls back to the raw suit string for one it doesn't recognise
  // (labels.js: SUIT_NAME[c.suit] || c.suit) — the one way an unexpected
  // string can reach this panel's markup at all, so it stands in for the
  // "untrusted card label" the M9 fix and this task's own brief both name.
  const hostile = decision({ played: { suit: "<img src=x onerror=alert(1)>", rank: 5 } });
  const html = renderReview({ decisions: [hostile], worst: [hostile], samples: 24 }, declarerView, 0);
  assert.ok(!html.includes("<img"), "an unescaped card label would inject markup into the modal");
  assert.match(html, /&lt;img/);
});

/* reviewErrorMessage(res) / REVIEW_REJECTED_MESSAGE — what ui/modals.js's
   paintRoundBody shows on the two ways requestReview can fail to hand back a
   real result: the worker answers ok:false (reviewErrorMessage), or the
   request rejects outright — a dead worker or client.js's own 10s timeout
   (REVIEW_REJECTED_MESSAGE). Both used to be built inline inside
   paintRoundBody, a DOM-writing function no test here can reach (this repo
   has no jsdom), which is exactly the failure-message-with-no-regression-net
   gap Task 10 already shipped once with the hint tray. Pulled out so these
   two lines get the same direct coverage every other wording branch in this
   panel already has. */
test("reviewErrorMessage: the worker's own words, capitalised and read as a sentence", async () => {
  const { reviewErrorMessage } = await import("../app/js/ui/coach.js");
  assert.equal(reviewErrorMessage({ ok: false, error: "no finished deal in this view" }),
    "No finished deal in this view.");
  // no error string at all — still a real, honest sentence, not "undefined."
  assert.equal(reviewErrorMessage({ ok: false }), "The review could not be run.");
  assert.equal(reviewErrorMessage(null), "The review could not be run.");
});

test("REVIEW_REJECTED_MESSAGE: a fixed, honest string for a genuine rejection", async () => {
  const { REVIEW_REJECTED_MESSAGE } = await import("../app/js/ui/coach.js");
  assert.equal(REVIEW_REJECTED_MESSAGE, "The review search failed — try again.");
  // never a raw Error#message: that text is runtime/browser-controlled, not
  // this file's to promise a stable reading of (same rule initCoach's own
  // hint-rejection handler already follows)
  assert.doesNotMatch(REVIEW_REJECTED_MESSAGE, /\bError\b|\[object/);
});

/* ---------------------------------------------------------------------------
   showMatchOver (ui/modals.js) — Task 14: the deal that clinches the match
   skips "roundEnd" entirely (match.js's endRound routes a clinching deal
   straight to "matchOver"), so it never reached showRoundResult's own review
   toggle above — the single most memorable deal of a match had no review
   affordance at all. coach/worker.js already accepts a matchOver view
   (view.lastResult is still the clinching deal's own result: endRound never
   clears declarer/partner/tricks/lastResult, only the *next* deal does), so
   this ports Task 12's #round-body/#round-action split to
   #match-body/#match-action rather than building a second analysis path.
   Same source-as-text approach as every DOM-writing function in this file —
   there is no jsdom here (Task 12's own report confirms it) — so these pin
   the *structure*; the task report documents the real, once-off Chromium
   proof that a live rematch button survives an open review. */
// Slices exactly one top-level function's own body — not "up to the next
// function", which would also sweep in that next function's leading doc
// comment (this file writes one above every function, and those comments
// freely say things like "the rematch button", which a boundary drawn at
// the next `function` keyword would misattribute to the wrong function).
// This file's own convention is reliable instead: every top-level function
// closes with a lone, unindented "}" on its own line — nested blocks never
// are (they read "  });", "  }", etc., never bare) — so that is the anchor.
function sliceFn(src, name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name}(...) not found in modals.js`);
  const m = /\n\}(?=\r?\n|$)/.exec(src.slice(start));
  assert.ok(m, `could not find function ${name}'s own closing brace`);
  return src.slice(start, start + m.index + m[0].length);
}

test("the match-over modal offers a review without displacing rematch", () => {
  const src = fs.readFileSync(path.join(root, "app/js/ui/modals.js"), "utf8");
  const showFn = sliceFn(src, "showMatchOver");
  assert.match(showFn, /review/i, "showMatchOver never mentions a review");
  assert.match(showFn, /id="match-body"/);
  assert.match(showFn, /id="match-action"/);

  // Task 12's own guarantee, ported: the function that paints the review
  // (calls renderReview) and the function that owns the rematch button are
  // different functions, and neither one's source mentions the other's own
  // host/control — no code path in either can reach the other, by
  // construction rather than by discipline (mirrors this file's own header
  // comment on #round-body/#round-action, the pattern this ports).
  const bodyFn = sliceFn(src, "paintMatchBody");
  assert.match(bodyFn, /renderReview\(/);
  // the actual DOM handles, not the English word — a comment explaining *why*
  // the split matters is expected to say "rematch" (this codebase's own
  // style), so the real guarantee is that the body painter never reaches for
  // the rematch button's id or its host, not that it never talks about it
  assert.doesNotMatch(bodyFn, /btn-rematch|match-action/, "the review body painter must never reach the rematch control's id or host");

  const actionFn = sliceFn(src, "matchAction");
  assert.match(actionFn, /btn-rematch/);
  assert.doesNotMatch(actionFn, /renderReview\(|match-body/i, "the action painter must never touch the review body");
});

test("a seatless viewer is not offered a review on the match-over modal", () => {
  const src = fs.readFileSync(path.join(root, "app/js/ui/modals.js"), "utf8");
  const actionFn = sliceFn(src, "matchAction");
  assert.match(actionFn, /view\.you\s*&&\s*view\.you\.seat\s*!=\s*null/,
    "the review toggle must be gated on view.you.seat != null, same as the round-result modal's own spectator gate");
});

test("the match review is requested lazily from the body painter alone", () => {
  const src = fs.readFileSync(path.join(root, "app/js/ui/modals.js"), "utf8");
  const bodyFn = sliceFn(src, "paintMatchBody");
  assert.match(bodyFn, /requestReview\(/);
  assert.match(bodyFn, /REVIEW_WAIT/, "a working state must show while the search runs");
  // showMatchOver's own body must never call requestReview directly — every
  // render would otherwise re-fire the search instead of waiting for the
  // toggle's first click (ambiguity #4: on demand, not automatic — same rule
  // showRoundResult's own paintRoundBody comment states).
  const showFn = sliceFn(src, "showMatchOver");
  assert.doesNotMatch(showFn, /requestReview\(/);
});

/* Fix round I4: the review's own two guards above ("...offers a review
   without displacing rematch" and "...is requested lazily...") were never
   ported to the report card's own pane when it was added — paintMatchReport
   is a separate top-level function neither guard's sliceFn call ever
   touched, so the same D37/D45 structural guarantee held for it only by
   discipline, not by construction. Same two properties, same technique,
   this time against paintMatchReport/matchAction. */
test("the match-over modal offers a report card without displacing rematch", () => {
  const src = fs.readFileSync(path.join(root, "app/js/ui/modals.js"), "utf8");
  const reportFn = sliceFn(src, "paintMatchReport");
  assert.match(reportFn, /renderReport\(/);
  assert.doesNotMatch(reportFn, /btn-rematch|match-action/,
    "the report body painter must never reach the rematch control's id or host");

  const actionFn = sliceFn(src, "matchAction");
  assert.match(actionFn, /btn-rematch/);
  assert.doesNotMatch(actionFn, /renderReport\(/, "the action painter must never touch the report body directly");
});

test("the match report is requested lazily from the body painter alone", () => {
  const src = fs.readFileSync(path.join(root, "app/js/ui/modals.js"), "utf8");
  const reportFn = sliceFn(src, "paintMatchReport");
  assert.match(reportFn, /requestReport\(/);
  assert.match(reportFn, /REVIEW_WAIT/, "a working state must show while the search runs");
  // showMatchOver's own body must never call requestReport directly, for the
  // same reason it must never call requestReview directly (see the review's
  // own identical test above) — every render would otherwise re-fire the
  // search instead of waiting for the toggle's first click.
  const showFn = sliceFn(src, "showMatchOver");
  assert.doesNotMatch(showFn, /requestReport\(/);
});
