import type { AgentRuntimeRegistry } from '@opencompanion/core'
import { mkdirSync } from 'node:fs'
import { createAuditLog } from './audit-log'
import type { AuthHealthMonitor, AuthHealthMonitorDeps } from './auth-health'
import { createBackendSession, type BackendSession } from './backend-session'
import { BRAND } from './brand'
import { buildCompanionRegistry } from './connect'
import { acquireSingleInstanceLock, drainThenExit, installShutdownHandlers } from './lifecycle'
import { auditDir, managedCliDir } from './paths'
import type { HttpClient, UpdateState } from './poll-client'
import type { SecretStore } from './storage/secret-store'
import { createSessionSupervisor, type SessionSupervisor } from './supervisor'
import { createStateStore, type StateStore } from './storage/state-store'
import { startAutoUpdate, type AutoUpdateHandle } from './update/auto-update'
import type { UpdaterDeps } from './update/updater'

/** A running daemon: drains its sessions and lock on stop. */
export interface Daemon {
  /** Stops the daemon: drains every backend session (cancel runs, flush poll clients), releases the lock. Idempotent. */
  stop(): Promise<void>
}

/** Injected dependencies for {@link startDaemon} (real defaults; fakeable in tests). */
export interface ServeDeps {
  /** The app-data root (lock, work folders, managed CLIs, audit). */
  appDataRoot: string
  /** The non-secret state store (paired backends + per-CLI connections + ceilings). */
  state: StateStore
  /** The encrypted secret store (the Better Auth bearers). */
  secrets: SecretStore
  /** The HTTP client the poll clients use (injectable for tests; defaults to a `fetch` wrapper). */
  http?: HttpClient
  /** Liveness probe for the single-instance lock (defaults to `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean
  /** The companion build version (reported to the backend for presence). */
  version?: string
  /** This machine's host name (reported to each backend for presence so the app can label the device). */
  hostname?: string
  /** Returns the daemon's current self-update state each poll (a function so every poll reports fresh state). */
  updateState?: () => UpdateState
  /**
   * The updater IO seams + install root for the daemon's self-update loop. When provided, `serve` runs
   * the loop (check on start + every ~6h, stage while idle, apply on restart) and feeds its state into
   * presence; when omitted (tests, or a build with no versioned install) the daemon does not self-update.
   */
  updater?: UpdaterDeps
  /** Builds an auth-health monitor (injectable for tests; defaults to {@link import('./auth-health').createAuthHealthMonitor}). */
  makeAuthMonitor?: (deps: AuthHealthMonitorDeps) => AuthHealthMonitor
  /** The agent-runtime registry (injectable for tests; defaults to {@link buildCompanionRegistry}). */
  registry?: AgentRuntimeRegistry
  /** Sink for the concise startup/shutdown lines (defaults to `process.stdout.write`). */
  write?: (line: string) => void
  /** When set, serve ONLY this backend (the `serve --url` filter); otherwise serve EVERY paired backend. */
  filterUrl?: string
}

/** The URL's host for a legible multi-backend log prefix, falling back to the raw URL if unparseable. */
function hostOf(backendUrl: string): string {
  try {
    return new URL(backendUrl).host
  } catch {
    return backendUrl
  }
}

/**
 * Boots the companion daemon: acquires the single-instance lock (returns `null` if another live
 * instance holds it), builds the SHARED runtime registry + local audit log ONCE, then starts a
 * {@link SessionSupervisor} that runs one {@link BackendSession} per paired backend concurrently. Each
 * session PULLS its backend's dispatched runs (the poll doubles as its presence heartbeat) and PUSHES
 * their output over its own HTTP poll client; a UI-issued connect instruction is executed off that
 * session's poll loop. The supervisor reconciles the running set against `listPairedBackends()` on a
 * relaxed interval, so a backend paired or unpaired by a SEPARATE process is picked up (or dropped)
 * without restarting `serve`. `filterUrl` pins the daemon to one backend (the `serve --url` path).
 * Graceful shutdown drains every session (cancel runs -> flush poll client) then releases the lock.
 * State lives in `conf`; secrets in the encrypted file store; binaries resolve from validated dirs plus
 * the managed-CLI dirs; web tools are served over loopback MCP.
 *
 * @param deps - The app-data root, stores, optional http/version/registry overrides, and optional filter.
 * @returns The running daemon, or `null` when nothing is paired to serve or another instance holds the lock.
 */
export function startDaemon(deps: ServeDeps): Daemon | null {
  const write = deps.write ?? ((line): void => void process.stdout.write(line))
  // Read paired backends through a FRESH store each call: the supervisor re-reads to pick up a pairing
  // written by a separate `companion pair` process, and the sessions read connections/ceilings live.
  const readState = (): StateStore => createStateStore({ cwd: deps.appDataRoot })
  const listBackendUrls = (): string[] => readState().listPairedBackends().map((backend) => backend.backendUrl)

  // Pre-flight (before the lock): refuse to boot when there is nothing to serve - an unpaired filter,
  // or no paired backend at all - matching the single-backend refusal so cli.ts still gets a null.
  const initial =
    deps.filterUrl !== undefined
      ? listBackendUrls().includes(deps.filterUrl)
        ? [deps.filterUrl]
        : []
      : listBackendUrls()
  if (initial.length === 0) {
    write(
      deps.filterUrl !== undefined
        ? `Not paired with ${deps.filterUrl}. Run '${BRAND.binary} pair' first.\n`
        : `No backend paired. Run '${BRAND.binary} pair' first.\n`
    )
    return null
  }

  const lock = acquireSingleInstanceLock({
    dir: deps.appDataRoot,
    ...(deps.isAlive ? { isAlive: deps.isAlive } : {})
  })
  if (!lock) {
    write(`Another ${BRAND.binary} daemon is already running on this machine.\n`)
    return null
  }

  const managedDir = managedCliDir(deps.appDataRoot)
  const registry = deps.registry ?? buildCompanionRegistry(managedDir)

  // Establish the audit substrate ONCE at boot (shared by every session) so the first dispatched run of
  // any backend can be logged fail-closed. The log only mkdirs on append; creating the dir here makes
  // the substrate observable and surfaces an unwritable audit root at startup rather than on first run.
  const auditRoot = auditDir(deps.appDataRoot)
  mkdirSync(auditRoot, { recursive: true })
  const audit = createAuditLog({ dir: auditRoot })

  // Forward reference so a session's `write` can consult the LIVE session count: prefix each session's
  // lines with its backend host only while more than one backend is served (multi-backend legibility).
  // The supervisor is assigned before any session is made (reconcile runs after construction), so the
  // closure never sees an unassigned `supervisor`.
  let supervisor: SessionSupervisor
  // The daemon's self-update loop, when `deps.updater` is supplied. Assigned after the shutdown drain
  // exists (it needs it for `requestShutdown`); the closures below read it lazily, and any poll that
  // reads `updateState` runs asynchronously after `auto` is set, so it is never observed unassigned.
  let auto: AutoUpdateHandle | null = null
  const sessionWrite =
    (backendUrl: string) =>
    (line: string): void => {
      write(supervisor.running().length > 1 ? `[${hostOf(backendUrl)}] ${line}` : line)
    }

  // Each poll reports the CURRENT self-update state: an injected `updateState` (tests) wins, otherwise
  // the live loop supplies it (empty until the loop exists / has completed its first check).
  const updateState = (): UpdateState => (deps.updateState ? deps.updateState() : (auto?.state() ?? {}))

  const makeSession = (backendUrl: string): BackendSession | null =>
    createBackendSession({
      appDataRoot: deps.appDataRoot,
      backendUrl,
      registry,
      readState,
      secrets: deps.secrets,
      audit,
      ...(deps.http ? { http: deps.http } : {}),
      ...(deps.version !== undefined ? { version: deps.version } : {}),
      ...(deps.hostname !== undefined ? { hostname: deps.hostname } : {}),
      updateState,
      write: sessionWrite(backendUrl),
      ...(deps.makeAuthMonitor ? { makeAuthMonitor: deps.makeAuthMonitor } : {})
    })

  supervisor = createSessionSupervisor({
    listBackendUrls,
    makeSession,
    ...(deps.filterUrl !== undefined ? { filter: deps.filterUrl } : {}),
    write
  })
  supervisor.reconcile()

  // A `serve --url` whose one filtered backend could not start a session (its pairing is corrupt - no
  // stored bearer, so `createBackendSession` returned null after writing "Missing credentials") has
  // nothing to serve: fail fast (tear the supervisor down, release the lock, return null) so the CLI
  // exits 1, restoring the old single-backend contract. A bare serve-all keeps the supervisor's
  // retry-null resilience instead - a later reconcile picks the backend up once it is re-paired.
  if (deps.filterUrl !== undefined && supervisor.running().length === 0) {
    void supervisor.stop()
    lock.release()
    return null
  }

  const drain = installShutdownHandlers({
    // Each session cancels its OWN runs inside `session.stop()` (invoked by `supervisor.stop()`), in the
    // correct order (cancel -> flush), so the daemon-level cancel seam is a no-op here.
    cancelAll: () => undefined,
    closeRelay: async () => {
      // Stop the self-update loop first so no staged-apply fires mid-teardown, then drain the sessions.
      auto?.stop()
      await supervisor.stop()
    },
    releaseLock: () => lock.release()
  })

  // Start the self-update loop once the drain exists: it checks on boot and every ~6h, stages a newer
  // release in the background, and applies it (flip + restart) ONLY when no run is in flight - summing
  // the live per-session run count for idleness. Applying it exits the process cleanly; the boot
  // service (Restart=always / KeepAlive) relaunches the daemon, which then runs the flipped `current`.
  if (deps.updater) {
    auto = startAutoUpdate({
      updater: deps.updater,
      isIdle: () => supervisor.activeRunCount() === 0,
      autoUpdateEnabled: () => readState().getAutoUpdate(),
      // Same timeout-guarded drain-then-exit the SIGTERM path uses, so a black-holed final flush can
      // never wedge the daemon stopped-but-alive after an update flip (the boot service relaunches it).
      requestShutdown: () => drainThenExit(drain),
      log: write
    })
  }

  const served = supervisor.running()
  write(`${BRAND.binary} daemon running (backends: ${served.join(', ')}; device ${deps.state.getDeviceId()}).\n`)
  return { stop: drain }
}
