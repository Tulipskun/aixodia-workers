import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

/// The smallest thing that answers like the D1 binding this Worker uses.
function registry(rows, { fail = false } = {}) {
  return {
    prepare(sql) {
      if (!/FROM engines ORDER BY/i.test(sql)) throw new Error(`unexpected query: ${sql}`);
      return {
        async all() {
          if (fail) throw new Error("D1 unavailable");
          return { results: rows };
        }
      };
    }
  };
}

const rows = [
  {
    id: "m-8a7d1192",
    name: "Primary Engine",
    url: "https://engine.aixodia.dpdns.org/m-8a7d1192",
    subtitle: "Cloudflare Named Tunnel",
    tag: "PRIMARY"
  },
  { id: "work-1", name: "Work", url: "https://work.aixodia.dpdns.org/work-1", subtitle: "", tag: "" }
];

function get(path, env = { DB: registry(rows) }) {
  return worker.fetch(new Request(`https://engine.aixodia.dpdns.org${path}`), env);
}

test("answers the registry under /api/engines", async () => {
  const response = await get("/api/engines");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).engines, rows);
});

test("answers the registry under /engines too", async () => {
  const response = await get("/engines");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).engines.length, 2);
});

test("answers HEAD with the same headers and no body problem", async () => {
  const response = await worker.fetch(
    new Request("https://engine.aixodia.dpdns.org/api/engines", { method: "HEAD" }),
    { DB: registry(rows) }
  );
  assert.equal(response.status, 200);
});

test("is read-only", async () => {
  const response = await worker.fetch(
    new Request("https://engine.aixodia.dpdns.org/api/engines", { method: "POST", body: "{}" }),
    { DB: registry(rows) }
  );
  assert.equal(response.status, 405);
});

test("serves nothing else: an engine path belongs to the engine", async () => {
  for (const path of ["/work-1/api/sessions", "/m-8a7d1192/healthz", "/", "/api/engines/x"]) {
    assert.equal((await get(path)).status, 404);
  }
});

test("fails closed when the registry is not configured", async () => {
  assert.equal((await get("/api/engines", {})).status, 503);
});
