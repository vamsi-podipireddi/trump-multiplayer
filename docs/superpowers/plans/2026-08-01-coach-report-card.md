# Coach Report Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grade every decision a player made across a match — card play, bid, trump and call — in one unit, aggregate them into a report card on the match-over modal, and fix the per-deal record the D1 stats table was always supposed to hold.

**Architecture:** Two new public engine fields (`G.auction`, `G.dealHistory`) plus `G.matchId` give the server a cheap, public per-deal record that arrives in the view. The expensive half — graded decisions — runs entirely in the browser (D28), fed by deal snapshots the client keeps in `localStorage`. Trump and call are re-ranked onto make-probability inside `ai/bid-search.js`, which is safe because D35 already cut them from the server and `coach/worker.js` is their only caller.

**Tech Stack:** Native ES modules, no bundler (D13). Node ≥20. `node --test`, zero test dependencies. Cloudflare Workers + Durable Objects, D1 (optional).

**Spec:** `docs/superpowers/specs/2026-08-01-coach-report-card-design.md`. Decisions D38–D46.

## Global Constraints

- **No new runtime dependencies.** `npm test` has none and must keep having none.
- **Consumers import the barrel, never a leaf module** (`STRUCTURE.md` rule 1). Modules *inside* a subsystem import leaves directly.
- **Client module imports are relative, never absolute** (`STRUCTURE.md` rule 3). Enforced by `test/client-modules.test.js`.
- **No `document`/`window`/`navigator`/`localStorage` at module top level** in anything under `app/js/` (`STRUCTURE.md` rule 5) — only inside functions.
- **A renderer under `app/js/ui/` takes the view as its first argument** and never imports `session.js` or `net.js` (`STRUCTURE.md` rule 6).
- **Run `npm run build:assets` after touching anything under `app/`** — `test/pwa.test.js` fails a stale precache.
- **Run the whole suite with bare `npm test`** (no path argument — D11). A single *file* may be run as `node --test test/engine.test.js`; a *directory* argument fails on Node 24.
- **`_silent` guards history.** Anything appended to `G` inside `endRound`/`resolveTrick` must be guarded by `if (!G._silent)`. `rolloutClone` sets `_silent: true` and a PIMC search resolves thousands of deals nobody reads.
- **Grade thresholds are shared, not re-declared:** `BLUNDER_WIN_DELTA = 0.15`, `MISTAKE_WIN_DELTA = 0.07`, both already in `app/js/coach/review.js`.
- **Every number that can be measured is measured.** Do not paste a tuned constant into a comment without `scripts/bench-auction-search.js` having produced it.

---

## File Structure

**Create:**
- `app/js/coach/auction.js` — reconstructs auction positions and grades bid/trump/call
- `app/js/coach/report.js` — pure aggregation over graded decisions, no search
- `app/js/util/deals.js` — `localStorage` deal-snapshot store
- `migrations/0001-report-card.sql` — D1 migration

**Modify:**
- `app/js/core/engine/match.js` — `matchId`, `dealHistory`, `auction` reset, `publicView`
- `app/js/core/engine/bidding.js` — append to `G.auction`
- `app/js/core/engine/ai/bid-search.js` — `evaluateTrumps`/`evaluateCalls`, re-rank
- `app/js/core/engine/index.js` — barrel exports
- `app/js/coach/review.js` — export `startingHand`, `preRoundScores`, `seedFromDeal`
- `app/js/coach/worker.js` — a `report` request kind
- `app/js/coach/client.js` — `requestReport`
- `app/js/ui/coach.js` — `describeReport`, `renderReport`
- `app/js/ui/modals.js` — report card as a match-over sibling
- `app/js/screens/game.js`, `app/js/solo.js` — snapshot at `roundEnd`
- `src/worker/stats.js` — fold `dealHistory`
- `schema.sql`, `scripts/bench-auction-search.js`
- `test/engine.test.js`, `test/coach.test.js`, `test/worker.test.js`
- `README.md`, `docs/STRUCTURE.md`, `ROADMAP.md`

---

### Task 1: Engine history — `G.auction`, `G.dealHistory`, `G.matchId`

**Files:**
- Modify: `app/js/core/engine/match.js`
- Modify: `app/js/core/engine/bidding.js:21-29` (`applyBid`), `:36-41` (`forceBid`)
- Test: `test/engine.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `G.matchId: string` (8 hex chars), `G.auction: [{seat:number, value:number|null, forced?:true}]`, `G.dealHistory: [{roundNumber, declarer, partner, bid, made, dPts, winners:number[]}]`. All three published by `publicView` as `matchId`, `auction`, `dealHistory`.

- [ ] **Step 1: Write the failing tests**

Append to `test/engine.test.js`:

```js
test("auction log replays to the declarer the engine chose", () => {
  for (let m = 0; m < 20; m++) {
    const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
    E.startMatch(G);
    while (G.phase !== "matchOver") {
      if (G.phase === "bidding") {
        // fold the log so far and check it predicts the engine's own state
        let high = null, highSeat = null;
        for (const a of G.auction) if (a.value != null) { high = a.value; highSeat = a.seat; }
        assert.equal(G.highBid, high, "auction fold must equal G.highBid");
        assert.equal(G.highBidder, highSeat, "auction fold must equal G.highBidder");
      }
      if (G.phase === "trumpSelect") {
        const last = G.auction.filter(a => a.value != null).pop();
        assert.ok(last, "a finalized auction has at least one bid");
        assert.equal(G.bid, last.value, "contract must be the last bid in the log");
        assert.equal(G.declarer, last.seat, "declarer must be the last bidder in the log");
      }
      const ra = E.requiredActor(G);
      if (!ra) { if (G.phase === "trickEnd") E.advanceTrick(G); else if (G.phase === "roundEnd") E.nextDeal(G); else break; continue; }
      applyChecked(G, ra.seat, randomAction(G));
    }
  }
});

test("dealHistory records every completed deal, and only real ones", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  let completed = 0;
  while (G.phase !== "matchOver") {
    const ra = E.requiredActor(G);
    if (!ra) {
      if (G.phase === "trickEnd") E.advanceTrick(G);
      else if (G.phase === "roundEnd") { completed++; assert.equal(G.dealHistory.length, completed); E.nextDeal(G); }
      else break;
      continue;
    }
    applyChecked(G, ra.seat, randomAction(G));
  }
  completed++;
  assert.equal(G.dealHistory.length, completed, "the clinching deal is recorded too");
  for (const d of G.dealHistory) {
    assert.equal(d.made, d.dPts >= d.bid, "made must follow from dPts and bid");
    assert.equal(d.winners.length, 2, "exactly two seats take a deal");
  }
});

test("a redeal discards the passed-out auction", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  const first = E.findBidActor(G);
  E.applyBid(G, first, null);
  assert.equal(G.auction.length, 1, "a pass is recorded");
  for (let i = 0; i < 3; i++) E.applyBid(G, E.findBidActor(G), null);
  // all four passed -> redeal() -> deal() resets the log
  assert.equal(G.auction.length, 0, "deal() clears the auction log");
});

test("matchId is stable within a match and changes across matches", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  const id = G.matchId;
  assert.match(id, /^[0-9a-f]{8}$/);
  E.nextDeal(G);
  assert.equal(G.matchId, id, "a new deal does not change the match id");
  E.startMatch(G);
  assert.notEqual(G.matchId, id, "startMatch mints a fresh match id");
});

test("publicView copies the new history rather than aliasing G", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  E.applyBid(G, E.findBidActor(G), E.MIN_BID);
  const v = E.publicView(G);
  v.auction[0].value = 9999;
  v.auction.push({ seat: 0, value: 1 });
  assert.equal(G.auction[0].value, E.MIN_BID, "mutating the view must not reach G");
  assert.equal(G.auction.length, 1);
  assert.equal(v.matchId, G.matchId);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/engine.test.js`
Expected: FAIL — `G.auction` is `undefined`, `G.dealHistory` is `undefined`, `G.matchId` is `undefined`.

- [ ] **Step 3: Add the fields to `match.js`**

In `app/js/core/engine/match.js`, add the minter above `createMatch`:

```js
/* 8 hex chars off the same CSPRNG the deal uses. There is nothing here to
   protect — a match id is public — but there is also no reason to introduce a
   second source of randomness for it. */
function mintMatchId() {
  let s = "";
  for (let i = 0; i < 8; i++) s += randomInt(16).toString(16);
  return s;
}
```

In `createMatch`'s returned object, alongside `scores: [0,0,0,0]`:

```js
    matchId: mintMatchId(), dealHistory: [], auction: [],
```

In `startMatch`, alongside `G.scores = [0,0,0,0]` — `startMatch` is exported and is the "a match begins" function, so a caller reusing a `G` must not inherit the last match's history:

```js
  G.matchId = mintMatchId(); G.dealHistory = [];
```

In `deal`, alongside `G.playedCards = []`:

```js
  G.auction = [];   // a redealt auction correctly vanishes with the hand it was bid on
```

In `endRound`, immediately after `winners.forEach(p => G.scores[p]++);` — **guarded**, for the same reason `resolveTrick`'s `G.tricks` push is: `playOutRound` reaches `endRound` on every rollout, and `rolloutClone` carries no history:

```js
  /* Guarded exactly as resolveTrick's own history push is: a PIMC search runs
     endRound thousands of times on rollout clones, and none of those deals is
     one anybody will read. */
  if (!G._silent) {
    if (!G.dealHistory) G.dealHistory = [];   // a room restored from storage predating this field
    G.dealHistory.push({
      roundNumber: G.roundNumber, declarer: G.declarer, partner: G.partner,
      bid: G.bid, made, dPts, winners: winners.slice(),
    });
  }
```

In `publicView`'s returned object, next to `tricks`:

```js
    matchId: G.matchId || null,
    /* Copied, not aliased, for the same reason tricks is: a viewer must never
       hold a reference into G. `|| []` covers a room restored from storage
       written before these fields existed. */
    auction: (G.auction || []).map(a => a.forced
      ? { seat: a.seat, value: a.value, forced: true }
      : { seat: a.seat, value: a.value }),
    dealHistory: (G.dealHistory || []).map(d => ({
      roundNumber: d.roundNumber, declarer: d.declarer, partner: d.partner,
      bid: d.bid, made: d.made, dPts: d.dPts, winners: d.winners.slice(),
    })),
```

- [ ] **Step 4: Append to the auction log in `bidding.js`**

In `applyBid`, **before** `advanceBidding(G)` — order matters: `advanceBidding` can call `redeal()` → `deal()`, which clears the log, and that is the behaviour the third test asserts:

```js
  if (!G.auction) G.auction = [];
  G.auction.push({ seat: p, value });
```

In `forceBid`, after `G.highBid = MIN_BID;`:

```js
  if (!G.auction) G.auction = [];
  // `forced` marks a bid nobody decided on — the review skips it rather than grading it
  G.auction.push({ seat: eldest, value: MIN_BID, forced: true });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/engine.test.js`
Expected: PASS, all tests including the pre-existing invariants.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. `publicView` gained keys, so `test/client.test.js`'s view-field pins may need the three new names added — if it fails there, add `matchId`, `auction`, `dealHistory` to its expected list.

- [ ] **Step 7: Commit**

```bash
git add app/js/core/engine/match.js app/js/core/engine/bidding.js test/engine.test.js
git commit -m "feat: engine records the auction, the deal history and a match id"
```

---

### Task 2: Re-rank trump and call onto make-probability (D42)

**Files:**
- Modify: `app/js/core/engine/ai/bid-search.js:137-231`
- Modify: `app/js/core/engine/index.js:24`
- Test: `test/coach.test.js`

**Interfaces:**
- Consumes: Task 1's fields (not directly — this task is independent of them).
- Produces: `evaluateTrumps(G, seat, opts) -> { candidates: [{suit, makeProb, meanPoints}], worlds } | null` and `evaluateCalls(G, seat, opts) -> { candidates: [{card, makeProb, meanPoints}], worlds } | null`, both exported from the barrel. `aiPickTrumpSearch` / `aiPickPartnerSearch` keep their existing signatures and become argmax wrappers.

- [ ] **Step 1: Write the failing test**

Append to `test/coach.test.js`:

```js
/* D29's wrapper property, applied to the auction: the review reads per-candidate
   scores and the hint reads the winner, so they must come from one ranking. */
test("aiPickTrumpSearch is evaluateTrumps' argmax on makeProb", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  while (G.phase === "bidding") E.applyBid(G, E.findBidActor(G), E.findBidActor(G) === G.bidTurn ? E.minNextBid(G) : null);
  assert.equal(G.phase, "trumpSelect");
  const seat = G.declarer;
  const opts = { rnd: E.mulberry32(7), playBudget: 24000 };
  const ev = E.evaluateTrumps(G, seat, opts);
  assert.ok(ev && ev.candidates.length === E.SUITS.length);
  assert.ok(ev.worlds > 0);
  for (const c of ev.candidates) {
    assert.ok(c.makeProb >= 0 && c.makeProb <= 1, "makeProb is a probability");
    assert.equal(typeof c.meanPoints, "number");
  }
  const best = ev.candidates.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));
  assert.equal(E.aiPickTrumpSearch(G, seat, { rnd: E.mulberry32(7), playBudget: 24000 }), best.suit);
});

test("aiPickPartnerSearch is evaluateCalls' argmax on makeProb", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  while (G.phase === "bidding") E.applyBid(G, E.findBidActor(G), E.findBidActor(G) === G.bidTurn ? E.minNextBid(G) : null);
  E.applyTrump(G, E.SUITS[0]);
  assert.equal(G.phase, "partnerSelect");
  const seat = G.declarer;
  const ev = E.evaluateCalls(G, seat, { rnd: E.mulberry32(11), playBudget: 24000 });
  assert.ok(ev && ev.candidates.length > 0);
  const best = ev.candidates.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));
  const pick = E.aiPickPartnerSearch(G, seat, { rnd: E.mulberry32(11), playBudget: 24000 });
  assert.ok(E.sameCard(pick, best.card));
});

test("the heuristic's own answer is evaluated first, so a tie leaves it standing", () => {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  while (G.phase === "bidding") E.applyBid(G, E.findBidActor(G), E.findBidActor(G) === G.bidTurn ? E.minNextBid(G) : null);
  const ev = E.evaluateTrumps(G, G.declarer, { rnd: E.mulberry32(3), playBudget: 24000 });
  assert.equal(ev.candidates.length, 4);
  // candidates[0] is the heuristic's pick; a reduce with strict > keeps the first on a tie
  assert.ok(E.SUITS.includes(ev.candidates[0].suit));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/coach.test.js`
Expected: FAIL — `E.evaluateTrumps is not a function`.

- [ ] **Step 3: Factor the evaluators out**

In `app/js/core/engine/ai/bid-search.js`, replace `meanOver` and `argmaxCandidate` with a scorer that keeps both statistics. Delete `argmaxCandidate` — nothing else calls it.

```js
/* Common random numbers, unchanged (D36): every candidate is scored on the SAME
   sampled worlds, so the comparison is a true paired one.
   What changed is the statistic. Candidates used to be ranked on mean captured
   points; D35 retired that objective — a deal is scored made or set, so points
   past the contract line buy nothing. makeProb is the fraction of shared worlds
   in which the declaring side reaches the contract, i.e. the same unit
   evaluateMoves already reports card play in. meanPoints is retained because
   scripts/bench-auction-search.js reports in it and D36's history is written
   in it. */
function scoreCandidates(G, seat, cands, worlds, toPlay, rnd) {
  const target = G.bid == null ? minNextBid(G) : G.bid;
  return cands.map(cand => {
    const { trump, call } = toPlay(cand);
    const pts = worlds.map(w => playOutWith(G, seat, w, trump, call, rnd));
    return {
      cand,
      makeProb: pts.filter(p => p >= target).length / pts.length,
      meanPoints: pts.reduce((s, p) => s + p, 0) / pts.length,
    };
  });
}

/* Strict `>`, and the heuristic's own answer sits at index 0 — so a tie leaves
   the heuristic's choice standing, exactly as argmaxCandidate did. */
const bestOf = (scored) => scored.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));
```

Replace `aiPickTrumpSearch` with an evaluator plus its wrapper:

```js
/* One evaluator, two consumers — D29's move applied to the auction. The coach's
   review needs every candidate's score to size a grade, not just the winner. */
function evaluateTrumps(G, seat, opts) {
  const rnd = (opts && opts.rnd) || Math.random;
  const budget = (opts && opts.playBudget) || TRUMP_PLAY_BUDGET;
  const heuristic = aiPickTrump(G, seat);
  const worlds = sampleWorlds(G, seat, worldsFor(SUITS.length, budget), rnd);
  if (!worlds.length) return null;
  const cands = [heuristic, ...SUITS.filter(s => s !== heuristic)];
  const scored = scoreCandidates(G, seat, cands, worlds,
    suit => ({ trump: suit, call: aiPickPartner(withTrump(G, suit), seat) }), rnd);
  return {
    candidates: scored.map(s => ({ suit: s.cand, makeProb: s.makeProb, meanPoints: s.meanPoints })),
    worlds: worlds.length,
  };
}

function aiPickTrumpSearch(G, seat, opts) {
  const ev = evaluateTrumps(G, seat, opts);
  return ev ? bestOf(ev.candidates).suit : aiPickTrump(G, seat);
}
```

Replace `aiPickPartnerSearch` the same way, keeping its shortlist comment and logic verbatim:

```js
function evaluateCalls(G, seat, opts) {
  const rnd = (opts && opts.rnd) || Math.random;
  const budget = (opts && opts.playBudget) || CALL_PLAY_BUDGET;
  const trump = G.trump || aiPickTrump(G, seat);
  const heuristic = aiPickPartner(withTrump(G, trump), seat);
  const honours = callableCards(G, seat).filter(c => c.rank >= 12 && !sameCard(c, heuristic));
  const cands = heuristic ? [heuristic, ...honours] : honours;
  if (!cands.length) return null;
  const worlds = sampleWorlds(G, seat, worldsFor(cands.length, budget), rnd);
  if (!worlds.length) return null;
  const scored = scoreCandidates(G, seat, cands, worlds, card => ({ trump, call: card }), rnd);
  return {
    candidates: scored.map(s => ({ card: s.cand, makeProb: s.makeProb, meanPoints: s.meanPoints })),
    worlds: worlds.length,
  };
}

function aiPickPartnerSearch(G, seat, opts) {
  const ev = evaluateCalls(G, seat, opts);
  if (ev) return bestOf(ev.candidates).card;
  const trump = G.trump || aiPickTrump(G, seat);
  return aiPickPartner(withTrump(G, trump), seat);
}
```

Add both to the module's export list:

```js
export { bidValue, aiBidDecisionSearch, aiPickTrumpSearch, aiPickPartnerSearch,
         evaluateTrumps, evaluateCalls,
         BID_PLAY_BUDGET, TRUMP_PLAY_BUDGET, CALL_PLAY_BUDGET, worldsFor, withTrump };
```

- [ ] **Step 4: Export from the barrel**

In `app/js/core/engine/index.js`, extend line 24:

```js
export { bidValue, aiBidDecisionSearch, aiPickTrumpSearch, aiPickPartnerSearch,
         evaluateTrumps, evaluateCalls } from "./ai/bid-search.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/coach.test.js && npm test`
Expected: PASS. `test/ai.test.js` exercises the auction search; if a seeded assertion there pinned a specific suit or card chosen under the points objective, update it to the new pick and note in the commit that the ranking changed — do **not** loosen the assertion.

- [ ] **Step 6: Commit**

```bash
git add app/js/core/engine/ai/bid-search.js app/js/core/engine/index.js test/coach.test.js test/ai.test.js
git commit -m "refactor: rank trump and the call by make-probability, one evaluator"
```

---

### Task 3: Re-measure what the re-ranking invalidated (D42's obligation)

**Files:**
- Modify: `scripts/bench-auction-search.js`
- Modify: `app/js/core/engine/ai/bid-search.js:19-84` (the comment block), `:85-87` (the budgets, only if the bench says so)
- Modify: `ROADMAP.md` (D36)

**Interfaces:**
- Consumes: Task 2's `evaluateTrumps`/`evaluateCalls`.
- Produces: measured replacements for D36's numbers. No new code interface.

This task produces no feature. It exists because D36's regret figures (trump 0.48 vs the heuristic's 2.96; call 1.06 vs 3.65), its hold-out (+2.47 ± 0.95 and +2.60 ± 0.87 points/deal) and the 24,000 budgets those rest on were **all measured against mean captured points**, which Task 2 just stopped ranking by.

- [ ] **Step 1: Point the bench's regret oracle at the new statistic**

In `scripts/bench-auction-search.js`, the regret sections score a candidate against a wide-oracle best. Change the oracle and the regret to `makeProb`, keeping a points column alongside so the old rows stay comparable:

```js
// regret is now in make-probability, the unit the search ranks by (D42).
// meanPoints is printed beside it so this run can be read against the pre-D42
// rows in bid-search.js's own comment block.
const regret = oracleBest.makeProb - chosen.makeProb;
```

- [ ] **Step 2: Run the regret sweep**

Run: `node scripts/bench-auction-search.js regret`
Expected: a table of trump and call regret at 6000 / 24000 / oracle width, in make-probability, against the hand-count heuristic's own regret as the bar. **Minutes, not seconds** — this script is deliberately outside `npm test`.

- [ ] **Step 3: Re-check the budgets**

Run: `node scripts/bench-auction-search.js budgets`
Expected: whether 24,000 still buys what it did. A binomial outcome has variance `p(1−p)`, a different estimation problem from a points mean, so the answer is not assumed either way. If the sweep says a different budget, change `TRUMP_PLAY_BUDGET`/`CALL_PLAY_BUDGET` and say so in the commit; if it says 24,000 stands, keep it and say *that*.

- [ ] **Step 4: Rewrite the numbers where they are quoted**

Replace the measured rows inside `bid-search.js`'s comment block (`:19-84`) with this run's output. Update `ROADMAP.md`'s D36 in its established style — a `~~struck~~` original followed by **CORRECTED, measured**, naming the command that produced the replacement. Do not delete the old figures; D35 and D36 both keep their retracted arithmetic visible on purpose.

- [ ] **Step 5: Verify nothing else quotes a stale number**

Run: `grep -rnE "2\.47|2\.60|0\.48|1\.06|2\.96|3\.65" --include="*.js" --include="*.md" .`
Expected: every remaining hit is inside a struck-through or explicitly historical passage.

- [ ] **Step 6: Commit**

```bash
git add scripts/bench-auction-search.js app/js/core/engine/ai/bid-search.js ROADMAP.md
git commit -m "measure: re-derive trump/call regret under the make-probability objective"
```

---

### Task 4: `coach/auction.js` — grade the bid, the trump and the call

**Files:**
- Create: `app/js/coach/auction.js`
- Modify: `app/js/coach/review.js:227` (export list)
- Test: `test/coach.test.js`

**Interfaces:**
- Consumes: `E.bidValue`, `E.evaluateTrumps`, `E.evaluateCalls`, `E.minNextBid`, `E.mulberry32`, `E.SUITS`, `E.sameCard`; `startingHand`, `preRoundScores`, `seedFromDeal`, `BLUNDER_WIN_DELTA`, `MISTAKE_WIN_DELTA` from `review.js`.
- Produces: `reviewAuction(v, seat, opts) -> { decisions, skipped }` where a decision is `{kind:"bid"|"trump"|"call", roundNumber, played, best, playedProb, bestProb, delta, band, grade, worlds}` and a skip is `{kind, roundNumber, reason:"forced"|"not-declarer"|"no-world"}`. Also exports `MIN_REVIEW_WORLDS`, `auctionBudgetFor`, `bandFor`.

- [ ] **Step 1: Export the three helpers from `review.js`**

Change `app/js/coach/review.js`'s last line to:

```js
export { reviewDeal, REVIEW_PLAY_BUDGET, BLUNDER_WIN_DELTA, MISTAKE_WIN_DELTA,
         startingHand, preRoundScores, seedFromDeal, gradeOf };
```

- [ ] **Step 2: Write the failing tests**

Append to `test/coach.test.js`:

```js
import { reviewAuction, MIN_REVIEW_WORLDS, auctionBudgetFor, bandFor } from "../app/js/coach/auction.js";

/* D43/D44 as arithmetic, not as a comment: the band must be able to express the
   finest grade there is, for the widest candidate list the call can offer. */
test("the review's world floor keeps the dead band under the mistake threshold", () => {
  assert.equal(MIN_REVIEW_WORLDS, Math.ceil(1 / MISTAKE_WIN_DELTA ** 2));
  for (const candidates of [1, 4, 13]) {
    const budget = auctionBudgetFor(candidates);
    const worlds = Math.max(4, Math.floor(budget / (candidates * 52)));   // worldsFor's own formula
    assert.ok(bandFor(worlds) <= MISTAKE_WIN_DELTA,
      `band ${bandFor(worlds)} must not swallow the mistake grade at ${candidates} candidates`);
  }
});

/* D32, executable. Every auction position must be built from what the player
   knew then — never from the finished deal's own trump, call or partner. */
test("reviewAuction never lets a later fact reach an earlier position", () => {
  const finished = finishedDealView();          // helper below
  const seen = [];
  reviewAuction(finished.v, finished.seat, { _tap: (pos, kind) => seen.push({ pos, kind }) });
  assert.ok(seen.length, "at least one auction position was searched");
  for (const { pos, kind } of seen) {
    assert.equal(pos.partner, null, `${kind}: partner must not be known`);
    assert.equal(pos.teamsRevealed, false, `${kind}: teams must not be revealed`);
    assert.equal(pos.calledCard, null, `${kind}: the called card must not be known`);
    assert.deepEqual(pos.playedCards, [], `${kind}: no card has been played yet`);
    assert.equal(pos.trickNumber, 0);
    if (kind !== "call") assert.equal(pos.trump, null, `${kind}: trump must not be known`);
    assert.equal(pos.hands[finished.seat].length, 13, `${kind}: the full starting hand`);
    assert.ok(pos.hands.filter((h, p) => p !== finished.seat).every(h => h.every(c => c === null)),
      `${kind}: other hands must be placeholders`);
  }
});

test("reviewAuction repeats exactly when asked twice", () => {
  const { v, seat } = finishedDealView();
  const a = reviewAuction(v, seat, {});
  const b = reviewAuction(v, seat, {});
  assert.deepEqual(a.decisions, b.decisions);
});

test("a correct pass on a weak hand is not an error", () => {
  // one-sided by construction: distance from the line on the RIGHT side is 0
  const { v, seat } = finishedDealView();
  const r = reviewAuction(v, seat, {});
  for (const d of r.decisions) assert.ok(d.delta >= 0, "delta is never negative");
});

test("a forced minimum bid is skipped, not graded", () => {
  const { v, seat } = forcedBidView();           // helper below
  const r = reviewAuction(v, seat, {});
  assert.ok(r.skipped.some(s => s.kind === "bid" && s.reason === "forced"));
  assert.ok(!r.decisions.some(d => d.kind === "bid"));
});

test("trump and call are skipped for a seat that did not declare", () => {
  const { v, seat } = finishedDealView();
  const other = [0, 1, 2, 3].find(s => s !== v.declarer);
  const r = reviewAuction(v, other, {});
  assert.ok(r.skipped.some(s => s.kind === "trump" && s.reason === "not-declarer"));
  assert.ok(r.skipped.some(s => s.kind === "call" && s.reason === "not-declarer"));
});
```

Add the two helpers near `drive()` in the same file:

```js
/* A finished deal's view for the seat that declared it, driven by the engine's
   own AI so every action is legal. */
function finishedDealView() {
  let out = null;
  drive((room, views) => {
    if (room.G.phase !== "roundEnd" && room.G.phase !== "matchOver") return;
    if (out) return;
    const seat = room.G.declarer;
    out = { v: views[seat], seat };
  });
  assert.ok(out, "a deal must have finished");
  return out;
}

/* Five consecutive passed-out auctions force the eldest to the minimum. */
function forcedBidView() {
  const G = E.createMatch(["A", "B", "C", "D"], { targetDeals: 3 });
  E.startMatch(G);
  while (G.phase === "bidding") E.applyBid(G, E.findBidActor(G), null);
  assert.ok(G.auction.some(a => a.forced), "the auction must have been forced");
  const seat = G.declarer;
  E.applyTrump(G, E.SUITS[0]);
  E.applyCall(G, E.callableCards(G, seat)[0]);
  while (G.phase !== "roundEnd" && G.phase !== "matchOver") {
    if (G.phase === "trickEnd") { E.advanceTrick(G); continue; }
    const ra = E.requiredActor(G);
    E.applyPlay(G, ra.seat, E.legalCards(G, ra.seat)[0]);
  }
  return { v: E.publicView(G), seat };
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/coach.test.js`
Expected: FAIL — cannot resolve `../app/js/coach/auction.js`.

- [ ] **Step 4: Write `app/js/coach/auction.js`**

```js
/* The auction's half of the post-deal review: grade the bid, the trump pick and
   the partner call from exactly the information the player had at the time —
   the sibling of review.js, which does the same for card play.

   The trap this file exists to avoid: bidValue reads `G.trump || aiPickTrump(G)`
   and `G.calledCard || aiPickPartner(G)`. A position rebuilt from a FINISHED
   deal's view has both filled in, so a naive reconstruction would grade your bid
   using the trump you had not yet chosen. Every position below nulls them. Same
   class of bug as review.js's `phase: "playing"`, and just as invisible without
   the _tap check in test/coach.test.js. */
import * as E from "../core/engine/index.js";
import { startingHand, preRoundScores, seedFromDeal, gradeOf, MISTAKE_WIN_DELTA } from "./review.js";

/* A make-probability is a binomial proportion over `worlds` sampled deals, so
   its two-standard-error band is 2*sqrt(0.25/worlds) — which is exactly
   1/sqrt(worlds). Inside it the search cannot tell two candidates apart, and
   grading anyway would assert precision the sampler does not have (D43). */
const bandFor = (worlds) => 1 / Math.sqrt(worlds);

/* The bots run budget -> worlds, which is right for a decision billed per
   invocation. A grader has the inverse constraint, and inheriting the bots'
   budgets breaks it: CALL_PLAY_BUDGET's 24000 over ~10 candidates yields 46
   worlds and a band of 0.147 — wider than MISTAKE_WIN_DELTA, so no call could
   ever grade "mistake". So the review runs precision -> worlds -> budget, and
   the floor is derived from the finest grade it has to express rather than
   chosen: change MISTAKE_WIN_DELTA and this follows (D44). */
const MIN_REVIEW_WORLDS = Math.ceil(1 / MISTAKE_WIN_DELTA ** 2);   // 205
const auctionBudgetFor = (candidates) => MIN_REVIEW_WORLDS * candidates * 52;

/* The position `seat` faced at one auction decision. `highBid` is the auction
   log's own prefix — never v.bid, which is where the contract ENDED. */
function auctionPosition(v, seat, kind, highBid) {
  const hand = startingHand(v.tricks || [], seat);
  return {
    _silent: true,
    phase: kind === "bid" ? "bidding" : kind === "trump" ? "trumpSelect" : "partnerSelect",
    // the whole point of this file: nothing from after the decision reaches it
    trump: kind === "call" ? v.trump : null,
    calledCard: null, partner: null, teamsRevealed: false,
    bid: kind === "bid" ? null : v.bid,
    highBid: kind === "bid" ? highBid : v.bid,
    declarer: kind === "bid" ? null : seat,
    bonusSuit: v.bonusSuit, dealer: v.dealer, roundNumber: v.roundNumber,
    names: v.names.slice(), scores: preRoundScores(v),
    targetGames: v.consts ? v.consts.TARGET_GAMES : 5,
    hands: [0, 1, 2, 3].map(p => p === seat
      ? hand.map(c => ({ suit: c.suit, rank: c.rank }))
      : new Array(13).fill(null)),
    trick: [], leadSuit: null, turn: seat, leader: seat, trickNumber: 0,
    tricksWon: [0, 0, 0, 0], capturedPoints: [0, 0, 0, 0],
    lastWinner: -1, lastWinnerSlot: -1, lastResult: null,
    log: [], playedCards: [], voids: [{}, {}, {}, {}],
  };
}

/* One graded decision, or null when the band swallows it — band decisions still
   return a decision, graded "fine": they were real decisions that were not
   errors, and dropping them would inflate the denominator's quality (D43). */
function decide(kind, roundNumber, played, best, playedProb, bestProb, worlds) {
  const band = bandFor(worlds);
  const raw = Math.max(0, bestProb - playedProb);
  const delta = raw > band ? raw : 0;
  return { kind, roundNumber, played, best, playedProb, bestProb, delta, band,
           grade: gradeOf(delta), worlds };
}

/* Every bidding turn this seat took. `highBid` folds the log left-to-right, so
   each position sees exactly the target that seat faced — the reason G.auction
   exists at all (D39): G.bids holds only each seat's LATEST bid, and a pass is
   not written to it, so the sequence is unrecoverable without the log. */
function gradeBids(v, seat, seed, tap, decisions, skipped) {
  let highBid = null;
  (v.auction || []).forEach((entry, i) => {
    if (entry.seat !== seat) { if (entry.value != null) highBid = entry.value; return; }
    if (entry.forced) {
      skipped.push({ kind: "bid", roundNumber: v.roundNumber, reason: "forced" });
    } else {
      const pos = auctionPosition(v, seat, "bid", highBid);
      if (tap) tap(pos, "bid", v.roundNumber);
      const need = E.minNextBid(pos);
      /* bidIsLegal admits any value >= minNextBid, but the bot only ever weighs
         `need` — so an overbid is graded against the level actually bid, not the
         minimum it could have bid. */
      const target = entry.value == null ? need : entry.value;
      const bv = E.bidValue(pos, seat, { rnd: E.mulberry32(seed + 100 + i), playBudget: auctionBudgetFor(1) });
      const worlds = bv.samples.length;
      if (!worlds) {
        skipped.push({ kind: "bid", roundNumber: v.roundNumber, reason: "no-world" });
      } else {
        const p = bv.makeProb(target);
        /* One-sided: being far from the line on the RIGHT side is not an error.
           A pass is wrong only when p is high; a bid only when p is low. */
        const wrongBy = entry.value == null ? p - 0.5 : 0.5 - p;
        const band = bandFor(worlds);
        const delta = wrongBy > band ? wrongBy : 0;
        decisions.push({
          kind: "bid", roundNumber: v.roundNumber,
          played: entry.value, best: entry.value == null ? target : null,
          playedProb: p, bestProb: 0.5, delta, band,
          grade: gradeOf(delta), worlds,
        });
      }
    }
    if (entry.value != null) highBid = entry.value;
  });
}

function gradeTrump(v, seat, seed, tap, decisions, skipped) {
  if (v.declarer !== seat) { skipped.push({ kind: "trump", roundNumber: v.roundNumber, reason: "not-declarer" }); return; }
  const pos = auctionPosition(v, seat, "trump", null);
  if (tap) tap(pos, "trump", v.roundNumber);
  const ev = E.evaluateTrumps(pos, seat, { rnd: E.mulberry32(seed + 200), playBudget: auctionBudgetFor(E.SUITS.length) });
  if (!ev) { skipped.push({ kind: "trump", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  const best = ev.candidates.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));
  const yours = ev.candidates.find(c => c.suit === v.trump);
  if (!yours) { skipped.push({ kind: "trump", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  decisions.push(decide("trump", v.roundNumber, v.trump, best.suit, yours.makeProb, best.makeProb, ev.worlds));
}

function gradeCall(v, seat, seed, tap, decisions, skipped) {
  if (v.declarer !== seat) { skipped.push({ kind: "call", roundNumber: v.roundNumber, reason: "not-declarer" }); return; }
  if (!v.calledCard) { skipped.push({ kind: "call", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  const pos = auctionPosition(v, seat, "call", null);
  if (tap) tap(pos, "call", v.roundNumber);
  const ev = E.evaluateCalls(pos, seat, { rnd: E.mulberry32(seed + 300), playBudget: auctionBudgetFor(13) });
  if (!ev) { skipped.push({ kind: "call", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  const best = ev.candidates.reduce((a, b) => (b.makeProb > a.makeProb ? b : a));
  const yours = ev.candidates.find(c => E.sameCard(c.card, v.calledCard));
  /* The shortlist is the honours plus the heuristic's pick, so a called seven is
     legitimately absent — that is a decision outside the search's candidate set,
     not a sampling failure, and it is skipped rather than graded against a set
     it was never in. */
  if (!yours) { skipped.push({ kind: "call", roundNumber: v.roundNumber, reason: "no-world" }); return; }
  decisions.push(decide("call", v.roundNumber, v.calledCard, best.card, yours.makeProb, best.makeProb, ev.worlds));
}

/* v: a finished deal's view (phase roundEnd/matchOver). seat: whose auction to
   grade. opts.seed overrides the deal-derived default (tests only). opts._tap
   (pos, kind, roundNumber) sees every position before it reaches the search —
   the affordance that makes this file's D32 promise checkable. */
function reviewAuction(v, seat, opts) {
  const seed = (opts && opts.seed != null) ? opts.seed : seedFromDeal(v);
  const tap = opts && opts._tap;
  const decisions = [], skipped = [];
  gradeBids(v, seat, seed, tap, decisions, skipped);
  gradeTrump(v, seat, seed, tap, decisions, skipped);
  gradeCall(v, seat, seed, tap, decisions, skipped);
  return { decisions, skipped };
}

export { reviewAuction, MIN_REVIEW_WORLDS, auctionBudgetFor, bandFor };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/coach.test.js`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. `test/client-modules.test.js` now loads `auction.js` too, which enforces relative imports and no top-level DOM automatically.

- [ ] **Step 7: Commit**

```bash
git add app/js/coach/auction.js app/js/coach/review.js test/coach.test.js
git commit -m "feat: grade the bid, the trump pick and the partner call"
```

---

### Task 5: `coach/report.js` — the aggregate

**Files:**
- Create: `app/js/coach/report.js`
- Test: `test/coach.test.js`

**Interfaces:**
- Consumes: graded decisions from `reviewDeal` (`{trickNo, played, best, playedWinProb, bestWinProb, delta, grade, samples}`) and `reviewAuction` (`{kind, roundNumber, …}`).
- Produces: `matchReport(deals, seat) -> { headline, counts, byKind, worst, coverage }` where `deals` is `[{roundNumber, decisions, skipped}]`. Pure — no search, no storage, no DOM.

- [ ] **Step 1: Write the failing tests**

Append to `test/coach.test.js`:

```js
import { matchReport } from "../app/js/coach/report.js";

const dec = (kind, delta, grade) => ({ kind, delta, grade, roundNumber: 1 });

test("matchReport's headline is a mean, so match length cannot move it", () => {
  const three = [1, 2, 3].map(n => ({ roundNumber: n, decisions: [dec("play", 0.2, "blunder"), dec("play", 0, "fine")], skipped: [] }));
  const seven = [1, 2, 3, 4, 5, 6, 7].map(n => ({ roundNumber: n, decisions: [dec("play", 0.2, "blunder"), dec("play", 0, "fine")], skipped: [] }));
  assert.equal(matchReport(three, 0, 3).headline, matchReport(seven, 0, 7).headline);
  assert.equal(matchReport(three, 0, 3).headline, 0.1);
});

test("skipped decisions stay out of the denominator, band decisions stay in", () => {
  const deals = [{ roundNumber: 1, decisions: [dec("play", 0, "fine"), dec("bid", 0, "fine")],
                   skipped: [{ kind: "trump", roundNumber: 1, reason: "not-declarer" }] }];
  const r = matchReport(deals, 0, 1);
  assert.equal(r.counts.fine, 2, "both graded decisions count");
  assert.equal(r.byKind.trump.n, 0, "a skip is not a decision");
});

test("headline is null, not zero, when nothing was graded", () => {
  const r = matchReport([{ roundNumber: 1, decisions: [], skipped: [] }], 0, 1);
  assert.equal(r.headline, null);
  assert.equal(r.counts.fine, 0);
});

test("coverage reports missing deals rather than hiding them", () => {
  const r = matchReport([{ roundNumber: 2, decisions: [dec("play", 0.3, "blunder")], skipped: [] }], 0, 5);
  assert.equal(r.coverage.dealsGraded, 1);
  assert.equal(r.coverage.dealsInMatch, 5);
});

test("worst is the two costliest across the whole match, not per deal", () => {
  const deals = [
    { roundNumber: 1, decisions: [dec("play", 0.30, "blunder"), dec("play", 0.05, "fine")], skipped: [] },
    { roundNumber: 2, decisions: [dec("call", 0.40, "blunder"), dec("bid", 0.20, "blunder")], skipped: [] },
  ];
  const r = matchReport(deals, 0, 2);
  assert.equal(r.worst.length, 2);
  assert.equal(r.worst[0].delta, 0.40);
  assert.equal(r.worst[1].delta, 0.30);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/coach.test.js`
Expected: FAIL — cannot resolve `../app/js/coach/report.js`.

- [ ] **Step 3: Write `app/js/coach/report.js`**

```js
/* The match-level aggregate over decisions review.js and auction.js have
   already graded. Pure arithmetic: no search, no storage, no DOM — which is
   what makes every rule below directly testable over synthetic decisions.

   The headline is a MEAN, not a sum. A sum is not comparable across 3-, 5- and
   7-deal matches, and this number is meant to survive into a career trend. It
   is invariant to match length; it is NOT invariant to bot difficulty or to how
   often you declared, which is why a career view has to slice by difficulty
   rather than pool, and why the card says so. */

const KINDS = ["play", "bid", "trump", "call"];

/* reviewDeal's own decisions carry no `kind` — they are all card play — so one
   is inferred rather than requiring review.js to change shape. */
const kindOf = (d) => d.kind || "play";

function matchReport(deals, seat, dealsInMatch) {
  const all = [];
  for (const d of (deals || [])) for (const dec of (d.decisions || [])) all.push(dec);

  const counts = { fine: 0, mistake: 0, blunder: 0 };
  for (const d of all) if (counts[d.grade] !== undefined) counts[d.grade]++;

  const byKind = {};
  for (const k of KINDS) {
    const mine = all.filter(d => kindOf(d) === k);
    byKind[k] = {
      n: mine.length,
      meanDelta: mine.length ? mine.reduce((s, d) => s + d.delta, 0) / mine.length : null,
      blunders: mine.filter(d => d.grade === "blunder").length,
    };
  }

  return {
    headline: all.length ? all.reduce((s, d) => s + d.delta, 0) / all.length : null,
    counts,
    byKind,
    worst: all.filter(d => d.grade !== "fine").sort((a, b) => b.delta - a.delta).slice(0, 2),
    coverage: {
      dealsGraded: (deals || []).length,
      dealsInMatch: dealsInMatch != null ? dealsInMatch : (deals || []).length,
      seat,
    },
  };
}

export { matchReport, KINDS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/coach.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/js/coach/report.js test/coach.test.js
git commit -m "feat: aggregate a match's graded decisions into one report"
```

---

### Task 6: Deal snapshots in `localStorage`

**Files:**
- Create: `app/js/util/deals.js`
- Modify: `app/js/screens/game.js:53-54`, `app/js/solo.js`
- Test: `test/coach.test.js`

**Interfaces:**
- Consumes: `v.matchId`, `v.roundNumber`, `v.tricks`, `v.auction` (Task 1).
- Produces: `snapshotOf(v) -> {}`, `saveDeal(room, matchId, snapshot) -> void`, `loadDeals(room, matchId) -> [snapshot]`.

- [ ] **Step 1: Write the failing test**

`snapshotOf` is pure and testable in Node; the storage functions are not (no `localStorage`), so the test covers the projection and the idempotence rule.

Append to `test/coach.test.js`:

```js
import { snapshotOf } from "../app/js/util/deals.js";

test("a snapshot carries exactly what the graders read, and no hand", () => {
  const { v } = finishedDealView();
  const s = snapshotOf(v);
  for (const k of ["tricks", "auction", "trump", "calledCard", "declarer", "partner",
                   "bid", "bonusSuit", "dealer", "roundNumber", "names", "scores",
                   "lastResult", "teamsRevealed", "consts"])
    assert.ok(k in s, `snapshot must carry ${k}`);
  assert.equal(s.you, undefined, "a snapshot never carries a hand");
  assert.equal(s.chat, undefined, "a snapshot never carries chat");
  // and it must still be enough to grade with
  const r = reviewAuction(s, s.declarer, {});
  assert.ok(r.decisions.length || r.skipped.length);
  const rd = reviewDeal(s, s.declarer, {});
  assert.ok(Array.isArray(rd.decisions));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/coach.test.js`
Expected: FAIL — cannot resolve `../app/js/util/deals.js`.

- [ ] **Step 3: Write `app/js/util/deals.js`**

```js
/* Finished deals, kept on this device so the match-over report card has
   something to grade. Deliberately client-side (D46): the DO pays nothing, no
   protocol changes, and a refresh or a reconnect keeps the data. The accepted
   cost is that a second device cannot grade deals it did not play — which the
   card states rather than hides (D45).

   Every storage access is wrapped exactly as util/prefs.js wraps its own:
   storage is a privilege, not a guarantee. Safari in private mode throws on
   read and write, and a quota is reachable — neither may stop a render. */

const PREFIX = "trump_deals:";
const MAX_MATCHES = 3;
const key = (room, matchId) => `${PREFIX}${room}:${matchId}`;

/* Exactly the fields reviewDeal (positionBefore) and reviewAuction
   (auctionPosition) read — nothing else. Notably NOT v.you: a snapshot must
   never carry a hand, so a stale one can never become a second source of one. */
function snapshotOf(v) {
  return {
    roundNumber: v.roundNumber, tricks: v.tricks || [], auction: v.auction || [],
    trump: v.trump, calledCard: v.calledCard, declarer: v.declarer, partner: v.partner,
    bid: v.bid, bonusSuit: v.bonusSuit, dealer: v.dealer,
    names: (v.names || []).slice(), scores: (v.scores || []).slice(),
    lastResult: v.lastResult || null, teamsRevealed: !!v.teamsRevealed,
    consts: { TARGET_GAMES: v.consts ? v.consts.TARGET_GAMES : 5 },
  };
}

function read(k) {
  try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch { return null; }
}

/* Evicts this room's other matches, then trims to MAX_MATCHES globally by the
   `ts` each record carries. A finished match's snapshots are worthless, so the
   cap is a housekeeping floor, not a retention policy. */
function evict(room, matchId) {
  try {
    const mine = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      if (k.startsWith(`${PREFIX}${room}:`) && k !== key(room, matchId)) { localStorage.removeItem(k); continue; }
      const rec = read(k);
      mine.push({ k, ts: (rec && rec.ts) || 0 });
    }
    mine.sort((a, b) => b.ts - a.ts);
    mine.slice(MAX_MATCHES).forEach(e => localStorage.removeItem(e.k));
  } catch { /* housekeeping is best-effort */ }
}

/* Idempotent by roundNumber: screens/game.js calls this on every render while
   the round-result modal is up, so the same deal must overwrite rather than
   accumulate. */
function saveDeal(room, matchId, snapshot) {
  if (!room || !matchId || !snapshot || snapshot.roundNumber == null) return;
  const k = key(room, matchId);
  const rec = read(k) || { ts: 0, deals: [] };
  const i = rec.deals.findIndex(d => d.roundNumber === snapshot.roundNumber);
  if (i >= 0) rec.deals[i] = snapshot; else rec.deals.push(snapshot);
  rec.ts = rec.deals.length;   // monotone without a clock; only used to order evictions
  try { localStorage.setItem(k, JSON.stringify(rec)); } catch { return; }
  evict(room, matchId);
}

function loadDeals(room, matchId) {
  const rec = read(key(room, matchId));
  return rec && Array.isArray(rec.deals)
    ? rec.deals.slice().sort((a, b) => a.roundNumber - b.roundNumber)
    : [];
}

export { snapshotOf, saveDeal, loadDeals };
```

- [ ] **Step 4: Wire the write in `screens/game.js`**

Add the import and the call. `screens/game.js:53-54` already branches on phase; the save goes with the `roundEnd` branch and also on `matchOver`, because the clinching deal never reaches `roundEnd` (`endRound` routes it straight to `matchOver` — the same gap D37's Task 14 closed for the review):

```js
import { snapshotOf, saveDeal } from "../util/deals.js";
```

```js
  // Snapshot before the modal branches: the deal that wins the match never
  // reaches roundEnd, so saving only there would lose the one deal a player is
  // most likely to want graded (the same gap D37's match-over review closed).
  if ((S.view.phase === "roundEnd" || S.view.phase === "matchOver") && S.view.lastResult)
    saveDeal(S.view.room.code, S.view.matchId, snapshotOf(S.view));
```

- [ ] **Step 5: Wire the same write in `solo.js`**

`solo.js` has no room code. Use the literal `"solo"` so its snapshots key and evict exactly like a room's:

```js
import { snapshotOf, saveDeal } from "./util/deals.js";
```

In its render path, where the round-result modal is shown:

```js
  if ((v.phase === "roundEnd" || v.phase === "matchOver") && v.lastResult)
    saveDeal("solo", v.matchId, snapshotOf(v));
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/coach.test.js && npm test`
Expected: PASS. `test/client-modules.test.js` loads `deals.js` under Node with no `localStorage` — every access is inside a function, so importing it must not throw.

- [ ] **Step 7: Rebuild the precache and commit**

```bash
npm run build:assets
git add app/js/util/deals.js app/js/screens/game.js app/js/solo.js app/sw.js test/coach.test.js
git commit -m "feat: keep finished deals on the device for the report card"
```

---

### Task 7: The card — worker request, facade, and the match-over panel

**Files:**
- Modify: `app/js/coach/worker.js:106-123`, `app/js/coach/client.js:90-97`
- Modify: `app/js/ui/coach.js`, `app/js/ui/modals.js:90-170`
- Test: `test/coach.test.js`

**Interfaces:**
- Consumes: `reviewDeal`, `reviewAuction`, `matchReport`, `loadDeals`.
- Produces: worker kind `"report"` taking `{deals, seat, dealsInMatch}` and returning `matchReport`'s object; `requestReport(deals, seat, dealsInMatch)` from `client.js`; `describeReport(report, v, seat)` and `renderReport(report, v, seat)` from `ui/coach.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/coach.test.js`:

```js
test("the worker's report branch grades every deal it is given", () => {
  const { v, seat } = finishedDealView();
  const res = handleRequest({ id: 1, kind: "report", deals: [snapshotOf(v)], seat, dealsInMatch: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.result.coverage.dealsGraded, 1);
  assert.equal(res.result.coverage.dealsInMatch, 3);
  assert.ok(res.result.counts.fine + res.result.counts.mistake + res.result.counts.blunder >= 0);
});

test("the worker refuses a report with no deals rather than reporting zero", () => {
  const res = handleRequest({ id: 2, kind: "report", deals: [], seat: 0, dealsInMatch: 3 });
  assert.equal(res.ok, false);
  assert.match(res.error, /no finished deal/i);
});

test("describeReport states coverage even when it is complete", () => {
  const report = matchReport([{ roundNumber: 1, decisions: [dec("play", 0, "fine")], skipped: [] }], 0, 1);
  const s = describeReport(report, { names: ["A", "B", "C", "D"] }, 0);
  assert.match(s.coverage, /1 of 1/);
});
```

Add `describeReport` to the file's existing `ui/coach.js` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/coach.test.js`
Expected: FAIL — `unknown request: report`.

- [ ] **Step 3: Add the worker branch**

In `app/js/coach/worker.js`, import and add a branch beside the review branch:

```js
import { reviewAuction } from "./auction.js";
import { matchReport } from "./report.js";
```

```js
    if (msg.kind === "report") {
      /* Same honesty as the review branch: a report over nothing is a refusal,
         not a perfect score. A zero here would read as flawless play. */
      const deals = Array.isArray(msg.deals) ? msg.deals : [];
      if (!deals.length) return { id: msg.id, ok: false, error: "no finished deal to report on" };
      const graded = deals.map(d => {
        const play = reviewDeal(d, msg.seat, {});
        const auction = reviewAuction(d, msg.seat, {});
        return {
          roundNumber: d.roundNumber,
          decisions: play.decisions.concat(auction.decisions),
          skipped: auction.skipped,
        };
      });
      return { id: msg.id, ok: true, result: matchReport(graded, msg.seat, msg.dealsInMatch) };
    }
```

- [ ] **Step 4: Add the facade call**

In `app/js/coach/client.js`, beside `requestReview`:

```js
/* Rides the same request() as the hint and the review — one correlation path,
   one timeout, one synchronous fallback. A whole match's grading is heavier
   than a single review, so this is the one caller that can plausibly reach
   TIMEOUT_MS on a slow phone; modals.js surfaces that as a retry rather than a
   permanent spinner. */
function requestReport(deals, seat, dealsInMatch) {
  return request("report", { deals, seat, dealsInMatch });
}
```

Add `requestReport` to the export list.

- [ ] **Step 5: Write the presentation pair in `ui/coach.js`**

Follows the file's existing pure-describe / render split, both directly executable in tests:

```js
/* Pure: matchReport's own numbers turned into the words the card prints.
   Coverage is always stated, including when it is complete — a partial mean
   presented as a whole one is the one thing this panel must never do (D45). */
function describeReport(report, v, seat) {
  const c = report.coverage;
  const graded = report.counts.fine + report.counts.mistake + report.counts.blunder;
  return {
    coverage: `graded ${c.dealsGraded} of ${c.dealsInMatch} deal${c.dealsInMatch === 1 ? "" : "s"}`,
    headline: report.headline == null
      ? "No decision in this match was open enough to grade."
      : `${(report.headline * 100).toFixed(1)}% average win probability given away, over ${graded} decision${graded === 1 ? "" : "s"}.`,
    counts: `${report.counts.fine} fine · ${report.counts.mistake} mistake${report.counts.mistake === 1 ? "" : "s"} · ${report.counts.blunder} blunder${report.counts.blunder === 1 ? "" : "s"}`,
    /* The bid's number shares the scale but not the meaning: passing hands the
       auction on rather than ending the deal, so it measures distance from the
       search's own line, not forgone win probability. Worded so nobody adds it
       to the other three. */
    bidNote: report.byKind.bid.n
      ? `Bidding: ${report.byKind.bid.n} decision${report.byKind.bid.n === 1 ? "" : "s"}, ${report.byKind.bid.blunders} well past the line.`
      : null,
    partial: c.dealsGraded < c.dealsInMatch
      ? "Deals played on another device, or before this browser stored them, are not included."
      : null,
  };
}

function renderReport(report, v, seat) {
  const s = describeReport(report, v, seat);
  const row = (k, label) => report.byKind[k].n
    ? `<div class="tr-row"><span>${label}</span><span>${report.byKind[k].meanDelta == null ? "—" : (report.byKind[k].meanDelta * 100).toFixed(1) + "%"}</span></div>`
    : "";
  const worst = report.worst.map(d =>
    `<div class="rv-row"><span>${esc(String(d.kind))} · deal ${d.roundNumber}</span><span>${(d.delta * 100).toFixed(1)}%</span></div>`).join("");
  return `<div class="deal-review">` +
    `<p class="kicker">${esc(s.coverage)}</p>` +
    `<p>${esc(s.headline)}</p>` +
    `<p class="muted">${esc(s.counts)}</p>` +
    row("play", "Card play") + row("trump", "Trump") + row("call", "The call") +
    (s.bidNote ? `<p class="muted">${esc(s.bidNote)}</p>` : "") +
    (worst ? `<div class="note">Costliest decisions</div>${worst}` : "") +
    (s.partial ? `<div class="note">${esc(s.partial)}</div>` : "") +
    `</div>`;
}
```

Add both to the file's export list.

- [ ] **Step 6: Attach it to the match-over modal**

In `app/js/ui/modals.js`, `showMatchOver` already carries the Task 14 body/action split with a `matchReviewOpen` toggle. Add the report card as a **third sibling** in the same body, next to — never replacing — the rematch button, per D37. Reuse the existing `paintReviewToggle` pairing with its own flag (`matchReportOpen`), and load deals through `loadDeals(view.room.code, view.matchId)`, falling back to `"solo"` when there is no room code. On `ok: false`, print the returned error via the existing `reviewErrorMessage`; on rejection, print `REVIEW_REJECTED_MESSAGE`.

- [ ] **Step 7: Run the tests**

Run: `node --test test/coach.test.js && npm test`
Expected: PASS.

- [ ] **Step 8: Rebuild the precache and commit**

```bash
npm run build:assets
git add app/js/coach/worker.js app/js/coach/client.js app/js/ui/coach.js app/js/ui/modals.js app/sw.js test/coach.test.js
git commit -m "feat: the report card on the match-over modal"
```

---

### Task 8: Fix what "Your record" measures (③)

**Files:**
- Modify: `src/worker/stats.js`
- Modify: `schema.sql`
- Create: `migrations/0001-report-card.sql`
- Test: `test/worker.test.js`

**Interfaces:**
- Consumes: `G.dealHistory`, `G.matchId` (Task 1).
- Produces: `matches` rows carrying `match_id`, `deals`, `bids_won`, `bids_made`; `/stats` returning the same four keys as before, correctly derived.

- [ ] **Step 1: Write the failing test**

Append to `test/worker.test.js`, following its existing fake-D1 pattern:

```js
test("stats count every deal's bids, not just the last one's", async () => {
  const captured = [];
  const env = { DB: fakeD1(captured) };
  const room = {
    code: "TEST",
    seatOwner: [ "p0", "p1", "p2", "p3" ],
    players: { p0: { uid: "u0", name: "A" }, p1: { uid: "u1", name: "B" },
               p2: { uid: "u2", name: "C" }, p3: { uid: "u3", name: "D" } },
    G: {
      phase: "matchOver", matchId: "abc12345", scores: [3, 1, 3, 1],
      dealHistory: [
        { roundNumber: 1, declarer: 0, partner: 2, bid: 150, made: true,  dPts: 160, winners: [0, 2] },
        { roundNumber: 2, declarer: 0, partner: 1, bid: 170, made: false, dPts: 140, winners: [2, 3] },
        { roundNumber: 3, declarer: 1, partner: 3, bid: 130, made: true,  dPts: 200, winners: [1, 3] },
      ],
      lastResult: { declarer: 1, made: true },
    },
  };
  await writeMatchStats(env, room);
  const seat0 = captured.find(r => r.uid === "u0");
  assert.equal(seat0.bids_won, 2, "seat 0 declared twice");
  assert.equal(seat0.bids_made, 1, "seat 0 made one of them");
  assert.equal(seat0.deals, 3);
  assert.equal(seat0.match_id, "abc12345");
  const seat1 = captured.find(r => r.uid === "u1");
  assert.equal(seat1.bids_won, 1);
  assert.equal(seat1.bids_made, 1);
  // the old columns must no longer be written at all
  assert.equal("was_declarer" in seat0, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/worker.test.js`
Expected: FAIL — the row has `was_declarer`/`bid_made` and no `bids_won`.

- [ ] **Step 3: Write the migration**

Create `migrations/0001-report-card.sql`:

```sql
-- Applied to an existing trump-stats database:
--   npx wrangler d1 execute trump-stats --remote --file=./migrations/0001-report-card.sql
--
-- was_declarer / bid_made are deliberately left in place and left alone. They
-- were derived from the final deal of a match only, so their historical values
-- cannot be recomputed and must not be reinterpreted as the new counters.
ALTER TABLE matches ADD COLUMN match_id  TEXT;
ALTER TABLE matches ADD COLUMN deals     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN bids_won  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN bids_made INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS matches_match_idx ON matches (match_id);
```

Add the same four columns to `schema.sql`'s `CREATE TABLE` for fresh installs, and mark the two old ones:

```sql
  was_declarer  INTEGER NOT NULL DEFAULT 0, -- DEPRECATED: final deal only; no longer written
  bid_made      INTEGER NOT NULL DEFAULT 0, -- DEPRECATED: final deal only; no longer written
  match_id      TEXT,                        -- groups the seats of one match
  deals         INTEGER NOT NULL DEFAULT 0,  -- deals played in that match
  bids_won      INTEGER NOT NULL DEFAULT 0,  -- deals this seat declared
  bids_made     INTEGER NOT NULL DEFAULT 0,  -- of those, contracts made
```

- [ ] **Step 4: Fold `dealHistory` in `writeMatchStats`**

Replace the per-seat row build in `src/worker/stats.js`:

```js
    const history = G.dealHistory || [];
    for (let seat = 0; seat < 4; seat++) {
      const owner = room.seatOwner[seat];
      const p = owner != null ? room.players[owner] : null;
      if (!p || !p.uid) continue;
      /* Every deal this seat declared, not just the last one — the bug this
         replaces read G.lastResult, so a player who won four bids and made all
         four then lost the fifth deal recorded bidsWon: 0. */
      const declared = history.filter(d => d.declarer === seat);
      stmts.push(env.DB.prepare(
        "INSERT INTO matches (uid, name, room, won, match_id, deals, bids_won, bids_made, ts) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(p.uid, p.name, room.code, G.scores[seat] === max ? 1 : 0,
             G.matchId || null, history.length, declared.length,
             declared.filter(d => d.made).length, Date.now()));
    }
```

- [ ] **Step 5: Read the new columns in `readStats`**

```js
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS games, SUM(won) AS wins, " +
      /* COALESCE, not a filter: rows written before the migration keep
         contributing their still-correct games and wins, and contribute zero —
         rather than a wrong number — to the bid counters they never held. */
      "SUM(COALESCE(bids_won, 0)) AS bidsWon, SUM(COALESCE(bids_made, 0)) AS bidsMade " +
      "FROM matches WHERE uid = ?"
    ).bind(uid).first();
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/worker.test.js && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/worker/stats.js schema.sql migrations/0001-report-card.sql test/worker.test.js
git commit -m "fix: count every deal's bids, not only the final deal's"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `docs/STRUCTURE.md`, `ROADMAP.md`

**Interfaces:** none.

- [ ] **Step 1: `docs/STRUCTURE.md`**

Add to the file table:

```
| `app/js/coach/auction.js` | Grades the bid, the trump pick and the call from the auction log — review.js's sibling for the half of a deal that happens before a card is played |
| `app/js/coach/report.js` | Pure aggregate over graded decisions; no search, no storage |
| `app/js/util/deals.js` | Finished-deal snapshots on this device, so the report card has something to grade |
```

- [ ] **Step 2: `README.md`**

Extend the **Deal review** row of the feature table and add a **Report card** row stating: it grades card play, bid, trump and call in one unit; it is computed on click at match end; it grades only deals this device stored, and says so; and the D1 record now counts every deal's bids rather than the final deal's.

Update the **Optional player stats (D1)** section with the migration command for existing databases.

- [ ] **Step 3: `ROADMAP.md`**

Add **M11 — the report card** with its task list, and paste decisions **D38–D46** from the spec's Decisions section verbatim.

- [ ] **Step 4: Verify no doc claims something untrue**

Run: `npm test`
Expected: PASS — `test/pwa.test.js` and `test/client.test.js` read several docs-adjacent invariants.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/STRUCTURE.md ROADMAP.md
git commit -m "docs: the report card, M11 and decisions D38-D46"
```

---

### Task 10: Career trend on the join screen (separable)

**Files:**
- Modify: `app/js/screens/join.js`, `src/worker/stats.js`

**Interfaces:**
- Consumes: Task 8's columns.
- Produces: `/stats` gains `matches: [{ts, bids_won, bids_made}]` for a sparkline.

Ship this only after Tasks 1–9 are merged and the metric has been seen against real matches. It is listed so the columns and the metric's stability requirement are not forgotten, not because it is required for the feature to be complete.

- [ ] **Step 1: Extend `/stats` with a recent-matches list**

```js
    const recent = await env.DB.prepare(
      "SELECT ts, deals, bids_won, bids_made FROM matches WHERE uid = ? ORDER BY ts DESC LIMIT 20"
    ).bind(uid).all();
```

- [ ] **Step 2: Render it on the join screen**

A single line under "Your record". **Do not pool across difficulties** — the report card's headline is invariant to match length but not to bot difficulty, so a run of `easy` matches would read as improvement. Either slice by difficulty or show only the bid record, which is difficulty-independent.

- [ ] **Step 3: Commit**

```bash
git add app/js/screens/join.js src/worker/stats.js
git commit -m "feat: recent-form line on the join screen"
```

---

## Self-Review

**Spec coverage.** D38 → Tasks 1, 6. D39 → Task 1. D40 → Task 1. D41 → Tasks 2, 4. D42 → Tasks 2, 3. D43 → Task 4. D44 → Task 4. D45 → Tasks 5, 7. D46 → Task 6. Stats fix (③) → Task 8. All eleven acceptance-criteria groups from the spec's Testing section map to a step: 1–7 → Task 1 Step 1; 8, 9, 11, 12, 13 → Task 4 Step 2; 10 → Task 2 Step 1; 14–16 → Task 5 Step 1; 17–18 → Task 8 Step 1; 19 → Tasks 4, 6 (automatic).

**Type consistency.** `evaluateTrumps` returns `{candidates:[{suit, makeProb, meanPoints}], worlds}` in Task 2 and is destructured that way in Task 4's `gradeTrump`. `evaluateCalls` returns `{card, …}` and Task 4 matches on `E.sameCard(c.card, v.calledCard)`. `matchReport(deals, seat, dealsInMatch)` takes three arguments in Task 5 and is called with three in Task 7. `snapshotOf`/`saveDeal`/`loadDeals` keep one spelling throughout.

**Known deviation from the spec, recorded rather than silently applied.** The spec's interface block gives `matchReport(graded, seat)`; the plan uses `matchReport(deals, seat, dealsInMatch)`, because `coverage.dealsInMatch` cannot be derived from the snapshots — that is exactly the number that is missing when snapshots are. The spec's `reviewAuction` decision shape gains `band` and `worlds` for the same reason: the card cannot honestly report a grade without the precision it was made at.
