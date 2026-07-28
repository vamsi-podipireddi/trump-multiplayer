/* ============================================================
   TRUMP — authoritative game engine (server-side, no I/O)
   250-point bid/capture trick game. All functions operate on an
   explicit game object G (no globals), so one process can run many
   rooms. The server drives timing + networking; this file is pure logic.
   Seats: 0,1,2,3 clockwise. Card points total 250:
   A/K/Q/J/10=10, each 5=5, one random suit's 3 = 30.
   ============================================================ */

/* The engine's public surface. Consumers import this file, never a leaf
   module; leaves import each other directly (the barrel would be a cycle). */
export { SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP,
         TOTAL_POINTS, TARGET_GAMES, MAX_REDEALS } from "./constants.js";
export { randomInt } from "./random.js";
export { sameCard, cardStr, rankLabel } from "./cards.js";
export { cardPoints, sideOf, defenders } from "./scoring.js";
export { createMatch, startMatch, nextDeal, publicView } from "./match.js";
export { applyBid, bidIsLegal, minNextBid, findBidActor } from "./bidding.js";
export { applyTrump, applyCall, callIsLegal, callableCards } from "./contract.js";
export { applyPlay, playIsLegal, advanceTrick, legalCards } from "./play.js";
export { requiredActor } from "./flow.js";
export { aiActionFor } from "./ai/index.js";
export { choosePIMCCard, determinize as _determinize } from "./ai/pimc.js";
