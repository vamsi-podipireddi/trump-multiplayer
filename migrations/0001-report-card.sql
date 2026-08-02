-- Applied to an existing trump-stats database:
--   npx wrangler d1 execute trump-stats --remote --file=./migrations/0001-report-card.sql
--
-- was_declarer / bid_made are deliberately left in place and left alone. They
-- were derived from the final deal of a match only, so their historical values
-- cannot be recomputed and must not be reinterpreted as the new counters.
ALTER TABLE matches ADD COLUMN match_id  TEXT;
ALTER TABLE matches ADD COLUMN deals     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN bids_won  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN bids_made INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS matches_match_idx ON matches (match_id);
