//! The front door of `engine.aixodia.dpdns.org`.
//!
//! A client is given one address and nothing else: this hostname. What is on the
//! other side of it is a set of engines, each reachable at `/<name>/…`, and only
//! this Worker knows which of them exist:
//!
//! * `GET /api/engines` — the registry, read from D1 and answered with an
//!   `online` flag per engine, because "which engine can I use" is the question a
//!   client actually has.
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
//! ## Why nothing here waits for a probe
//!
//! Asking every engine `/healthz` on the way to an answer costs the client the
//! whole round trip through Access and the tunnel — hundreds of milliseconds for
//! a flag that changes on a scale of seconds. So the answer is built from stamps
//! already in the table, and the probes run **after** the response, updating
//! those stamps (`online_at`, `online_version`). A client therefore gets a fast
//! answer whose `online` means "answered within the last minute", and the next
//! answer is the fresh one.

// Nothing waits on a probe, so the timeout is only about not hanging: a busy
// engine crossing two edges can take a second and still be perfectly alive.
const PROBE_TIMEOUT_MS = 2500;
/// How old a stamp may be before the background probes run again.
const PROBE_AFTER_MS = 8000;
/// A stamp this recent still counts as online.
const ONLINE_WINDOW_MS = 60_000;
/// How long this isolate may answer from its own copy of the rows.
const ROWS_TTL_MS = 30_000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function error(status, message) {
  return json(status, { error: message });
}

/// Work that must happen but must not hold the response: the request lifetime of
/// a Worker ends with the response, so this is the one place to spend the tail.
function after(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(promise);
  else promise.catch(() => {});
}

const caches = new WeakMap();

function remembered(env) {
  return caches.get(env.DB);
}

async function readRows(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, url, origin_host, subtitle, tag, online_at, online_version " +
      "FROM engines ORDER BY created_at, id"
  ).all();
  const rows = Array.isArray(results) ? results : [];
  caches.set(env.DB, { at: Date.now(), rows });
  return rows;
}

/// The engines. Answers from this isolate's copy while it is fresh, and refreshes
/// it in the background once it is not — a client never pays for the read twice.
async function engines(env, ctx) {
  const cache = remembered(env);
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < ROWS_TTL_MS) return cache.rows;
  if (cache) {
    after(ctx, readRows(env).catch(() => {}));
    return cache.rows;
  }
  return readRows(env);
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

/// One engine's address, as the response shows it.
function isOnline(row, now) {
  const stamp = Number(row.online_at || 0) * 1000;
  return stamp > 0 && now - stamp < ONLINE_WINDOW_MS;
}

/// Probes every engine that has no fresh stamp, all at once, and writes the
/// answers straight back to the table the next request reads.
async function refreshHealth(env, rows, now) {
  const stale = rows.filter((row) => {
    if (!origin(row)) return false;
    const stamp = Number(row.online_at || 0) * 1000;
    return stamp === 0 || now - stamp > PROBE_AFTER_MS;
  });
  if (stale.length === 0) return;

  const headers = tokenHeaders(env);
  const answers = await Promise.all(
    stale.map(async (row) => {
      try {
        const response = await fetch(`${origin(row)}/healthz`, {
          headers: { ...headers, accept: "application/json" },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
        });
        if (!response.ok) return { id: row.id, online: false };
        const body = await response.json().catch(() => null);
        if (!body || body.ok !== true) return { id: row.id, online: false };
        return { id: row.id, online: true, version: String(body.version || "") };
      } catch {
        return { id: row.id, online: false };
      }
    })
  );

  const stamp = Math.floor(Date.now() / 1000);
  // Only healthy answers are written. A failed probe says nothing about a
  // machine that answered a minute ago — a busy box or a slow second must not
  // turn it offline — so the stamp it already has is left to age out of the
  // one-minute window on its own.
  const healthy = answers.filter((answer) => answer.online);
  const statements = healthy.map((answer) =>
    env.DB.prepare("UPDATE engines SET online_at = ?1, online_version = ?2 WHERE id = ?3").bind(
      stamp,
      answer.version || "",
      answer.id
    )
  );
  if (statements.length === 0) return;

  // One round trip for every row, not one per row.
  if (typeof env.DB.batch === "function") await env.DB.batch(statements);
  else for (const statement of statements) await statement.run();

  const cache = remembered(env);
  if (!cache) return;
  for (const answer of healthy) {
    const row = cache.rows.find((item) => item.id === answer.id);
    if (!row) continue;
    row.online_at = stamp;
    row.online_version = answer.version || "";
  }
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
  /// The stamps must not depend on somebody asking for the list: a phone that
  /// opens after a quiet hour would otherwise be told nothing is online. A
  /// minute is the same cadence the probes run at anyway.
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    try {
      // A cron has nobody to report to, so the only record that it ran at all
      // is this row — without it a schedule that silently stopped would look
      // exactly like a fleet of engines that went down together.
      const ran = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        "INSERT INTO system_state (key, value, updated_at) VALUES ('gateway/probe_run_at', ?1, ?2) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(String(ran), ran).run();
      const rows = await readRows(env);
      await refreshHealth(env, rows, Date.now());
    } catch (error) {
      // The next minute tries again; this is the only trace a cron leaves.
      console.error(`probe run failed: ${error && error.message}`);
    }
  },

  async fetch(request, env, ctx) {
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
      let rows;
      try {
        rows = await engines(env, ctx);
      } catch {
        return error(503, "The engine registry is unavailable");
      }
      const now = Date.now();
      // Answer from the stamps that are already there, then go and refresh them.
      const answer = rows.map((row) => {
        const online = isOnline(row, now);
        return {
          id: row.id,
          name: row.name,
          url: row.url,
          origin_host: row.origin_host,
          subtitle: row.subtitle,
          tag: row.tag,
          online,
          version: online ? row.online_version || "" : ""
        };
      });
      if (rows.some((row) => origin(row))) after(ctx, refreshHealth(env, rows, now));
      return json(200, { engines: answer });
    }

    let rows;
    try {
      rows = await engines(env, ctx);
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
