//! The engine registry, as one endpoint: `GET /api/engines`.
//!
//! Each engine is reachable at `https://<its tunnel host>/<name>/…` — the shape
//! droidime uses for devices — and the engine itself claims that name in the
//! `engines` table and serves the path. So this Worker no longer forwards
//! anything: one engine's address is its own tunnel, and a second one has its
//! own. What is left for a Worker is the answer no single engine can give, the
//! list of engines that exist.
//!
//! The list is read straight from D1, the same table the console used to be told
//! about through a Workers KV key nobody ever wrote.

function error(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export default {
  async fetch(request, env) {
    if (!env.DB) return error(503, "The engine registry is not configured");

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const isRegistry =
      (segments.length === 1 && segments[0] === "engines") ||
      (segments.length === 2 && segments[0] === "api" && segments[1] === "engines");
    if (!isRegistry) return error(404, "Not found");
    if (request.method !== "GET" && request.method !== "HEAD") {
      return error(405, "The registry is read-only");
    }

    const { results } = await env.DB.prepare(
      "SELECT id, name, url, subtitle, tag FROM engines ORDER BY created_at, id"
    ).all();
    return new Response(JSON.stringify({ engines: results || [] }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  }
};
