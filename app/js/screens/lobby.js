import { S } from "../session.js";
import { $, esc, avatarHtml } from "../util/dom.js";
import { icon } from "../cards/icons.js";
import { send } from "../net.js";

const DIFF_OPTS = [["easy","Easy"],["normal","Normal"],["hard","Hard"]];
const DEAL_OPTS = [3,5,7];
const TIMER_OPTS = [0,15,30,45,60,90];

// ---------- lobby ----------
function renderLobby() {
  $("lobby-code").textContent = S.view.room.code;
  const list = $("lobby-seats"); list.innerHTML = "";
  const isHost = S.view.room.isHost;
  S.view.seats.forEach(s => {
    const row = document.createElement("div");
    row.className = "seatrow" + (s.you ? " you" : "");
    const host = S.view.room.hostSeat === s.seat ? ` <span class="pill ai">Host</span>` : "";
    const pill = s.isHuman
      ? `<span class="pill ${s.connected ? "on" : "off"}">${s.you ? "You" : (s.connected ? "Here" : "Away")}</span>`
      : `<span class="pill open">Open</span>`;
    row.innerHTML = `${avatarHtml(s.name, !s.isHuman)}<span class="tag">${s.label}</span><span class="who">${s.name ? esc(s.name) : "Empty"}</span>${host}<span class="spacer"></span>${pill}`;
    if (s.you) row.appendChild(miniBtn("Stand up", "", () => send({ type: "stand" }), "stand"));
    else if (!s.isHuman) row.appendChild(miniBtn("Sit here", "", () => send({ type: "sit", seat: s.seat })));
    else if (isHost) row.appendChild(miniBtn("Remove", "danger", () => { if (confirm(`Remove ${s.name} from the table?`)) send({ type: "kick", seat: s.seat }); }, "exit"));
    list.appendChild(row);
  });
  renderSettings($("lobby-settings"), isHost);

  const ctrl = $("lobby-controls"); ctrl.innerHTML = "";
  if (S.view.you.spectator) {
    const p = document.createElement("p"); p.className = "muted";
    p.textContent = "You're spectating — take any open seat above to play.";
    ctrl.appendChild(p);
  }
  if (isHost) {
    // the note below the button already explains what happens to empty seats
    const b = document.createElement("button"); b.className = "btn"; b.style.width = "100%"; b.textContent = "Start the match";
    b.onclick = () => send({ type: "start" }); ctrl.appendChild(b);
  } else {
    const p = document.createElement("p"); p.className = "muted"; p.style.textAlign = "center";
    p.innerHTML = `Waiting for <b>${esc(S.view.room.hostName || "host")}</b> to start…`;
    ctrl.appendChild(p);
  }
  const spec = S.view.room.spectators;
  $("lobby-note").textContent = `${S.view.room.humans} seated${spec ? `, ${spec} spectating` : ""}. Empty seats become AI when the game starts.`;
}
function miniBtn(label, cls, fn, ic) {
  const b = document.createElement("button");
  b.className = "mini-btn " + (cls || "");
  b.innerHTML = (ic ? icon(ic) : "") + `<span>${esc(label)}</span>`;
  b.onclick = fn;
  return b;
}
/* Settings are host-driven; everyone else sees the same rows, read-only. */
function renderSettings(host_el, isHost) {
  const st = S.view.settings || {}; host_el.innerHTML = "";
  const seg = (label, opts, cur, key, live) => {
    const row = document.createElement("div"); row.className = "setrow";
    const l = document.createElement("span"); l.className = "lbl"; l.textContent = label; row.appendChild(l);
    const editable = isHost && (live || !S.view.room.started);
    opts.forEach(([val, text]) => {
      const b = document.createElement("button");
      b.className = "segbtn"; b.type = "button"; b.textContent = text;
      b.setAttribute("aria-pressed", String(val === cur));
      if (editable) b.onclick = () => send({ type: "settings", [key]: val });
      else b.disabled = true;
      row.appendChild(b);
    });
    host_el.appendChild(row);
  };
  seg("AI SKILL", DIFF_OPTS, st.difficulty, "difficulty", true); // difficulty may change mid-match
  seg("DEALS TO WIN", DEAL_OPTS.map(n => [n, String(n)]), st.targetDeals, "targetDeals", false);
  seg("TURN TIMER", TIMER_OPTS.map(n => [n, n === 0 ? "Off" : n + "s"]), st.turnTimerSec, "turnTimerSec", true);
}

export { renderLobby, renderSettings, miniBtn, DIFF_OPTS, DEAL_OPTS, TIMER_OPTS };
