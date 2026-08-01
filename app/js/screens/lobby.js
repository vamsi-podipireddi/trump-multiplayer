import { S, leaveRoom } from "../session.js";
import { $, esc, avatarHtml } from "../util/dom.js";
import { icon } from "../cards/icons.js";
import { send } from "../net.js";
import { setModal, hideOverlay, onRender } from "../ui/modals.js";
import { coachOn } from "../coach/read.js";

const DIFF_OPTS = [["easy","Easy"],["normal","Normal"],["hard","Hard"]];
const DEAL_OPTS = [3,5,7];
const TIMER_OPTS = [0,15,30,45,60,90];
const COACH_OPTS = [[true,"On"],[false,"Off"]];

// ---------- lobby ----------
/* Reads the session directly, unlike the renderers under ui/: a lobby is a room
   and solo has no room, so there is no second caller to parameterise for. */
function renderLobby() {
  const view = S.view;
  $("lobby-code").textContent = view.room.code;
  // assigned, not addEventListener: this runs on every view push and listeners would stack
  $("btn-lobby-leave").onclick = () => leaveRoom("");

  const list = $("lobby-seats"); list.innerHTML = "";
  const isHost = !!view.room.isHost;
  view.seats.forEach(s => {
    const row = document.createElement("div");
    row.className = "seatrow" + (s.you ? " you" : "");
    // the dot is the glance; the pill beside it is the same fact in words, which
    // is the one a screen reader gets
    const dot = `<span class="${s.isHuman ? (s.connected ? "dot on" : "dot off") : "dot"}" aria-hidden="true"></span>`;
    const host = view.room.hostSeat === s.seat ? `<span class="pill ai">Host</span>` : "";
    const pill = s.isHuman
      ? `<span class="pill ${s.connected ? "on" : "off"}">${s.you ? "You" : (s.connected ? "Here" : "Away")}</span>`
      : `<span class="pill open">Open</span>`;
    row.innerHTML = avatarHtml(s.name, !s.isHuman) + dot +
      `<span class="tag">${esc(s.label)}</span><span class="who">${s.name ? esc(s.name) : "Empty"}</span>` +
      host + `<span class="spacer"></span>` + pill;
    if (s.you) row.appendChild(miniBtn("Stand up", "", () => send({ type: "stand" }), "stand"));
    else if (!s.isHuman) row.appendChild(miniBtn("Sit here", "", () => send({ type: "sit", seat: s.seat })));
    else if (isHost) row.appendChild(miniBtn("Remove", "danger", () => { if (confirm(`Remove ${s.name} from the table?`)) send({ type: "kick", seat: s.seat }); }, "exit"));
    list.appendChild(row);
  });
  renderSettings($("lobby-settings"), isHost);

  const ctrl = $("lobby-controls"); ctrl.innerHTML = "";
  if (view.you.spectator) {
    const p = document.createElement("p"); p.className = "muted centred";
    p.textContent = "You're spectating — take any open seat above to play.";
    ctrl.appendChild(p);
  }
  if (isHost) {
    // .btn is already full width; the note below the button explains the empty seats
    const b = document.createElement("button"); b.className = "btn"; b.textContent = "Start the match";
    b.onclick = () => send({ type: "start" }); ctrl.appendChild(b);
  } else {
    const p = document.createElement("p"); p.className = "muted centred";
    p.innerHTML = `Waiting for <b>${esc(view.room.hostName || "host")}</b> to start…`;
    ctrl.appendChild(p);
  }
  const spec = view.room.spectators;
  $("lobby-note").textContent = `${view.room.humans} seated${spec ? `, ${spec} spectating` : ""}. Empty seats become AI when the game starts.`;
}
function miniBtn(label, cls, fn, ic) {
  const b = document.createElement("button");
  b.className = "mini-btn " + (cls || "");
  b.innerHTML = (ic ? icon(ic) : "") + `<span>${esc(label)}</span>`;
  b.onclick = fn;
  return b;
}
/* Settings are host-driven; everyone else sees the same rows, read-only. The
   row spacing comes from .settings, and the settings modal builds its own
   container — so claim the class here rather than depend on the host's markup. */
function renderSettings(host_el, isHost) {
  const st = S.view.settings || {};
  host_el.classList.add("settings"); host_el.innerHTML = "";
  const seg = (label, opts, cur, key, live) => {
    const row = document.createElement("div"); row.className = "setrow";
    const l = document.createElement("span"); l.className = "lbl"; l.textContent = label;
    const box = document.createElement("div"); box.className = "opts";
    const editable = isHost && (live || !S.view.room.started);
    opts.forEach(([val, text]) => {
      const b = document.createElement("button");
      b.className = "segbtn"; b.type = "button"; b.textContent = text;
      b.setAttribute("aria-pressed", String(val === cur));
      if (editable) b.onclick = () => send({ type: "settings", [key]: val });
      else b.disabled = true;
      box.appendChild(b);
    });
    row.appendChild(l); row.appendChild(box);
    host_el.appendChild(row);
  };
  seg("Match length", DEAL_OPTS.map(n => [n, "First to " + n]), st.targetDeals, "targetDeals", false);
  seg("AI skill", DIFF_OPTS, st.difficulty, "difficulty", true); // difficulty may change mid-match
  seg("Turn timer", TIMER_OPTS.map(n => [n, n === 0 ? "Off" : n + "s"]), st.turnTimerSec, "turnTimerSec", true);
  seg("Hints", COACH_OPTS, coachOn(st), "coach", true);
  const note = document.createElement("p"); note.className = "muted";
  note.textContent = "a table agreement — the engine runs in every browser";
  host_el.appendChild(note);
}

/* The same settings rows, opened from the table instead of the lobby. It lives
   here rather than in ui/modals.js because it needs both renderSettings() and
   the session's host flag, and a modal that reads S is one solo would have to
   fork (docs/STRUCTURE.md rule 6); ui/modals.js supplies only the overlay.
   Closing goes through modals.js's own seam rather than a second one of its
   own, so whichever render() the page registered repaints the table — the
   settings chips on the rails are drawn there, not by this modal. */
function showSettingsModal() {
  setModal("settings", `<h2>Table settings</h2><div id="modal-settings"></div><button class="btn ghost" id="btn-close-set">Done</button>`);
  renderSettings($("modal-settings"), !!S.view.room.isHost);
  $("btn-close-set").onclick = () => { hideOverlay(); onRender(); };
}

export { renderLobby, renderSettings, showSettingsModal, miniBtn, DIFF_OPTS, DEAL_OPTS, TIMER_OPTS, COACH_OPTS };
