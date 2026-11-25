//! The front door of `engine.aixodia.dpdns.org`.
//!
//! A client is given one address and nothing else: this hostname. What is on the
//! other side of it is a set of engines, each reachable at `/<name>/…`, and only
//! this Worker knows which of them exist:
//!
//! * `GET /api/engines` — the registry, read from D1, with each engine's lease
//!   and version.
//! * `DELETE /api/engines/<id>` — forget an engine that is not running any more.
//! * `PATCH /api/engines/<id>` — set the name a person sees, without touching
//!   the id everything else addresses the machine by.
//! * `/<name>/…` — forwarded to that engine's own tunnel origin, which serves
//!   the path itself (the engine takes its name off before routing).
//! * anything else — forwarded to the first engine, unchanged. That keeps
//!   `/healthz` and `/api/…` answers for a client built before the name path.
//!
//! ## The id is the machine's, the alias is the person's
//!
//! `id` is the path segment every client, socket ticket and revocation uses, and
//! it is written by the engine itself from its machine id — so renaming an engine
//! may never change it. `alias` is a column the engine never writes: the Worker
//! owns it, and a heartbeat cannot overwrite it. An empty alias means the machine
//! has no name of its own and the registry's `name` (the id) is shown instead.
//!
//! The origin hostnames are not public: each one has an Access application that
//! admits the service token below and nothing else (`non_identity`), so this
//! Worker is the only way in through them. It is also why the forward sets the
//! token rather than relying on the caller having one.
//!
//! ## Liveness is a lease, not a probe
//!
//! `engines.heartbeat_at` is written by the engine itself every twenty seconds,
//! and `online` is nothing more than "that stamp is younger than a lease". The
//! alternative — asking each engine `/healthz` on the way to an answer — costs
//! the caller the whole round trip through Access and the tunnel, needs a timer
//! to stay fresh when nobody is asking, and answers a question about the
//! gateway's reachability rather than the engine's life. A process that stops
//! beating is offline; the app's own socket decides whether the engine it is on
//! can be reached right now.

/// The browser origins allowed to call this hostname from a page.
///
/// CORS belongs to this Worker and not to the origins behind it. Cloudflare
/// Access sits in front of every origin with a service-token policy, and it
/// answers a request that carries an `Origin` header with a bare `403` — before
/// the tunnel is even dialled. So the browser's `Origin` never travels further
/// in: the preflight is answered here, and the actual request is forwarded
/// without it. Without this a ticket POST from the console failed its preflight
/// and no socket was ever opened.
const DEFAULT_CONSOLE_ORIGINS = "https://aixodia.dpdns.org,http://localhost:5173";

const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

/// The longest name a person may give an engine. Long enough for a hostname and
/// a purpose, short enough that a card can draw it without truncating.
const ALIAS_MAX = 40;

/// How long a heartbeat keeps an engine online. Three beats: one lost write is
/// not a death, two in a row is.
const LEASE_SECONDS = 60;

/// The keys a machine writes about itself on first start. Deleting them makes
/// the next start provision a fresh tunnel, which is how a rebuilt machine gets
/// its address back.
const MACHINE_KEYS = ["tunnel_token", "tunnel_url", "daemon/url"];

/// How long this isolate may reuse the rows it forwards to. Engines are added
/// and renamed by hand, so a few seconds of staleness costs nothing.
const ROUTE_CACHE_MS = 10_000;

function consoleOrigins(env) {
  return String(env.CONSOLE_ORIGINS || DEFAULT_CONSOLE_ORIGINS)
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/// The origin a reply may be read from, or `""` when the caller is not a page.
function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  return origin && consoleOrigins(env).includes(origin) ? origin : "";
}

/// A preflight, answered without touching an engine: the origins behind this
/// hostname refuse browser origins outright, so a forwarded OPTIONS would come
/// back 403 and the browser would never send the request it was asking about.
function preflight(request, origin) {
  const headers = new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-max-age": "600",
    vary: "Origin"
  });
  const asked = request.headers.get("access-control-request-headers");
  if (asked) headers.set("access-control-allow-headers", asked);
  return new Response(null, { status: 204, headers });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function error(status, message) {
  return json(status, { error: message });
}

function tokenHeaders(env) {
  const id = String(env.ACCESS_CLIENT_ID || "");
  const secret = String(env.ACCESS_CLIENT_SECRET || "");
  return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
}

const tokenEncoder = new TextEncoder();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", tokenEncoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(req) {
  const match = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/// Check a bearer against the one table the auth Worker issues from.
///
/// Both Workers bind the same D1 database, so the live token set is local to
/// this Worker — no round trip, and a revoke takes effect on the next request.
/// This matters because the engine behind the tunnel may be an older build that
/// still honours the master token: refusing an unknown bearer here, at the only
/// public entrance, means that credential never reaches any engine.
///
/// Returns "yes" / "no" / "unavailable"; the last is a D1 fault, kept distinct
/// from a token the Worker simply does not vouch for.
async function bearerVerdict(env, token) {
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT state, expires_at FROM auth_tokens WHERE token_hash = ?1"
    ).bind(await sha256Hex(token)).first();
  } catch {
    return "unavailable";
  }
  if (!row || row.state !== "active") return "no";
  if (typeof row.expires_at === "number" && row.expires_at <= Math.floor(Date.now() / 1000)) {
    return "no";
  }
  return "yes";
}

/// The engines with their lease read out, newest registration last.
async function engines(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, alias, url, origin_host, subtitle, tag, version, " +
      `(heartbeat_at > 0 AND unixepoch() - heartbeat_at <= ${LEASE_SECONDS}) AS online ` +
      "FROM engines ORDER BY created_at, id"
  ).all();
  return (Array.isArray(results) ? results : []).map((row) => ({
    id: row.id,
    name: row.name,
    alias: row.alias || "",
    url: row.url,
    origin_host: row.origin_host,
    subtitle: row.subtitle,
    tag: row.tag,
    online: row.online === 1 || row.online === true,
    version: row.online === 1 || row.online === true ? row.version || "" : ""
  }));
}

/// One row, with its lease evaluated, or null when the registry has no such id.
async function registryRow(env, id) {
  const row = await env.DB.prepare(
    "SELECT id, name, alias, " +
      `(heartbeat_at > 0 AND unixepoch() - heartbeat_at <= ${LEASE_SECONDS}) AS online ` +
      "FROM engines WHERE id = ?1"
  )
    .bind(id)
    .first();
  if (!row) return null;
  return { id: row.id, name: row.name, alias: row.alias || "", online: row.online === 1 || row.online === true };
}

/// Who is asking. A destructive write is not something to leave to an unknown
/// bearer: the same table the auth Worker issues from decides it, and a store
/// that cannot be read refuses rather than admitting everybody.
async function whoIsAsking(request, env) {
  const claimed = bearer(request);
  if (!claimed) return { ok: false, response: json(401, { error: "a signed-in session is required", code: "NO_TOKEN" }) };
  const verdict = await bearerVerdict(env, claimed);
  if (verdict === "unavailable") return { ok: false, response: error(503, "The token store is unavailable") };
  if (verdict === "no") return { ok: false, response: json(401, { error: "unauthorized", code: "UNKNOWN_TOKEN" }) };
  return { ok: true };
}

/// Forgets an engine that is not running any more.
///
/// Offline is the whole test. A live engine is refused — it writes its own row
/// every twenty seconds, so deleting a beating row would be undone within one
/// beat and the caller would be told it had worked — and a machine that is not
/// beating is deleted, address and all, at once. "Offline" means one thing here.
async function deleteEngine(request, env, id) {
  const who = await whoIsAsking(request, env);
  if (!who.ok) return who.response;
  let row;
  try {
    row = await registryRow(env, id);
  } catch {
    return error(503, "The engine registry is unavailable");
  }
  if (!row) return error(404, `no engine named ${id}`);
  const name = row.alias || row.name;
  if (row.online) {
    return json(409, {
      error: `${name} is still beating: stop the engine, or wait for its lease to lapse`,
      code: "ENGINE_ONLINE"
    });
  }
  // Offline is the permission to delete, not a reason to refuse. One lease is
  // the whole test: a machine that is beating owns its row, and a machine that
  // is not has nothing left to argue with. A machine that comes back after being
  // deleted makes a fresh tunnel from missing keys, so nothing here needs a
  // grace period — and a grace period would only mean "offline" had two answers.
  //
  // The delete repeats the lease test rather than trusting the read above it: a
  // beat can land in the milliseconds between the two, and a caller told
  // "deleted" about an engine that is running would be told something untrue.
  let changed = 0;
  try {
    const result = await env.DB.prepare(
      `DELETE FROM engines WHERE id = ?1 AND (heartbeat_at = 0 OR unixepoch() - heartbeat_at > ${LEASE_SECONDS})`
    )
      .bind(id)
      .run();
    changed = result?.meta?.changes || 0;
  } catch {
    return error(503, "The engine registry is unavailable");
  }
  if (!changed) {
    return json(409, {
      error: `${name} started beating again: stop the engine before deleting it`,
      code: "ENGINE_ONLINE"
    });
  }
  // The row is gone, so the address is unpublishable from here on: nothing left
  // names it. So it is taken down now, and every step is reported.
  const steps = await unpublish(env, id);
  routeCaches.delete(env.DB);
  const clean = Object.values(steps).every((step) => !String(step).startsWith("failed"));
  return json(200, { ok: true, deleted: id, name: row.name, url_removed: clean, steps });
}

/// One Cloudflare API call, with the account token this Worker is given.
///
/// The token is a secret binding, never a variable: it can delete tunnels and
/// DNS records for the whole account, so it must not be readable from the
/// repository or from `/api/…` answers.
async function cloudflare(env, path, init) {
  if (!env.CF_ADMIN_TOKEN) throw new Error("CF_ADMIN_TOKEN is not configured");
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CF_ADMIN_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const why = (body.errors || []).map((e) => e.message).filter(Boolean).join("; ");
    throw new Error(why || `HTTP ${response.status}`);
  }
  return body.result;
}

/// Takes down everything a machine published about itself.
///
/// The order is the one that leaves no half-address behind: the DNS record goes
/// first so nothing resolves to a tunnel that is about to vanish, then the
/// tunnel (which is what its token was for), then the keys that would otherwise
/// let the next start reuse a tunnel that no longer exists.
///
/// A step that fails does not stop the others: the registry row is deleted
/// either way, so the caller must be told exactly which parts of the address
/// are still standing rather than a single "ok".
async function unpublish(env, id) {
  const account = env.CF_ACCOUNT_ID;
  const zone = env.CF_ZONE_ID;
  const domain = env.CF_DOMAIN || "aixodia.dpdns.org";
  const host = `${id}.${domain}`;
  const steps = {};

  // 1. The hostname clients use.
  try {
    const records = await cloudflare(env, `/zones/${zone}/dns_records?name=${encodeURIComponent(host)}`);
    const mine = (records || []).filter((r) => r.name === host);
    for (const record of mine) {
      await cloudflare(env, `/zones/${zone}/dns_records/${record.id}`, { method: "DELETE" });
    }
    steps.dns = mine.length ? `removed ${mine.length}` : "none";
  } catch (e) {
    steps.dns = `failed: ${e.message}`;
  }

  // 2. The tunnel the hostname pointed at, found by the machine's own name.
  try {
    const tunnels = await cloudflare(
      env,
      `/accounts/${account}/cfd_tunnel?name=${encodeURIComponent(id)}&is_deleted=false`
    );
    const mine = (tunnels || []).filter((t) => t.name === id);
    for (const tunnel of mine) {
      await cloudflare(env, `/accounts/${account}/cfd_tunnel/${tunnel.id}`, { method: "DELETE" });
    }
    steps.tunnel = mine.length ? `removed ${mine.length}` : "none";
  } catch (e) {
    steps.tunnel = `failed: ${e.message}`;
  }

  // 3. What the machine remembers about its address.
  try {
    if (!env.CONFIG) throw new Error("the KV binding is not configured");
    for (const key of MACHINE_KEYS) await env.CONFIG.delete(`instances/${id}/${key}`);
    steps.keys = `removed ${MACHINE_KEYS.length}`;
  } catch (e) {
    steps.keys = `failed: ${e.message}`;
  }

  return steps;
}

/// A name to show, with nothing that a card cannot draw.
function cleanAlias(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, ALIAS_MAX);
}

/// Sets the name a person sees. The id is not touched: it is the path every
/// client already uses, and renaming must not move a machine's address.
async function renameEngine(request, env, id) {
  const who = await whoIsAsking(request, env);
  if (!who.ok) return who.response;
  let body;
  try {
    body = await request.json();
  } catch {
    return error(400, 'a JSON body with an "alias" field is required');
  }
  if (!body || typeof body !== "object" || !("alias" in body)) {
    return error(400, 'the body has no "alias" field');
  }
  const alias = cleanAlias(body.alias);
  let row;
  try {
    row = await registryRow(env, id);
  } catch {
    return error(503, "The engine registry is unavailable");
  }
  if (!row) return error(404, `no engine named ${id}`);
  try {
    await env.DB.prepare("UPDATE engines SET alias = ?1, updated_at = unixepoch() WHERE id = ?2")
      .bind(alias, id)
      .run();
  } catch {
    return error(503, "The engine registry is unavailable");
  }
  routeCaches.delete(env.DB);
  return json(200, { ok: true, id, alias, name: row.name });
}

const routeCaches = new WeakMap();

/// The rows a forward needs. Kept for a few seconds in this isolate so a chat
/// does not pay a D1 read per message, and never longer than a rename takes.
async function routing(env) {
  const cache = routeCaches.get(env.DB);
  if (cache && Date.now() - cache.at < ROUTE_CACHE_MS) return cache.rows;
  const rows = await engines(env);
  routeCaches.set(env.DB, { at: Date.now(), rows });
  return rows;
}

function origin(row) {
  const host = String(row.origin_host || "").trim();
  return host ? `https://${host}` : "";
}

async function forward(request, row, env) {
  const base = origin(row);
  if (!base) return error(502, `engine ${row.id} has no origin`);
  const target = new URL(request.url);
  target.protocol = "https:";
  target.host = new URL(base).host;

  const headers = new Headers(request.headers);
  headers.delete("host");
  // Access answers a browser origin with 403, and the caller here is this
  // Worker, not the page: the page's CORS is settled below, on the way out.
  headers.delete("origin");
  headers.delete("referer");
  for (const [name, value] of Object.entries(tokenHeaders(env))) headers.set(name, value);

  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

  const response = await fetch(target.toString(), init);
  const caller = allowedOrigin(request, env);
  // A WebSocket answer has to be handed back untouched: wrapping it would drop
  // the upgrade. Everything else can be re-wrapped to keep the body streaming.
  if (response.webSocket || response.status === 101) return response;
  const echoed = new Headers(response.headers);
  if (caller) {
    echoed.set("access-control-allow-origin", caller);
    echoed.set("vary", "Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: echoed
  });
}

export default {
  async fetch(request, env) {
    if (!env.DB) return error(503, "The engine registry is not configured");

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const first = segments[0] || "";

    const isRegistry =
      (segments.length === 1 && first === "engines") ||
      (segments.length === 2 && first === "api" && segments[1] === "engines");

    if (isRegistry) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return error(405, "The registry is read-only");
      }
      try {
        return json(200, { engines: await engines(env) });
      } catch {
        return error(503, "The engine registry is unavailable");
      }
    }

    // A preflight is about this hostname, not about an engine: answer it here
    // so the real request can be forwarded on its own terms. It is asked before
    // the registry's own verbs, because a browser checks PATCH and DELETE too.
    if (request.method === "OPTIONS") {
      const origin = allowedOrigin(request, env);
      if (!origin) return error(403, "This origin is not allowed to call the gateway");
      return preflight(request, origin);
    }

    // One row of the registry, by id: the two writes a person makes about a
    // machine rather than the machine making about itself.
    if (segments.length === 3 && first === "api" && segments[1] === "engines") {
      const id = segments[2];
      if (request.method === "DELETE") return deleteEngine(request, env, id);
      if (request.method === "PATCH") return renameEngine(request, env, id);
      return error(405, `cannot ${request.method} one engine: use PATCH or DELETE`);
    }

    // A bearer is a claim, not a credential until the auth Worker vouches for
    // it. Check it here rather than trusting the engine to refuse it: an older
    // engine behind the tunnel may still accept its own master token, and this
    // Worker is the only public entrance to every engine. Requests without a
    // bearer (health probes, the registry, socket tickets) are untouched.
    const claimed = bearer(request);
    if (claimed) {
      const verdict = await bearerVerdict(env, claimed);
      if (verdict === "unavailable") return error(503, "The token store is unavailable");
      if (verdict === "no") return json(401, { error: "unauthorized", code: "UNKNOWN_TOKEN" });
    }

    let rows;
    try {
      rows = await routing(env);
    } catch {
      return error(503, "The engine registry is unavailable");
    }
    if (rows.length === 0) return error(503, "No engine is registered");

    // A name in the path is an engine; anything else is the first engine, which
    // is what a client that only knows the hostname expects.
    const named = rows.find((row) => row.id === first);
    return forward(request, named || rows[0], env);
  }
};
