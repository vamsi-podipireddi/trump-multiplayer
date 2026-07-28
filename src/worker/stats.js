/* Optional player stats, backed by D1 when a DB binding exists (see schema.sql). */
async function readStats(env, uid) {
  const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
  if (!env.DB) return json({ available: false });
  if (!uid) return json({ error: "missing uid" }, 400);
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS games, SUM(won) AS wins, SUM(was_declarer) AS bidsWon, SUM(bid_made) AS bidsMade FROM matches WHERE uid = ?"
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
    for (let seat = 0; seat < 4; seat++) {
      const owner = room.seatOwner[seat];
      const p = owner != null ? room.players[owner] : null;
      if (!p || !p.uid) continue;
      const r = G.lastResult || {};
      stmts.push(env.DB.prepare(
        "INSERT INTO matches (uid, name, room, won, was_declarer, bid_made, ts) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(p.uid, p.name, room.code, G.scores[seat] === max ? 1 : 0,
             r.declarer === seat ? 1 : 0, r.declarer === seat && r.made ? 1 : 0, Date.now()));
    }
    if (stmts.length) await env.DB.batch(stmts);
  } catch { /* stats are best-effort */ }
}

export { readStats, writeMatchStats };
