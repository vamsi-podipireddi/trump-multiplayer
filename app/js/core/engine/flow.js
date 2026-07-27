import { NUM_PLAYERS } from "./constants.js";
import { findBidActor } from "./bidding.js";

// ============================================================
//  Driver helpers (server queries)
// ============================================================
/* Who must act now and what kind of action; null if the phase is a
   timed transition (trickEnd/roundEnd/matchOver/lobby). */
function requiredActor(G) {
  switch (G.phase) {
    case "bidding": { const s = findBidActor(G); return s === null ? null : { seat: s, kind: "bid" }; }
    case "trumpSelect": return { seat: G.declarer, kind: "trump" };
    case "partnerSelect": return { seat: G.declarer, kind: "call" };
    case "playing": return G.trick.length < NUM_PLAYERS ? { seat: G.turn, kind: "play" } : null;
    default: return null;
  }
}

export { requiredActor };
