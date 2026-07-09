import { createAuditLog, type AuditLog } from '../audit-log'
import { resolveBackendUrl } from '../backend-url'
import { type ConnectableToolId } from '../connect'
import { makeMasterKey } from '../master-key'
import { appDataDir, auditDir, secretsDir } from '../paths'
import { createFileSecretStore } from '../storage/secret-store'
import { createStateStore, type StateStore } from '../storage/state-store'
import * as ui from '../ui'

/** The connectable CLIs shown in the interactive picker, with friendly labels (one per connectable tool id). */
export const CLI_OPTIONS: { value: ConnectableToolId; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'hermes', label: 'Hermes Agent' }
]

/**
 * Reads the value following a `--flag` token in argv, or `undefined` when absent.
 *
 * @param argv - The process arguments.
 * @param flag - The flag name (e.g. `"--url"`).
 * @returns The flag's value, or `undefined`.
 */
export function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  return argv[index + 1]
}

/**
 * Returns the first positional argument after the command (the sub-target, e.g. the connect
 * tool id), skipping the command token, any `--flag`, and any value that immediately follows a
 * `--flag`. Returns `undefined` when there is no positional sub-target.
 *
 * @param argv - The process arguments (the command is `argv[0]`).
 * @returns The positional sub-target, or `undefined`.
 */
export function positionalArg(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (token === undefined) continue
    if (token.startsWith('--')) {
      i++
      continue
    }
    return token
  }
  return undefined
}

/** Builds the state + secret stores rooted at `appDataRoot`. */
export function buildStores(appDataRoot: string): {
  appDataRoot: string
  state: ReturnType<typeof createStateStore>
  secrets: ReturnType<typeof createFileSecretStore>
} {
  const dir = secretsDir(appDataRoot)
  return {
    appDataRoot,
    state: createStateStore({ cwd: appDataRoot }),
    secrets: createFileSecretStore({ dir, masterKey: makeMasterKey(dir) })
  }
}

/** The resolved app-data root + the two stores + the secret-store master key. */
export function openStores(): ReturnType<typeof buildStores> {
  return buildStores(appDataDir())
}

/** Opens the local audit log so the CLI can append pairing-lifecycle events beside the daemon's. */
export function openAuditLog(appDataRoot: string): AuditLog {
  return createAuditLog({ dir: auditDir(appDataRoot) })
}

/**
 * The interactive backend picker {@link resolveBackendUrl} uses when several backends are paired and
 * no `--url` was given: an arrow-key select styled like the rest of the CLI. Throws (so the command
 * aborts with the `--url` hint) when the user cancels, since no backend can be chosen.
 *
 * @param urls - The paired backend URLs to choose from.
 * @returns The selected backend URL.
 */
export async function selectBackendUrl(urls: string[]): Promise<string> {
  const choice = await ui.p.select<string>({
    message: 'Which backend?',
    options: urls.map((url) => ({ value: url, label: url }))
  })
  if (ui.p.isCancel(choice)) {
    throw new Error('Multiple backends are paired. Pass --url <backend>.')
  }
  return choice
}

/**
 * Resolves the backend a `connect`/`disconnect` targets (explicit `--url`, the sole pairing, or - in
 * a TTY - an interactive pick among several) and, on an empty or still-ambiguous pairing set, prints
 * the resolver's guidance and exits non-zero. Returns the URL, or `undefined` once the process is
 * exiting, so callers do `const url = await resolveCommandBackend(...); if (url === undefined) return`.
 *
 * @param argv - The process arguments (read for an explicit `--url`).
 * @param state - The state store (read for the paired backends).
 * @returns The resolved backend URL, or `undefined` when the process is exiting.
 */
export async function resolveCommandBackend(argv: string[], state: StateStore): Promise<string | undefined> {
  try {
    return await resolveBackendUrl(flagValue(argv, '--url'), state, {
      interactive: process.stdin.isTTY === true,
      prompt: selectBackendUrl
    })
  } catch (err) {
    ui.p.cancel(err instanceof Error ? err.message : String(err))
    process.exit(1)
    return undefined
  }
}
