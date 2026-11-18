//! The front door of `engine.aixodia.dpdns.org`.
//!
//! A client is given one address and nothing else: this hostname. What is on the
//! other side of it is a set of engines, each reachable at `/<name>/…`, and only
//! this Worker knows which of them exist:
//!
//! * `GET /api/engines` — the registry, read from D1, with each engine's lease
//!   and version.
//! * `/<name>/…` — forwarded to that engine's own tunnel origin, which serves
//!   the path itself (the engine takes its name off before routing).
//! * anything else — forwarded to the first engine, unchanged. That keeps
//!   `/healthz` and `/api/…` answers for a client built before the name path.
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

/// How long a heartbeat keeps an engine online. Three beats: one lost write is
/// not a death, two in a row is.
const LEASE_SECONDS = 60;

/// How long this isolate may reuse the rows it forwards to. Engines are added
/// and renamed by hand, so a few seconds of staleness costs nothing.
const ROUTE_CACHE_MS = 10_000;

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

/// The engines with their lease read out, newest registration last.
async function engines(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, url, origin_host, subtitle, tag, version, " +
      `(heartbeat_at > 0 AND unixepoch() - heartbeat_at <= ${LEASE_SECONDS}) AS online ` +
      "FROM engines ORDER BY created_at, id"
  ).all();
  return (Array.isArray(results) ? results : []).map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    origin_host: row.origin_host,
    subtitle: row.subtitle,
    tag: row.tag,
    online: row.online === 1 || row.online === true,
    version: row.online === 1 || row.online === true ? row.version || "" : ""
  }));
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
  for (const [name, value] of Object.entries(tokenHeaders(env))) headers.set(name, value);

  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

  const response = await fetch(target.toString(), init);
  // A WebSocket answer has to be handed back untouched: wrapping it would drop
  // the upgrade. Everything else can be re-wrapped to keep the body streaming.
  if (response.webSocket || response.status === 101) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
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
