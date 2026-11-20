/**
 * AIxodia sign-in authority.
 *
 * Kept out of the engine on purpose. The engine is an agent that also exposes
 * device-control routes; making it the authority on who may use the console meant
 * its uptime was a login requirement, so upgrading it logged everyone out and a
 * crash locked the door.
 *
 * This Worker owns the allowlist and the session state in D1. It answers the
 * console whether or not the engine is running: a sign-in still succeeds when the
 * engine is down, and the console reports the engine as unreachable instead of
 * showing a login that appears broken.
 *
 * Storage choices, since they drive everything else here:
 *
 *   CONFIG (KV)    — the allowlist and Access values. Read constantly, written by
 *                    a human, so KV's eventual consistency costs nothing.
 *   DB (D1)        — sessions. A token must be readable the moment it is issued,
 *                    and KV can take a minute to propagate a write, so a session
 *                    could be refused right after being created.
 */

const TOKEN_TTL_SECS = 720 * 60 * 60   // browser tokens have a client-side refresh hint
const EMAIL_MAX = 254

import * as device from './device.js'
import { hooks, allowlist, permits } from './shared.js'

// Published for device.js (which must not import this file's stack eagerly) and
// for tests, which substitute a stub instead of faking RSA signatures.
hooks.accessIdentity ||= (env, req) => accessIdentity(env, req)

// ---------------------------------------------------------------- utilities

const encoder = new TextEncoder()

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** 32 random bytes, base64url. The token is the whole credential. */
function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/** A reference only has to be unguessable enough to survive a race, not decades. */
function randomReference() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}
function base64url(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function now() {
  return Math.floor(Date.now() / 1000)
}

/**
 * Tokens are stored hashed.
 *
 * A D1 row is readable by anyone with the account credential, and a plaintext
 * token there is a live session for the taking. Hashing costs one digest per
 * request and makes a dump of the table useless.
 */
async function tokenKey(token) {
  return sha256Hex(token)
}

/** Deliberately loose: the allowlist decides, this only rejects nonsense. */
function emailWellFormed(email) {
  const trimmed = String(email || '').trim()
  if (!trimmed || trimmed.length > EMAIL_MAX) return false
  const at = trimmed.indexOf('@')
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (!local || !domain || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return false
  }
  return !/[\s\u0000-\u001f\u007f]/.test(trimmed)
}



// ---------------------------------------------------------------- schema

/**
 * Creates the table once per isolate, not once per request.
 *
 * `IF NOT EXISTS` makes the statement harmless, but it is still a write sent to D1
 * on every status poll if it runs unconditionally. The schema cannot change while
 * this isolate lives, so remembering that it ran is enough.
 */
let schemaReady = null
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = createSchema(env).catch((err) => {
      // A failed create must be retried by the next request rather than cached as
      // done, or one transient D1 error would break the isolate for its lifetime.
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

async function createSchema(env) {
  // Every sign-in mints one token in one table. The browser route writes here
  // too: there is no second session table whose tokens the engine cannot sync.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS auth_tokens (
       token_hash TEXT PRIMARY KEY NOT NULL,
       email TEXT NOT NULL,
       device_name TEXT NOT NULL,
       state TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER,
       sync_state TEXT NOT NULL DEFAULT 'pending',
       revoked_at INTEGER
     )`,
  ).run()
  // Device Authorization Flow (auth_system.md): the app's sign-in attempts and
  // the live tokens. Tokens are hashed; device codes are hashed too, while the
  // user code stays readable because the approve page looks it up by it.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS device_codes (
       device_code_hash TEXT PRIMARY KEY NOT NULL,
       user_code TEXT NOT NULL,
       device_name TEXT NOT NULL,
       state TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       approved_by TEXT,
       token_hash TEXT
     )`,
  ).run()
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS device_codes_user_code
     ON device_codes (user_code) WHERE state = 'pending'`,
  ).run()
  // Deployments created before the browser and device flows were unified have
  // an auth_tokens table without expires_at. Add it in place; the column is
  // nullable, so every existing device token stays valid with no expiry.
  await env.DB.prepare(`ALTER TABLE auth_tokens ADD COLUMN expires_at INTEGER`).run()
    .catch((err) => {
      if (!String(err?.message || err).includes('duplicate column')) throw err
    })
  // Tokens issued by the old browser route live in gate_sessions. Copy the
  // live ones into the single table so a deploy does not sign the console out;
  // the old rows are left untouched as a rollback record.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO auth_tokens
       (token_hash, email, device_name, state, created_at, expires_at, sync_state, revoked_at)
     SELECT token_hash, email, 'browser', 'active', created_at, expires_at, 'pending', NULL
       FROM gate_sessions WHERE state = 'active'`,
  ).run().catch(() => {}) // the table may not exist in a fresh deployment

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rate_limits (
       key TEXT PRIMARY KEY NOT NULL,
       window_start INTEGER NOT NULL,
       count INTEGER NOT NULL
     )`,
  ).run()
}

/**
 * The state an auth-token row reports right now.
 *
 * Device-issued tokens have no expiry column value on purpose: the draft's rule
 * is revoke-only. Browser-issued tokens carry `expires_at` so a console token
 * cannot outlive its refresh hint if the console stops asking for a new one.
 * Expiry is derived, never written: a status poll must not become a D1 write.
 */
function effectiveState(row) {
  if (!row) return 'unknown'
  if (row.state !== 'active') return row.state
  if (typeof row.expires_at === 'number' && row.expires_at <= now()) return 'expired'
  return 'active'
}

const EXPLAIN = {
  EMAIL_NOT_ALLOWED: 'That email is not allowed to sign in.',
  BAD_EMAIL: 'That does not look like an email address.',
  NO_ALLOWLIST: 'This deployment has no allowed emails configured yet.',
}

// ---------------------------------------------------------------- handlers

/**
 * Reads the signed-in identity from the Access assertion.
 *
 * The email is taken from a JWT Cloudflare signed, not from the request body. That
 * is the difference between "this browser says it is someone" and "Cloudflare
 * verified this session": a body field can be any string a script sends, while the
 * assertion is issued only after a real login and is bound to this application's
 * audience.
 *
 * The signature is checked against the team's published keys. Reading the claims
 * without verifying them would accept a token this Worker can be handed by anyone,
 * which the email field already allowed.
 */
export async function accessIdentity(env, req) {
  // The header is what an Access-protected origin receives. The cookie is the same
  // assertion held by the browser: it is sent here because this Worker sits on its
  // own hostname, which Access does not protect and therefore does not annotate.
  // Both carry a token signed by the same team key, so the checks below are what
  // make either one trustworthy.
  const assertion =
    req.headers.get('cf-access-jwt-assertion') || accessJwtFromCookies(req.headers.get('cookie') || '')
  if (!assertion) return { error: 'no_assertion' }

  const parts = assertion.split('.')
  if (parts.length !== 3) return { error: 'malformed' }

  let header
  let claims
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])))
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])))
  } catch {
    return { error: 'malformed' }
  }

  const teamDomain = (await configValue(env, 'access/team_domain', 'ACCESS_TEAM_DOMAIN')).trim()
  const audience = (await configValue(env, 'access/app_aud', 'ACCESS_APP_AUD')).trim()
  if (!teamDomain || !audience) return { error: 'not_configured' }

  const verified = await verifySignature(assertion, header, teamDomain)
  if (!verified) return { error: 'bad_signature' }

  // The assertion carries the audience of the Access application that issued it, and
  // several protect this product: the console origin and the engine's own hostname
  // are separate applications with separate tags. Accepting only one would refuse a
  // browser that signed in through the other, which is what made every console
  // sign-in fail while curl against the engine looked fine.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  const accepted = (env.ACCESS_ACCEPTED_AUDIENCES || audience)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (!audiences.some((tag) => accepted.includes(tag))) return { error: 'wrong_audience' }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return { error: 'expired' }

  const email = String(claims.email || claims.sub || '').trim()
  if (!email) return { error: 'no_subject' }
  return { email }
}

/** Checks an RS256 signature against the team's current key set. */
async function verifySignature(assertion, header, teamDomain) {
  const kid = header.kid
  if (!kid) return false

  let keys
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { cache: 'no-store' })
    if (!res.ok) return false
    keys = (await res.json()).keys || []
  } catch {
    return false
  }

  const jwk = keys.find((key) => key.kid === kid)
  if (!jwk) return false

  let key
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    return false
  }

  const [rawHeader, rawPayload, rawSignature] = assertion.split('.')
  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  try {
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64urlDecode(rawSignature),
      signed,
    )
  } catch {
    return false
  }
}

/**
 * Who the browser is signed in as, or 401.
 *
 * Separate from `/auth/request` because it creates nothing: the console calls this
 * on load to decide whether to show the app or the sign-in panel, and it has to be
 * answerable without the engine and without writing a session just to ask.
 */
async function identity(env, req) {
  const found = await hooks.accessIdentity(env, req)
  if (!found.email) {
    return json({ error: 'unauthorized', code: found.error?.toUpperCase() || 'NO_ACCESS_SESSION' }, 401)
  }
  return json({ email: found.email })
}

/** Pulls the Access assertion out of the browser's cookie header. */
function accessJwtFromCookies(cookieHeader) {
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== 'CF_Authorization') continue
    const value = part.slice(index + 1).trim()
    return value ? decodeURIComponent(value) : ''
  }
  return ''
}

function base64urlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function configValue(env, kvKey, varName) {
  try {
    const fromKv = await env.CONFIG.get(kvKey)
    if (fromKv && fromKv.trim()) return fromKv
  } catch {
    // A KV failure must fall through to the variable, not open the door.
  }
  return env[varName] || ''
}

/**
 * What the engine asks: is this token valid, and for whom.
 *
 * The engine does not hold the token table and cannot check a signature, because
 * tokens are opaque. Asking here means revoking a session takes effect on both
 * sides at once.
 */
/**
 * Issues one engine token for the signed-in browser.
 *
 * The console runs on one host and the engine on another, so the Access cookie
 * that proves who the user is never reaches the engine. This route turns that
 * cookie into the same bearer token the app's device flow hands out: one table,
 * one hash format, one push to the engines. Reaching this route at all required
 * a verified Access assertion — the allowlist check below is the remaining gate.
 *
 * The email comes from the assertion, never from the request body, so a caller
 * cannot ask for someone else's token.
 */
async function issueToken(env, req) {
  const found = await hooks.accessIdentity(env, req)
  if (!found.email) {
    return json({ error: 'unauthorized', code: found.error?.toUpperCase() || 'NO_ACCESS_SESSION' }, 401)
  }
  const email = found.email.toLowerCase()

  const allowed = await allowlist(env)
  if (allowed.length > 0 && !permits(allowed, email)) {
    return json({ error: 'forbidden', code: 'EMAIL_NOT_ALLOWED', email }, 403)
  }

  await ensureSchema(env)

  // Every exchange mints a fresh opaque token: the old row stays until its
  // refresh hint runs out, so a page reload cannot resurrect a revoked session.
  const token = randomToken()
  const tokenHash = await tokenKey(token)
  const expiresAt = now() + TOKEN_TTL_SECS
  await env.DB.prepare(
    `INSERT INTO auth_tokens
       (token_hash, email, device_name, state, created_at, expires_at, sync_state, revoked_at)
     VALUES (?1, ?2, 'browser', 'active', ?3, ?4, 'pending', NULL)`,
  )
    .bind(tokenHash, email, now(), expiresAt)
    .run()
  await device.pushSync(env, { activate: [tokenHash] })

  return json({ token, email, expires_at: expiresAt })
}

async function verify(env, req) {
  const token = bearer(req)
  if (!token) {
    return json({ error: 'unauthorized', code: 'NO_TOKEN' }, 401)
  }

  await ensureSchema(env)

  // One token table for every client. The device flow writes here and so does
  // the browser exchange, so a token the engine synced is a token this worker
  // can vouch for — no second session store to keep in step.
  const hash = await tokenKey(token)
  const row = await env.DB.prepare(
    `SELECT state, email, expires_at FROM auth_tokens WHERE token_hash = ?1`,
  )
    .bind(hash)
    .first()

  const state = effectiveState(row)
  if (!row || state === 'unknown') return json({ valid: false, code: 'unknown_token' }, 401)
  if (state === 'pending') return json({ valid: false, code: 'pending_confirmation' }, 403)
  if (state === 'expired') return json({ valid: false, code: 'expired' }, 401)
  return json({ valid: true, email: row.email, expires_at: row.expires_at })
}

function bearer(req) {
  const header = req.headers.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

/**
 * Where a browser goes after Cloudflare Access has let it through.
 *
 * This endpoint exists to be intercepted: a browser with no Access session is sent
 * to the login and comes back here with one. Coming back is the whole point, so the
 * answer has to move the browser on — an empty 200/204 leaves it staring at a blank
 * page, which from the outside is indistinguishable from a sign-in that failed.
 *
 * Only a path on this origin is honoured. An absolute URL would let this endpoint
 * point a freshly authenticated browser somewhere else entirely.
 */
function startRedirect(url) {
  const next = String(url.searchParams.get('next') || '/')
  const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/'
  return new Response(null, { status: 302, headers: { location: safe } })
}

// ---------------------------------------------------------------- routing

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method

    // Cross-origin calls from the console need CORS; it is same-origin through the
    // Pages proxy, but keeping this means the Worker can be called directly too.
    const origin = req.headers.get('origin') || ''
    const cors = {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '600',
      vary: 'Origin',
    }
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    let response
    try {
      if (method === 'POST' && path === '/auth/verify') response = await verify(env, req)
      else if (method === 'POST' && path === '/auth/device/code') response = await device.deviceCode(env, req)
      else if (method === 'POST' && path === '/auth/device/token') response = await device.deviceToken(env, req)
      else if (method === 'GET' && path === '/auth/device') response = await device.devicePage(env, req, url)
      else if (method === 'POST' && path === '/auth/device/approve') response = await device.deviceApprove(env, req)
      else if (method === 'GET' && path === '/auth/sessions') response = await device.sessionsList(env, req)
      else if (method === 'POST' && path === '/auth/revoke') response = await device.revoke(env, req)
      else if (method === 'GET' && path === '/auth/sessions/active') response = await device.activeSessions(env, req)
      else if (path === '/healthz') response = json({ ok: true })
      else if (method === 'GET' && path === '/auth/identity') response = await identity(env, req)
      else if (method === 'POST' && path === '/auth/token') response = await issueToken(env, req)
      else if (method === 'GET' && path === '/auth/start') response = startRedirect(url)

      else response = json({ error: 'not_found' }, 404)
    } catch (err) {
      // A D1 outage must not read as a credential problem: the app would tell the
      // user their account was rejected.
      response = json(
        { error: 'server_error', code: 'STORAGE_FAILED', detail: String(err?.message || err) },
        500,
      )
    }

    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value)
    return response
  },
}
