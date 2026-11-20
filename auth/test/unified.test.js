import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

// The browser and the device app must share one token table. This test drives
// the Worker's fetch handler with a stubbed Access identity, so it covers the
// route table, the schema migration and the verify path together.

import { hooks } from '../src/shared.js'
hooks.accessIdentity = async () => ({ email: 'operator@example.com' })
const worker = await import('../src/index.js')

class D1Mini {
  constructor(db) { this.db = db }
  prepare(sql) {
    const db = this.db
    const params = []
    return {
      bind(...values) { params.push(...values); return this },
      async first() { return db.prepare(sql).get(...params) ?? null },
      get(...params) { return db.prepare(sql).get(...params) ?? null },
      async run() { return { meta: { changes: db.prepare(sql).run(...params).changes } } },
      async all() { return { results: db.prepare(sql).all(...params) } },
    }
  }
}

function env() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE engines (id TEXT PRIMARY KEY, name TEXT, url TEXT, created_at INTEGER)`)
  return {
    DB: new D1Mini(db),
    CONFIG: { get: async () => '' },
    AUTH_ALLOWED_EMAILS: '',
    ENGINE_URL: '',
    PUBLIC_URL: 'https://aixodia.dpdns.org',
  }
}

// The schema is cached per isolate in the Worker, so one environment serves
// both tests — just as one isolate serves many requests in production.
const e = env()

function call(path, { method = 'GET', token = '' } = {}) {
  return worker.default.fetch(
    new Request(`https://worker${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    e,
  )
}

test('browser token lands in the same table the device flow syncs', async () => {
  const res = await call('/auth/token', { method: 'POST' })
  assert.equal(res.status, 200)
  const { token } = await res.json()
  assert.ok(token)

  // The one token table is what the engine pulls for its live set.
  const row = e.DB.prepare('SELECT device_name, state FROM auth_tokens').get()
  assert.equal(row.device_name, 'browser')
  assert.equal(row.state, 'active')

  // No second session table holds a copy.
  const tables = (await e.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gate_sessions'`,
  ).all()).results
  assert.equal(tables.length, 0)
})

test('a browser token verifies through the same endpoint a device token uses', async () => {
  const issued = await (await call('/auth/token', { method: 'POST' })).json()

  const good = await call('/auth/verify', { method: 'POST', token: issued.token })
  assert.equal(good.status, 200)
  assert.equal((await good.json()).valid, true)

  const bad = await call('/auth/verify', { method: 'POST', token: 'not-the-token' })
  assert.equal(bad.status, 401)
  assert.equal((await bad.json()).code, 'unknown_token')
})

// Signing in from the console means passing through Cloudflare Access at
// /auth/start. The browser comes back to this path with a session, so the answer
// has to send it into the console rather than leave it on a blank page.
test('the sign-in hop redirects into the console', async () => {
  const res = await call('/auth/start')
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://aixodia.dpdns.org/')
})

// The Location has to name the console, because a relative one is resolved against
// the Worker's own origin and would land the browser on workers.dev.
test('the sign-in hop only redirects within the console', async () => {
  const inside = await call('/auth/start?next=/engines')
  assert.equal(inside.headers.get('location'), 'https://aixodia.dpdns.org/engines')
  const outside = await call('/auth/start?next=https://evil.example/steal')
  assert.equal(outside.headers.get('location'), 'https://aixodia.dpdns.org/')
  const protocolRelative = await call('/auth/start?next=//evil.example/steal')
  assert.equal(protocolRelative.headers.get('location'), 'https://aixodia.dpdns.org/')
})
