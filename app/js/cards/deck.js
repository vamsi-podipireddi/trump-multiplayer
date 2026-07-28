import { RED, SUIT_KEY, rankLabel, SUIT_PATH } from "./labels.js";

const suitPath = (s, cx, cy, size, flip) =>
  `<path d="${SUIT_PATH[s]}" transform="translate(${cx} ${cy})${flip ? " rotate(180)" : ""} scale(${(size / 100).toFixed(4)}) translate(-50 -50)"/>`;

/* Pip layouts, normalised: column 0 = left, .5 = centre, 1 = right; row 0 = top,
   1 = bottom. Anything below the midline prints upside down, as on a real card.
   This table is the whole difference between a deck and 52 copies of one symbol. */
const PIP_LAYOUT = {
  2:  [[.5,0],[.5,1]],
  3:  [[.5,0],[.5,.5],[.5,1]],
  4:  [[0,0],[1,0],[0,1],[1,1]],
  5:  [[0,0],[1,0],[.5,.5],[0,1],[1,1]],
  6:  [[0,0],[1,0],[0,.5],[1,.5],[0,1],[1,1]],
  7:  [[0,0],[1,0],[.5,.25],[0,.5],[1,.5],[0,1],[1,1]],
  8:  [[0,0],[1,0],[.5,.25],[0,.5],[1,.5],[.5,.75],[0,1],[1,1]],
  9:  [[0,0],[1,0],[0,1/3],[1,1/3],[.5,.5],[0,2/3],[1,2/3],[0,1],[1,1]],
  10: [[0,0],[1,0],[.5,1/6],[0,1/3],[1,1/3],[0,2/3],[1,2/3],[.5,5/6],[0,1],[1,1]],
};
const COL = [78, 120, 162], ROW_TOP = 68, ROW_BOT = 268, PIP_SIZE = 46;

/* Court cards. Stylised rather than a bad copy of the Rouen pattern, but built
   the way a real court is: a framed panel, a half figure, and the same figure
   rotated 180° about the middle — which is why you can hold the card either way up. */
function courtFigure(rank) {
  /* Mostly card stock with the suit's colour kept to the garment and the crown.
     A court drawn as a solid silhouette turns into an ink blot at the 40px each
     half actually gets in a hand. */
  const robe = `<path class="cs" d="M58 168v-14c0-17 15-26 36-29h52c21 3 36 12 36 29v14Z"/>` +
               `<path class="cl" d="M58 168v-14c0-17 15-26 36-29h52c21 3 36 12 36 29"/>`;
  const mantle = `<path fill="currentColor" d="M94 125 120 150 146 125 154 168H86Z"/>` +
                 `<path class="cl" d="M94 125 120 150 146 125"/>`;
  const neck = `<path class="cs" d="M110 114h20v20h-20Z"/><path class="cl" d="M110 114v20M130 114v20"/>`;
  const face = `<path class="cs" d="M98 76h44v26a22 22 0 0 1-44 0Z"/><path class="cl" d="M98 76h44v26a22 22 0 0 1-44 0Z"/>`;
  const eyes = `<path class="cl" stroke-width="3.2" stroke-linecap="round" d="M107 92h9M124 92h9"/>`;
  if (rank === 13) return (                                     // King — crown, beard, a raised sword
    `<path class="ci" d="M66 134V83l6-13 6 13v51Z"/><rect class="ci" x="57" y="96" width="30" height="6" rx="3"/>` +
    robe + mantle + neck + face + eyes +
    `<path class="ci" d="M99 105c1 15 10 25 21 25s20-10 21-25c-5 7-12 11-21 11s-16-4-21-11Z"/>` +
    `<path fill="currentColor" d="M96 76V47l13 12 11-18 11 18 13-12v29Z"/><path class="cl" d="M96 76V47l13 12 11-18 11 18 13-12v29Z"/>` +
    `<rect class="ci" x="94" y="71" width="52" height="8" rx="4"/>` +
    `<circle class="cs" cx="109" cy="58" r="3"/><circle class="cs" cx="120" cy="49" r="3"/><circle class="cs" cx="131" cy="58" r="3"/>`
  );
  if (rank === 12) return (                                     // Queen — coronet, long hair, a rose
    `<path class="ci" d="M169 126h6v26h-6Z"/><circle fill="currentColor" cx="172" cy="118" r="11"/>` +
    `<circle class="cs" cx="172" cy="118" r="4"/><path class="cl" d="M172 107a11 11 0 1 1 0 22 11 11 0 0 1 0-22Z"/>` +
    robe + mantle + neck +
    `<path class="ci" d="M97 82c-9 9-11 27-8 41l13 3c-4-14-6-30-5-44Z"/>` +
    `<path class="ci" d="M143 82c9 9 11 27 8 41l-13 3c4-14 6-30 5-44Z"/>` + face + eyes +
    `<path fill="currentColor" d="M98 76V53l11 10 11-15 11 15 11-10v23Z"/><path class="cl" d="M98 76V53l11 10 11-15 11 15 11-10v23Z"/>` +
    `<rect class="ci" x="96" y="71" width="48" height="7" rx="3.5"/><circle class="cs" cx="120" cy="52" r="3"/>`
  );
  return (                                                      // Jack — plumed cap, halberd
    `<path class="ci" d="M70 140V88h7v52Z"/><path class="ci" d="M62 74 86 81 73 94Z"/>` +
    robe + mantle + neck + face + eyes +
    `<path fill="currentColor" d="M144 60c15-9 20-5 28-17-2 19-13 30-28 30Z"/><path class="cl" d="M144 60c15-9 20-5 28-17-2 19-13 30-28 30"/>` +
    `<path fill="currentColor" d="M96 76c0-21 10-31 24-31s24 10 24 31Z"/><path class="cl" d="M96 76c0-21 10-31 24-31s24 10 24 31"/>` +
    `<rect class="ci" x="94" y="71" width="52" height="8" rx="4"/>`
  );
}

/* `compact` is the 44px call-partner card: a full pip layout is illegible at
   that size, so it gets the index and one centred pip — which is what a real
   card shows through a fanned hand anyway. */
function cardFace(card, compact) {
  const s = card.suit, r = rankLabel(card.rank);
  const idx = `<text x="32" y="60" text-anchor="middle" font-size="${r === "10" ? 39 : 48}">${r}</text>` +
              suitPath(s, 32, 87, 30);
  let body;
  if (compact) body = suitPath(s, 120, 200, 96);
  else if (card.rank >= 11 && card.rank <= 13) {
    body = `<rect class="cfr" x="44" y="42" width="152" height="252" rx="10"/><path class="cfr" d="M44 168h152"/>` +
           `<g>${courtFigure(card.rank)}</g>` +
           `<g transform="rotate(180 120 168)">${courtFigure(card.rank)}</g>`;
  } else if (card.rank === 14) {
    body = (s === "♠" ? `<path class="cfr" d="M120 74 174 168 120 262 66 168Z"/>` : "") + suitPath(s, 120, 168, s === "♠" ? 112 : 104);
  } else {
    body = (PIP_LAYOUT[card.rank] || []).map(([cx, cy]) =>
      suitPath(s, COL[cx * 2], ROW_TOP + cy * (ROW_BOT - ROW_TOP), PIP_SIZE, cy > .5)).join("");
  }
  return `<svg viewBox="0 0 240 336" fill="currentColor" aria-hidden="true">${idx}${body}` +
         `<g transform="rotate(180 120 168)">${idx}</g></svg>`;
}

/* `asButton` gives keyboard users a real focusable control instead of a clickable div. */
function cardEl(card, asButton) {
  const el = document.createElement(asButton ? "button" : "div");
  if (asButton) el.type = "button";
  el.className = "card s-" + SUIT_KEY[card.suit] + (RED.has(card.suit) ? " red" : "");
  el.innerHTML = cardFace(card);
  if (!asButton) el.setAttribute("aria-hidden", "true"); // table furniture; the log narrates play
  return el;
}

export { suitPath, courtFigure, cardFace, cardEl, COL, ROW_TOP, ROW_BOT, PIP_SIZE };
