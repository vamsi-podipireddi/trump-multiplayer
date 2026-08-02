/* Optional player stats, backed by D1 when a DB binding exists (see schema.sql). */
async function readStats(env, uid) {
  const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
  if (!env.DB) return json({ available: false });
  if (!uid) return json({ error: "missing uid" }, 400);
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS games, SUM(won) AS wins, " +
      /* COALESCE, not a filter: rows written before the migration keep
         contributing their still-correct games and wins, and contribute zero —
         rather than a wrong number — to the bid counters they never held. */
      "SUM(COALESCE(bids_won, 0)) AS bidsWon, SUM(COALESCE(bids_made, 0)) AS bidsMade " +
      "FROM matches WHERE uid = ?"
    ).bind(uid).first();
    return json({ available: true, games: row.games | 0, wins: row.wins | 0, bidsWon: row.bidsWon | 0, bidsMade: row.bidsMade | 0 });
  } catch {
    return json({ available: false });
  }
}

/* One row per human seat at matchOver, when a D1 binding exists (M8/D10). */
async function writeMatchStats(env, room) {
  if (!env.DB || !room || room.G.phase !== "matchOver") return;
  if (room.G._statsRecorded) return;
  room.G._statsRecorded = true; // lives on G: a rematch swaps in a fresh G, clearing it
  const G = room.G;
  const max = Math.max(...G.scores);
  try {
    const stmts = [];
    const history = G.dealHistory || [];
    for (let seat = 0; seat < 4; seat++) {
      const owner = room.seatOwner[seat];
      const p = owner != null ? room.players[owner] : null;
      if (!p || !p.uid) continue;
      /* Every deal this seat declared, not just the last one — the bug this
         replaces read G.lastResult, so a player who won four bids and made all
         four then lost the fifth deal recorded bidsWon: 0. */
      const declared = history.filter(d => d.declarer === seat);
      stmts.push(env.DB.prepare(
        "INSERT INTO matches (uid, name, room, won, match_id, deals, bids_won, bids_made, ts) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(p.uid, p.name, room.code, G.scores[seat] === max ? 1 : 0,
             G.matchId || null, history.length, declared.length,
             declared.filter(d => d.made).length, Date.now()));
    }
    if (stmts.length) await env.DB.batch(stmts);
  } catch { /* stats are best-effort */ }
}

export { readStats, writeMatchStats };
