import { test } from "node:test";
import assert from "node:assert/strict";
import { rankLabel, cardStr, cardName, SUIT_KEY, SUIT_PATH } from "../app/js/cards/labels.js";
import { cardFace } from "../app/js/cards/deck.js";

// Independent of labels.js's own SUIT_NAME/RANK_NAME/SUIT_KEY tables: importing
// those to build the expected value would be tautological if the table itself
// were wrong (e.g. two suits' words swapped), since both sides of the assertion
// would read the identical broken entry. Pinned here instead, from the real
// cardName format (`${RANK_NAME[rank] || rank} of ${SUIT_NAME[suit]}`, checked
// against app/js/cards/labels.js) and the real CSS suit-key convention.
const SUIT_WORD = { "♠": "spades", "♥": "hearts", "♦": "diamonds", "♣": "clubs" };
const RANK_WORD = { 14: "ace", 13: "king", 12: "queen", 11: "jack" };
const SUIT_CLASS = { "♠": "s", "♥": "h", "♦": "d", "♣": "c" };

test("rank labels cover courts and pips", () => {
  assert.equal(rankLabel(14), "A");
  assert.equal(rankLabel(13), "K");
  assert.equal(rankLabel(12), "Q");
  assert.equal(rankLabel(11), "J");
  for (let r = 2; r <= 10; r++) assert.equal(rankLabel(r), String(r));
});

test("cardStr and cardName agree on every card in the deck", () => {
  for (const suit of ["♠", "♥", "♦", "♣"]) {
    // an equality check, not a truthy one: a table mapping every suit to the
    // same key would pass `assert.ok(SUIT_KEY[suit], ...)` but is still wrong
    assert.equal(SUIT_KEY[suit], SUIT_CLASS[suit], `wrong CSS key for ${suit}`);
    for (let rank = 2; rank <= 14; rank++) {
      assert.equal(cardStr({ suit, rank }), rankLabel(rank) + suit);
      const name = cardName({ suit, rank });
      // exact equality against the independent oracle above, not just a check
      // that " of " appears — "2 of diamonds" for a ♥ 2 (a hearts/diamonds
      // swap in SUIT_NAME) would satisfy a bare /  of  / test identically
      assert.equal(name, `${RANK_WORD[rank] || rank} of ${SUIT_WORD[suit]}`,
        `wrong screen-reader name for ${rank}${suit}: ${name}`);
    }
  }
});

test("cardFace draws every card without throwing, and marks its suit", () => {
  // cardFace has no CSS class to check (that's cardEl's job) — the only real
  // suit signal in its output is the suit's own pip geometry, so assert that
  // verbatim rather than a single-letter SUIT_KEY, which recurs by accident
  // in every card's boilerplate (aria-hidden, font-size, scale, translate...)
  // regardless of suit and so would never actually catch a swapped suit.
  for (const suit of ["♠", "♥", "♦", "♣"]) {
    for (let rank = 2; rank <= 14; rank++) {
      const svg = cardFace({ suit, rank });
      assert.ok(typeof svg === "string" && svg.length > 0, `empty face for ${rank}${suit}`);
      assert.ok(svg.includes(SUIT_PATH[suit]), `${rank}${suit} does not draw the ${suit} pip shape`);
    }
  }
});
