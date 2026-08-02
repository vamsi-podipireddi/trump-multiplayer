/* ============================================================
   Single-player: the same engine the server runs, driven in-page. There is
   no room, no socket and no redaction — the local player is always seat 0.

   step()/apply() mirror drive()/aiAct() in src/core/room/drive.js: the same
   phase dispatch (trickEnd delay, roundEnd gate, otherwise requiredActor()
   plus an AI delay) and the same discipline of routing every action — human
   click or AI move alike — through one legality-checked function, so the
   guard can't be bypassed by one path.

   paint() mirrors buildView() in src/core/room/view.js: publicView(G) is a
   hand-free, multi-viewer-safe snapshot, so paint() adds the local player's
   own hand the same way buildView() adds the *viewer's* hand — the one
   thing publicView() deliberately leaves out.

   The table itself is no longer solo's own: ui/table.js, ui/rails.js,
   ui/hand.js, ui/actionbar.js, ui/log.js and ui/modals.js all take the view
   (and a handler object) as arguments rather than reading session.js's S, so
   both clients paint from one implementation. Solo has no session, and
   reaching into the multiplayer client's session object here would couple two
   clients that must stay independent — which is exactly why those modules
   were parameterised instead of shared by importing S.
   ============================================================ */
import * as E from "./core/engine/index.js";
import { $, esc } from "./util/dom.js";
import { cardEl } from "./cards/deck.js";
import { paintIcons } from "./cards/icons.js";
import { renderTable, resetTable } from "./ui/table.js";
import { renderContract, renderScoreboard, renderTricks } from "./ui/rails.js";
import { renderHand, resetHandFor } from "./ui/hand.js";
import { renderActionBar, resetActionBar, phaseLabel } from "./ui/actionbar.js";
import { renderLog } from "./ui/log.js";
import { showMatchOver, showHelp, showRoundResult, maybeShowReveal, hideReveal, hideOverlay, setRenderHandler } from "./ui/modals.js";
import { fitTable, initResize } from "./ui/layout.js";
import { startAmbient } from "./ui/ambient.js";
import { openSheet, closeSheet } from "./ui/chat.js";
import { setFourColor, initPrefs } from "./util/prefs.js";
import { initSound, toggleSound } from "./ui/sound.js";
import { initCoach, renderCoach, resetCoach } from "./ui/coach.js";
import { snapshotOf, saveDeal, roomKeyOf } from "./util/deals.js";

const ME = 0;

/* Recovered from the deleted root index.html: SPEED (650ms) paced every AI bid
   and card play; trump/partner selection there used SPEED+200. The unified
   requiredActor()-driven loop below — like drive()'s single ai-kind-agnostic
   delay — doesn't vary the pause by action kind, so SPEED is the one AI_DELAY
   for all four. TRICK_DELAY was that client's 1000ms, and is now 1450: the
   trick-end beat starts its sweep at 780ms and the slide itself takes 550ms
   (see .trick-card in app/css/table.css), so clearing at 1000 deleted the cards
   a third of the way to the winner's plate. The server's own trick timer is
   1600ms for the same reason. */
const AI_DELAY = 650, TRICK_DELAY = 1450;

let G = null, difficulty = "normal", lastView = null;
/* Which seat is mid-decision, so the plate can show the three dots the server
   never sends. Solo owns the delay, so it is the only client that can know. */
let thinking = null;
/* Bumped every time a match is (re)started; a setTimeout captures the value
   current when it was scheduled and checks it again when it fires, so a
   match abandoned via "New match" can't have a stray AI/trick timer reach
   into the *next* match's G. drive.js gets this for free from room.timers;
   a bare setTimeout here needs the counter to get it too. */
let gen = 0;
/* Set while the Help modal covers the table, cleared when it closes (see
   boot()'s setRenderHandler below). Checked by step()'s two timers so the
   trick-end pause and AI play both freeze behind the modal instead of
   running unseen. Multiplayer's ui/modals.js has no matching flag: its game
   state lives on a server the client doesn't control, so a client-side
   pause could only hide that the AI and turn timer kept running there, not
   actually stop them — solo owns G directly, so it can.
   Match-scoped, like gen, and reset alongside every gen++ for the same
   reason: a keyboard user can Tab straight past the Help overlay (nothing
   here may add a focus trap or inert — ui/modals.js is shared with the
   multiplayer client) to "New match" and activate it, which calls
   toStart() and hides the overlay directly, never through the
   setRenderHandler seam that normally clears this flag. Left uncleared,
   every future step() timer would see a stale paused=true and no-op
   forever — a silently frozen game with no path back except reopening and
   properly closing Help. */
let paused = false;

/* Every renderer that keeps per-deal state of its own keyed on the round number
   — the face-up set, the bid stepper, the trick-end beat — has to be told when a
   *match* ends, because the next one starts at round 1 again and would otherwise
   inherit it. Multiplayer never needs this: leaving a room reloads the page.
   `paused` is cleared here for the same reason it always was: this path is
   reachable with the Help modal still open (Tab past it to "New match"), which
   never goes through the setRenderHandler seam that normally clears the flag. */
function resetForNewMatch() {
  paused = false;
  resetTable();
  resetHandFor();
  resetActionBar();
  resetCoach();
}

export function startSolo(opts) {
  difficulty = opts.difficulty;
  gen++;
  resetForNewMatch();
  thinking = null;
  G = E.createMatch(["You", "West", "North", "East"], { targetDeals: opts.targetDeals });
  E.startMatch(G);
  $("start-screen").classList.remove("show");
  $("game").style.display = "grid";
  document.body.classList.add("in-game");
  paint();   // the deal itself has no pending timer — show it immediately, same as the server's unconditional broadcast in drive()
  step();
}

function step() {
  const ra = E.requiredActor(G);
  const myGen = gen;
  if (G.phase === "trickEnd") {
    thinking = null;
    setTimeout(() => { if (myGen !== gen || paused) return; E.advanceTrick(G); paint(); step(); }, TRICK_DELAY);
    return;
  }
  thinking = null;
  if (G.phase === "roundEnd") { paint(); return; }    // the result panel's button calls H.nextDeal
  if (G.phase === "matchOver") { paint(); return; }
  if (!ra) { paint(); return; }
  if (ra.seat === ME) { paint(); return; }            // wait for input; the handlers below call step() again
  thinking = ra.seat;
  paint();
  setTimeout(() => {
    if (myGen !== gen || paused) return;
    const a = E.aiActionFor(G, ra.seat, difficulty);
    thinking = null;
    apply(ra.seat, a);
    paint();
    step();
  }, AI_DELAY);
}

/* One place where an action reaches the engine, whether it came from a click
   or from the AI — so the legality guard cannot be bypassed by one path. */
function apply(seat, a) {
  if (!a) return;
  if (a.type === "bid")   { if (a.value === null || E.bidIsLegal(G, seat, a.value)) E.applyBid(G, seat, a.value); }
  if (a.type === "trump") E.applyTrump(G, a.suit);
  if (a.type === "call")  { if (E.callIsLegal(G, a.card)) E.applyCall(G, a.card); }
  if (a.type === "play")  { if (E.playIsLegal(G, seat, a.card)) E.applyPlay(G, seat, a.card); }
}
/* Every control on the table routes through here. Each one applies, repaints
   and re-enters the loop, which is what the multiplayer client gets for free
   from the server's next state message. */
const H = {
  bid: value => act({ type: "bid", value }),
  pass: () => act({ type: "bid", value: null }),
  trump: suit => act({ type: "trump", suit }),
  call: card => act({ type: "call", card }),
  play: card => act({ type: "play", card }),
  nextDeal: () => { hideOverlay(); E.nextDeal(G); paint(); step(); },
};
function act(a) { apply(ME, a); paint(); step(); }

// ---------- view ----------
function paint() {
  const v = E.publicView(G);
  v.you = { seat: ME, playerId: null, spectator: false, away: false, ready: true, pendingSeat: null };
  v.room = { isHost: true, hostName: null };   // solo has no separate host; showMatchOver()'s rematch button just needs this true
  v.you.hand = G.hands[ME].slice();            // the one line that puts cards in your hand — publicView(G) carries none
  const ra = E.requiredActor(G);
  if (ra && ra.seat === ME) {
    v.you.toAct = true; v.you.actKind = ra.kind;
    if (ra.kind === "play") v.you.legal = E.legalCards(G, ME);
    else if (ra.kind === "call") v.you.callable = E.callableCards(G, ME);
    else if (ra.kind === "bid") v.you.minBid = E.minNextBid(G);
  }
  lastView = v;
  render(v);
  return v;
}

/* Mirrors screens/game.js's tableCtx(): the same shape, with solo's answers.
   posOf is the identity because you are always seat 0 and always sit south. */
function ctxFor(v) {
  return {
    mySeat: ME,
    posOf: seat => seat,
    seatInfo: seat => ({ name: v.names[seat], isAI: seat !== ME, connected: true, away: false }),
    activeSeat: activeSeat(v),
    role: seat => roleOfSeat(v, seat),
    sideOf: seat => (v.teamsRevealed ? E.sideOf(G, seat) : null),
    thinking,
    target: v.consts.TARGET_GAMES,
    settingsHtml: `<span class="chip">AI <b>${esc(difficulty)}</b></span>`,
    onSettings: null,
  };
}
function render(v) {
  const ph = phaseLabel(v.phase);
  $("header-state").innerHTML = `Deal <b>${v.roundNumber}</b> · first to <b>${v.consts.TARGET_GAMES}</b>${ph ? " · " + esc(ph) : ""}`;
  const ctx = ctxFor(v);
  renderTable(v, ctx);
  renderContract(v, ctx);
  renderScoreboard(v, ctx);
  renderTricks(v, ctx);
  renderHand(v, H.play);
  renderActionBar(v, H);
  /* after renderActionBar, never before — see the identical comment in
     screens/game.js's renderGame(): both write #hand-hint, and a hint answer
     is meant to override the phase's own contextual tip, not the reverse. */
  renderCoach(v, ctx, H);
  /* after the action bar (and the coach line above), never before — see the
     identical comment in screens/game.js's renderGame(): fitTable() measures
     what the tray left over. */
  fitTable();
  renderLog(v);

  if ((v.phase === "roundEnd" || v.phase === "matchOver") && v.lastResult)
    saveDeal(roomKeyOf(v), v.matchId, snapshotOf(v));

  const ok = $("overlay").dataset.kind;
  if (ok === "help") { /* the reader closes it */ }
  else if (v.phase === "matchOver") { if (ok !== "match") showMatchOver(v, toStart); }
  else if (v.phase === "roundEnd" && v.lastResult) showRoundResult(v, ctx, H);
  else hideOverlay();
  maybeShowReveal(v, ctx);
}

function activeSeat(v) {
  if (v.phase === "playing") return v.turn;
  if (v.phase === "bidding") return v.bidTurn;
  if (v.phase === "trumpSelect" || v.phase === "partnerSelect") return v.declarer;
  return -1;
}
function roleOfSeat(v, seat) {
  if (!v.teamsRevealed) {
    if (v.phase === "bidding" && v.bidActive.includes(seat)) return seat === v.highBidder ? { c: "high", t: "high bid" } : null;
    if (seat === v.highBidder) return { c: "high", t: "high bid" };
    if (v.phase === "bidding") return { c: "passed", t: "passed" };
    return null;
  }
  if (seat === v.declarer) return { c: "bidder", t: "BIDDER" };
  if (seat === v.partner) return { c: "partner", t: "PARTNER" };
  return { c: "def", t: "DEFENDER" };
}

// ---------- start / restart ----------
/* Abandon the current match (if any) and return to the difficulty/deals
   picker. Bumping gen invalidates any AI/trick timer still pending from it.
   Also clears paused: this hides the overlay directly rather than through
   showHelp's own close button, so it is reachable with Help still open
   (Tab past it to "New match") and must not leave a stale pause behind for
   the next match — see the comment on paused's declaration. */
function toStart() {
  gen++;
  resetForNewMatch();
  thinking = null;
  G = null;
  hideOverlay();
  hideReveal();
  closeSheet();
  document.body.classList.remove("in-game");
  $("game").style.display = "none";
  $("start-screen").classList.add("show");
}

/* ---------- boot ----------
   Wrapped and guarded, unlike a plain top-level boot sequence: solo.js is the
   entry point solo.html's only script reference loads, so its top level would
   otherwise run immediately — including under test/client-modules.test.js,
   which imports every file under app/js/ with no DOM. typeof, not a direct
   reference, so checking on Node (where `document` is never declared at all)
   doesn't itself throw. Mirrors main.js's own boot() guard exactly. */
function boot() {
  /* showHelp()'s close button calls back into whatever setRenderHandler
     registered (see ui/modals.js) — the seam solo.js already uses to get
     paint() called on close. Piggyback the resume on it here instead of
     touching ui/modals.js: unpause and re-step() so the AI/trick timer that
     froze behind the modal picks back up. */
  setRenderHandler(() => { if (G) paint(); if (paused) { paused = false; step(); } });
  paintIcons(document);
  (function dressChrome() {
    const fan = $("brand-fan");
    [{ suit: "♠", rank: 14 }, { suit: "♥", rank: 13 }, { suit: "♣", rank: 12 }].forEach((c, i) => {
      const el = cardEl(c);
      el.style.transform = `rotate(${(i - 1) * 7}deg)`;
      el.style.animationDelay = (0.1 + i * 0.11).toFixed(2) + "s";
      fan.appendChild(el);
    });
    $("brand-colophon").innerHTML = `<i class="bar"></i><span>250 points · bid &amp; capture</span>`;
    startAmbient($("join-fx"));
  })();

  $("btn-start").onclick = () => startSolo({ difficulty: $("sel-difficulty").value, targetDeals: Number($("sel-deals").value) });
  $("btn-help").onclick = () => { paused = true; showHelp(lastView); };
  $("btn-new").onclick = toStart;
  // paint(), not render: the click handler is wired once, long before any G
  // exists, so it needs a no-arg repaint it can call once a response lands —
  // paint() is solo's, rebuilding v from the current G on every call.
  initCoach(paint);

  initPrefs();
  initSound();
  $("btn-colors").onclick = () => setFourColor(!document.body.classList.contains("fourcolor"));
  $("btn-sound").onclick = toggleSound;

  document.querySelectorAll("#sheet-tabs button").forEach(b => { b.onclick = () => openSheet(b.dataset.tab); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  initResize();
}
if (typeof document !== "undefined") boot();
