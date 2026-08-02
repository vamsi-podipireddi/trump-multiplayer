-- Applied to an existing trump-stats database:
--   npx wrangler d1 execute trump-stats --remote --file=./migrations/0002-difficulty.sql
--
-- difficulty is written from room.settings.difficulty at match end (the
-- tier in effect when the match finished, not necessarily the only one it
-- was played at — see difficulty_mixed). Rows written before this migration
-- have no difficulty on record: NULL, not a guessed tier, for the same
-- reason 0001 left was_declarer/bid_made alone rather than reinterpreting
-- them — there is no way to recover it after the fact.
--
-- difficulty_mixed defaults to 0 (not mixed) for existing rows. That default
-- is a documented gap, not a claim: a pre-migration match that actually
-- switched tiers mid-way reads as "not mixed" because whether it did is
-- exactly the fact that was never recorded. Only rows written by the
-- difficulty-aware writeMatchStats carry a trustworthy 0.
ALTER TABLE matches ADD COLUMN difficulty       TEXT;
ALTER TABLE matches ADD COLUMN difficulty_mixed INTEGER NOT NULL DEFAULT 0;
