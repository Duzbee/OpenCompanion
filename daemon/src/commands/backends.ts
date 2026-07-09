import { BRAND } from '../brand'
import { isDaemonRunning } from '../lifecycle'
import * as ui from '../ui'
import { openStores } from './shared'

/** Runs the `status` command: prints pairing + per-CLI connection state (non-secret only). */
export function cmdStatus(): void {
  ui.intro()
  const { state } = openStores()
  const backends = state.listPairedBackends()
  if (backends.length === 0) {
    ui.p.log.warn(`No backends paired. Run '${BRAND.binary} pair' to get started.`)
    ui.outro('Nothing paired yet.')
    return
  }
  ui.p.log.info(`Device id: ${ui.pc.dim(state.getDeviceId())}`)
  for (const backend of backends) {
    const connections = state.listConnections(backend.backendUrl)
    const body =
      connections.length === 0
        ? `No CLIs connected. Run '${BRAND.binary} connect'.`
        : connections.map((c) => `${c.toolId}: ${c.source}, auth ${c.authHealth}`).join('\n')
    ui.p.note(body, backend.backendUrl)
  }
  ui.outro(`${BRAND.name} status.`)
}

/**
 * Runs the `backends` command: one boxed summary per paired backend - its device id, how many coding
 * CLIs are connected, the capability ceiling that clamps its runs, and whether a live daemon currently
 * holds the single-instance lock. The daemon state is a machine-global property (one daemon per
 * machine), probed once and shown against each pairing. On an empty pairing set it prints the pair
 * hint. The daemon lock is read-only-probed, so this status check never disturbs a running daemon.
 */
export function cmdBackends(): void {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const backends = state.listPairedBackends()
  if (backends.length === 0) {
    ui.p.log.warn(`No backends paired. Run '${BRAND.binary} pair' to get started.`)
    ui.outro('Nothing paired yet.')
    return
  }
  const daemonRunning = isDaemonRunning({ dir: appDataRoot })
  for (const backend of backends) {
    const ceiling = state.getPolicyCeiling(backend.backendUrl)
    const body = [
      `device id: ${backend.deviceId}`,
      `connected CLIs: ${state.listConnections(backend.backendUrl).length}`,
      `ceiling: ${ceiling.permissionMode}, network ${ceiling.network}`,
      `daemon running: ${daemonRunning ? 'yes' : 'no'}`
    ].join('\n')
    ui.p.note(body, backend.backendUrl)
  }
  ui.outro(`${BRAND.name} backends.`)
}
