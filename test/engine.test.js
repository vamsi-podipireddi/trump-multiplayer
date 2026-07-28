/* Engine invariants: random + AI-driven full-match playouts, rule edges.
   Pure engine, no I/O — every playout must satisfy the deck/trick/score laws. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../app/js/core/engine/index.js";
import * as R from "../room.js";

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

function randomAction(G) {
  const ra = E.requiredActor(G);
  assert.ok(ra, `requiredActor null in phase ${G.phase}`);
  if (ra.kind === "bid") {
    const lo = E.minNextBid(G);
    if (lo > E.MAX_BID || Math.random() < 0.6) return { type: "bid", value: null };
    const value = Math.min(E.MAX_BID, lo + E.BID_STEP * rnd(3));
    return { type: "bid", value };
  }
  if (ra.kind === "trump") return { type: "trump", suit: pick(E.SUITS) };
  if (ra.kind === "call") return { type: "call", card: pick(E.callableCards(G, ra.seat)) };
  if (ra.kind === "play") return { type: "play", card: pick(E.legalCards(G, ra.seat)) };
  assert.fail(`unknown action kind ${ra.kind}`);
}

function applyChecked(G, seat, act) {
  if (act.type === "bid") {
    assert.equal(E.bidIsLegal(G, seat, act.value), true, `bid ${act.value} must be legal`);
    E.applyBid(G, seat, act.value);
  } else if (act.type === "trump") {
    E.applyTrump(G, act.suit);
  } else if (act.type === "call") {
    assert.equal(E.callIsLegal(G, act.card), true, "call must be legal");
    // called card must not be in declarer's hand
    assert.ok(!G.hands[G.declarer].some(c => E.sameCard(c, act.card)));
    E.applyCall(G, act.card);
    // partner (unless self via safety) must actually hold the called card
    if (G.partner !== G.declarer)
      assert.ok(G.hands[G.partner].some(c => E.sameCard(c, act.card)), "partner holds called card");
  } else if (act.type === "play") {
    const hand = G.hands[seat];
    const legal = E.legalCards(G, seat);
    assert.ok(legal.every(c => hand.some(h => E.sameCard(h, c))), "legal ⊆ hand");
    if (G.trick.length > 0 && hand.some(c => c.suit === G.leadSuit))
      assert.ok(legal.every(c => c.suit === G.leadSuit), "must follow suit");
    assert.equal(E.playIsLegal(G, seat, act.card), true, "play must be legal");
    E.applyPlay(G, seat, act.card);
  }
}

/* Drive one full match with the given action chooser; assert invariants throughout. */
function playMatch(chooser, maxSteps = 200000) {
  const G = E.createMatch();
  E.startMatch(G);
  let scoresBefore = G.scores.slice();
  let tricksThisDeal = 0;
  assert.ok(G.hands.every(h => h.length === 13), "13 cards each after deal");

  for (let step = 0; step < maxSteps; step++) {
    if (G.phase === "trickEnd") {
      E.advanceTrick(G);
      tricksThisDeal++;
      continue;
    }
    if (G.phase === "roundEnd" || G.phase === "matchOver") {
      assert.equal(tricksThisDeal, 13, "13 tricks per deal");
      const captured = G.capturedPoints.reduce((a, b) => a + b, 0);
      assert.equal(captured, E.TOTAL_POINTS, "all 250 points captured");
      const r = G.lastResult;
      assert.ok(r, "lastResult set");
      assert.equal(r.winners.length, 2, "two winners per deal");
      for (let s = 0; s < 4; s++) {
        const want = scoresBefore[s] + (r.winners.includes(s) ? 1 : 0);
        assert.equal(G.scores[s], want, `seat ${s} score delta`);
      }
      const dPts = G.capturedPoints[r.declarer] + G.capturedPoints[r.partner];
      assert.equal(r.made, dPts >= r.bid, "made iff captured >= bid");
      if (G.phase === "matchOver") {
        assert.ok(G.scores.some(s => s >= E.TARGET_GAMES), "someone reached target");
        return G;
      }
      scoresBefore = G.scores.slice();
      E.nextDeal(G);
      tricksThisDeal = 0;
      assert.ok(G.hands.every(h => h.length === 13), "13 cards each after next deal");
      continue;
    }
    const ra = E.requiredActor(G);
    assert.ok(ra, `no actor in phase ${G.phase}`);
    applyChecked(G, ra.seat, chooser(G, ra));
  }
  assert.fail("match did not terminate within step budget");
}

/* The deal must not come off Math.random. V8's generator is xorshift128+ and its
   state is recoverable from a handful of outputs — and a player observes plenty
   of them, since the cards they are dealt *are* the output. Sharing that stream
   would leak future deals and (via room.js) other players' session tokens.
   Pinning Math.random to a constant is the sharpest test available: anything
   still drawing from it degenerates, anything on the CSPRNG is unaffected. */
test("dealing and token minting never draw on Math.random", () => {
  const real = Math.random;
  Math.random = () => 0.42;
  try {
    const deals = new Set(), dealers = new Set(), bonuses = new Set();
    for (let i = 0; i < 40; i++) {
      const G = E.createMatch();
      E.startMatch(G);
      deals.add(G.hands.map(h => h.map(c => c.suit + c.rank).join(",")).join("|"));
      dealers.add(G.dealer);
      bonuses.add(G.bonusSuit);
    }
    assert.equal(deals.size, 40, "every shuffle must be distinct with Math.random pinned");
    assert.ok(dealers.size > 1, "the opening dealer must not be predictable either");
    assert.ok(bonuses.size > 1, "nor the bonus suit");

    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(R.randId(16, false));
    assert.equal(ids.size, 200, "playerId is a bearer token — it must come off the CSPRNG");
    const codes = new Set();
    for (let i = 0; i < 200; i++) codes.add(R.randId(8, true));
    assert.equal(codes.size, 200, "private room codes are secrets too");

    // the explicit-rng escape hatch is still honoured, for reproducible tests
    assert.equal(R.randId(6, true, () => 0), "AAAAAA");
  } finally { Math.random = real; }
});

test("randomInt is uniform over its range and never out of bounds", () => {
  for (const n of [2, 3, 4, 13, 52]) {
    const seen = new Array(n).fill(0);
    for (let i = 0; i < n * 200; i++) {
      const v = E.randomInt(n);
      assert.ok(Number.isInteger(v) && v >= 0 && v < n, `randomInt(${n}) returned ${v}`);
      seen[v]++;
    }
    assert.ok(seen.every(c => c > 0), `randomInt(${n}) never produced every value`);
  }
});

test("deck totals 250 points for every bonus suit", () => {
  for (const s of E.SUITS) {
    const G = { bonusSuit: s };
    let sum = 0;
    for (const suit of E.SUITS) for (const rank of E.RANKS) sum += E.cardPoints(G, { suit, rank });
    assert.equal(sum, E.TOTAL_POINTS);
  }
});

test("trick resolution: trump beats lead, off-suit never wins", () => {
  const G = E.createMatch();
  E.startMatch(G);
  // force a known state: rig hands so the outcomes are deterministic
  G.phase = "playing"; G.trump = "♠"; G.bonusSuit = "♥";
  G.declarer = 0; G.partner = 2; G.teamsRevealed = true; G.bid = 130;
  G.trick = []; G.leadSuit = null; G.turn = 0; G.leader = 0; G.trickNumber = 0;
  G.hands = [
    [{ suit: "♥", rank: 14 }],
    [{ suit: "♥", rank: 2 }],
    [{ suit: "♠", rank: 2 }],   // low trump
    [{ suit: "♦", rank: 14 }],  // off-suit ace, no trump
  ];
  E.applyPlay(G, 0, { suit: "♥", rank: 14 });
  E.applyPlay(G, 1, { suit: "♥", rank: 2 });
  E.applyPlay(G, 2, { suit: "♠", rank: 2 });
  E.applyPlay(G, 3, { suit: "♦", rank: 14 });
  assert.equal(G.phase, "trickEnd");
  assert.equal(G.lastWinner, 2, "low trump beats lead ace; off-suit ace never wins");
});

test("all-pass redeals end in a forced 130 bid for eldest", () => {
  const G = E.createMatch();
  E.startMatch(G);
  const dealer = G.dealer;
  let guard = 0;
  while (G.phase === "bidding" && guard++ < 100) {
    const ra = E.requiredActor(G);
    E.applyBid(G, ra.seat, null);
  }
  assert.equal(G.phase, "trumpSelect");
  assert.equal(G.bid, E.MIN_BID);
  assert.equal(G.declarer, (dealer + 1) % 4, "eldest hand forced");
  assert.ok(guard < 100, "auction terminated");
});

test("bidIsLegal edges", () => {
  const G = E.createMatch();
  E.startMatch(G);
  const p = E.findBidActor(G);
  assert.equal(E.bidIsLegal(G, p, E.MIN_BID), true);
  assert.equal(E.bidIsLegal(G, p, E.MIN_BID - 5), false);
  assert.equal(E.bidIsLegal(G, p, E.MIN_BID + 2), false, "off-step bid");
  assert.equal(E.bidIsLegal(G, p, E.MAX_BID + 5), false);
  assert.equal(E.bidIsLegal(G, p, null), true, "pass always allowed for actor");
  assert.equal(E.bidIsLegal(G, (p + 1) % 4, E.MIN_BID), false, "not your turn");
});

test("publicView never contains hands", () => {
  const G = E.createMatch();
  E.startMatch(G);
  const pv = E.publicView(G);
  assert.ok(!("hands" in pv), "no hands key");
  assert.deepEqual(pv.handCounts, [13, 13, 13, 13]);
  // no card object from any hand appears anywhere in the serialized view during bidding
  const s = JSON.stringify(pv);
  for (let seat = 0; seat < 4; seat++)
    for (const c of G.hands[seat])
      assert.ok(!s.includes(JSON.stringify(c)), "hand card leaked into public view");
});

test("publicView carries each seat's latest bid, and a pass is absent rather than zero", () => {
  const G = E.createMatch();
  E.startMatch(G);
  assert.deepEqual(E.publicView(G).bids, [null, null, null, null], "no bids before the auction opens");

  const first = E.findBidActor(G);
  E.applyBid(G, first, E.MIN_BID);
  const passer = E.findBidActor(G);
  E.applyBid(G, passer, null);

  let pv = E.publicView(G);
  assert.equal(pv.bids[first], E.MIN_BID, "a bid is recorded against its seat");
  assert.equal(pv.bids[passer], null, "a pass writes nothing — leaving bidActive is what marks it");
  assert.ok(!pv.bidActive.includes(passer), "a passed seat leaves the auction");
  assert.ok(pv.bidActive.includes(first));

  // a raise overwrites the seat's own entry, and the high bidder always matches highBid
  const raiser = E.findBidActor(G);
  if (raiser != null && E.bidIsLegal(G, raiser, E.minNextBid(G))) {
    const raised = E.minNextBid(G);
    E.applyBid(G, raiser, raised);
    pv = E.publicView(G);
    assert.equal(pv.bids[raiser], raised);
    assert.equal(pv.bids[pv.highBidder], pv.highBid, "highBidder's entry is the high bid");
  }

  // and they clear at the next deal rather than bleeding across rounds
  while (G.phase !== "roundEnd" && G.phase !== "matchOver") {
    const ra = E.requiredActor(G);
    if (!ra) break;
    const a = E.aiActionFor(G, ra.seat, "easy");
    if (ra.kind === "bid") E.applyBid(G, ra.seat, a.value);
    else if (ra.kind === "trump") E.applyTrump(G, a.suit);
    else if (ra.kind === "call") E.applyCall(G, a.card);
    else if (ra.kind === "play") E.applyPlay(G, ra.seat, a.card);
    if (G.phase === "trickEnd") E.advanceTrick(G);
  }
  if (G.phase === "roundEnd") {
    E.nextDeal(G);
    assert.deepEqual(E.publicView(G).bids, [null, null, null, null], "bids reset with the deal");
  }
});

test("callableCards excludes declarer's holdings and callIsLegal agrees", () => {
  const G = E.createMatch();
  E.startMatch(G);
  // drive to partnerSelect with a real auction
  const ra = E.requiredActor(G);
  E.applyBid(G, ra.seat, E.MIN_BID);
  let guard = 0;
  while (G.phase === "bidding" && guard++ < 20) E.applyBid(G, E.requiredActor(G).seat, null);
  assert.equal(G.phase, "trumpSelect");
  E.applyTrump(G, "♠");
  assert.equal(G.phase, "partnerSelect");
  const declarerCards = new Set(G.hands[G.declarer].map(c => c.suit + c.rank));
  const callable = E.callableCards(G, G.declarer);
  assert.equal(callable.length, 52 - 13);
  for (const c of callable) {
    assert.ok(!declarerCards.has(c.suit + c.rank), "callable excludes own holdings");
    assert.equal(E.callIsLegal(G, c), true);
  }
  const held = G.hands[G.declarer][0];
  assert.equal(E.callIsLegal(G, held), false, "cannot call a held card");
});

test("30 random full matches satisfy every invariant", () => {
  for (let i = 0; i < 30; i++) playMatch((G) => randomAction(G));
});

test("AI-driven matches produce only legal actions (normal + easy)", () => {
  for (const easy of [false, true])
    for (let i = 0; i < 5; i++)
      playMatch((G, ra) => {
        const act = E.aiActionFor(G, ra.seat, easy);
        assert.ok(act, "AI produced an action");
        return act;
      });
});
