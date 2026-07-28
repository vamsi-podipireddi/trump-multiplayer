import { S } from "../session.js";
import { $, esc } from "../util/dom.js";
import { icon } from "../cards/icons.js";
import { send } from "../net.js";
import { renderSettings } from "../screens/lobby.js";

/* showHelp() and showSettingsModal() close by calling back into render(),
   which now lives in screens/game.js. It still needs the same registration
   seam net.js uses (see net.js): game.js already imports showMatchOver/
   hideOverlay/showSettingsModal from this file (render() and renderScoreboard()
   both call into ui/modals.js), so importing render() back here would make the
   two files import each other. main.js registers the real render() once at
   boot; until then this is a safe no-op.
   renderSettings() (screens/lobby.js) needs no such seam and is imported
   directly above: lobby.js never imports this file, or anything that does, so
   there is no cycle to close. */
let onRender = () => {};
function setRenderHandler(fn) { onRender = fn; }

function setModal(kind, html) { $("modal").innerHTML = html; $("overlay").dataset.kind = kind; $("overlay").classList.add("show"); }
function hideOverlay() { $("overlay").classList.remove("show"); $("overlay").dataset.kind = ""; }

// ---------- modals ----------
function showMatchOver() {
  const max = Math.max(...S.view.scores);
  const champs = [0,1,2,3].filter(p => S.view.scores[p] === max);
  const youWon = S.mySeat != null && champs.includes(S.mySeat);
  const standings = [0,1,2,3].slice().sort((a,b)=>S.view.scores[b]-S.view.scores[a]).map(p =>
    `<div class="${S.mySeat!=null&&p===S.mySeat?"me":""}"><span>${esc(S.view.names[p])}${S.mySeat!=null&&p===S.mySeat?" (you)":""}</span>` +
    `<span>${S.view.scores[p]} deal${S.view.scores[p]===1?"":"s"}</span></div>`).join("");
  let btn = S.view.room.isHost ? `<button id="btn-rematch">Start a new match</button>` : `<p class="muted">Waiting for ${esc(S.view.room.hostName||"host")} to start a new match…</p>`;
  setModal("match",
    `<h2>Match over</h2><p class="big">${youWon ? icon("cup") + "You win the match" : esc(champs.map(p=>S.view.names[p]).join(" & ")) + " win the match"}</p>` +
    `<p>First to ${S.view.consts.TARGET_GAMES} deals.</p><div class="standings">${standings}</div>${btn}`);
  if (S.view.room.isHost) $("btn-rematch").onclick = () => send({ type: "newMatch" });
}
function showHelp() {
  const c = (S.view && S.view.consts) || { TOTAL_POINTS:250, MIN_BID:130, BID_STEP:5, TARGET_GAMES:5 };
  setModal("help",
    `<h2>How to Play TRUMP</h2><ul class="how">` +
    `<li>4 seats; you take an open one and any empty seats are AI. The deck holds <b>${c.TOTAL_POINTS} points</b>: A/K/Q/J/10 = 10 each, every 5 = 5, one random suit's <b>3 = 30</b> (announced before bidding).</li>` +
    `<li><b>Bid</b> the points your side will capture (min ${c.MIN_BID}, steps of ${c.BID_STEP}) or pass; highest bidder wins.</li>` +
    `<li>The bid winner picks <b>trump</b> and <b>calls a card they don't hold</b> — its holder is their partner (teams shown at once: gold = bidding side, blue = defenders).</li>` +
    `<li>The bid winner leads. Follow suit if you can; highest trump wins a trick, else the highest card of the led suit; the winner captures its point-cards and leads next.</li>` +
    `<li>Make the bid → bidding side wins the deal; fall short → defenders win it. First to <b>${c.TARGET_GAMES} deals</b> wins the match.</li>` +
    `</ul><button id="btn-close">Got it</button>`);
  $("btn-close").onclick = () => { hideOverlay(); onRender(); };
}
function showSettingsModal() {
  setModal("settings", `<h2>Table Settings</h2><div id="modal-settings" style="text-align:left;"></div><button id="btn-close-set">Done</button>`);
  renderSettings($("modal-settings"), !!S.view.room.isHost);
  $("btn-close-set").onclick = () => { hideOverlay(); onRender(); };
}

export { setModal, hideOverlay, showMatchOver, showHelp, showSettingsModal, setRenderHandler };
