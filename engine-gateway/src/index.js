//! The front door of `engine.aixodia.dpdns.org`.
//!
//! A client is given one address and nothing else: this hostname. What is on the
//! other side of it is a set of engines, each reachable at `/<name>/…`, and only
//! this Worker knows which of them exist:
//!
//! * `GET /api/engines` — the registry, read from D1 and answered with a live
//!   `online` flag per engine, because "which engine can I use" is the question
//!   a client actually has. The flags are probes of each engine's `/healthz`.
//! * `/<name>/…` — forwarded to that engine's own tunnel origin, which serves
//!   the path itself (the engine takes its name off before routing).
//! * anything else — forwarded to the first engine, unchanged. That keeps
//!   `/healthz` and `/api/…` answers for a client built before the name path.
//!
//! The origin hostnames are not public: each one has an Access application that
//! admits the service token below and nothing else (`non_identity`), so this
//! Worker is the only way in through them. It is also why the forward sets the
//! token rather than relying on the caller having one.

const PROBE_TIMEOUT_MS = 2000;
const REGISTRY_TTL_MS = 15_000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function error(status, message) {
  return json(status, { error: message });
}

/// The engines, cached for a few seconds so a burst of API calls is one D1 read.
const caches = new WeakMap();

async function engines(env) {
  const cache = caches.get(env.DB) || { at: 0, rows: [] };
  if (Date.now() - cache.at < REGISTRY_TTL_MS) return cache.rows;
  const { results } = await env.DB.prepare(
    "SELECT id, name, url, origin_host, subtitle, tag FROM engines ORDER BY created_at, id"
  ).all();
  const rows = Array.isArray(results) ? results : [];
  caches.set(env.DB, { at: Date.now(), rows });
  return rows;
}

/// Marks each engine with whether its own tunnel answers right now.
async function withHealth(rows, env) {
  const probes = rows.map(async (row) => {
    const base = origin(row);
    if (!base) return { ...row, online: false };
    try {
      const response = await fetch(`${base}/healthz`, {
        headers: { ...tokenHeaders(env), accept: "application/json" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      if (!response.ok) return { ...row, online: false };
      const body = await response.json().catch(() => null);
      if (!body || body.ok !== true) return { ...row, online: false };
      return { ...row, online: true, version: body.version || "" };
    } catch {
      return { ...row, online: false };
    }
  });
  return Promise.all(probes);
}

function origin(row) {
  const host = String(row.origin_host || "").trim();
  return host ? `https://${host}` : "";
}

function tokenHeaders(env) {
  const id = String(env.ACCESS_CLIENT_ID || "");
  const secret = String(env.ACCESS_CLIENT_SECRET || "");
  return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
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
      const rows = await withHealth(await engines(env), env);
      return json(200, { engines: rows });
    }

    let rows;
    try {
      rows = await engines(env);
    } catch {
      return error(503, "The engine registry is unavailable");
    }
    if (rows.length === 0) return error(503, "No engine is registered");

    // A name in the path is an engine; anything else is the first engine, which
    // is what a client that only knows the hostname expects.
    const named = rows.find((row) => row.id === first);
    const chosen = named || rows[0];
    return forward(request, chosen, env);
  }
};
