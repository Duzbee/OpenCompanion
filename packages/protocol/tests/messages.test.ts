import { describe, expect, it } from 'vitest'
import {
  ConnectInstructionSchema,
  ConnectResultBodySchema,
  RunCancelSchema,
  RunStartSchema,
  ToolCallSchema,
  ToolResultSchema,
  type RunStart
} from '../src/messages'

describe('DOWN message schemas', () => {
  it('parses a valid run.start', () => {
    const msg = RunStartSchema.parse({
      type: 'run.start',
      runId: 'r1',
      agentId: 'a1',
      productId: 'p1',
      userId: 'u1',
      connectionId: 'c1',
      input: 'do the thing',
      systemPrompt: 'grounded prompt',
      modelId: 'claude-x',
      effort: 'high',
      webToolManifest: [{ name: 'knowledge_search', description: 'search', inputSchema: { type: 'object' } }],
      policy: { permissionMode: 'read-only', network: 'off' }
    })
    expect(msg.type).toBe('run.start')
    expect(msg.runId).toBe('r1')
    expect(msg.effort).toBe('high')
  })

  it('rejects a run.start whose effort is not a known reasoning level', () => {
    expect(() =>
      RunStartSchema.parse({
        type: 'run.start',
        runId: 'r1',
        agentId: 'a1',
        productId: 'p1',
        userId: 'u1',
        connectionId: 'c1',
        input: 'do the thing',
        effort: 'ludicrous',
        webToolManifest: []
      })
    ).toThrow()
  })

  it('parses a run.cancel', () => {
    const msg = RunCancelSchema.parse({ type: 'run.cancel', runId: 'r1' })
    expect(msg.type).toBe('run.cancel')
  })

  it('parses a tool.result reply', () => {
    const msg = ToolResultSchema.parse({ type: 'tool.result', runId: 'r1', callId: 'k1', ok: true, result: 'rows' })
    expect(msg.type).toBe('tool.result')
  })

  it('rejects a run.start missing runId', () => {
    expect(() => RunStartSchema.parse({ type: 'run.start', agentId: 'a1' })).toThrow()
  })

  it('rejects a non-object payload', () => {
    expect(() => RunStartSchema.parse('not-an-object')).toThrow()
    expect(() => RunStartSchema.parse(null)).toThrow()
  })
})

describe('RunStart JSON round-trip', () => {
  it('a run.start with a webToolManifest survives serialize -> parse unchanged', () => {
    const original: RunStart = {
      type: 'run.start',
      runId: 'r1',
      agentId: 'a1',
      productId: 'p1',
      userId: 'u1',
      connectionId: 'c1',
      input: 'do the thing',
      systemPrompt: 'grounded prompt',
      modelId: 'claude-x',
      conversationId: 'thread-1',
      webToolManifest: [
        {
          name: 'knowledge_search',
          description: 'search the knowledge base',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      ],
      mcpServers: { docs: { type: 'http', url: 'http://127.0.0.1:7777' } },
      policy: { permissionMode: 'auto-edit', network: 'off' }
    }
    const round = RunStartSchema.parse(JSON.parse(JSON.stringify(original)))
    expect(round).toEqual(original)
  })

  it('carries an optional scheduleId for a scheduled companion run (PARITY-D)', () => {
    const msg = RunStartSchema.parse({
      type: 'run.start',
      runId: 'r1',
      agentId: 'a1',
      productId: 'p1',
      userId: 'u1',
      connectionId: 'c1',
      input: 'run the schedule',
      scheduleId: 'sched-42',
      webToolManifest: []
    })
    expect(msg.scheduleId).toBe('sched-42')
  })

  it('leaves scheduleId undefined for an ad-hoc run.start', () => {
    const msg = RunStartSchema.parse({
      type: 'run.start',
      runId: 'r1',
      agentId: 'a1',
      productId: 'p1',
      userId: 'u1',
      connectionId: 'c1',
      input: 'do the thing',
      webToolManifest: []
    })
    expect(msg.scheduleId).toBeUndefined()
  })
})

describe('ToolCallSchema', () => {
  it('parses a valid tool.call UP message', () => {
    const msg = ToolCallSchema.parse({
      type: 'tool.call',
      runId: 'r1',
      callId: 'k1',
      name: 'knowledge_search',
      args: { query: 'pricing' }
    })
    expect(msg.name).toBe('knowledge_search')
    expect(msg.args).toEqual({ query: 'pricing' })
  })

  it('rejects a tool.call missing the callId correlation id', () => {
    expect(() => ToolCallSchema.parse({ type: 'tool.call', runId: 'r1', name: 'x', args: {} })).toThrow()
  })

  it('rejects a tool.call whose name is empty', () => {
    expect(() => ToolCallSchema.parse({ type: 'tool.call', runId: 'r1', callId: 'k1', name: '', args: {} })).toThrow()
  })
})

describe('connect instruction + result shapes', () => {
  it('accepts a valid connect instruction and rejects a missing/empty field', () => {
    expect(
      ConnectInstructionSchema.safeParse({ requestId: 'r1', toolId: 'codex', install: false }).success
    ).toBe(true)
    expect(ConnectInstructionSchema.safeParse({ requestId: '', toolId: 'codex', install: false }).success).toBe(false)
    expect(ConnectInstructionSchema.safeParse({ requestId: 'r1', toolId: 'codex' }).success).toBe(false)
  })

  it('accepts each result status and rejects an unknown one', () => {
    for (const status of ['connected', 'needs-login', 'installed-needs-login', 'not-installed', 'failed']) {
      expect(ConnectResultBodySchema.safeParse({ toolId: 'codex', status }).success).toBe(true)
    }
    expect(ConnectResultBodySchema.safeParse({ toolId: 'codex', status: 'logged-in' }).success).toBe(false)
  })

  it('accepts the optional result fields together', () => {
    const parsed = ConnectResultBodySchema.safeParse({
      toolId: 'claude-code',
      status: 'connected',
      authHealth: 'healthy',
      connections: [{ toolId: 'claude-code', authHealth: 'healthy' }]
    })
    expect(parsed.success).toBe(true)
  })
})
