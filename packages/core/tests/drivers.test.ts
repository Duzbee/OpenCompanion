// D-B (Phase 2): the engine driver stays policy-agnostic. Codex defaults network ON
// (interactive); unattended/dispatched callers pass network: 'off'. Claude delegates
// tool permission to the injected requestPermission; the tauri host injects an
// auto-allow policy to match the desktop app's auto-allow posture.
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgenticCliDriverParams,
  AgenticDriverMessage,
  ClaudeDriverParams
} from '../src/adapters/types'
import {
  forwardOverride,
  makeDrivers,
  sdkExecutableOverride,
  type ClaudeQuery,
  type SpawnFn
} from '../src/drivers'

const cwd = join(tmpdir(), 'drivers-x')

/** Drains an async-iterable driver into an array of normalized messages. */
async function drain(
  driver: AsyncIterable<AgenticDriverMessage>
): Promise<AgenticDriverMessage[]> {
  const out: AgenticDriverMessage[] = []
  for await (const m of driver) out.push(m)
  return out
}

function claudeParams(over: Partial<ClaudeDriverParams> = {}): ClaudeDriverParams {
  return {
    prompt: 'hi',
    cwd,
    binaryPath: '/usr/local/bin/claude',
    permissionMode: 'read-only',
    signal: new AbortController().signal,
    requestPermission: async () => 'allow',
    ...over
  }
}

function cliParams(over: Partial<AgenticCliDriverParams> = {}): AgenticCliDriverParams {
  return {
    prompt: 'hi',
    cwd,
    binaryPath: '/usr/local/bin/opencode',
    permissionMode: 'read-only',
    signal: new AbortController().signal,
    ...over
  }
}

describe('forwardOverride', () => {
  it('off Windows returns the path unchanged (always usable)', () => {
    expect(forwardOverride('/usr/local/bin/claude', 'darwin')).toBe('/usr/local/bin/claude')
    expect(forwardOverride('/usr/local/bin/claude', 'linux')).toBe('/usr/local/bin/claude')
  })

  it('on Windows forwards a native exe or a shim (.cmd/.ps1/.bat), undefined for a bare path', () => {
    expect(forwardOverride('C:\\tools\\claude.exe', 'win32')).toBe('C:\\tools\\claude.exe')
    expect(forwardOverride('C:\\tools\\claude.cmd', 'win32')).toBe('C:\\tools\\claude.cmd')
    expect(forwardOverride('C:\\tools\\claude.ps1', 'win32')).toBe('C:\\tools\\claude.ps1')
    expect(forwardOverride('C:\\tools\\claude.bat', 'win32')).toBe('C:\\tools\\claude.bat')
    expect(forwardOverride('C:\\tools\\claude', 'win32')).toBeUndefined()
  })

  it('sdkExecutableOverride delegates to forwardOverride with the live platform', () => {
    const result = sdkExecutableOverride('/usr/local/bin/claude')
    expect(result).toBe(forwardOverride('/usr/local/bin/claude', process.platform))
  })
})

/** A fake `query` async-iterable yielding the supplied SDK messages, capturing options. */
function fakeQuery(
  messages: unknown[],
  capture: { options?: unknown }
): ClaudeQuery {
  return ((params: { prompt: string | AsyncIterable<unknown>; options?: unknown }) => {
    capture.options = params.options
    return (async function* () {
      for (const m of messages) yield m
    })()
  }) as unknown as ClaudeQuery
}

describe('claudeDriver', () => {
  it('yields a conversation (session_id) then done on a successful result', async () => {
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-42',
          usage: { input_tokens: 11, output_tokens: 4 }
        }
      ],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    const out = await drain(claudeDriver(claudeParams()))
    expect(out).toEqual([
      { kind: 'conversation', id: 'sess-42' },
      { kind: 'done', usage: { inputTokens: 11, outputTokens: 4 } }
    ])
  })

  it('sets options.resume only when p.resume is supplied', async () => {
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(claudeDriver(claudeParams({ resume: 'prev-session' })))
    expect((capture.options as { resume?: string }).resume).toBe('prev-session')

    const capture2: { options?: unknown } = {}
    const query2 = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture2
    )
    const { claudeDriver: cd2 } = makeDrivers({ query: query2 })
    await drain(cd2(claudeParams()))
    expect((capture2.options as { resume?: string }).resume).toBeUndefined()
  })

  it('passes the BYOK key through the child env as ANTHROPIC_API_KEY', async () => {
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(claudeDriver(claudeParams({ apiKey: 'sk-byok' })))
    const env = (capture.options as { env?: Record<string, string> }).env
    expect(env?.ANTHROPIC_API_KEY).toBe('sk-byok')
  })

  it('delegates tool permission to the injected requestPermission (deny -> behavior deny)', async () => {
    // D-B lock: canUseTool is policy-agnostic - it forwards the SDK's (toolName, input) to the
    // injected requestPermission and maps the decision, rather than hardcoding allow/deny. A host
    // (tauri auto-allow, desktop) supplies the policy. Here a 'deny' decision yields behavior 'deny'.
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const requestPermission = vi.fn(async (): Promise<'allow' | 'deny'> => 'deny')
    const { claudeDriver } = makeDrivers({ query })
    await drain(claudeDriver(claudeParams({ requestPermission })))
    const canUseTool = (
      capture.options as {
        canUseTool: (name: string, input: unknown) => Promise<{ behavior: 'allow' | 'deny' }>
      }
    ).canUseTool
    const decision = await canUseTool('Bash', { command: 'rm -rf /' })
    expect(requestPermission).toHaveBeenCalledWith('Bash', { command: 'rm -rf /' })
    expect(decision).toMatchObject({ behavior: 'deny' })
  })
})

/** One JSON-RPC message pushed to / read from the fake app-server. */
type RpcMessage = Record<string, unknown>

/**
 * A fake `codex app-server` child: it parses the JSON-RPC requests the driver writes to stdin and
 * answers them on stdout (initialize -> thread/start -> turn/start), then streams the scripted turn
 * notifications. `turn/interrupt` is answered and finalizes the turn as `interrupted`. Records every
 * request so a test can assert the handshake, the turn/start params, and cancel.
 */
class FakeAppServer extends EventEmitter {
  stdout = new PassThrough()
  stderr = new EventEmitter()
  killed = false
  requests: { method: string; params: unknown; id?: number }[] = []
  private buf = ''
  constructor(
    private opts: {
      threadId?: string
      turnId?: string
      notifications?: unknown[]
      threadError?: string
      turnError?: string
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
      }
    }
  }
  private respond(method: string, id: number): void {
    const threadId = this.opts.threadId ?? 'thread-1'
    const turnId = this.opts.turnId ?? 'turn-1'
    if (method === 'initialize') {
      this.push({ jsonrpc: '2.0', id, result: { userAgent: 'codex/0.142.3', codexHome: '/h/.codex' } })
    } else if (method === 'thread/start' || method === 'thread/resume') {
      if (this.opts.threadError) {
        this.push({ jsonrpc: '2.0', id, error: { message: this.opts.threadError } })
        return
      }
      this.push({ jsonrpc: '2.0', id, result: { thread: { id: threadId } } })
      this.push({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: threadId } } })
    } else if (method === 'turn/start') {
      if (this.opts.turnError) {
        this.push({ jsonrpc: '2.0', id, error: { message: this.opts.turnError } })
        return
      }
      this.push({ jsonrpc: '2.0', id, result: { turn: { id: turnId } } })
      for (const n of this.opts.notifications ?? []) this.push(n as RpcMessage)
    } else if (method === 'turn/interrupt') {
      this.push({ jsonrpc: '2.0', id, result: {} })
      this.push({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { turn: { id: turnId, status: 'interrupted' } }
      })
    } else {
      this.push({ jsonrpc: '2.0', id, result: {} })
    }
  }
  kill(): void {
    this.killed = true
    this.stdout.end()
  }
}

/** The standard tail of a successful turn: an agentMessage delta then a completed turn with usage. */
function successNotifications(text = 'hello world'): unknown[] {
  return [
    { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: text } },
    {
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { last: { inputTokens: 9, outputTokens: 3 } } }
    },
    {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } }
    }
  ]
}

/** Builds an injected spawnFn returning `child`, plus a recorder of the spawn call. */
function fakeSpawn(child: EventEmitter): {
  spawnFn: SpawnFn
  callArgs: () => { bin: string; args: string[]; opts: { env?: Record<string, string>; cwd?: string } }
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

/** Reads the recorded `turn/start` request params (the structured prompt input + sandbox policy). */
function turnStartParams(child: FakeAppServer): Record<string, unknown> {
  const req = child.requests.find((r) => r.method === 'turn/start')
  return (req?.params ?? {}) as Record<string, unknown>
}

describe('codexDriver', () => {
  it('runs the initialize -> thread -> turn handshake and streams conversation, text, and done', async () => {
    const child = new FakeAppServer({ threadId: 'thread-7', notifications: successNotifications() })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out).toEqual([
      { kind: 'conversation', id: 'thread-7' },
      { kind: 'text', text: 'hello world' },
      { kind: 'done', usage: { inputTokens: 9, outputTokens: 3 } }
    ])
    // The handshake order is exactly initialize -> initialized -> thread/start -> turn/start.
    expect(child.requests.map((r) => r.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start'
    ])
  })

  it('streams agent text token-by-token as separate deltas arrive (no buffering to completion)', async () => {
    const child = new FakeAppServer({
      notifications: [
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Hel' } },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'lo' } },
        { jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    // Two distinct text deltas (not one dump), then done - the point of the app-server rewrite.
    expect(out.filter((m) => m.kind === 'text')).toEqual([
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'lo' }
    ])
    expect(out.at(-1)?.kind).toBe('done')
  })

  it('resumes a prior thread via thread/resume (never thread/start) when p.resume is set', async () => {
    const child = new FakeAppServer({ threadId: 'thread-77', notifications: successNotifications() })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', resume: 'thread-77' })))
    const methods = child.requests.map((r) => r.method)
    expect(methods).toContain('thread/resume')
    expect(methods).not.toContain('thread/start')
    const resume = child.requests.find((r) => r.method === 'thread/resume')
    expect(resume?.params).toEqual({ threadId: 'thread-77' })
  })

  it('sends the prompt as structured turn/start input, never as a spawn argument', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', prompt: '--dangerous' })))
    // The prompt is never an argument, so a leading "-" can't be re-parsed as a flag.
    expect(callArgs().args).not.toContain('--dangerous')
    expect(turnStartParams(child).input).toEqual([{ type: 'text', text: '--dangerous' }])
  })

  it('spawns `app-server` with plugins/apps disabled and hosted web search live', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    const { args } = callArgs()
    expect(args.slice(0, 5)).toEqual(['app-server', '--disable', 'plugins', '--disable', 'apps'])
    expect(args).toContain('web_search="live"')
  })

  it('blocks sandbox egress when network is off but keeps hosted web search live (server-side)', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', network: 'off' })))
    // Egress is off in the per-turn sandbox policy; hosted web search (a server-side tool) stays on.
    expect(turnStartParams(child).sandboxPolicy).toMatchObject({ networkAccess: false })
    expect(callArgs().args).toContain('web_search="live"')
  })

  it('enables sandbox egress when network is on; web search stays live either way', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', network: 'on' })))
    expect(turnStartParams(child).sandboxPolicy).toMatchObject({ networkAccess: true })
    expect(callArgs().args).toContain('web_search="live"')
  })

  it('defaults sandbox egress ON when network is unset (D-B: network only off when off)', async () => {
    // D-B lock: `network` unset yields `networkAccessEnabled: true` (drivers.ts networkEnabled =
    // p.network !== 'off'), so an interactive run reaches the network unless a caller opts out with
    // network: 'off'. Observed via the per-turn sandboxPolicy the driver sends to turn/start.
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(turnStartParams(child).sandboxPolicy).toMatchObject({ networkAccess: true })
  })

  it('falls back to the OS temp dir for the child cwd and turn cwd when no workspace is connected', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', cwd: '' })))
    expect(callArgs().opts.cwd).toBe(tmpdir())
    expect(turnStartParams(child).cwd).toBe(tmpdir())
  })

  it('passes the BYOK key through the child env as CODEX_API_KEY', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', apiKey: 'sk-codex' })))
    expect(callArgs().opts.env?.CODEX_API_KEY).toBe('sk-codex')
  })

  it('threads MCP servers into -c mcp_servers overrides (auto-approved)', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(
      codexDriver(
        cliParams({
          binaryPath: '/usr/local/bin/codex',
          mcpServers: { companion: { type: 'http', url: 'http://127.0.0.1:1/t/mcp' } }
        })
      )
    )
    const { args } = callArgs()
    expect(args).toContain('mcp_servers.companion.url="http://127.0.0.1:1/t/mcp"')
    expect(args).toContain('mcp_servers.companion.default_tools_approval_mode="approve"')
  })

  it('surfaces an MCP tool chip and still completes to done', async () => {
    const child = new FakeAppServer({
      notifications: [
        {
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            item: { id: 'm', type: 'mcpToolCall', server: 's', tool: 'list', status: 'completed' }
          }
        },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'done' } },
        { jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out).toContainEqual({ kind: 'tool', name: 'list', status: 'completed' })
    expect(out.at(-1)?.kind).toBe('done')
  })

  it('emits done even when a turn completes with no agent text (empty backstop)', async () => {
    const child = new FakeAppServer({
      notifications: [
        { jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out.at(-1)?.kind).toBe('done')
    expect(out.some((m) => m.kind === 'error')).toBe(false)
  })

  it('surfaces a failed turn as an error and does not also emit done', async () => {
    const child = new FakeAppServer({
      notifications: [
        {
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { turn: { status: 'failed', error: { message: 'model error' } } }
        }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out).toContainEqual({ kind: 'error', message: 'model error' })
    expect(out.some((m) => m.kind === 'done')).toBe(false)
  })

  it('surfaces a handshake request error (e.g. thread/start) as an error', async () => {
    const child = new FakeAppServer({ threadError: 'not signed in' })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out.some((m) => m.kind === 'error' && m.message.includes('not signed in'))).toBe(true)
  })

  it('cancels via turn/interrupt and swallows the abort (no error, no done)', async () => {
    // A turn that streams a delta but never completes on its own; the abort must interrupt it.
    const child = new FakeAppServer({
      notifications: [
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'partial' } }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const controller = new AbortController()
    const collected: AgenticDriverMessage[] = []
    for await (const m of codexDriver(
      cliParams({ binaryPath: '/usr/local/bin/codex', signal: controller.signal })
    )) {
      collected.push(m)
      // Cancel as soon as the first streamed token arrives (the turn id is known by now).
      if (m.kind === 'text') controller.abort()
    }
    // The driver sent a graceful turn/interrupt, and the abort is swallowed (teardown, not failure).
    expect(child.requests.some((r) => r.method === 'turn/interrupt')).toBe(true)
    expect(collected.some((m) => m.kind === 'error')).toBe(false)
    expect(collected.some((m) => m.kind === 'done')).toBe(false)
  })

  it('yields a stall error when no message arrives within the inactivity ceiling', async () => {
    vi.useFakeTimers()
    try {
      // An app-server that never answers the initialize handshake - a genuinely hung run.
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
      const { codexDriver } = makeDrivers({ spawnFn })
      const collected: AgenticDriverMessage[] = []
      const done = (async () => {
        for await (const m of codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' }))) {
          collected.push(m)
        }
      })()

      // Let the driver reach the first line read, then cross the 15-minute ceiling.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(900_000)
      await done

      expect(collected).toHaveLength(1)
      expect(collected[0]).toMatchObject({ kind: 'error' })
      expect(collected[0]).toMatchObject({ message: expect.stringContaining('stalled') })
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A minimal fake child process the injected spawnFn returns. */
class FakeChild extends EventEmitter {
  stdout: AsyncGenerator<Buffer> | null
  stderr = new EventEmitter()
  constructor(stdoutChunks: Buffer[]) {
    super()
    this.stdout = (async function* () {
      for (const c of stdoutChunks) yield c
    })()
  }
}

describe('openCodeDriver abort handling', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('swallows an ABORT_ERR child error (no error message, no unhandled rejection)', async () => {
    const unhandled = vi.fn()
    process.once('unhandledRejection', unhandled)

    const child = new FakeChild([])
    const spawnFn = vi.fn(() => child) as unknown as (typeof import('cross-spawn'))['default']
    const { openCodeDriver } = makeDrivers({ spawnFn })

    const controller = new AbortController()
    const iterable = openCodeDriver(cliParams({ signal: controller.signal }))
    const collected: AgenticDriverMessage[] = []
    const consume = (async () => {
      for await (const m of iterable) collected.push(m)
    })()

    // Simulate cross-spawn surfacing the aborted-spawn error.
    queueMicrotask(() => {
      controller.abort()
      child.emit('error', Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))
      child.emit('close', null)
    })

    await consume
    await new Promise((r) => setTimeout(r, 10))
    process.removeListener('unhandledRejection', unhandled)

    expect(collected.some((m) => m.kind === 'error')).toBe(false)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('surfaces a non-abort child error as an error message', async () => {
    const child = new FakeChild([])
    const spawnFn = vi.fn(() => child) as unknown as (typeof import('cross-spawn'))['default']
    const { openCodeDriver } = makeDrivers({ spawnFn })

    const iterable = openCodeDriver(cliParams())
    const collected: AgenticDriverMessage[] = []
    const consume = (async () => {
      for await (const m of iterable) collected.push(m)
    })()

    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      child.emit('close', 1)
    })

    await consume
    expect(collected.some((m) => m.kind === 'error' && m.message.includes('spawn ENOENT'))).toBe(
      true
    )
  })

  it('maps a clean exit (code 0) to done', async () => {
    const child = new FakeChild([Buffer.from('working')])
    const spawnFn = vi.fn(() => child) as unknown as (typeof import('cross-spawn'))['default']
    const { openCodeDriver } = makeDrivers({ spawnFn })

    const iterable = openCodeDriver(cliParams())
    const collected: AgenticDriverMessage[] = []
    const consume = (async () => {
      for await (const m of iterable) collected.push(m)
    })()

    queueMicrotask(() => {
      child.emit('close', 0)
    })

    await consume
    expect(collected).toContainEqual({ kind: 'text', text: 'working' })
    expect(collected.at(-1)).toEqual({ kind: 'done' })
  })

  it('spawns inside the run cwd so process-relative ops stay confined (--dir is only a hint)', async () => {
    const child = new FakeChild([])
    const spawnFn = vi.fn(() => child) as unknown as (typeof import('cross-spawn'))['default']
    const { openCodeDriver } = makeDrivers({ spawnFn })

    const runCwd = join(tmpdir(), 'confined-work')
    const iterable = openCodeDriver(cliParams({ cwd: runCwd }))
    const consume = (async () => {
      for await (const _m of iterable) {
        /* drain */
      }
    })()

    queueMicrotask(() => {
      child.emit('close', 0)
    })

    await consume
    expect(spawnFn).toHaveBeenCalledTimes(1)
    const options = vi.mocked(spawnFn).mock.calls[0][2] as { cwd?: string }
    expect(options.cwd).toBe(runCwd)
  })
})
