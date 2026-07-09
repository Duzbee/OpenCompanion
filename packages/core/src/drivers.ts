import realSpawn from 'cross-spawn'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { HERMES_ACP_CONFIG, makeAcpDriver } from './acp-driver'
import { buildCliEnv } from './env-scrub'
import { isWindowsShimPath } from './binaries'
import { nodeDirOnPath, stripInspectorEnv } from './shell-path'
import {
  CODEX_APP_SERVER_CLIENT_INFO,
  buildCodexAppServerArgs,
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  claudePermissionOptions,
  claudeReasoningOptions,
  codexAppServerNotificationToMessages,
  codexPosture,
  codexReasoningEffort,
  extractCodexThreadId,
  extractCodexTurnId,
  extractTextDelta,
  extractThinkingDelta,
  extractToolUses,
  mapCodexMcpServers,
  mapMcpServers,
  newCodexAppServerTurnState,
  parseCodexAppServerLine
} from './adapters/mapping'
import type {
  AgenticCliDriver,
  AgenticCliDriverParams,
  AgenticDriverMessage,
  ClaudeDriver
} from './adapters/types'

/** The `query` function shape this package consumes from the Claude Agent SDK (injectable). */
export type ClaudeQuery = typeof realQuery

/**
 * Appends one diagnostic line about a Codex run to `<tmpdir>/generatesaas-codex-trace.log`, but ONLY
 * when `GENERATESAAS_CODEX_TRACE` is set. Off by default (buyers never see it); a maintainer sets the
 * env var when driving the companion daemon to capture exactly where a Codex run stalls (spawn args,
 * each raw event, exit code, terminal outcome). Never throws.
 *
 * @param stage - A short stage label.
 * @param detail - Optional context appended after the stage.
 */
function codexTrace(stage: string, detail?: string): void {
  if (!process.env.GENERATESAAS_CODEX_TRACE) return
  try {
    const line = `${new Date().toISOString()} ${stage}${detail ? ` ${detail}` : ''}\n`
    appendFileSync(join(tmpdir(), 'generatesaas-codex-trace.log'), line)
  } catch {
    // Tracing is best-effort by design.
  }
}

/** The `cross-spawn` default export shape this package consumes (injectable). */
export type SpawnFn = typeof realSpawn

/** Injected SDK/CLI seams for {@link makeDrivers}; each defaults to the real import. */
export interface DriverDeps {
  /** The Claude Agent SDK `query` (defaults to the real SDK). */
  query?: ClaudeQuery
  /** The process spawner (defaults to `cross-spawn`). */
  spawnFn?: SpawnFn
}

/** The four agentic drivers a registry wires into its adapters. */
export interface AgentDrivers {
  /** Drives the user's installed Claude Code via the Agent SDK. */
  claudeDriver: ClaudeDriver
  /** Drives the user's installed Codex via `codex app-server` (JSON-RPC over stdio). */
  codexDriver: AgenticCliDriver
  /** Drives the user's installed OpenCode via `opencode run`. */
  openCodeDriver: AgenticCliDriver
  /** Drives the user's installed Hermes via `hermes acp` (ACP JSON-RPC over stdio). */
  hermesDriver: AgenticCliDriver
}

/**
 * The executable path to forward to an agentic SDK as its CLI override, or `undefined`
 * to let the SDK self-resolve. Off Windows the resolved path is always usable. On
 * Windows the Claude/Codex SDKs spawn the real native binary / bundled `cli.js`, so a
 * native `.exe` AND an npm `.cmd`/`.ps1`/`.bat` shim are both forwarded (the spike-A
 * carry-in: a shim install must not silently re-enable the SDK's bundled-binary
 * auto-discovery); a bare extensionless path is not forwarded.
 *
 * @param binaryPath - The resolved binary path.
 * @param platform - The platform to evaluate against (`process.platform`).
 * @returns The path to forward, or `undefined`.
 */
export function forwardOverride(
  binaryPath: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') return binaryPath
  return isWindowsShimPath(binaryPath) ? binaryPath : undefined
}

/**
 * The executable override for the live platform. Thin wrapper over
 * {@link forwardOverride} using `process.platform`.
 *
 * @param binaryPath - The resolved binary path.
 * @returns The path to forward to the SDK, or `undefined`.
 */
export function sdkExecutableOverride(binaryPath: string): string | undefined {
  return forwardOverride(binaryPath, process.platform)
}

/**
 * Builds the allowlisted child env for a spawned CLI: scrub `process.env` to the
 * operational allowlist (adding `extra` back), strip inherited inspector/debugger vars
 * (so a Bun-based CLI does not crash with `EADDRINUSE` under a debugged host), prepend
 * the runtime node dir to PATH so an npm-shim CLI resolves a node (spike-A carry-in 2),
 * and drop any `undefined` values so the result is a clean `Record<string, string>` the
 * SDKs and `spawn` accept.
 *
 * @param extra - The single credential (and any explicit var) to add back after scrubbing.
 * @returns The allowlisted child environment (string values only).
 */
export function childEnvFor(extra: Record<string, string> = {}): Record<string, string> {
  const withNode = nodeDirOnPath(stripInspectorEnv(buildCliEnv(process.env, extra)))
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(withNode)) {
    if (typeof value === 'string') out[name] = value
  }
  return out
}

/** Bridges an AbortSignal to a fresh AbortController (the Agent SDK wants a controller). */
function controllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

/**
 * Appends captured process stderr (trimmed, tail-limited) to an error message so a
 * failed run surfaces the tool's real reason (not signed in, missing `node` on the
 * PATH, etc.) rather than only an opaque exit code.
 */
export function withStderr(message: string, stderr: string): string {
  const detail = stderr.trim()
  return detail ? `${message}: ${detail.slice(-600)}` : message
}

/**
 * True when an error is an abort (a cancelled `spawn({ signal })` re-surfaces as an
 * `error` event with name `AbortError` or code `ABORT_ERR`). Used to swallow the
 * abort rather than re-throwing it as an uncaught exception (spike-A carry-in 1).
 *
 * @param error - The thrown/emitted error value.
 * @returns True when the error is an abort.
 */
function isAbortError(error: unknown): boolean {
  if (!(error && typeof error === 'object')) return false
  const e = error as { name?: unknown; code?: unknown }
  return e.name === 'AbortError' || e.code === 'ABORT_ERR'
}

/**
 * Builds the Claude driver bound to the injected `query`. Emits a `conversation`
 * (the SDK `session_id`) before `done` on a successful result, and sets
 * `options.resume` only when `p.resume` is supplied (spike-D resume). The child env
 * is an allowlist with the node dir on PATH, plus the BYOK key when present.
 */
function makeClaudeDriver(query: ClaudeQuery): ClaudeDriver {
  return async function* (p) {
    const opts = claudePermissionOptions(p.permissionMode)
    const allowedTools = [...(opts.allowedTools ?? []), ...(p.allowedTools ?? [])]
    const disallowedTools = [...(opts.disallowedTools ?? []), ...(p.disallowedTools ?? [])]
    let stderrDetail = ''
    const claudeExecutable = sdkExecutableOverride(p.binaryPath)
    // Inherit an ALLOWLISTED environment (the user's own trusted CLI keeps PATH,
    // proxy, CA, locale, etc.; non-operational vars are dropped) with the runtime
    // node dir on PATH so an npm-shim CLI resolves a node, then add the BYOK key.
    const childEnv = childEnvFor(p.apiKey ? { ANTHROPIC_API_KEY: p.apiKey } : {})
    const options: Options = {
      cwd: p.cwd,
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      includePartialMessages: true,
      abortController: controllerFromSignal(p.signal),
      permissionMode: opts.permissionMode,
      stderr: (data) => {
        stderrDetail += data
      },
      // The SDK (and the underlying CLI) reject `bypassPermissions` unless this
      // safety flag is also set, so `full` mode would error without it. `full` is
      // already an explicit, UI-gated opt-in, so the bypass is intentional here.
      ...(opts.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
      ...claudeReasoningOptions(p.effort),
      ...(p.mcpServers ? { mcpServers: mapMcpServers(p.mcpServers) } : {}),
      ...(p.resume ? { resume: p.resume } : {}),
      env: childEnv,
      canUseTool: async (toolName, input) => {
        const decision = await p.requestPermission(toolName, input)
        return decision === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Denied by user' }
      }
    }
    try {
      for await (const message of query({ prompt: p.prompt, options })) {
        if (message.type === 'stream_event') {
          const text = extractTextDelta(message.event)
          if (text) yield { kind: 'text', text }
          const thinking = extractThinkingDelta(message.event)
          if (thinking) yield { kind: 'reasoning', text: thinking }
        } else if (message.type === 'assistant') {
          // The assistant message carries the turn's `tool_use` blocks - the only place
          // Claude surfaces which tools it invoked (auto-accepted edits never hit
          // `canUseTool`). Yield one tool part per call so the UI shows tool usage.
          for (const used of extractToolUses(message)) {
            yield { kind: 'tool', name: used.name, status: 'completed', detail: used.detail }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success') {
            // Spike D: surface the session id so a follow-up turn can resume.
            yield { kind: 'conversation', id: message.session_id }
            yield {
              kind: 'done',
              usage: {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens
              }
            }
          } else {
            yield {
              kind: 'error',
              message: withStderr(message.errors.join('; ') || message.subtype, stderrDetail)
            }
          }
        }
      }
    } catch (error) {
      if (p.signal.aborted) return
      yield {
        kind: 'error',
        message: withStderr(error instanceof Error ? error.message : String(error), stderrDetail)
      }
    }
  }
}

/**
 * INACTIVITY ceiling for a Codex run, in milliseconds. It resets on EVERY output line, so a run that
 * keeps emitting (tool calls, reasoning, text) streams for arbitrarily long - a task can run for
 * hours as long as it makes visible progress. The ceiling only fires when the child goes fully
 * SILENT for the whole window, which is a genuinely hung process (the sole guard the unattended
 * daemon has, since it has no run-level timeout). Sized very generously so a legitimate long silent
 * stretch - a big final generation over accumulated context (an observed heavy run peaked near 201s)
 * or a slow single tool step (a long build/command) - is never mistaken for a hang; interactive
 * chat also has a Stop button, so a user can always cancel sooner. After a terminal event a stall is
 * just the child being slow to close, so it is treated as a clean end, not an error.
 */
const CODEX_STALL_TIMEOUT_MS = 900_000

/**
 * Races the next stdout-line read against {@link CODEX_STALL_TIMEOUT_MS}. Resolves to the iterator
 * result when a line arrives, or the sentinel `'stalled'` when the ceiling elapses first. The timer
 * is always cleared so a completed read never leaks a pending timeout.
 *
 * @param read - The pending `iterator.next()` for the readline stream.
 * @returns The iterator result, or `'stalled'` on inactivity timeout.
 */
export function raceLineAgainstStall(
  read: Promise<IteratorResult<string>>
): Promise<IteratorResult<string> | 'stalled'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stall = new Promise<'stalled'>((resolve) => {
    timer = setTimeout(() => resolve('stalled'), CODEX_STALL_TIMEOUT_MS)
  })
  return Promise.race([read, stall]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Builds the Codex driver, driving the user's OWN installed `codex` via a per-run `codex app-server`
 * JSON-RPC stdio client (version-robust: the spawned CLI negotiates its own protocol, unlike a pinned
 * SDK talking a foreign binary). One `app-server` child is spawned per run; the driver does the
 * `initialize` handshake, opens (or `thread/resume`s - spike-D) a thread, starts a turn, and STREAMS
 * the answer token-by-token from `item/agentMessage/delta` notifications (no more buffering the whole
 * answer to completion, the point of this rewrite). It emits a `conversation` (the thread id) so a
 * follow-up turn can resume. Cancel maps to a graceful `turn/interrupt` before the child is torn down.
 * The inactivity watchdog recovers a genuinely hung run - but because deltas now arrive continuously,
 * a healthy long generation resets it constantly and never trips it. The child env is an allowlist
 * with the node dir on PATH; a BYOK key passes as `CODEX_API_KEY`, else the user's `~/.codex` login.
 */
function makeCodexDriver(spawnFn: SpawnFn): AgenticCliDriver {
  return async function* (p) {
    const posture = codexPosture(p.permissionMode)
    const effort = codexReasoningEffort(p.effort)
    // OS-enforced egress control (I2): `network: 'off'` (the unattended/dispatched default) sets the
    // per-turn sandbox `networkAccess: false`, so the sandbox actually blocks the run from the network
    // rather than merely recording the intent. Absent/`'on'` keeps the network-on default (interactive
    // parity). Hosted web search is DECOUPLED and always on (a server-side tool, confirmed to complete
    // with egress off), so an unattended run keeps egress blocked while web search still works.
    const networkEnabled = p.network !== 'off'
    const mcpServers = p.mcpServers ? mapCodexMcpServers(p.mcpServers) : undefined
    // A chat with no connected workspace has an empty `p.cwd`; the app-server needs a real cwd, so
    // fall back to the OS temp dir (a valid, writable, throwaway directory) - the run is chat-only.
    const runCwd = p.cwd && p.cwd.length > 0 ? p.cwd : tmpdir()
    const args = buildCodexAppServerArgs(
      mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}
    )
    codexTrace(
      'spawn',
      `bin=${p.binaryPath} cwd=${runCwd} sandbox=${posture.sandboxMode} net=${networkEnabled} mcp=${mcpServers ? Object.keys(mcpServers).length : 0}`
    )
    const child = spawnFn(p.binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Run inside the per-product work folder so process-relative file operations stay confined.
      cwd: runCwd,
      // Inherit an allowlisted env (PATH, proxy, CA, locale, ...) with the node dir on PATH, then add
      // the BYOK key as `CODEX_API_KEY`; subscription mode reads the user's `~/.codex` login instead.
      env: childEnvFor(p.apiKey ? { CODEX_API_KEY: p.apiKey } : {})
    })
    child.stdin?.on('error', () => {})
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    // Capture a non-abort spawn error (e.g. ENOENT); an aborted spawn is swallowed as teardown.
    let spawnError: Error | undefined
    child.on('error', (err: Error) => {
      spawnError = isAbortError(err) ? undefined : err
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

    let threadId: string | undefined
    let turnId: string | undefined
    let interruptSent = false
    // Cancel maps to a graceful `turn/interrupt` (the server finalizes the turn with
    // `status: interrupted`), then the per-run child is torn down - killing it is the definitive
    // cancel, while the interrupt lets the server flush the session rollout so a later resume is clean.
    const onAbort = (): void => {
      if (!interruptSent && threadId && turnId) {
        interruptSent = true
        writeMessage({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'turn/interrupt',
          params: { threadId, turnId }
        })
      }
      // Give the interrupt a tick to flush, then force teardown so a hung server cannot strand cancel.
      setImmediate(() => child.kill())
    }
    if (p.signal.aborted) onAbort()
    else p.signal.addEventListener('abort', onAbort, { once: true })

    const state = newCodexAppServerTurnState()
    let phase: 'init' | 'thread' | 'turn' | 'stream' = 'init'
    const initId = sendRequest('initialize', { clientInfo: { ...CODEX_APP_SERVER_CLIENT_INFO } })
    let threadReqId: number | undefined
    let turnReqId: number | undefined
    let sawTerminal = false

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
            codexTrace('stall', `phase=${phase}`)
            child.kill()
            void read.catch(() => {})
            if (p.signal.aborted) return
            yield {
              kind: 'error',
              message:
                'The model run stalled - no activity for 15 minutes. Try again; if it persists, update your Codex CLI.'
            }
            return
          }
          if (result.done) break
          const incoming = parseCodexAppServerLine(result.value)
          if (!incoming) continue
          if (incoming.kind === 'serverRequest') {
            // Non-interactive product run: acknowledge any server-side approval/tool request with an
            // empty result so the turn never blocks on an unanswered prompt (sandbox + approvalPolicy
            // never means none fire in practice; this is belt-and-suspenders).
            writeMessage({ jsonrpc: '2.0', id: incoming.id, result: {} })
            continue
          }
          if (incoming.kind === 'response') {
            if (incoming.error) {
              if (p.signal.aborted) return
              yield { kind: 'error', message: withStderr(incoming.error, stderr) }
              return
            }
            if (phase === 'init' && incoming.id === initId) {
              writeMessage({ jsonrpc: '2.0', method: 'initialized', params: {} })
              threadReqId = p.resume
                ? sendRequest('thread/resume', buildCodexThreadResumeParams(p.resume))
                : sendRequest(
                    'thread/start',
                    buildCodexThreadStartParams({
                      cwd: runCwd,
                      sandboxMode: posture.sandboxMode,
                      approvalPolicy: posture.approvalPolicy,
                      ...(p.model ? { model: p.model } : {})
                    })
                  )
              phase = 'thread'
            } else if (phase === 'thread' && incoming.id === threadReqId) {
              threadId = extractCodexThreadId(incoming.result)
              // Surface the thread id so a follow-up turn can resume (spike-D).
              if (threadId) yield { kind: 'conversation', id: threadId }
              turnReqId = sendRequest(
                'turn/start',
                buildCodexTurnStartParams({
                  threadId: threadId ?? '',
                  cwd: runCwd,
                  prompt: p.prompt,
                  sandboxMode: posture.sandboxMode,
                  networkAccessEnabled: networkEnabled,
                  ...(effort ? { effort } : {})
                })
              )
              phase = 'turn'
            } else if (phase === 'turn' && incoming.id === turnReqId) {
              turnId = extractCodexTurnId(incoming.result)
              phase = 'stream'
            }
            continue
          }
          // notification
          codexTrace('event', incoming.method)
          const { messages, outcome } = codexAppServerNotificationToMessages(
            incoming.method,
            incoming.params,
            state
          )
          for (const message of messages) yield message
          if (outcome) {
            sawTerminal = true
            // A failed turn already emitted its error; a completed/interrupted turn breaks to `done`.
            if (outcome === 'failed') return
            break
          }
        }
      }
      if (p.signal.aborted) return
      codexTrace(
        'end',
        `sawTerminal=${sawTerminal} emittedText=${state.emittedText} stderr=${stderr.trim().slice(-200)}`
      )
      if (spawnError) {
        yield { kind: 'error', message: withStderr(spawnError.message, stderr) }
        return
      }
      if (sawTerminal) {
        yield { kind: 'done', ...(state.usage ? { usage: state.usage } : {}) }
      } else {
        // stdout EOF before a terminal event = the app-server died mid-run.
        yield {
          kind: 'error',
          message: withStderr('Codex app-server exited before completing the turn', stderr)
        }
      }
    } catch (error) {
      // A cancelled run kills the child, which rejects the pending read; that is expected teardown,
      // not a run failure, so swallow it silently - the other drivers do the same. A genuine
      // (non-abort) failure still surfaces as an error.
      if (p.signal.aborted || isAbortError(error)) return
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

/**
 * Shared CLI-driver loop for the headless agentic CLIs (OpenCode): spawns the binary
 * with an allowlisted, node-on-PATH env, streams stdout as `text` messages, captures
 * stderr, honors abort silently (swallowing the `ABORT_ERR` `error` event - spike-A
 * carry-in 1), and maps the exit code onto a `done` / `error` message.
 *
 * @param spawnFn - The injected process spawner.
 * @param p - The run params (binary path, prompt, cwd, model, permission mode, signal).
 * @param config - The tool name and the per-tool argument-array builder.
 * @returns The normalized message stream.
 */
async function* streamCliTool(
  spawnFn: SpawnFn,
  p: AgenticCliDriverParams,
  config: {
    toolName: string
    buildArgs: (p: AgenticCliDriverParams) => string[]
    /** Per-tool env additions (e.g. a BYOK key) merged over the scrubbed env. */
    extraEnv?: (p: AgenticCliDriverParams) => Record<string, string>
  }
): AsyncGenerator<AgenticDriverMessage> {
  const child = spawnFn(p.binaryPath, config.buildArgs(p), {
    signal: p.signal,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Run inside the per-product work folder so process-relative file operations stay
    // confined; `--dir` is only a hint, the real confinement is the child's cwd.
    cwd: p.cwd,
    // Inherit an allowlisted env (the user's own trusted CLI keeps PATH, proxy, CA,
    // locale, ...; non-operational vars are dropped) with the node dir on PATH, then
    // add back the single credential the run needs - the same convention as Claude/Codex.
    env: childEnvFor(config.extraEnv?.(p) ?? {})
  })
  // Attach an `error` handler so a cancelled `spawn({ signal })` does not re-throw
  // `ABORT_ERR` as an uncaught exception. A non-abort error is captured and surfaced
  // after the exit-code resolution.
  let spawnError: Error | undefined
  child.on('error', (err: Error) => {
    spawnError = isAbortError(err) ? undefined : err
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exitCode = new Promise<number | null>((resolve) =>
    child.on('close', (code) => resolve(code))
  )

  try {
    if (child.stdout) {
      for await (const chunk of child.stdout) {
        const text = chunk.toString()
        if (text) yield { kind: 'text', text }
      }
    }
  } catch (error) {
    if (p.signal.aborted) return
    yield { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    return
  }

  if (p.signal.aborted) return
  const code = await exitCode
  // The abort may land while the exit code is resolving; an aborted run is silent.
  if (p.signal.aborted) return
  if (spawnError) {
    yield { kind: 'error', message: stderr.trim() || spawnError.message }
    return
  }
  if (code === 0) yield { kind: 'done' }
  else
    yield {
      kind: 'error',
      message: stderr.trim() || `${config.toolName} exited with code ${code ?? 'unknown'}`
    }
}

/**
 * Builds the OpenCode driver bound to the injected spawner. Drives `opencode run`,
 * streaming stdout; OpenCode has no resume primitive on this path, so `p.resume` is
 * ignored.
 */
function makeOpenCodeDriver(spawnFn: SpawnFn): AgenticCliDriver {
  return (p) =>
    streamCliTool(spawnFn, p, {
      toolName: 'opencode',
      buildArgs: (params) => {
        // Pass option values with `=` (attached, so a leading "-" can't be re-parsed as
        // a flag) and put the prompt after `--` so an untrusted prompt starting with "-"
        // can never smuggle CLI flags (e.g. --dangerously-skip-permissions). The prompt
        // is the only attacker-influenced value when a product forwards end-user input.
        const args = ['run', `--dir=${params.cwd}`]
        if (params.model) args.push(`--model=${params.model}`)
        // Read-only / auto-edit defer to OpenCode's own permission config; only the
        // explicit "full" posture (a deliberate UI opt-in, like Claude bypassPermissions
        // and Codex danger-full-access) auto-approves everything.
        if (params.permissionMode === 'full') args.push('--dangerously-skip-permissions')
        args.push('--', params.prompt)
        return args
      }
    })
}

/**
 * Builds the four agentic drivers from injected SDK/CLI seams. Production passes no
 * deps and gets the real `query` and `cross-spawn`; tests inject fakes so the
 * resume/conversation/abort behaviour is verified without spawning.
 *
 * @param deps - The injected SDK/CLI seams (each defaults to the real import).
 * @returns The Claude, Codex, OpenCode, and Hermes drivers.
 */
export function makeDrivers(deps: DriverDeps = {}): AgentDrivers {
  const query = deps.query ?? realQuery
  const spawnFn = deps.spawnFn ?? realSpawn
  return {
    claudeDriver: makeClaudeDriver(query),
    codexDriver: makeCodexDriver(spawnFn),
    openCodeDriver: makeOpenCodeDriver(spawnFn),
    hermesDriver: makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
  }
}
