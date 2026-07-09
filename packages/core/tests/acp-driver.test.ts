import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { HERMES_ACP_CONFIG, makeAcpDriver, probeAcpAuth } from '../src/acp-driver'
import type { SpawnFn } from '../src/drivers'
import type { AgenticCliDriverParams, AgenticDriverMessage } from '../src/adapters/types'
import {
  INITIALIZE_RESULT,
  INITIALIZE_RESULT_UNAUTH,
  MESSAGE_CHUNK,
  NEW_SESSION_RESULT,
  PERMISSION_REQUEST,
  PERMISSION_REQUEST_ALLOW_ONLY,
  SESSION_ID,
  THOUGHT_CHUNK,
  TOOL_CALL,
  TOOL_CALL_UPDATE,
  TOOL_CALL_UPDATE_IN_PROGRESS,
  USAGE_UPDATE
} from './fixtures/hermes-acp/frames'

const cwd = join(tmpdir(), 'acp-driver-x')

/** Drains an async-iterable driver into an array of normalized messages. */
async function drain(
  driver: AsyncIterable<AgenticDriverMessage>
): Promise<AgenticDriverMessage[]> {
  const out: AgenticDriverMessage[] = []
  for await (const m of driver) out.push(m)
  return out
}

/** Builds run params with sane defaults; overrides win. */
function acpParams(over: Partial<AgenticCliDriverParams> = {}): AgenticCliDriverParams {
  return {
    prompt: 'hi',
    cwd,
    binaryPath: '/usr/local/bin/hermes',
    permissionMode: 'read-only',
    signal: new AbortController().signal,
    ...over
  }
}

/** One JSON-RPC message read from / written to the fake ACP agent. */
type RpcMessage = Record<string, unknown>

/**
 * A fake `hermes acp` child: it parses the JSON-RPC requests the driver writes to stdin and answers
 * them on stdout (initialize -> session/new|session/load -> session/set_mode? -> session/prompt),
 * then streams the scripted prompt frames and a `{stopReason}` result. Records every request the
 * driver sends and every response it writes to an agent request (e.g. a permission answer), so a
 * test can assert the handshake order, the mcpServers payload, set_mode, cancel, and the permission
 * auto-answer.
 */
class FakeAcpAgent extends EventEmitter {
  stdout = new PassThrough()
  stderr = new EventEmitter()
  killed = false
  /** Every request/notification the DRIVER sent to the agent (method + params). */
  requests: { method: string; params: unknown; id?: number }[] = []
  /** Every response the DRIVER wrote to an agent-initiated request (e.g. permission answer). */
  answers: RpcMessage[] = []
  private buf = ''
  constructor(
    private opts: {
      initializeResult?: unknown
      initializeError?: string
      newSessionResult?: unknown
      newSessionError?: string
      /** Frames replayed as notifications during a `session/load`, before its `{}` response. */
      loadFrames?: unknown[]
      /** Frames pushed during a `session/prompt`, before the `{stopReason}` response. */
      promptFrames?: unknown[]
      stopReason?: string
      /** When true, stream the prompt frames then EOF the child instead of responding. */
      killAfterPrompt?: boolean
      /** When true, stream the prompt frames but never send the prompt response (cancel path). */
      neverResolvePrompt?: boolean
    } = {}
  ) {
    super()
  }
  stdin = {
    on: (): void => {},
    end: (): void => {},
    write: (data: string, cb?: (error?: Error | null) => void): boolean => {
      this.onData(data)
      cb?.()
      return true
    }
  }
  private push(msg: RpcMessage): void {
    if (!this.killed) this.stdout.write(`${JSON.stringify(msg)}\n`)
  }
  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg: RpcMessage
      try {
        msg = JSON.parse(line) as RpcMessage
      } catch {
        continue
      }
      if (typeof msg.method === 'string' && msg.id !== undefined) {
        this.requests.push({ method: msg.method, params: msg.params, id: msg.id as number })
        this.respond(msg.method, msg.id as number)
      } else if (typeof msg.method === 'string') {
        this.requests.push({ method: msg.method, params: msg.params })
      } else if (msg.id !== undefined) {
        // A response the driver wrote to an agent-initiated request (permission answer).
        this.answers.push(msg)
      }
    }
  }
  private respond(method: string, id: number): void {
    if (method === 'initialize') {
      if (this.opts.initializeError) {
        this.push({ jsonrpc: '2.0', id, error: { code: -32000, message: this.opts.initializeError } })
        return
      }
      this.push({ jsonrpc: '2.0', id, result: this.opts.initializeResult ?? INITIALIZE_RESULT })
    } else if (method === 'session/new') {
      if (this.opts.newSessionError) {
        this.push({ jsonrpc: '2.0', id, error: { code: -32000, message: this.opts.newSessionError } })
        return
      }
      this.push({ jsonrpc: '2.0', id, result: this.opts.newSessionResult ?? NEW_SESSION_RESULT })
    } else if (method === 'session/load') {
      for (const f of this.opts.loadFrames ?? []) this.push(f as RpcMessage)
      this.push({ jsonrpc: '2.0', id, result: {} })
    } else if (method === 'session/set_mode') {
      this.push({ jsonrpc: '2.0', id, result: {} })
    } else if (method === 'session/prompt') {
      for (const f of this.opts.promptFrames ?? []) this.push(f as RpcMessage)
      if (this.opts.killAfterPrompt) {
        this.kill()
        return
      }
      if (this.opts.neverResolvePrompt) return
      this.push({ jsonrpc: '2.0', id, result: { stopReason: this.opts.stopReason ?? 'end_turn' } })
    } else {
      this.push({ jsonrpc: '2.0', id, result: {} })
    }
  }
  kill(): void {
    this.killed = true
    this.stdout.end()
  }
}

/** Builds an injected spawnFn returning `child`, plus a recorder of the spawn call. */
function fakeSpawn(child: EventEmitter): {
  spawnFn: SpawnFn
  callArgs: () => {
    bin: string
    args: string[]
    opts: { env?: Record<string, string>; cwd?: string }
  }
} {
  const fn = vi.fn(() => child)
  return {
    spawnFn: fn as unknown as SpawnFn,
    callArgs: () => {
      const call = vi.mocked(fn).mock.calls[0] as unknown as [
        string,
        string[],
        { env?: Record<string, string>; cwd?: string }
      ]
      return { bin: call[0], args: call[1], opts: call[2] }
    }
  }
}

/** Reads the params of the first request the driver sent with `method`. */
function requestParams(child: FakeAcpAgent, method: string): Record<string, unknown> {
  const req = child.requests.find((r) => r.method === method)
  return (req?.params ?? {}) as Record<string, unknown>
}

describe('makeAcpDriver', () => {
  it('maps a happy-path run to conversation + reasoning + text + tool + done', async () => {
    const child = new FakeAcpAgent({
      promptFrames: [THOUGHT_CHUNK, MESSAGE_CHUNK, TOOL_CALL, TOOL_CALL_UPDATE, USAGE_UPDATE]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out).toEqual([
      { kind: 'conversation', id: SESSION_ID },
      { kind: 'reasoning', text: 'The' },
      { kind: 'text', text: 'Zephyr' },
      { kind: 'tool', name: 'mcp__generatesaas_app_tools__codename_lookup', status: 'started' },
      { kind: 'tool', name: 'mcp__generatesaas_app_tools__codename_lookup', status: 'completed' },
      { kind: 'done' }
    ])
    // The handshake is exactly initialize -> session/new -> session/prompt (no set_mode in read-only).
    expect(child.requests.map((r) => r.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt'
    ])
  })

  it('sends the prompt as a structured session/prompt input, never as a spawn argument', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ prompt: '--dangerous' })))
    expect(callArgs().args).not.toContain('--dangerous')
    expect(requestParams(child, 'session/prompt').prompt).toEqual([
      { type: 'text', text: '--dangerous' }
    ])
  })

  it('spawns with the configured binaryArgs and the run cwd (falling back to tmpdir when empty)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ cwd: '' })))
    expect(callArgs().args).toEqual(['acp', '--accept-hooks'])
    expect(callArgs().opts.cwd).toBe(tmpdir())
  })

  it('forwards an http MCP server into the session/new request as an ACP http entry', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(
      driver(
        acpParams({
          mcpServers: { app: { type: 'http', url: 'http://127.0.0.1:9/t/mcp' } }
        })
      )
    )
    expect(requestParams(child, 'session/new').mcpServers).toEqual([
      { type: 'http', name: 'app', url: 'http://127.0.0.1:9/t/mcp', headers: [] }
    ])
  })

  it('passes an empty mcpServers array when no servers are configured', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams()))
    expect(requestParams(child, 'session/new').mcpServers).toEqual([])
  })

  it('sends session/set_mode with the mapped id when it differs from the current mode', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'auto-edit' })))
    expect(requestParams(child, 'session/set_mode')).toEqual({
      sessionId: SESSION_ID,
      modeId: 'accept_edits'
    })
  })

  it('omits session/set_mode when the mapped id equals the current mode', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'read-only' })))
    expect(child.requests.some((r) => r.method === 'session/set_mode')).toBe(false)
  })

  it('resumes via session/load and suppresses the replayed history frames', async () => {
    const replayed = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION_ID,
        update: { content: { text: 'OLD', type: 'text' }, sessionUpdate: 'agent_message_chunk' }
      }
    }
    const live = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION_ID,
        update: { content: { text: 'NEW', type: 'text' }, sessionUpdate: 'agent_message_chunk' }
      }
    }
    const child = new FakeAcpAgent({ loadFrames: [replayed], promptFrames: [live] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams({ resume: SESSION_ID })))
    const methods = child.requests.map((r) => r.method)
    expect(methods).toContain('session/load')
    expect(methods).not.toContain('session/new')
    expect(requestParams(child, 'session/load').sessionId).toBe(SESSION_ID)
    // The replayed 'OLD' chunk is suppressed (arrives before the prompt); only the live 'NEW' is emitted.
    const texts = out.filter((m): m is { kind: 'text'; text: string } => m.kind === 'text')
    expect(texts).toEqual([{ kind: 'text', text: 'NEW' }])
    expect(out).toContainEqual({ kind: 'conversation', id: SESSION_ID })
    expect(out.at(-1)).toEqual({ kind: 'done' })
  })

  it('auto-answers a permission request by rejecting in read-only mode', async () => {
    const child = new FakeAcpAgent({ promptFrames: [PERMISSION_REQUEST, MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'read-only' })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } }
    })
  })

  it('auto-answers a permission request by allowing in auto-edit mode', async () => {
    const child = new FakeAcpAgent({ promptFrames: [PERMISSION_REQUEST, MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'auto-edit' })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
  })

  it('cancels an allow-only permission request in read-only mode (never auto-allows a mutation)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [PERMISSION_REQUEST_ALLOW_ONLY, MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'read-only' })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'cancelled' } }
    })
  })

  it('ignores an intermediate in_progress tool update (a running tool is not reported finished)', async () => {
    const child = new FakeAcpAgent({
      promptFrames: [TOOL_CALL, TOOL_CALL_UPDATE_IN_PROGRESS, TOOL_CALL_UPDATE, MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    const tools = out.filter((m) => m.kind === 'tool')
    expect(tools).toEqual([
      { kind: 'tool', name: 'mcp__generatesaas_app_tools__codename_lookup', status: 'started' },
      { kind: 'tool', name: 'mcp__generatesaas_app_tools__codename_lookup', status: 'completed' }
    ])
  })

  it('cancels via session/cancel on abort and returns silently (no done, no error)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK], neverResolvePrompt: true })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const controller = new AbortController()
    const collected: AgenticDriverMessage[] = []
    for await (const m of driver(acpParams({ signal: controller.signal }))) {
      collected.push(m)
      if (m.kind === 'text') controller.abort()
    }
    expect(child.requests.some((r) => r.method === 'session/cancel')).toBe(true)
    expect(collected.some((m) => m.kind === 'done')).toBe(false)
    expect(collected.some((m) => m.kind === 'error')).toBe(false)
  })

  it('treats a cancelled stopReason as a silent terminal (no done, no error)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK], stopReason: 'cancelled' })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out).toContainEqual({ kind: 'text', text: 'Zephyr' })
    expect(out.some((m) => m.kind === 'done')).toBe(false)
    expect(out.some((m) => m.kind === 'error')).toBe(false)
  })

  it('surfaces an unexpected stopReason as an error and never also emits done', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK], stopReason: 'refusal' })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out).toContainEqual({ kind: 'error', message: 'The agent run ended: refusal' })
    expect(out.some((m) => m.kind === 'done')).toBe(false)
  })

  it('surfaces a handshake error (e.g. session/new not signed in) as an error', async () => {
    const child = new FakeAcpAgent({ newSessionError: 'not signed in' })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out.some((m) => m.kind === 'error' && m.message.includes('not signed in'))).toBe(true)
    expect(out.some((m) => m.kind === 'done')).toBe(false)
  })

  it('surfaces child death before a terminal stopReason as an error', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK], killAfterPrompt: true })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out).toContainEqual({ kind: 'text', text: 'Zephyr' })
    expect(out.some((m) => m.kind === 'error')).toBe(true)
    expect(out.some((m) => m.kind === 'done')).toBe(false)
  })

  it('surfaces a spawn error (ENOENT) as an error', async () => {
    const child = new FakeAcpAgent()
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const collected: AgenticDriverMessage[] = []
    const consume = (async () => {
      for await (const m of driver(acpParams())) collected.push(m)
    })()
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      child.kill()
    })
    await consume
    expect(collected.some((m) => m.kind === 'error' && m.message.includes('spawn ENOENT'))).toBe(
      true
    )
  })

  it('yields a stall error when no message arrives within the inactivity ceiling', async () => {
    vi.useFakeTimers()
    try {
      const child = new (class extends EventEmitter {
        stdin = { on: (): void => {}, end: (): void => {}, write: (): boolean => true }
        stdout = Readable.from(
          (async function* () {
            await new Promise<void>(() => {})
          })()
        )
        stderr = new EventEmitter()
        kill(): void {}
      })()
      const { spawnFn } = fakeSpawn(child)
      const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
      const collected: AgenticDriverMessage[] = []
      const done = (async () => {
        for await (const m of driver(acpParams())) collected.push(m)
      })()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(900_000)
      await done
      expect(collected).toHaveLength(1)
      expect(collected[0]).toMatchObject({ kind: 'error' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('probeAcpAuth', () => {
  it('reports authenticated when the agent advertises a non-terminal auth method', async () => {
    const child = new FakeAcpAgent({ initializeResult: INITIALIZE_RESULT })
    const { spawnFn } = fakeSpawn(child)
    const result = await probeAcpAuth(spawnFn, '/usr/local/bin/hermes', ['acp'])
    expect(result.authenticated).toBe(true)
  })

  it('reports unauthenticated when only a terminal setup method is advertised', async () => {
    const child = new FakeAcpAgent({ initializeResult: INITIALIZE_RESULT_UNAUTH })
    const { spawnFn } = fakeSpawn(child)
    const result = await probeAcpAuth(spawnFn, '/usr/local/bin/hermes', ['acp'])
    expect(result.authenticated).toBe(false)
  })

  it('rejects (throws) on a spawn error rather than reporting unauthenticated', async () => {
    // A child that never answers `initialize` (models an ENOENT spawn: the process object exists but
    // emits `error` and produces no stdout), so the probe is still pending when the error fires.
    const child = new (class extends EventEmitter {
      stdin = { on: (): void => {}, end: (): void => {}, write: (): boolean => true }
      stdout = new PassThrough()
      stderr = new EventEmitter()
      kill(): void {}
    })()
    const { spawnFn } = fakeSpawn(child)
    const probe = probeAcpAuth(spawnFn, '/usr/local/bin/hermes', ['acp'])
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    })
    await expect(probe).rejects.toThrow('spawn ENOENT')
  })

  it('rejects (throws) when the agent never answers within the probe timeout', async () => {
    vi.useFakeTimers()
    try {
      // A child that never responds to `initialize`: the probe must THROW on timeout (absence of
      // evidence), not resolve as unauthenticated - Task 2's authStatus relies on this throw.
      const child = new (class extends EventEmitter {
        stdin = { on: (): void => {}, end: (): void => {}, write: (): boolean => true }
        stdout = new PassThrough()
        stderr = new EventEmitter()
        kill(): void {}
      })()
      const { spawnFn } = fakeSpawn(child)
      const probe = probeAcpAuth(spawnFn, '/usr/local/bin/hermes', ['acp'])
      const assertion = expect(probe).rejects.toThrow('timed out')
      // Cross the 15s probe ceiling so the timeout fires.
      await vi.advanceTimersByTimeAsync(15_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
