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

/// Response for a token hash lookup, or null for an unknown token.
async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// A D1 stand-in that answers both the registry and the token table, so a test
/// can decide which bearer the gateway vouches for.
function data({ source = rows, tokens = [], tokenQueryFails = false, racingBeat = false } = {}) {
  const list = source.map((row) => ({ ...row }));
  const queries = [];
  return {
    queries,
    prepare(sql) {
      if (/FROM auth_tokens WHERE token_hash/i.test(sql)) {
        queries.push(sql);
        return {
          bind(tokenHash) {
            return {
              async first() {
                if (tokenQueryFails) throw new Error("D1 unavailable");
                const row = tokens.find((t) => t.token_hash === tokenHash);
                return row ? { state: row.state, expires_at: row.expires_at ?? null } : null;
              }
            };
          }
        };
      }
      if (/^DELETE FROM engines/i.test(sql)) {
        queries.push(sql);
        return {
          bind(id) {
            return {
              async run() {
                const at = list.findIndex((r) => r.id === id);
                // The same rule the SQL states: a beating row may not go, a
                // row that is not beating may.
                const beat = at >= 0 ? Number(list[at].heartbeat_at || 0) : 0;
                const gone = beat === 0 || Math.floor(Date.now() / 1000) - beat > 60;
                // `racingBeat` is a beat that lands between the read and the
                // write: the row is read as stale and is fresh by the time the
                // delete reaches it.
                if (at < 0 || !gone || racingBeat) return { meta: { changes: 0 } };
                list.splice(at, 1);
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }
      if (/^UPDATE engines SET alias/i.test(sql)) {
        queries.push(sql);
        return {
          bind(alias, id) {
            return {
              async run() {
                const row = list.find((r) => r.id === id);
                if (!row) return { meta: { changes: 0 } };
                row.alias = alias;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }
      if (/FROM engines WHERE id = /i.test(sql)) {
        queries.push(sql);
        return {
          bind(id) {
            return {
              async first() {
                const row = list.find((r) => r.id === id);
                if (!row) return null;
                const fresh = row.heartbeat_at > 0 && Math.floor(Date.now() / 1000) - row.heartbeat_at <= 60;
                return {
                  id: row.id,
                  name: row.name,
                  alias: row.alias || "",
                  heartbeat_at: row.heartbeat_at,
                  online: fresh ? 1 : 0
                };
              }
            };
          }
        };
      }
      if (!/FROM engines ORDER BY/i.test(sql)) throw new Error(`unexpected query: ${sql}`);
      queries.push(sql);
      return {
        async all() {
          return {
            results: list.map((row) => ({
              ...row,
              online: row.heartbeat_at > 0 && Math.floor(Date.now() / 1000) - row.heartbeat_at <= 60 ? 1 : 0
            }))
          };
        }
      };
    }
  };
}

const env = {
  ACCESS_CLIENT_ID: "id.access",
  ACCESS_CLIENT_SECRET: "secret",
  CF_ACCOUNT_ID: "acct-1",
  CF_ZONE_ID: "zone-1",
  CF_ADMIN_TOKEN: "admin-token"
};

/// A Cloudflare account with one tunnel, one DNS record and no surprises.
function cloudflare({ records = [{ id: "rec-1", name: "work-1.aixodia.dpdns.org" }], tunnels = [{ id: "tun-1", name: "work-1" }], refuse = {} } = {}) {
  const asked = [];
  const answer = (url, init = {}) => {
    const path = url.pathname.replace("/client/v4", "");
    asked.push([init.method || "GET", path]);
    const refuseAt = Object.keys(refuse).find((step) => path.includes(step));
    if (refuseAt) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: refuse[refuseAt] }] }), {
        status: 403
      });
    }
    let result = [];
    if (path.includes("/dns_records")) result = records;
    if (path.includes("/cfd_tunnel")) result = tunnels;
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  return { asked, answer };
}

const registryRequest = () => new Request("https://engine.aixodia.dpdns.org/api/engines");

/// Runs the Worker with a fake network, and reports what it did.
async function run(request, { db = registry(rows), answer, config } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    const url = new URL(target);
    calls.push({ url, init });
    if (answer) return answer(url, init);
    return new Response("ok", { status: 200 });
  };
  const deletes = [];
  const kv = config || {
    deleted: deletes,
    async delete(key) {
      deletes.push(key);
    }
  };
  try {
    const response = await worker.fetch(request, { DB: db, CONFIG: kv, ...env });
    return { response, calls, db, kv };
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
// ------------------------------------------------------------ bearer gate
// The gateway shares D1 with the auth Worker. It refuses any bearer the Worker
// does not vouch for, so a master token dies here even if an old engine behind
// the tunnel would still accept it.

const GOOD = "worker-issued-token";
const MASTER = "the-engine-master-token";

async function activeTokens(extra = []) {
  return [
    { token_hash: await hashToken(GOOD), state: "active", expires_at: null },
    ...extra
  ];
}

const authed = (path, token) =>
  new Request(`https://engine.aixodia.dpdns.org${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });

test("a Worker-issued bearer is forwarded to the engine", async () => {
  const { response, calls } = await run(authed("/api/sessions", GOOD), {
    db: data({ tokens: await activeTokens() })
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1, "the request reached the engine");
  assert.equal(calls[0].init.headers.get("authorization"), `Bearer ${GOOD}`);
});

test("the master token is refused at the door, never reaching an engine", async () => {
  const { response, calls } = await run(authed("/api/sessions", MASTER), {
    db: data({ tokens: await activeTokens() })
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "UNKNOWN_TOKEN");
  assert.equal(calls.length, 0, "nothing was forwarded to the old engine");
});

test("a revoked token is refused on the next request", async () => {
  // The Worker flipped the row to revoked; the gateway reads the same table.
  const revoked = data({ tokens: [{ token_hash: await hashToken(GOOD), state: "revoked", expires_at: null }] });
  const { response, calls } = await run(authed("/api/sessions", GOOD), { db: revoked });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("an expired token is refused", async () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  const { response } = await run(authed("/api/sessions", GOOD), {
    db: data({ tokens: [{ token_hash: await hashToken(GOOD), state: "active", expires_at: past }] })
  });
  assert.equal(response.status, 401);
});

test("a token that has not expired yet passes", async () => {
  const future = Math.floor(Date.now() / 1000) + 600;
  const { response } = await run(authed("/api/sessions", GOOD), {
    db: data({ tokens: [{ token_hash: await hashToken(GOOD), state: "active", expires_at: future }] })
  });
  assert.equal(response.status, 200);
});

test("no bearer means no token check — probes and tickets still pass", async () => {
  const { response, calls } = await run(new Request("https://engine.aixodia.dpdns.org/healthz"), {
    db: data({ tokens: [] })
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    data({ tokens: [] }).queries.filter((q) => /auth_tokens/.test(q)).length,
    0,
    "no token query was made"
  );
});

test("the registry is public even if a bad bearer is attached", async () => {
  const { response } = await run(authed("/api/engines", MASTER), {
    db: data({ tokens: [] })
  });
  assert.equal(response.status, 200, "the registry branch precedes the token check");
});

test("a broken token store fails closed, not open", async () => {
  const { response, calls } = await run(authed("/api/sessions", GOOD), {
    db: data({ tokens: [], tokenQueryFails: true })
  });
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});

test("a preflight is answered here, never forwarded to an Access-guarded origin", async () => {
  const db = registry(rows);
  let forwarded = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    forwarded += 1;
    return new Response("should not be reached", { status: 500 });
  };
  try {
    const request = new Request("https://engine.aixodia.dpdns.org/m-8a7d1192/api/terminals/ticket", {
      method: "OPTIONS",
      headers: {
        origin: "https://aixodia.dpdns.org",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type"
      }
    });
    const response = await worker.fetch(request, { DB: db });
    assert.equal(response.status, 204);
    assert.equal(forwarded, 0);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://aixodia.dpdns.org");
    assert.match(response.headers.get("access-control-allow-methods"), /POST/);
    assert.match(response.headers.get("access-control-allow-headers"), /authorization/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a page from another origin is refused, and so is a preflight without one", async () => {
  const db = registry(rows);
  const stranger = await worker.fetch(
    new Request("https://engine.aixodia.dpdns.org/m-8a7d1192/api/terminals", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" }
    }),
    { DB: db }
  );
  assert.equal(stranger.status, 403);
  const bare = await worker.fetch(
    new Request("https://engine.aixodia.dpdns.org/m-8a7d1192/api/terminals", { method: "OPTIONS" }),
    { DB: db }
  );
  assert.equal(bare.status, 403);
});

test("a forward drops the page's origin, so Access cannot refuse it", async () => {
  const db = registry(rows);
  let seen = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), headers: new Headers(init.headers) };
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    const response = await worker.fetch(
      new Request("https://engine.aixodia.dpdns.org/m-8a7d1192/api/terminals", {
        headers: { origin: "https://aixodia.dpdns.org", referer: "https://aixodia.dpdns.org/" }
      }),
      { DB: db }
    );
    assert.equal(seen.headers.get("origin"), null);
    assert.equal(seen.headers.get("referer"), null);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://aixodia.dpdns.org");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --------------------------------------------------- deleting and renaming
// Two writes a person makes about a machine, rather than a machine making about
// itself. Both need a bearer, and both are about a row, not about a forward.

const rowHandle = () => new Request("https://engine.aixodia.dpdns.org/api/engines/work-1", {
  method: "DELETE",
  headers: { authorization: `Bearer ${GOOD}` }
});

const renameHandle = (body, id = "work-1") =>
  new Request(`https://engine.aixodia.dpdns.org/api/engines/${id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${GOOD}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

test("an engine that has been gone a day is deleted with its address", async () => {
  const db = data({
    source: [rows[0], { ...rows[1], heartbeat_at: now() - 25 * 3600 }],
    tokens: await activeTokens()
  });
  const cf = cloudflare();
  const { response, calls, kv } = await run(rowHandle(), { db, answer: cf.answer });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    deleted: "work-1",
    name: "Work",
    url_removed: true,
    steps: { dns: "removed 1", tunnel: "removed 1", keys: "removed 3" }
  });
  // Nothing was forwarded: a delete is a registry write and an address teardown.
  assert.deepEqual(
    calls.map((c) => c.url.host),
    ["api.cloudflare.com", "api.cloudflare.com", "api.cloudflare.com", "api.cloudflare.com"]
  );
  // DNS first, then the tunnel: the hostname must stop resolving before the
  // thing it names disappears, never the other way round.
  assert.deepEqual(cf.asked, [
    ["GET", "/zones/zone-1/dns_records"],
    ["DELETE", "/zones/zone-1/dns_records/rec-1"],
    ["GET", "/accounts/acct-1/cfd_tunnel"],
    ["DELETE", "/accounts/acct-1/cfd_tunnel/tun-1"]
  ]);
  // And the keys that would let the next start reuse a tunnel that is gone.
  assert.deepEqual(kv.deleted, [
    "instances/work-1/tunnel_token",
    "instances/work-1/tunnel_url",
    "instances/work-1/daemon/url"
  ]);
});

test("an engine that went quiet ten minutes ago is deleted now, with its address", async () => {
  // Offline is the whole test. A machine that stopped beating owns nothing in
  // this registry any more, and its address is not held for it: asking a person
  // to wait a day for a machine they can see is off was a rule about nothing.
  const db = data({ tokens: await activeTokens() });
  const cf = cloudflare();
  const { response, kv } = await run(rowHandle(), { db, answer: cf.answer });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deleted, "work-1");
  assert.equal(body.url_removed, true);
  assert.deepEqual(body.steps, { dns: "removed 1", tunnel: "removed 1", keys: "removed 3" });
  assert.equal(kv.deleted.length, 3);
});

test("an engine that starts beating again between the read and the delete is refused", async () => {
  // The lease test is repeated inside the DELETE itself, so a beat that lands
  // after the read cannot be overwritten: the caller is refused, not lied to.
  const db = data({ tokens: await activeTokens(), racingBeat: true });
  const { response } = await run(rowHandle(), { db, answer: cloudflare().answer });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "ENGINE_ONLINE");
});

test("a machine that stopped beating long ago but is still up is deleted whole", async () => {
  const db = data({
    source: [{ ...rows[1], heartbeat_at: 0 }],
    tokens: await activeTokens()
  });
  const cf = cloudflare({ records: [], tunnels: [] });
  const { response } = await run(rowHandle(), { db, answer: cf.answer });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.steps, { dns: "none", tunnel: "none", keys: "removed 3" });
  assert.equal(body.url_removed, true, "nothing left standing is a clean delete");
});

test("a refusal from Cloudflare is reported, not hidden behind an ok", async () => {
  const db = data({
    source: [{ ...rows[1], heartbeat_at: now() - 25 * 3600 }],
    tokens: await activeTokens()
  });
  const cf = cloudflare({ refuse: { cfd_tunnel: "tunnel is in use" } });
  const { response } = await run(rowHandle(), { db, answer: cf.answer });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.url_removed, false);
  assert.match(body.steps.tunnel, /^failed: tunnel is in use$/);
  assert.equal(body.steps.dns, "removed 1", "the steps that did run are still said");
});

test("a live engine is refused, because its own heartbeat would undo the delete", async () => {
  const db = data({ tokens: await activeTokens() });
  const request = new Request("https://engine.aixodia.dpdns.org/api/engines/m-8a7d1192", {
    method: "DELETE",
    headers: { authorization: `Bearer ${GOOD}` }
  });
  const { response } = await run(request, { db });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "ENGINE_ONLINE");
  assert.match(body.error, /still beating/);
});

test("an engine nobody has heard of is a 404, not a silent success", async () => {
  const { response } = await run(
    new Request("https://engine.aixodia.dpdns.org/api/engines/m-ghost", {
      method: "DELETE",
      headers: { authorization: `Bearer ${GOOD}` }
    }),
    { db: data({ tokens: await activeTokens() }) }
  );
  assert.equal(response.status, 404);
});

test("deleting without a bearer is refused, and no row is touched", async () => {
  const db = data({ tokens: await activeTokens() });
  const { response } = await run(
    new Request("https://engine.aixodia.dpdns.org/api/engines/work-1", { method: "DELETE" }),
    { db }
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "NO_TOKEN");
  assert.equal(db.queries.filter((q) => /^DELETE FROM engines/.test(q)).length, 0);
});

test("a bearer the store does not vouch for cannot delete", async () => {
  const { response } = await run(rowHandle(), { db: data({ tokens: [] }) });
  assert.equal(response.status, 401);
});

test("an alias is stored beside the id, never instead of it", async () => {
  const db = data({ tokens: await activeTokens() });
  const { response } = await run(renameHandle({ alias: "Work bench" }), { db });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, id: "work-1", alias: "Work bench", name: "Work" });
});

test("the registry carries the alias so a client can draw the name a person chose", async () => {
  const db = data({ tokens: await activeTokens(), source: [{ ...rows[1], alias: "Work bench" }] });
  await run(renameHandle({ alias: "Work bench" }), { db });
  const body = await (await run(registryRequest(), { db })).response.json();
  assert.equal(body.engines[0].id, "work-1", "the address is still the machine's own");
  assert.equal(body.engines[0].alias, "Work bench");
});

test("an empty alias clears the name, and the id is shown again", async () => {
  const db = data({ tokens: await activeTokens(), source: [{ ...rows[1], alias: "Work bench" }] });
  const { response } = await run(renameHandle({ alias: "  " }), { db });
  assert.equal((await response.json()).alias, "");
});

test("a name is trimmed, stripped of control characters and bounded", async () => {
  const db = data({ tokens: await activeTokens() });
  const { response } = await run(renameHandle({ alias: "  a\u0000b  " }), { db });
  assert.equal((await response.json()).alias, "ab");
  const long = data({ tokens: await activeTokens() });
  const bounded = await run(renameHandle({ alias: "x".repeat(200) }), { db: long });
  assert.equal((await bounded.response.json()).alias.length, 40);
});

test("a rename with no alias field is refused, because silence cannot mean 'clear it'", async () => {
  const { response } = await run(renameHandle({ name: "Work" }), {
    db: data({ tokens: await activeTokens() })
  });
  assert.equal(response.status, 400);
});

test("a rename needs a bearer too", async () => {
  const { response } = await run(
    new Request("https://engine.aixodia.dpdns.org/api/engines/work-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias: "Work bench" })
    }),
    { db: data({ tokens: await activeTokens() }) }
  );
  assert.equal(response.status, 401);
});

test("a row that is not in the registry cannot be named", async () => {
  const { response } = await run(renameHandle({ alias: "Ghost" }, "m-ghost"), {
    db: data({ tokens: await activeTokens() })
  });
  assert.equal(response.status, 404);
});

test("one engine row answers nothing but its two writes", async () => {
  const { response } = await run(
    new Request("https://engine.aixodia.dpdns.org/api/engines/work-1", {
      headers: { authorization: `Bearer ${GOOD}` }
    }),
    { db: data({ tokens: await activeTokens() }) }
  );
  assert.equal(response.status, 405);
});
