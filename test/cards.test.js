import { test } from "node:test";
import assert from "node:assert/strict";
import { rankLabel, cardStr, cardName, SUIT_KEY, SUIT_PATH } from "../app/js/cards/labels.js";
import { cardFace } from "../app/js/cards/deck.js";

test("rank labels cover courts and pips", () => {
  assert.equal(rankLabel(14), "A");
  assert.equal(rankLabel(13), "K");
  assert.equal(rankLabel(12), "Q");
  assert.equal(rankLabel(11), "J");
  for (let r = 2; r <= 10; r++) assert.equal(rankLabel(r), String(r));
});

test("cardStr and cardName agree on every card in the deck", () => {
  for (const suit of ["♠", "♥", "♦", "♣"]) {
    assert.ok(SUIT_KEY[suit], `no CSS key for ${suit}`);
    for (let rank = 2; rank <= 14; rank++) {
      assert.equal(cardStr({ suit, rank }), rankLabel(rank) + suit);
      const name = cardName({ suit, rank });
      assert.ok(/ of /.test(name), `unreadable screen-reader name: ${name}`);
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
