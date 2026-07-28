import { S, myUid, takeNotice } from "../session.js";
import { $ } from "../util/dom.js";
import { WS_BASE, connect } from "../net.js";

// ---------- join UI ----------
function doJoin(create) {
  const name = $("join-name").value.trim();
  if (!name) { $("join-err").textContent = "Enter a name."; return; }
  const code = create ? "" : $("join-code").value.trim().toUpperCase();
  if (!create && !code) { $("join-err").textContent = "Enter a room code, or use Create New Room."; return; }
  S.creating = !!create; S.createPrivate = create && $("join-private").checked; S.createTries = 0;
  S.roomCode = code || null;
  connect(name, code);
}
function doSolo() {
  const name = $("join-name").value.trim();
  if (!name) { $("join-err").textContent = "Enter a name."; return; }
  S.autoStartSolo = true; S.startingSolo = true; S.roomCode = null;
  S.creating = true; S.createPrivate = false; S.createTries = 0;
  connect(name, ""); // create a fresh room, then auto-start with 3 bots
}
/* Optional: the Cloudflare backend reports a lifetime record when a D1 binding
   exists. Any failure (node backend, no DB, offline) just leaves the line off. */
async function loadStats() {
  const uid = myUid(); if (!uid) return;
  const base = WS_BASE ? WS_BASE.replace(/^ws/, "http") : "";
  try {
    const r = await fetch(`${base}/stats?uid=${encodeURIComponent(uid)}`);
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !j.available || !j.games) return;
    $("join-record").innerHTML = `Your record: <b>${j.games}</b> match${j.games === 1 ? "" : "es"} · ` +
      `<b>${j.wins}</b> won · bids taken <b>${j.bidsWon}</b>, made <b>${j.bidsMade}</b>`;
  } catch {}
}
/* A notice left by leaveRoom() (e.g. "the host removed you") survives the
   reload it triggers — shown once at boot. */
function showNotice() {
  const notice = takeNotice();
  if (notice) $("join-err").textContent = notice;
}

export { doJoin, doSolo, loadStats, showNotice };
