/* ============================================================
   TRUMP — authoritative game engine (server-side, no I/O)
   250-point bid/capture trick game. All functions operate on an
   explicit game object G (no globals), so one process can run many
   rooms. The server drives timing + networking; this file is pure logic.
   Seats: 0,1,2,3 clockwise. Card points total 250:
   A/K/Q/J/10=10, each 5=5, one random suit's 3 = 30.
   ============================================================ */

import { SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP,
         TOTAL_POINTS, TARGET_GAMES, MAX_REDEALS } from "./app/js/core/engine/constants.js";
import { randomInt } from "./app/js/core/engine/random.js";
import { sameCard, rankLabel, cardStr } from "./app/js/core/engine/cards.js";
import { cardPoints, sideOf, defenders } from "./app/js/core/engine/scoring.js";
import { createMatch, startMatch, nextDeal, publicView } from "./app/js/core/engine/match.js";
import { findBidActor, minNextBid, bidIsLegal, applyBid } from "./app/js/core/engine/bidding.js";
import { applyTrump, callableCards, callIsLegal, applyCall } from "./app/js/core/engine/contract.js";
import { legalCards, playIsLegal, applyPlay, advanceTrick } from "./app/js/core/engine/play.js";
import { requiredActor } from "./app/js/core/engine/flow.js";
import { aiActionFor } from "./app/js/core/engine/ai/index.js";
import { choosePIMCCard, determinize } from "./app/js/core/engine/ai/pimc.js";

export {
  SUITS, RANKS, NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP, TOTAL_POINTS, TARGET_GAMES, MAX_REDEALS,
  createMatch, startMatch, nextDeal,
  applyBid, bidIsLegal, minNextBid, findBidActor,
  applyTrump, applyCall, callIsLegal, callableCards,
  applyPlay, playIsLegal, advanceTrick, legalCards,
  aiActionFor, requiredActor, publicView,
  cardPoints, sameCard, sideOf, defenders, cardStr, rankLabel,
  choosePIMCCard, randomInt, determinize as _determinize,
};
