import { WebSocketServer } from "ws";
import * as R from "../core/room/index.js";
import { ALLOW_ORIGIN, clientIp, MAX_SOCKETS_PER_IP, JOIN_GRACE_MS, MSG_RATE } from "./config.js";
import { rooms, getOrCreateRoom, send, applyFx, armTimer } from "./registry.js";

// ============================================================
//  WebSocket lifecycle
// ============================================================
function attachSockets(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });
  const ipCount = new Map();

  wss.on("connection", (ws, req) => {
    // same-origin check: browsers send Origin; non-browser clients (no header) pass
    const origin = req.headers.origin;
    if (origin) {
      let host = null; try { host = new URL(origin).host; } catch {}
      if (host !== req.headers.host && !ALLOW_ORIGIN.includes(origin)) {
        ws.close(1008, "bad origin"); return;
      }
    }
    const ip = clientIp(req);
    const n = (ipCount.get(ip) || 0) + 1;
    if (n > MAX_SOCKETS_PER_IP) { ws.close(1008, "too many connections"); return; }
    ipCount.set(ip, n);
    ws._ip = ip;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    // sockets that never join get dropped
    ws._joinGrace = setTimeout(() => { if (!ws._pid) ws.terminate(); }, JOIN_GRACE_MS);

    ws.on("message", (data) => {
      const now = Date.now();
      if (!ws._rl || now - ws._rl.ts > 1000) ws._rl = { ts: now, n: 0 };
      if (++ws._rl.n > MSG_RATE) return; // drop floods
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      try { handleMessage(ws, msg); } catch (e) { send(ws, { type: "error", message: "server error" }); }
    });
    ws.on("close", () => handleClose(ws));
  });

  /* Release whatever room/player this socket is currently bound to. A socket that
     joins twice would otherwise strand its previous identity: nothing maps to that
     pid any more, but the room still counts it as connected — so the seat stays
     claimed and the empty-room expiry never arms. One socket could then hold every
     seat in a room, or pin MAX_ROOMS rooms open until restart. */
  function detach(ws, immediate) {
    const entry = ws._code != null ? rooms.get(ws._code) : null;
    const pid = ws._pid;
    ws._pid = null; ws._code = null;
    if (!entry || !pid) return;
    if (entry.socks.get(pid) !== ws) return; // a newer socket owns this player
    entry.socks.delete(pid);
    if (entry.socks.size === 0) entry.emptiedAt = Date.now(); // reclaim order at the room cap
    applyFx(entry, R.disconnect(entry.state, pid, Date.now(), { immediate }));
    armTimer(entry);
  }

  function handleMessage(ws, msg) {
    if (!msg || typeof msg.type !== "string") return;
    const now = Date.now();
    if (msg.type === "join") {
      if (ws._pid) detach(ws, true); // this socket is switching identity, not reconnecting
      const entry = getOrCreateRoom(msg.room, !!msg.private);
      if (!entry) { send(ws, { type: "error", message: "server is busy (too many rooms)" }); return; }
      const { pid, resumed, fx } = R.join(entry.state, msg, now);
      if (pid == null) { applyFx(entry, fx, ws); return; }
      if (resumed) {
        const old = entry.socks.get(pid);
        if (old && old !== ws) { old._pid = null; old._code = null; try { old.terminate(); } catch {} }
      }
      entry.socks.set(pid, ws);
      ws._pid = pid; ws._code = entry.state.code;
      if (ws._joinGrace) { clearTimeout(ws._joinGrace); ws._joinGrace = null; }
      applyFx(entry, fx, ws);
      armTimer(entry);
      return;
    }
    const entry = ws._code != null ? rooms.get(ws._code) : null;
    if (!entry || !ws._pid) return;
    const fx = R.message(entry.state, ws._pid, msg, now);
    applyFx(entry, fx, ws);
    armTimer(entry);
  }

  function handleClose(ws) {
    if (ws._joinGrace) { clearTimeout(ws._joinGrace); ws._joinGrace = null; }
    if (ws._ip) {
      const n = (ipCount.get(ws._ip) || 1) - 1;
      if (n <= 0) ipCount.delete(ws._ip); else ipCount.set(ws._ip, n);
    }
    detach(ws, false); // a real drop: seats keep their reconnect grace
  }

  // keep-alive ping (drop dead sockets); unref'd so it never holds a test process open
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false; try { ws.ping(); } catch {}
    });
  }, 30000).unref();

  return wss;
}

export { attachSockets };
