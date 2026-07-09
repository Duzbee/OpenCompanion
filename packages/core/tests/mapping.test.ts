import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCodexAppServerArgs,
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  claudePermissionOptions,
  claudeReasoningOptions,
  codexAppServerItemToMessage,
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
  parseCodexAppServerLine,
  prependSystemPrompt,
  serializeCodexConfigOverrides
} from '../src/adapters/mapping'

describe('prependSystemPrompt', () => {
  it('prepends a system prompt above the user prompt for CLIs with no system channel', () => {
    expect(prependSystemPrompt('You are helpful.', 'write a haiku')).toBe(
      'You are helpful.\n\nwrite a haiku'
    )
  })

  it('returns the prompt unchanged when there is no system prompt', () => {
    expect(prependSystemPrompt(undefined, 'write a haiku')).toBe('write a haiku')
    expect(prependSystemPrompt('', 'write a haiku')).toBe('write a haiku')
  })
})

describe('claudePermissionOptions', () => {
  it('maps read-only to a hard non-destructive posture', () => {
    expect(claudePermissionOptions('read-only')).toEqual({
      permissionMode: 'dontAsk',
      allowedTools: ['Read', 'Glob', 'Grep'],
      disallowedTools: ['Edit', 'Write', 'Bash']
    })
  })
  it('maps auto-edit to acceptEdits and full to bypassPermissions', () => {
    expect(claudePermissionOptions('auto-edit')).toEqual({ permissionMode: 'acceptEdits' })
    expect(claudePermissionOptions('full')).toEqual({ permissionMode: 'bypassPermissions' })
  })
})

describe('codexPosture', () => {
  it('maps read-only to a read-only sandbox with no escalation', () => {
    expect(codexPosture('read-only')).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'never' })
  })
  it('maps auto-edit and full to write sandboxes', () => {
    expect(codexPosture('auto-edit')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never'
    })
    expect(codexPosture('full')).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never'
    })
  })
})

describe('mapMcpServers', () => {
  it('maps transport-neutral MCP specs to the Claude SDK shape', () => {
    const out = mapMcpServers({
      fs: { type: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { X: '1' } },
      web: { type: 'http', url: 'https://mcp.example.com' },
      live: { type: 'sse', url: 'https://sse.example.com' }
    })
    expect(out.fs).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server-fs'],
      env: { X: '1' }
    })
    expect(out.web).toEqual({ type: 'http', url: 'https://mcp.example.com' })
    expect(out.live).toEqual({ type: 'sse', url: 'https://sse.example.com' })
  })
  it('drops undefined optional fields for a bare stdio spec', () => {
    const out = mapMcpServers({ fs: { type: 'stdio', command: 'mcp-fs' } })
    expect(out.fs).toEqual({ type: 'stdio', command: 'mcp-fs' })
    expect(Object.keys(out.fs)).toEqual(['type', 'command'])
  })
})

describe('mapCodexMcpServers', () => {
  it('maps stdio specs to command/args/env and http/sse specs to a url', () => {
    const out = mapCodexMcpServers({
      fs: { type: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { X: '1' } },
      web: { type: 'http', url: 'http://127.0.0.1:1/t/mcp' },
      live: { type: 'sse', url: 'https://sse.example.com' }
    })
    // Every entry carries `default_tools_approval_mode: 'approve'` so Codex auto-approves the
    // app's MCP tools; without it a non-interactive run auto-cancels every call under a sandbox.
    expect(out.fs).toEqual({
      command: 'npx',
      args: ['-y', 'server-fs'],
      env: { X: '1' },
      default_tools_approval_mode: 'approve'
    })
    expect(out.web).toEqual({
      url: 'http://127.0.0.1:1/t/mcp',
      default_tools_approval_mode: 'approve'
    })
    expect(out.live).toEqual({
      url: 'https://sse.example.com',
      default_tools_approval_mode: 'approve'
    })
  })

  it('skips a stdio spec with no command and an http spec with no url', () => {
    const out = mapCodexMcpServers({
      bad: { type: 'stdio' },
      alsoBad: { type: 'http' }
    })
    expect(out).toEqual({})
  })
})

describe('extractTextDelta', () => {
  it('extracts text from a content_block_delta text_delta event', () => {
    expect(
      extractTextDelta({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })
    ).toBe('hi')
  })
  it('returns null for other event shapes', () => {
    expect(extractTextDelta({ type: 'message_start' })).toBeNull()
    expect(
      extractTextDelta({ type: 'content_block_delta', delta: { type: 'input_json_delta' } })
    ).toBeNull()
    expect(extractTextDelta(null)).toBeNull()
    expect(extractTextDelta('nope')).toBeNull()
  })
})

describe('extractThinkingDelta', () => {
  it('extracts thinking text from a thinking_delta event', () => {
    expect(
      extractThinkingDelta({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'hmm' }
      })
    ).toBe('hmm')
  })
  it('returns null for text deltas and other shapes', () => {
    expect(
      extractThinkingDelta({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hi' }
      })
    ).toBeNull()
    expect(extractThinkingDelta({ type: 'message_start' })).toBeNull()
    expect(extractThinkingDelta(null)).toBeNull()
  })
})

describe('claudeReasoningOptions', () => {
  it('leaves native behaviour for default/undefined', () => {
    expect(claudeReasoningOptions('default')).toEqual({})
    expect(claudeReasoningOptions(undefined)).toEqual({})
  })
  it('disables thinking for off', () => {
    expect(claudeReasoningOptions('off')).toEqual({ thinking: { type: 'disabled' } })
  })
  it('keeps adaptive thinking on and passes the named effort for low/medium/high', () => {
    expect(claudeReasoningOptions('high')).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'high'
    })
    expect(claudeReasoningOptions('low')).toEqual({ thinking: { type: 'adaptive' }, effort: 'low' })
  })
})

describe('codexReasoningEffort', () => {
  it('passes through low/medium/high and leaves default/off native (undefined)', () => {
    expect(codexReasoningEffort('medium')).toBe('medium')
    expect(codexReasoningEffort('high')).toBe('high')
    expect(codexReasoningEffort('default')).toBeUndefined()
    expect(codexReasoningEffort('off')).toBeUndefined()
    expect(codexReasoningEffort(undefined)).toBeUndefined()
  })
})

describe('codexAppServerItemToMessage', () => {
  it('maps a commandExecution to a tool message by status (independent of completion)', () => {
    const running = { id: '1', type: 'commandExecution', command: 'ls', status: 'inProgress' }
    expect(codexAppServerItemToMessage(running, false)).toEqual({
      kind: 'tool',
      name: 'command',
      status: 'started',
      detail: 'ls'
    })
    expect(codexAppServerItemToMessage({ ...running, status: 'completed' }, true)).toEqual({
      kind: 'tool',
      name: 'command',
      status: 'completed',
      detail: 'ls'
    })
    expect(codexAppServerItemToMessage({ ...running, status: 'failed' }, true)).toEqual({
      kind: 'tool',
      name: 'command',
      status: 'failed',
      detail: 'ls'
    })
  })

  it('maps a fileChange to a tool message listing each change, only on completion', () => {
    const item = {
      id: '2',
      type: 'fileChange',
      status: 'completed',
      changes: [
        { kind: 'add', path: 'a.ts' },
        { kind: 'update', path: 'b.ts' }
      ]
    }
    // The changes payload is final only on completion, so a started event emits nothing.
    expect(codexAppServerItemToMessage(item, false)).toBeNull()
    expect(codexAppServerItemToMessage(item, true)).toEqual({
      kind: 'tool',
      name: 'file_change',
      status: 'completed',
      detail: 'add a.ts, update b.ts'
    })
    expect(codexAppServerItemToMessage({ ...item, status: 'failed' }, true)).toEqual({
      kind: 'tool',
      name: 'file_change',
      status: 'failed',
      detail: 'add a.ts, update b.ts'
    })
  })

  it('maps a webSearch to a tool message once, on completion (the query is the detail)', () => {
    const item = { id: '4', type: 'webSearch', query: 'latest react release' }
    expect(codexAppServerItemToMessage(item, true)).toEqual({
      kind: 'tool',
      name: 'web_search',
      status: 'completed',
      detail: 'latest react release'
    })
    expect(codexAppServerItemToMessage(item, false)).toBeNull()
  })

  it('ignores agentMessage and reasoning items (the driver streams those from deltas)', () => {
    expect(
      codexAppServerItemToMessage({ id: '5', type: 'agentMessage', text: 'hello' }, true)
    ).toBeNull()
    expect(
      codexAppServerItemToMessage({ id: '3', type: 'reasoning', text: 'pondering' }, true)
    ).toBeNull()
  })

  it('surfaces an mcpToolCall as a tool chip so companion app-MCP tools (e.g. list_schedules) stream', () => {
    const running = {
      id: '6',
      type: 'mcpToolCall',
      server: 'companion',
      tool: 'list_schedules',
      status: 'inProgress'
    }
    expect(codexAppServerItemToMessage(running, false)).toEqual({
      kind: 'tool',
      name: 'list_schedules',
      status: 'started'
    })
    expect(codexAppServerItemToMessage({ ...running, status: 'completed' }, true)).toEqual({
      kind: 'tool',
      name: 'list_schedules',
      status: 'completed'
    })
    const failed = { ...running, status: 'failed', error: { message: 'boom' } }
    expect(codexAppServerItemToMessage(failed, true)).toEqual({
      kind: 'tool',
      name: 'list_schedules',
      status: 'failed',
      detail: 'boom'
    })
  })
})

describe('extractToolUses', () => {
  it('extracts tool_use blocks with a readable detail from an assistant message', () => {
    const filePath = join(tmpdir(), 'b.ts')
    const message = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'working' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
          { type: 'tool_use', name: 'Read', input: { file_path: filePath } }
        ]
      }
    }
    expect(extractToolUses(message)).toEqual([
      { name: 'Bash', detail: 'ls -la' },
      { name: 'Read', detail: filePath }
    ])
  })
  it('returns an empty array for non-assistant or malformed shapes', () => {
    expect(extractToolUses({ type: 'result' })).toEqual([])
    expect(extractToolUses({ type: 'assistant', message: { content: 'nope' } })).toEqual([])
    expect(extractToolUses(null)).toEqual([])
  })
})

describe('serializeCodexConfigOverrides', () => {
  it('flattens nested config into dotted key=tomlValue overrides (strings JSON-quoted)', () => {
    expect(
      serializeCodexConfigOverrides({
        approval_policy: 'never',
        sandbox_workspace_write: { network_access: false },
        web_search: 'live'
      })
    ).toEqual([
      'approval_policy="never"',
      'sandbox_workspace_write.network_access=false',
      'web_search="live"'
    ])
  })

  it('flattens an MCP server map into per-field overrides, arrays and env inline', () => {
    expect(
      serializeCodexConfigOverrides({
        mcp_servers: {
          fs: { command: 'npx', args: ['-y', 'server-fs'], env: { X: '1' }, default_tools_approval_mode: 'approve' },
          web: { url: 'http://127.0.0.1:1/t/mcp', default_tools_approval_mode: 'approve' }
        }
      })
    ).toEqual([
      'mcp_servers.fs.command="npx"',
      'mcp_servers.fs.args=["-y", "server-fs"]',
      'mcp_servers.fs.env.X="1"',
      'mcp_servers.fs.default_tools_approval_mode="approve"',
      'mcp_servers.web.url="http://127.0.0.1:1/t/mcp"',
      'mcp_servers.web.default_tools_approval_mode="approve"'
    ])
  })
})

describe('buildCodexAppServerArgs', () => {
  it('builds a stdio app-server spawn with plugins/apps disabled and web search live, no prompt', () => {
    const args = buildCodexAppServerArgs({})
    expect(args.slice(0, 5)).toEqual(['app-server', '--disable', 'plugins', '--disable', 'apps'])
    // The user's ChatGPT-account plugins/apps are dropped (predictable product toolset + stops the
    // context-bloat stall); our MCP tools, hosted web search, and Codex coding tools stay.
    expect(args.filter((a) => a === '--disable')).toHaveLength(2)
    expect(args).toContain('web_search="live"')
    // The prompt is sent over JSON-RPC, never argv, so a leading "-" can't be re-parsed as a flag.
    expect(args.some((a) => a.includes('--dangerous'))).toBe(false)
    // This is the app-server transport, not the old `codex exec` path.
    expect(args).not.toContain('exec')
  })

  it('injects app MCP servers as -c mcp_servers overrides (auto-approved)', () => {
    const args = buildCodexAppServerArgs({
      mcpServers: {
        companion: { url: 'http://127.0.0.1:1/t/mcp', default_tools_approval_mode: 'approve' }
      }
    })
    expect(args).toContain('mcp_servers.companion.url="http://127.0.0.1:1/t/mcp"')
    expect(args).toContain('mcp_servers.companion.default_tools_approval_mode="approve"')
  })
})

describe('buildCodexThreadStartParams / buildCodexThreadResumeParams', () => {
  it('sets cwd, approval policy, sandbox tier, and an optional model', () => {
    const dir = join(tmpdir(), 'work')
    expect(
      buildCodexThreadStartParams({ cwd: dir, sandboxMode: 'read-only', approvalPolicy: 'never' })
    ).toEqual({ cwd: dir, approvalPolicy: 'never', sandbox: 'read-only' })
    expect(
      buildCodexThreadStartParams({
        cwd: dir,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        model: 'gpt-5.5'
      })
    ).toEqual({ cwd: dir, approvalPolicy: 'never', sandbox: 'workspace-write', model: 'gpt-5.5' })
  })

  it('resume params carry the prior thread id (spike-D resume)', () => {
    expect(buildCodexThreadResumeParams('thread-9')).toEqual({ threadId: 'thread-9' })
  })
})

describe('buildCodexTurnStartParams', () => {
  it('sends the prompt as structured input and blocks egress under read-only network-off', () => {
    const dir = join(tmpdir(), 'work')
    const params = buildCodexTurnStartParams({
      threadId: 't1',
      cwd: dir,
      prompt: '--dangerous',
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      effort: 'high'
    })
    expect(params.threadId).toBe('t1')
    expect(params.cwd).toBe(dir)
    // The prompt is structured input, never argv, so a leading "-" cannot smuggle a flag.
    expect(params.input).toEqual([{ type: 'text', text: '--dangerous' }])
    expect(params.effort).toBe('high')
    // Network egress is OS-enforced off; hosted web search (a server-side tool) is unaffected.
    expect(params.sandboxPolicy).toEqual({
      type: 'readOnly',
      writableRoots: [],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    })
  })

  it('workspace-write grants the cwd as a writable root and honors network on', () => {
    const dir = join(tmpdir(), 'work')
    const params = buildCodexTurnStartParams({
      threadId: 't1',
      cwd: dir,
      prompt: 'hi',
      sandboxMode: 'workspace-write',
      networkAccessEnabled: true
    })
    expect(params.sandboxPolicy).toMatchObject({
      type: 'workspaceWrite',
      writableRoots: [dir],
      networkAccess: true
    })
    // No effort key when effort is omitted.
    expect('effort' in params).toBe(false)
  })

  it('danger-full-access is an unrestricted sandbox policy', () => {
    const params = buildCodexTurnStartParams({
      threadId: 't1',
      cwd: join(tmpdir(), 'w'),
      prompt: 'hi',
      sandboxMode: 'danger-full-access',
      networkAccessEnabled: true
    })
    expect(params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
  })
})

describe('parseCodexAppServerLine', () => {
  it('classifies responses, server requests, and notifications', () => {
    expect(
      parseCodexAppServerLine('{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"tn"}}}')
    ).toEqual({ kind: 'response', id: 3, result: { turn: { id: 'tn' } } })
    expect(parseCodexAppServerLine('{"jsonrpc":"2.0","id":4,"error":{"message":"boom"}}')).toEqual({
      kind: 'response',
      id: 4,
      error: 'boom'
    })
    // A method WITH an id is a server->client request (e.g. an approval) we must answer.
    expect(
      parseCodexAppServerLine(
        '{"jsonrpc":"2.0","id":9,"method":"item/commandExecution/requestApproval","params":{}}'
      )
    ).toEqual({ kind: 'serverRequest', id: 9, method: 'item/commandExecution/requestApproval' })
    // A method WITHOUT an id is a streamed notification.
    expect(
      parseCodexAppServerLine(
        '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hi"}}'
      )
    ).toEqual({ kind: 'notification', method: 'item/agentMessage/delta', params: { delta: 'hi' } })
  })

  it('skips blank and non-JSON lines', () => {
    expect(parseCodexAppServerLine('   ')).toBeNull()
    expect(parseCodexAppServerLine('not json')).toBeNull()
  })
})

describe('extractCodexThreadId / extractCodexTurnId', () => {
  it('reads the thread/turn id from a reply, or undefined', () => {
    expect(extractCodexThreadId({ thread: { id: 'th-1' } })).toBe('th-1')
    expect(extractCodexThreadId({})).toBeUndefined()
    expect(extractCodexTurnId({ turn: { id: 'tn-1' } })).toBe('tn-1')
    expect(extractCodexTurnId({ turn: {} })).toBeUndefined()
  })
})

describe('codexAppServerNotificationToMessages', () => {
  it('streams agentMessage deltas by item id and marks emittedText', () => {
    const state = newCodexAppServerTurnState()
    const d1 = codexAppServerNotificationToMessages(
      'item/agentMessage/delta',
      { itemId: 'a', delta: 'Hello' },
      state
    )
    expect(d1.messages).toEqual([{ kind: 'text', text: 'Hello' }])
    const d2 = codexAppServerNotificationToMessages(
      'item/agentMessage/delta',
      { itemId: 'a', delta: ' world' },
      state
    )
    // Same item id: append with no separator (token deltas never duplicate).
    expect(d2.messages).toEqual([{ kind: 'text', text: ' world' }])
    // A new item id is a distinct block: its first delta gets a blank-line separator.
    const d3 = codexAppServerNotificationToMessages(
      'item/agentMessage/delta',
      { itemId: 'b', delta: 'Second' },
      state
    )
    expect(d3.messages).toEqual([{ kind: 'text', text: '\n\nSecond' }])
    expect(state.emittedText).toBe(true)
  })

  it('streams reasoning deltas', () => {
    const state = newCodexAppServerTurnState()
    expect(
      codexAppServerNotificationToMessages('item/reasoning/textDelta', { delta: 'thinking' }, state)
        .messages
    ).toEqual([{ kind: 'reasoning', text: 'thinking' }])
  })

  it('emits a completed agentMessage as text only when no delta streamed for it (backstop)', () => {
    const streamed = newCodexAppServerTurnState()
    codexAppServerNotificationToMessages(
      'item/agentMessage/delta',
      { itemId: 'a', delta: 'streamed' },
      streamed
    )
    // The completed item for the same id is a no-op (deltas already carried the text).
    expect(
      codexAppServerNotificationToMessages(
        'item/completed',
        { item: { id: 'a', type: 'agentMessage', text: 'streamed' } },
        streamed
      ).messages
    ).toEqual([])
    // A version that never streamed deltas: the completed item's full text is the backstop.
    const noStream = newCodexAppServerTurnState()
    expect(
      codexAppServerNotificationToMessages(
        'item/completed',
        { item: { id: 'z', type: 'agentMessage', text: 'final answer' } },
        noStream
      ).messages
    ).toEqual([{ kind: 'text', text: 'final answer' }])
  })

  it('captures per-turn usage from thread/tokenUsage/updated (last bucket over total)', () => {
    const state = newCodexAppServerTurnState()
    const out = codexAppServerNotificationToMessages(
      'thread/tokenUsage/updated',
      {
        tokenUsage: {
          total: { inputTokens: 99, outputTokens: 99 },
          last: { inputTokens: 12, outputTokens: 4 }
        }
      },
      state
    )
    expect(out.messages).toEqual([])
    expect(state.usage).toEqual({ inputTokens: 12, outputTokens: 4 })
  })

  it('ends the turn on turn/completed and surfaces a failed turn as an error', () => {
    const state = newCodexAppServerTurnState()
    expect(
      codexAppServerNotificationToMessages(
        'turn/completed',
        { turn: { id: 't', status: 'completed' } },
        state
      )
    ).toEqual({ messages: [], outcome: 'completed' })
    // An interrupted turn also ends cleanly (the driver swallows it when its signal is aborted).
    expect(
      codexAppServerNotificationToMessages(
        'turn/completed',
        { turn: { status: 'interrupted' } },
        state
      )
    ).toEqual({ messages: [], outcome: 'completed' })
    expect(
      codexAppServerNotificationToMessages(
        'turn/completed',
        { turn: { status: 'failed', error: { message: 'model error' } } },
        state
      )
    ).toEqual({ messages: [{ kind: 'error', message: 'model error' }], outcome: 'failed' })
  })

  it('surfaces turn/failed and error notifications as failed', () => {
    const state = newCodexAppServerTurnState()
    expect(
      codexAppServerNotificationToMessages('turn/failed', { error: { message: 'nope' } }, state)
    ).toEqual({ messages: [{ kind: 'error', message: 'nope' }], outcome: 'failed' })
    expect(codexAppServerNotificationToMessages('error', { message: 'fatal' }, state)).toEqual({
      messages: [{ kind: 'error', message: 'fatal' }],
      outcome: 'failed'
    })
  })

  it('defers non-agent items to codexAppServerItemToMessage (e.g. an MCP tool chip)', () => {
    const state = newCodexAppServerTurnState()
    const out = codexAppServerNotificationToMessages(
      'item/completed',
      {
        item: {
          id: 'm',
          type: 'mcpToolCall',
          server: 'companion',
          tool: 'list_schedules',
          status: 'completed'
        }
      },
      state
    )
    expect(out.messages).toEqual([{ kind: 'tool', name: 'list_schedules', status: 'completed' }])
  })
})
