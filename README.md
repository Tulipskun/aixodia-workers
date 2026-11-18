# AIxodia Workers

The Cloudflare Workers that sit in front of AIxodia's origins. Three Workers,
three jobs, no shared storage between them.

| Directory | Worker | Serves |
|---|---|---|
| `auth/` | `aixodia-auth` | sign-in: device codes, sessions, tokens, Access JWT verification |
| `engine-gateway/` | `aixodia-engine-gateway` | one public address for every engine machine: `engines.aixodia.dpdns.org/<machine>/…` |
| `mcp-gateway/` | `aixodia-mcp-gateway` | one public address for every droidime device: `mcp.aixodia.dpdns.org/<device>/…` |

Each directory is a self-contained Worker with its own `wrangler.toml`, its own
KV namespace binding and its own tests. They live in one repository because they
deploy the same way and answer on the same zone; they share no code, no KV
namespace and no secret.

## Rules

* One Worker owns one KV namespace. A Worker never reads or writes another
  Worker's namespace.
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
