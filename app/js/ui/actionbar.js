/* The prompt line and the tray above it.
   Parameterised on the view and on a handler object rather than on session.js /
   net.js, because solo.js drives the identical controls with its own handlers —
   importing net.js here would put a WebSocket in the offline game. */
import { $, esc } from "../util/dom.js";
import { SUITS, SUIT_NAME, SUIT_PATH, suitSvg, suitClass, cardName } from "../cards/labels.js";
import { miniCardEl } from "../cards/deck.js";
import { sfx } from "./sound.js";

/* The bid stepper is the one control with state that has to survive a render:
   the value you have dialled up but not yet committed. It is keyed on the bid
   context, not stored per session — a new deal, taking a different seat, or
   anyone raising the high bid moves the minimum you may legally bid and so
   invalidates whatever you had dialled. (This pair replaces the old
   S.humanBidValue/S.bidCtxKey.) */
let bidValue = null, bidCtxKey = "";

/* The key cannot see a *match* boundary: a new match restarts at deal 1 with no
   high bid, so its opening auction keys identically to the abandoned one's and a
   value dialled up before the abandon would survive into it. Solo calls this at
   both match boundaries; multiplayer never needs it, because leaving a room
   reloads the page. */
function resetActionBar() { bidValue = null; bidCtxKey = ""; }

const PHASE_LABEL = {
  bidding: "Bidding", trumpSelect: "Choosing trump", partnerSelect: "Calling partner",
  playing: "Playing", trickEnd: "Trick won", roundEnd: "Deal over", matchOver: "Match over",
};
function phaseLabel(phase) { return PHASE_LABEL[phase] || ""; }

/* Private mirror of screens/game.js's activeSeat() — a pure function of the
   view that game.js also needs. Duplicated rather than imported: game.js
   already imports renderActionBar from this file, so importing back would make
   the two files import each other, and game.js is exactly the layer this
   module is no longer allowed to depend on. */
function activeSeat(v) {
  if (v.phase === "playing") return v.turn;
  if (v.phase === "bidding") return v.bidTurn;
  if (v.phase === "trumpSelect" || v.phase === "partnerSelect") return v.declarer;
  return -1;
}
const suitTitle = s => SUIT_NAME[s].charAt(0).toUpperCase() + SUIT_NAME[s].slice(1);

function renderActionBar(v, h) {
  const bar = $("action-bar"), tray = $("action-tray"), buttons = $("action-buttons"),
        grid = $("call-grid"), hintEl = $("hand-hint");
  bar.innerHTML = ""; buttons.innerHTML = ""; grid.innerHTML = "";
  const hint = fillBar(v, h, bar, buttons, grid);

  bar.dataset.turn = v.you.toAct ? "you" : "other";   // drives the cue rail
  buttons.classList.toggle("show", buttons.children.length > 0);
  grid.classList.toggle("show", grid.children.length > 0);
  /* The tray is out of flow and layout.js lifts the felt by its measured
     height, so an empty tray would steal a strip of felt for nothing. */
  tray.classList.toggle("show", buttons.children.length > 0 || grid.children.length > 0);
  hintEl.textContent = hint;
  hintEl.classList.toggle("show", !!hint);
}

/* Fills the three slots and returns the hand hint. Split out so renderActionBar
   above can commit the .show classes once, from what actually landed in them,
   instead of every early return having to remember to do it. */
function fillBar(v, h, bar, buttons, grid) {
  const c = v.consts;
  const name = seat => esc(v.names[seat] || "");
  const prompt = html => { const s = document.createElement("span"); s.className = "prompt"; s.innerHTML = html; bar.appendChild(s); };
  const button = (label, cls, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "act-btn" + (cls ? " " + cls : "");
    b.innerHTML = label;
    b.onclick = fn;
    buttons.appendChild(b);
    return b;
  };

  if (v.you.spectator) {
    // seats are handed out at deal boundaries mid-match, so say when you're in
    const q = v.you.pendingSeat != null
      ? ` · you take ${esc(v.seats[v.you.pendingSeat].label)} on the next deal`
      : "";
    prompt(`Spectating ${esc(v.room.hostName || "")}'s table — ${phaseLabel(v.phase)}${q}`);
    return "";
  }

  if (v.you.toAct && v.you.actKind === "bid") {
    const lo = v.you.minBid;
    /* minBid is in the key as well as highBid because it, not highBid, is the
       bound the stepper is clamped to — if the two ever stop tracking each other
       the key still moves when the legal floor does. */
    const ctxKey = [v.you.seat, v.roundNumber, v.highBid || 0, lo].join("|");
    if (bidCtxKey !== ctxKey) { bidCtxKey = ctxKey; bidValue = null; } // fresh bid context → start at the minimum
    /* Every cue below fires from a click handler rather than from the render
       path: the bar is rebuilt on every view update, so a cue placed here would
       replay on each bot's bid and again on each stepper press. */
    button("Pass", "pass", () => { sfx("pass"); bidValue = null; h.pass(); });
    if (lo > c.MAX_BID) { prompt("Bidding is maxed out — you can only pass."); return ""; }
    prompt(v.highBid
      ? `Your bid — ${name(v.highBidder)} holds <b>${v.highBid}</b>.`
      : "Your bid — nobody has opened.");
    const val = bidValue == null || bidValue < lo || bidValue > c.MAX_BID ? lo : bidValue;
    bidValue = val;
    const step = (delta, label, aria) => {
      const b = button(label, "step", () => {
        const wasFocused = document.activeElement === b;
        bidValue = Math.max(lo, Math.min(c.MAX_BID, val + delta));
        renderActionBar(v, h);
        /* the whole bar is rebuilt, so a keyboard user holding down +5 would
           otherwise lose focus to <body> on the first press */
        if (wasFocused) {
          const again = $("action-buttons").querySelectorAll(".act-btn.step")[delta < 0 ? 0 : 1];
          if (again && !again.disabled) again.focus();
        }
      });
      b.setAttribute("aria-label", aria);
      return b;
    };
    step(-c.BID_STEP, "−" + c.BID_STEP, "Lower the bid").disabled = val <= lo;
    const shown = document.createElement("span");
    shown.className = "bidval"; shown.textContent = val;
    buttons.appendChild(shown);
    step(c.BID_STEP, "+" + c.BID_STEP, "Raise the bid").disabled = val >= c.MAX_BID;
    button("Bid " + val, "primary", () => { sfx("bid"); bidValue = null; h.bid(val); });
    return "Bid only what your side can actually capture — fall short and the defenders take the deal.";
  }

  if (v.you.toAct && v.you.actKind === "trump") {
    prompt(`You won the bid at <b>${v.bid}</b>. Name the trump suit.`);
    SUITS.forEach(s => {
      const b = button(suitSvg(s) + suitTitle(s), "suit " + suitClass(s), () => { sfx("trump"); h.trump(s); });
      b.setAttribute("aria-label", "Choose " + SUIT_NAME[s] + " as trump");
    });
    return "Your longest suit is usually the safest trump.";
  }

  if (v.you.toAct && v.you.actKind === "call") {
    prompt("Call a card you <b>don't</b> hold — its holder is your partner.");
    const bySuit = {}; SUITS.forEach(s => bySuit[s] = []);
    (v.you.callable || []).forEach(cd => bySuit[cd.suit].push(cd));
    SUITS.forEach(s => {
      if (!bySuit[s].length) return;
      const row = document.createElement("div"); row.className = "call-row";
      /* .call-suit carries the 15px box itself, so the class has to land on the
         <svg> — inside a wrapper span the pip would keep its inherited 1em. */
      row.innerHTML = `<svg class="call-suit ${suitClass(s)}" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="${SUIT_PATH[s]}"/></svg>`;
      const cards = document.createElement("div"); cards.className = "cards";
      bySuit[s].sort((a, b) => b.rank - a.rank).forEach(cd => {
        const bonus = cd.suit === v.bonusSuit && cd.rank === 3;
        const m = miniCardEl(cd, true);
        if (bonus) m.classList.add("bonus");
        m.setAttribute("aria-label", "Call " + cardName(cd) + (bonus ? " (bonus 30 points)" : ""));
        m.onclick = () => { sfx("click"); h.call({ suit: cd.suit, rank: cd.rank }); };
        cards.appendChild(m);
      });
      row.appendChild(cards);
      grid.appendChild(row);
    });
    return "Call high in a suit you are long in — you want your partner to have real cards, not scraps.";
  }

  if (v.phase === "playing" || v.phase === "trickEnd") {
    const me = v.you.seat;
    if (v.you.toAct) {
      prompt(v.leadSuit ? `Your turn — follow ${SUIT_NAME[v.leadSuit]}.` : "Your turn — you lead.");
      const hand = v.you.hand || [], legal = v.you.legal || [];
      if (!v.leadSuit) return "You are leading — anything goes.";
      if (!hand.some(cd => cd.suit === v.leadSuit)) return `You are void in ${SUIT_NAME[v.leadSuit]} — anything is legal, including trump.`;
      if (legal.length === hand.length) return `Every card you hold follows ${SUIT_NAME[v.leadSuit]}.`;
      return `${legal.length} of your ${hand.length} cards can be played.`;
    }
    const mySide = v.teamsRevealed && (me === v.declarer || me === v.partner) ? "D" : "O";
    if (mySide === "D") {
      const mate = me === v.declarer ? v.partner : v.declarer;
      /* `partner === declarer` is the deal where the called card is in the
         caller's own hand — one seat, so its points count once. ui/rails.js and
         ui/modals.js guard their copies of this sum the same way. */
      const dPts = v.capturedPoints[v.declarer] + (v.partner === v.declarer ? 0 : v.capturedPoints[v.partner]);
      prompt(`You + ${name(mate)} need <b>${Math.max(0, v.bid - dPts)}</b> more · ${name(v.turn)} to play`);
    } else {
      const mate = [0, 1, 2, 3].find(s => s !== me && s !== v.declarer && s !== v.partner);
      prompt(`You + ${name(mate)} defend · ${name(v.turn)} to play`);
    }
    return "";
  }

  if (v.phase === "roundEnd" || v.phase === "matchOver") {
    const verdict = v.lastResult ? (v.lastResult.made ? "Bid made." : "Bid set.") : "";
    if (v.phase !== "roundEnd") { prompt(verdict); return ""; }
    if (h.ready && v.seats) {
      const live = v.seats.filter(s => s.isHuman && s.connected && !s.away);
      const ready = live.filter(s => s.ready).length;
      const b = button(v.you.ready ? `Ready ✓ — waiting ${ready}/${live.length}` : `Next deal — I'm ready (${ready}/${live.length})`,
        "ready", () => h.ready());
      b.disabled = !!v.you.ready;
      /* layout.js counts #ready-count down: the deal advances on its own when it
         hits zero, and a table that does not say so reads as stuck. */
      prompt(`${verdict ? verdict + " " : ""}Next deal starts when everyone is ready — auto in <span id="ready-count">…</span>`);
      return "";
    }
    if (h.nextDeal) button("Next deal", "primary", () => h.nextDeal());
    prompt(verdict);
    return "";
  }

  const act = activeSeat(v);
  prompt(act >= 0 ? `${phaseLabel(v.phase)} — waiting for <b>${name(act)}</b>` : phaseLabel(v.phase));
  return "";
}

export { renderActionBar, resetActionBar, phaseLabel };
