import { requiredActor } from "../flow.js";
import { aiBidDecision, aiPickTrump, aiPickPartner, chooseAICard } from "./heuristic.js";
import { choosePIMCCard } from "./pimc.js";
import { aiBidDecisionSearch, aiPickTrumpSearch, aiPickPartnerSearch } from "./bid-search.js";

/* The action an AI would take for the seat that currently must act.
   difficulty: "easy" | "normal" | "hard" (legacy boolean easy also accepted).

   "hard" is the only tier that simulates anything: it searches all four
   decisions (ai/bid-search.js for the auction, ai/pimc.js for the card), while
   easy and normal answer every one of them with ai/heuristic.js's linear
   hand-count. Keeping the auction heuristic below "hard" is deliberate — the
   three tiers are meant to differ in how much the bots *know*, and an auction
   the lower tiers also searched would make them differ only in card play.

   Difficulty is one room setting applied to every bot (src/core/room/drive.js),
   so the shipped shape of this branch is four searching seats bidding against
   each other, not one against three hand-counters. That regime is measured in
   scripts/bench-auction-search.js's `table` section: the auction settles ~13
   points higher and the extra ambition is paid for, not merely spent. */
function aiActionFor(G, seat, difficulty) {
  const easy = difficulty === true || difficulty === "easy";
  const hard = difficulty === "hard";
  const ra = requiredActor(G);
  if (!ra || ra.seat !== seat) return null;
  if (ra.kind === "bid") return { type: "bid", value: hard ? aiBidDecisionSearch(G, seat) : aiBidDecision(G, seat, easy) };
  if (ra.kind === "trump") return { type: "trump", suit: hard ? aiPickTrumpSearch(G, seat) : aiPickTrump(G, seat) };
  if (ra.kind === "call") return { type: "call", card: hard ? aiPickPartnerSearch(G, seat) : aiPickPartner(G, seat) };
  if (ra.kind === "play") return { type: "play", card: hard ? choosePIMCCard(G, seat) : chooseAICard(G, seat, easy) };
  return null;
}

export { aiActionFor };
