#!/usr/bin/env node
/* Re-derives every number in ai/bid-search.js's budget comment.
 *
 * Two load-bearing constants (TRUMP_PLAY_BUDGET, CALL_PLAY_BUDGET) were set from
 * measurement rather than taste, and the in-suite strength test provably cannot
 * see them regress — the effect is ~2.5 points a deal against ~25 points of
 * per-deal noise, so a test fast enough for `npm test` has no power over it.
 * This script is where that evidence lives, so the constants can be re-checked
 * whenever the rollout policy (ai/heuristic.js chooseAICard) is tuned, which is
 * what would silently invalidate them.
 *
 * Since ROADMAP D35 those two govern the search that answers the coach's
 * auction advisor in the browser, not a bot's: ai/index.js routes only the bid
 * server-side. `cost` reports both — what the DO actually spends, and what the
 * full three-question auction would cost if it were routed back.
 *
 * Not run by `npm test` — it takes minutes. Run it deliberately:
 *
 *   node scripts/bench-auction-search.js              # everything, ~12 min
 *   node scripts/bench-auction-search.js cost regret  # named sections only
 *   DEALS=40 node scripts/bench-auction-search.js     # smaller/faster
 *
 * Sections: cost | regret | shortlist | calibration | outcome | table | threshold
 *           | counterfactual
 *
 * `table`, `threshold` and `counterfactual` answer a question the others
 * structurally cannot.
 * Every number above comes from ONE searching seat against three hand-counters,
 * but difficulty is a single room setting applied to every bot
 * (src/core/room/drive.js), so the shipped shape is four searching seats bidding
 * against each other — and deals-won is blind to that, since exactly two of four
 * seats win every deal and an all-hard table against an all-hard table is pinned
 * at 50% by construction. What can be seen is the auction's own shape: where the
 * contract settles, how often the declaring side is set, how often it hits the
 * 250 ceiling, and how a lone hand-counter fares at such a table.
 */
import * as E from "../app/js/core/engine/index.js";
import { chooseAICard, aiPickTrump, aiPickPartner, aiBidDecision } from "../app/js/core/engine/ai/heuristic.js";
/* worldsFor and withTrump are imported, never re-typed: every world count this
   script prints is quoted verbatim in bid-search.js's own budget comment and in
   ROADMAP D35/D36, so a local copy of the formula would keep printing stale
   numbers into two places contributors read as measured fact. (The copy this
   replaced had also silently dropped withTrump's `G.trump === trump ? G :`
   identity short-circuit.) */
import { aiBidDecisionSearch, aiPickTrumpSearch, aiPickPartnerSearch,
         BID_PLAY_BUDGET, TRUMP_PLAY_BUDGET, CALL_PLAY_BUDGET,
         worldsFor, withTrump } from "../app/js/core/engine/ai/bid-search.js";
import { sortHand } from "../app/js/core/engine/cards.js";

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const ci = xs => 1.96 * sd(xs) / Math.sqrt(xs.length);
const key = c => c.suit + c.rank;
const fresh = () => { const G = E.createMatch(); E.startMatch(G); return G; };
const pm = (xs) => `${mean(xs) >= 0 ? "+" : ""}${mean(xs).toFixed(2)} +/- ${ci(xs).toFixed(2)}`;
// up here rather than beside `table`'s tally(): `cost` runs first, and a const is
// not usable before its own initialiser has evaluated
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/* Deliberately NOT bid-search.js's playOutWith: an oracle that shares the code
   under test cannot catch that code being wrong. The `cost` section asserts the
   two still agree, so this staying independent is checked, not assumed. */
function evalDeal(G, seat, world, trump, call) {
  const hands = [0, 1, 2, 3].map(p => (p === seat ? G.hands[seat].slice() : world[p].slice()));
  let partner = [0, 1, 2, 3].find(p => hands[p].some(c => E.sameCard(c, call)));
  if (partner === undefined) partner = seat;
  hands.forEach(h => sortHand(h, trump));
  const sim = {
    _silent: true, phase: "playing", trump, bonusSuit: G.bonusSuit, declarer: seat, partner,
    teamsRevealed: true, bid: 130, calledCard: call, dealer: G.dealer, roundNumber: 1, hands,
    trick: [], leadSuit: null, turn: seat, leader: seat, trickNumber: 0,
    tricksWon: [0, 0, 0, 0], capturedPoints: [0, 0, 0, 0], scores: [0, 0, 0, 0],
    names: G.names, log: [], lastWinner: -1, lastWinnerSlot: -1, lastResult: null, targetGames: 99,
  };
  for (let g = 0; g < 300; g++) {
    if (sim.phase === "trickEnd") { E.advanceTrick(sim); continue; }
    if (sim.phase !== "playing") break;
    E.applyPlay(sim, sim.turn, chooseAICard(sim, sim.turn, false, Math.random));
  }
  return partner === seat ? sim.capturedPoints[seat]
                          : sim.capturedPoints[seat] + sim.capturedPoints[partner];
}
const worldsOf = (G, seat, n, rnd) => Array.from({ length: n }, () => E._determinize(G, seat, rnd));
const truth = (G, seat, trump, call, ws) => mean(ws.map(w => evalDeal(G, seat, w, trump, call)));

/* Drive a whole deal, one seat's auction answers swapped for the search's. */
function runDeal(snap, bidFor, trumpFor, callFor) {
  const G = JSON.parse(snap);
  let guard = 0;
  while (G.phase === "bidding" && guard++ < 40) {
    const seat = E.findBidActor(G);
    if (seat === null) break;
    E.applyBid(G, seat, bidFor(G, seat));
    if (G.redealCount > 0) return null;           // a redeal reshuffles; the pairing is gone
  }
  if (G.phase !== "trumpSelect") return null;
  E.applyTrump(G, trumpFor(G, G.declarer));
  E.applyCall(G, callFor(G, G.declarer));
  let g2 = 0;
  while ((G.phase === "playing" || G.phase === "trickEnd") && g2++ < 300) {
    if (G.phase === "trickEnd") { E.advanceTrick(G); continue; }
    E.applyPlay(G, G.turn, chooseAICard(G, G.turn, false, Math.random));
  }
  return G;
}
const toTrumpSelect = (G) => {
  let guard = 0;
  while (G.phase === "bidding" && guard++ < 40) {
    const seat = E.findBidActor(G);
    if (seat === null) break;
    E.applyBid(G, seat, aiBidDecision(G, seat, false, Math.random));
  }
  return G.phase === "trumpSelect";
};

const DEALS = Number(process.env.DEALS || 150);
const EW = Number(process.env.EW || 300);
const want = process.argv.slice(2);
const on = (s) => !want.length || want.includes(s);

// ---------------------------------------------------------------- cost
if (on("cost")) {
  /* PIMC's own arithmetic (pimc.js:95-97): maxDet x legal x cardsLeft plays per
     card decision, and nothing at all when the play is forced. 8000 x 13 is the
     wrong figure because 8000 is a per-decision CAP, not a per-decision spend:
     cardsLeft is in affordable's denominator, so maxDet GROWS toward its 24
     ceiling as the deal empties while the per-decision cost falls with
     legal.length and cardsLeft. */
  const pimcFor = (G) => {
    let tot = 0, g = 0;
    while ((G.phase === "playing" || G.phase === "trickEnd") && g++ < 400) {
      if (G.phase === "trickEnd") { E.advanceTrick(G); continue; }
      const legal = E.legalCards(G, G.turn);
      const left = G.hands.reduce((n, h) => n + h.length, 0) || 1;
      if (legal.length > 1) tot += Math.min(24, Math.max(1, Math.floor(8000 / (legal.length * left)))) * legal.length * left;
      E.applyPlay(G, G.turn, chooseAICard(G, G.turn, false, Math.random));
    }
    return tot;
  };
  const pimc = [], nbids = [], sls = [], contracts = [];
  let mismatch = 0, checked = 0;
  for (let d = 0; d < Math.min(DEALS, 60); d++) {
    const G = fresh();
    let n = 0, guard = 0;
    while (G.phase === "bidding" && guard++ < 60) {
      const seat = E.findBidActor(G);
      if (seat === null) break;
      n++;
      E.applyBid(G, seat, aiBidDecisionSearch(G, seat, { rnd: E.mulberry32(d * 100 + n) }));
    }
    if (G.phase !== "trumpSelect") continue;
    nbids.push(n); contracts.push(G.bid);
    sls.push(1 + E.callableCards(G, G.declarer).filter(c => c.rank >= 12).length);
    // the oracle above must still agree with the module's own playOutWith
    const seat = G.declarer, h = aiPickPartner(withTrump(G, aiPickTrump(G, seat)), seat);
    const list = [h, ...E.callableCards(G, seat).filter(c => c.rank >= 12 && !E.sameCard(c, h))];
    const ws = worldsOf(withTrump(G, aiPickTrump(G, seat)), seat, worldsFor(list.length, CALL_PLAY_BUDGET), E.mulberry32(d));
    let best = list[0], bestM = truth(G, seat, aiPickTrump(G, seat), list[0], ws);
    for (const c of list.slice(1)) { const m = truth(G, seat, aiPickTrump(G, seat), c, ws); if (m > bestM) { bestM = m; best = c; } }
    const mod = aiPickPartnerSearch(withTrump(G, aiPickTrump(G, seat)), seat, { rnd: E.mulberry32(d) });
    checked++; if (!E.sameCard(best, mod)) mismatch++;
    E.applyTrump(G, aiPickTrump(G, G.declarer));
    E.applyCall(G, aiPickPartner(G, G.declarer));
    pimc.push(pimcFor(G));
  }
  const P = mean(pimc), nb = mean(nbids), sl = Math.round(mean(sls));
  const bid = nb * worldsFor(1, BID_PLAY_BUDGET) * 52;
  const trump = worldsFor(4, TRUMP_PLAY_BUDGET) * 4 * 52;
  const call = worldsFor(sl, CALL_PLAY_BUDGET) * sl * 52;
  console.log(`== cost (${pimc.length} deals) ==`);
  console.log(`  independent oracle vs the module's own search: ${mismatch}/${checked} disagreements (must be 0)`);
  console.log(`  mean contract ${mean(contracts).toFixed(1)}, ${nb.toFixed(2)} bid decisions an auction, call shortlist ~${mean(sls).toFixed(1)}`);
  console.log(`  PIMC, all four seats, one deal : ${Math.round(P)} plays (${Math.round(P / 4)}/bot)`);
  console.log(`  auction search AS ROUTED (ai/index.js): bid ${Math.round(bid)} plays/deal  (+${(100 * bid / P).toFixed(1)}% of PIMC)`);
  console.log(`  the same search if trump/call were also routed server-side: +${trump} +${Math.round(call)} = ${Math.round(bid + trump + call)} plays  (+${(100 * (bid + trump + call) / P).toFixed(1)}%)`);

  /* Per-DEAL totals are the wrong unit for a Durable Object, which is what every
     task on this branch reasoned in. src/core/room/timers.js fires ONE alarm per
     bot action (drive.js arms an "ai" timer; fireTimers -> aiAct -> aiActionFor),
     so the figure a CPU limit has to clear is the worst SINGLE decision. Timed
     through aiActionFor rather than through the search functions directly, so it
     keeps measuring whatever ai/index.js actually routes where — including that
     trump and call no longer reach a search at all. */
  const inv = { bid: [], trump: [], call: [], play: [] };
  const perDeal = [];
  let cold = null;
  for (let d = 0; d < Math.min(DEALS, 20); d++) {
    const G = fresh();
    let spent = 0, guard = 0;
    while (G.phase !== "roundEnd" && G.phase !== "matchOver" && guard++ < 400) {
      if (G.phase === "trickEnd") { E.advanceTrick(G); continue; }
      const ra = E.requiredActor(G);
      if (!ra) break;
      const t0 = performance.now();
      const act = E.aiActionFor(G, ra.seat, "hard");
      const ms = performance.now() - t0;
      if (cold === null) cold = { kind: ra.kind, ms };   // first search of the process: cold code, cold caches
      inv[ra.kind].push(ms); spent += ms;
      if (act.type === "bid") E.applyBid(G, ra.seat, act.value);
      else if (act.type === "trump") E.applyTrump(G, act.suit);
      else if (act.type === "call") E.applyCall(G, act.card);
      else E.applyPlay(G, ra.seat, act.card);
    }
    perDeal.push(spent);
  }
  const warm = Object.entries(inv).filter(([, xs]) => xs.length);
  console.log(`\n  == CPU per ALARM INVOCATION (${perDeal.length} deals, all four seats on "hard") ==`);
  console.log(`     ${"kind".padEnd(6)}${"n".padStart(6)}${"mean".padStart(9)}${"p50".padStart(9)}${"p95".padStart(9)}${"max".padStart(9)}   ms`);
  for (const [k, xs] of warm) {
    const s = xs.slice().sort((a, b) => a - b);
    console.log(`     ${k.padEnd(6)}${String(xs.length).padStart(6)}${mean(xs).toFixed(2).padStart(9)}${pct(s, 0.5).toFixed(2).padStart(9)}${pct(s, 0.95).toFixed(2).padStart(9)}${s[s.length - 1].toFixed(2).padStart(9)}`);
  }
  const worst = warm.reduce((w, [k, xs]) => { const m = Math.max(...xs); return m > w.ms ? { kind: k, ms: m } : w; }, { kind: "-", ms: 0 });
  console.log(`     per deal, all four seats: ${mean(perDeal).toFixed(1)} ms  (max deal ${Math.max(...perDeal).toFixed(1)} ms)`);
  console.log(`     WORST SINGLE INVOCATION: ${worst.ms.toFixed(2)} ms (${worst.kind})   first of the process, cold: ${cold.ms.toFixed(2)} ms (${cold.kind})`);
}

// -------------------------------------------------------------- regret
if (on("regret")) {
  const BUDGETS = [6000, 12000, 24000, 96000];
  console.log(`\n== regret vs the best available candidate (${DEALS} deals, ${EW}-world oracle; lower is better) ==`);
  for (const what of ["trump", "call"]) {
    const reg = {}, gain = {}; BUDGETS.forEach(b => { reg[b] = []; gain[b] = []; });
    const regH = [], spread = [];
    for (let d = 0; d < DEALS; d++) {
      const G = fresh();
      let seat, cands, valOf;
      if (what === "trump") {
        seat = E.findBidActor(G);
        const ws = worldsOf(G, seat, EW, E.mulberry32(900000 + d));
        cands = E.SUITS;
        const v = {}; for (const t of cands) v[t] = truth(G, seat, t, aiPickPartner(withTrump(G, t), seat), ws);
        valOf = (t) => v[t];
      } else {
        if (!toTrumpSelect(G)) continue;
        seat = G.declarer;
        E.applyTrump(G, aiPickTrump(G, seat));
        const h = aiPickPartner(G, seat);
        cands = [h, ...E.callableCards(G, seat).filter(c => c.rank >= 12 && !E.sameCard(c, h))];
        const ws = worldsOf(G, seat, EW, E.mulberry32(800000 + d));
        const v = {}; for (const c of cands) v[key(c)] = truth(G, seat, G.trump, c, ws);
        valOf = (c) => v[key(c)];
      }
      const vals = cands.map(valOf), best = Math.max(...vals);
      spread.push(best - Math.min(...vals));
      const h = what === "trump" ? aiPickTrump(G, seat) : aiPickPartner(G, seat);
      regH.push(best - valOf(h));
      for (const b of BUDGETS) {
        const s = what === "trump" ? aiPickTrumpSearch(G, seat, { rnd: E.mulberry32(1000 + d), playBudget: b })
                                   : aiPickPartnerSearch(G, seat, { rnd: E.mulberry32(2000 + d), playBudget: b });
        reg[b].push(best - valOf(s)); gain[b].push(valOf(s) - valOf(h));
      }
    }
    const shipped = what === "trump" ? TRUMP_PLAY_BUDGET : CALL_PLAY_BUDGET;
    const nc = what === "trump" ? 4 : 10;
    console.log(`  ${what}: best-worst spread ${mean(spread).toFixed(1)} pts · hand-count regret ${mean(regH).toFixed(2)}`);
    for (const b of BUDGETS)
      console.log(`    ${String(b).padStart(6)} (~${String(worldsFor(nc, b)).padStart(3)} worlds/cand) regret ${mean(reg[b]).toFixed(2)}  gain vs hand-count ${pm(gain[b])}${b === shipped ? "   <- shipped" : ""}`);
  }
}

// ----------------------------------------------------------- shortlist
if (on("shortlist")) {
  const rank = {}; const aceCeil = [], regH = [];
  for (let d = 0; d < DEALS; d++) {
    const G = fresh();
    if (!toTrumpSelect(G)) continue;
    const seat = G.declarer;
    E.applyTrump(G, aiPickTrump(G, seat));
    const h = aiPickPartner(G, seat);
    const full = [h, ...E.callableCards(G, seat).filter(c => c.rank >= 12 && !E.sameCard(c, h))];
    const ws = worldsOf(G, seat, EW, E.mulberry32(800000 + d));
    const v = {}; for (const c of full) v[key(c)] = truth(G, seat, G.trump, c, ws);
    const best = Math.max(...full.map(c => v[key(c)]));
    const bc = full.find(c => v[key(c)] === best);
    rank[bc.rank] = (rank[bc.rank] || 0) + 1;
    const aces = full.filter(c => c.rank === 14);
    aceCeil.push(best - (aces.length ? Math.max(...aces.map(c => v[key(c)])) : v[key(h)]));
    regH.push(best - v[key(h)]);
  }
  console.log(`\n== call shortlist: why rank >= 12 and not aces only ==`);
  console.log(`  best call's rank (14=A 13=K 12=Q): ${JSON.stringify(rank)}`);
  console.log(`  an aces-only shortlist forfeits ${mean(aceCeil).toFixed(2)} of the ${mean(regH).toFixed(2)} pts the full one wins back`);
}

// --------------------------------------------------------- calibration
if (on("calibration")) {
  const N = Math.min(DEALS, 250);
  const wrong = { 3000: 0, 6000: 0 }; let near = 0, differ = 0;
  for (let d = 0; d < N; d++) {
    const G = fresh();
    const seat = E.findBidActor(G), need = E.minNextBid(G);
    const t = aiPickTrump(G, seat), c = aiPickPartner(withTrump(G, t), seat);
    const ws = worldsOf(G, seat, 2000, E.mulberry32(700000 + d));
    const p = ws.map(w => evalDeal(G, seat, w, t, c)).filter(x => x >= need).length / ws.length;
    if (Math.abs(p - 0.5) < 0.08) near++;
    const dec = {};
    for (const b of [3000, 6000]) {
      dec[b] = aiBidDecisionSearch(G, seat, { rnd: E.mulberry32(3000 + d), playBudget: b }) !== null;
      if (dec[b] !== (p >= 0.5)) wrong[b]++;
    }
    if (dec[3000] !== dec[6000]) differ++;
  }
  console.log(`\n== bid calibration vs a 2000-world oracle (${N} hands, ${near} within 0.08 of the 0.5 line) ==`);
  console.log(`  wrong at 3000: ${wrong[3000]}   at 6000: ${wrong[6000]}   opening decisions that differ: ${differ}`);
}

// ------------------------------------------------------------- outcome
if (on("outcome")) {
  /* The end metric: deals won. endRound scores made-or-set, so passing and
     setting the other side counts as a win — a bidder cannot game this by
     simply buying more contracts. Paired on the dealt hand; seat 0 swaps
     policy, seats 1-3 always hand-count. */
  const N = Number(process.env.ODEALS || 4000);
  const heur = (d) => (G, seat) => aiBidDecision(G, seat, false, E.mulberry32(d * 31 + seat + G.bidTurn * 7));
  const arms = {
    "bid only": (isS, d) => [
      (G, s) => (s === 0 && isS) ? aiBidDecisionSearch(G, s, { rnd: E.mulberry32(d * 97 + G.bidTurn) }) : heur(d)(G, s),
      (G, s) => aiPickTrump(G, s), (G, s) => aiPickPartner(G, s)],
    "trump+call only": (isS, d) => [heur(d),
      (G, s) => (s === 0 && isS) ? aiPickTrumpSearch(G, s, { rnd: E.mulberry32(d * 13 + 1) }) : aiPickTrump(G, s),
      (G, s) => (s === 0 && isS) ? aiPickPartnerSearch(G, s, { rnd: E.mulberry32(d * 17 + 2) }) : aiPickPartner(G, s)],
    "full auction": (isS, d) => [
      (G, s) => (s === 0 && isS) ? aiBidDecisionSearch(G, s, { rnd: E.mulberry32(d * 97 + G.bidTurn) }) : heur(d)(G, s),
      (G, s) => (s === 0 && isS) ? aiPickTrumpSearch(G, s, { rnd: E.mulberry32(d * 13 + 1) }) : aiPickTrump(G, s),
      (G, s) => (s === 0 && isS) ? aiPickPartnerSearch(G, s, { rnd: E.mulberry32(d * 17 + 2) }) : aiPickPartner(G, s)],
  };
  console.log(`\n== outcome: deals won by seat 0, search vs hand-count (${N} paired deals each) ==`);
  for (const [label, mk] of Object.entries(arms)) {
    const win = [], lvl = []; let extra = 0, extraWon = 0;
    for (let d = 0; d < N; d++) {
      const base = fresh(), snap = JSON.stringify(base);
      const S = runDeal(snap, ...mk(true, d)), H = runDeal(snap, ...mk(false, d));
      if (!S || !H) continue;
      const ws = S.lastResult.winners.includes(0) ? 1 : 0;
      win.push(ws - (H.lastResult.winners.includes(0) ? 1 : 0));
      lvl.push(S.bid - H.bid);
      if (S.declarer === 0 && H.declarer !== 0) { extra++; extraWon += ws; }
    }
    const pp = win.map(x => x * 100);
    console.log(`  ${label.padEnd(16)}: ${pm(pp)} pp  ${Math.abs(mean(pp)) > ci(pp) ? "(significant)" : "(CI spans 0)"}  contract ${mean(lvl) >= 0 ? "+" : ""}${mean(lvl).toFixed(1)} pts` +
      (extra ? `, bought ${extra} contracts the hand-count did not and won ${(100 * extraWon / extra).toFixed(1)}% of them` : ""));
  }
}

// --------------------------------------------------------------- table
/* Shared by `table` and `threshold`: one whole deal under a per-seat auction
   policy. Unlike runDeal above it never bails on a redeal — a redeal is one of
   the things being measured — and it reports the auction's shape rather than one
   seat's paired result. */
const CONTRACT_BUCKETS = [130, 140, 150, 160, 170, 180, 190, 200, 210];
const bucketOf = (b) => Math.min(CONTRACT_BUCKETS.length - 1, Math.floor((b - 130) / 10));

/* Continued from `G` mid-auction with the seed counter already at `turn`, so the
   `counterfactual` section can fork one snapshot into two branches whose seats
   answer identically wherever the two positions are identical. playTable is this
   from a fresh deal. */
function finishDeal(G, seats, card, probe, turn) {
  let guard = 0, redeals = 0;
  while (G.phase === "bidding" && guard++ < 80) {
    redeals = Math.max(redeals, G.redealCount);
    const seat = E.findBidActor(G);
    if (seat === null) break;
    E.applyBid(G, seat, seats[seat].bid(G, seat, ++turn));
  }
  if (G.phase !== "trumpSelect") return null;
  /* forceBid writes highBid/highBidder directly and never touches G.bids, so a
     declarer with no bid on record is one the engine forced to 130 after
     MAX_REDEALS+1 all-pass auctions — a distinct failure mode from bidding 130. */
  const forced = G.bids[G.declarer] === null;
  E.applyTrump(G, seats[G.declarer].trump(G, G.declarer));
  E.applyCall(G, seats[G.declarer].call(G, G.declarer));
  let g2 = 0;
  while ((G.phase === "playing" || G.phase === "trickEnd") && g2++ < 300) {
    if (G.phase === "trickEnd") { E.advanceTrick(G); continue; }
    E.applyPlay(G, G.turn, card(G));
  }
  /* Only trust the probe when it is about *this* contract: a forced declarer
     never bid at all, and a redeal leaves the previous auction's entry behind. */
  const pr = probe[G.declarer];
  return { bid: G.bid, made: G.lastResult.made, dPts: G.lastResult.dPts,
           prob: pr && pr.level === G.bid ? pr : null,
           winners: G.lastResult.winners, redeals, forced, turns: turn };
}
const playTable = (seats, card, probe = {}) => finishDeal(fresh(), seats, card, probe, 0);

/* aiBidDecisionSearch inlined so the make-probability behind each bid can be
   kept (probe) and its 0.5 line swept (thresh). Identical to the shipped
   function at thresh 0.5 on the same seed — asserted, not assumed, by the
   equivalence guard at the top of `table`.

   probe[seat] holds the level a seat last *bid* and the probability it bid on.
   Only bids are recorded: a seat that passes goes on to compute probabilities
   for levels it never took, and the declarer's winning bid is by definition its
   last one. */
const searcher = (d, thresh, probe) => ({
  bid: (G, s, n) => {
    const need = E.minNextBid(G);
    if (need > E.MAX_BID) return null;
    const p = E.bidValue(G, s, { rnd: E.mulberry32(d * 977 + n) }).makeProb(need);
    if (p < (thresh === undefined ? 0.5 : thresh)) return null;
    if (probe) probe[s] = { level: need, p };
    return need;
  },
  trump: (G, s) => aiPickTrumpSearch(G, s, { rnd: E.mulberry32(d * 13 + 1) }),
  call: (G, s) => aiPickPartnerSearch(G, s, { rnd: E.mulberry32(d * 17 + 2) }),
});
/* Seeded on (deal, seat, turn) for the same reason the searcher is: the deal
   itself comes off the platform CSPRNG and cannot be pinned, but everything a
   policy decides on top of it can, so a rerun at the same size is reproducible
   for both arms rather than only the searching one. */
const counter = (d) => ({
  bid: (G, s, n) => aiBidDecision(G, s, false, E.mulberry32(d * 31 + s * 7 + n)),
  trump: (G, s) => aiPickTrump(G, s),
  call: (G, s) => aiPickPartner(G, s),
});
/* `who` is the set of seats that search; everyone else hand-counts. */
const tableOf = (who, d, thresh, probe) => [0, 1, 2, 3].map(s => (who.includes(s) ? searcher(d, thresh, probe) : counter(d)));

/* Accumulates one arm's deals into the distribution the deal-win metric cannot
   see. seatWin is reported for seat 3 specifically: exactly two of four seats win
   every deal, so any seat's rate is 50% under a symmetric table and a deviation
   is exactly the asymmetry a mixed table introduces. */
function tally(rows) {
  const bids = rows.map(r => r.bid).sort((a, b) => a - b);
  const hist = CONTRACT_BUCKETS.map(() => 0), lost = CONTRACT_BUCKETS.map(() => 0);
  rows.forEach(r => { hist[bucketOf(r.bid)]++; if (!r.made) lost[bucketOf(r.bid)]++; });
  return {
    n: rows.length, bids, hist,
    /* "do contracts spiral upward, with declarers set constantly?" is a question
       about this row, not about the mean: a table whose 180s all fail is unwell
       however healthy its average looks. */
    setBy: hist.map((h, i) => (h ? lost[i] / h : null)),
    mean: mean(bids), ci: ci(bids), p50: pct(bids, 0.5), p90: pct(bids, 0.9), max: bids[bids.length - 1],
    set: rows.filter(r => !r.made).length / rows.length,
    ceiling: rows.filter(r => r.bid >= 250).length / rows.length,
    big: rows.filter(r => r.bid >= 180).length / rows.length,
    redeal: rows.filter(r => r.redeals > 0).length / rows.length,
    forced: rows.filter(r => r.forced).length / rows.length,
    turns: mean(rows.map(r => r.turns)),
    margin: mean(rows.map(r => r.dPts - r.bid)),
    /* Pooled margin is not independent of the set rate: a set deal contributes a
       negative margin, so a policy that is set more often has a lower pooled
       margin whatever it does with the contracts it makes. madeMargin is the
       part of the claim "the extra contract comes out of surplus, not risk" that
       does not simply restate the set rate. */
    madeMargin: mean(rows.filter(r => r.made).map(r => r.dPts - r.bid)),
    seatWin: rows.filter(r => r.winners.includes(3)).length / rows.length,
  };
}
function report(label, t) {
  console.log(`  ${label.padEnd(22)} contract ${t.mean.toFixed(1)} +/- ${t.ci.toFixed(1)}  p50 ${String(t.p50).padStart(3)}  p90 ${String(t.p90).padStart(3)}  max ${t.max}` +
    `   set ${(100 * t.set).toFixed(1)}%   >=180 ${(100 * t.big).toFixed(1)}%   250 ${(100 * t.ceiling).toFixed(1)}%` +
    `   redeal ${(100 * t.redeal).toFixed(1)}%  forced ${(100 * t.forced).toFixed(1)}%   ${t.turns.toFixed(1)} bids` +
    `   margin ${t.margin >= 0 ? "+" : ""}${t.margin.toFixed(1)} (made only ${t.madeMargin >= 0 ? "+" : ""}${t.madeMargin.toFixed(1)})   seat3 wins ${(100 * t.seatWin).toFixed(1)}%`);
}
function histTable(labels, tallies) {
  const w = 6;
  const head = `  ${"".padEnd(22)}${CONTRACT_BUCKETS.map((b, i) => (i === CONTRACT_BUCKETS.length - 1 ? b + "+" : String(b)).padStart(w)).join("")}`;
  console.log(`  winning contract, % of deals in each 10-point band:`);
  console.log(head);
  labels.forEach((l, i) => console.log(`  ${l.padEnd(22)}${tallies[i].hist.map(h => (100 * h / tallies[i].n).toFixed(1).padStart(w)).join("")}`));
  console.log(`\n  and the % of those the declaring side was SET in ("." = fewer than 20 deals in the band):`);
  console.log(head);
  labels.forEach((l, i) => console.log(`  ${l.padEnd(22)}${tallies[i].setBy.map((s, j) =>
    (tallies[i].hist[j] < 20 ? "." : (100 * s).toFixed(1)).padStart(w)).join("")}`));
}

if (on("table")) {
  const N = Number(process.env.TDEALS || 1000);
  const P = Number(process.env.TPIMC || 200);
  const heurCard = (G) => chooseAICard(G, G.turn, false, Math.random);
  const pimcCard = (G) => E.choosePIMCCard(G, G.turn);
  const ARMS = [["all hand-count", []], ["all search (hard)", [0, 1, 2, 3]],
                ["1 search vs 3", [0]], ["3 search vs 1 (seat 3)", [0, 1, 2]]];
  console.log(`\n== table: what the auction settles at when every seat searches (${N} deals, heuristic card play) ==`);
  /* searcher() reimplements aiBidDecisionSearch to keep the probability; pin the
     two together before any number below rests on the reimplementation. */
  let drift = 0;
  for (let d = 0; d < 200; d++) {
    const G = fresh(), s = E.findBidActor(G), rnd = () => E.mulberry32(d * 977 + 1);
    const mine = E.bidValue(G, s, { rnd: rnd() }).makeProb(E.minNextBid(G)) >= 0.5 ? E.minNextBid(G) : null;
    if (mine !== aiBidDecisionSearch(G, s, { rnd: rnd() })) drift++;
  }
  console.log(`  the probe's inlined bid vs the shipped aiBidDecisionSearch: ${drift}/200 disagreements (must be 0)`);

  const labels = [], tallies = [], calib = [];
  for (const [label, who] of ARMS) {
    const rows = [];
    for (let d = 0; d < N; d++) { const probe = {}; const r = playTable(tableOf(who, d, undefined, probe), heurCard, probe); if (r) rows.push(r); }
    labels.push(label); tallies.push(tally(rows)); report(label, tallies[tallies.length - 1]);
    if (who.length === 4) calib.push(...rows.filter(r => r.prob));
  }
  histTable(labels, tallies);

  /* Calibration, not a break-even: what the declarer's own make-probability was
     at the level it won the auction with, against whether it then made it. This
     used to be followed by a comparison against (1/3)(1-set) + (2/3)(set) as "the
     value of passing instead," presented as the crux of whether 0.5 is too loose.
     That comparison is RETRACTED (task-8-report.md section 8.2; ROADMAP.md's M10
     milestone, "fixed to stop asserting a retracted claim") — the expression is
     an algebraic identity, not a counterfactual: exactly two of four seats win
     every deal, so it equals 50% for every set rate, which made every threshold
     from 0.5 to 0.65 read as "conservative." It also compared a rate conditioned
     on the search liking the hand and winning the auction against a rate
     conditioned on nothing. The real answer is the same-hand fork in the
     `counterfactual` section below: bidding a marginal level measured at
     -0.35 +/- 1.40 pp against passing it instead — no detectable effect, which is
     why 0.50 stands as the incumbent rather than as a measured winner. */
  const BANDS = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.85], [0.85, 1.01]];
  console.log(`\n  all-search declarers, by the make-probability they bid the winning level on:`);
  for (const [lo, hi] of BANDS) {
    const in_ = calib.filter(r => r.prob.p >= lo && r.prob.p < hi);
    if (!in_.length) continue;
    console.log(`    p in [${lo}, ${hi === 1.01 ? "1.0" : hi})  n ${String(in_.length).padStart(5)}  contract ${mean(in_.map(r => r.bid)).toFixed(1)}` +
      `  actually made ${(100 * in_.filter(r => r.made).length / in_.length).toFixed(1)}%  (= the declaring side's deal-win rate; scoring is binary)`);
  }

  /* The rows above roll out with the heuristic, which is what the search itself
     assumes — so they could be self-consistent and still wrong about the table
     that ships, where all four seats play PIMC. Same two arms, real card play. */
  console.log(`\n  the same two symmetric arms with PIMC card play, i.e. the tier as shipped (${P} deals):`);
  for (const [label, who] of [ARMS[0], ARMS[1]]) {
    const rows = [];
    for (let d = 0; d < P; d++) { const r = playTable(tableOf(who, d), pimcCard); if (r) rows.push(r); }
    report(label, tally(rows));
  }
}

// ----------------------------------------------------------- threshold
/* aiBidDecisionSearch bids when makeProb(need) >= 0.5. Bidding to a coin flip is
   right when the opponents underbid and reckless when they do not, so a
   symmetric table is exactly where that line should be re-examined. Both halves
   matter: raising it must be paid for in the asymmetric regime the +2.77pp
   result came from, or it is a trade rather than an improvement. */
if (on("threshold")) {
  const N = Number(process.env.THDEALS || 800);
  const M = Number(process.env.THPAIRED || 2500);
  const THRESHOLDS = [0.5, 0.55, 0.6, 0.65];
  const heurCard = (G) => chooseAICard(G, G.turn, false, Math.random);
  console.log(`\n== threshold: the makeProb line, at an all-search table (${N} deals) and against hand-counters (${M} paired) ==`);
  const labels = [], tallies = [];
  for (const T of THRESHOLDS) {
    const rows = [];
    for (let d = 0; d < N; d++) { const r = playTable(tableOf([0, 1, 2, 3], d, T), heurCard); if (r) rows.push(r); }
    labels.push(`all search @ ${T}`); tallies.push(tally(rows)); report(labels[labels.length - 1], tallies[tallies.length - 1]);
  }
  histTable(labels, tallies);

  console.log(`\n  and what each line is worth in the asymmetric regime (seat 0 searches, 1-3 hand-count):`);
  const heur = (d) => (G, seat) => aiBidDecision(G, seat, false, E.mulberry32(d * 31 + seat + G.bidTurn * 7));
  for (const T of THRESHOLDS) {
    const bidAt = (d) => (G, s) => {
      if (s !== 0) return heur(d)(G, s);
      const need = E.minNextBid(G);
      if (need > E.MAX_BID) return null;
      return E.bidValue(G, s, { rnd: E.mulberry32(d * 97 + G.bidTurn) }).makeProb(need) >= T ? need : null;
    };
    const win = [], lvl = [];
    for (let d = 0; d < M; d++) {
      const snap = JSON.stringify(fresh());
      const S = runDeal(snap, bidAt(d), (G, s) => aiPickTrump(G, s), (G, s) => aiPickPartner(G, s));
      const H = runDeal(snap, heur(d), (G, s) => aiPickTrump(G, s), (G, s) => aiPickPartner(G, s));
      if (!S || !H) continue;
      win.push((S.lastResult.winners.includes(0) ? 1 : 0) - (H.lastResult.winners.includes(0) ? 1 : 0));
      lvl.push(S.bid - H.bid);
    }
    const pp = win.map(x => x * 100);
    console.log(`    bid @ ${T}: ${pm(pp)} pp of deals won  ${Math.abs(mean(pp)) > ci(pp) ? "(significant)" : "(CI spans 0)"}   contract ${mean(lvl) >= 0 ? "+" : ""}${mean(lvl).toFixed(1)} pts`);
  }
}

// ----------------------------------------------------- counterfactual
/* What §4.3 of the task report could not answer.
 *
 * "Bidding at p returns X%, passing is worth (1/3)(1-set) + (2/3)(set)" is an
 * algebraic identity, not a counterfactual: exactly two of four seats win every
 * deal, so that expression is 1/2 for every set rate, and it compares a rate
 * conditioned on the search liking the hand AND winning the auction against one
 * conditioned on nothing. It says "bid more" at every threshold, which makes it
 * evidence for none of them.
 *
 * The real question is a same-hand one, so ask it that way. Walk an all-search
 * auction to the first decision whose make-probability is marginal, snapshot,
 * and finish the deal twice from that one position: once with that seat bidding
 * (what 0.50 does) and once with it passing (what a higher line would do). The
 * seats' seeds continue from the fork, so wherever the two branches face the
 * same position they answer it the same way, and the only difference is the
 * decision under test. Statistic: that seat's own deal-win rate, paired.
 */
if (on("counterfactual")) {
  const N = Number(process.env.CDEALS || 4000);
  const LO = 0.5, HI = 0.6;
  const heurCard = (G) => chooseAICard(G, G.turn, false, Math.random);
  const bands = { "0.50-0.55": [], "0.55-0.60": [] };
  let forks = 0, dropped = 0;
  for (let d = 0; d < N; d++) {
    const G = fresh(), seats = tableOf([0, 1, 2, 3], d);
    let turn = 0, guard = 0, seat = null, p = 0;
    while (G.phase === "bidding" && guard++ < 80) {
      const s = E.findBidActor(G);
      if (s === null) break;
      const need = E.minNextBid(G);
      if (need > E.MAX_BID) { E.applyBid(G, s, null); turn++; continue; }
      turn++;
      p = E.bidValue(G, s, { rnd: E.mulberry32(d * 977 + turn) }).makeProb(need);
      if (p >= LO && p < HI) { seat = s; break; }
      E.applyBid(G, s, p >= 0.5 ? need : null);
    }
    if (seat === null) continue;
    const snap = JSON.stringify(G);
    /* A branch whose fork triggers an all-pass redeal is dealt new cards, and
       the pairing — the whole point — is gone with them. */
    const branch = (takesIt) => {
      const g = JSON.parse(snap);
      E.applyBid(g, seat, takesIt ? E.minNextBid(g) : null);
      const r = finishDeal(g, seats, heurCard, {}, turn);
      return r && !r.redeals ? (r.winners.includes(seat) ? 1 : 0) : null;
    };
    const bidW = branch(true), passW = branch(false);
    if (bidW === null || passW === null) { dropped++; continue; }
    forks++;
    bands[p < 0.55 ? "0.50-0.55" : "0.55-0.60"].push({ bidW, passW });
  }
  console.log(`\n== counterfactual: the same hand, bidding a marginal level or passing (${N} deals -> ${forks} forks, ${dropped} dropped to redeals) ==`);
  for (const [label, rows] of Object.entries(bands)) {
    if (rows.length < 30) { console.log(`  p in [${label}): only ${rows.length} forks, skipped`); continue; }
    const diff = rows.map(r => 100 * (r.bidW - r.passW));
    console.log(`  p in [${label}): n ${String(rows.length).padStart(5)}   bidding wins ${(100 * mean(rows.map(r => r.bidW))).toFixed(1)}%` +
      `   passing wins ${(100 * mean(rows.map(r => r.passW))).toFixed(1)}%   bid - pass ${pm(diff)} pp` +
      `  ${Math.abs(mean(diff)) > ci(diff) ? "(significant)" : "(CI spans 0)"}`);
  }
  console.log(`  a positive [0.50-0.55) row is the case for keeping 0.50; a negative one is the case for 0.55.`);
}
