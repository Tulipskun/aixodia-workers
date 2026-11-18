# AIxodia engine gateway

Answers one question no single engine can answer: which engines are there.

```
https://engine.aixodia.dpdns.org/api/engines   →   {"engines": [...]}
```

The list carries a live `online` flag and the version behind it, because "which
engine can I use" is the question a client actually has: each row's own
`/healthz` is probed (2 s timeout, in parallel, with the service token) and a row
that does not answer is reported as offline rather than hidden.

```
https://engine.aixodia.dpdns.org/api/engines
  →  {"engines":[{"id":"m-8a7d1192","name":"Primary Engine",
                  "url":"https://engine.aixodia.dpdns.org/m-8a7d1192",
                  "origin_host":"m-8a7d1192.aixodia.dpdns.org",
                  "online":true,"version":"v1.177"}]}
```

## Liveness is a lease the engine keeps

`online` is not a probe result. Each engine writes `heartbeat_at` in the
`engines` table every twenty seconds, and the gateway answers with
`heartbeat_at > 0 AND unixepoch() - heartbeat_at <= 60` — the TTL-lease shape
Consul checks and Kubernetes node leases use.

Probing on the way to an answer cost the caller the whole round trip through
Access and the tunnel, needed a cron to stay fresh when nobody asked, and
measured the gateway's reach rather than the engine's life. None of that is here:
the registry is one D1 read, and `version` rides on the same beat.

The engine's own socket is what decides whether the engine a phone is on can be
reached right now — the lease only says the process is running.

## This Worker is the whole hostname

A client is given one address, `https://engine.aixodia.dpdns.org`, and nothing
else. What this Worker does with a request:

| request | what happens |
|---|---|
| `GET /api/engines` | the registry above, from D1 |
| `/<id>/…` where `<id>` is an engine | forwarded to that engine's `origin_host`, **path unchanged** |
| anything else (`/healthz`, `/api/…`) | forwarded to the first engine, unchanged |

The path is forwarded as-is because the engine takes its own name off before it
routes — the Worker does not strip anything, so one rewrite exists, not two.

Forwarding uses the engine's `origin_host`, never its `url`: the `url` is the
public address (this hostname), and fetching that from here would come straight
back to this Worker. Each origin hostname has an Access application whose only
policy is a `non_identity` service-token rule, so the token below is the one way
in:

```
ACCESS_CLIENT_ID / ACCESS_CLIENT_SECRET   (secret bindings, used by the forward)
```

`GET https://m-8a7d1192.aixodia.dpdns.org/healthz` without that token answers 403.

## Each engine has its own name

An engine is addressed as

```
https://engine.aixodia.dpdns.org/<name>/…     e.g. https://engine.aixodia.dpdns.org/m-8a7d1192/api/sessions
```

which is the same shape droidime gives its devices (`mcp…/<device>/…`). The
engine does two things itself, on startup:

* **claims a name** in the `engines` table — the desired name (`m-` plus eight
  hex digits of `/etc/machine-id`, or `AIXODIA_INSTANCE`), or `<name>-1`,
  `<name>-2`, … if that one is taken;
* **serves its name** — every route it has is also reachable under that prefix,
  so `/m-8a7d1192/healthz` is `/healthz`.

The row is found again by `origin_host`, the tunnel hostname the engine answers
on, never by the name. A restart therefore never allocates a second name, and a
machine renamed in place keeps the row it already owns.

The engine's tunnel hostname is the Worker's way in, not a client's way in: the
address a client is handed always points at this hostname and the name path.

## The registry is one table

```sql
CREATE TABLE engines (
  id          TEXT PRIMARY KEY,      -- the name in the path
  name        TEXT NOT NULL,         -- what a person sees in the switcher
  url         TEXT NOT NULL,         -- public base URL a client should call
  origin_host TEXT,                  -- the tunnel hostname that engine answers on
  subtitle    TEXT,
  tag         TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

`schema.sql` in the repository root creates it and is idempotent.

* `GET /api/engines` answers the registry — id, name, url, subtitle, tag, never
  the tunnel hostname — so the console's engine switcher has one source of truth.
* The sign-in Worker reads the same `url` column when it pushes a revocation to
  every engine, so a new engine is one row for every consumer.
* Nothing else is read here. The engine writes its own row; this Worker only
  lists.

## Why a registry instead of Workers KV

The console used to read a KV key `engines` that nothing ever wrote, so it saw one
engine, and revocation had no target. The table is written by the engines that
exist, which makes it the only place that can be wrong.

## Cloudflare resources

- Zone `aixodia.dpdns.org` on the account.
- Worker route `engine.aixodia.dpdns.org/api/engines*`.
- D1 database `aixodia` bound as `DB`, holding the `engines` table.
- The engine hostname's Access application must bypass `/api/*` and `/healthz`,
  which it does for the engine's own API anyway. A named path needs the same
  bypass under the name: `engine.aixodia.dpdns.org/<name>/api` and
  `engine.aixodia.dpdns.org/<name>/healthz` (one application each, no policy but
  `bypass`) — that is what lets the console call an engine through its name.

There is no service token here any more: nothing is forwarded, so nothing has to
authenticate to an origin.

## Deploy

```bash
npx wrangler d1 execute aixodia --remote --file=../schema.sql
npx wrangler deploy
```

## Provisioning a second machine

1. Create a remotely-managed Named Tunnel for it.
2. Point its public hostname, e.g. `work.aixodia.dpdns.org`, at
   `http://localhost:8787` — the engine's port is the same on every machine.
3. Protect that hostname with the Access application and its policies.
4. Write its own two keys in Workers KV `AIXODIA_CONFIG`:
   `instances/<machine>/tunnel_token` (the tunnel connector token) and
   `instances/<machine>/tunnel_url` (`https://work.aixodia.dpdns.org`).
5. `aixodia start` — `CF_TOKEN` is the only variable it needs. The engine inserts
   its own row (and prints the name it got: `public name …`).

Steps 1–3 are the provisioning; no `INSERT` and no deploy. Adding the named
Access bypasses for that engine's name is the only registry-side work, and only
the console needs it.

The engine publishes its live address to `instances/<machine>/daemon/url` and its
version to `instances/<machine>/daemon/version`.

## Test

```bash
npm test
```
