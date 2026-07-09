import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceSpec } from '../src/service'

const APP_DATA = mkdtempSync(join(tmpdir(), 'companion-cli-'))
// The app-data dir the mocked `appDataDir()` returns. Defaults to the shared APP_DATA; a test that
// needs a clean single-paired-backend state points it at its own fresh dir for the duration.
let appDataOverride = APP_DATA

const runPair = vi.fn(async () => ({ ok: true }))
const runUnpair = vi.fn(() => ({ ok: true }))
const runConnect = vi.fn(async () => [])
const buildCompanionRegistry = vi.fn(() => ({}))
const clackSelect = vi.fn(async () => 'skip' as string)
const clackMultiselect = vi.fn(async (): Promise<string[]> => [])
const connectTool = vi.fn(async () => ({ kind: 'reused', toolId: 'claude-code', authHealth: 'healthy' }))
const startDaemon = vi.fn(() => null)
// The update command's IO seams: scripted per test so the apply/check paths run without a network or a
// real versioned install. Defaults are inert (no update available, no-op flip/prune).
const checkLatest = vi.fn(async () => ({ current: '0.0.0-dev', latest: null, updateAvailable: false }))
const stageVersion = vi.fn(async () => '/versions/staged')
const flipCurrent = vi.fn(() => undefined)
const pruneVersions = vi.fn(() => undefined)
const installService = vi.fn((_spec: ServiceSpec) => ({ path: '/unit', message: 'installed' }))
const uninstallService = vi.fn(() => ({ message: 'removed' }))
const serviceStatus = vi.fn(() => ({ installed: true, message: 'installed and loaded' }))

vi.mock('../src/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/paths')>()
  return { ...actual, appDataDir: () => appDataOverride }
})
vi.mock('../src/pair', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pair')>()
  return { ...actual, runPair, runUnpair }
})
// Fake the clack UI so commands never touch a real TTY: message helpers echo to stdout (so the
// text assertions still see the content), and `select` is scripted per test.
vi.mock('@clack/prompts', () => {
  const emit = (m: unknown): void => void process.stdout.write(`${String(m)}\n`)
  return {
    intro: emit,
    outro: emit,
    cancel: emit,
    note: (body: unknown, title?: unknown) => emit(`${title ?? ''} ${body ?? ''}`),
    log: { info: emit, success: emit, warn: emit, warning: emit, error: emit, message: emit, step: emit },
    spinner: () => ({ start: emit, stop: emit, message: emit }),
    select: clackSelect,
    multiselect: clackMultiselect,
    isCancel: () => false
  }
})
vi.mock('../src/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/connect')>()
  return {
    ...actual,
    runConnect,
    buildCompanionRegistry,
    connectTool
  }
})
vi.mock('../src/serve', () => ({ startDaemon }))
vi.mock('../src/update/updater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/update/updater')>()
  return { ...actual, checkLatest, stageVersion, flipCurrent, pruneVersions }
})
vi.mock('../src/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/service')>()
  return { ...actual, installService, uninstallService, serviceStatus }
})

const { main } = await import('../src/cli')

let exitCode: number | undefined
let stdout: string
let stderr: string

beforeEach(() => {
  exitCode = undefined
  stdout = ''
  stderr = ''
  appDataOverride = APP_DATA
  vi.clearAllMocks()
  // Default stdin to non-TTY so `serve` never blocks on the interactive connect prompt; the TTY
  // path is exercised explicitly by its own test.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  // process.exit throws so the command handler stops exactly where the real CLI would exit.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error('__exit__')
  }) as never)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(() => vi.restoreAllMocks())

/** Runs `main(argv)`, swallowing the `process.exit` throw the stub raises. */
async function run(argv: string[]): Promise<void> {
  try {
    await main(argv)
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__exit__') throw err
  }
}

describe('cli routing', () => {
  it('routes "pair" to runPair and exits 0 on success', async () => {
    await run(['pair', '--url', 'https://b.example'])
    expect(runPair).toHaveBeenCalledTimes(1)
    expect(exitCode).toBe(0)
  })

  it('"pair" with no --url and nothing paired requires an explicit backend', async () => {
    // Pairing DEFINES the backend URL, so with no --url and an empty pairing set the companion
    // (which no longer carries a baked-in default) must refuse rather than invent one.
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-pairreq-'))
    appDataOverride = solo
    await run(['pair'])
    expect(runPair).not.toHaveBeenCalled()
    expect(stdout).toContain('Not paired with any backend')
    expect(exitCode).toBe(1)
    appDataOverride = APP_DATA
  })

  it('passes --url and --client-id through to runPair', async () => {
    await run(['pair', '--url', 'https://b.example', '--client-id', 'companion'])
    expect(runPair).toHaveBeenCalledWith(
      { backendUrl: 'https://b.example', clientId: 'companion' },
      expect.anything()
    )
  })

  it('routes "unpair" to runUnpair', async () => {
    await run(['unpair', '--url', 'https://b.example'])
    expect(runUnpair).toHaveBeenCalledWith('https://b.example', expect.anything())
  })

  it('"unpair" success notes that a running daemon stops serving it within ~15s', async () => {
    await run(['unpair', '--url', 'https://b.example'])
    expect(stdout).toContain('~15s')
    expect(exitCode).toBe(0)
  })

  it('"unpair" refuses a not-paired backend, naming "opencompanion backends", and exits 1', async () => {
    runUnpair.mockReturnValueOnce({ ok: false })
    await run(['unpair', '--url', 'https://notpaired.example'])
    expect(stdout).toContain('opencompanion backends')
    expect(exitCode).toBe(1)
  })

  it('"backends" prints the pair hint when nothing is paired', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-backends-empty-'))
    appDataOverride = solo
    await run(['backends'])
    expect(stdout).toContain('opencompanion pair')
    appDataOverride = APP_DATA
  })

  it('"backends" lists each pairing with device id, connected CLI count, ceiling, and daemon state', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-backends-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend({ backendUrl: 'https://bk.example', deviceId: 'dev-123' })
    state.upsertConnection('https://bk.example', { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    await run(['backends'])
    expect(stdout).toContain('https://bk.example')
    expect(stdout).toContain('dev-123')
    expect(stdout).toContain('1') // one connected CLI
    expect(stdout).toContain('auto-edit') // the default ceiling permission mode
    expect(stdout).toContain('daemon running: no')
    appDataOverride = APP_DATA
  })

  it('"backends" reports the daemon as running when a live single-instance lock is held', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-backends-live-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: 'https://live.example', deviceId: 'dl' })
    const { writeFileSync } = await import('node:fs')
    // The daemon records its own pid in the single-instance lock; this process is alive, so the
    // liveness probe reports the daemon as running.
    writeFileSync(join(solo, 'opencompanion.pid'), String(process.pid))
    await run(['backends'])
    expect(stdout).toContain('daemon running: yes')
    appDataOverride = APP_DATA
  })

  it('refuses "connect" when the backend is not paired', async () => {
    await run(['connect', '--url', 'https://unpaired.example'])
    expect(runConnect).not.toHaveBeenCalled()
    expect(stdout).toContain('Not paired')
    expect(exitCode).toBe(1)
  })

  it('routes "connect <tool>" to runConnect once the backend is paired', async () => {
    // Pair the backend first so the connect guard passes (real store under the temp dir).
    const { createStateStore } = await import('../src/storage/state-store')
    const state = createStateStore({ cwd: APP_DATA })
    state.upsertPairedBackend({ backendUrl: 'https://b.example', deviceId: 'd1' })
    await run(['connect', 'codex', '--url', 'https://b.example'])
    expect(runConnect).toHaveBeenCalledWith(expect.anything(), 'codex')
  })

  it('"connect <unknown-tool>" exits non-zero (empty outcomes are a failure, not success)', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-connbad-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: 'https://cb.example', deviceId: 'dcb' })
    // `runConnect` rejects an unknown tool and returns NO outcomes (the default mock returns []); the
    // CLI must translate that into a non-zero exit rather than printing "Coding CLIs connected."
    runConnect.mockResolvedValueOnce([])
    await run(['connect', 'not-a-cli', '--url', 'https://cb.example'])
    expect(exitCode).toBe(1)
    expect(stdout).not.toContain('Coding CLIs connected')
    appDataOverride = APP_DATA
  })

  it('routes "connect <tool>" with no --url to the single paired backend (dev convenience)', async () => {
    // A fresh app-data dir so exactly one backend is paired (the shared APP_DATA has several from
    // earlier tests). The resolver must pick that single paired backend when --url is absent, so
    // `companion connect codex` works flagless.
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-solo-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: 'https://solo.example', deviceId: 'd7' })
    await run(['connect', 'codex'])
    expect(runConnect).toHaveBeenCalledWith(
      expect.objectContaining({ backendUrl: 'https://solo.example' }),
      'codex'
    )
    appDataOverride = APP_DATA
  })

  it('bare "connect" without a TTY detects only (never installs unasked) and exits 0', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-conndetect-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: 'https://cd.example', deviceId: 'dd' })
    await run(['connect', '--url', 'https://cd.example'])
    expect(runConnect).toHaveBeenCalledWith(expect.objectContaining({ install: false }))
    expect(clackMultiselect).not.toHaveBeenCalled()
    expect(connectTool).not.toHaveBeenCalled()
    expect(exitCode).toBe(0)
    appDataOverride = APP_DATA
  })

  it('bare "connect" in a TTY offers a multiselect and connects only the chosen CLIs', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-connpick-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: 'https://cp.example', deviceId: 'dp' })
    clackMultiselect.mockResolvedValueOnce(['codex'])
    await run(['connect', '--url', 'https://cp.example'])
    expect(runConnect).toHaveBeenCalledWith(expect.objectContaining({ install: false }))
    expect(clackMultiselect).toHaveBeenCalledOnce()
    expect(connectTool).toHaveBeenCalledOnce()
    expect(connectTool.mock.calls[0]?.[0]).toBe('codex')
    expect(exitCode).toBe(0)
    appDataOverride = APP_DATA
  })

  it('routes "disconnect <tool>" to removing the connection on the single paired backend', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-disc-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend({ backendUrl: 'https://disc.example', deviceId: 'd8' })
    state.upsertConnection('https://disc.example', {
      toolId: 'codex',
      source: 'reused',
      authHealth: 'healthy'
    })
    await run(['disconnect', 'codex'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Disconnected codex')
    // A fresh store reflects the removal.
    expect(createStateStore({ cwd: solo }).getConnection('https://disc.example', 'codex')).toBeNull()
    appDataOverride = APP_DATA
  })

  it('"disconnect" rejects an unknown tool id', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-discbad-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: 'https://discbad.example', deviceId: 'd9' })
    await run(['disconnect', 'not-a-cli'])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('Choose a CLI to disconnect')
    appDataOverride = APP_DATA
  })

  it('"disconnect" refuses when the backend is not paired', async () => {
    await run(['disconnect', 'codex', '--url', 'https://unpaired-disc.example'])
    expect(stdout).toContain('Not paired')
    expect(exitCode).toBe(1)
  })

  it('routes "status" to a non-secret summary', async () => {
    await run(['status'])
    expect(stdout.length).toBeGreaterThan(0)
  })

  it('routes "serve" to startDaemon and exits non-zero when boot fails', async () => {
    // 'https://b.example' was paired by the connect test above, so serve skips pairing and boots.
    // startDaemon is mocked to null here (real boot is covered in serve.test), so cmdServe exits 1.
    await run(['serve', '--url', 'https://b.example'])
    expect(startDaemon).toHaveBeenCalledOnce()
    expect((startDaemon.mock.calls[0]?.[0] as { filterUrl: string }).filterUrl).toBe('https://b.example')
    expect(exitCode).toBe(1)
  })

  it('"serve" pairs on demand when the backend is not paired, then proceeds to boot', async () => {
    await run(['serve', '--url', 'https://serve-fresh.example'])
    expect(runPair).toHaveBeenCalledOnce()
    // A successful on-demand pair falls through to booting (startDaemon is null in this suite).
    expect(startDaemon).toHaveBeenCalledOnce()
    expect(exitCode).toBe(1)
  })

  it('"serve" aborts before booting when on-demand pairing fails', async () => {
    runPair.mockResolvedValueOnce({ ok: false })
    await run(['serve', '--url', 'https://serve-nopair.example'])
    expect(runPair).toHaveBeenCalledOnce()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(exitCode).toBe(1)
  })

  it('"serve" skips pairing when the backend is already paired', async () => {
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend({
      backendUrl: 'https://serve-paired.example',
      deviceId: 'd4'
    })
    await run(['serve', '--url', 'https://serve-paired.example'])
    expect(runPair).not.toHaveBeenCalled()
    expect(startDaemon).toHaveBeenCalledOnce()
  })

  it('"serve" offers an interactive CLI connect when paired but nothing is connected (TTY)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend({
      backendUrl: 'https://serve-connect.example',
      deviceId: 'd5'
    })
    clackSelect.mockResolvedValueOnce('claude-code')
    await run(['serve', '--url', 'https://serve-connect.example'])
    expect(clackSelect).toHaveBeenCalledOnce()
    expect(connectTool).toHaveBeenCalledOnce()
    expect(connectTool.mock.calls[0]?.[0]).toBe('claude-code')
    expect(startDaemon).toHaveBeenCalledOnce()
  })

  it('"serve" does not prompt to connect when stdin is not a TTY', async () => {
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend({
      backendUrl: 'https://serve-notty.example',
      deviceId: 'd6'
    })
    await run(['serve', '--url', 'https://serve-notty.example'])
    expect(clackSelect).not.toHaveBeenCalled()
    expect(startDaemon).toHaveBeenCalledOnce()
  })

  it('"serve --if-paired" prints one hint and exits 0 on an unpaired machine (no pairing, no daemon)', async () => {
    // The unpaired opportunistic path is how `pnpm dev` runs the daemon: it must not pair or boot.
    await run(['serve', '--url', 'https://ifpaired-unpaired.example', '--if-paired'])
    expect(runPair).not.toHaveBeenCalled()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(exitCode).toBeUndefined()
    expect(stdout).toContain('OpenCompanion idle')
  })

  it('"serve --if-paired" boots when a backend is already paired', async () => {
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend({
      backendUrl: 'https://ifpaired-paired.example',
      deviceId: 'd7'
    })
    await run(['serve', '--url', 'https://ifpaired-paired.example', '--if-paired'])
    expect(runPair).not.toHaveBeenCalled()
    expect(startDaemon).toHaveBeenCalledOnce()
    // startDaemon is mocked to null here; --if-paired treats a failed boot as a clean skip (exit 0),
    // where a bare `serve` would exit 1.
    expect(exitCode).toBeUndefined()
  })

  it('"serve --if-paired" with NO --url finds the single paired backend (API-suffixed key)', async () => {
    // `pnpm dev` runs `serve --if-paired` with no --url. Pairings are keyed by the backend's
    // API URL (with /api), so resolving via the bare config default would miss them - the
    // resolution must fall back to the SINGLE paired backend, like connect/disconnect do.
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    appDataOverride = mkdtempSync(join(tmpdir(), 'companion-single-paired-'))
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: appDataOverride }).upsertPairedBackend({
      backendUrl: 'http://localhost:3000/api',
      deviceId: 'd8'
    })
    await run(['serve', '--if-paired'])
    expect(runPair).not.toHaveBeenCalled()
    expect(startDaemon).toHaveBeenCalledOnce()
    expect(stdout).not.toContain('OpenCompanion idle')
    expect(exitCode).toBeUndefined()
  })

  it('"service install" installs a bare-serve boot service when a backend is paired (no --url needed)', async () => {
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend({
      backendUrl: 'https://svc-install.example',
      deviceId: 'dsvc'
    })
    // Inject a sentinel argv[1] so the assertion pins the resolved entry to the launched script, not a
    // module path: buildServiceSpec must re-invoke `process.argv[1]` (bundler-independent, like
    // isEntryPoint), so the boot service always runs the real dispatch entry. Clear the root-launcher
    // marker so this asserts the dev-build fallback path, not the versioned-install path.
    const originalEntry = process.argv[1]
    const originalLauncher = process.env.OPENCOMPANION_ROOT_LAUNCHER
    process.argv[1] = '/opt/opencompanion/daemon/cli.js'
    delete process.env.OPENCOMPANION_ROOT_LAUNCHER
    try {
      await run(['service', 'install'])
    } finally {
      process.argv[1] = originalEntry
      if (originalLauncher === undefined) delete process.env.OPENCOMPANION_ROOT_LAUNCHER
      else process.env.OPENCOMPANION_ROOT_LAUNCHER = originalLauncher
    }
    expect(installService).toHaveBeenCalledOnce()
    // The boot service runs `<node> <argv[1]> serve` (bare: serve-all + hot pickup, never pinned to a --url).
    const program = installService.mock.calls[0]?.[0].program
    expect(program).toEqual([process.execPath, '/opt/opencompanion/daemon/cli.js', 'serve'])
    expect(program).not.toContain('--url')
    expect(stdout).toContain('installed')
    expect(exitCode).toBe(0)
  })

  it('"service install" runs the stable root launcher when OPENCOMPANION_ROOT_LAUNCHER is set', async () => {
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend({
      backendUrl: 'https://svc-launcher.example',
      deviceId: 'dsvcl'
    })
    // A versioned install's root launcher exports its own absolute path before exec, so the boot
    // service tracks the `current` pointer across updates by running `<root launcher> serve` instead
    // of node+cli paths baked inside one version dir (which an update would orphan).
    const originalLauncher = process.env.OPENCOMPANION_ROOT_LAUNCHER
    process.env.OPENCOMPANION_ROOT_LAUNCHER = '/home/u/.opencompanion/opencompanion'
    try {
      await run(['service', 'install'])
    } finally {
      if (originalLauncher === undefined) delete process.env.OPENCOMPANION_ROOT_LAUNCHER
      else process.env.OPENCOMPANION_ROOT_LAUNCHER = originalLauncher
    }
    expect(installService).toHaveBeenCalledOnce()
    const program = installService.mock.calls[0]?.[0].program
    expect(program).toEqual(['/home/u/.opencompanion/opencompanion', 'serve'])
    expect(exitCode).toBe(0)
  })

  it('"service install" tolerates a deprecated --url by ignoring it with a notice', async () => {
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend({
      backendUrl: 'https://svc-url.example',
      deviceId: 'dsvcu'
    })
    await run(['service', 'install', '--url', 'https://svc-url.example'])
    expect(installService).toHaveBeenCalledOnce()
    expect(installService.mock.calls[0]?.[0].program).not.toContain('--url')
    expect(stdout).toContain('Ignoring --url')
    expect(exitCode).toBe(0)
  })

  it('"service install" refuses (never installs an unusable daemon) when nothing is paired', async () => {
    // A bare `serve` with nothing paired exits non-zero, and the OS would restart it into a crash
    // loop, so installing the boot service must require at least one pairing.
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-svc-unpaired-'))
    appDataOverride = solo
    await run(['service', 'install'])
    expect(installService).not.toHaveBeenCalled()
    expect(stderr).toContain('No backend paired')
    expect(exitCode).toBe(1)
    appDataOverride = APP_DATA
  })

  it('routes "service uninstall" to uninstallService', async () => {
    await run(['service', 'uninstall'])
    expect(uninstallService).toHaveBeenCalledOnce()
    expect(stdout).toContain('removed')
  })

  it('routes "service status" to serviceStatus', async () => {
    await run(['service', 'status'])
    expect(serviceStatus).toHaveBeenCalledOnce()
  })

  it('prints usage for an unknown service action', async () => {
    await run(['service', 'bogus'])
    expect(stderr).toContain('service <install|uninstall|status>')
    expect(exitCode).toBe(1)
  })

  it('"update --auto off" persists the auto-update toggle and exits 0', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-autoupd-'))
    appDataOverride = solo
    await run(['update', '--auto', 'off'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('off')
    // A fresh store re-reads the file, matching the daemon's per-call fresh read.
    const { createStateStore } = await import('../src/storage/state-store')
    expect(createStateStore({ cwd: solo }).getAutoUpdate()).toBe(false)
    // And it flips back on.
    await run(['update', '--auto', 'on'])
    expect(createStateStore({ cwd: solo }).getAutoUpdate()).toBe(true)
    appDataOverride = APP_DATA
  })

  it('"update --auto <bogus>" prints usage and exits 1', async () => {
    await run(['update', '--auto', 'sometimes'])
    expect(stderr).toContain('update --auto <on|off>')
    expect(exitCode).toBe(1)
  })

  it('"update --check" reports current, latest, and the auto-update flag for both states', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-updcheck-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: solo }).setAutoUpdate(false)
    checkLatest.mockResolvedValueOnce({ current: '1.2.3', latest: '1.2.4', updateAvailable: true })
    await run(['update', '--check'])
    expect(stdout).toContain('current: 1.2.3')
    expect(stdout).toContain('latest: 1.2.4')
    expect(stdout).toContain('auto-update: off')
    expect(exitCode).toBe(0)
    // Flipping the toggle on is reflected on the next check.
    stdout = ''
    createStateStore({ cwd: solo }).setAutoUpdate(true)
    checkLatest.mockResolvedValueOnce({ current: '1.2.3', latest: '1.2.4', updateAvailable: true })
    await run(['update', '--check'])
    expect(stdout).toContain('auto-update: on')
    appDataOverride = APP_DATA
  })

  it('"update" surfaces a post-stage flip failure as a clean error and exits non-zero', async () => {
    // The stage succeeds but the pointer flip throws (e.g. a read-only install root); the CLI must
    // print one clear line and exit non-zero rather than let the rejection escape to the top level.
    checkLatest.mockResolvedValueOnce({ current: '1.2.3', latest: '1.2.4', updateAvailable: true })
    stageVersion.mockResolvedValueOnce('/versions/1.2.4')
    flipCurrent.mockImplementationOnce(() => {
      throw new Error('current pointer is read-only')
    })
    await run(['update'])
    expect(stderr).toContain('Update failed')
    expect(stderr).toContain('current pointer is read-only')
    expect(stdout).not.toContain('Updated 1.2.3')
    expect(exitCode).toBe(1)
  })

  it('prints usage and exits non-zero on an unknown command', async () => {
    await run(['bogus'])
    expect(stderr).toContain('Usage: opencompanion')
    expect(exitCode).toBe(1)
  })

  it('"--help"/"-h"/"help" print the usage banner to stdout and exit 0', async () => {
    for (const verb of ['--help', '-h', 'help']) {
      exitCode = undefined
      stdout = ''
      stderr = ''
      await run([verb])
      expect(exitCode, verb).toBe(0)
      // Help goes to stdout (a success verb), NOT the error path.
      expect(stderr, verb).toBe('')
      expect(stdout, verb).toContain('Usage: opencompanion <command>')
      expect(stdout, verb).toContain('manage the always-on OS service')
    }
    // The --help banner is byte-identical to the usage the unknown-command path prints to stderr.
    exitCode = undefined
    stdout = ''
    stderr = ''
    await run(['--help'])
    const helpBanner = stdout
    exitCode = undefined
    stdout = ''
    stderr = ''
    await run(['definitely-not-a-command'])
    expect(helpBanner).toBe(stderr)
  })

  it('"--version"/"-v"/"version" print "<binary> <version>" to stdout and exit 0', async () => {
    // Task 4's staged-binary sanity-run parses exactly this shape, so it is a wire contract. Under
    // vitest no tsup define runs, so daemonVersion() reports the 0.0.0-dev fallback.
    for (const verb of ['--version', '-v', 'version']) {
      exitCode = undefined
      stdout = ''
      stderr = ''
      await run([verb])
      expect(exitCode, verb).toBe(0)
      expect(stderr, verb).toBe('')
      expect(stdout, verb).toBe('opencompanion 0.0.0-dev\n')
    }
  })

  it('routes "setup" to pair + connect + service install for a fresh backend', async () => {
    await run(['setup', '--url', 'https://setup-fresh.example'])
    expect(runPair).toHaveBeenCalledOnce()
    expect(runConnect).toHaveBeenCalledOnce()
    expect(installService).toHaveBeenCalledOnce()
    expect(stdout).toContain('Setup complete')
    expect(exitCode).toBe(0)
  })

  it('skips pairing in "setup" when the backend is already paired', async () => {
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend({
      backendUrl: 'https://setup-paired.example',
      deviceId: 'd2'
    })
    await run(['setup', '--url', 'https://setup-paired.example'])
    expect(runPair).not.toHaveBeenCalled()
    expect(runConnect).toHaveBeenCalledOnce()
    expect(installService).toHaveBeenCalledOnce()
    expect(exitCode).toBe(0)
  })

  it('aborts "setup" before installing the service when pairing fails', async () => {
    runPair.mockResolvedValueOnce({ ok: false })
    await run(['setup', '--url', 'https://setup-fail.example'])
    expect(runPair).toHaveBeenCalledOnce()
    expect(installService).not.toHaveBeenCalled()
    expect(exitCode).toBe(1)
  })

  it('"policy show" prints each backend ceiling, work root, and the invariants footer', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-polshow-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    const { backendKey } = await import('../src/backend-key')
    const url = 'https://ps.example'
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: url, deviceId: 'dps' })
    await run(['policy', 'show'])
    expect(stdout).toContain(url)
    expect(stdout).toContain('auto-edit') // the default permission ceiling
    expect(stdout).toContain(join('work', backendKey(url))) // the backendKey-derived work root
    expect(stdout).toContain('Ceilings only clamp down')
    expect(stdout).toContain('enforced by this daemon, not by any backend')
    appDataOverride = APP_DATA
  })

  it('"policy show --url" filters to the one named backend', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-polshowurl-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend({ backendUrl: 'https://a.example', deviceId: 'da' })
    state.upsertPairedBackend({ backendUrl: 'https://b.example', deviceId: 'db' })
    await run(['policy', 'show', '--url', 'https://b.example'])
    expect(stdout).toContain('https://b.example')
    expect(stdout).not.toContain('https://a.example')
    appDataOverride = APP_DATA
  })

  it('"policy set" clamps the ceiling, persists it, and audits a policy-change with from/to', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-polset-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    const url = 'https://p.example'
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: url, deviceId: 'dp' })
    await run(['policy', 'set', '--url', url, '--permission-mode', 'full'])
    expect(exitCode).toBe(0)
    // Persisted (a fresh store re-reads the file, matching the daemon's per-call fresh read). The
    // omitted --network keeps the full stock-parity default (network on).
    expect(createStateStore({ cwd: solo }).getPolicyCeiling(url)).toEqual({
      permissionMode: 'full',
      network: 'on'
    })
    // The new effective ceiling is printed back.
    expect(stdout).toContain('full')
    // Audited with the compact from/to strings (from = the full-capability default).
    const { createAuditLog } = await import('../src/audit-log')
    const { auditDir } = await import('../src/paths')
    const change = createAuditLog({ dir: auditDir(solo) })
      .read({ backendUrl: url })
      .find((e) => e.event === 'policy-change')
    expect(change?.detail?.from).toBe('{"permissionMode":"auto-edit","network":"on"}')
    expect(change?.detail?.to).toBe('{"permissionMode":"full","network":"on"}')
    appDataOverride = APP_DATA
  })

  it('"policy set" preserves the unspecified field (a network-only set keeps the permission mode)', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-polpartial-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    const url = 'https://partial.example'
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend({ backendUrl: url, deviceId: 'dpp' })
    state.setPolicyCeiling(url, { permissionMode: 'full', network: 'off' })
    await run(['policy', 'set', '--url', url, '--network', 'on'])
    expect(exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).getPolicyCeiling(url)).toEqual({
      permissionMode: 'full',
      network: 'on'
    })
    appDataOverride = APP_DATA
  })

  it('"policy set" rejects an invalid permission mode and writes nothing', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-polbadmode-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    const url = 'https://badmode.example'
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: url, deviceId: 'dbm' })
    await run(['policy', 'set', '--url', url, '--permission-mode', 'sudo'])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('Invalid --permission-mode')
    // Nothing written: a fresh read still returns the full stock-parity default.
    expect(createStateStore({ cwd: solo }).getPolicyCeiling(url)).toEqual({
      permissionMode: 'auto-edit',
      network: 'on'
    })
    appDataOverride = APP_DATA
  })

  it('"policy set" rejects an invalid network value', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-polbadnet-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    const url = 'https://badnet.example'
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: url, deviceId: 'dbn' })
    await run(['policy', 'set', '--url', url, '--network', 'maybe'])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('Invalid --network')
    appDataOverride = APP_DATA
  })

  it('"policy set" requires at least one of --permission-mode or --network', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-polnoflag-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    const url = 'https://noflag.example'
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: url, deviceId: 'dnf' })
    await run(['policy', 'set', '--url', url])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('at least one')
    appDataOverride = APP_DATA
  })

  it('"policy set" refuses a backend that is not paired', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-polunpaired-'))
    appDataOverride = solo
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: solo }).upsertPairedBackend({ backendUrl: 'https://paired.example', deviceId: 'dpr' })
    await run(['policy', 'set', '--url', 'https://unpaired.example', '--permission-mode', 'full'])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('Not paired')
    appDataOverride = APP_DATA
  })

  it('"policy" with an unknown subcommand prints the group usage', async () => {
    await run(['policy', 'bogus'])
    expect(stderr).toContain('policy <show|set>')
    expect(exitCode).toBe(1)
  })

  it('"log" pretty-prints the newest audit entries oldest-first, one line each', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-log-'))
    appDataOverride = solo
    const { createAuditLog } = await import('../src/audit-log')
    const { auditDir } = await import('../src/paths')
    const log = createAuditLog({ dir: auditDir(solo) })
    log.append({
      backendUrl: 'https://logbk.example',
      event: 'dispatched',
      runId: 'r1',
      productId: 'p1',
      toolId: 'claude-code'
    })
    log.append({
      backendUrl: 'https://logbk.example',
      event: 'completed',
      runId: 'r1',
      outcome: 'ok',
      durationMs: 1200
    })
    await run(['log'])
    expect(exitCode).toBeUndefined()
    expect(stdout).toContain('dispatched')
    expect(stdout).toContain('completed')
    expect(stdout).toContain('logbk.example')
    expect(stdout).toContain('r1')
    expect(stdout).toContain('claude-code')
    expect(stdout).toContain('1200ms')
    // The host is shown, not the full URL.
    expect(stdout).not.toContain('https://logbk.example')
    // Chronological: the dispatched line precedes its completed line.
    expect(stdout.indexOf('dispatched')).toBeLessThan(stdout.indexOf('completed'))
    appDataOverride = APP_DATA
  })

  it('"log --json" prints raw JSONL with no pretty decoration', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-logjson-'))
    appDataOverride = solo
    const { createAuditLog } = await import('../src/audit-log')
    const { auditDir } = await import('../src/paths')
    createAuditLog({ dir: auditDir(solo) }).append({
      backendUrl: 'https://j.example',
      event: 'dispatched',
      runId: 'r1',
      toolId: 'codex'
    })
    await run(['log', '--json'])
    expect(stdout).toContain('"event":"dispatched"')
    expect(stdout).toContain('"runId":"r1"')
    // Raw JSON only - none of the pretty labels.
    expect(stdout).not.toContain('tool codex')
    appDataOverride = APP_DATA
  })

  it('"log --json" on an empty log emits nothing (pipe-safe, exit 0)', async () => {
    // A never-used machine: `opencompanion log --json | jq .` must receive empty input, not the human
    // empty-state prose that would make jq choke.
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-logjsonempty-'))
    appDataOverride = solo
    await run(['log', '--json'])
    expect(exitCode).toBeUndefined()
    expect(stdout).toBe('')
    appDataOverride = APP_DATA
  })

  it('"log -n" limits to the newest N entries', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-logn-'))
    appDataOverride = solo
    const { createAuditLog } = await import('../src/audit-log')
    const { auditDir } = await import('../src/paths')
    const log = createAuditLog({ dir: auditDir(solo) })
    for (let i = 0; i < 5; i++) {
      log.append({ backendUrl: 'https://n.example', event: 'dispatched', runId: `run-${i}` })
    }
    await run(['log', '-n', '2'])
    // Only the newest two (run-3, run-4); the older ones are trimmed.
    expect(stdout).toContain('run-3')
    expect(stdout).toContain('run-4')
    expect(stdout).not.toContain('run-0')
    expect(stdout).not.toContain('run-1')
    expect(stdout).not.toContain('run-2')
    appDataOverride = APP_DATA
  })

  it('"log --url" filters to entries for that backend', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-logurl-'))
    appDataOverride = solo
    const { createAuditLog } = await import('../src/audit-log')
    const { auditDir } = await import('../src/paths')
    const log = createAuditLog({ dir: auditDir(solo) })
    log.append({ backendUrl: 'https://keep.example', event: 'pair' })
    log.append({ backendUrl: 'https://drop.example', event: 'pair' })
    await run(['log', '--url', 'https://keep.example'])
    expect(stdout).toContain('keep.example')
    expect(stdout).not.toContain('drop.example')
    appDataOverride = APP_DATA
  })

  it('"log -n <garbage>" exits 1 without printing entries', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-logbadn-'))
    appDataOverride = solo
    const { createAuditLog } = await import('../src/audit-log')
    const { auditDir } = await import('../src/paths')
    createAuditLog({ dir: auditDir(solo) }).append({ backendUrl: 'https://g.example', event: 'pair' })
    await run(['log', '-n', 'abc'])
    expect(exitCode).toBe(1)
    expect(stderr).toContain('Invalid -n')
    expect(stdout).not.toContain('g.example')
    appDataOverride = APP_DATA
  })

  it('"log -n 0" is rejected (a count must be a positive integer)', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-logzero-'))
    appDataOverride = solo
    const { createAuditLog } = await import('../src/audit-log')
    const { auditDir } = await import('../src/paths')
    createAuditLog({ dir: auditDir(solo) }).append({ backendUrl: 'https://z.example', event: 'pair' })
    await run(['log', '-n', '0'])
    expect(exitCode).toBe(1)
    expect(stderr).toContain('Invalid -n')
    appDataOverride = APP_DATA
  })

  it('"log" on a machine with no audit dir prints a friendly empty state and creates no dir', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'companion-cli-logempty-'))
    appDataOverride = solo
    const { auditDir } = await import('../src/paths')
    const dir = auditDir(solo)
    expect(existsSync(dir)).toBe(false)
    await run(['log'])
    expect(exitCode).toBeUndefined()
    // Names the audit dir and says runs will show up there.
    expect(stdout).toContain(dir)
    expect(stdout.toLowerCase()).toContain('will appear')
    // The read path must NOT create the audit dir.
    expect(existsSync(dir)).toBe(false)
    appDataOverride = APP_DATA
  })

  // Last: "uninstall" deletes the shared temp app-data dir.
  it('routes "uninstall" to service removal, drops pairings, and deletes data', async () => {
    const { createStateStore } = await import('../src/storage/state-store')
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend({
      backendUrl: 'https://uninstall.example',
      deviceId: 'd3'
    })
    await run(['uninstall'])
    expect(uninstallService).toHaveBeenCalledOnce()
    expect(runUnpair).toHaveBeenCalled()
    expect(stdout).toContain('uninstalled')
    expect(exitCode).toBe(0)
  })
})
