import { hostname } from 'node:os'
import { DEFAULT_CLIENT_ID } from '../backend-url'
import { BRAND } from '../brand'
import { buildCompanionRegistry, connectTool, type ConnectableToolId } from '../connect'
import { runPair } from '../pair'
import { appDataDir, managedCliDir } from '../paths'
import { startDaemon, type Daemon } from '../serve'
import { createStateStore, type StateStore } from '../storage/state-store'
import * as ui from '../ui'
import { daemonVersion } from '../version'
import { buildUpdaterDeps } from './update'
import { CLI_OPTIONS, flagValue, openStores } from './shared'

/**
 * For a foreground `serve` in a real terminal: when the paired backend has no connected coding CLI
 * yet, asks which CLI to connect (an arrow-key picker) and walks the user through that CLI's login
 * before the daemon starts - so a single `serve` goes pair -> connect -> run without pointing at a
 * second command. Skipped when stdin is not a TTY (a boot-started service is headless and is
 * connected by `setup`) or when a CLI is already connected. Never throws to the caller.
 *
 * @param appDataRoot - The app-data root (the managed-CLI base dir lives under it).
 * @param state - The state store (reads existing connections, records the new one).
 * @param backendUrl - The paired backend the connection is recorded under.
 */
async function ensureCliConnected(
  appDataRoot: string,
  state: StateStore,
  backendUrl: string
): Promise<void> {
  if (!process.stdin.isTTY) return
  if (state.listConnections(backendUrl).length > 0) return
  const choice = await ui.p.select<ConnectableToolId | 'skip'>({
    message: 'Connect a coding CLI now?',
    options: [...CLI_OPTIONS, { value: 'skip', label: 'Skip for now', hint: `run '${BRAND.binary} connect' later` }]
  })
  if (ui.p.isCancel(choice) || choice === 'skip') return
  const baseDir = managedCliDir(appDataRoot)
  await connectTool(choice, {
    registry: buildCompanionRegistry(baseDir),
    baseDir,
    state,
    backendUrl,
    write: ui.line
  })
}

/**
 * Boots the daemon and blocks until a signal drains it, or exits on a failed boot. The daemon installs
 * its own SIGINT/SIGTERM handlers (cancel runs -> close transport -> release lock -> exit), so this
 * resolves only on a failed boot. Under `--if-paired` (a dev/boot run) a failed boot exits 0 so the
 * rest of `pnpm dev` keeps running, where a bare `serve` exits 1.
 *
 * @param daemon - The booted daemon, or `null` when boot failed (the lock is held, or nothing to serve).
 * @param ifPaired - Whether this is the opportunistic `--if-paired` run.
 * @param label - What the success line reports the daemon is serving.
 */
async function blockUntilDrained(daemon: Daemon | null, ifPaired: boolean, label: string): Promise<void> {
  if (!daemon) {
    // startDaemon already wrote why it could not boot (another instance holds the lock, or nothing is
    // paired). Under `--if-paired` exit 0 so the rest of `pnpm dev` keeps running.
    if (ifPaired) return
    ui.p.cancel(`Could not start the ${BRAND.binary} daemon.`)
    process.exit(1)
    return
  }
  ui.p.log.success(`Running against ${ui.pc.cyan(label)}. Press Ctrl+C to stop.`)
  // Block forever: the daemon's shutdown handlers own the exit. A never-resolving promise keeps
  // the event loop alive (the poll + flush loops would anyway, but this is explicit).
  await new Promise<void>(() => {})
}

/**
 * Runs the `serve` command. With NO `--url` the one daemon serves EVERY paired backend concurrently
 * and hot-picks up a backend paired later (a separate `companion pair`), so there is nothing to resolve
 * or pair on demand - it just boots against the current pairing set. With `--url <backend>` it FILTERS
 * to that one backend, pairing it on demand via the RFC-8628 device-authorization flow when needed and
 * - in an interactive terminal with no CLI connected yet - offering to connect a coding CLI (see
 * {@link ensureCliConnected}); this is how the boot service pins a backend and how a fresh machine goes
 * unpaired -> running in one command.
 *
 * `--if-paired` makes `serve` a quiet no-op on an unpaired machine: this is how `pnpm dev` runs the
 * daemon alongside the app. When no backend is paired (or the `--url` filter is unpaired) it prints one
 * hint and exits 0 - never opening the encrypted secret store or dropping into device pairing - and a
 * failed boot also exits 0 rather than non-zero, so a companion that cannot run never fails `pnpm dev`.
 */
export async function cmdServe(argv: string[]): Promise<void> {
  const ifPaired = argv.includes('--if-paired')
  const explicitUrl = flagValue(argv, '--url')
  const idleHint =
    `${BRAND.name} idle: no backend paired. Run '${BRAND.binary} pair' (or '${BRAND.binary} setup') to start the daemon.`
  const pairingState = createStateStore({ cwd: appDataDir() })
  // Reported to each backend for presence so the app can label the device by its machine name. Trim +
  // cap to the backend's 253-char limit so a long/padded hostname can never fail the connect schema.
  const machineName = hostname().trim().slice(0, 253)

  // No --url: serve EVERY paired backend (the supervisor reconciles against the live pairing set), so
  // there is nothing to resolve or pair on demand here. Idle (--if-paired) or guide when nothing is
  // paired yet - a bare `serve` needs a --url to pair against, since pairing DEFINES a backend URL.
  if (explicitUrl === undefined) {
    if (pairingState.listPairedBackends().length === 0) {
      if (ifPaired) {
        ui.line(idleHint)
        return
      }
      ui.p.cancel(`No backend paired. Run '${BRAND.binary} pair --url <backend>', or 'serve --url <backend>' to pair on demand.`)
      process.exit(1)
      return
    }
    ui.intro()
    const { appDataRoot, state, secrets } = openStores()
    await blockUntilDrained(
      startDaemon({
        appDataRoot,
        state,
        secrets,
        version: daemonVersion(),
        updater: buildUpdaterDeps(ui.line),
        ...(machineName ? { hostname: machineName } : {}),
        write: ui.line
      }),
      ifPaired,
      'all paired backends'
    )
    return
  }

  // --url <backend>: filter to that one backend, pairing + connecting it on demand.
  if (ifPaired && !pairingState.getPairedBackend(explicitUrl)) {
    ui.line(idleHint)
    return
  }
  ui.intro()
  const { appDataRoot, state, secrets } = openStores()
  if (!state.getPairedBackend(explicitUrl)) {
    const clientId = flagValue(argv, '--client-id') ?? DEFAULT_CLIENT_ID
    const { ok } = await runPair({ backendUrl: explicitUrl, clientId }, { state, secrets, write: ui.line })
    if (!ok) {
      ui.p.cancel('Pairing failed.')
      process.exit(1)
      return
    }
  }
  await ensureCliConnected(appDataRoot, state, explicitUrl)
  await blockUntilDrained(
    startDaemon({
      appDataRoot,
      filterUrl: explicitUrl,
      state,
      secrets,
      version: daemonVersion(),
      updater: buildUpdaterDeps(ui.line),
      ...(machineName ? { hostname: machineName } : {}),
      write: ui.line
    }),
    ifPaired,
    explicitUrl
  )
}
