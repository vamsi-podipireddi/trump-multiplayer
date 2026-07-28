/* ============================================================
   node adapter (server.js) over real sockets.

   The room core is exercised in room.test.js; what is only testable here is
   the socket<->player bookkeeping the adapter owns. That bookkeeping is where
   a socket could strand identities by joining repeatedly — the core never saw
   it, because from its side each join looked like a different player arriving.
   ============================================================ */
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

/* Static imports are hoisted — every imported module fully evaluates before
   this file's own top-level statements run, no matter where the `import`
   sits textually. That would read MAX_ROOMS before it is set below. A dynamic
   import() runs exactly where it is written, so it still executes after the
   env var — the same ordering CommonJS's synchronous loading used to give us. */
process.env.MAX_ROOMS = "3"; // set before importing: makes the room cap reachable in a test
const { httpServer, rooms } = await import("../server.js");

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

test("static serving refuses to walk out of app/", async () => {
  const url = (await listening()).replace("ws://", "http://");
  for (const bad of ["/../server.js", "/..%2fserver.js", "/%2e%2e/src/core/room/view.js", "//etc/passwd"]) {
    const res = await fetch(url + bad);
    assert.ok(res.status === 403 || res.status === 404, `${bad} must not be served (got ${res.status})`);
    const body = await res.text();
    /* Post-ESM, "require(" appears nowhere in the repo any more, so it quit
       being a canary at all — this assertion would pass no matter what
       leaked. Neither replacement is generic: "new WebSocketServer(" only
       appears in server.js (the browser client uses the native WebSocket,
       never the ws package), and the "../../../app/js/core/engine/index.js"
       import line appears throughout src/core/room/ (server-only code,
       including view.js — the file the traversal above targets) and nowhere
       under app/. Two canaries, not one, because traversal above targets both
       server.js and view.js, and each one's import line is distinct — a
       single string shared by both would have to be vaguer, and vaguer is
       how you end up matching an innocuous asset instead. */
    assert.ok(!body.includes("new WebSocketServer(") && !body.includes('import * as E from "../../../app/js/core/engine/index.js"'),
      `${bad} leaked source`);
  }
  const ok = await fetch(url + "/");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /text\/html/);
});

test.after(() => {
  for (const ws of sockets) { try { ws.terminate(); } catch {} }
  for (const [, e] of rooms) if (e.timer) clearTimeout(e.timer);
  httpServer.closeAllConnections();
  httpServer.close();
});
