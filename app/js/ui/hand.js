import { $ } from "../util/dom.js";
import { SUIT_NAME, cardName } from "../cards/labels.js";
import { cardEl } from "../cards/deck.js";
import { getPref, setPref } from "../util/prefs.js";
import { sfx } from "./sound.js";

/* Sorted, the hand reads ♠ ♥ ♣ ♦, high to low, whatever order the wire used.
   Alternating the colours is what makes a fanned hand scannable, and a fixed
   order means your ace of hearts is in the same place every single deal —
   the engine's habit of shuffling trump to the end moved it mid-hand. The
   toggle exists because the other order is the one a real hand arrives in. */
const HAND_ORDER = { "♠":0, "♥":1, "♣":2, "♦":3 };

/* The fly-in comes from the dealer's seat, by its position relative to you —
   0 south, 1 west, 2 north, 3 east, the order screens/game.js's POS_CLASS uses. */
const DEAL_ROT = [-6, -26, 2, 26];

/* One number for both the per-card animation-delay and the per-card sound, so
   the cue can never drift off the card it belongs to. The lead is the design's
   (TRUMP.dc.html:853): the cue is the card meeting the felt, not leaving the
   dealer's hand, and an eased .46s flight has covered most of its distance by
   then. The cap is the hand — no view may queue an unbounded pile of timers. */
const DEAL_GAP = 46, DEAL_CUE_LEAD = 120, MAX_DEAL_CUES = 13;

/* Which cards you have turned over, and the deal that answer belongs to:
   a new deal puts the whole hand back face-down. Module-local rather than on
   the view because the server neither knows nor cares which of your own cards
   you have looked at. */
const faceUp = new Set();
let faceUpRound = null;
let dealtRound = null;        // the deal whose fly-in has already played
let sorted = null;            // resolved on first use: reading the pref touches localStorage
let lastHand = [];            // the keys currently in the hand, so the tools can repaint alone
let repaint = null;           // rebound per render — a card tap has no view of its own
let dealCues = [];            // pending sound timers for the deal currently landing

function isSorted() {
  if (sorted === null) sorted = getPref("trump_sort", "1") !== "0";
  return sorted;
}

/* A fresh deal: nothing is face-up, and the cards get thrown at you again.
   Called with no argument (or null) when the *match* restarts, not just the
   deal: solo's next match deals round 1 all over again, so a memo left on
   round 1 would hand the new deal the old match's face-up cards and count its
   fly-in as already played. A null memo can't match any round number, so the
   next render is a fresh deal whatever it is numbered. */
function resetHandFor(roundNumber = null) {
  faceUp.clear();
  cancelDealCues();
  faceUpRound = roundNumber;
  dealtRound = null;
}

/* One cue per card as it arrives. Cancellable because a deal can start while
   the last one is still landing — a rematch, or a quick next-deal — and two
   hands' worth of card sounds playing over each other is just noise. */
function cancelDealCues() {
  for (const t of dealCues) clearTimeout(t);
  dealCues = [];
}
function scheduleDealCues(n) {
  cancelDealCues();
  for (let i = 0; i < Math.min(n, MAX_DEAL_CUES); i++)
    dealCues.push(setTimeout(() => sfx("deal"), DEAL_CUE_LEAD + i * DEAL_GAP));
}

/* Distance is the felt's, not the hand's: the cards come off the dealer's seat,
   which is out on the table. Falls back to a plausible throw rather than zero,
   so a card still arrives from somewhere before the first fitTable(). */
function dealOrigin(pos) {
  const tbl = $("table");
  const r = tbl ? tbl.getBoundingClientRect() : null;
  const w = (r && r.width) || 640, h = (r && r.height) || 360;
  const dx = Math.round(Math.min(420, w * 0.3));
  const dy = Math.round(Math.min(560, h * 0.7));
  return {
    x: pos === 1 ? -dx : pos === 3 ? dx : 0,
    y: pos === 2 ? -dy - 60 : pos === 0 ? -Math.round(dy * 0.5) : -Math.round(dy * 0.92),
    r: DEAL_ROT[pos] || 0,
  };
}

/* Everything about one card that depends on state rather than on which card it
   is. Split out of the build loop because a turn-over has to be applied to the
   *existing* element: the flip is a CSS transition between .down and not, and a
   replaced element has no previous state to transition from. */
function paintCard(el, card, i, hand, ctx, onPlay) {
  const n = hand.length, key = card.suit + card.rank;
  const up = faceUp.has(key);
  const isTrump = !!ctx.trump && card.suit === ctx.trump;
  const isBonus = !!ctx.bonusSuit && card.suit === ctx.bonusSuit && card.rank === 3;
  const isLegal = ctx.legal.has(key);
  const tappable = !up || (ctx.canPlay && isLegal);

  el.classList.toggle("down", !up);
  el.classList.toggle("suit-start", i > 0 && hand[i - 1].suit !== card.suit); // seam between suits
  /* Every mark that names the card waits for the card to be face-up — the gold
     edge and the TRUMP flag are answers to the question a face-down card is
     asking, and giving them away would make turning it over pointless. */
  el.classList.toggle("trumpcard", up && isTrump);
  el.classList.toggle("bonuscard", up && isBonus);
  el.classList.toggle("playable", up && ctx.canPlay && isLegal);
  el.classList.toggle("illegal", up && ctx.canPlay && !isLegal);
  el.classList.toggle("legal-hint", up && ctx.constrained && isLegal);

  let label;
  if (!up) {
    label = `Turn over card ${i + 1} of ${n}`;
    el.removeAttribute("title");
    el.onclick = () => { faceUp.add(key); sfx("flip"); if (repaint) repaint(); };
  } else {
    const notes = [];
    if (isTrump) notes.push("trump");
    if (isBonus) notes.push("bonus 30");
    label = cardName(card) + (notes.length ? ` (${notes.join(", ")})` : "");
    el.onclick = null;
    el.removeAttribute("title");
    if (ctx.canPlay && isLegal) {
      label = "Play " + label;
      el.onclick = () => onPlay(card);
    } else if (ctx.canPlay) {
      // grayscale says "not this one"; only the title says why
      el.title = label = `${label} — you must follow ${SUIT_NAME[ctx.leadSuit] || ctx.leadSuit}`;
    }
  }
  el.setAttribute("aria-label", label);
  // still focusable when inert, so the hand can be read out on someone else's turn
  el.setAttribute("aria-disabled", tappable ? "false" : "true");
  el.dataset.k = key;

  /* One label for the whole trump run, on its middle card: thirteen cards each
     shouting TRUMP is noise, and the gold edge already marks the rest. */
  const text = !up ? "" : isBonus ? "+30" : i === ctx.trumpTagAt ? "TRUMP" : "";
  let tag = el.querySelector(".tag");
  if (text) {
    if (!tag) { tag = document.createElement("span"); el.appendChild(tag); }
    tag.className = "tag" + (isBonus ? " bonus" : "");
    tag.textContent = text;
  } else if (tag) tag.remove();
}

function renderHand(view, onPlay) {
  const wrap = $("my-hand");
  const you = view.you || {};
  if (view.roundNumber !== faceUpRound) resetHandFor(view.roundNumber);
  repaint = () => renderHand(view, onPlay);

  const raw = (you.hand || []).slice();
  const hand = isSorted()
    ? raw.sort((a, b) => (HAND_ORDER[a.suit] - HAND_ORDER[b.suit]) || (b.rank - a.rank))
    : raw;
  const n = hand.length;
  lastHand = hand.map(c => c.suit + c.rank);
  const canPlay = !!you.toAct && you.actKind === "play";
  const legal = new Set((canPlay ? (you.legal || []) : []).map(x => x.suit + x.rank));
  /* The playable set is only worth highlighting when something is actually
     constraining it — outlining all thirteen teaches nothing. */
  const constrained = canPlay && legal.size < n;
  const trumpRun = [];
  hand.forEach((c, i) => {
    if (view.trump && c.suit === view.trump && !(c.rank === 3 && c.suit === view.bonusSuit)) trumpRun.push(i);
  });
  const ctx = { canPlay, legal, constrained, trump: view.trump, bonusSuit: view.bonusSuit,
                leadSuit: view.leadSuit, trumpTagAt: trumpRun.length ? trumpRun[Math.floor(trumpRun.length / 2)] : -1 };

  /* Rebuilding the hand blows away keyboard focus, and a state message arrives
     for every action at the table — including other people's chat. Skip the
     rebuild when nothing about the hand changed, and when it does change put
     focus back on the same card (or its position) instead of dropping the user
     out to <body> mid-turn. Which cards are face-up is in the signature too, or
     turning one over would not repaint at all. */
  const struct = JSON.stringify([lastHand, canPlay, [...legal].sort(),
                                 view.trump, view.bonusSuit, view.leadSuit, view.roundNumber]);
  const sig = struct + "|" + lastHand.map(k => faceUp.has(k) ? 1 : 0).join("");
  if (wrap._sig === sig) return;
  const inPlace = wrap._struct === struct && wrap.children.length === n;
  wrap._sig = sig;
  wrap._struct = struct;
  if (inPlace) {
    // only the face-up set moved: repaint the existing elements so the turn-over
    // has a previous state to transition from, and focus never leaves the card
    hand.forEach((card, i) => paintCard(wrap.children[i], card, i, hand, ctx, onPlay));
    syncTools();
    return;
  }

  const active = document.activeElement;
  const hadFocus = active && wrap.contains(active);
  const focusKey = hadFocus ? active.dataset.k : null;
  const focusIdx = hadFocus ? Array.prototype.indexOf.call(wrap.children, active) : -1;
  wrap.innerHTML = "";

  const fresh = n > 0 && dealtRound !== view.roundNumber;
  const from = fresh ? dealOrigin(((view.dealer - (you.seat || 0)) + 4) % 4) : null;
  hand.forEach((card, i) => {
    const el = cardEl(card, true);              // real <button>: Tab to reach it, Enter/Space to play
    paintCard(el, card, i, hand, ctx, onPlay);
    /* Fan the hand: --rot/--dy are composed with --lift in one CSS transform, so a
       hover or focus lift can't flatten the arc (and the arc can't cancel the lift). */
    const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;      // -1 … +1 across the hand
    el.style.setProperty("--rot", (t * 6).toFixed(2) + "deg");
    el.style.setProperty("--dy", (t * t * 8).toFixed(1) + "px");
    if (fresh) {
      el.style.setProperty("--dfx", from.x + "px");
      el.style.setProperty("--dfy", from.y + "px");
      el.style.setProperty("--dfr", from.r + "deg");
      el.style.animationDelay = (i * DEAL_GAP) + "ms";
    } else {
      /* Every rebuild creates fresh elements, and #my-hand .card animates in
         unconditionally — so without this, playing one card would deal the
         other twelve all over again. */
      el.style.animation = "none";
    }
    wrap.appendChild(el);
  });
  if (fresh) { dealtRound = view.roundNumber; scheduleDealCues(n); }
  fitHand(wrap);
  syncTools();

  if (hadFocus && wrap.children.length) {
    let target = null;
    for (const el of wrap.children) if (el.dataset.k === focusKey) { target = el; break; }
    if (!target) target = wrap.children[Math.min(Math.max(focusIdx, 0), wrap.children.length - 1)];
    target.focus();
  }
}

/* Thirteen cards at the CSS overlap are ~564px wide — wider than any phone, and a
   grid track's `auto` minimum is min-content, so the oversized hand used to stretch
   column 1 and push the header and the felt off screen. Tighten the overlap only as
   far as the width actually demands, and never past 16px of each card showing.
   --ml-base/--seam are read back off the element because responsive.css moves them
   per breakpoint; keeping a second copy of those numbers here is how they drift. */
function fitHand(wrap) {
  const n = wrap.children.length;
  if (!n) return;
  const cs = getComputedStyle(wrap);
  const base = parseFloat(cs.getPropertyValue("--ml-base")) || -22;
  const seam = parseFloat(cs.getPropertyValue("--seam")) || 16;
  const cw = wrap.children[0].offsetWidth;              // layout width: transforms don't count
  /* …which is exactly why the budget has to allow for them: the outermost cards are
     rotated ~6deg about an origin below the card, so each end reaches about
     height*sin(6deg) further out than its layout box. */
  const slop = Math.ceil(wrap.children[0].offsetHeight * 0.25) + 12;
  const avail = wrap.clientWidth - slop;
  if (!cw || avail <= 0) return;                        // not laid out yet
  let ml = base;
  if (n > 1) {
    let seams = 0;
    for (const el of wrap.children) if (el.classList.contains("suit-start")) seams++;
    ml = Math.min(base, (avail - cw - seams * seam) / (n - 1) - cw);
    /* Never hide more than this: the exposed sliver carries the corner index and is
       the card's only reliable tap target, since the next card paints over the rest. */
    ml = Math.max(ml, -(cw - 20));
  }
  wrap.style.setProperty("--ml", ml.toFixed(2) + "px");
}

/* The two buttons above the hand. Their lit state is a function of the hand, so
   it is repainted from renderHand as well as from the clicks themselves. */
function syncTools() {
  const tools = $("hand-tools");
  if (!tools) return;
  tools.classList.toggle("show", lastHand.length > 0);
  const down = lastHand.filter(k => !faceUp.has(k)).length;
  const flip = $("btn-flip"), sort = $("btn-sort");
  if (flip) {
    flip.classList.toggle("on", down > 0);
    const t = down ? `Turn over all ${down} face-down card${down === 1 ? "" : "s"}` : "Turn every card face-down";
    flip.setAttribute("aria-label", t);
    flip.title = t;
  }
  if (sort) {
    sort.classList.toggle("on", isSorted());
    sort.setAttribute("aria-pressed", String(isSorted()));
  }
}

/* Neither toggle means anything to the server, so both repaint locally through
   onChange rather than waiting for a state message that will never arrive. */
function initHandTools(onChange) {
  const flip = $("btn-flip"), sort = $("btn-sort");
  if (flip) flip.onclick = () => {
    // one button, two jobs: turn the rest of the hand over, or — once it is all
    // face-up — put it back down, which is the only way to get the ritual back
    const anyDown = lastHand.some(k => !faceUp.has(k));
    faceUp.clear();
    if (anyDown) for (const k of lastHand) faceUp.add(k);
    sfx("flip");
    syncTools();
    if (onChange) onChange();
  };
  if (sort) sort.onclick = () => {
    sorted = !isSorted();
    setPref("trump_sort", sorted ? "1" : "0");
    syncTools();
    if (onChange) onChange();
  };
  syncTools();
}

export { renderHand, fitHand, initHandTools, resetHandFor };
