import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bearerKey,
  nextDevicePollResult,
  readBearer,
  runPair,
  runUnpair,
  type FetchFn
} from '../src/pair'
import { createAuditLog } from '../src/audit-log'
import { makeMasterKey } from '../src/master-key'
import { createFileSecretStore } from '../src/storage/secret-store'
import { createStateStore } from '../src/storage/state-store'

const BACKEND = 'https://buyer.example'
const CLIENT_ID = 'companion'

/** Builds real (temp-backed) stores, a local audit log, an output-capturing sink, and a no-op sleep. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'companion-pair-'))
  const state = createStateStore({ cwd: dir })
  const secrets = createFileSecretStore({ dir: join(dir, 'secrets'), masterKey: makeMasterKey(join(dir, 'secrets')) })
  const audit = createAuditLog({ dir: join(dir, 'audit') })
  const lines: string[] = []
  return { state, secrets, audit, lines, write: (line: string) => lines.push(line), sleep: async () => {} }
}

/** A `Response`-like the mock fetch returns. */
function res(ok: boolean, status: number, body: unknown): {
  ok: boolean
  status: number
  json(): Promise<unknown>
} {
  return { ok, status, json: async () => body }
}

/**
 * A mock fetch that answers `/device/code` with a fixed code and `/device/token` from a queued
 * sequence of token responses (consumed in order).
 */
function mockFetch(tokenSequence: ReturnType<typeof res>[]): FetchFn {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/device/code')) {
      return res(true, 200, {
        device_code: 'DEVCODE',
        user_code: 'WXYZ-1234',
        verification_uri: `${BACKEND}/device`,
        interval: 1
      })
    }
    if (url.endsWith('/device/token')) {
      const next = tokenSequence.shift()
      if (!next) throw new Error('token sequence exhausted')
      return next
    }
    throw new Error(`unexpected url ${url}`)
  })
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.restoreAllMocks())

describe('nextDevicePollResult (RFC 8628 mapping)', () => {
  it('maps a present token to success', () => {
    expect(nextDevicePollResult({ accessToken: 'tok', interval: 5 })).toEqual({
      kind: 'success',
      accessToken: 'tok'
    })
  })
  it('keeps polling on authorization_pending', () => {
    expect(nextDevicePollResult({ errorCode: 'authorization_pending', interval: 5 })).toEqual({
      kind: 'pending'
    })
  })
  it('slows down by 5s on slow_down', () => {
    expect(nextDevicePollResult({ errorCode: 'slow_down', interval: 5 })).toEqual({
      kind: 'slow_down',
      nextInterval: 10
    })
  })
  it('errors on access_denied and expired_token', () => {
    expect(nextDevicePollResult({ errorCode: 'access_denied', interval: 5 }).kind).toBe('error')
    expect(nextDevicePollResult({ errorCode: 'expired_token', interval: 5 }).kind).toBe('error')
  })
})

describe('runPair', () => {
  it('prints the verification URL + user code and stores the bearer on success', async () => {
    const h = harness()
    const fetchFn = mockFetch([
      res(false, 400, { error: 'authorization_pending' }),
      res(true, 200, { access_token: 'SECRET_BEARER' })
    ])
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result).toEqual({ ok: true })
    const output = h.lines.join('')
    expect(output).toContain(`${BACKEND}/device`)
    expect(output).toContain('WXYZ-1234')
    // The bearer is persisted in the encrypted store and never appears in the printed output.
    expect(readBearer(BACKEND, h.secrets)).toBe('SECRET_BEARER')
    expect(output).not.toContain('SECRET_BEARER')
    expect(h.state.getPairedBackend(BACKEND)?.deviceId).toBe(h.state.getDeviceId())
  })

  it('keeps polling past authorization_pending then succeeds', async () => {
    const h = harness()
    const fetchFn = mockFetch([
      res(false, 400, { error: 'authorization_pending' }),
      res(false, 400, { error: 'authorization_pending' }),
      res(true, 200, { access_token: 'TOK' })
    ])
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result.ok).toBe(true)
  })

  it('backs off on slow_down (interval grows) and still succeeds', async () => {
    const h = harness()
    const sleeps: number[] = []
    const fetchFn = mockFetch([
      res(false, 400, { error: 'slow_down' }),
      res(true, 200, { access_token: 'TOK' })
    ])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      {
        state: h.state,
        secrets: h.secrets,
        fetchFn,
        write: h.write,
        sleep: async (s) => void sleeps.push(s)
      }
    )
    // The code interval is 1; after slow_down the next sleep is 1 + 5 = 6.
    expect(sleeps).toEqual([1, 6])
  })

  it('fails on access_denied without storing a bearer', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(false, 400, { error: 'access_denied' })])
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result).toEqual({ ok: false })
    expect(readBearer(BACKEND, h.secrets)).toBeNull()
  })

  it('fails on expired_token', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(false, 400, { error: 'expired_token' })])
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result.ok).toBe(false)
  })

  it('fails when the device-code request is rejected', async () => {
    const h = harness()
    const fetchFn: FetchFn = vi.fn(async () => res(false, 500, {}))
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result.ok).toBe(false)
    expect(h.state.getPairedBackend(BACKEND)).toBeNull()
  })
})

describe('runUnpair', () => {
  it('removes the stored bearer and the paired-backend state', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(true, 200, { access_token: 'TOK' })])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(readBearer(BACKEND, h.secrets)).toBe('TOK')

    const result = runUnpair(BACKEND, { state: h.state, secrets: h.secrets, write: h.write })
    expect(result).toEqual({ ok: true })
    expect(readBearer(BACKEND, h.secrets)).toBeNull()
    expect(h.state.getPairedBackend(BACKEND)).toBeNull()
  })

  it('reports when the backend is not paired', () => {
    const h = harness()
    const result = runUnpair(BACKEND, { state: h.state, secrets: h.secrets, write: h.write })
    expect(result.ok).toBe(false)
  })
})

describe('pairing lifecycle audit', () => {
  it('appends a pair event carrying the backendUrl and deviceId on success', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(true, 200, { access_token: 'TOK' })])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, audit: h.audit, fetchFn, write: h.write, sleep: h.sleep }
    )
    const entries = h.audit.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.event).toBe('pair')
    expect(entries[0]?.backendUrl).toBe(BACKEND)
    expect(entries[0]?.detail?.deviceId).toBe(h.state.getDeviceId())
  })

  it('does not audit a failed pair', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(false, 400, { error: 'access_denied' })])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, audit: h.audit, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(h.audit.read()).toHaveLength(0)
  })

  it('appends an unpair event carrying the backendUrl and deviceId on success', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(true, 200, { access_token: 'TOK' })])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    const deviceId = h.state.getDeviceId()
    const result = runUnpair(BACKEND, { state: h.state, secrets: h.secrets, audit: h.audit, write: h.write })
    expect(result.ok).toBe(true)
    const entries = h.audit.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.event).toBe('unpair')
    expect(entries[0]?.backendUrl).toBe(BACKEND)
    expect(entries[0]?.detail?.deviceId).toBe(deviceId)
  })

  it('does not audit a not-paired unpair', () => {
    const h = harness()
    runUnpair(BACKEND, { state: h.state, secrets: h.secrets, audit: h.audit, write: h.write })
    expect(h.audit.read()).toHaveLength(0)
  })
})

describe('bearerKey', () => {
  it('is filesystem-safe and stable per backend', () => {
    const key = bearerKey(BACKEND)
    expect(key).toMatch(/^bearer-[0-9a-f]{32}$/)
    expect(bearerKey(BACKEND)).toBe(key)
    expect(bearerKey('https://other.example')).not.toBe(key)
  })
})
