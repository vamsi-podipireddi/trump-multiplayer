import { S, myUid, mintCode, leaveRoom } from "./session.js";
import { $, toast } from "./util/dom.js";

/* render() (screens/game.js) and showEmote() (ui/chat.js) are both real
   modules now, but net.js still can't import either directly without becoming
   part of a cycle. showEmote() is the simpler case: ui/chat.js imports send()
   from here directly, so the reverse import would be net.js -> ui/chat.js ->
   net.js. render()'s case is the same shape reached a longer way: game.js's
   renderGame()/render() call into ui/actionbar.js, ui/hand.js, ui/layout.js,
   screens/lobby.js and ui/modals.js, every one of which imports send() or
   serverNow() from here, so net.js -> screens/game.js -> any of those ->
   net.js. Either way, net.js cannot reach these without the page registering
   them. main.js registers the real functions once at boot; until then these
   are no-ops, so a message arriving before that registration is inert, not a
   crash. */
let onView = () => {};
function setViewHandler(fn) { onView = fn; }
let onEmote = () => {};
function setEmoteHandler(fn) { onEmote = fn; }

// ---------- networking ----------
// Production "Pages + separate Worker" split: set WS_BASE to the Worker's URL,
// e.g. "wss://trump-multiplayer.<your-subdomain>.workers.dev".
// Leave "" for same-origin (single Worker w/ static assets, or local `node server.js`).
const WS_BASE = "";
function connect(name, code) {
  S.wantConnected = true;
  S.myName = name;
  if (!code) code = mintCode(S.createPrivate ? 8 : 4);
  S.roomCode = code;
  const base = WS_BASE || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  S.ws = new WebSocket(`${base}/ws?room=${encodeURIComponent(code)}`);
  S.ws.onopen = () => {
    $("conn").classList.remove("show");
    reconnectDelay = RECONNECT_MIN; // a good connection resets the backoff
    let pid = null; // only auto-resume a recent session token (avoids hijacking a stale one on a shared device)
    const t = +localStorage.getItem("trump_pid_" + code + "_t") || 0; if (Date.now() - t < 3 * 3600 * 1000) pid = localStorage.getItem("trump_pid_" + code);
    S.ws.send(JSON.stringify({ type: "join", room: code, name, playerId: pid || null, uid: myUid(), create: S.creating, private: S.createPrivate }));
  };
  S.ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
  S.ws.onclose = () => { if (S.wantConnected) { $("conn").classList.add("show"); scheduleReconnect(name); } };
  S.ws.onerror = () => {};
}
/* Exponential backoff with jitter: a server that is down (or restarting, and
   about to get every client back at once) shouldn't be hammered every 1.5s. */
const RECONNECT_MIN = 800, RECONNECT_MAX = 20000;
let reconnectDelay = RECONNECT_MIN;
function scheduleReconnect(name) {
  if (S.reconnectTimer) return;
  const wait = Math.round(reconnectDelay * (0.7 + Math.random() * 0.6));
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  S.reconnectTimer = setTimeout(() => { S.reconnectTimer = null; if (S.wantConnected) connect(name, S.roomCode); }, wait);
}
function onMsg(m) {
  if (m.type === "joined") {
    S.myPid = m.playerId; S.roomCode = m.room;
    S.creating = false; S.createTries = 0;   // a later reconnect must not re-assert "create"
    localStorage.setItem("trump_pid_" + m.room, m.playerId);
    localStorage.setItem("trump_pid_" + m.room + "_t", String(Date.now()));
    localStorage.setItem("trump_name", $("join-name").value.trim());
    history.replaceState(null, "", "?room=" + m.room);
  } else if (m.type === "state") {
    S.view = m.view; S.mySeat = S.view.you.seat;
    if (typeof S.view.now === "number") S.serverSkew = Date.now() - S.view.now;
    if (S.autoStartSolo && !S.view.room.started && S.view.room.isHost) { S.autoStartSolo = false; send({ type: "start" }); }
    onView();
  } else if (m.type === "emote") {
    onEmote(m.seat, m.e);
  } else if (m.type === "error") {
    // a freshly minted code collided with a live room — mint another and try again
    if (m.code === "code-taken" && S.creating && S.createTries < 6) {
      S.createTries++;
      const dead = S.ws;
      if (dead) { dead.onclose = null; dead.onerror = null; dead.onmessage = null; try { dead.close(); } catch {} }
      S.ws = null; S.roomCode = null;
      connect(S.myName, "");
      return;
    }
    // the host removed us: stop reconnecting, drop the session, back to the join screen
    if (m.code === "kicked") { leaveRoom(m.message); return; }
    toast(m.message);
  }
}
const serverNow = () => Date.now() - S.serverSkew;
const send = o => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };

export { WS_BASE, connect, scheduleReconnect, onMsg, serverNow, send, setViewHandler, setEmoteHandler };
