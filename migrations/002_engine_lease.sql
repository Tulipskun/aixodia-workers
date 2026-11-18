-- Liveness is a lease the engine keeps, not a probe the gateway makes.
--
-- `heartbeat_at` is written by the engine itself every twenty seconds, so
-- "online" means "its process says so, and said so recently" — the same shape
-- Consul TTL checks and Kubernetes node leases use. The gateway only reads it;
-- there is no cron and no probe on the way to an answer.
--
-- `version` is the engine's own version string, refreshed with the same write.
--
-- Applied once, by hand:
--   npx wrangler d1 execute aixodia --remote --file=migrations/002_engine_lease.sql
ALTER TABLE engines ADD COLUMN heartbeat_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE engines ADD COLUMN version TEXT NOT NULL DEFAULT '';
UPDATE engines SET heartbeat_at = online_at, version = online_version;
ALTER TABLE engines DROP COLUMN online_at;
ALTER TABLE engines DROP COLUMN online_version;
