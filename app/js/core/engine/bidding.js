import { NUM_PLAYERS, MIN_BID, MAX_BID, BID_STEP, MAX_REDEALS } from "./constants.js";
import { logG, name } from "./log.js";
import { deal } from "./match.js";

// ============================================================
//  Auction
// ============================================================
function findBidActor(G) {
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const p = (G.bidTurn + i) % NUM_PLAYERS;
    if (G.bidActive.includes(p) && p !== G.highBidder) return p;
  }
  return null;
}
function minNextBid(G) { return G.highBid === null ? MIN_BID : G.highBid + BID_STEP; }
function bidIsLegal(G, p, value) {
  if (G.phase !== "bidding" || findBidActor(G) !== p) return false;
  if (value === null) return true;
  return Number.isInteger(value) && value >= minNextBid(G) && value <= MAX_BID && (value - MIN_BID) % BID_STEP === 0;
}
function applyBid(G, p, value) {
  if (value === null) { G.bidActive = G.bidActive.filter(x => x !== p); logG(G, `${name(G, p)} passes`, "bid"); }
  /* A pass deliberately does not write to `bids` — leaving `bidActive` is what marks
     a seat as folded. That keeps bids[p] number-or-null, so the table can tell
     "passed" from "hasn't acted yet" without a sentinel value. */
  else { G.highBid = value; G.highBidder = p; G.bids[p] = value; logG(G, `${name(G, p)} bids ${value}`, "bid"); }
  G.bidTurn = (p + 1) % NUM_PLAYERS;
  advanceBidding(G);
}
function advanceBidding(G) {
  if (G.bidActive.length === 0) { redeal(G); return; }
  const actor = findBidActor(G);
  if (actor === null) { finalizeDeclarer(G); return; }
  G.bidTurn = actor;
}
function forceBid(G) {
  const eldest = (G.dealer + 1) % NUM_PLAYERS;
  G.highBidder = eldest; G.highBid = MIN_BID;
  logG(G, `${name(G, eldest)} is forced to take the minimum bid of ${MIN_BID}.`, "bid");
  finalizeDeclarer(G);
}
function finalizeDeclarer(G) {
  G.declarer = G.highBidder; G.bid = G.highBid; G.redealCount = 0;
  logG(G, `★ ${name(G, G.declarer)} wins the bid at ${G.bid} — choosing trump…`, "bid");
  G.phase = "trumpSelect";
}
function redeal(G) {
  G.redealCount++;
  if (G.redealCount > MAX_REDEALS) { forceBid(G); return; }
  logG(G, `Everyone passed — redealing (${G.redealCount}).`, "bid");
  deal(G);
}

export { findBidActor, minNextBid, bidIsLegal, applyBid, advanceBidding, forceBid, finalizeDeclarer, redeal };
