/* A card's name has one definition, shared with the server and the solo game.
   The rest of this file is display-layer only: markup, CSS keys, and the
   screen-reader spellings the engine has no reason to know about. */
import { SUITS, rankLabel, cardStr } from "../core/engine/index.js";
export { SUITS, rankLabel, cardStr };

import { esc } from "../util/dom.js";

const RED = new Set(["♥","♦"]);

// ---------- card elements ----------
const SUIT_KEY = { "♠":"s", "♥":"h", "♦":"d", "♣":"c" };
const SUIT_NAME = { "♠":"spades", "♥":"hearts", "♦":"diamonds", "♣":"clubs" };
const RANK_NAME = { 14:"ace", 13:"king", 12:"queen", 11:"jack" };
const cardName = c => `${RANK_NAME[c.rank] || c.rank} of ${SUIT_NAME[c.suit] || c.suit}`;

/* ---------- the deck ----------
   Suits are drawn, never typed. ♠♥♦♣ are font glyphs: every OS ships a
   different one, none of them match the proportions of a real pip, and they
   are the single biggest reason a web card game reads as clip-art.
   Each path is authored in a 100×100 box and placed by transform. */
const SUIT_PATH = {
  "♠": "M50 6s-28 26-36 41c-8 15-3 30 12 32 10 2 18-3 22-11 0 0-2 14-14 24h32c-12-10-14-24-14-24 4 8 12 13 22 11 15-2 20-17 12-32C78 32 50 6 50 6Z",
  "♥": "M50 90S10 62 10 36c0-15 11-25 23-25 9 0 15 5 17 11 2-6 8-11 17-11 12 0 23 10 23 25 0 26-40 54-40 54Z",
  "♦": "M50 3 86 50 50 97 14 50Z",
  "♣": "M50 4c-11 0-20 9-20 20 0 4 1 8 3 11-3-2-7-3-11-3C11 32 2 41 2 52s9 20 20 20c9 0 16-5 19-13 0 0 0 15-12 33h42c-12-18-12-33-12-33 3 8 10 13 19 13 11 0 20-9 20-20s-9-20-20-20c-4 0-8 1-11 3 2-3 3-7 3-11 0-11-9-20-20-20Z",
};
/* A suit named inside a sentence, a chip, or a button. */
function suitSvg(s) {
  return SUIT_PATH[s] ? `<svg class="su" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="${SUIT_PATH[s]}"/></svg>` : "";
}

// suit colours come from CSS classes (not inline styles) so the 4-colour deck can override them
function suitSpan(s) { return s ? `<span class="sc s-${SUIT_KEY[s]}">${suitSvg(s)}</span>` : ""; }
function cardSpan(c) { return c ? `<span class="sc s-${SUIT_KEY[c.suit]}">${rankLabel(c.rank)}${suitSvg(c.suit)}</span>` : ""; }
/* The core writes card names as text ("plays K♦"); swap the glyph for the drawn
   pip so a card reads the same in the log as it does on the felt. */
function textWithCards(t) {
  return esc(t).replace(/([AKQJ0-9]{1,2}|10)([♠♥♦♣])/g, (m, r, s) => `<span class="sc s-${SUIT_KEY[s]}">${r}${suitSvg(s)}</span>`);
}

export { RED, SUIT_KEY, SUIT_NAME, RANK_NAME, cardName, SUIT_PATH, suitSvg, suitSpan, cardSpan, textWithCards };
