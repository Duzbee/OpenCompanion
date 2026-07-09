import { FALLBACK_MODELS } from '@opencompanion/core-types'
import type {
  AdapterCapabilities,
  AuthStatus,
  ConnectionRef,
  DetectResult,
  ModelInfo,
  RunHandle
} from '@opencompanion/core-types'
import type { RunContext, RunContextResolvers } from '../context'
import type { RuntimeRunEvent, RuntimeRunRequest } from '../runtime-types'
import type { AgenticDriverMessage, CommonAdapterDeps } from './types'

/**
 * Returns a provider's registry models, falling back to the shared
 * {@link FALLBACK_MODELS} when the (config-gated) registry yields none. Shared by the two
 * registry-backed agentic adapters (Claude Code -> `'anthropic'`, Codex -> `'openai'`),
 * which differ only in the provider string; OpenCode keeps its bespoke `opencode models`
 * parse because it addresses models as `provider/model`.
 *
 * @param deps - The adapter's registry lookup.
 * @param provider - The registry/fallback provider key (e.g. `'anthropic'`).
 * @returns The registry models, or the provider's fallback list (or `[]`).
 */
export async function registryModelsOrFallback(
  deps: CommonAdapterDeps,
  provider: string
): Promise<ModelInfo[]> {
  const registry = await deps.listRegistryModels(provider)
  return registry.length > 0 ? registry : (FALLBACK_MODELS[provider] ?? [])
}

/**
 * Maps one normalized driver message onto the package's {@link RuntimeRunEvent} stream.
 * Shared by every agentic adapter (and the completion adapter) so the message contract has
 * exactly one translation point. Returns whether the message emitted streamed *output* (text,
 * reasoning, or tool activity) so a caller can track "has any output streamed yet" for retry
 * bookkeeping; `conversation`, `done` and `error` are control events and return `false`.
 *
 * @param message - The normalized driver message.
 * @param emit - Sink for the resulting run event.
 * @returns True when the message produced streamed output (text/reasoning/tool).
 */
export function emitDriverMessage(
  message: AgenticDriverMessage,
  emit: (event: RuntimeRunEvent) => void
): boolean {
  if (message.kind === 'text') {
    emit({ type: 'delta', text: message.text })
    return true
  }
  if (message.kind === 'reasoning') {
    emit({ type: 'reasoning', text: message.text })
    return true
  }
  if (message.kind === 'tool') {
    emit({ type: 'tool', name: message.name, status: message.status, detail: message.detail })
    return true
  }
  if (message.kind === 'conversation') {
    emit({ type: 'conversation', id: message.id })
    return false
  }
  if (message.kind === 'done') {
    emit({ type: 'done', usage: message.usage })
    return false
  }
  emit({ type: 'error', message: message.message })
  return false
}

/**
 * Probes whether a tool binary is installed by resolving it and running `--version`.
 * Shared by every agentic adapter (they differ only in the binary name), so the
 * resolve / version / error-handling shape lives in exactly one place.
 *
 * @param deps - The adapter's binary resolver + tool runner.
 * @param name - The binary name to resolve (e.g. `'claude'`).
 * @returns The detect result (installed flag, version, and resolved path).
 */
export async function detectBinary(deps: CommonAdapterDeps, name: string): Promise<DetectResult> {
  const path = deps.resolveBinary(name)
  if (!path) return { installed: false }
  try {
    const { code, stdout } = await deps.runTool(path, ['--version'])
    return { installed: code === 0, version: stdout.trim() || undefined, path }
  } catch {
    return { installed: false, path }
  }
}

/**
 * The `apiKey`-mode auth status shared by every agentic adapter: a stored BYOK key means
 * authenticated; its absence reports the standard "No API key stored" detail.
 *
 * @param deps - The adapter's key loader.
 * @param conn - The connection being probed.
 * @returns The apiKey-mode auth status.
 */
export function apiKeyAuthStatus(deps: CommonAdapterDeps, conn: ConnectionRef): AuthStatus {
  const hasKey = deps.loadApiKey(conn.id) !== null
  return {
    authenticated: hasKey,
    mode: 'apiKey',
    detail: hasKey ? undefined : 'No API key stored'
  }
}

/** Copy for a subscription-mode status probe that shells out to the tool's status subcommand. */
export interface SubscriptionStatusCopy {
  /** Binary to resolve and probe. */
  binary: string
  /** Thrown-error message when the binary is not installed (non-evidence, not a sign-out). */
  notInstalledDetail: string
  /** Status subcommand args (e.g. `['login', 'status']`). */
  statusArgs: string[]
  /** Detail when the status subcommand exits 0 (signed in). */
  okDetail: string
  /** Detail when the status subcommand exits non-zero (not signed in). */
  failDetail: string
  /** Thrown-error message when the status probe itself fails to run (non-evidence). */
  errorDetail: string
}

/**
 * The `subscription`-mode auth status for an agentic CLI that exposes a non-interactive
 * status subcommand (Codex `login status`, OpenCode `auth list`): resolve the binary and
 * run the status args. A binary miss or a spawn failure is NON-EVIDENCE of a sign-out and
 * THROWS (the caller keeps the connection's last-known health); only a status command that
 * ran and reported signed-out (nonzero exit) returns `authenticated: false`. Adapters whose
 * CLI has no non-interactive status check (Claude Code) stay bespoke.
 *
 * @param deps - The adapter's binary resolver + tool runner.
 * @param copy - The binary, status args, and per-outcome detail strings.
 * @returns The subscription-mode auth status.
 * @throws When the binary cannot be resolved or the status probe fails to run (non-evidence).
 */
export async function subscriptionStatusCheck(
  deps: CommonAdapterDeps,
  copy: SubscriptionStatusCopy
): Promise<AuthStatus> {
  const path = deps.resolveBinary(copy.binary)
  // A binary miss (NOT-INSTALLED) and a spawn failure (transient probe error) are both NON-EVIDENCE
  // of a sign-out, not a real "not signed in": mapping either onto `authenticated: false` is the
  // false "needs re-auth" prompt we must avoid, so THROW and let the auth-health caller keep the
  // connection's last-known health. Only a status command that actually RAN and reported signed-out
  // (nonzero exit) returns `authenticated: false` and legitimately flips a connection to needs-reauth.
  if (!path) throw new Error(copy.notInstalledDetail)
  try {
    const { code } = await deps.runTool(path, copy.statusArgs)
    return {
      authenticated: code === 0,
      mode: 'subscription',
      detail: code === 0 ? copy.okDetail : copy.failDetail
    }
  } catch {
    throw new Error(copy.errorDetail)
  }
}

/** Context an adapter receives to start its driver for one run. */
export interface AgenticDriverContext {
  /** Resolved absolute path to the user's CLI binary. */
  binaryPath: string
  /** Stored BYOK key; `undefined` means subscription mode (the tool resolves its own auth). */
  apiKey: string | undefined
  /** Abort signal wired to {@link RunHandle.cancel}. */
  signal: AbortSignal
  /**
   * Forwards a tool approval to the UI and resolves with the user's decision. Only adapters
   * that set `interactiveApproval` thread this into their driver; the rest ignore it.
   */
  requestPermission: (toolName: string, input: unknown) => Promise<'allow' | 'deny'>
}

/** Per-adapter inputs to {@link runAgenticDriver}. */
export interface AgenticRunOptions {
  /** Binary name to resolve (e.g. `'claude'`). */
  binary: string
  /** User-facing message emitted when the binary is not installed. */
  notInstalledMessage: string
  /**
   * The adapter's capabilities - the SINGLE source of truth for its behaviour flags. The
   * run-loop reads {@link AdapterCapabilities.interactiveApproval} (whether to wire an
   * approval registry) and {@link AdapterCapabilities.enforcesNetworkOff} (whether a
   * requested `network: 'off'` is genuinely OS-enforced) off this, so the same flags the
   * orchestrator/UI discover are the flags that drive the run - no parallel per-call copies
   * that can silently drift.
   */
  capabilities: AdapterCapabilities
  /** Starts the driver for this run, yielding normalized messages. */
  start: (ctx: AgenticDriverContext) => AsyncIterable<AgenticDriverMessage>
}

/**
 * Shared run-loop for every agentic CLI adapter, threaded with the per-run
 * {@link RunContext}. Resolves the binary and BYOK key THROUGH `resolvers` keyed by `ctx`
 * (never a module global), so two interleaved runs with different `RunContext` can never
 * cross-resolve. It emits a not-installed error (returning inert handles) when the binary
 * is missing, pumps the driver's normalized messages onto the {@link RuntimeRunEvent}
 * stream via {@link emitDriverMessage}, and returns a {@link RunHandle}. Interactive
 * approval is wired only when {@link AdapterCapabilities.interactiveApproval} is set;
 * otherwise `respondToPermission` is a no-op. This is the one place the controller,
 * not-installed guard, message mapping, and permission registry live.
 *
 * When a run requests `network: 'off'` but the adapter's
 * {@link AdapterCapabilities.enforcesNetworkOff} is falsy, the run-loop emits a structured
 * `network-not-enforced` event ONCE for this run (a per-RUN signal the host can persist/surface
 * - NOT a process-global console line) and still proceeds: the disclosure is non-fatal because
 * Claude Code, the primary CLI, cannot OS-enforce egress and refusing the run would break the
 * product. The honest contract is therefore observable per run rather than dying as stderr.
 *
 * @param req - The run request.
 * @param ctx - The per-run context (identity + resolved local state).
 * @param resolvers - Per-run binary/credential resolvers receiving `ctx`.
 * @param emit - Sink for run events.
 * @param options - The per-adapter binary, not-installed message, capabilities, and driver starter.
 * @returns The run handle (`cancel` + `respondToPermission`).
 */
export function runAgenticDriver(
  req: RuntimeRunRequest,
  ctx: RunContext,
  resolvers: RunContextResolvers,
  emit: (event: RuntimeRunEvent) => void,
  options: AgenticRunOptions
): RunHandle {
  const controller = new AbortController()
  const pending = new Map<string, (decision: 'allow' | 'deny') => void>()

  const binaryPath = resolvers.resolveBinary(ctx, options.binary)
  if (!binaryPath) {
    emit({ type: 'error', message: options.notInstalledMessage })
    return {
      cancel() {
        /* no run was started */
      },
      respondToPermission() {
        /* no run was started */
      }
    }
  }
  // The companion's default unattended ceiling is `network: 'off'`. Only adapters that can
  // OS-enforce egress-off honour it for real; the rest must not let the run inherit a silent
  // false "network blocked" guarantee, so surface it as a structured per-run event (the host
  // persists/relays it) before the driver starts rather than logging to a process-global stderr.
  if (req.network === 'off' && !options.capabilities.enforcesNetworkOff) {
    emit({ type: 'network-not-enforced', adapter: options.binary })
  }
  const apiKey = resolvers.loadApiKey(ctx, req.connectionId) ?? undefined

  const requestPermission = (toolName: string, input: unknown): Promise<'allow' | 'deny'> =>
    new Promise((resolve) => {
      const requestId = crypto.randomUUID()
      pending.set(requestId, resolve)
      emit({ type: 'permission-request', requestId, toolName, input })
    })

  // Resolve every outstanding permission request as denied and clear the map, so a run cancelled
  // (or ended) while a prompt is unanswered never leaves the driver's `canUseTool` awaiting forever.
  const denyPending = (): void => {
    for (const resolve of pending.values()) resolve('deny')
    pending.clear()
  }

  void (async () => {
    try {
      for await (const message of options.start({
        binaryPath,
        apiKey,
        signal: controller.signal,
        requestPermission
      })) {
        emitDriverMessage(message, emit)
      }
    } catch (error) {
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      denyPending()
    }
  })()

  return {
    cancel: () => {
      controller.abort()
      denyPending()
    },
    respondToPermission: options.capabilities.interactiveApproval
      ? (requestId, decision) => {
          const resolve = pending.get(requestId)
          if (resolve) {
            pending.delete(requestId)
            resolve(decision)
          }
        }
      : () => {
          /* this adapter has no interactive approval */
        }
  }
}
