import { randomUUID } from 'node:crypto'
import Conf from 'conf'
import type { AuthHealth, RunPolicy } from '@opencompanion/protocol'

/**
 * A paired backend's durable record (the Better Auth bearer lives in the SecretStore, never
 * here). One record per buyer backend the companion has paired with via the device-
 * authorization grant; the `backendUrl` is both the key and the base the poll client polls.
 */
export interface PairedBackend {
  /** The buyer backend base URL the companion paired with (the record key). */
  backendUrl: string
  /** This install's stable device id (generated once, reused on re-pair). */
  deviceId: string
  /** The server-decided companion/room id, when the backend returned one at pairing. */
  companionId?: string
}

/** A connected coding CLI's durable record (per backend), recording reuse and last auth-health. */
export interface CliConnection {
  /** The adapter/tool id (a connectable CLI id, e.g. `claude-code`). */
  toolId: string
  /** Whether the CLI was reused as-is or installed/logged-in by the companion. */
  source: 'reused' | 'installed'
  /** The last observed CLI auth-health from the connect probe. */
  authHealth: AuthHealth
}

/** The on-disk document shape (one blob, document-shaped, tiny). */
interface StateSchema {
  /** The stable per-install device id (generated once, reused on re-pair). */
  deviceId: string
  /** Paired backends keyed by `backendUrl`. */
  backends: Record<string, PairedBackend>
  /** Per-backend CLI connections, keyed `backendUrl -> toolId -> record`. */
  connections: Record<string, Record<string, CliConnection>>
  /** Per-backend capability ceiling (the unattended default when unset). */
  policyCeilings: Record<string, RunPolicy>
  /** Whether the daemon self-updates to the latest release (on by default). */
  autoUpdate: boolean
}

/**
 * The default ceiling when a backend has no explicit policy: FULL stock-parity capability. The CLI runs
 * inside its confined work folder exactly as it would if the user ran it in a terminal themselves, and
 * the user clamps DOWN per backend with `opencompanion policy set` whenever they want less - the daemon
 * only ever lowers a run, never raises it.
 *
 * `network: 'on'` because a coding CLI is normally online (it installs packages, reads docs, reaches its
 * provider); defaulting egress off would silently break stock behaviour for every run that did not
 * explicitly ask to be air-gapped. A user who wants an air-gapped backend clamps it with `--network off`.
 *
 * `auto-edit` (not `read-only`): the executor floors a dispatched run up to `auto-edit` and treats a
 * `read-only` ceiling as an EXPLICIT builder opt-in that suppresses that floor, so defaulting to
 * `read-only` would silently make every run read-only. Work-folder confinement stays always-on by
 * construction (the cwd IS the per-product work folder), independent of this ceiling.
 */
const DEFAULT_CEILING: RunPolicy = { permissionMode: 'auto-edit', network: 'on' }

/** The companion's non-secret persistent state (paired backends and their config). */
export interface StateStore {
  /**
   * Returns this install's stable device id, generating and persisting one on first read so
   * every re-pair reuses the same id (the device-authorization flow binds to it).
   */
  getDeviceId(): string
  /** Returns the paired backend, or `null`. */
  getPairedBackend(backendUrl: string): PairedBackend | null
  /** Inserts or updates a paired backend. */
  upsertPairedBackend(rec: PairedBackend): void
  /** Returns every paired backend. */
  listPairedBackends(): PairedBackend[]
  /** Removes a paired backend record and ALL its derived state (no-op when absent). */
  removePairedBackend(backendUrl: string): void
  /** Returns a backend's CLI connection by tool id, or `null`. */
  getConnection(backendUrl: string, toolId: string): CliConnection | null
  /** Returns every CLI connection configured under a backend (empty when none). */
  listConnections(backendUrl: string): CliConnection[]
  /** Inserts or updates a CLI connection under a backend. */
  upsertConnection(backendUrl: string, conn: CliConnection): void
  /** Removes a backend's CLI connection by tool id (no-op when absent). Returns whether one was removed. */
  removeConnection(backendUrl: string, toolId: string): boolean
  /** Returns the policy ceiling for a backend (the unattended default when unset). */
  getPolicyCeiling(backendUrl: string): RunPolicy
  /**
   * Sets a backend's capability ceiling. A ceiling only exists for a paired backend, so this throws
   * when the backend is not paired (the CLI guards this first and surfaces a friendly message). A live
   * daemon needs no signal - its executor reads ceilings through fresh stores, so the next dispatched
   * run picks the new ceiling up.
   *
   * @param backendUrl - The paired backend the ceiling applies to.
   * @param policy - The new capability ceiling.
   * @throws When the backend is not paired.
   */
  setPolicyCeiling(backendUrl: string, policy: RunPolicy): void
  /** Whether the daemon self-updates to the latest release. Defaults to `true` when never set. */
  getAutoUpdate(): boolean
  /** Turns daemon self-update on or off. */
  setAutoUpdate(value: boolean): void
}

/** Options for {@link createStateStore}. */
export interface StateStoreOpts {
  /** The directory the `conf` file lives in (the app-data root). */
  cwd: string
  /** The config file base name (defaults to `opencompanion-state`). */
  name?: string
}

/**
 * Creates the `conf`-backed {@link StateStore}. `conf` gives atomic writes and a typed
 * schema with zero native build, which survives the vendored-Node packaging cleanly (no
 * experimental flag). Secrets are deliberately NOT stored here - the Better Auth bearer
 * lives in the {@link import('./secret-store').SecretStore}.
 *
 * @param opts - The directory and optional file name.
 * @returns The state store.
 */
export function createStateStore(opts: StateStoreOpts): StateStore {
  const conf = new Conf<StateSchema>({
    cwd: opts.cwd,
    configName: opts.name ?? 'opencompanion-state',
    defaults: {
      deviceId: '',
      backends: {},
      connections: {},
      policyCeilings: {},
      autoUpdate: true
    }
  })

  return {
    getDeviceId() {
      const existing = conf.get('deviceId')
      if (existing) return existing
      const deviceId = randomUUID()
      conf.set('deviceId', deviceId)
      return deviceId
    },
    getPairedBackend(backendUrl) {
      return conf.get('backends')[backendUrl] ?? null
    },
    upsertPairedBackend(rec) {
      conf.set('backends', { ...conf.get('backends'), [rec.backendUrl]: rec })
    },
    listPairedBackends() {
      return Object.values(conf.get('backends'))
    },
    removePairedBackend(backendUrl) {
      for (const field of ['backends', 'connections', 'policyCeilings'] as const) {
        const all = { ...conf.get(field) }
        delete all[backendUrl]
        conf.set(field, all)
      }
    },
    getConnection(backendUrl, toolId) {
      return conf.get('connections')[backendUrl]?.[toolId] ?? null
    },
    listConnections(backendUrl) {
      return Object.values(conf.get('connections')[backendUrl] ?? {})
    },
    upsertConnection(backendUrl, conn) {
      const all = conf.get('connections')
      const forBackend = { ...(all[backendUrl] ?? {}), [conn.toolId]: conn }
      conf.set('connections', { ...all, [backendUrl]: forBackend })
    },
    removeConnection(backendUrl, toolId) {
      const all = conf.get('connections')
      const forBackend = all[backendUrl]
      if (!forBackend || !(toolId in forBackend)) return false
      const { [toolId]: _removed, ...rest } = forBackend
      conf.set('connections', { ...all, [backendUrl]: rest })
      return true
    },
    getPolicyCeiling(backendUrl) {
      return conf.get('policyCeilings')[backendUrl] ?? DEFAULT_CEILING
    },
    setPolicyCeiling(backendUrl, policy) {
      if (!conf.get('backends')[backendUrl]) {
        throw new Error(`Cannot set a policy ceiling for an unpaired backend: ${backendUrl}`)
      }
      conf.set('policyCeilings', { ...conf.get('policyCeilings'), [backendUrl]: policy })
    },
    getAutoUpdate() {
      return conf.get('autoUpdate')
    },
    setAutoUpdate(value) {
      conf.set('autoUpdate', value)
    }
  }
}
