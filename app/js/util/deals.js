/* Finished deals, kept on this device so the match-over report card has
   something to grade. Deliberately client-side (D46): the DO pays nothing, no
   protocol changes, and a refresh or a reconnect keeps the data. The accepted
   cost is that a second device cannot grade deals it did not play — which the
   card states rather than hides (D45).

   Every storage access is wrapped exactly as util/prefs.js wraps its own:
   storage is a privilege, not a guarantee. Safari in private mode throws on
   read and write, and a quota is reachable — neither may stop a render. */

const PREFIX = "trump_deals:";
const MAX_MATCHES = 3;
const key = (room, matchId) => `${PREFIX}${room}:${matchId}`;

/* Exactly the fields reviewDeal (positionBefore) and reviewAuction
   (auctionPosition) read — nothing else. Notably NOT v.you: a snapshot must
   never carry a hand, so a stale one can never become a second source of one. */
function snapshotOf(v) {
  return {
    roundNumber: v.roundNumber, tricks: v.tricks || [], auction: v.auction || [],
    trump: v.trump, calledCard: v.calledCard, declarer: v.declarer, partner: v.partner,
    bid: v.bid, bonusSuit: v.bonusSuit, dealer: v.dealer,
    names: (v.names || []).slice(), scores: (v.scores || []).slice(),
    lastResult: v.lastResult || null, teamsRevealed: !!v.teamsRevealed,
    consts: { TARGET_GAMES: v.consts ? v.consts.TARGET_GAMES : 5 },
  };
}

function read(k) {
  try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch { return null; }
}

/* Evicts this room's other matches, then trims to MAX_MATCHES globally by the
   `ts` each record carries. A finished match's snapshots are worthless, so the
   cap is a housekeeping floor, not a retention policy. */
function evict(room, matchId) {
  try {
    const mine = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      if (k.startsWith(`${PREFIX}${room}:`) && k !== key(room, matchId)) { localStorage.removeItem(k); continue; }
      const rec = read(k);
      mine.push({ k, ts: (rec && rec.ts) || 0 });
    }
    mine.sort((a, b) => b.ts - a.ts);
    mine.slice(MAX_MATCHES).forEach(e => localStorage.removeItem(e.k));
  } catch { /* housekeeping is best-effort */ }
}

/* Idempotent by roundNumber: screens/game.js calls this on every render while
   the round-result modal is up, so the same deal must overwrite rather than
   accumulate. */
function saveDeal(room, matchId, snapshot) {
  if (!room || !matchId || !snapshot || snapshot.roundNumber == null) return;
  const k = key(room, matchId);
  const rec = read(k) || { ts: 0, deals: [] };
  const i = rec.deals.findIndex(d => d.roundNumber === snapshot.roundNumber);
  if (i >= 0) rec.deals[i] = snapshot; else rec.deals.push(snapshot);
  rec.ts = rec.deals.length;   // monotone without a clock; only used to order evictions
  try { localStorage.setItem(k, JSON.stringify(rec)); } catch { return; }
  evict(room, matchId);
}

function loadDeals(room, matchId) {
  const rec = read(key(room, matchId));
  return rec && Array.isArray(rec.deals)
    ? rec.deals.slice().sort((a, b) => a.roundNumber - b.roundNumber)
    : [];
}

export { snapshotOf, saveDeal, loadDeals };
