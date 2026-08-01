/* The coach's search, run off the main thread: a hint costs ~150 ms and a
   review costs seconds, and either would visibly stall the thread animating
   the turn-timer ring and the card flight. Everything here works from a
   redacted view alone (shadowFromView) — that, not a promise about what this
   file chooses to look at, is what makes a browser-side hint structurally
   incapable of cheating. */
import * as E from "../core/engine/index.js";
import { shadowFromView } from "./shadow.js";
import { reviewDeal } from "./review.js";

/* Background-thread budget: generous, because nothing here blocks a frame.
   client.js's synchronous fallback (no worker available) passes
   FALLBACK_HINT_BUDGET instead — small enough that running it on the thread
   painting the UI doesn't read as a stall.

   timeMs: Infinity here, deliberately, not merely generous: evaluateMoves
   enforces its timeMs as a real wall-clock cutoff after the 4th
   determinization (ai/pimc.js), and unlike server-side PIMC — where that
   cutoff is a no-op because Workers freeze Date.now() between I/O, the
   reason ROADMAP M9 moved PIMC's own budget onto simulated plays in the
   first place — this file runs in a browser Worker, where the clock keeps
   ticking. A finite timeMs would make "a seeded hint repeats" (its own
   reproducibility promise, tested in test/coach.test.js) hold only on a
   fast, unloaded machine: two calls to the same seed could race the clock
   to a different determinization count under load. playBudget alone is the
   bound. FALLBACK_HINT_BUDGET keeps a real, finite timeMs (30ms) instead —
   deliberately, the one place a clock guard is still the right tool: it
   runs synchronously on the thread painting the UI, where not stalling a
   frame matters more than a hint being bit-for-bit reproducible. */
const HINT_BUDGET = { determinizations: 48, playBudget: 120000, timeMs: Infinity };
const FALLBACK_HINT_BUDGET = { determinizations: 8, playBudget: 6000, timeMs: 30 };

/* Which phase a view must be in for a given actKind to be a real decision —
   checked as a pair, not actKind alone, so a view whose phase and actKind have
   drifted apart (which should never happen, but would otherwise roll out
   whatever G.phase says and hand back a quiet, wrong verdict) is refused
   instead of guessed at. Mirrors flow.js's own requiredActor() switch. */
const PHASE_FOR_ACT = { play: "playing", bid: "bidding", trump: "trumpSelect", call: "partnerSelect" };

/* Pure: takes a request, returns a response. Exported separately from the
   worker's own message wiring so the tests can execute the real thing in Node,
   where `self` does not exist. */
function handleRequest(msg) {
  try {
    const seed = (msg && msg.seed) || 1;
    if (msg.kind === "hint") {
      const view = msg.view;
      const actKind = view && view.you && view.you.actKind;
      /* evaluateMoves and the auction search both roll out from *some* reading
         of G regardless of what phase it actually is — playOutRound just
         returns the instant phase isn't "playing", and bidValue/aiPickTrumpSearch/
         aiPickPartnerSearch have no phase check of their own at all — so this
         phase/actKind pairing (plus toAct) is the one thing standing between a
         mismatched request and a quiet, wrong verdict instead of an honest
         refusal. */
      if (!view || !view.you || !view.you.toAct || PHASE_FOR_ACT[actKind] !== view.phase)
        return { id: msg.id, ok: false, error: "not your decision to make" };
      const G = shadowFromView(view);
      if (!G) return { id: msg.id, ok: false, error: "no position in this view" };
      const seat = view.you.seat;
      const budget = (msg && msg.budget) || HINT_BUDGET;
      const rnd = E.mulberry32(seed);

      if (actKind === "play") {
        const ev = E.evaluateMoves(G, seat, { ...budget, rnd });
        if (!ev) return { id: msg.id, ok: false, error: "the sampler could not build a consistent deal" };
        const moves = ev.moves.slice().sort((a, b) =>
          (b.winProb * 1000 + b.meanPoints) - (a.winProb * 1000 + a.meanPoints));
        return { id: msg.id, ok: true, result: { kind: "play", moves, best: moves[0],
                                                 determinizations: ev.determinizations } };
      }

      /* bid/trump/call run ai/bid-search.js's search instead of evaluateMoves' —
         a different budget shape (just rnd + playBudget: bid-search.js has no
         timeMs of its own, deliberately, per its own file comment — Workers
         freeze Date.now() between I/O, so a wall-clock cutoff would never fire
         there either). Reusing HINT_BUDGET/FALLBACK_HINT_BUDGET's playBudget
         rather than each function's own tuned default (aiActionFor's "hard" bot
         calls all three with none, see ai/index.js) keeps the one asymmetry that
         matters here — thorough off-thread, cheap on the thread painting the
         UI — without a second pair of constants to keep in sync with the first;
         it costs only that a hint searches wider than the bot's own move would,
         which is already true of the card-play hint above (HINT_BUDGET's 120000
         against PIMC_PLAY_BUDGET's 8000). makeProb/median/samples.length are
         read into plain values here, not left as bidValue's own closure — a
         function cannot cross postMessage's structured clone. */
      const searchOpts = { rnd, playBudget: budget.playBudget };
      if (actKind === "bid") {
        const bv = E.bidValue(G, seat, searchOpts);
        const target = view.you.minBid;
        return { id: msg.id, ok: true, result: { kind: "bid", median: bv.median, target,
                                                 makeProb: bv.makeProb(target), worlds: bv.samples.length } };
      }
      if (actKind === "trump") {
        const suit = E.aiPickTrumpSearch(G, seat, searchOpts);
        return { id: msg.id, ok: true, result: { kind: "trump", suit } };
      }
      // actKind === "call" — PHASE_FOR_ACT above admits no other value here
      const card = E.aiPickPartnerSearch(G, seat, searchOpts);
      if (!card) return { id: msg.id, ok: false, error: "no callable card found" };
      return { id: msg.id, ok: true, result: { kind: "call", card } };
    }
    if (msg.kind === "review") {
      const view = msg.view;
      /* Same honesty as the hint branch above: a review only means something
         once a deal has actually finished and v.tricks — the whole public
         record reviewDeal reconstructs positions from — is there to read.
         Anything else is an honest refusal, not a review of a partial or
         nonexistent deal. */
      if (!view || (view.phase !== "roundEnd" && view.phase !== "matchOver") ||
          !Array.isArray(view.tricks) || !view.tricks.length)
        return { id: msg.id, ok: false, error: "no finished deal in this view" };
      /* No seed here, deliberately: client.js mints a fresh random one per
         request (requestReview rides the same request() as requestHint), and
         reviewDeal's own default instead derives the seed from the deal
         itself — so re-requesting a review of the same finished deal prints
         the same numbers regardless of how many times it's been asked for. */
      const result = reviewDeal(view, msg.seat, {});
      return { id: msg.id, ok: true, result };
    }
    return { id: msg.id, ok: false, error: `unknown request: ${msg.kind}` };
  } catch (e) {
    return { id: msg && msg.id, ok: false, error: String((e && e.message) || e) };
  }
}

/* Registered only in a real worker. `test/client-modules.test.js` imports every
   file under app/js in Node, where `self` is undefined — hence the guard, and
   hence the export list below staying non-empty. */
if (typeof self !== "undefined" && typeof window === "undefined" && typeof self.postMessage === "function")
  self.onmessage = (e) => self.postMessage(handleRequest(e.data));

export { handleRequest, HINT_BUDGET, FALLBACK_HINT_BUDGET };
