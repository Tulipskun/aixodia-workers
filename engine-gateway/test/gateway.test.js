import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

/// The smallest thing that answers like the D1 binding this Worker uses, plus
/// the two statements the health refresh writes.
function registry(source, { fail = false } = {}) {
  const writes = [];
  // A copy per call: the Worker keeps its own row objects in an isolate cache,
  // and a shared array would let one test's probe hand the next test a fresh
  // stamp it never earned.
  const rows = source.map((row) => ({ ...row }));
  return {
    writes,
    prepare(sql) {
      if (/FROM engines ORDER BY/i.test(sql)) {
        return {
          async all() {
            if (fail) throw new Error("D1 unavailable");
            return { results: rows };
          }
        };
      }
      if (/^UPDATE engines SET online_at/i.test(sql)) {
        return {
          bind(...args) {
            writes.push(args);
            return { async run() {} };
          }
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
    }
  };
}

const fresh = Math.floor(Date.now() / 1000);

const rows = [
  {
    id: "m-8a7d1192",
    name: "Primary Engine",
    url: "https://engine.aixodia.dpdns.org/m-8a7d1192",
    origin_host: "m-8a7d1192.aixodia.dpdns.org",
    subtitle: "Cloudflare Named Tunnel",
    tag: "PRIMARY",
    online_at: fresh,
    online_version: "v1.177"
  },
  {
    id: "work-1",
    name: "Work",
    url: "https://engine.aixodia.dpdns.org/work-1",
    origin_host: "work.example.net",
    subtitle: "",
    tag: "",
    online_at: 0,
    online_version: ""
  }
];

const env = {
  ACCESS_CLIENT_ID: "id.access",
  ACCESS_CLIENT_SECRET: "secret"
};

/// Runs the Worker with a fake network and a fake tail, and reports both.
async function run(request, { db = registry(rows), answer } = {}) {
  const calls = [];
  const tail = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    const url = new URL(target);
    calls.push({ url, init });
    if (answer) return answer(url, init);
    return new Response(JSON.stringify({ ok: true, version: "v1.177" }), { status: 200 });
  };
  try {
    const response = await worker.fetch(request, { DB: db, ...env }, { waitUntil: (p) => tail.push(p) });
    return { response, calls, tail, db };
  } finally {
    globalThis.fetch = original;
  }
}

const registryRequest = () => new Request("https://engine.aixodia.dpdns.org/api/engines");

test("the registry answers from the stamps and probes afterwards", async () => {
  const { response, calls } = await run(registryRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  // Fresh row is answered as is; the stale row is answered from what is known.
  assert.deepEqual(
    body.engines.map((e) => [e.id, e.online]),
    [["m-8a7d1192", true], ["work-1", false]]
  );
  // The answer was built from the stamps: the only probe that runs is for the
  // stale row, and it starts after the body is already decided.
  assert.deepEqual(calls.map((call) => call.url.host), ["work.example.net"]);
});

test("the probes run after the response, all at once, and are written back", async () => {
  const db = registry(rows);
  const { tail } = await run(registryRequest(), { db });
  assert.equal(tail.length, 1);
  await tail[0];
  // Only the stale row was probed: the fresh stamp still stands.
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0][2], "work-1");
});

test("a row whose stamp is old enough is probed again even while it is online", async () => {
  const aged = [{ ...rows[0], online_at: Math.floor(Date.now() / 1000) - 30 }];
  const db = registry(aged);
  const { tail } = await run(registryRequest(), { db });
  await tail[0];
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0][0], Math.floor(Date.now() / 1000));
});

test("a probe carries the service token, because the origin admits nothing else", async () => {
  const { calls, tail } = await run(registryRequest());
  await tail[0];
  for (const call of calls) {
    assert.equal(call.init.headers["CF-Access-Client-Id"], "id.access");
    assert.equal(call.init.headers["CF-Access-Client-Secret"], "secret");
  }
});

test("a failed probe is not written, so a busy box is not turned offline", async () => {
  const db = registry(rows);
  const { tail } = await run(registryRequest(), { db, answer: () => new Response("no", { status: 502 }) });
  await tail[0];
  assert.deepEqual(db.writes, []);
});

test("the rows are read once for a burst of requests", async () => {
  const db = registry(rows);
  let reads = 0;
  const counting = {
    prepare(sql) {
      if (/FROM engines ORDER BY/i.test(sql)) reads += 1;
      return db.prepare(sql);
    },
    async batch(statements) {
      return db.batch(statements);
    }
  };
  for (let i = 0; i < 4; i += 1) {
    const { tail } = await run(registryRequest(), { db: counting });
    await Promise.all(tail);
  }
  assert.equal(reads, 1);
});

test("a named path is forwarded to that engine, path untouched", async () => {
  const { response, calls } = await run(
    new Request("https://engine.aixodia.dpdns.org/work-1/api/sessions?limit=5"),
    { answer: () => new Response("ok", { status: 200 }) }
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0].url.host, "work.example.net");
  assert.equal(calls[0].url.pathname, "/work-1/api/sessions");
  assert.equal(calls[0].url.search, "?limit=5");
});

test("a path with no engine name goes to the first engine, unchanged", async () => {
  const { calls } = await run(new Request("https://engine.aixodia.dpdns.org/healthz"), {
    answer: () => new Response("ok", { status: 200 })
  });
  assert.equal(calls[0].url.host, "m-8a7d1192.aixodia.dpdns.org");
  assert.equal(calls[0].url.pathname, "/healthz");
});

test("a method and its body survive the forward", async () => {
  const { calls } = await run(
    new Request("https://engine.aixodia.dpdns.org/m-8a7d1192/api/chat", { method: "POST", body: "{}" }),
    { answer: () => new Response("ok", { status: 200 }) }
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

test("the registry is read-only", async () => {
  const { response } = await run(
    new Request("https://engine.aixodia.dpdns.org/api/engines", { method: "POST", body: "{}" })
  );
  assert.equal(response.status, 405);
});

test("an engine without an origin cannot be forwarded to", async () => {
  const db = registry([{ ...rows[0], origin_host: "" }]);
  const { response } = await run(new Request("https://engine.aixodia.dpdns.org/x/api/sessions"), { db });
  assert.equal(response.status, 502);
});

test("fails closed when the registry is not configured", async () => {
  const response = await worker.fetch(registryRequest(), {});
  assert.equal(response.status, 503);
});

test("an unreachable registry is reported, not guessed", async () => {
  const { response } = await run(registryRequest(), { db: registry(rows, { fail: true }) });
  assert.equal(response.status, 503);
});
