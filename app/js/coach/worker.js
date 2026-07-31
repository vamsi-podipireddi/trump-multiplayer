/* The coach's search, run off the main thread: a hint costs ~150 ms and a
   review costs seconds, and either would visibly stall the thread animating
   the turn-timer ring and the card flight. Everything here works from a
   redacted view alone (shadowFromView) — that, not a promise about what this
   file chooses to look at, is what makes a browser-side hint structurally
   incapable of cheating. */
import * as E from "../core/engine/index.js";
import { shadowFromView } from "./shadow.js";
// reviewDeal (./review.js) lands in Task 9. Until then "review" below is a
// stub — same message shape, so client.js needs no change when it arrives.

/* Background-thread budget: generous, because nothing here blocks a frame.
   client.js's synchronous fallback (no worker available) passes
   FALLBACK_HINT_BUDGET instead — small enough that running it on the thread
   painting the UI doesn't read as a stall. */
const HINT_BUDGET = { determinizations: 48, playBudget: 120000, timeMs: 400 };
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
    if (msg.kind === "review") return { id: msg.id, ok: false, error: "review not available yet" };
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
