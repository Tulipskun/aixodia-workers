# AIxodia engine gateway

Gives every machine's engine its own path on **one** public hostname:

```
https://engines.aixodia.dpdns.org/<machine>/api/...   →   https://<machine>.aixodia.dpdns.org/api/...
https://engines.aixodia.dpdns.org/engines             →   {"engines": [...]}
```

`<machine>` is the name the engine gives itself: `m-` plus eight hex digits of
its `/etc/machine-id`, or whatever `AIXODIA_INSTANCE` overrides it with. It is
printed at startup (`machine m-…`) and returned by `/healthz` as `instance`.

The Worker reads the first path segment, looks it up in the **`engines` table in
D1**, removes the segment, and forwards the request to that instance's own Named
Tunnel origin with the Cloudflare Access service token attached. The engine
therefore keeps serving the paths it always served (`/api/...`, `/ws`,
`/healthz`) and needs no knowledge of the shared address.

## The registry is one table

```sql
CREATE TABLE engines (
  id          TEXT PRIMARY KEY,      -- the machine name
  name        TEXT NOT NULL,         -- what a person sees in the switcher
  url         TEXT NOT NULL,         -- public base URL a client should call
  origin_host TEXT,                  -- <machine>.aixodia.dpdns.org
  subtitle    TEXT,
  tag         TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

`schema.sql` in the repository root creates it and is idempotent.

* `GET /engines` answers the registry (id, name, url, subtitle, tag — never the
  tunnel hostname) so the console's engine switcher has one source of truth.
* Every proxied request reads `origin_host` from the same row.
* The sign-in Worker reads the same `url` column when it pushes a revocation to
  every engine, so a new engine is one `INSERT` for all three consumers.

Adding a machine is a row, not a deploy:

```bash
npx wrangler d1 execute aixodia --remote --command \
  "INSERT INTO engines (id, name, url, origin_host) VALUES
     ('m-abc12345', 'Work phone', 'https://engines.aixodia.dpdns.org/m-abc12345', 'm-abc12345.aixodia.dpdns.org')"
```

## Why a gateway instead of one hostname per engine

A tunnel per engine is still needed — each engine is a separate machine or a
separate process with its own credentials — but a client should not have to learn
a new hostname per engine, and a DNS record per engine is one more thing to
provision and protect. One hostname, one Access policy, one certificate, and a
path segment that names the instance.

## Cloudflare resources

- Zone `aixodia.dpdns.org` on the account.
- Worker route `engines.aixodia.dpdns.org/*`.
- D1 database `aixodia` bound as `DB`, holding the `engines` table.
- A proxied DNS record for `engines.aixodia.dpdns.org` (a CNAME to
  `aixodia.dpdns.org` is enough) or the route has no name to answer on.
- Access application protecting `*.aixodia.dpdns.org/*` with a service-token
  policy, and that token stored as the `ACCESS_CLIENT_ID` /
  `ACCESS_CLIENT_SECRET` secrets.

The Worker fails closed: no origin credential, no answer.

## Deploy

```bash
npx wrangler d1 execute aixodia --remote --file=../schema.sql
npx wrangler deploy
```

The Worker needs a service token to reach an Access-protected origin. Its secret
is shown once, when it is created, so keep a copy where the next session can find
it: the `system_state` table in D1 holds `gateway/access_client_id` and
`gateway/access_client_secret` for this Worker. Nothing auth-related is written
there, and this Worker reads nothing from the auth Worker's namespace.

```bash
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"aixodia-engine-gateway","duration":"87600h"}' \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/access/service_tokens"
# client_id and client_secret above -> system_state, then:
printf '%s' "$CLIENT_ID"     | npx wrangler secret put ACCESS_CLIENT_ID
printf '%s' "$CLIENT_SECRET" | npx wrangler secret put ACCESS_CLIENT_SECRET
```

The token also has to be allowed by the origin's Access application: add a
`non_identity` policy whose include is `service_token.token_id` = that token.

## Provisioning a machine

`<machine>` below is the engine's own name: `aixodia status` (or the log line
`machine m-…`) prints it after the engine has started once, and `/healthz`
returns it as `instance`. Nothing on the machine needs configuring.

1. Create a remotely-managed Named Tunnel for the machine.
2. Point its public hostname `<machine>.aixodia.dpdns.org` at
   `http://localhost:8787` — the engine's port is the same on every machine.
   A machine that already runs a tunnel only needs one more ingress rule and a
   proxied CNAME to the tunnel's `…cfargotunnel.com` target.
3. Protect that hostname with the Access service-token policy.
4. `INSERT` the row above.
5. Write the engine's own two keys in Workers KV `AIXODIA_CONFIG`:
   `instances/<machine>/tunnel_token` (the tunnel connector token) and
   `instances/<machine>/tunnel_url` (`https://<machine>.aixodia.dpdns.org`).
6. `aixodia start` — `CF_TOKEN` is the only variable it needs.

The engine publishes its live address to `instances/<machine>/daemon/url` and its
version to `instances/<machine>/daemon/version`.

## Test

```bash
npm test
```
