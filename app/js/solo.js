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

   Reuses cards/*, ui/hand.js, ui/log.js, ui/modals.js, ui/layout.js, ui/chat.js
   and util/* from the multiplayer client. ui/hand.js, ui/log.js and
   ui/modals.js take the view (and, where they dispatch a player action, a
   callback) as arguments rather than reading session.js's S — solo has no
   session, and reaching into the multiplayer client's session object here
   would couple two clients that must stay independent. The seat/medallion/
   trick/scoreboard/action-bar painting below is solo's own: it is table
   presentation, not game rules, and screens/game.js + ui/actionbar.js are
   themselves wired to that same session object throughout. */
import * as E from "./core/engine/index.js";
import { $, esc, paintAvatar } from "./util/dom.js";
import { SUIT_KEY, SUIT_NAME, RED, suitSvg, suitSpan, cardSpan, cardName } from "./cards/labels.js";
import { cardEl, cardFace } from "./cards/deck.js";
import { paintIcons } from "./cards/icons.js";
import { renderHand } from "./ui/hand.js";
import { renderLog } from "./ui/log.js";
import { showMatchOver, showHelp, hideOverlay, setRenderHandler } from "./ui/modals.js";
import { fitTable, initResize } from "./ui/layout.js";
import { openSheet, closeSheet } from "./ui/chat.js";
import { setFourColor, initPrefs } from "./util/prefs.js";

const ME = 0;
const POS_CLASS = ["south", "west", "north", "east"]; // seat N sits at position N — no rotation, ME is always south

/* Recovered from the deleted root index.html: SPEED (650ms) paced every AI bid
   and card play; trump/partner selection there used SPEED+200. The unified
   requiredActor()-driven loop below — like drive()'s single ai-kind-agnostic
   delay — doesn't vary the pause by action kind, so SPEED is the one AI_DELAY
   for all four. later(advanceTrick, 1000) paced the pause after a trick. */
const AI_DELAY = 650, TRICK_DELAY = 1000;

let G = null, difficulty = "normal", lastView = null;
let humanBidValue = null, bidCtxKey = null;    // the human's in-progress bid stepper, mirrors ui/actionbar.js's S.humanBidValue/S.bidCtxKey
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
   actually stop them — solo owns G directly, so it can. */
let paused = false;

export function startSolo(opts) {
  difficulty = opts.difficulty;
  gen++;
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
    setTimeout(() => { if (myGen !== gen || paused) return; E.advanceTrick(G); paint(); step(); }, TRICK_DELAY);
    return;
  }
  if (G.phase === "roundEnd") { paint(); return; }    // player clicks "Next deal" -> E.nextDeal(G); paint(); step();
  if (G.phase === "matchOver") { paint(); return; }
  if (!ra) { paint(); return; }
  if (ra.seat === ME) { paint(); return; }            // wait for input; the click handlers call step() again
  setTimeout(() => {
    if (myGen !== gen || paused) return;
    const a = E.aiActionFor(G, ra.seat, difficulty);
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

function render(v) {
  $("header-state").innerHTML = `Deal <b>${v.roundNumber}</b> · first to <b>${v.consts.TARGET_GAMES}</b>`;
  renderMedallion(v);
  renderSeats(v);
  renderTrick(v);
  renderHand(v, onPlay);
  renderActionBar(v);
  /* after the action bar, never before — see the identical comment in
     screens/game.js's renderGame(): fitTable() measures what #bottom left over. */
  fitTable();
  renderScoreboard(v);
  renderLog(v);
  const ok = $("overlay").dataset.kind;
  if (v.phase === "matchOver") { if (ok !== "help" && ok !== "match") showMatchOver(v, toStart); }
  else if (ok !== "help") hideOverlay();
}
function onPlay(card) { apply(ME, { type: "play", card }); paint(); step(); }

// ---------- table: seats, medallion, trick (mirrors screens/game.js, parameterised on v instead of S.view) ----------
function activeSeat(v) {
  if (v.phase === "playing") return v.turn;
  if (v.phase === "bidding") return v.bidTurn;
  if (v.phase === "trumpSelect" || v.phase === "partnerSelect") return v.declarer;
  return -1;
}
function roleOfSeat(v, seat) {
  if (!v.teamsRevealed) {
    if (v.phase === "bidding" && v.bidActive.includes(seat)) return seat === v.highBidder ? { c: "bidding", t: "high bid" } : { c: "bidding", t: "bidding" };
    if (seat === v.highBidder) return { c: "bidding", t: "high bid" };
    if (v.phase === "bidding") return { c: "passed", t: "passed" };
    return null;
  }
  if (seat === v.declarer) return { c: "bidder", t: "BIDDER" };
  if (seat === v.partner) return { c: "partner", t: "PARTNER" };
  return { c: "def", t: "DEFENDER" };
}
function renderSeats(v) {
  const act = activeSeat(v);
  for (let seat = 0; seat < 4; seat++) {
    const el = $("seat-" + POS_CLASS[seat]);
    el.classList.toggle("active", seat === act);
    el.classList.toggle("dealer", v.dealer === seat);
    el.classList.toggle("team-d", v.teamsRevealed && E.sideOf(G, seat) === "D");
    el.classList.toggle("team-o", v.teamsRevealed && E.sideOf(G, seat) === "O");
    const np = el.querySelector(".nameplate");
    np.querySelector(".who").textContent = v.names[seat];
    paintAvatar(np.querySelector(".avatar"), v.names[seat], seat !== ME);
    np.querySelector(".role")?.remove();
    np.querySelector(".dealer-btn")?.remove();
    const role = roleOfSeat(v, seat);
    if (role) { const r = document.createElement("span"); r.className = "role " + role.c; r.textContent = role.t; np.appendChild(r); }
    if (v.dealer === seat) {
      const d = document.createElement("span"); d.className = "dealer-btn"; d.textContent = "D"; d.title = "Dealer"; np.appendChild(d);
    }
    const bc = el.querySelector(".bidchip");
    const bidVal = v.phase === "bidding" ? v.bids[seat] : null;
    bc.className = "bidchip" + (seat === v.highBidder ? " high" : "");
    bc.textContent = bidVal != null ? String(bidVal) : "";
    bc.style.display = bidVal != null ? "" : "none";
    const backs = el.querySelector("[data-backs]"); backs.innerHTML = "";
    if (seat !== ME) {
      for (let i = 0; i < v.handCounts[seat]; i++) { const d = document.createElement("div"); d.className = "card-back"; backs.appendChild(d); }
      if (v.handCounts[seat]) { const n = document.createElement("span"); n.className = "backs-count"; n.textContent = String(v.handCounts[seat]); backs.appendChild(n); }
    }
    const tw = v.tricksWon[seat];
    el.querySelector(".meta").innerHTML = `<b>${v.capturedPoints[seat]}</b> pts · ${tw} ${tw === 1 ? "trick" : "tricks"}`;
  }
}
function renderTrick(v) {
  const tw = $("trick");
  const keyOf = pl => pl.player + ":" + pl.card.suit + pl.card.rank;
  const want = v.trick;
  const existing = Array.from(tw.children);
  const prefixOk = existing.length <= want.length && existing.every((el, i) => el.dataset.k === keyOf(want[i]));
  if (!prefixOk) tw.innerHTML = "";
  want.forEach((play, i) => {
    let el = tw.children[i];
    if (!el) {
      el = cardEl(play.card);
      el.dataset.k = keyOf(play);
      el.classList.add("trick-card", "pos-" + play.player);
      tw.appendChild(el);
    }
    el.classList.toggle("winner", v.phase === "trickEnd" && i === v.lastWinnerSlot);
  });
}
function renderMedallion(v) {
  const med = $("medallion");
  const label = med.querySelector(".med-label"), main = med.querySelector(".med-main");
  const sub = med.querySelector(".med-sub"), bar = med.querySelector(".med-bar > i");
  const chips = med.querySelector(".med-chips");
  const ph = v.phase;
  let mode = "full", showBar = false, pct = 0;
  chips.innerHTML = v.bonusSuit ? `<span>bonus ${cardSpan({ suit: v.bonusSuit, rank: 3 })} = 30</span>` : "";
  main.classList.remove("set");

  if (ph === "playing" || ph === "trickEnd") {
    mode = "strip"; showBar = true;
    const dPts = v.capturedPoints[v.declarer] + v.capturedPoints[v.partner];
    label.innerHTML = `${suitSpan(v.trump)} TRUMP`;
    main.innerHTML = `<b>${v.bid}</b> to make · <b>${dPts}</b>`;
    pct = v.bid ? Math.min(1, dPts / v.bid) : 0;
    const done = v.tricksWon.reduce((a, b) => a + b, 0);
    chips.innerHTML = `<span>trick ${Math.min(13, done + (ph === "playing" ? 1 : 0))} / 13</span>`;
  } else if (ph === "bidding") {
    label.textContent = "AUCTION";
    main.textContent = v.highBid ? String(v.highBid) : "—";
    sub.innerHTML = v.highBid ? `held by <b>${esc(v.names[v.highBidder])}</b>` : "no bid yet";
    if (v.you.minBid != null) chips.innerHTML += `<span>min next ${v.you.minBid}</span>`;
  } else if (ph === "trumpSelect") {
    label.textContent = "BID WON";
    main.textContent = String(v.bid);
    sub.innerHTML = `<b>${esc(v.names[v.declarer])}</b> is choosing trump`;
  } else if (ph === "partnerSelect") {
    label.innerHTML = `TRUMP ${suitSpan(v.trump)}`;
    main.textContent = String(v.bid);
    sub.innerHTML = `<b>${esc(v.names[v.declarer])}</b> is calling a partner`;
  } else if (v.lastResult) {
    const r = v.lastResult;
    label.textContent = "DEAL OVER";
    main.textContent = r.made ? "MADE" : "SET";
    main.classList.toggle("set", !r.made);
    sub.innerHTML = `${esc(v.names[r.declarer])} &amp; ${esc(v.names[r.partner])} captured <b>${r.dPts}</b>/${r.bid}`;
    showBar = true; pct = r.bid ? Math.min(1, r.dPts / r.bid) : 0;
  } else {
    label.textContent = ""; main.textContent = "—"; sub.textContent = "";
  }
  med.dataset.mode = mode;
  med.classList.toggle("has-bar", showBar);
  bar.style.width = (pct * 100).toFixed(1) + "%";
}
function renderScoreboard(v) {
  const c = v.consts;
  $("score-title").textContent = `SCOREBOARD · FIRST TO ${c.TARGET_GAMES}`;
  const deals = n => c.TARGET_GAMES <= 5
    ? Array.from({ length: c.TARGET_GAMES }, (_, i) => `<i class="tally${i < n ? " on" : ""}"></i>`).join("")
    : `${n} / ${c.TARGET_GAMES}`;
  let html = `<tr><th class="name">Player</th><th>Points</th><th class="deals">Deals</th></tr>`;
  for (let s = 0; s < 4; s++) {
    const cls = [];
    if (s === ME) cls.push("you");
    if (v.teamsRevealed) cls.push(E.sideOf(G, s) === "D" ? "side-d" : "side-o");
    html += `<tr class="${cls.join(" ")}"><td class="name">${esc(v.names[s])}${v.dealer === s ? " (D)" : ""}</td>` +
            `<td><b>${v.capturedPoints[s]}</b></td><td class="deals">${deals(v.scores[s])}</td></tr>`;
  }
  $("scoreboard").innerHTML = html;

  const cl = $("contract-line"); cl.innerHTML = "";
  if (v.teamsRevealed && v.declarer != null) {
    const dPts = v.capturedPoints[v.declarer] + v.capturedPoints[v.partner];
    const top = document.createElement("div"); top.className = "cbar-top";
    top.innerHTML = `<span>${suitSpan(v.trump)} ${esc(v.names[v.declarer])} &amp; ${esc(v.names[v.partner])}</span><b>${dPts}/${v.bid}</b>`;
    const bar = document.createElement("div"); bar.className = "cbar";
    const fill = document.createElement("i");
    fill.style.width = (v.bid ? Math.min(1, dPts / v.bid) * 100 : 0).toFixed(1) + "%";
    bar.appendChild(fill); cl.appendChild(top); cl.appendChild(bar);
  }
}

// ---------- action bar: bid stepper, trump/call pickers, status banners ----------
/* Solo's own action bar, not a reuse of ui/actionbar.js: that module is wired
   directly to session.js's S (S.mySeat, S.humanBidValue, S.bidCtxKey) and to
   net.js's send() at every call site, which is exactly the coupling solo must
   not take on. It is small and worth writing once here instead. */
function renderActionBar(v) {
  const bar = $("action-bar"); bar.innerHTML = "";
  bar.dataset.turn = v.you.toAct ? "you" : "other";
  const c = v.consts;
  const text = (cls, html) => { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; bar.appendChild(d); };
  const button = (label, cls, fn) => { const b = document.createElement("button"); b.className = "act-btn " + (cls || ""); b.innerHTML = label; b.onclick = fn; bar.appendChild(b); return b; };

  if (v.you.toAct) {
    if (v.you.actKind === "bid") {
      const ctxKey = v.roundNumber + "|" + (v.highBid || 0);
      if (bidCtxKey !== ctxKey) { bidCtxKey = ctxKey; humanBidValue = null; }
      const lo = v.you.minBid;
      text("prompt", `Your bid — highest so far ${v.highBid ? "<b>" + v.highBid + "</b> from " + esc(v.names[v.highBidder]) : "<b>none</b>"} · bonus ${cardSpan({ suit: v.bonusSuit, rank: 3 })} is worth 30`);
      button("Pass", "pass", () => { humanBidValue = null; apply(ME, { type: "bid", value: null }); paint(); step(); });
      if (lo > c.MAX_BID) { text("status", "Bidding is maxed out — you can only pass."); return; }
      let val = humanBidValue; if (val == null || val < lo || val > c.MAX_BID) { val = lo; humanBidValue = val; }
      const dn = button("−" + c.BID_STEP, "step", () => { humanBidValue = Math.max(lo, val - c.BID_STEP); renderActionBar(v); });
      dn.setAttribute("aria-label", "Lower the bid by " + c.BID_STEP);
      dn.disabled = val <= lo;
      const valEl = document.createElement("span"); valEl.className = "bidval"; valEl.textContent = val; bar.appendChild(valEl);
      const up = button("+" + c.BID_STEP, "step", () => { humanBidValue = Math.min(c.MAX_BID, val + c.BID_STEP); renderActionBar(v); });
      up.setAttribute("aria-label", "Raise the bid by " + c.BID_STEP);
      up.disabled = val >= c.MAX_BID;
      button("Bid " + val, "", () => { humanBidValue = null; apply(ME, { type: "bid", value: val }); paint(); step(); });
      return;
    }
    if (v.you.actKind === "trump") {
      text("prompt", `You won the bid at <b>${v.bid}</b>. Choose the trump suit.`);
      E.SUITS.forEach(s => {
        const b = button(`${suitSvg(s)}<small>${SUIT_NAME[s]}</small>`, "suit s-" + SUIT_KEY[s] + (RED.has(s) ? " red" : ""),
          () => { apply(ME, { type: "trump", suit: s }); paint(); step(); });
        b.setAttribute("aria-label", "Choose " + SUIT_NAME[s] + " as trump");
      });
      return;
    }
    if (v.you.actKind === "call") {
      text("prompt", `Trump is ${suitSpan(v.trump)}. Now name a card you <b>don't</b> hold — whoever has it is your partner.`);
      const grid = document.createElement("div"); grid.className = "call-grid";
      const byS = {}; E.SUITS.forEach(s => byS[s] = []);
      (v.you.callable || []).forEach(cd => byS[cd.suit].push(cd));
      E.SUITS.forEach(s => {
        if (!byS[s].length) return;
        const row = document.createElement("div"); row.className = "call-row";
        const lab = document.createElement("span");
        lab.className = "call-suit sc s-" + SUIT_KEY[s]; lab.innerHTML = suitSvg(s); lab.setAttribute("aria-hidden", "true");
        row.appendChild(lab);
        byS[s].sort((a, b) => b.rank - a.rank).forEach(cd => {
          const m = document.createElement("button");
          m.type = "button";
          m.className = "mini-card s-" + SUIT_KEY[cd.suit] + (RED.has(cd.suit) ? " red" : "") + (cd.rank === 14 ? " ace" : "") + (cd.suit === v.bonusSuit && cd.rank === 3 ? " bonus" : "");
          m.innerHTML = cardFace(cd, true);
          m.setAttribute("aria-label", "Call " + cardName(cd) + (cd.suit === v.bonusSuit && cd.rank === 3 ? " (bonus 30 points)" : ""));
          m.onclick = () => { apply(ME, { type: "call", card: { suit: cd.suit, rank: cd.rank } }); paint(); step(); };
          row.appendChild(m);
        });
        grid.appendChild(row);
      });
      bar.appendChild(grid);
      return;
    }
    if (v.you.actKind === "play") { bannerForPlay(v, true); return; }
  }
  if (v.phase === "playing" || v.phase === "trickEnd") { bannerForPlay(v, false); return; }
  if (v.phase === "roundEnd") {
    if (v.lastResult) {
      const r = v.lastResult;
      text("banner", `${esc(v.names[r.declarer])} & ${esc(v.names[r.partner])} captured <b>${r.dPts}</b>/${r.bid} → <b>${r.made ? "MADE" : "SET"}</b>. ${r.winners.map(p => esc(v.names[p])).join(" & ")} win the deal.`);
    }
    button("Next deal →", "", () => { E.nextDeal(G); paint(); step(); });
    return;
  }
  text("status", `${phaseLabel(v.phase)} — waiting for <b>${esc(v.names[activeSeat(v)] || "")}</b>`);
}
function bannerForPlay(v, myTurn) {
  const dPts = v.capturedPoints[v.declarer] + v.capturedPoints[v.partner];
  const mySide = E.sideOf(G, ME);
  const mate = mySide === "D" ? (ME === v.declarer ? v.partner : v.declarer) : E.defenders(G).find(p => p !== ME);
  const turnTxt = myTurn ? " <b>Your turn.</b>" : ` — ${esc(v.names[v.turn])} to play`;
  const d = document.createElement("div"); d.className = "banner";
  d.innerHTML = mySide === "D"
    ? `<span class="d">You + ${esc(v.names[mate])}</span> are the bidding side — need <b>${v.bid}</b> pts, captured <b>${dPts}</b>.${turnTxt}`
    : `<span class="o">You + ${esc(v.names[mate])}</span> defend — keep them under <b>${v.bid}</b> pts (they have <b>${dPts}</b>).${turnTxt}`;
  $("action-bar").appendChild(d);
}
function phaseLabel(phase) {
  return ({ bidding: "Bidding", trumpSelect: "Choosing trump", partnerSelect: "Calling partner", playing: "Playing", trickEnd: "Trick won", roundEnd: "Deal over", matchOver: "Match over" })[phase] || "";
}

// ---------- start / restart ----------
/* Abandon the current match (if any) and return to the difficulty/deals
   picker. Bumping gen invalidates any AI/trick timer still pending from it. */
function toStart() {
  gen++;
  G = null;
  hideOverlay();
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
  setRenderHandler(() => { paint(); if (paused) { paused = false; step(); } });
  paintIcons(document);
  $("title-suits").innerHTML = E.SUITS.map(suitSpan).join("");
  const pips = E.SUITS.map(s => `<span class="sc s-${SUIT_KEY[s]}">${suitSvg(s)}</span>`).join("");
  $("brand-colophon").innerHTML = `<i class="bar"></i>${pips}<i class="bar"></i>`;

  $("btn-start").onclick = () => startSolo({ difficulty: $("sel-difficulty").value, targetDeals: Number($("sel-deals").value) });
  $("btn-help").onclick = () => { paused = true; showHelp(lastView); };
  $("btn-new").onclick = toStart;

  initPrefs();
  $("btn-colors").onclick = () => setFourColor(!document.body.classList.contains("fourcolor"));

  document.querySelectorAll("#sheet-tabs button").forEach(b => { b.onclick = () => openSheet(b.dataset.tab); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  initResize();
}
if (typeof document !== "undefined") boot();
