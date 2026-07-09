import { DEFAULT_CLIENT_ID, resolveBackendUrl } from '../backend-url'
import { BRAND } from '../brand'
import { runPair, runUnpair } from '../pair'
import * as ui from '../ui'
import { flagValue, openAuditLog, openStores, selectBackendUrl } from './shared'

/** Runs the `pair` command and exits with the appropriate code. */
export async function cmdPair(argv: string[]): Promise<void> {
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
  const clientId = flagValue(argv, '--client-id') ?? DEFAULT_CLIENT_ID
  const { ok } = await runPair(
    { backendUrl, clientId },
    { state, secrets, audit: openAuditLog(appDataRoot), write: ui.line }
  )
  if (ok) ui.outro(`Paired with ${backendUrl}.`)
  else ui.p.cancel('Pairing failed.')
  process.exit(ok ? 0 : 1)
}

/** Runs the `unpair` command and exits with the appropriate code. */
export async function cmdUnpair(argv: string[]): Promise<void> {
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
  const { ok } = runUnpair(backendUrl, { state, secrets, audit: openAuditLog(appDataRoot), write: ui.line })
  if (ok) {
    // The removal is picked up by a running daemon's supervisor on its next reconcile - no signal
    // needed - so the daemon stops serving this backend within one reconcile interval.
    ui.p.log.info('A running daemon stops serving it within ~15s.')
    ui.outro(`Unpaired from ${backendUrl}.`)
  } else {
    ui.p.cancel(`Not paired with ${backendUrl}. Run '${BRAND.binary} backends' to list paired backends.`)
  }
  process.exit(ok ? 0 : 1)
}
