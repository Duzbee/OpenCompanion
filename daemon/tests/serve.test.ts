import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntimeRegistry, RuntimeToolAdapter } from '@opencompanion/core'
import type { AdapterCapabilities, AuthStatus } from '@opencompanion/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthHealthMonitor, AuthHealthMonitorDeps } from '../src/auth-health'
import { bearerKey } from '../src/pair'
import type { HttpClient } from '../src/poll-client'
import { startDaemon, type ServeDeps } from '../src/serve'
import type { UpdaterDeps } from '../src/update/updater'
import { createFileSecretStore, type SecretStore } from '../src/storage/secret-store'
import { createStateStore, type StateStore } from '../src/storage/state-store'

const BACKEND = 'https://buyer.example'

/** A fresh app-data root + real (temp-backed) state + secret stores. */
function fixtures(): { appDataRoot: string; state: StateStore; secrets: SecretStore } {
  const appDataRoot = mkdtempSync(join(tmpdir(), 'companion-serve-'))
  const state = createStateStore({ cwd: appDataRoot })
  const secrets = createFileSecretStore({
    dir: join(appDataRoot, 'secrets'),
    masterKey: Buffer.alloc(32, 7)
  })
  return { appDataRoot, state, secrets }
}

/** One request the fake HTTP client recorded. */
interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** A recording fake HTTP client that scripts the transport responses by path. */
function fakeHttp(): { http: HttpClient; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
    if (url.endsWith('/connect')) {
      return {
        status: 200,
        json: async () => ({ companionId: 'u1:d1', wireToken: 'wire-token', pollIntervalMs: 999_999 })
      }
    }
    if (url.includes('/poll')) {
      return { status: 200, json: async () => ({ runs: [], cancel: [] }) }
    }
    return { status: 200, json: async () => ({ cancel: [] }) }
  }
  return { http, calls }
}

/** Wires a daemon over the fakes, pre-pairing the backend unless `pair` is false. */
function bootDeps(over: Partial<ServeDeps> & { pair?: boolean } = {}) {
  const { appDataRoot, state, secrets } = fixtures()
  if (over.pair !== false) {
    state.upsertPairedBackend({ backendUrl: BACKEND, deviceId: state.getDeviceId() })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
  }
  const { http, calls } = fakeHttp()
  const lines: string[] = []
  const deps: ServeDeps = {
    appDataRoot,
    state,
    secrets,
    isAlive: () => false,
    registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
    http,
    write: (line) => void lines.push(line),
    ...over
  }
  return { deps, state, secrets, calls, lines }
}

/** Lets the daemon's poll loop run one cycle (connect + poll), flushing microtasks + 0ms timers. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/**
 * Drains the fire-and-forget connect runner's async chain (detect -> auth probe -> result POST), which
 * spans several microtask turns beyond the poll cycle itself. Repeated 0ms advances flush each turn
 * without firing the long poll/flush sleeps.
 */
async function drainRunner(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
}

/** Capabilities stub (unused by the auth probe, but required by the adapter shape). */
const CAPS: AdapterCapabilities = {
  kind: 'agentic',
  supportedAuthModes: ['subscription'],
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  httpMcp: false
}

/** A minimal runtime adapter whose `authStatus` reports a fixed authenticated flag. */
function fakeAdapter(id: string, authenticated: boolean): RuntimeToolAdapter {
  return {
    id,
    displayName: id,
    capabilities: CAPS,
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ authenticated, mode: 'subscription' }),
    listModels: async () => [],
    run: () => ({ cancel: () => {}, respondToPermission: () => {} })
  }
}

/** A registry backed by a fixed id -> adapter map. */
function fakeRegistry(adapters: Record<string, RuntimeToolAdapter>): AgentRuntimeRegistry {
  return {
    getAdapters: () => Object.values(adapters),
    getAdapter: (id) => adapters[id],
    requireAdapter: (id) => {
      const adapter = adapters[id]
      if (!adapter) throw new Error(`no adapter ${id}`)
      return adapter
    }
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const BACKEND2 = 'https://buyer2.example'

describe('startDaemon (serve)', () => {
  it('refuses to boot when no backend is paired', () => {
    const { deps, lines } = bootDeps({ pair: false })
    expect(startDaemon(deps)).toBeNull()
    expect(lines.join('')).toContain('No backend paired')
  })

  it('serves EVERY paired backend and lists them all in the startup line', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    for (const url of [BACKEND, BACKEND2]) {
      state.upsertPairedBackend({ backendUrl: url, deviceId: state.getDeviceId() })
      secrets.set(bearerKey(url), 'bearer-xyz')
    }
    const { http, calls } = fakeHttp()
    const lines: string[] = []
    const daemon = startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      write: (line) => void lines.push(line)
    })
    expect(daemon).not.toBeNull()
    await tick()
    // The startup line names both served backends (multi-backend legibility).
    const startup = lines.find((l) => l.includes('opencompanion daemon running'))
    expect(startup).toContain(BACKEND)
    expect(startup).toContain(BACKEND2)
    // Both backends were connected: one session per backend, each against its own origin.
    expect(calls.some((c) => c.url === `${BACKEND}/companion/connect`)).toBe(true)
    expect(calls.some((c) => c.url === `${BACKEND2}/companion/connect`)).toBe(true)
    await daemon?.stop()
  })

  it('filterUrl serves ONLY the named backend, ignoring other pairings', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    for (const url of [BACKEND, BACKEND2]) {
      state.upsertPairedBackend({ backendUrl: url, deviceId: state.getDeviceId() })
      secrets.set(bearerKey(url), 'bearer-xyz')
    }
    const { http, calls } = fakeHttp()
    const lines: string[] = []
    const daemon = startDaemon({
      appDataRoot,
      state,
      secrets,
      filterUrl: BACKEND,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      write: (line) => void lines.push(line)
    })
    expect(daemon).not.toBeNull()
    await tick()
    const startup = lines.find((l) => l.includes('opencompanion daemon running'))
    expect(startup).toContain(BACKEND)
    expect(startup).not.toContain(BACKEND2)
    // Only the filtered backend was ever contacted.
    expect(calls.some((c) => c.url.startsWith(BACKEND2))).toBe(false)
    await daemon?.stop()
  })

  it('serve --url fails fast (null) when the filtered backend pairing is corrupt (no bearer), releasing the lock', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    // Paired, but the bearer was never stored - a corrupt pairing the poll client cannot authenticate.
    state.upsertPairedBackend({ backendUrl: BACKEND, deviceId: state.getDeviceId() })
    const { http } = fakeHttp()
    const lines: string[] = []
    const registry = { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } }
    const daemon = startDaemon({
      appDataRoot,
      state,
      secrets,
      filterUrl: BACKEND,
      isAlive: () => false,
      registry,
      http,
      write: (line) => void lines.push(line)
    })
    // The single filtered backend could not start a session, so the daemon refuses to boot (cmdServe
    // then exits 1) rather than idling; the "Missing credentials" guidance was surfaced.
    expect(daemon).toBeNull()
    expect(lines.join('')).toContain('Missing credentials')
    // The lock was released on the fast-fail, so a re-boot with a repaired bearer wins immediately.
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    const reboot = startDaemon({
      appDataRoot,
      state,
      secrets,
      filterUrl: BACKEND,
      isAlive: () => true,
      registry,
      http,
      write: () => undefined
    })
    expect(reboot).not.toBeNull()
    await reboot?.stop()
  })

  it('refuses to boot when another instance holds the single-instance lock', async () => {
    const { deps } = bootDeps()
    // The first boot wins and HOLDS the lock (no stop). A second boot on the same dir with a live
    // holder is refused.
    const first = startDaemon(deps)
    expect(first).not.toBeNull()
    const second = bootDeps({ appDataRoot: deps.appDataRoot, isAlive: () => true })
    expect(startDaemon(second.deps)).toBeNull()
    expect(second.lines.join('')).toContain('already running')
    await first?.stop()
  })

  it('connects by exchanging the stored bearer + deviceId for a wire token (never a bespoke secret)', async () => {
    const { deps, calls, state } = bootDeps()
    const daemon = startDaemon(deps)
    expect(daemon).not.toBeNull()
    await tick()
    const connect = calls.find((c) => c.url.endsWith('/connect'))
    expect(connect).toBeDefined()
    // The connect carries the stored Better Auth bearer and the device id - no wire secret of our own.
    expect(connect?.headers.authorization).toBe('Bearer bearer-xyz')
    expect(JSON.parse(connect?.body ?? '{}').deviceId).toBe(state.getDeviceId())
    expect(JSON.stringify(calls)).not.toContain('secret')
    // The daemon appends the companion path to the API base it was paired with (relative, not a
    // hardcoded /api on the origin), so it reaches the transport wherever the API is mounted.
    expect(connect?.url).toBe(`${BACKEND}/companion/connect`)
    await daemon?.stop()
  })

  it('polls for dispatched runs after connecting, presenting the wire token', async () => {
    const { deps, calls } = bootDeps()
    const daemon = startDaemon(deps)
    await tick()
    const poll = calls.find((c) => c.url.includes('/poll'))
    expect(poll).toBeDefined()
    expect(poll?.headers.authorization).toBe('Bearer wire-token')
    await daemon?.stop()
  })

  it('reports a mid-session connect: a SEPARATE store write reaches the next poll (fresh reads)', async () => {
    // Boot with NO connection recorded, then simulate a separate `companion connect` process writing
    // the state file after the daemon is already running. The daemon reads connections through a fresh
    // store per call, so the new connection must ride the NEXT poll's `connections` query - proving the
    // captured-store staleness bug is fixed and an external connect propagates without restarting serve.
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend({ backendUrl: BACKEND, deviceId: state.getDeviceId() })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    const pollUrls: string[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) {
        // A short cadence so the second poll fires when we advance the fake timers below.
        return { status: 200, json: async () => ({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 10 }) }
      }
      if (url.includes('/poll')) {
        pollUrls.push(url)
        return { status: 200, json: async () => ({ runs: [], cancel: [] }) }
      }
      return { status: 200, json: async () => ({ cancel: [] }) }
    }
    const deps: ServeDeps = {
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      write: () => undefined
    }
    const daemon = startDaemon(deps)
    expect(daemon).not.toBeNull()
    await tick()
    // The first poll reported an empty connection set.
    expect(pollUrls.length).toBeGreaterThan(0)
    expect(new URL(pollUrls[0]!).searchParams.get('connections')).toBe('[]')
    // A separate process connects a CLI (a fresh store writing the SAME state file the daemon captured).
    createStateStore({ cwd: appDataRoot }).upsertConnection(BACKEND, {
      toolId: 'codex',
      source: 'reused',
      authHealth: 'healthy'
    })
    // Advance to the next poll; the daemon's fresh read must now report the new connection.
    await vi.advanceTimersByTimeAsync(15)
    const last = pollUrls[pollUrls.length - 1]!
    expect(JSON.parse(new URL(last).searchParams.get('connections') ?? '[]')).toEqual([
      { toolId: 'codex', authHealth: 'healthy' }
    ])
    await daemon?.stop()
  })

  it('creates the local audit log directory under the app-data root (every run is auditable)', async () => {
    const { deps } = bootDeps()
    const daemon = startDaemon(deps)
    expect(daemon).not.toBeNull()
    // The daemon establishes its audit substrate at boot so a dispatched run can be logged fail-closed.
    expect(existsSync(join(deps.appDataRoot, 'audit'))).toBe(true)
    await daemon?.stop()
  })

  it('drains on stop: stops the poll client and releases the lock so a re-boot wins', async () => {
    const { deps } = bootDeps()
    const daemon = startDaemon(deps)
    await tick()
    await daemon?.stop()
    // The lock is released, so a fresh boot on the same dir wins again.
    const reboot = bootDeps({ appDataRoot: deps.appDataRoot, isAlive: () => true })
    const again = startDaemon(reboot.deps)
    expect(again).not.toBeNull()
    await again?.stop()
  })

  it('probes EVERY connected CLI and persists each one auth-health (not just the first)', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend({ backendUrl: BACKEND, deviceId: state.getDeviceId() })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    // Two connected CLIs, both stale-"healthy" in the store; the SECOND has actually lost auth.
    state.upsertConnection(BACKEND, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    state.upsertConnection(BACKEND, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    const registry = fakeRegistry({
      'claude-code': fakeAdapter('claude-code', true),
      codex: fakeAdapter('codex', false)
    })
    // Capture the probe the monitor is built with so we can drive it directly.
    let probe: (() => Promise<AuthStatus>) | null = null
    const makeAuthMonitor = (mdeps: AuthHealthMonitorDeps): AuthHealthMonitor => {
      probe = mdeps.probe
      return { current: () => 'unknown', start: () => undefined, probeNow: async () => 'unknown', stop: () => undefined }
    }
    const { http } = fakeHttp()
    const daemon = startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry,
      http,
      makeAuthMonitor,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    const aggregate = await probe?.()
    // The aggregate is unauthenticated because one CLI is broken.
    expect(aggregate?.authenticated).toBe(false)
    // Each connection's persisted health reflects its OWN adapter (the old code probed only the first,
    // so codex would have stayed "healthy" and masked the broken CLI).
    const fresh = createStateStore({ cwd: appDataRoot })
    expect(fresh.getConnection(BACKEND, 'claude-code')?.authHealth).toBe('healthy')
    expect(fresh.getConnection(BACKEND, 'codex')?.authHealth).toBe('needs-reauth')
    await daemon?.stop()
  })

  it('collects a poll-delivered connect instruction, runs it, and POSTs the result back (runner wired end to end)', async () => {
    // A poll delivers ONE connect instruction for an authed CLI. The daemon must hand it to the connect
    // runner, which drives the (real) headless connect against the fake adapter, records the connection,
    // and posts the mapped result back through the poll client - proving runner + client + registry are
    // wired together inside startDaemon (not just unit-tested in isolation).
    const instruction = { requestId: 'req-1', toolId: 'codex', install: false }
    const calls: RecordedRequest[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      if (url.endsWith('/connect')) {
        return {
          status: 200,
          json: async () => ({ companionId: 'u1:d1', wireToken: 'wire-token', pollIntervalMs: 999_999 })
        }
      }
      if (url.includes('/poll')) {
        return { status: 200, json: async () => ({ runs: [], cancel: [], connects: [instruction] }) }
      }
      return { status: 200, json: async () => ({ cancel: [] }) }
    }
    const registry = fakeRegistry({ codex: fakeAdapter('codex', true) })
    const { deps } = bootDeps({ http, registry })
    const daemon = startDaemon(deps)
    expect(daemon).not.toBeNull()
    await tick()
    await drainRunner()
    const result = calls.find((c) => c.url.endsWith('/companion/connects/req-1/result'))
    expect(result).toBeDefined()
    expect(result?.method).toBe('POST')
    expect(result?.headers.authorization).toBe('Bearer wire-token')
    const body = JSON.parse(result?.body ?? '{}') as {
      toolId: string
      status: string
      connections: Array<{ toolId: string; authHealth: string }>
    }
    expect(body.status).toBe('connected')
    expect(body.connections).toEqual([{ toolId: 'codex', authHealth: 'healthy' }])
    await daemon?.stop()
  })

  it('runs the self-update loop and its findings ride the poll heartbeat (presence badges the update)', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend({ backendUrl: BACKEND, deviceId: state.getDeviceId() })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    // Auto-update off: the loop still CHECKS (so presence can badge a waiting update) but never stages
    // or restarts, keeping this test free of the process.exit apply path.
    state.setAutoUpdate(false)
    // A fake updater whose release channel advertises a much newer version; only VERSION is fetched
    // because auto-update is off (no staging), so the other IO seams are never exercised here.
    const updater: UpdaterDeps = {
      installDir: appDataRoot,
      releaseBase: 'https://releases.example',
      platform: 'linux',
      arch: 'x64',
      download: async (url, dest) => {
        if (!url.endsWith('/VERSION')) throw new Error(`unexpected download ${url}`)
        writeFileSync(dest, '9.9.9\n')
      },
      run: async () => ({ ok: true, stdout: '' }),
      log: () => undefined
    }
    const pollUrls: string[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) {
        return { status: 200, json: async () => ({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 10 }) }
      }
      if (url.includes('/poll')) {
        pollUrls.push(url)
        return { status: 200, json: async () => ({ runs: [], cancel: [] }) }
      }
      return { status: 200, json: async () => ({ cancel: [] }) }
    }
    const daemon = startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      updater,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    // Let the initial check resolve and a subsequent poll carry the state (updateState is read fresh
    // per poll, so the check need only land before the poll it rides on).
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5)
    const last = pollUrls[pollUrls.length - 1]!
    const params = new URL(last).searchParams
    expect(params.get('updateAvailable')).toBe('true')
    expect(params.get('latestVersion')).toBe('9.9.9')
    await daemon?.stop()
  })

  it('a probe that THROWS keeps that connection last-known health (a detection miss is not a re-auth)', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend({ backendUrl: BACKEND, deviceId: state.getDeviceId() })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    // Both CLIs are stored healthy. claude-code's probe THROWS (its binary did not resolve under the
    // daemon's minimal-PATH env); codex is genuinely still signed in.
    state.upsertConnection(BACKEND, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    state.upsertConnection(BACKEND, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    const throwingClaude: RuntimeToolAdapter = {
      ...fakeAdapter('claude-code', true),
      authStatus: async () => {
        throw new Error('Claude Code is not installed')
      }
    }
    const registry = fakeRegistry({ 'claude-code': throwingClaude, codex: fakeAdapter('codex', true) })
    let probe: (() => Promise<AuthStatus>) | null = null
    const makeAuthMonitor = (mdeps: AuthHealthMonitorDeps): AuthHealthMonitor => {
      probe = mdeps.probe
      return { current: () => 'unknown', start: () => undefined, probeNow: async () => 'unknown', stop: () => undefined }
    }
    const { http } = fakeHttp()
    const daemon = startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry,
      http,
      makeAuthMonitor,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    const aggregate = await probe?.()
    // The throw is swallowed - no re-auth false-flag - and codex is authenticated, so the aggregate
    // stays authenticated (the detection miss does not drag it down).
    expect(aggregate?.authenticated).toBe(true)
    const fresh = createStateStore({ cwd: appDataRoot })
    // claude-code KEEPS its last-known healthy; a detection miss must never flip it to needs-reauth.
    expect(fresh.getConnection(BACKEND, 'claude-code')?.authHealth).toBe('healthy')
    expect(fresh.getConnection(BACKEND, 'codex')?.authHealth).toBe('healthy')
    await daemon?.stop()
  })
})
