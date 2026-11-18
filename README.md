# AIxodia Workers

The Cloudflare Workers that sit in front of AIxodia's origins. Three Workers,
three jobs, no shared storage between them.

| Directory | Worker | Serves |
|---|---|---|
| `auth/` | `aixodia-auth` | sign-in: device codes, sessions, tokens, Access JWT verification |
| `engine-gateway/` | `aixodia-engine-gateway` | `GET /api/engines` — the registry from the `engines` table in D1 — and, when a deployment has more than one machine, one public address for all of them |
| `mcp-gateway/` | `aixodia-mcp-gateway` | one public address for every droidime device: `mcp.aixodia.dpdns.org/<device>/…` |

Each directory is a self-contained Worker with its own `wrangler.toml`, its own
storage binding and its own tests. They live in one repository because they deploy
the same way and answer on the same zone; they share no code, no storage namespace
and no secret.

Where the data lives:

| Worker | Storage |
|---|---|
| `auth` | KV `AIXODIA_CONFIG` (allowlist, sync secret, Access team) + D1 `aixodia` (codes, tokens, rate limits) |
| `engine-gateway` | D1 `aixodia`, table `engines` — the engine registry and the origin each one answers on |
| `mcp-gateway` | KV `DEVICE_TUNNELS` — one entry per droidime device |

`schema.sql` is the D1 schema these Workers rely on; it is idempotent and applied
by hand.

## Rules

* One Worker owns one storage namespace. A Worker never reads or writes another
  Worker's namespace. The D1 database is the one shared store, and each table has
  one owner: `engines` belongs to `engine-gateway`, the sign-in tables to `auth`.
* Nothing here is imported by the engine, the console or the Android app. They
  reach these Workers over HTTPS only.
* Deploys are manual (`wrangler deploy`) and are not tied to a push.

## Test

```bash
cd auth           && npm test
cd engine-gateway && npm test
cd mcp-gateway    && npm test
```

## Deploy

Each directory's `README.md` lists the Cloudflare resources it needs and the
`wrangler` commands, in the order they have to run: KV namespace, service token
secrets, then the deploy.

The engine and both gateways share one Cloudflare Access service-token policy
shape but not one token: the credential a Worker presents is a secret binding on
that Worker, and the record of what was created is kept in that Worker's own KV.
