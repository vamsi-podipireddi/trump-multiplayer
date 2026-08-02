/* Below this many same-tier, non-mixed matches, recentForm says nothing
   rather than showing a number that's mostly noise. Small enough to reach
   after a handful of games, large enough that one fluke result can't read
   as a trend. */
const MIN_RECENT_FORM = 3;

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
    /* Cannot throw — readRecentForm swallows its own failure and returns null
       — deliberately, so a successful totals fetch is never discarded by the
       newer query failing. See its own comment below. */
    const recentForm = await readRecentForm(env, uid);
    return json({ available: true, games: row.games | 0, wins: row.wins | 0, bidsWon: row.bidsWon | 0, bidsMade: row.bidsMade | 0, recentForm });
  } catch {
    return json({ available: false });
  }
}

/* Recent-form line for the join screen (Task 10) — scoped to ONE difficulty,
   never pooled. A win rate (and the report card's own headline) is invariant
   to match length but not to bot difficulty, so a run of easy matches would
   read as improvement; see app/js/coach/report.js's header comment for the
   same rule applied to the report card. The tier is whichever difficulty the
   player's most recent match was recorded under — "recent form" is naturally
   about whatever they've been playing lately. Matches flagged
   difficulty_mixed (the host changed tiers mid-match, src/core/room/
   handlers.js's handleSettings) are dropped entirely: a match played across
   two tiers has no single difficulty its result can honestly be charged to.
   Below MIN_RECENT_FORM matches in that tier, returns null — silence beats a
   number whose meaning depends on which bots the player happened to face.

   Its own try/catch, never the caller's (fix round I2). This query reads
   `difficulty`/`difficulty_mixed`, which migrations/0002-difficulty.sql adds;
   the totals query above reads only columns 0001 already had. Sharing one
   try meant a database with 0001 but not 0002 — the guaranteed state in any
   window between deploying this Worker and running 0002, and the permanent
   state for anyone who applied only the migration the earlier era documented
   — threw "no such column: difficulty" out of a query that had ALREADY
   succeeded, and answered {available:false}: the pre-existing "Your record"
   line vanished entirely, indistinguishable from having no database at all.
   Recent form is the newer, optional line; it degrades to null on its own
   and takes nothing else with it. */
async function readRecentForm(env, uid) {
  try {
    const res = await env.DB.prepare(
      "SELECT difficulty, difficulty_mixed, won, bids_won, bids_made FROM matches " +
      "WHERE uid = ? ORDER BY ts DESC LIMIT 20"
    ).bind(uid).all();
    const rows = (res && res.results) || [];
    const tier = rows.length ? rows[0].difficulty : null;
    if (!tier) return null; // no matches yet, or the newest predates this column
    const scoped = rows.filter(r => r.difficulty === tier && !r.difficulty_mixed);
    if (scoped.length < MIN_RECENT_FORM) return null;
    return {
      difficulty: tier,
      n: scoped.length,
      wins: scoped.reduce((s, r) => s + (r.won ? 1 : 0), 0),
      bidsWon: scoped.reduce((s, r) => s + (r.bids_won || 0), 0),
      bidsMade: scoped.reduce((s, r) => s + (r.bids_made || 0), 0),
    };
  } catch { return null; } // one line's worth of degradation, never the whole response
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
        "INSERT INTO matches (uid, name, room, won, match_id, deals, bids_won, bids_made, difficulty, difficulty_mixed, ts) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(p.uid, p.name, room.code, G.scores[seat] === max ? 1 : 0,
             G.matchId || null, history.length, declared.length,
             declared.filter(d => d.made).length,
             /* The tier in effect when the match ended — not necessarily the
                only one it was played at, which is exactly what
                _difficultyMixed (handlers.js's handleSettings, lives on G the
                same way _statsRecorded does: a rematch swaps in a fresh G) is
                for. */
             room.settings.difficulty, G._difficultyMixed ? 1 : 0,
             Date.now()));
    }
    if (stmts.length) await env.DB.batch(stmts);
  } catch { /* stats are best-effort */ }
}

export { readStats, writeMatchStats };
