import { S } from "../session.js";
import { $ } from "../util/dom.js";
import { SUIT_NAME, cardName } from "../cards/labels.js";
import { cardEl } from "../cards/deck.js";
import { send } from "../net.js";

/* The hand always reads ♠ ♥ ♣ ♦, high to low, whatever order the wire used.
   Alternating the colours is what makes a fanned hand scannable, and a fixed
   order means your ace of hearts is in the same place every single deal —
   the engine's habit of shuffling trump to the end moved it mid-hand. */
const HAND_ORDER = { "♠":0, "♥":1, "♣":2, "♦":3 };
function renderHand() {
  const wrap = $("my-hand");
  const hand = ((S.view.you && S.view.you.hand) || []).slice()
    .sort((a, b) => (HAND_ORDER[a.suit] - HAND_ORDER[b.suit]) || (b.rank - a.rank));
  const canPlay = S.view.you.toAct && S.view.you.actKind === "play";
  const legalKey = new Set((canPlay ? (S.view.you.legal || []) : []).map(x => x.suit + x.rank));

  /* Rebuilding the hand blows away keyboard focus, and a state message arrives
     for every action at the table — including other people's chat. Skip the
     rebuild when nothing about the hand changed, and when it does change put
     focus back on the same card (or its position) instead of dropping the user
     out to <body> mid-turn. */
  const sig = JSON.stringify([hand.map(c => c.suit + c.rank), canPlay, [...legalKey].sort(),
                              S.view.trump, S.view.bonusSuit, S.view.leadSuit]);
  if (wrap._sig === sig) return;
  wrap._sig = sig;
  const active = document.activeElement;
  const hadFocus = active && wrap.contains(active);
  const focusKey = hadFocus ? active.dataset.k : null;
  const focusIdx = hadFocus ? Array.prototype.indexOf.call(wrap.children, active) : -1;
  wrap.innerHTML = "";

  hand.forEach((card, i) => {
    const el = cardEl(card, true);              // real <button>: Tab to reach it, Enter/Space to play
    if (i > 0 && hand[i - 1].suit !== card.suit) el.classList.add("suit-start"); // seam between suits
    const notes = [];
    if (S.view.trump && card.suit === S.view.trump) { el.classList.add("trumpcard"); notes.push("trump"); }
    if (S.view.bonusSuit && card.suit === S.view.bonusSuit && card.rank === 3) { el.classList.add("bonuscard"); notes.push("bonus 30 points"); }
    let label = cardName(card) + (notes.length ? ` (${notes.join(", ")})` : "");
    if (canPlay) {
      if (legalKey.has(card.suit + card.rank)) {
        el.classList.add("playable"); el.onclick = () => send({ type: "play", card });
        label = "Play " + label;
      } else {
        el.classList.add("illegal");
        el.setAttribute("aria-disabled", "true");
        el.title = label = `${label} — you must follow ${SUIT_NAME[S.view.leadSuit] || S.view.leadSuit}`;
      }
    } else {
      // still focusable (so the hand can be read out) but inert
      el.setAttribute("aria-disabled", "true");
    }
    el.setAttribute("aria-label", label);
    el.dataset.k = card.suit + card.rank;
    wrap.appendChild(el);
  });

  /* Fan the hand: --rot/--dy are composed with --lift in one CSS transform, so a
     hover or focus lift can't flatten the arc (and the arc can't cancel the lift). */
  const n = wrap.children.length;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;      // -1 … +1 across the hand
    wrap.children[i].style.setProperty("--rot", (t * 7).toFixed(2) + "deg");
    wrap.children[i].style.setProperty("--dy", (t * t * 6).toFixed(1) + "px");
  }
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
   far as the width actually demands, and never past 16px of each card showing. */
function fitHand(wrap) {
  const n = wrap.children.length;
  if (!n) return;
  const cs = getComputedStyle(wrap);
  const base = parseFloat(cs.getPropertyValue("--ml-base")) || -22;
  const seam = parseFloat(cs.getPropertyValue("--seam")) || 16;
  const cw = wrap.children[0].offsetWidth;              // layout width: transforms don't count
  /* …which is exactly why the budget has to allow for them: the outermost cards are
     rotated ~7deg about an origin below the card, so each end reaches about
     height*sin(7deg) further out than its layout box. */
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

export { renderHand, fitHand };
