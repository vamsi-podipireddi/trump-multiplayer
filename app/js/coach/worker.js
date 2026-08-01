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

/* Pure: takes a request, returns a response. Exported separately from the
   worker's own message wiring so the tests can execute the real thing in Node,
   where `self` does not exist. */
function handleRequest(msg) {
  try {
    const seed = (msg && msg.seed) || 1;
    if (msg.kind === "hint") {
      const view = msg.view;
      /* evaluateMoves rolls out from G.phase, and playOutRound returns
         immediately once the phase isn't "playing" — so a bidding/trump/call
         position (or a view where it isn't even my turn) would otherwise come
         back with a quiet all-zero "best" card instead of an honest refusal. */
      if (!view || view.phase !== "playing" || !view.you || view.you.actKind !== "play")
        return { id: msg.id, ok: false, error: "not a card-play decision" };
      const G = shadowFromView(view);
      if (!G) return { id: msg.id, ok: false, error: "no position in this view" };
      const seat = view.you.seat;
      const budget = (msg && msg.budget) || HINT_BUDGET;
      const ev = E.evaluateMoves(G, seat, { ...budget, rnd: E.mulberry32(seed) });
      if (!ev) return { id: msg.id, ok: false, error: "the sampler could not build a consistent deal" };
      const moves = ev.moves.slice().sort((a, b) =>
        (b.winProb * 1000 + b.meanPoints) - (a.winProb * 1000 + a.meanPoints));
      return { id: msg.id, ok: true, result: { kind: "play", moves, best: moves[0],
                                               determinizations: ev.determinizations } };
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
