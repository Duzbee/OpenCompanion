import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionRef } from '@opencompanion/core'
import {
  createOpenCodeAdapter,
  type OpenCodeAdapterDeps
} from '../src/adapters/opencode'
import type { AgenticCliDriverParams, AgenticDriverMessage } from '../src/adapters/types'
import { makeRunContext, type RunContextResolvers } from '../src/context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../src/runtime-types'

const cwd = join(tmpdir(), 'opencode-x')

function makeAdapter(over: Partial<OpenCodeAdapterDeps> = {}): RuntimeToolAdapter {
  const deps: OpenCodeAdapterDeps = {
    driver: async function* () {
      /* yields nothing */
    },
    resolveBinary: () => '/usr/local/bin/opencode',
    loadApiKey: () => null,
    listRegistryModels: async () => [],
    runTool: async () => ({ code: 0, stdout: 'opencode 1.17.7' }),
    ...over
  }
  return createOpenCodeAdapter(deps)
}

const collect = (): { events: RuntimeRunEvent[]; emit: (e: RuntimeRunEvent) => void } => {
  const events: RuntimeRunEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

const ctx = makeRunContext({ productId: 'p', userId: 'u', cwd })
const resolvers: RunContextResolvers = {
  loadApiKey: () => null,
  resolveBinary: () => '/usr/local/bin/opencode'
}

const subConn: ConnectionRef = { id: 'c1', toolId: 'opencode', authMode: 'subscription' }

const baseReq: RuntimeRunRequest = {
  connectionId: 'c1',
  prompt: 'hi',
  cwd,
  permissionMode: 'read-only'
}

describe('opencode adapter', () => {
  it('is subscription-only (manages its own provider auth)', () => {
    expect(makeAdapter().capabilities.supportedAuthModes).toEqual(['subscription'])
  })

  it('reports not installed when the binary is missing', async () => {
    expect(await makeAdapter({ resolveBinary: () => null }).detect()).toEqual({ installed: false })
  })

  it('lists models from `opencode models` output, parsing provider/model lines', async () => {
    const adapter = makeAdapter({
      runTool: async () => ({
        code: 0,
        stdout: 'anthropic/claude-sonnet-4-6\nopenai/gpt-5.5\n# comment\n'
      })
    })
    const models = await adapter.listModels(subConn)
    expect(models).toEqual([
      { id: 'anthropic/claude-sonnet-4-6', source: 'tool' },
      { id: 'openai/gpt-5.5', source: 'tool' }
    ])
  })

  it('falls back to a curated model list when the binary is missing', async () => {
    const models = await makeAdapter({ resolveBinary: () => null }).listModels(subConn)
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.source === 'fallback')).toBe(true)
  })

  it('streams text and done from the driver', async () => {
    const messages: AgenticDriverMessage[] = [{ kind: 'text', text: 'working' }, { kind: 'done' }]
    const adapter = makeAdapter({
      driver: async function* () {
        for (const m of messages) yield m
      }
    })
    const sink = collect()
    adapter.run(baseReq, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(sink.events).toEqual([
      { type: 'delta', text: 'working' },
      { type: 'done', usage: undefined }
    ])
  })

  it('prepends the run system prompt to the prompt the driver receives', async () => {
    let capturedPrompt: string | undefined
    const adapter = makeAdapter({
      driver: async function* (params) {
        capturedPrompt = params.prompt
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    adapter.run({ ...baseReq, systemPrompt: 'You are X' }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(capturedPrompt).toBe('You are X\n\nhi')
  })

  it('ignores conversationId (OpenCode has no resume on this path)', async () => {
    let capturedResume: string | undefined = 'sentinel'
    const adapter = makeAdapter({
      driver: async function* (params: AgenticCliDriverParams) {
        capturedResume = params.resume
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    adapter.run({ ...baseReq, conversationId: 'ignored' }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(capturedResume).toBeUndefined()
  })

  it('emits an error when the binary cannot be resolved at run time', () => {
    const sink = collect()
    makeAdapter().run(
      baseReq,
      ctx,
      { resolveBinary: () => null, loadApiKey: () => null },
      sink.emit
    )
    expect(sink.events).toEqual([{ type: 'error', message: 'OpenCode is not installed' }])
  })
})
