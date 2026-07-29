import { S } from "../session.js";
import { $, esc } from "../util/dom.js";
import { send, serverNow } from "../net.js";
import { renderTable } from "../ui/table.js";
import { renderContract, renderScoreboard, renderTricks } from "../ui/rails.js";
import { renderHand } from "../ui/hand.js";
import { renderActionBar, phaseLabel } from "../ui/actionbar.js";
import { renderLog } from "../ui/log.js";
import { renderChat, closeSheet } from "../ui/chat.js";
import { hideOverlay, showMatchOver, showRoundResult, maybeShowReveal, hideReveal } from "../ui/modals.js";
import { fitTable, tickTimers } from "../ui/layout.js";
import { renderLobby, renderSettings, showSettingsModal, DIFF_OPTS } from "./lobby.js";

// ---------- orientation ----------
const orient = () => (S.mySeat == null ? 0 : S.mySeat);
const seatAtPos = pos => (orient() + pos) % 4;
const posOfSeat = seat => (seat - orient() + 4) % 4;
const POS_CLASS = ["south","west","north","east"]; // pos 0..3 relative to viewer

/* Every action the table can take, in one object handed to whichever renderer
   owns the control. The renderers themselves no longer import net.js — that is
   what lets solo.js drive the identical table with its own handlers. */
const HANDLERS = {
  bid: value => send({ type: "bid", value }),
  pass: () => send({ type: "bid", value: null }),
  trump: suit => send({ type: "trump", suit }),
  call: card => send({ type: "call", card: { suit: card.suit, rank: card.rank } }),
  play: card => send({ type: "play", card }),
  ready: () => send({ type: "ready" }),
};

// ---------- top-level render ----------
function render() {
  if (!S.view) return;
  if (!S.view.room.started && S.startingSolo) { $("join-err").textContent = "Dealing…"; return; } // skip the lobby for solo
  if (S.view.room.started) S.startingSolo = false;
  if (!S.view.room.started) { $("join-screen").classList.remove("show"); $("lobby-screen").classList.add("show"); $("game").style.display = "none"; renderLobby(); }
  else { $("join-screen").classList.remove("show"); $("lobby-screen").classList.remove("show"); $("game").style.display = "grid"; renderGame(); }
  document.body.classList.toggle("in-game", !!S.view.room.started);
  if (!S.view.room.started) { closeSheet(); hideReveal(); }
  $("awaybar").classList.toggle("show", !!(S.view.room.started && S.view.you.away));
  $("btn-stand").style.display = S.view.room.started && !S.view.you.spectator ? "" : "none";

  /* One owner for the overlay, so a modal that is still relevant is never
     yanked out from under a click. Settings and Help are user-opened and
     survive every state message; the deal result and the match result are
     state-driven and replace each other. */
  const ok = $("overlay").dataset.kind;
  if (ok === "settings" && $("modal-settings")) renderSettings($("modal-settings"), !!S.view.room.isHost); // keep open, refresh pressed states
  else if (ok === "help") { /* the reader closes it */ }
  else if (S.view.phase === "matchOver") { if (ok !== "match") showMatchOver(S.view, () => send({ type: "newMatch" })); }
  else if (S.view.phase === "roundEnd" && S.view.lastResult) showRoundResult(S.view, tableCtx(), HANDLERS);
  else hideOverlay();
}

// ---------- game board ----------
function sideOf(seat) { return (seat === S.view.declarer || seat === S.view.partner) ? "D" : "O"; }
function activeSeat() {
  if (S.view.phase === "playing") return S.view.turn;
  if (S.view.phase === "bidding") return S.view.bidTurn;
  if (S.view.phase === "trumpSelect" || S.view.phase === "partnerSelect") return S.view.declarer;
  return -1;
}
function roleOf(seat) {
  if (!S.view.teamsRevealed) {
    if (S.view.phase === "bidding" && S.view.bidActive.includes(seat)) return seat === S.view.highBidder ? { c:"high", t:"high bid" } : null;
    if (seat === S.view.highBidder) return { c:"high", t:"high bid" };
    // a folded seat used to return null and render blank — identical to one yet to act
    if (S.view.phase === "bidding") return { c:"passed", t:"passed" };
    return null;
  }
  if (seat === S.view.declarer) return { c:"bidder", t:"BIDDER" };
  if (seat === S.view.partner) return { c:"partner", t:"PARTNER" };
  return { c:"def", t:"DEFENDER" };
}
/* The one object every shared renderer takes. It is rebuilt each frame rather
   than cached because all of it is a pure function of S.view, and a stale
   mySeat after a seat change is a whole table rotated the wrong way. */
function tableCtx() {
  return {
    mySeat: S.mySeat,
    posOf: posOfSeat,
    seatInfo: seat => {
      const info = S.view.seats[seat];
      return {
        name: S.view.names[seat] || info.name || info.label,
        isAI: !info.isHuman, connected: info.connected, away: info.away,
      };
    },
    activeSeat: activeSeat(),
    role: roleOf,
    /* null, not "O", until the teams are actually known: sideOf() answers
       "everyone defends" while declarer is still null, and a rail that paints
       that is claiming a fact the auction has not established yet. */
    sideOf: seat => (S.view.teamsRevealed ? sideOf(seat) : null),
    thinking: null,                      // the server never says a bot is "thinking"; solo does
    target: S.view.consts.TARGET_GAMES,
    /* The rails render in both pages, and solo has no room settings at all, so
       the chips arrive as text rather than as a second import of the session. */
    settingsHtml: settingsChips(),
    onSettings: S.view.room.isHost ? showSettingsModal : null,
  };
}
function settingsChips() {
  const st = S.view.settings || {};
  const diff = (DIFF_OPTS.find(d => d[0] === st.difficulty) || ["", "?"])[1];
  return `<span class="chip">AI <b>${esc(diff)}</b></span>` +
         `<span class="chip">Timer <b>${st.turnTimerSec ? st.turnTimerSec + "s" : "off"}</b></span>`;
}
function renderGame() {
  const ph = phaseLabel(S.view.phase);
  $("header-state").innerHTML = `Deal <b>${S.view.roundNumber}</b> · first to <b>${S.view.consts.TARGET_GAMES}</b>${ph ? " · " + esc(ph) : ""}`;

  const ctx = tableCtx();
  renderTable(S.view, ctx);
  renderContract(S.view, ctx);
  renderScoreboard(S.view, ctx);
  renderTricks(S.view, ctx);
  renderHand(S.view, HANDLERS.play);
  renderActionBar(S.view, HANDLERS);
  /* after the action bar, never before: the tray is what --tray-lift is measured
     from and the felt is sized by what is left over, so measuring first reads the
     *previous* phase's layout — which is how your own plate ended up under it. */
  fitTable();
  renderLog(S.view);
  renderChat(S.view, S.mySeat, e => send({ type: "emote", e }));
  tickTimers(S.view, serverNow());
  maybeShowReveal(S.view, ctx);
}

export { render, renderGame, sideOf, activeSeat, roleOf, orient, seatAtPos, posOfSeat, POS_CLASS, tableCtx, HANDLERS };
