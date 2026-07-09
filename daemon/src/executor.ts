import { createHash } from 'node:crypto'
import {
  jsonSchema,
  tool,
  type AdapterCapabilities,
  type ConnectionRef,
  type McpServerSpec,
  type PermissionMode,
  type RunContext,
  type RuntimeRunEvent,
  type RuntimeRunRequest,
  type SessionManager,
  type ToolSet
} from '@opencompanion/core'
import type {
  RunConversationMsg,
  RunEventMsg,
  RunPolicy,
  RunStart,
  ToolCall,
  WebToolManifestEntry
} from '@opencompanion/protocol'
import { comparePermissionModes } from '@opencompanion/protocol'
import type { AuditLog } from './audit-log'
import { buildRun } from './run-context-builder'

/** A running loopback app-MCP handle (the subset of the runtime's `LocalMcpHandle`). */
interface ServedTools {
  /** The `http` MCP spec to inject into the run's `mcpServers`. */
  spec: McpServerSpec
  /** Tears down the listener + server. */
  close(): Promise<void>
}

/** Hooks a caller (the poll client) wires into one run. */
export interface RunHooks {
  /** Receives each run event, already wrapped as a `run.event` UP message. */
  onEvent(msg: RunEventMsg): void
  /**
   * Receives the run's SDK session/thread id, wrapped as a `run.conversation` UP message, so the
   * backend can persist it and resume the next turn (I1). Optional: a local test run ignores it.
   */
  onConversation?(msg: RunConversationMsg): void
  /**
   * Receives a web-side tool invocation to proxy as a `tool.call` UP message; resolves the result.
   * The wire correlation `callId` is OWNED by the poll client (it mints and tracks it), so the
   * executor never supplies one - it passes only the run-scoped tool name + args.
   */
  onToolCall(call: Omit<ToolCall, 'callId'>): Promise<unknown>
  /**
   * Fires once per run when the run requested `network: 'off'` but the resolved adapter cannot
   * OS-enforce egress (e.g. claude-code/opencode), so the restriction is best-effort. A non-fatal
   * honesty disclosure the host surfaces to the operator (the daemon logs it per-run); the run
   * continues. Optional: a local test run ignores it.
   */
  onNetworkNotEnforced?(adapter: string): void
  /** Fires once when the run leaves the active map (terminal/cancel). */
  onClose(): void
}

/** Injected dependencies for {@link createExecutor} (all fakeable in tests). */
export interface ExecutorDeps {
  /** The confined `work/` parent. */
  appDataRoot: string
  /**
   * The paired backend's key, namespacing this daemon's confined work tree as
   * `work/<backendKey>/<productId>/` so two paired backends never collide on a shared `productId`.
   */
  backendKey: string
  /** The paired backend URL this daemon serves, stamped onto every audit entry it authors. */
  backendUrl: string
  /**
   * The local audit log. Every dispatched run is recorded here BEFORE the CLI is started (fail-closed:
   * a run whose `dispatched` append throws is refused and never executes), so an unlogged run is
   * impossible; terminal outcomes are recorded best-effort.
   */
  audit: AuditLog
  /** The runtime session manager driving the CLIs. */
  sessionManager: SessionManager
  /** Resolves a connection for a product, or `null`. */
  getConnection(productId: string, connectionId: string): ConnectionRef | null
  /**
   * Returns the policy ceiling the requested policy is clamped to. The daemon resolves ONE ceiling
   * per paired backend (keyed by `backendUrl`), so its implementation ignores `productId`; the
   * argument is kept for the seam's shape, not because the ceiling varies by product.
   */
  getCeiling(productId: string): RunPolicy
  /** Resolves a tool binary by bare name, or `null`. */
  resolveBinary(name: string): string | null
  /** Serves a `ToolSet` over loopback MCP (the runtime's `serveToolsOverHttp`). */
  serveTools(tools: ToolSet): Promise<ServedTools>
  /** Decides whether to serve web tools (the runtime's `shouldServeLocalTools`). */
  shouldServe(capabilities: AdapterCapabilities, tools: ToolSet): boolean
  /** Capabilities for the resolved tool id (used by `shouldServe`); defaults to agentic+httpMcp. */
  getCapabilities?(toolId: string): AdapterCapabilities
  /**
   * Sink for a best-effort terminal-audit failure. A `dispatched` append is fail-closed (a throw
   * refuses the run), but a THROWING terminal append (completed/failed/cancelled) must not crash the
   * daemon: it is swallowed and surfaced here as a warning line instead. Defaults to a no-op.
   */
  log?: (line: string) => void
}

/** Starts and cancels dispatched runs. */
export interface Executor {
  /** Starts a dispatched run; idempotent dedupe is the caller's job (by `runId`). */
  start(start: RunStart, hooks: RunHooks): void
  /** Cancels an in-flight run by id. */
  cancel(runId: string): void
  /** The number of runs currently in flight (dispatched, not yet closed); summed for idle-gating. */
  activeRunCount(): number
}

/** Default capabilities used when the host does not inject a per-tool lookup. */
const DEFAULT_CAPS: AdapterCapabilities = {
  kind: 'agentic',
  supportedAuthModes: ['subscription'],
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  httpMcp: true
}

/**
 * Raises a permission mode UP to at least `auto-edit`, leaving a higher mode (`full`) unchanged - but
 * ONLY when the per-backend `ceiling` permits it. The companion is UNATTENDED, so it normally mirrors
 * the desktop SCHEDULED posture: the CLI must be able to edit/act headlessly (a `read-only` posture
 * would refuse every write on the CLIs that map the mode to a static sandbox - Codex/OpenCode - making
 * the companion a read-only agent). The one exception is an EXPLICIT read-only ceiling: a builder who
 * sets `ceiling.permissionMode === 'read-only'` is opting into a truly non-destructive companion, so
 * the floor is NOT applied and the clamped `read-only` mode stands. Otherwise this floors up. It never
 * LOWERS a mode, and the run's real safety boundaries (work-folder confinement + network posture) come
 * from the clamped policy, not the permission mode.
 *
 * @param mode - The clamped permission mode from the policy.
 * @param ceiling - The per-backend permission ceiling; a `read-only` ceiling suppresses the floor.
 * @returns The mode, floored up to `auto-edit` unless the ceiling is `read-only`.
 */
function floorToAutoEdit(mode: PermissionMode, ceiling: PermissionMode): PermissionMode {
  // Honor an explicit read-only CEILING: the builder wants a non-destructive companion, so do not
  // raise a clamped read-only mode. The floor only ever applies under a more permissive ceiling.
  if (ceiling === 'read-only') return mode
  return comparePermissionModes(mode, 'auto-edit') >= 0 ? mode : 'auto-edit'
}

/**
 * Turns the serializable web-tool manifest into an in-process {@link ToolSet} whose every
 * `execute` proxies a `tool.call` over the daemon transport and awaits the matching `tool.result`.
 * The model sees the tools via the loopback MCP; their work happens server-side.
 *
 * @param manifest - The web-tool descriptors from the dispatch.
 * @param runId - The run these tools belong to.
 * @param onToolCall - Sends a `tool.call` UP and resolves its result.
 * @returns The proxying tool set.
 */
function manifestToToolSet(
  manifest: WebToolManifestEntry[],
  runId: string,
  onToolCall: (call: Omit<ToolCall, 'callId'>) => Promise<unknown>
): ToolSet {
  const out: ToolSet = {}
  for (const entry of manifest) {
    out[entry.name] = tool({
      ...(entry.description ? { description: entry.description } : {}),
      inputSchema: jsonSchema(entry.inputSchema),
      execute: async (args: unknown) =>
        onToolCall({
          type: 'tool.call',
          runId,
          name: entry.name,
          args: (args ?? {}) as Record<string, unknown>
        })
    })
  }
  return out
}

/**
 * Computes the SHA-256 fingerprint of a dispatched run's prompt, so the audit log can prove WHICH
 * prompt ran without ever storing the prompt text (a privacy-preserving fingerprint). The canonical
 * serialization is a JSON object with keys in a FIXED order - `{"systemPrompt":<string|null>,
 * "input":<string>}` - hashed as UTF-8 hex; an absent system prompt is normalized to `null` so a
 * dispatch that omits it still hashes stably. This is the whole prompt content the backend composed
 * (system prompt + user input); the per-run local bits (cwd, binary, MCP) are not part of the prompt.
 *
 * @param start - The dispatched run descriptor.
 * @returns The 64-char lowercase hex SHA-256 of the canonical prompt JSON.
 */
function promptFingerprint(start: RunStart): string {
  const canonical = JSON.stringify({ systemPrompt: start.systemPrompt ?? null, input: start.input })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Builds the {@link Executor} over the runtime session manager. Each `start` resolves the
 * connection + policy ceiling, builds the isolated {@link RunContext} + clamped
 * {@link RuntimeRunRequest}, optionally serves the web tools over loopback MCP and injects the
 * spec into `mcpServers`, then drives the run - forwarding every runtime event up as a
 * `run.event`, forwarding the SDK session id as a `run.conversation`, AUTO-APPROVING any CLI
 * permission-request and flooring the posture to `auto-edit` (the daemon is unattended with no
 * approver, so it mirrors the desktop SCHEDULED posture and lets the CLI act headlessly rather than
 * refusing every write - UNLESS the per-backend ceiling is explicitly `read-only`, an opt-in
 * non-destructive companion where the floor is suppressed), and tearing the MCP server down on close.
 * A cancel that arrives while a run's loopback MCP is still being served is honored (the served
 * handle is closed and the run never starts) rather than dropped.
 *
 * Every dispatched run is audited locally FAIL-CLOSED: a `dispatched` entry is appended to
 * `deps.audit` BEFORE the CLI is started, and if that append throws the run is refused (terminal
 * error frame, CLI never started) so an unlogged run is impossible. The terminal outcome
 * (`completed`/`failed`/`cancelled`, with a duration) is then recorded best-effort - a throwing
 * terminal append is swallowed to a warning line rather than crashing the already-executed run.
 *
 * @param deps - The injected runtime + storage + MCP + audit dependencies.
 * @returns The executor.
 */
export function createExecutor(deps: ExecutorDeps): Executor {
  const getCaps = deps.getCapabilities ?? ((): AdapterCapabilities => DEFAULT_CAPS)
  /**
   * Run ids whose `serveTools()` is still in flight (no run yet in the `SessionManager`). A cancel
   * that arrives during this window would otherwise be dropped: the session manager has no run to
   * cancel, and `serveTools` would resolve AFTER the cancel and start the run anyway. Tracking them
   * here lets `cancel` mark such a run so the resolved MCP handle is closed and the run never starts.
   */
  const pending = new Set<string>()
  /** Run ids canceled while still pending (their `serveTools()` had not yet resolved). */
  const canceledWhilePending = new Set<string>()
  /**
   * Run ids currently in flight: added when a run is dispatched, removed when its `onClose` fires
   * (terminal, cancel, or a refusal). Keyed by run id and mutated only through the per-run `finish`
   * below, so it is authoritative for idle-gating and cannot drift like a bare increment/decrement.
   */
  const active = new Set<string>()

  return {
    start(start, hooks): void {
      // Mark this run in flight and route every close path through `finish`, so the active set always
      // reflects the true lifecycle (start -> onClose) whichever branch closes the run.
      active.add(start.runId)
      const finish = (): void => {
        active.delete(start.runId)
        hooks.onClose()
      }
      const connection = deps.getConnection(start.productId, start.connectionId)
      if (!connection) {
        hooks.onEvent({
          type: 'run.event',
          runId: start.runId,
          event: { type: 'error', message: 'Unknown connection' }
        })
        finish()
        return
      }

      const ceiling = deps.getCeiling(start.productId)
      const { ctx, req, resolvers, effectivePolicy } = buildRun({
        appDataRoot: deps.appDataRoot,
        backendKey: deps.backendKey,
        start,
        ceiling,
        connection,
        resolveBinary: deps.resolveBinary
      })

      const toolSet = manifestToToolSet(start.webToolManifest, start.runId, hooks.onToolCall)
      const caps = getCaps(connection.toolId)

      // Floor the clamped permission mode UP to `auto-edit` for this unattended run (mirroring the
      // desktop SCHEDULED posture) so the CLIs that map the mode to a static sandbox (Codex/OpenCode)
      // can actually edit/act headlessly. Paired with the auto-approve of interactive permission
      // requests below, this gives the companion the same act-headlessly capability desktop scheduled
      // runs have. It never LOWERS a mode (a `full` ceiling stays `full`), and an explicit read-only
      // CEILING suppresses the floor entirely (an opt-in non-destructive companion).
      const postured: RuntimeRunRequest = {
        ...req,
        permissionMode: floorToAutoEdit(req.permissionMode, ceiling.permissionMode)
      }

      // The policy this run ACTUALLY executes under (the clamped network posture plus the floored
      // permission mode) - the honest record for the audit log, not the pre-floor clamped mode.
      const auditedPolicy: RunPolicy = {
        permissionMode: postured.permissionMode,
        network: effectivePolicy.network
      }

      // FAIL-CLOSED: record the dispatch locally BEFORE the CLI is started. If the append throws (a
      // full or unwritable audit dir), refuse the run through the existing terminal error frame path
      // and never start the CLI - an unlogged run is impossible. Terminal outcomes below are recorded
      // best-effort (a throwing terminal append must not crash the daemon).
      const dispatchedAt = performance.now()
      try {
        deps.audit.append({
          backendUrl: deps.backendUrl,
          event: 'dispatched',
          runId: start.runId,
          productId: start.productId,
          toolId: connection.toolId,
          promptSha256: promptFingerprint(start),
          policy: auditedPolicy
        })
      } catch (err) {
        // Surface the underlying cause (disk-full vs permission) in the LOCAL daemon log so an operator
        // can debug refused runs; the wire frame stays a fixed message so no local detail leaks upstream.
        deps.log?.(
          `audit dispatch append failed for run ${start.runId} - refusing run: ${err instanceof Error ? err.message : String(err)}\n`
        )
        hooks.onEvent({
          type: 'run.event',
          runId: start.runId,
          event: { type: 'error', message: 'audit log unavailable - run refused' }
        })
        finish()
        return
      }

      // Records the terminal outcome exactly once (a `done`/`error` event or a cancel that reaps the
      // run without one). Best-effort: a throwing append is swallowed and surfaced as a warning line,
      // so a broken audit sink never crashes an already-executed run.
      let terminalRecorded = false
      const recordTerminal = (event: 'completed' | 'failed' | 'cancelled', outcome?: string): void => {
        if (terminalRecorded) return
        terminalRecorded = true
        try {
          deps.audit.append({
            backendUrl: deps.backendUrl,
            event,
            runId: start.runId,
            productId: start.productId,
            toolId: connection.toolId,
            durationMs: Math.round(performance.now() - dispatchedAt),
            ...(outcome !== undefined ? { outcome } : {})
          })
        } catch (err) {
          deps.log?.(
            `audit terminal append failed for run ${start.runId}: ${err instanceof Error ? err.message : String(err)}\n`
          )
        }
      }

      const run = (served: ServedTools | null): void => {
        const runReq: RuntimeRunRequest = served
          ? { ...postured, mcpServers: { ...(postured.mcpServers ?? {}), opencompanion: served.spec } }
          : postured
        deps.sessionManager.startRun(
          runReq,
          ctx,
          resolvers,
          (event: RuntimeRunEvent, runId) => {
            // Forward the SDK session/thread id UP (I1) so the backend can persist it and resume the
            // next turn, instead of dropping it; everything else rides the `run.event` channel.
            if (event.type === 'conversation') {
              hooks.onConversation?.({ type: 'run.conversation', runId, conversationId: event.id })
              return
            }
            // A `network: 'off'` run on an adapter that cannot OS-enforce egress: surface the
            // best-effort disclosure once (the run still proceeds). It is a package-local runtime
            // event, not a wire `RunEvent`, so it never rides the run.event channel and is NOT
            // mapped onto an `error` (which would mark the non-fatal run as failed).
            if (event.type === 'network-not-enforced') {
              hooks.onNetworkNotEnforced?.(event.adapter)
              return
            }
            // The companion runs UNATTENDED: there is no synchronous approver and no permission-
            // response wire back from the backend, so an interactive approval can never be surfaced
            // to a human. Mirror the DESKTOP SCHEDULED posture (auto-approve mutating tools) rather
            // than auto-denying: auto-DENY would silently refuse every write and make the companion a
            // read-only agent that cannot actually act, defeating parity. Auto-APPROVE so the CLI can
            // edit/act headlessly; the run is already bounded by the work-folder confinement, the
            // clamped network posture, and the per-backend policy ceiling, which are the real safety
            // boundaries for an unattended run (not an approval prompt no one can answer).
            if (event.type === 'permission-request') {
              deps.sessionManager.respondToPermission(runId, event.requestId, 'allow')
              return
            }
            // Record the terminal outcome locally before forwarding it up: a `done` completed the run,
            // an `error` failed it. Best-effort so a broken audit sink never crashes an executed run.
            if (event.type === 'done') recordTerminal('completed')
            else if (event.type === 'error') recordTerminal('failed', event.message)
            hooks.onEvent({ type: 'run.event', runId, event })
          },
          null,
          () => {
            void served?.close()
            // The run left the active map without a terminal event: it was cancelled (or reaped as an
            // orphan). `recordTerminal` no-ops if a `done`/`error` already recorded the outcome.
            recordTerminal('cancelled')
            finish()
          },
          // Key the run by the DISPATCH id so emitted events (and cancel-by-id) correlate to the
          // dispatched run, and drive THIS run's already-resolved, product-scoped connection so a
          // colliding bare connection id never resolves another product's connection.
          { runId: start.runId, connection }
        )
      }

      if (deps.shouldServe(caps, toolSet)) {
        // `serveTools()` is async: mark the run pending so a cancel arriving during this window is not
        // dropped (the session manager has no run to cancel yet). When it resolves, if the run was
        // canceled meanwhile, close the served handle and DO NOT start it; otherwise proceed.
        pending.add(start.runId)
        void deps.serveTools(toolSet).then(
          (served: ServedTools) => {
            pending.delete(start.runId)
            if (canceledWhilePending.delete(start.runId)) {
              void served.close()
              // Cancelled during the serve window: the dispatched run never reached the session
              // manager, so record its cancellation here (the run's onClose path is not taken).
              recordTerminal('cancelled')
              finish()
              return
            }
            run(served)
          },
          (err: unknown) => {
            pending.delete(start.runId)
            // A cancel that landed during the serve window wins over a serve REJECTION too (mirroring
            // the resolve path): the run was cancelled, so record `cancelled` and close quietly rather
            // than reporting the serve failure the user pre-empted. No `error` frame is surfaced.
            if (canceledWhilePending.delete(start.runId)) {
              recordTerminal('cancelled')
              finish()
              return
            }
            recordTerminal('failed', err instanceof Error ? err.message : 'Failed to serve tools')
            hooks.onEvent({
              type: 'run.event',
              runId: start.runId,
              event: { type: 'error', message: err instanceof Error ? err.message : 'Failed to serve tools' }
            })
            finish()
          }
        )
      } else {
        run(null)
      }
    },
    cancel(runId): void {
      // A run whose `serveTools()` is still pending has no entry in the session manager yet, so a
      // plain `cancelRun` would be a no-op and the run would start after cancellation. Mark it so the
      // pending `serveTools` resolution closes the handle and skips starting instead of dropping the
      // cancel. Always also forward to the session manager for an already-running run.
      if (pending.has(runId)) canceledWhilePending.add(runId)
      deps.sessionManager.cancelRun(runId)
    },
    activeRunCount(): number {
      return active.size
    }
  }
}
