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
    origin_host: "m-8a7d1192.aixodia.dpdns.org",
    subtitle: "Cloudflare Named Tunnel",
    tag: "PRIMARY"
  },
  {
    id: "work-1",
    name: "Work",
    url: "https://engine.aixodia.dpdns.org/work-1",
    origin_host: "work.example.net",
    subtitle: "",
    tag: ""
  }
];

const env = {
  DB: registry(rows),
  ACCESS_CLIENT_ID: "id.access",
  ACCESS_CLIENT_SECRET: "secret"
};

/// Collects what was forwarded instead of reaching the network.
function network({ healthz = {}, answer } = {}) {
  const calls = [];
  const fetch = async (target, init = {}) => {
    const url = new URL(target);
    calls.push({ url, init });
    if (url.pathname === "/healthz") {
      const entry = healthz[url.host];
      if (!entry) throw new Error("no route");
      return new Response(JSON.stringify(entry), { status: 200 });
    }
    if (answer) return answer(new URL(target), init);
    return new Response("ok", { status: 200, headers: { "x-engine": url.host } });
  };
  return { calls, fetch };
}

async function run(request, { fetch, db = env.DB } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = fetch || (async (t) => {
    calls.push(String(t));
    return new Response("ok", { status: 200 });
  });
  try {
    const response = await worker.fetch(request, { DB: db, ACCESS_CLIENT_ID: env.ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET: env.ACCESS_CLIENT_SECRET });
    return { response, calls };
  } finally {
    globalThis.fetch = original;
  }
}

const healthy = {
  "m-8a7d1192.aixodia.dpdns.org": { ok: true, version: "v1.177" },
  "work.example.net": { ok: true, version: "v1.170" }
};

test("the registry says which engines are online, and with what version", async () => {
  const net = network({ healthz: { "m-8a7d1192.aixodia.dpdns.org": { ok: true, version: "v1.177" } } });
  const { response } = await run(new Request("https://engine.aixodia.dpdns.org/api/engines"), { fetch: net.fetch });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.engines.map((e) => [e.id, e.online, e.version]),
    [["m-8a7d1192", true, "v1.177"], ["work-1", false, undefined]]
  );
});

test("a probe carries the service token, because the origin admits nothing else", async () => {
  const net = network({ healthz: healthy });
  await run(new Request("https://engine.aixodia.dpdns.org/api/engines"), { fetch: net.fetch });
  for (const call of net.calls) {
    assert.equal(call.init.headers["CF-Access-Client-Id"], "id.access");
    assert.equal(call.init.headers["CF-Access-Client-Secret"], "secret");
  }
});

test("a named path is forwarded to that engine, path untouched", async () => {
  const net = network({ healthz: healthy });
  const { response } = await run(new Request("https://engine.aixodia.dpdns.org/work-1/api/sessions?limit=5"), { fetch: net.fetch });
  assert.equal(response.status, 200);
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].url.host, "work.example.net");
  assert.equal(net.calls[0].url.pathname, "/work-1/api/sessions");
  assert.equal(net.calls[0].url.search, "?limit=5");
});

test("a path with no engine name goes to the first engine, unchanged", async () => {
  const net = network({ healthz: healthy });
  await run(new Request("https://engine.aixodia.dpdns.org/healthz"), { fetch: net.fetch });
  assert.equal(net.calls[0].url.host, "m-8a7d1192.aixodia.dpdns.org");
  assert.equal(net.calls[0].url.pathname, "/healthz");
});

test("a method and its body survive the forward", async () => {
  const net = network({ healthz: healthy });
  await run(
    new Request("https://engine.aixodia.dpdns.org/m-8a7d1192/api/chat", { method: "POST", body: "{}" }),
    { fetch: net.fetch }
  );
  assert.equal(net.calls[0].init.method, "POST");
  assert.ok(net.calls[0].init.body);
});

test("a websocket answer is returned rather than wrapped", async () => {
  // Node cannot build a 101 Response, and the Worker runtime hands one back with
  // `webSocket` on it; that object is what must be returned untouched.
  const upgraded = { status: 101, webSocket: {} };
  const net = network({ healthz: healthy, answer: () => upgraded });
  const { response } = await run(
    new Request("https://engine.aixodia.dpdns.org/m-8a7d1192/ws", { headers: { upgrade: "websocket" } }),
    { fetch: net.fetch }
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
  const net = network({ healthz: healthy });
  const { response } = await run(new Request("https://engine.aixodia.dpdns.org/x/api/sessions"), {
    fetch: net.fetch,
    db: registry([{ ...rows[0], origin_host: "" }])
  });
  assert.equal(response.status, 502);
});

test("fails closed when the registry is not configured", async () => {
  const original = globalThis.fetch;
  const response = await worker.fetch(new Request("https://engine.aixodia.dpdns.org/api/engines"), {});
  globalThis.fetch = original;
  assert.equal(response.status, 503);
});
