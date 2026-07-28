/* ============================================================
   node adapter (src/server/) over real sockets.

   The room core is exercised in room.test.js; what is only testable here is
   the socket<->player bookkeeping the adapter owns. That bookkeeping is where
   a socket could strand identities by joining repeatedly — the core never saw
   it, because from its side each join looked like a different player arriving.
   ============================================================ */
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/* Static imports are hoisted — every imported module fully evaluates before
   this file's own top-level statements run, no matter where the `import`
   sits textually. That would read MAX_ROOMS before it is set below. A dynamic
   import() runs exactly where it is written, so it still executes after the
   env var — the same ordering CommonJS's synchronous loading used to give us. */
process.env.MAX_ROOMS = "3"; // set before importing: makes the room cap reachable in a test
const { httpServer, rooms } = await import("../src/server/index.js");

let base = null;
async function listening() {
  if (!base) {
    await new Promise(r => httpServer.listen(0, "127.0.0.1", r));
    base = `ws://127.0.0.1:${httpServer.address().port}`;
  }
  return base;
}

const sockets = []; // every socket is force-closed in test.after, including after a failed assert
async function open() {
  const ws = new WebSocket(await listening() + "/ws");
  sockets.push(ws);
  ws._inbox = [];
  ws.on("message", d => ws._inbox.push(JSON.parse(d)));
  ws.on("error", () => {});
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  return ws;
}
/* Wait until `pick` finds something in the socket's inbox (or give up). */
async function until(ws, pick, tries = 60) {
  for (let i = 0; i < tries; i++) {
    for (let j = ws._inbox.length - 1; j >= 0; j--) { const hit = pick(ws._inbox[j]); if (hit) return hit; }
    await new Promise(r => setTimeout(r, 10));
  }
  return null;
}
const join = (ws, room, name) => ws.send(JSON.stringify({ type: "join", room, name }));
const lastView = ws => until(ws, m => (m.type === "state" ? m.view : null));

test("a socket that joins twice does not strand its first identity", async () => {
  const ws = await open();
  join(ws, "AAAA", "first");
  const a = await until(ws, m => (m.type === "joined" ? m : null));
  assert.ok(a, "first join acknowledged");

  join(ws, "BBBB", "second");
  const b = await until(ws, m => (m.type === "joined" && m.room === "BBBB" ? m : null));
  assert.ok(b, "second join acknowledged");

  const first = rooms.get("AAAA");
  assert.equal(first.socks.size, 0, "no socket still mapped into the abandoned room");
  assert.equal(Object.keys(first.state.players).length, 0, "and no player left behind claiming to be connected");
  assert.deepEqual(first.state.seatOwner, [null, null, null, null], "its seat is free again");
  assert.ok(first.timer, "the emptied room is scheduled to expire");
  ws.close();
});

test("one socket cannot squat every seat in a room", async () => {
  const ws = await open();
  for (let i = 0; i < 8; i++) { join(ws, "CCCC", "squatter" + i); await new Promise(r => setTimeout(r, 15)); }
  const view = await lastView(ws);
  assert.ok(view, "got a state broadcast");
  assert.equal(view.room.humans, 1, "one live socket seats exactly one player");
  assert.equal(view.room.spectators, 0, "and leaves no spectator ghosts");
  assert.equal(Object.keys(rooms.get("CCCC").state.players).length, 1);

  // a real player can still take a seat at that table
  const other = await open();
  join(other, "CCCC", "Real");
  const ack = await until(other, m => (m.type === "joined" ? m : null));
  assert.ok(ack && ack.seat != null, `a genuine player must still get a seat, got ${JSON.stringify(ack)}`);
  ws.close(); other.close();
});

test("closing a socket releases its room, and the room expires when empty", async () => {
  const ws = await open();
  join(ws, "DDDD", "solo");
  assert.ok(await until(ws, m => (m.type === "joined" ? m : null)));
  ws.close();
  const gone = await until(ws, () => (rooms.get("DDDD").socks.size === 0 ? true : null));
  assert.ok(gone, "socket unregistered on close");
  assert.ok(rooms.get("DDDD").timer, "expiry armed for the empty room");
});

test("at the room cap, empty rooms are recycled but occupied ones are not", async () => {
  for (const [code] of rooms) rooms.delete(code);            // start from a clean table (cap is 3 here)
  const live = await open();
  join(live, "KEEP", "Real");
  assert.ok(await until(live, m => (m.type === "joined" ? m : null)), "the occupied room is set up");

  // fill the rest of the cap with rooms nobody is in
  for (const code of ["EMP1", "EMP2"]) {
    const t = await open();
    join(t, code, "passer-by");
    assert.ok(await until(t, m => (m.type === "joined" ? m : null)));
    t.close();
    await until(t, () => (rooms.get(code).socks.size === 0 ? true : null));
  }
  assert.equal(rooms.size, 3, "at the cap");

  // a new player must still get in — an empty room gives way, the live one does not
  const fresh = await open();
  join(fresh, "NEW1", "Latecomer");
  const ack = await until(fresh, m => (m.type === "joined" ? m : null));
  assert.ok(ack, "a real player must not be refused because squatters filled the cap");
  assert.ok(rooms.has("KEEP"), "the room with a live player must never be recycled");
  assert.ok(rooms.has("NEW1"));
  assert.ok(rooms.size <= 3, `cap held, got ${rooms.size}`);
  live.close(); fresh.close();
});

/* fetch()/undici runs every request through the WHATWG URL parser before it
   ever leaves the process, and that parser collapses "/../" dot-segments and
   percent-decodes some paths — so most of the traversal probes below never
   reach the guard at src/server/http.js:27 through fetch() at all (measured
   against a raw echo server: fetch turns "/../src/server/sockets.js" into a
   normalised "GET /src/server/sockets.js" on the wire, and "/%2e%2e/..." the
   same way; only "/..%2fsrc/..." and "//etc/passwd" survive fetch() intact).
   Writing the request line ourselves over a bare socket guarantees the guard
   actually sees the bytes it is supposed to defend against. */
const raw = (port, target) => new Promise(res => {
  const s = net.connect(port, "127.0.0.1", () =>
    s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
  let buf = ""; s.on("data", d => { buf += d; });
  s.on("close", () => res(buf));
  s.on("error", () => res(""));
});
function parseRaw(resp) {
  const sep = resp.indexOf("\r\n\r\n");
  if (sep === -1) return { status: 0, body: "" };
  const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(resp) || [, "0"])[1]);
  return { status, body: resp.slice(sep + 4) };
}

test("static serving refuses to walk out of app/", async () => {
  const port = Number((await listening()).match(/:(\d+)$/)[1]);

  /* A marker read out of the real target file rather than hardcoded, so a
     future refactor that changes src/core/room/'s relative import depth (it
     has moved before) can't silently turn this into a string nothing will
     ever match again — a hardcoded path literal here degraded this exact
     canary to always-true four times, because "the string isn't in the body"
     is indistinguishable from "the guard is doing its job" once the string
     can no longer appear at all. */
  const viewSrc = fs.readFileSync(path.join(ROOT, "src/core/room/view.js"), "utf8");
  const viewCanary = viewSrc.split("\n").find(l => l.includes("core/engine/index.js")).trim();

  // Statuses measured over this same raw transport against the real server —
  // fetch() cannot reproduce these probes faithfully (see the comment on
  // raw() above), so this is the only way to exercise the guard end to end.
  const probes = [
    ["/../src/server/sockets.js", 403],
    ["/..%2fsrc/server/sockets.js", 403],
    ["/%2e%2e/src/core/room/view.js", 404],
    ["//etc/passwd", 404],
  ];
  for (const [bad, want] of probes) {
    const { status, body } = parseRaw(await raw(port, bad));
    assert.equal(status, want, `${bad} must get ${want} over raw HTTP (got ${status})`);
    assert.ok(!body.includes("new WebSocketServer(") && !body.includes(viewCanary), `${bad} leaked source`);
  }

  // Positive control: the same raw transport must still serve a real file.
  // Without this, a harness that silently failed to connect (wrong port, a
  // dropped socket, ...) would return status 0 for every probe above — which
  // is not 200 or 403, so it would *fail* the loop rather than pass it
  // vacuously, except the failure would look like a broken test, not a
  // broken guard. This pins that raw() actually talks to the server.
  const { status: okStatus, body: okBody } = parseRaw(await raw(port, "/index.html"));
  assert.equal(okStatus, 200, "a real file under app/ must be served over the same raw transport");
  assert.match(okBody, /<!doctype html>|<html/i, "expected the app shell's markup, not an empty/failed response");
});

test.after(() => {
  for (const ws of sockets) { try { ws.terminate(); } catch {} }
  for (const [, e] of rooms) if (e.timer) clearTimeout(e.timer);
  httpServer.closeAllConnections();
  httpServer.close();
});
