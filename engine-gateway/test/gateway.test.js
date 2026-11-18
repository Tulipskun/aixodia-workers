import test from "node:test";
import assert from "node:assert/strict";
import worker, { INSTANCE_NAME, ORIGIN_HOST } from "../src/index.js";

/// The smallest thing that answers like the D1 binding this Worker uses:
/// one table, two prepared statements.
function registry(rows, { fail = false } = {}) {
  return {
    prepare(sql) {
      const params = [];
      const statement = {
        bind(...values) {
          params.push(...values);
          return statement;
        },
        async first() {
          if (fail) throw new Error("D1 unavailable");
          const match = sql.match(/FROM engines WHERE id/i);
          if (!match) throw new Error(`unexpected query: ${sql}`);
          return rows.find((row) => row.id === params[0]) || null;
        },
        async all() {
          if (fail) throw new Error("D1 unavailable");
          if (!/FROM engines ORDER BY/i.test(sql)) throw new Error(`unexpected query: ${sql}`);
          return { results: rows.map(({ origin_host, ...rest }) => rest) };
        }
      };
      return statement;
    }
  };
}

const credentials = { ACCESS_CLIENT_ID: "test-id", ACCESS_CLIENT_SECRET: "test-secret" };
const machine = {
  id: "phone-2",
  name: "Phone",
  url: "https://engines.aixodia.dpdns.org/phone-2",
  origin_host: "phone-2.aixodia.dpdns.org",
  subtitle: "Named Tunnel",
  tag: "PRIMARY"
};

test("validates instance names", () => {
  for (const value of ["main", "phone-2", "a", "x9"]) assert.equal(INSTANCE_NAME.test(value), true);
  for (const value of ["", "-main", "main-", "main--two", "../etc", "a/b", "Main", "a".repeat(33)]) {
    assert.equal(INSTANCE_NAME.test(value), false);
  }
});

test("restricts origin hostname suffix", () => {
  assert.equal(ORIGIN_HOST.test("phone-2.aixodia.dpdns.org"), true);
  assert.equal(ORIGIN_HOST.test("attacker.example"), false);
  assert.equal(ORIGIN_HOST.test("phone-2.example.org"), false);
});

test("fails closed without origin authentication", async () => {
  const response = await worker.fetch(new Request("https://engines.aixodia.dpdns.org/phone-2/healthz"), {
    DB: registry([machine])
  });
  assert.equal(response.status, 503);
});

test("fails closed when the registry binding is missing", async () => {
  const response = await worker.fetch(new Request("https://engines.aixodia.dpdns.org/phone-2/healthz"), {});
  assert.equal(response.status, 503);
});

test("answers the registry, without the tunnel hostnames", async () => {
  const response = await worker.fetch(new Request("https://engines.aixodia.dpdns.org/engines"), {
    DB: registry([machine])
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    engines: [{ id: "phone-2", name: "Phone", url: machine.url, subtitle: "Named Tunnel", tag: "PRIMARY" }]
  });
});

test("answers the registry under the engine's api prefix too", async () => {
  const response = await worker.fetch(new Request("https://engine.aixodia.dpdns.org/api/engines"), {
    DB: registry([machine])
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).engines.length, 1);
});

test("the registry is read-only", async () => {
  const response = await worker.fetch(
    new Request("https://engines.aixodia.dpdns.org/engines", { method: "POST" }),
    { DB: registry([machine]) }
  );
  assert.equal(response.status, 405);
});

test("strips the instance segment and forwards method, query, body and token", async () => {
  let seen;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => {
    seen = request;
    return new Response("ok", { status: 200 });
  };
  try {
    const request = new Request("https://engines.aixodia.dpdns.org/phone-2/api/chat?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json", connection: "keep-alive", host: "engines.aixodia.dpdns.org" },
      body: JSON.stringify({ messages: [] })
    });
    const response = await worker.fetch(request, { DB: registry([machine]), ...credentials });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(seen.url, "https://phone-2.aixodia.dpdns.org/api/chat?stream=1");
    assert.equal(seen.headers.get("cf-access-client-id"), "test-id");
    assert.equal(seen.headers.get("cf-access-client-secret"), "test-secret");
    assert.equal(seen.headers.get("x-aixodia-instance"), "phone-2");
    assert.equal(seen.headers.get("connection"), null);
    assert.deepEqual(await seen.json(), { messages: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a bare instance address becomes the root path", async () => {
  let seen;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => {
    seen = request;
    return new Response("ok", { status: 200 });
  };
  try {
    await worker.fetch(new Request("https://engines.aixodia.dpdns.org/phone-2"), {
      DB: registry([machine]),
      ...credentials
    });
    assert.equal(seen.url, "https://phone-2.aixodia.dpdns.org/");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns 404 for engines that are not registered", async () => {
  const response = await worker.fetch(new Request("https://engines.aixodia.dpdns.org/nope/healthz"), {
    DB: registry([machine]),
    ...credentials
  });
  assert.equal(response.status, 404);
});

test("never forwards an origin that is not this zone", async () => {
  const response = await worker.fetch(new Request("https://engines.aixodia.dpdns.org/phone-2/healthz"), {
    DB: registry([{ ...machine, origin_host: "evil.example.com" }]),
    ...credentials
  });
  assert.equal(response.status, 404);
});

test("reports an unreachable tunnel as 502", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  try {
    const response = await worker.fetch(new Request("https://engines.aixodia.dpdns.org/phone-2/healthz"), {
      DB: registry([machine]),
      ...credentials
    });
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
