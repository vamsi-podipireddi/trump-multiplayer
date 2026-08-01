import { requiredActor } from "../flow.js";
import { aiBidDecision, aiPickTrump, aiPickPartner, chooseAICard } from "./heuristic.js";
import { choosePIMCCard } from "./pimc.js";
import { aiBidDecisionSearch } from "./bid-search.js";

/* The action an AI would take for the seat that currently must act.
   difficulty: "easy" | "normal" | "hard" (legacy boolean easy also accepted).

   "hard" is the only tier that simulates anything, and it simulates exactly two
   of the four decisions: the bid (ai/bid-search.js) and the card (ai/pimc.js).
   Trump and the call are answered by ai/heuristic.js's linear hand-count at
   EVERY tier, including hard.

   That asymmetry is measured, not aesthetic. This code runs inside a Durable
   Object, which meters CPU per *invocation* — one alarm per bot action
   (src/core/room/timers.js -> drive.js's aiAct) — so what a routing decision
   costs is the price of the single worst decision, not a per-deal total. Timed
   through this function (scripts/bench-auction-search.js `cost`), a searched
   trump or call is ~8 ms of CPU in an invocation that would otherwise be ~0.01,
   and the paired A/B in ROADMAP D35 puts the pair's worth at +0.56 +/- 0.42 pp
   of deals won — indistinguishable from zero, because a deal is scored made-or-
   set and trump/call mostly buy margin a binary score discards. The bid is the
   arm that pays: +2.77 +/- 0.91 pp, and its ~1.8 ms lands on a bidding turn
   where nothing else is spending anything.

   aiPickTrumpSearch/aiPickPartnerSearch are NOT dead: they still answer the
   coach's auction advisor (app/js/coach/worker.js), which runs in the player's
   own browser, off the main thread, at a budget of its own and at zero server
   cost. Only the server-side routing was cut.

   Difficulty is one room setting applied to every bot (src/core/room/drive.js),
   so the shipped shape of this branch is four searching *bidders* against each
   other, not one against three hand-counters. scripts/bench-auction-search.js's
   `table` section reads like a measurement of that regime, but isn't one: its
   `searcher` (bench:405-411) still sends trump and the call through the search
   too, on every seat that "searches" — the pre-cut auction, not what ships. Its
   "auction settles ~13 points higher" and "paid for, not merely spent" describe
   that pre-cut table, not the bid-only one four `hard` bots actually play. */
function aiActionFor(G, seat, difficulty) {
  const easy = difficulty === true || difficulty === "easy";
  const hard = difficulty === "hard";
  const ra = requiredActor(G);
  if (!ra || ra.seat !== seat) return null;
  if (ra.kind === "bid") return { type: "bid", value: hard ? aiBidDecisionSearch(G, seat) : aiBidDecision(G, seat, easy) };
  if (ra.kind === "trump") return { type: "trump", suit: aiPickTrump(G, seat) };
  if (ra.kind === "call") return { type: "call", card: aiPickPartner(G, seat) };
  if (ra.kind === "play") return { type: "play", card: hard ? choosePIMCCard(G, seat) : chooseAICard(G, seat, easy) };
  return null;
}

export { aiActionFor };
