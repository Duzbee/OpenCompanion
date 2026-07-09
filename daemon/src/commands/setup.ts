import { rmSync } from 'node:fs'
import { DEFAULT_CLIENT_ID, resolveBackendUrl } from '../backend-url'
import { BRAND } from '../brand'
import { buildCompanionRegistry } from '../connect'
import { runPair, runUnpair } from '../pair'
import { managedCliDir } from '../paths'
import { installService, uninstallService } from '../service'
import * as ui from '../ui'
import { connectCliInteractively } from './connect'
import { buildServiceSpec } from './service'
import { flagValue, openStores, selectBackendUrl } from './shared'

/**
 * Runs the one-shot `setup`: pair with the backend (skipping pairing when already paired), connect
 * the user's coding CLIs, then install the always-on OS service. This is the single command an
 * installer chains, so a fresh machine goes from nothing to a running, paired, boot-starting
 * companion in one step. Connect failures are non-fatal (the user can `opencompanion connect` more
 * later); a failed pairing aborts before the service is installed.
 */
export async function cmdSetup(argv: string[]): Promise<void> {
  ui.intro()
  const { appDataRoot, state, secrets } = openStores()
  let backendUrl: string
  try {
    backendUrl = await resolveBackendUrl(flagValue(argv, '--url'), state, {
      interactive: process.stdin.isTTY === true,
      prompt: selectBackendUrl
    })
  } catch (err) {
    ui.p.cancel(err instanceof Error ? err.message : String(err))
    process.exit(1)
    return
  }

  if (state.getPairedBackend(backendUrl)) {
    ui.line(`Already paired with ${backendUrl}.`)
  } else {
    const clientId = flagValue(argv, '--client-id') ?? DEFAULT_CLIENT_ID
    const { ok } = await runPair({ backendUrl, clientId }, { state, secrets, write: ui.line })
    if (!ok) {
      ui.p.cancel('Pairing failed.')
      process.exit(1)
      return
    }
  }

  const baseDir = managedCliDir(appDataRoot)
  const { connected } = await connectCliInteractively({
    registry: buildCompanionRegistry(baseDir),
    baseDir,
    state,
    backendUrl,
    write: ui.line
  })

  const { message } = installService(buildServiceSpec(appDataRoot))
  ui.line(message)
  ui.outro(
    connected > 0
      ? `Setup complete. ${BRAND.name} is running and will start on boot.`
      : `Setup complete. Connect a coding CLI with '${BRAND.binary} connect' to start running tasks.`
  )
  process.exit(0)
}

/**
 * Runs `uninstall`: stop + remove the OS service, drop every backend pairing (revoking the stored
 * bearer locally), and delete the companion's app-data directory (state, secrets, managed CLIs). A
 * clean, single-command removal that leaves nothing behind. Idempotent: safe to run when nothing is
 * installed.
 */
export function cmdUninstall(): void {
  ui.intro()
  const { appDataRoot, state, secrets } = openStores()
  const { message } = uninstallService()
  ui.line(message)
  for (const backend of state.listPairedBackends()) {
    runUnpair(backend.backendUrl, { state, secrets, write: ui.line })
  }
  rmSync(appDataRoot, { recursive: true, force: true })
  ui.outro(`${BRAND.name} uninstalled: service removed, pairings dropped, data deleted.`)
  process.exit(0)
}
