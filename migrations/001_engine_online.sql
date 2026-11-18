-- The gateway's health stamps for each engine.
--
-- `online_at` is when the gateway last got a healthy answer from that engine's
-- `/healthz` (`0` = never), and `online_version` is the version it reported. The
-- gateway answers the registry from these stamps and probes afterwards, so a
-- client never pays for a round trip through the tunnel on the way to a list.
--
-- Applied once, by hand, like the schema itself:
--   npx wrangler d1 execute aixodia --remote --file=migrations/001_engine_online.sql
ALTER TABLE engines ADD COLUMN online_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE engines ADD COLUMN online_version TEXT NOT NULL DEFAULT '';
