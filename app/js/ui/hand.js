import { $ } from "../util/dom.js";
import { SUIT_NAME, cardName } from "../cards/labels.js";
import { cardEl } from "../cards/deck.js";
import { sfx } from "./sound.js";

/* The hand reads ♠ ♥ ♣ ♦, high to low, whatever order the wire used.
   Alternating the colours is what makes a fanned hand scannable, and a fixed
   order means your ace of hearts is in the same place every single deal —
   the engine's habit of shuffling trump to the end moved it mid-hand. */
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

let dealtRound = null;        // the deal whose fly-in has already played
let dealCues = [];            // pending sound timers for the deal currently landing

/* A fresh deal: the cards get thrown at you again. Called with no argument when
   the *match* restarts, not just the deal — solo's next match deals round 1 all
   over again, and a memo left on round 1 would count the new deal's fly-in as
   already played. */
function resetHandFor() {
  cancelDealCues();
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
   is. Split out of the build loop so a change of turn repaints the existing
   elements instead of replacing them — a replaced card has no previous state to
   transition its lift and its glow from, and loses keyboard focus with it. */
function paintCard(el, card, i, hand, ctx, onPlay) {
  const key = card.suit + card.rank;
  const isTrump = !!ctx.trump && card.suit === ctx.trump;
  const isBonus = !!ctx.bonusSuit && card.suit === ctx.bonusSuit && card.rank === 3;
  const isLegal = ctx.legal.has(key);

  el.classList.toggle("suit-start", i > 0 && hand[i - 1].suit !== card.suit); // seam between suits
  /* The two cards worth naming are lit rather than labelled — table.css owns
     both blooms; nothing here writes a word onto a card. */
  el.classList.toggle("trumpcard", isTrump);
  el.classList.toggle("bonuscard", isBonus);
  el.classList.toggle("playable", ctx.canPlay && isLegal);
  el.classList.toggle("illegal", ctx.canPlay && !isLegal);
  el.classList.toggle("legal-hint", ctx.constrained && isLegal);

  const notes = [];
  if (isTrump) notes.push("trump");
  if (isBonus) notes.push("bonus 30");
  let label = cardName(card) + (notes.length ? ` (${notes.join(", ")})` : "");
  el.onclick = null;
  el.removeAttribute("title");
  if (ctx.canPlay && isLegal) {
    label = "Play " + label;
    el.onclick = () => onPlay(card);
  } else if (ctx.canPlay) {
    // grayscale says "not this one"; only the title says why
    el.title = label = `${label} — you must follow ${SUIT_NAME[ctx.leadSuit] || ctx.leadSuit}`;
  }
  el.setAttribute("aria-label", label);
  // still focusable when inert, so the hand can be read out on someone else's turn
  el.setAttribute("aria-disabled", ctx.canPlay && isLegal ? "false" : "true");
  el.dataset.k = key;
}

function renderHand(view, onPlay) {
  const wrap = $("my-hand");
  const you = view.you || {};

  const hand = (you.hand || []).slice()
    .sort((a, b) => (HAND_ORDER[a.suit] - HAND_ORDER[b.suit]) || (b.rank - a.rank));
  const n = hand.length;
  const keys = hand.map(c => c.suit + c.rank);
  const canPlay = !!you.toAct && you.actKind === "play";
  const legal = new Set((canPlay ? (you.legal || []) : []).map(x => x.suit + x.rank));
  /* The playable set is only worth highlighting when something is actually
     constraining it — outlining all thirteen teaches nothing. */
  const constrained = canPlay && legal.size < n;
  const ctx = { canPlay, legal, constrained, trump: view.trump, bonusSuit: view.bonusSuit,
                leadSuit: view.leadSuit };

  /* Rebuilding the hand blows away keyboard focus, and a state message arrives
     for every action at the table — including other people's chat. Skip the
     rebuild when nothing about the hand changed, and when it does change put
     focus back on the same card (or its position) instead of dropping the user
     out to <body> mid-turn. */
  const held = JSON.stringify(keys);
  const sig = held + "|" + JSON.stringify([canPlay, [...legal].sort(),
                                           view.trump, view.bonusSuit, view.leadSuit, view.roundNumber]);
  if (wrap._sig === sig) return;
  /* The same cards under a new turn: repaint them in place rather than replacing
     them, so the lift and the glow have a previous state to transition from and
     focus never leaves the card it is on. */
  const inPlace = wrap._held === held && wrap.children.length === n;
  wrap._sig = sig;
  wrap._held = held;
  if (inPlace) {
    hand.forEach((card, i) => paintCard(wrap.children[i], card, i, hand, ctx, onPlay));
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

export { renderHand, fitHand, resetHandFor };
