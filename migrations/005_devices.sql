-- Phones, as a list of their own.
--
-- An engine is a machine that runs our daemon: it beats, it reports what it may
-- use, and every verb on its card is a request to that daemon. A DroidIME device
-- is a phone with a tunnel and an MCP origin — no daemon, no shells, no desktop —
-- so it is a different kind of thing in a different table, and the two lists
-- cannot be confused by a filter that one day forgets to run.
--
-- `origin_host` is the device's own Cloudflare hostname, which Access already
-- guards; `heartbeat_at` is 0 for a device that has never said anything, which
-- is why "online" is a lease and not a stored flag.
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  alias         TEXT NOT NULL DEFAULT '',
  origin_host   TEXT NOT NULL,
  subtitle      TEXT NOT NULL DEFAULT '',
  battery       INTEGER,
  heartbeat_at  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS devices_created ON devices (created_at, id);
