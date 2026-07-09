import { BRAND } from '../brand'
import {
  buildCompanionRegistry,
  connectTool,
  isConnectableToolId,
  runConnect,
  CONNECTABLE_TOOL_IDS,
  type ConnectableToolId,
  type ConnectDeps
} from '../connect'
import { managedCliDir } from '../paths'
import * as ui from '../ui'
import { CLI_OPTIONS, openStores, positionalArg, resolveCommandBackend } from './shared'

/**
 * Connects coding CLIs with a detection-first flow: every CLI that is already installed and signed
 * in is reused automatically; the remaining ones are only OFFERED - an optional multiselect in a
 * real terminal (each chosen CLI is installed and walked through its own interactive vendor login),
 * a one-line hint headlessly. Nothing is ever installed unasked, so a user with a single
 * subscription never gets the other two CLIs force-installed.
 *
 * @param deps - The connect dependencies (registry, base dir, state store, backend URL, sink).
 * @returns How many CLIs ended up connected and whether any CHOSEN CLI failed to connect.
 */
export async function connectCliInteractively(deps: ConnectDeps): Promise<{ ok: boolean; connected: number }> {
  const detection = await runConnect({ ...deps, install: false })
  const reused = new Set(detection.filter((o) => o.kind === 'reused').map((o) => o.toolId))
  const remaining = CLI_OPTIONS.filter((opt) => !reused.has(opt.value))
  if (remaining.length === 0) return { ok: true, connected: reused.size }
  if (!process.stdin.isTTY) {
    ui.line(`Set up more CLIs any time with '${BRAND.binary} connect <${remaining.map((o) => o.value).join('|')}>'.`)
    return { ok: true, connected: reused.size }
  }
  const chosen = await ui.p.multiselect<ConnectableToolId>({
    message: 'Set up more coding CLIs? (optional - space selects, enter continues)',
    options: remaining.map((opt) => ({ value: opt.value, label: opt.label })),
    required: false
  })
  if (ui.p.isCancel(chosen)) return { ok: true, connected: reused.size }
  let ok = true
  let connected = reused.size
  for (const toolId of chosen) {
    const outcome = await connectTool(toolId, deps)
    if (outcome.kind === 'failed') ok = false
    else connected++
  }
  return { ok, connected }
}

/** Runs the `connect` command and exits with the appropriate code. */
export async function cmdConnect(argv: string[]): Promise<void> {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const backendUrl = await resolveCommandBackend(argv, state)
  if (backendUrl === undefined) return
  if (!state.getPairedBackend(backendUrl)) {
    ui.p.cancel(`Not paired with ${backendUrl}. Run '${BRAND.binary} pair' first.`)
    process.exit(1)
    return
  }
  const baseDir = managedCliDir(appDataRoot)
  const deps: ConnectDeps = {
    registry: buildCompanionRegistry(baseDir),
    baseDir,
    state,
    backendUrl,
    write: ui.line
  }
  const only = positionalArg(argv)
  if (only !== undefined) {
    // An explicit tool id is a direct ask: install + login that one CLI. An unknown `only` tool makes
    // `runConnect` reject it and return NO outcomes; treat that (and any outcome marked `failed`) as a
    // failure so `companion connect not-a-cli` exits non-zero rather than printing success.
    const outcomes = await runConnect(deps, only)
    const failed = outcomes.length === 0 || outcomes.some((o) => o.kind === 'failed')
    if (failed) ui.p.cancel('Some coding CLIs could not be connected.')
    else ui.outro('Coding CLIs connected.')
    process.exit(failed ? 1 : 0)
    return
  }
  const { ok, connected } = await connectCliInteractively(deps)
  if (!ok) {
    ui.p.cancel('Some coding CLIs could not be connected.')
    process.exit(1)
    return
  }
  ui.outro(connected > 0 ? 'Coding CLIs connected.' : 'No coding CLIs connected yet.')
  process.exit(0)
}

/**
 * Runs the `disconnect <tool>` command: stops the companion driving one coding CLI by removing its
 * per-backend connection record, WITHOUT uninstalling or logging the CLI out (it stays installed and
 * signed in - only the companion stops using it). The running daemon reads connections fresh, so the
 * removal takes effect within one poll: it drops from `GET /devices` and the web offers the CLI as
 * "Connect" again. Requires the backend to be paired and a valid tool id. Exits with the right code.
 *
 * @param argv - The process arguments (the tool id is the positional; `--url` selects the backend).
 */
export async function cmdDisconnect(argv: string[]): Promise<void> {
  ui.intro()
  const { state } = openStores()
  const backendUrl = await resolveCommandBackend(argv, state)
  if (backendUrl === undefined) return
  if (!state.getPairedBackend(backendUrl)) {
    ui.p.cancel(`Not paired with ${backendUrl}. Run '${BRAND.binary} pair' first.`)
    process.exit(1)
    return
  }
  const toolId = positionalArg(argv)
  if (!toolId || !isConnectableToolId(toolId)) {
    ui.p.cancel(`Choose a CLI to disconnect: ${CONNECTABLE_TOOL_IDS.join(', ')}.`)
    process.exit(1)
    return
  }
  const removed = state.removeConnection(backendUrl, toolId)
  if (removed) ui.outro(`Disconnected ${toolId}. It stays installed and signed in.`)
  else ui.p.cancel(`${toolId} was not connected on ${backendUrl}.`)
  process.exit(removed ? 0 : 1)
}
