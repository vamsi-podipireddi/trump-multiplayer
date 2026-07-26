-- ============================================================
--  TRUMP — optional player stats (Cloudflare D1).
--
--  Entirely opt-in: the Durable Object writes here only when a DB
--  binding exists (see wrangler.toml). With no binding the game runs
--  exactly as before and /stats reports {available:false}.
--
--  Setup:
--    npx wrangler d1 create trump-stats
--    npx wrangler d1 execute trump-stats --remote --file=./schema.sql
--    # then uncomment the [[d1_databases]] block in wrangler.toml
--
--  One row per human seat per finished match. `uid` is a random id the
--  browser mints into localStorage — no accounts, no personal data.
-- ============================================================

CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT    NOT NULL,          -- localStorage "trump_uid"
  name          TEXT    NOT NULL,          -- display name at match end
  room          TEXT    NOT NULL,
  won           INTEGER NOT NULL DEFAULT 0, -- 1 if this seat tied/held the top deal count
  was_declarer  INTEGER NOT NULL DEFAULT 0, -- 1 if this seat won the final deal's bid
  bid_made      INTEGER NOT NULL DEFAULT 0, -- 1 if that contract was made
  ts            INTEGER NOT NULL            -- epoch ms
);

CREATE INDEX IF NOT EXISTS matches_uid_idx ON matches (uid);
CREATE INDEX IF NOT EXISTS matches_ts_idx  ON matches (ts);
