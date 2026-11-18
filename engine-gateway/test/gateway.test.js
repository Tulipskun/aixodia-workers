import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

/// The smallest thing that answers like the D1 binding this Worker uses.
function registry(source, { fail = false } = {}) {
  const rows = source.map((row) => ({ ...row }));
  const queries = [];
  return {
    queries,
    prepare(sql) {
      if (!/FROM engines ORDER BY/i.test(sql)) throw new Error(`unexpected query: ${sql}`);
      queries.push(sql);
      return {
        async all() {
          if (fail) throw new Error("D1 unavailable");
          // The lease is evaluated by SQLite in production; here it is applied
          // by hand so a test can make a row as stale or as fresh as it likes.
          return {
            results: rows.map((row) => ({
              ...row,
              online: row.heartbeat_at > 0 && Math.floor(Date.now() / 1000) - row.heartbeat_at <= 60 ? 1 : 0
            }))
          };
        }
      };
    }
  };
}

const now = () => Math.floor(Date.now() / 1000);

const rows = [
  {
    id: "m-8a7d1192",
    name: "Primary Engine",
    url: "https://engine.aixodia.dpdns.org/m-8a7d1192",
    origin_host: "m-8a7d1192.aixodia.dpdns.org",
    subtitle: "Cloudflare Named Tunnel",
    tag: "PRIMARY",
    version: "v1.177",
    heartbeat_at: now()
  },
  {
    id: "work-1",
    name: "Work",
    url: "https://engine.aixodia.dpdns.org/work-1",
    origin_host: "work.example.net",
    subtitle: "",
    tag: "",
    version: "v1.170",
    heartbeat_at: now() - 600
  }
];

const env = {
  ACCESS_CLIENT_ID: "id.access",
  ACCESS_CLIENT_SECRET: "secret"
};

const registryRequest = () => new Request("https://engine.aixodia.dpdns.org/api/engines");

/// Runs the Worker with a fake network, and reports what it did.
async function run(request, { db = registry(rows), answer } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    const url = new URL(target);
    calls.push({ url, init });
    if (answer) return answer(url, init);
    return new Response("ok", { status: 200 });
  };
  try {
    const response = await worker.fetch(request, { DB: db, ...env });
    return { response, calls, db };
  } finally {
    globalThis.fetch = original;
  }
}

test("the registry is the lease, with no probe on the way to the answer", async () => {
  const { response, calls } = await run(registryRequest());
  assert.equal(response.status, 200);
  assert.equal(calls.length, 0, "nothing was asked of any engine");
  const body = await response.json();
  assert.deepEqual(
    body.engines.map((e) => [e.id, e.online, e.version]),
    [
      ["m-8a7d1192", true, "v1.177"],
      // An engine that stopped beating is offline, and its version is not
      // claimed for an answer it did not give.
      ["work-1", false, ""]
    ]
  );
});

test("a lease one minute old still counts, older does not", async () => {
  const db = registry([
    { ...rows[0], heartbeat_at: now() - 55 },
    { ...rows[1], heartbeat_at: now() - 61 }
  ]);
  const body = await (await run(registryRequest(), { db })).response.json();
  assert.deepEqual(body.engines.map((e) => e.online), [true, false]);
});

test("a row that never beat is offline, not online by default", async () => {
  const db = registry([{ ...rows[0], heartbeat_at: 0 }]);
  const body = await (await run(registryRequest(), { db })).response.json();
  assert.equal(body.engines[0].online, false);
});

test("the registry is read-only", async () => {
  const { response } = await run(
    new Request("https://engine.aixodia.dpdns.org/api/engines", { method: "POST", body: "{}" })
  );
  assert.equal(response.status, 405);
});

test("fails closed when the registry is not configured", async () => {
  const response = await worker.fetch(registryRequest(), {});
  assert.equal(response.status, 503);
});

test("an unreachable registry is reported, not guessed", async () => {
  const { response } = await run(registryRequest(), { db: registry(rows, { fail: true }) });
  assert.equal(response.status, 503);
});

test("a named path is forwarded to that engine, path untouched", async () => {
  const { response, calls } = await run(
    new Request("https://engine.aixodia.dpdns.org/work-1/api/sessions?limit=5")
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0].url.host, "work.example.net");
  assert.equal(calls[0].url.pathname, "/work-1/api/sessions");
  assert.equal(calls[0].url.search, "?limit=5");
});

test("a path with no engine name goes to the first engine, unchanged", async () => {
  const { calls } = await run(new Request("https://engine.aixodia.dpdns.org/healthz"));
  assert.equal(calls[0].url.host, "m-8a7d1192.aixodia.dpdns.org");
  assert.equal(calls[0].url.pathname, "/healthz");
});

test("a forward carries the service token, because the origin admits nothing else", async () => {
  const { calls } = await run(new Request("https://engine.aixodia.dpdns.org/work-1/healthz"));
  assert.equal(calls[0].init.headers.get("CF-Access-Client-Id"), "id.access");
  assert.equal(calls[0].init.headers.get("CF-Access-Client-Secret"), "secret");
});

test("a method and its body survive the forward", async () => {
  const { calls } = await run(
    new Request("https://engine.aixodia.dpdns.org/m-8a7d1192/api/chat", { method: "POST", body: "{}" })
  );
  assert.equal(calls[0].init.method, "POST");
  assert.ok(calls[0].init.body);
});

test("a websocket answer is returned rather than wrapped", async () => {
  // Node cannot build a 101 Response, and the Worker runtime hands one back with
  // `webSocket` on it; that object is what must be returned untouched.
  const upgraded = { status: 101, webSocket: {} };
  const { response } = await run(
    new Request("https://engine.aixodia.dpdns.org/m-8a7d1192/ws", { headers: { upgrade: "websocket" } }),
    { answer: () => upgraded }
  );
  assert.equal(response.status, 101);
});

test("the rows are read once for a burst of forwarded requests", async () => {
  const db = registry(rows);
  for (let i = 0; i < 4; i += 1) {
    await run(new Request("https://engine.aixodia.dpdns.org/work-1/healthz"), { db });
  }
  assert.equal(db.queries.length, 1);
});

test("the registry itself is never served from the forward cache", async () => {
  const db = registry(rows);
  await run(registryRequest(), { db });
  await run(registryRequest(), { db });
  assert.equal(db.queries.length, 2, "each registry answer reads the lease again");
});

test("an engine without an origin cannot be forwarded to", async () => {
  const db = registry([{ ...rows[0], origin_host: "" }]);
  const { response } = await run(new Request("https://engine.aixodia.dpdns.org/x/api/sessions"), { db });
  assert.equal(response.status, 502);
});

test("nothing is registered means nothing is forwarded", async () => {
  const { response } = await run(new Request("https://engine.aixodia.dpdns.org/healthz"), {
    db: registry([])
  });
  assert.equal(response.status, 503);
});