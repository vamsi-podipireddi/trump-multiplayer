import { S } from "../session.js";
import { $, esc, paintAvatar } from "../util/dom.js";
import { suitSpan, cardSpan } from "../cards/labels.js";
import { cardEl } from "../cards/deck.js";
import { renderLog } from "../ui/log.js";
import { renderChat, closeSheet } from "../ui/chat.js";
import { hideOverlay, showMatchOver, showSettingsModal } from "../ui/modals.js";
import { renderActionBar } from "../ui/actionbar.js";
import { renderHand } from "../ui/hand.js";
import { fitTable, tickTimers, setRingEl } from "../ui/layout.js";
import { renderLobby, renderSettings, miniBtn, DIFF_OPTS } from "./lobby.js";

// ---------- orientation ----------
const orient = () => (S.mySeat == null ? 0 : S.mySeat);
const seatAtPos = pos => (orient() + pos) % 4;
const posOfSeat = seat => (seat - orient() + 4) % 4;
const POS_CLASS = ["south","west","north","east"]; // pos 0..3 relative to viewer

// ---------- top-level render ----------
function render() {
  if (!S.view) return;
  if (!S.view.room.started && S.startingSolo) { $("join-err").textContent = "Dealing…"; return; } // skip the lobby for solo
  if (S.view.room.started) S.startingSolo = false;
  if (!S.view.room.started) { $("join-screen").classList.remove("show"); $("lobby-screen").classList.add("show"); $("game").style.display = "none"; renderLobby(); }
  else { $("join-screen").classList.remove("show"); $("lobby-screen").classList.remove("show"); $("game").style.display = "grid"; renderGame(); }
  document.body.classList.toggle("in-game", !!S.view.room.started);
  if (!S.view.room.started) closeSheet();
  $("awaybar").classList.toggle("show", !!(S.view.room.started && S.view.you.away));
  $("btn-stand").style.display = S.view.room.started && !S.view.you.spectator ? "" : "none";
  const ok = $("overlay").dataset.kind;
  if (ok === "settings" && $("modal-settings")) renderSettings($("modal-settings"), !!S.view.room.isHost); // keep open, refresh pressed states
  else if (S.view.phase === "matchOver") { if (ok !== "help" && ok !== "match") showMatchOver(); }
  else if (ok !== "help") hideOverlay();
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
    if (S.view.phase === "bidding" && S.view.bidActive.includes(seat)) return seat === S.view.highBidder ? { c:"bidding", t:"high bid" } : { c:"bidding", t:"bidding" };
    if (seat === S.view.highBidder) return { c:"bidding", t:"high bid" };
    // a folded seat used to return null and render blank — identical to one yet to act
    if (S.view.phase === "bidding") return { c:"passed", t:"passed" };
    return null;
  }
  if (seat === S.view.declarer) return { c:"bidder", t:"BIDDER" };
  if (seat === S.view.partner) return { c:"partner", t:"PARTNER" };
  return { c:"def", t:"DEFENDER" };
}
function renderGame() {
  setRingEl(null); // rebuilt below if the active seat is on the clock
  $("header-state").innerHTML = `Deal <b>${S.view.roundNumber}</b> · first to <b>${S.view.consts.TARGET_GAMES}</b>`;
  renderMedallion();

  const act = activeSeat();
  // seats by position
  for (let pos = 0; pos < 4; pos++) {
    const seat = seatAtPos(pos);
    const el = $("seat-" + POS_CLASS[pos]);
    const info = S.view.seats[seat];
    el.classList.toggle("active", seat === act);
    el.classList.toggle("dealer", S.view.dealer === seat);
    el.classList.toggle("team-d", S.view.teamsRevealed && sideOf(seat) === "D");
    el.classList.toggle("team-o", S.view.teamsRevealed && sideOf(seat) === "O");
    const np = el.querySelector(".nameplate");
    np.querySelector(".who").textContent = info.name || info.label;
    paintAvatar(np.querySelector(".avatar"), info.name || info.label, !info.isHuman);
    np.querySelector(".role")?.remove();
    np.querySelector(".dealer-btn")?.remove();
    const role = roleOf(seat);
    if (role) { const r = document.createElement("span"); r.className = "role " + role.c; r.textContent = role.t; np.appendChild(r); }
    /* The dealer button is a puck that travels round a real table, so it is one
       here too — appended last, which is where it sits in front of the player. */
    if (S.view.dealer === seat) {
      const d = document.createElement("span"); d.className = "dealer-btn"; d.textContent = "D";
      d.title = "Dealer"; np.appendChild(d);
    }
    /* The countdown rings the player's own face — the one place on the plate the
       eye is already looking — instead of adding a second disc beside it. */
    const ava = np.querySelector(".avatar");
    const onClock = seat === act && S.view.turnDeadline != null && info.isHuman && info.connected && !info.away;
    ava.classList.toggle("ticking", onClock);
    if (onClock) setRingEl(ava); else ava.classList.remove("urgent");
    np.classList.toggle("off", info.isHuman && !info.connected);
    el.classList.toggle("away-seat", !!info.away);
    const zzz = info.away ? ` · <span class="zzz">on autopilot</span>` : (info.isHuman && !info.connected ? ` · <span class="zzz">offline</span>` : "");
    // tricks, not deals: deal-wins are in the scoreboard as pips, where "first to N" reads
    const tw = S.view.tricksWon[seat];
    el.querySelector(".meta").innerHTML = `<b>${S.view.capturedPoints[seat]}</b> pts · ${tw} ${tw === 1 ? "trick" : "tricks"}${zzz}`;
    /* What each seat actually bid — the pill beside the name says the state
       (bidding / high bid / passed), this says the number, so neither repeats. */
    const bc = el.querySelector(".bidchip");
    const bidVal = S.view.phase === "bidding" && S.view.bids ? S.view.bids[seat] : null;
    bc.className = "bidchip" + (seat === S.view.highBidder ? " high" : "");
    bc.textContent = bidVal != null ? String(bidVal) : "";
    bc.style.display = bidVal != null ? "" : "none";
    // card backs for everyone except your own seat
    const backs = el.querySelector("[data-backs]"); backs.innerHTML = "";
    const isMe = (S.mySeat != null && seat === S.mySeat);
    if (!isMe) {
      for (let i = 0; i < S.view.handCounts[seat]; i++) { const d = document.createElement("div"); d.className = "card-back"; backs.appendChild(d); }
      if (S.view.handCounts[seat]) { const n = document.createElement("span"); n.className = "backs-count"; n.textContent = String(S.view.handCounts[seat]); backs.appendChild(n); }
    }
  }

  // trick — reuse existing nodes so only a newly played card animates in (no full-trick flash)
  const tw = $("trick");
  const keyOf = pl => pl.player + ":" + pl.card.suit + pl.card.rank;
  const want = S.view.trick;
  const existing = Array.from(tw.children);
  const prefixOk = existing.length <= want.length && existing.every((el, i) => el.dataset.k === keyOf(want[i]));
  if (!prefixOk) tw.innerHTML = "";
  want.forEach((play, i) => {
    let el = tw.children[i];
    if (!el) {
      el = cardEl(play.card);
      el.dataset.k = keyOf(play);
      el.classList.add("trick-card", "pos-" + posOfSeat(play.player));
      tw.appendChild(el);
    }
    el.classList.toggle("winner", S.view.phase === "trickEnd" && i === S.view.lastWinnerSlot);
  });

  renderHand();
  renderActionBar();
  /* after the action bar, never before: it is the tallest thing in #bottom and the
     felt is sized by what is left over, so measuring first reads the *previous*
     phase's layout — which is how the strip ended up on top of the north seat. */
  fitTable();
  renderScoreboard();
  renderLog();
  renderChat();
  tickTimers();
}
/* ---------- centre medallion ----------
   The felt is the biggest thing on screen and used to carry nothing: the contract
   lived in a header badge, whose turn it was in a 14px line under the hand. This
   puts the state where the eye already rests. Two modes on one element — a centred
   plaque while the middle is empty, a slim strip once cards are being played into
   it. aria-hidden: the action bar and the aria-live log already narrate all of it. */
function renderMedallion() {
  const med = $("medallion");
  const label = med.querySelector(".med-label"), main = med.querySelector(".med-main");
  const sub = med.querySelector(".med-sub"), bar = med.querySelector(".med-bar > i");
  const chips = med.querySelector(".med-chips");
  const ph = S.view.phase;
  let mode = "full", showBar = false, pct = 0;
  chips.innerHTML = S.view.bonusSuit ? `<span>bonus ${cardSpan({ suit: S.view.bonusSuit, rank: 3 })} = 30</span>` : "";
  main.classList.remove("set");

  if (ph === "playing" || ph === "trickEnd") {
    mode = "strip"; showBar = true;
    const dPts = S.view.capturedPoints[S.view.declarer] + S.view.capturedPoints[S.view.partner];
    label.innerHTML = `${suitSpan(S.view.trump)} TRUMP`;
    main.innerHTML = `<b>${S.view.bid}</b> to make · <b>${dPts}</b>`;
    pct = S.view.bid ? Math.min(1, dPts / S.view.bid) : 0;
    // the trick counter rides in the strip rather than floating separately — one
    // element to keep clear of the seats and the cross instead of two
    const done = S.view.tricksWon.reduce((a, b) => a + b, 0);
    chips.innerHTML = `<span>trick ${Math.min(13, done + (ph === "playing" ? 1 : 0))} / 13</span>`;
  } else if (ph === "bidding") {
    label.textContent = "AUCTION";
    main.textContent = S.view.highBid ? String(S.view.highBid) : "—";
    sub.innerHTML = S.view.highBid ? `held by <b>${esc(S.view.names[S.view.highBidder])}</b>` : "no bid yet";
    // minBid is only on the wire while *you* are the required bidder; never recompute it
    if (S.view.you.minBid != null) chips.innerHTML += `<span>min next ${S.view.you.minBid}</span>`;
  } else if (ph === "trumpSelect") {
    label.textContent = "BID WON";
    main.textContent = String(S.view.bid);
    sub.innerHTML = `<b>${esc(S.view.names[S.view.declarer])}</b> is choosing trump`;
  } else if (ph === "partnerSelect") {
    label.innerHTML = `TRUMP ${suitSpan(S.view.trump)}`;
    main.textContent = String(S.view.bid);
    sub.innerHTML = `<b>${esc(S.view.names[S.view.declarer])}</b> is calling a partner`;
  } else if (S.view.lastResult) {           // roundEnd, matchOver
    const r = S.view.lastResult;
    label.textContent = "DEAL OVER";
    main.textContent = r.made ? "MADE" : "SET";
    main.classList.toggle("set", !r.made);
    sub.innerHTML = `${esc(S.view.names[r.declarer])} &amp; ${esc(S.view.names[r.partner])} captured <b>${r.dPts}</b>/${r.bid}`;
    showBar = true; pct = r.bid ? Math.min(1, r.dPts / r.bid) : 0;
  } else {
    label.textContent = ""; main.textContent = "—"; sub.textContent = "";
  }

  med.dataset.mode = mode;
  med.classList.toggle("has-bar", showBar);
  bar.style.width = (pct * 100).toFixed(1) + "%";
}

function renderScoreboard() {
  const c = S.view.consts;
  $("score-title").textContent = `SCOREBOARD · FIRST TO ${c.TARGET_GAMES}`;
  /* Deal-wins as pips against the target — "2" never said how close anyone was.
     Seven of them don't fit the column, so "first to 7" falls back to n / K. */
  const deals = n => c.TARGET_GAMES <= 5
    ? Array.from({ length: c.TARGET_GAMES }, (_, i) => `<i class="tally${i < n ? " on" : ""}"></i>`).join("")
    : `${n} / ${c.TARGET_GAMES}`;
  let html = `<tr><th class="name">Player</th><th>Points</th><th class="deals">Deals</th></tr>`;
  for (let s = 0; s < 4; s++) {
    const cls = [];
    if (S.mySeat != null && s === S.mySeat) cls.push("you");
    if (S.view.teamsRevealed) cls.push(sideOf(s) === "D" ? "side-d" : "side-o");   // a rail on the row, not a dot in the cell
    html += `<tr class="${cls.join(" ")}"><td class="name">${esc(S.view.names[s] || S.view.seats[s].label)}${S.view.dealer === s ? " (D)" : ""}</td>` +
            `<td><b>${S.view.capturedPoints[s]}</b></td><td class="deals">${deals(S.view.scores[s])}</td></tr>`;
  }
  $("scoreboard").innerHTML = html;

  const cl = $("contract-line"); cl.innerHTML = "";
  if (S.view.teamsRevealed && S.view.declarer != null) {
    const dPts = S.view.capturedPoints[S.view.declarer] + S.view.capturedPoints[S.view.partner];
    const top = document.createElement("div"); top.className = "cbar-top";
    top.innerHTML = `<span>${suitSpan(S.view.trump)} ${esc(S.view.names[S.view.declarer])} &amp; ${esc(S.view.names[S.view.partner])}</span><b>${dPts}/${S.view.bid}</b>`;
    const bar = document.createElement("div"); bar.className = "cbar";
    const fill = document.createElement("i");
    fill.style.width = (S.view.bid ? Math.min(1, dPts / S.view.bid) * 100 : 0).toFixed(1) + "%";
    bar.appendChild(fill); cl.appendChild(top); cl.appendChild(bar);
  }

  const st = S.view.settings || {}, sl = $("settings-line");
  const diffName = (DIFF_OPTS.find(d => d[0] === st.difficulty) || ["", "?"])[1];
  sl.innerHTML = `<span class="chip">AI <b>${diffName}</b></span><span class="chip">Timer <b>${st.turnTimerSec ? st.turnTimerSec + "s" : "off"}</b></span> `;
  if (S.view.room.isHost) sl.appendChild(miniBtn("Change", "", showSettingsModal, "gear"));
}

export { render, renderGame, renderMedallion, renderScoreboard, sideOf, activeSeat, roleOf, orient, seatAtPos, posOfSeat };
