/* Every module that renders reads this object and several write it. ESM `let`
   exports are read-only for importers, so the shared state has to be a single
   mutable object rather than a set of exported bindings. */
export const S = {
  ws: null, view: null, myPid: null, mySeat: null, roomCode: null,
  humanBidValue: null, bidCtxKey: null, reconnectTimer: null, wantConnected: false,
  autoStartSolo: false, startingSolo: false, // one-click "Play vs 3 Bots"
  serverSkew: 0,   // Date.now() - server now; keeps deadlines honest across clock drift
  creating: false, createPrivate: false, createTries: 0, myName: "",
};

/* Codes are minted client-side because the Durable Object is routed by the code
   before the socket opens. 4 chars for a shareable room, 8 for a private one. */
const mintCode = (len) => { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < (len || 4); i++) s += A[Math.floor(Math.random() * A.length)]; return s; };

/* Stable per-browser id for optional stats — random, no account, never leaves as PII. */
function myUid() {
  try {
    let u = localStorage.getItem("trump_uid");
    if (!u) { u = mintCode(8).toLowerCase() + Date.now().toString(36); localStorage.setItem("trump_uid", u); }
    return u;
  } catch { return null; }
}

/* Hard reset back to the join screen: forget this room's session token and
   reload, so no state from the old table survives. */
function leaveRoom(reason) {
  S.wantConnected = false;
  try {
    if (S.roomCode) { localStorage.removeItem("trump_pid_" + S.roomCode); localStorage.removeItem("trump_pid_" + S.roomCode + "_t"); }
    if (reason) sessionStorage.setItem("trump_notice", reason);
  } catch {}
  if (S.ws) { S.ws.onclose = null; try { S.ws.close(); } catch {} }
  location.href = location.pathname;
}

/* A notice left by leaveRoom() survives the reload it triggers (e.g. "the host
   removed you") — read once at boot and cleared immediately after. */
function takeNotice() {
  try {
    const n = sessionStorage.getItem("trump_notice");
    if (n) sessionStorage.removeItem("trump_notice");
    return n;
  } catch { return null; }
}

export { myUid, mintCode, leaveRoom, takeNotice };
