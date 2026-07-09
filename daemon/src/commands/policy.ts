import { join } from 'node:path'
import {
  PermissionModeSchema,
  RunPolicySchema,
  type PermissionMode,
  type RunPolicy
} from '@opencompanion/protocol'
import { backendKey } from '../backend-key'
import { BRAND } from '../brand'
import { auditLifecycle } from '../pair'
import { workRoot } from '../paths'
import * as ui from '../ui'
import { flagValue, openAuditLog, openStores, positionalArg, resolveCommandBackend } from './shared'

/**
 * The fixed footer `policy show` prints under every backend. Verbatim and load-bearing: it is the
 * user's assurance that a paired backend can only ever LOWER what its runs may do, never raise it, and
 * that confinement + MCP-stripping are enforced locally by this daemon rather than trusted to any
 * backend.
 */
const POLICY_INVARIANTS =
  'Ceilings only clamp down - a backend can never raise them. Runs are confined to the work folder shown; backend-pushed MCP servers are dropped; these rules are enforced by this daemon, not by any backend.'

/**
 * Runs `policy show [--url <backend>]`: prints, per paired backend, the capability ceiling that clamps
 * its runs (permission mode + network), the confined work root those runs are pinned to
 * (`work/<backendKey>`), and the fixed {@link POLICY_INVARIANTS} footer. With `--url` it filters to
 * that one backend; without, it lists every pairing. Read-only - it never mutates state. On an empty
 * pairing set it prints the pair hint; on an unpaired `--url` it refuses and exits non-zero.
 *
 * @param argv - The process arguments (`--url` optionally filters to one backend).
 */
function cmdPolicyShow(argv: string[]): void {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const explicitUrl = flagValue(argv, '--url')
  const backends = state
    .listPairedBackends()
    .filter((backend) => explicitUrl === undefined || backend.backendUrl === explicitUrl)
  if (backends.length === 0) {
    if (explicitUrl !== undefined) {
      ui.p.cancel(`Not paired with ${explicitUrl}. Run '${BRAND.binary} backends' to list paired backends.`)
      process.exit(1)
      return
    }
    ui.p.log.warn(`No backends paired. Run '${BRAND.binary} pair' to get started.`)
    ui.outro('Nothing paired yet.')
    return
  }
  for (const backend of backends) {
    const ceiling = state.getPolicyCeiling(backend.backendUrl)
    const workDir = join(workRoot(appDataRoot), backendKey(backend.backendUrl))
    const body = [
      `permission ceiling: ${ceiling.permissionMode}`,
      `network: ${ceiling.network}`,
      `work root: ${workDir}`,
      '',
      POLICY_INVARIANTS
    ].join('\n')
    ui.p.note(body, backend.backendUrl)
  }
  ui.outro(`${BRAND.name} policy.`)
}

/**
 * Runs `policy set --url <backend> [--permission-mode <m>] [--network <on|off>]`: clamps a paired
 * backend's capability ceiling. At least one of the two fields must be given; an omitted field keeps
 * its current value (read-modify-write off {@link StateStore.getPolicyCeiling}). The permission mode is
 * validated with `PermissionModeSchema` and the network with `RunPolicySchema`'s network enum; the
 * backend must be paired. On success the new ceiling is persisted (a running daemon picks it up on its
 * next fresh read - no signal needed), a best-effort `policy-change` audit entry records the old/new
 * pair as JSON-compact strings, and the new effective ceiling is printed.
 *
 * @param argv - The process arguments (`--url` selects the backend; `--permission-mode`/`--network` set fields).
 */
async function cmdPolicySet(argv: string[]): Promise<void> {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const backendUrl = await resolveCommandBackend(argv, state)
  if (backendUrl === undefined) return
  if (!state.getPairedBackend(backendUrl)) {
    ui.p.cancel(`Not paired with ${backendUrl}. Run '${BRAND.binary} pair' first.`)
    process.exit(1)
    return
  }
  const modeFlag = flagValue(argv, '--permission-mode')
  const networkFlag = flagValue(argv, '--network')
  if (modeFlag === undefined && networkFlag === undefined) {
    ui.p.cancel('Set at least one of --permission-mode <read-only|auto-edit|full> or --network <on|off>.')
    process.exit(1)
    return
  }
  let permissionMode: PermissionMode | undefined
  if (modeFlag !== undefined) {
    const parsed = PermissionModeSchema.safeParse(modeFlag)
    if (!parsed.success) {
      ui.p.cancel(`Invalid --permission-mode "${modeFlag}". Use read-only, auto-edit, or full.`)
      process.exit(1)
      return
    }
    permissionMode = parsed.data
  }
  let network: RunPolicy['network'] | undefined
  if (networkFlag !== undefined) {
    const parsed = RunPolicySchema.shape.network.safeParse(networkFlag)
    if (!parsed.success) {
      ui.p.cancel(`Invalid --network "${networkFlag}". Use on or off.`)
      process.exit(1)
      return
    }
    network = parsed.data
  }
  const current = state.getPolicyCeiling(backendUrl)
  const next: RunPolicy = {
    permissionMode: permissionMode ?? current.permissionMode,
    network: network ?? current.network
  }
  state.setPolicyCeiling(backendUrl, next)
  auditLifecycle(
    openAuditLog(appDataRoot),
    {
      backendUrl,
      event: 'policy-change',
      detail: { from: JSON.stringify(current), to: JSON.stringify(next) }
    },
    ui.line
  )
  ui.outro(`Ceiling for ${backendUrl}: ${next.permissionMode}, network ${next.network}.`)
  process.exit(0)
}

/**
 * Runs the `policy <show|set>` command group, dispatching on the subcommand positional. An unknown or
 * missing subcommand prints the group usage and exits non-zero.
 *
 * @param argv - The process arguments (`argv[0]` is `"policy"`, `argv[1]` the subcommand).
 */
export async function cmdPolicy(argv: string[]): Promise<void> {
  const action = positionalArg(argv)
  if (action === 'show') {
    cmdPolicyShow(argv)
    return
  }
  if (action === 'set') {
    await cmdPolicySet(argv)
    return
  }
  process.stderr.write(`Usage: ${BRAND.binary} policy <show|set>\n`)
  process.exit(1)
}
