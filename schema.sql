-- The `aixodia` D1 database, for the Workers in this repository.
--
-- Applied by hand (`npx wrangler d1 execute aixodia --remote --file=schema.sql`)
-- because there is no migration runner here. Every statement is idempotent.

-- The engine registry: which engines exist, what they are called, and where
-- their own tunnel answers. This is the one place that answers "which engines
-- are there" — the console asks the gateway, the gateway answers from here, and
-- the sign-in Worker reads the same rows to push revocations to every engine.
CREATE TABLE IF NOT EXISTS engines (
  id          TEXT PRIMARY KEY,          -- the machine name the engine gives itself
  name        TEXT NOT NULL,             -- what a person sees in the switcher
  url         TEXT NOT NULL,             -- public base URL a client should call
  origin_host TEXT,                      -- <machine>.aixodia.dpdns.org, the tunnel origin
  subtitle    TEXT,
  tag         TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  -- When the gateway last got a healthy answer from this engine's /healthz, and
  -- the version it reported. The gateway answers from these stamps and probes
  -- afterwards, so a client never waits for a round trip through the tunnel.
  online_at      INTEGER NOT NULL DEFAULT 0,
  online_version TEXT NOT NULL DEFAULT ''
);
