import { requiredActor } from "../flow.js";
import { aiBidDecision, aiPickTrump, aiPickPartner, chooseAICard } from "./heuristic.js";
import { choosePIMCCard } from "./pimc.js";

/* The action an AI would take for the seat that currently must act.
   difficulty: "easy" | "normal" | "hard" (legacy boolean easy also accepted). */
function aiActionFor(G, seat, difficulty) {
  const easy = difficulty === true || difficulty === "easy";
  const hard = difficulty === "hard";
  const ra = requiredActor(G);
  if (!ra || ra.seat !== seat) return null;
  if (ra.kind === "bid") return { type: "bid", value: aiBidDecision(G, seat, easy) };
  if (ra.kind === "trump") return { type: "trump", suit: aiPickTrump(G, seat) };
  if (ra.kind === "call") return { type: "call", card: aiPickPartner(G, seat) };
  if (ra.kind === "play") return { type: "play", card: hard ? choosePIMCCard(G, seat) : chooseAICard(G, seat, easy) };
  return null;
}

export { aiActionFor };
