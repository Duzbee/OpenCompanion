import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import type { McpServerSpec, PermissionMode } from '@opencompanion/protocol'
import { childEnvFor, raceLineAgainstStall, withStderr, type SpawnFn } from './drivers'
import type { AgenticCliDriver, AgenticDriverMessage } from './adapters/types'

/** ACP protocol version this client negotiates (Hermes v0.18.0 speaks version 1). */
const ACP_PROTOCOL_VERSION = 1

/**
 * Client identity sent in the `initialize` handshake (mirrors the Codex app-server client info).
 * Deliberately NEUTRAL: this is reusable boilerplate, so the identity every ACP agent sees must
 * not carry a product codename.
 */
const ACP_CLIENT_INFO = { name: 'companion', version: '1.0.0' } as const

/**
 * Client capabilities advertised to the agent. Both filesystem access and terminal
 * spawning are declined: the agent runs inside its own cwd and drives its own tools, so
 * it never needs to call back into this client for file reads/writes or a terminal.
 */
const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false
} as const

/** How long an ACP auth probe waits for the `initialize` result before it is treated as no-evidence. */
const ACP_PROBE_TIMEOUT_MS = 15_000

/** True for a plain object (never `null` or an array). Local, so acp-driver has no cross-file coupling. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Per-tool ACP configuration that shapes how {@link makeAcpDriver} drives one agent CLI:
 * the launch arguments, whether app MCP servers are forwarded into the session, and the
 * mapping from the runtime's {@link PermissionMode} onto the agent's own session mode id.
 */
export interface AcpDriverConfig {
  /** Arguments passed to the binary to start an ACP stdio session (e.g. `['acp']`). */
  binaryArgs: string[]
  /** When true, http MCP servers in the run params are forwarded into `session/new`. */
  forwardMcpServers: boolean
  /**
   * Maps a runtime permission mode onto the agent's session mode id (from `modes.availableModes`),
   * or `undefined` to leave the agent's default mode untouched.
   */
  mapPermissionMode(mode: PermissionMode): string | undefined
}

/**
 * The Hermes Agent ACP configuration: launch `hermes acp --accept-hooks`, forward the
 * app MCP server, and map the runtime permission modes onto Hermes' session modes
 * (`read-only` -> `default` (ask before edits), `auto-edit` -> `accept_edits`, `full` -> `dont_ask`).
 */
export const HERMES_ACP_CONFIG: AcpDriverConfig = {
  binaryArgs: ['acp', '--accept-hooks'],
  forwardMcpServers: true,
  mapPermissionMode: (m) =>
    m === 'read-only' ? 'default' : m === 'auto-edit' ? 'accept_edits' : 'dont_ask'
}

/** A parsed inbound ACP line: an agent response, an agent-initiated request, or a notification. */
type AcpIncoming =
  | { kind: 'response'; id: number; result?: Record<string, unknown>; error?: string }
  | { kind: 'agentRequest'; id: number; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }

/**
 * Parses one JSON-RPC line into an {@link AcpIncoming}, or `undefined` for an unparseable
 * or unrecognized frame (so a malformed line degrades to "skip" rather than throwing).
 *
 * @param line - One newline-delimited JSON-RPC frame from the agent's stdout.
 * @returns The classified frame, or `undefined` to ignore it.
 */
function parseAcpLine(line: string): AcpIncoming | undefined {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(msg)) return undefined
  const hasId = typeof msg.id === 'number'
  const method = typeof msg.method === 'string' ? msg.method : undefined
  const params = isRecord(msg.params) ? msg.params : {}
  if (method && hasId) return { kind: 'agentRequest', id: msg.id as number, method, params }
  if (method) return { kind: 'notification', method, params }
  if (hasId) {
    const error =
      isRecord(msg.error) && typeof msg.error.message === 'string'
        ? msg.error.message
        : msg.error !== undefined
          ? 'request failed'
          : undefined
    return {
      kind: 'response',
      id: msg.id as number,
      result: isRecord(msg.result) ? msg.result : undefined,
      error
    }
  }
  return undefined
}

/** Reads the text of an ACP content block (`{ content: { text } }`), or `undefined`. */
function contentText(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined
  return typeof content.text === 'string' ? content.text : undefined
}

/**
 * Maps one `session/update` notification's params onto a normalized driver message, tracking
 * each `tool_call` title by its id so a later `tool_call_update` (which omits the title) can
 * name the same tool. Returns `undefined` for kinds the driver ignores (`usage_update`,
 * `session_info_update`, ...) or an unrecognized shape - every field read is guarded so an
 * unexpected frame never throws.
 *
 * @param params - The `session/update` params.
 * @param toolTitles - The id->title map, updated on each `tool_call`.
 * @returns The normalized message, or `undefined` to ignore the update.
 */
function mapSessionUpdate(
  params: Record<string, unknown>,
  toolTitles: Map<string, string>
): AgenticDriverMessage | undefined {
  const update = isRecord(params.update) ? params.update : undefined
  if (!update) return undefined
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
  switch (kind) {
    case 'agent_message_chunk': {
      const text = contentText(update.content)
      return text ? { kind: 'text', text } : undefined
    }
    case 'agent_thought_chunk': {
      const text = contentText(update.content)
      return text ? { kind: 'reasoning', text } : undefined
    }
    case 'tool_call': {
      const title = typeof update.title === 'string' ? update.title : (toolCallId ?? 'tool')
      if (toolCallId) toolTitles.set(toolCallId, title)
      return { kind: 'tool', name: title, status: 'started' }
    }
    case 'tool_call_update': {
      // Only the terminal statuses are emitted: the initial `tool_call` already reported the tool
      // as started, so an intermediate update (`pending`/`in_progress`, or a content-only update
      // with no status) would otherwise misreport a still-running tool as finished.
      if (update.status !== 'failed' && update.status !== 'completed') return undefined
      const name = (toolCallId && toolTitles.get(toolCallId)) || toolCallId || 'tool'
      return { kind: 'tool', name, status: update.status }
    }
    default:
      return undefined
  }
}

/**
 * Maps the run params' http MCP servers onto ACP `session/new` entries when forwarding is
 * enabled. Only `http` specs are forwarded (the app MCP is always http); each becomes
 * `{ type:'http', name, url, headers: [] }` keyed by its server name. Absent/empty yields `[]`.
 *
 * @param mcpServers - The builder/integration MCP servers keyed by name.
 * @param forward - Whether forwarding is enabled for this tool.
 * @returns The ACP `mcpServers` array (possibly empty).
 */
function mapAcpMcpServers(
  mcpServers: Record<string, McpServerSpec> | undefined,
  forward: boolean
): { type: 'http'; name: string; url: string; headers: [] }[] {
  if (!forward || !mcpServers) return []
  const out: { type: 'http'; name: string; url: string; headers: [] }[] = []
  for (const [name, spec] of Object.entries(mcpServers)) {
    if (spec.type === 'http' && spec.url) out.push({ type: 'http', name, url: spec.url, headers: [] })
  }
  return out
}

/**
 * Picks the option id to auto-answer an agent `session/request_permission`. In `read-only`
 * mode ONLY a `reject_*` option may be chosen (the run must not mutate): when the agent offers
 * none, `undefined` is returned and the caller answers with the `cancelled` outcome instead of
 * auto-approving a mutation. In the permissive modes the first `allow_*` option is chosen,
 * falling back to the first option when no kind matches, so a run never blocks on an
 * unanswered prompt (this is a non-interactive product run).
 *
 * @param options - The permission options offered by the agent.
 * @param mode - The run's permission mode.
 * @returns The chosen option id, or `undefined` to cancel the request.
 */
function choosePermissionOption(options: unknown, mode: PermissionMode): string | undefined {
  if (!Array.isArray(options)) return undefined
  const parsed = options.filter(isRecord)
  const idOf = (o: Record<string, unknown>): string | undefined =>
    typeof o.optionId === 'string' ? o.optionId : undefined
  const byKind = (prefix: string): string | undefined => {
    const match = parsed.find((o) => typeof o.kind === 'string' && o.kind.startsWith(prefix))
    return match ? idOf(match) : undefined
  }
  if (mode === 'read-only') return byKind('reject')
  const first = parsed[0]
  return byKind('allow') ?? (first !== undefined ? idOf(first) : undefined)
}

/**
 * Builds a tool-agnostic ACP driver: a JSON-RPC 2.0 client over a per-run child's stdio that
 * drives the user's OWN installed agent CLI (e.g. Hermes). One child is spawned per run; the
 * driver does the `initialize` handshake, opens (`session/new`) or resumes (`session/load`) a
 * session, optionally sets the session mode from the permission mode, then streams the answer
 * from `session/update` notifications while the `session/prompt` is pending. It yields a
 * `conversation` (the session id) so a follow-up turn can resume, auto-answers permission
 * requests non-interactively, maps a `cancelled`/aborted run to a silent return, and recovers a
 * genuinely hung run via the shared inactivity watchdog. Provider auth is the agent's own (no
 * BYOK env var is injected). The child env is the shared allowlist with the node dir on PATH.
 *
 * @param spawnFn - The injected process spawner (defaults to `cross-spawn` in production).
 * @param config - The per-tool ACP configuration (launch args, MCP forwarding, mode mapping).
 * @returns An {@link AgenticCliDriver} that yields normalized messages for one run.
 */
export function makeAcpDriver(spawnFn: SpawnFn, config: AcpDriverConfig): AgenticCliDriver {
  return async function* (p) {
    // A chat with no connected workspace has an empty cwd; ACP needs a real cwd, so fall back to
    // the OS temp dir (a valid, writable, throwaway directory) - the run is chat-only.
    const runCwd = p.cwd && p.cwd.length > 0 ? p.cwd : tmpdir()
    const mcpServers = mapAcpMcpServers(p.mcpServers, config.forwardMcpServers)
    const child = spawnFn(p.binaryPath, config.binaryArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runCwd,
      // Inherit an allowlisted env (PATH, proxy, CA, locale, ...) with the node dir on PATH. No BYOK
      // var: the agent owns its provider auth (its own login), unlike the Claude/Codex BYOK path.
      env: childEnvFor()
    })
    child.stdin?.on('error', () => {})
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    // Capture a spawn error (e.g. ENOENT); surfaced after the loop unless the run was aborted (a
    // post-abort kill never emits a spawn error, so no abort-vs-real disambiguation is needed here).
    let spawnError: Error | undefined
    child.on('error', (err: Error) => {
      spawnError = err
    })

    let nextId = 1
    const writeMessage = (message: Record<string, unknown>): void => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`)
      } catch {
        // stdin can be torn down mid-run (cancel/exit); a lost write is not a run failure.
      }
    }
    const sendRequest = (method: string, params: Record<string, unknown>): number => {
      const id = nextId++
      writeMessage({ jsonrpc: '2.0', id, method, params })
      return id
    }
    const writeNotify = (method: string, params: Record<string, unknown>): void => {
      writeMessage({ jsonrpc: '2.0', method, params })
    }

    let sessionId: string | undefined
    // Cancel maps to a graceful `session/cancel` notification (so the agent finalizes the turn),
    // then the per-run child is torn down - killing it is the definitive cancel.
    const onAbort = (): void => {
      if (sessionId) writeNotify('session/cancel', { sessionId })
      setImmediate(() => child.kill())
    }
    if (p.signal.aborted) onAbort()
    else p.signal.addEventListener('abort', onAbort, { once: true })

    const toolTitles = new Map<string, string>()
    let phase: 'init' | 'session' | 'stream' = 'init'
    // `session/update` notifications are mapped ONLY while the prompt is pending; this suppresses the
    // `session/load` history replay and any post-`session/new` metadata that arrives before the prompt.
    let promptPending = false
    let sawDone = false
    const initId = sendRequest('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
      clientInfo: ACP_CLIENT_INFO
    })
    let sessionReqId: number | undefined
    let setModeReqId: number | undefined
    let promptReqId: number | undefined

    /**
     * Emits `session/set_mode` when the mapped mode differs from `current`, then sends
     * `session/prompt`. The caller advances `phase` to `'stream'`; keeping that assignment in the
     * main loop flow (not this closure) lets the control-flow analysis narrow the phase correctly.
     */
    const startPrompt = (current: string | undefined): void => {
      const target = config.mapPermissionMode(p.permissionMode)
      if (sessionId && target && target !== current) {
        setModeReqId = sendRequest('session/set_mode', { sessionId, modeId: target })
      }
      promptPending = true
      promptReqId = sendRequest('session/prompt', {
        sessionId: sessionId ?? '',
        prompt: [{ type: 'text', text: p.prompt }]
      })
    }

    const rl = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined
    try {
      if (rl) {
        const iterator = rl[Symbol.asyncIterator]()
        while (true) {
          const read = iterator.next()
          const result = await raceLineAgainstStall(read)
          if (result === 'stalled') {
            // No message for the inactivity ceiling - a genuinely hung run (a healthy run resets this
            // on every streamed delta). Kill the child, swallow the pending read's late rejection, and
            // surface a recoverable stall error (unless the run was already cancelled).
            child.kill()
            void read.catch(() => {})
            if (p.signal.aborted) return
            yield {
              kind: 'error',
              message:
                'The model run stalled - no activity for 15 minutes. Try again; if it persists, update your agent CLI.'
            }
            return
          }
          if (result.done) break
          const incoming = parseAcpLine(result.value)
          if (!incoming) continue
          if (incoming.kind === 'agentRequest') {
            if (incoming.method === 'session/request_permission') {
              const optionId = choosePermissionOption(incoming.params.options, p.permissionMode)
              writeMessage({
                jsonrpc: '2.0',
                id: incoming.id,
                result: optionId
                  ? { outcome: { outcome: 'selected', optionId } }
                  : { outcome: { outcome: 'cancelled' } }
              })
            } else {
              // We declined fs + terminal capabilities, so no other agent request is expected;
              // answer any stray one with method-not-found so the agent never blocks on it.
              writeMessage({
                jsonrpc: '2.0',
                id: incoming.id,
                error: { code: -32601, message: 'Method not supported' }
              })
            }
            continue
          }
          if (incoming.kind === 'response') {
            if (incoming.id === setModeReqId) continue // set_mode is best-effort; ignore result/error.
            if (incoming.error) {
              if (p.signal.aborted) return
              yield { kind: 'error', message: withStderr(incoming.error, stderr) }
              return
            }
            if (phase === 'init' && incoming.id === initId) {
              if (p.resume) {
                sessionId = p.resume
                sessionReqId = sendRequest('session/load', {
                  sessionId: p.resume,
                  cwd: runCwd,
                  mcpServers
                })
              } else {
                sessionReqId = sendRequest('session/new', { cwd: runCwd, mcpServers })
              }
              phase = 'session'
            } else if (phase === 'session' && incoming.id === sessionReqId) {
              if (p.resume) {
                // `session/load` returns `{}` (no session metadata); the id is the resumed one, and
                // there is no current mode to compare against, so the mode is left untouched.
                if (sessionId) yield { kind: 'conversation', id: sessionId }
                startPrompt(undefined)
              } else {
                sessionId = readSessionId(incoming.result)
                if (sessionId) yield { kind: 'conversation', id: sessionId }
                startPrompt(readCurrentModeId(incoming.result))
              }
              phase = 'stream'
            } else if (phase === 'stream' && incoming.id === promptReqId) {
              promptPending = false
              const stopReason = readStopReason(incoming.result)
              if (stopReason === 'end_turn') {
                sawDone = true
                break
              }
              // A cancelled turn (the agent's response to our `session/cancel`, or its own cancel) is
              // neither success nor failure: return silently, emitting no terminal message.
              if (stopReason === 'cancelled') return
              yield {
                kind: 'error',
                message: withStderr(`The agent run ended: ${stopReason ?? 'unknown'}`, stderr)
              }
              return
            }
            continue
          }
          // notification
          if (incoming.method === 'session/update' && promptPending) {
            const message = mapSessionUpdate(incoming.params, toolTitles)
            if (message) yield message
          }
        }
      }
      if (p.signal.aborted) return
      if (spawnError) {
        yield { kind: 'error', message: withStderr(spawnError.message, stderr) }
        return
      }
      if (sawDone) {
        yield { kind: 'done' }
        return
      }
      // stdout EOF before a terminal `end_turn` = the agent died mid-run.
      yield {
        kind: 'error',
        message: withStderr('The agent exited before completing the run', stderr)
      }
    } catch (error) {
      // A cancelled run kills the child, which can reject the pending read; that is expected teardown,
      // not a run failure, so swallow it silently. A genuine failure still surfaces as an error.
      if (p.signal.aborted) return
      yield {
        kind: 'error',
        message: withStderr(error instanceof Error ? error.message : String(error), stderr)
      }
    } finally {
      rl?.close()
      child.kill()
    }
  }
}

/** Reads `result.sessionId` from a `session/new` response, or `undefined`. */
function readSessionId(result: Record<string, unknown> | undefined): string | undefined {
  return result && typeof result.sessionId === 'string' ? result.sessionId : undefined
}

/** Reads `result.modes.currentModeId` from a `session/new` response, or `undefined`. */
function readCurrentModeId(result: Record<string, unknown> | undefined): string | undefined {
  const modes = result && isRecord(result.modes) ? result.modes : undefined
  return modes && typeof modes.currentModeId === 'string' ? modes.currentModeId : undefined
}

/** Reads `result.stopReason` from a `session/prompt` response, or `undefined`. */
function readStopReason(result: Record<string, unknown> | undefined): string | undefined {
  return result && typeof result.stopReason === 'string' ? result.stopReason : undefined
}

/** The outcome of an ACP auth probe: whether a usable (non-terminal) provider is configured. */
export interface AcpAuthProbeResult {
  /** True when the agent advertises at least one non-`terminal` auth method (a usable provider). */
  authenticated: boolean
  /** A short human-readable summary of the advertised providers (best-effort). */
  detail?: string
}

/**
 * Probes an ACP agent's auth state by doing only the `initialize` handshake: an agent that has a
 * usable provider advertises a non-`terminal` auth method (a `terminal` method is a "run this to
 * configure" action, i.e. no provider yet). Spawns the binary, sends `initialize`, reads the
 * result, and tears the child down. THROWS on a spawn error or a timeout (both are absence of
 * evidence, not proof of "unauthenticated"), and resolves `{ authenticated, detail }` only on a
 * clean handshake.
 *
 * @param spawnFn - The injected process spawner.
 * @param binaryPath - The resolved agent binary path.
 * @param args - The ACP launch arguments (e.g. `['acp']`).
 * @returns The probe result on a clean handshake.
 */
export function probeAcpAuth(
  spawnFn: SpawnFn,
  binaryPath: string,
  args: string[]
): Promise<AcpAuthProbeResult> {
  return new Promise<AcpAuthProbeResult>((resolve, reject) => {
    const child = spawnFn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpdir(),
      env: childEnvFor()
    })
    child.stdin?.on('error', () => {})
    let settled = false
    const rl = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined
    const teardown = (): void => {
      rl?.close()
      try {
        child.stdin?.end()
      } catch {
        // stdin may already be torn down.
      }
      setImmediate(() => child.kill())
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      teardown()
      reject(new Error('ACP auth probe timed out'))
    }, ACP_PROBE_TIMEOUT_MS)
    child.on('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      teardown()
      reject(err)
    })
    const initId = 1
    // Attach the line listener BEFORE sending `initialize`: readline starts flowing on creation and
    // does not buffer `'line'` events for a late listener, so a response written during the send
    // would otherwise be missed.
    rl?.on('line', (line: string) => {
      if (settled) return
      const incoming = parseAcpLine(line)
      if (!incoming || incoming.kind !== 'response' || incoming.id !== initId) return
      settled = true
      clearTimeout(timer)
      teardown()
      if (incoming.error) {
        reject(new Error(incoming.error))
        return
      }
      const methods = readAuthMethods(incoming.result)
      const usable = methods.filter((m) => m.type !== 'terminal')
      resolve({
        authenticated: usable.length > 0,
        detail:
          usable.length > 0
            ? usable.map((m) => m.name ?? m.id ?? 'provider').join(', ')
            : 'no configured provider'
      })
    })
    sendInitialize(child, initId)
  })
}

/** Writes the `initialize` request (with the given id) to the child. */
function sendInitialize(child: ReturnType<SpawnFn>, id: number): void {
  try {
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: ACP_CLIENT_CAPABILITIES,
          clientInfo: ACP_CLIENT_INFO
        }
      })}\n`
    )
  } catch {
    // A failed write surfaces as a spawn `error` event, which rejects the probe.
  }
}

/** Reads the `authMethods` array from an `initialize` result, defensively. */
function readAuthMethods(
  result: Record<string, unknown> | undefined
): { id?: string; name?: string; type?: string }[] {
  if (!result || !Array.isArray(result.authMethods)) return []
  return result.authMethods.filter(isRecord).map((m) => ({
    id: typeof m.id === 'string' ? m.id : undefined,
    name: typeof m.name === 'string' ? m.name : undefined,
    type: typeof m.type === 'string' ? m.type : undefined
  }))
}
