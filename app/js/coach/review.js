/* Post-deal review: re-search each of your own decision points from exactly
   the information you had at that moment, and grade the card you played
   against the search's own best — judging the decision, not the outcome
   (spec C5). A finished deal is fully public (13 tricks x 4 cards, each
   tagged with its player, in v.tricks), so every position below is
   reconstructed from that record alone: no server round-trip, no protocol
   change, and — this is the part that makes the grading honest — no card
   from trick T+1 onward is ever allowed to reach trick T's position. */
import * as E from "../core/engine/index.js";

/* Thresholds on the search's own win-probability swing (evaluateMoves'
   winProb: the fraction of sampled worlds where your side made the
   contract), not on points — a trick's worth of points lost to an already-
   hopeless contract costs nothing, and a single low card that flips the
   contract from lost to made costs everything. */
const BLUNDER_WIN_DELTA = 0.15;
const MISTAKE_WIN_DELTA = 0.07;

/* One trick's worth of ai/pimc.js's own PIMC_PLAY_BUDGET (8000 — what the
   hard AI spends on one live card decision) times the most tricks a deal can
   have, split evenly across however many tricks this deal actually has
   (always 13, this game deals all 52 cards every time, but derived from the
   record rather than hardcoded twice). Each decision then gets roughly the
   search depth the hard AI would give its own move, and a 13-decision
   review's total cost is bounded regardless of whether its decisions land in
   the expensive early game (many legal cards, many unseen) or the cheap
   endgame. */
const REVIEW_PLAY_BUDGET = 104000; // 13 x 8000

/* Reopening a review must print the same numbers — that reproducibility is
   the entire reason mulberry32 (D9's seedable AI-internal RNG) exists. But
   client.js mints a fresh random id/seed on *every* request, and
   requestReview rides the exact same request() as requestHint (by design —
   see client.js), so a plain caller-supplied seed can't be what makes a
   review stable: asking again would hand reviewDeal a different seed and
   print a different verdict. Folding the deal's own cards into the default
   instead ties the seed to the deal, not to when or how many times it was
   asked about; worker.js's review branch relies on exactly this, passing no
   seed of its own. An explicit opts.seed still wins over this default, for
   callers — namely the tests below — that want an exact, named draw. */
function seedFromDeal(v) {
  let h = 2166136261; // FNV-1a offset basis — not cryptographic, just stable and well enough mixed
  for (const t of (v.tricks || []))
    for (const { player, card } of t.cards) {
      h ^= player * 64 + E.SUITS.indexOf(card.suit) * 16 + card.rank;
      h = Math.imul(h, 16777619);
    }
  return (h >>> 0) || 1; // mulberry32 treats 0 as a valid but degenerate seed; steer clear of it
}

/* Mirrors applyPlay's own rule exactly, same as shadow.js: a seat is known
   void in a trick's led suit once it has followed with something else,
   which is only knowable once it isn't the one leading — index i>0 within
   that trick's own play order. */
function noteVoid(voids, i, player, card, lead) {
  if (i > 0 && lead && card.suit !== lead) voids[player][lead] = true;
}

/* seat's full starting hand: a finished deal is fully public, and each seat
   played exactly one card per trick, so the 13 cards recorded against `seat`
   across the deal's tricks — in the order they were played — *are* that
   seat's hand. hand[k] is the card seat played in trick k+1, so "seat's hand
   right before trick T" is simply hand.slice(T-1): nothing fancier is needed
   because nothing reorders a hand once it's dealt. */
function startingHand(tricks, seat) {
  return tricks.map(t => t.cards.find(c => c.player === seat).card);
}

/* This round's own outcome (v.scores' winners++) is exactly the fact under
   review, so it cannot be baked into a position built to judge that same
   round's decisions — scores must read as they stood *before* this round,
   which is constant across every decision point in it (scores only move at
   endRound). v.lastResult.winners names who got the increment; subtracting
   it back out is safe because endRound always sets lastResult in the same
   breath it flips phase to roundEnd/matchOver. */
function preRoundScores(v) {
  const winners = v.lastResult && v.lastResult.winners;
  return v.scores.map((s, p) => s - (winners && winners.includes(p) ? 1 : 0));
}

/* The position seat actually faced right before playing in trick idx+1 —
   the prefix only: every card of every earlier trick, plus whatever of
   *this* trick had already been led before seat's own turn. Nothing from
   trick idx+2 onward, and no running total (playedCards/voids/tricksWon/
   capturedPoints) that isn't purely a fold over that same prefix, ever
   reaches this object — that is the whole of C5.

   `hand` is seat's full 13-card starting hand (see startingHand); `running`
   is the fold over tricks[0..idx-1], threaded in rather than recomputed here
   so a 13-decision review is one pass over the deal, not thirteen. */
function positionBefore(v, seat, scores, hand, idx, running) {
  const t = v.tricks[idx];
  const myTurn = t.cards.findIndex(c => c.player === seat);
  const before = t.cards.slice(0, myTurn); // this trick's own cards, played before seat's turn
  const lead = t.cards[0].card.suit;

  const voids = running.voids.map(o => ({ ...o }));
  before.forEach((c, i) => noteVoid(voids, i, c.player, c.card, lead));

  const playedAlreadyInTrick = p => before.some(c => c.player === p);
  const hands = [0, 1, 2, 3].map(p => p === seat
    ? hand.slice(idx).map(c => ({ suit: c.suit, rank: c.rank }))
    : new Array(13 - idx - (playedAlreadyInTrick(p) ? 1 : 0)).fill(null));

  const prevTrick = idx > 0 ? v.tricks[idx - 1] : null;
  return {
    _silent: true,
    // "playing", never v.phase — a finished deal's view is "roundEnd"/
    // "matchOver" by construction, and rolloutClone/playOutRound gate every
    // simulated play on phase==="playing". Copying v.phase through would make
    // applyPlay's own trick-in-progress case a silent no-op for every
    // rollout (playOutRound returns immediately instead of playing the rest
    // of the deal out), so every legal card would score identically and the
    // review would report a flawless hand no matter what was actually
    // played — wrong, and wrong in a way none of the card-level checks below
    // would ever catch.
    phase: "playing",
    trump: v.trump, bonusSuit: v.bonusSuit,
    declarer: v.declarer, partner: v.partner, teamsRevealed: v.teamsRevealed,
    bid: v.bid, calledCard: v.calledCard,
    dealer: v.dealer, roundNumber: v.roundNumber,
    names: v.names.slice(), scores: scores.slice(),
    targetGames: v.consts ? v.consts.TARGET_GAMES : 5,
    hands,
    trick: before.map(c => ({ player: c.player, card: { suit: c.card.suit, rank: c.card.rank } })),
    leadSuit: myTurn > 0 ? lead : null,
    turn: seat, leader: t.cards[0].player,
    trickNumber: idx, // completed tricks only — trick idx+1 (this one) is still in flight
    tricksWon: running.tricksWon.slice(), capturedPoints: running.capturedPoints.slice(),
    lastWinner: prevTrick ? prevTrick.winner : -1, lastWinnerSlot: -1, lastResult: null,
    log: [], playedCards: running.playedCards.concat(before.map(c => c.card)), voids,
  };
}

/* Fold one whole resolved trick into the running prefix, in place. Called
   only after that trick's own decision point (if any) has already been
   built and scored, so the position built for trick T never carries trick
   T's own outcome, let alone trick T+1's. */
function foldTrick(running, t) {
  const lead = t.cards[0].card.suit;
  t.cards.forEach((c, i) => {
    running.playedCards.push(c.card);
    noteVoid(running.voids, i, c.player, c.card, lead);
  });
  running.tricksWon[t.winner]++;
  running.capturedPoints[t.winner] += t.pts;
}

function gradeOf(delta) {
  if (delta >= BLUNDER_WIN_DELTA) return "blunder";
  if (delta >= MISTAKE_WIN_DELTA) return "mistake";
  return "fine";
}

/* v: a finished deal's view (buildView at phase roundEnd/matchOver). seat:
   whose decisions to grade. opts.seed: overrides the deal-derived default
   (tests only; production leaves this to seedFromDeal). opts._tap(pos,
   trickNo): called with every position right before it is handed to the
   search — the one affordance that makes C5 checkable against the real
   positions instead of trusting this file's own comments.

   Each entry in the returned decisions also carries its own `samples`
   (that decision's evaluateMoves' own determinizations, not just the
   deal-wide minimum) — with timeMs: Infinity below, that count is a pure
   function of REVIEW_PLAY_BUDGET and the position, so it is exactly what
   evaluateMoves' own affordable/maxDet formula predicts, every time. That
   is what makes it possible to check, rather than merely comment, that
   nothing here is quietly clock-limited (see test/coach.test.js). */
function reviewDeal(v, seat, opts) {
  const seed = (opts && opts.seed != null) ? opts.seed : seedFromDeal(v);
  const tap = opts && opts._tap;
  const tricks = v.tricks || [];
  const perDecisionBudget = Math.max(1, Math.floor(REVIEW_PLAY_BUDGET / Math.max(1, tricks.length)));
  const hand = startingHand(tricks, seat);
  const scores = preRoundScores(v);
  const running = { playedCards: [], voids: [{}, {}, {}, {}], tricksWon: [0, 0, 0, 0], capturedPoints: [0, 0, 0, 0] };

  const decisions = [];

  for (let idx = 0; idx < tricks.length; idx++) {
    const t = tricks[idx];
    const myTurn = t.cards.findIndex(c => c.player === seat);
    const playedCard = t.cards[myTurn].card;
    const pos = positionBefore(v, seat, scores, hand, idx, running);

    if (E.legalCards(pos, seat).length > 1) { // else no decision was made — a forced play, skip it
      if (tap) tap(pos, idx + 1);
      /* timeMs: Infinity, deliberately — evaluateMoves defaults it to 25 and
         enforces it as a real wall-clock cutoff after the 4th determinization
         (ai/pimc.js). That default is a no-op on the server (Workers freeze
         Date.now() between I/O — the reason ROADMAP M9 moved PIMC's own
         budget onto simulated plays in the first place), but this file runs
         in a browser Worker, where the clock keeps ticking: left at 25 it
         would silently cap search depth below what REVIEW_PLAY_BUDGET
         affords on a slow device or a busy tab, and — the part that actually
         matters — make reviewDeal non-deterministic, since two calls could
         race the clock to different determinization counts. playBudget alone
         is the bound; nothing here should also depend on how fast the CPU
         happened to be. */
      const ev = E.evaluateMoves(pos, seat, { playBudget: perDecisionBudget, timeMs: Infinity, rnd: E.mulberry32(seed + idx + 1) });
      if (ev) { // null only if the sampler couldn't build any consistent world — rare; skip rather than fabricate a grade
        const playedMove = ev.moves.find(m => E.sameCard(m.card, playedCard));
        /* E.moveScore is choosePIMCCard's own argmax rule, imported rather than
           restated: "best" here has to mean what the search would itself have
           played — including meanPoints breaking the tie between moves that win
           equally often — or the grade is measured against a different search
           than the one the hint recommends and the bot plays. */
        const bestMove = ev.moves.reduce((a, b) => (E.moveScore(b) > E.moveScore(a) ? b : a));
        const delta = Math.max(0, bestMove.winProb - playedMove.winProb); // sampling noise can rank the actual play above the search's own "best" — that reads as 0, not a negative blunder
        decisions.push({
          trickNo: idx + 1, played: playedMove.card, best: bestMove.card,
          playedWinProb: playedMove.winProb, bestWinProb: bestMove.winProb,
          delta, grade: gradeOf(delta), samples: ev.determinizations,
        });
      }
    }
    foldTrick(running, t);
  }

  const worst = decisions.filter(d => d.grade !== "fine").sort((a, b) => b.delta - a.delta).slice(0, 2);
  // The aggregate is derived from the per-decision counts, not tracked
  // separately, so the two can never drift apart from each other.
  const samples = decisions.length ? Math.min(...decisions.map(d => d.samples)) : 0;
  return { decisions, worst, samples };
}

export { reviewDeal, REVIEW_PLAY_BUDGET, BLUNDER_WIN_DELTA, MISTAKE_WIN_DELTA,
         startingHand, preRoundScores, seedFromDeal, gradeOf };
