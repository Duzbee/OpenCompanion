import { describe, expect, it, vi } from 'vitest'
import type { McpServerSpec } from '@opencompanion/core'
import { mcpServersToToolsWith, type McpClientLike } from '../src/mcp-tools'

/** Builds a fake MCP client exposing one tool, so no process or network is touched. */
function fakeClient(): McpClientLike & {
  listTools: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const listTools = vi.fn<McpClientLike['listTools']>(async () => ({
    tools: [
      {
        name: 'search',
        description: 'd',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
      }
    ]
  }))
  const callTool = vi.fn<McpClientLike['callTool']>(async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }))
  const close = vi.fn<McpClientLike['close']>(async () => {})
  return { listTools, callTool, close }
}

const servers: Record<string, McpServerSpec> = { web: { type: 'http', url: 'https://x' } }

describe('mcpServersToToolsWith', () => {
  it('wraps each MCP tool as an AI SDK tool that calls back into the client', async () => {
    const client = fakeClient()
    const { tools } = await mcpServersToToolsWith(servers, () => client)
    expect(Object.keys(tools)).toEqual(['search'])
    await tools.search.execute?.({ q: 'hi' }, { toolCallId: '1', messages: [] })
    expect(client.callTool).toHaveBeenCalledWith({ name: 'search', arguments: { q: 'hi' } })
  })

  it('close() closes every created client', async () => {
    const clients = [fakeClient(), fakeClient()]
    let i = 0
    const two: Record<string, McpServerSpec> = {
      a: { type: 'http', url: 'https://a' },
      b: { type: 'http', url: 'https://b' }
    }
    const { close } = await mcpServersToToolsWith(two, () => clients[i++])
    await close()
    expect(clients[0].close).toHaveBeenCalledOnce()
    expect(clients[1].close).toHaveBeenCalledOnce()
  })

  it('keeps same-named tools from two servers, routing each to its own client', async () => {
    const clients = [fakeClient(), fakeClient()]
    let i = 0
    const two: Record<string, McpServerSpec> = {
      a: { type: 'http', url: 'https://a' },
      b: { type: 'http', url: 'https://b' }
    }
    const { tools } = await mcpServersToToolsWith(two, () => clients[i++])
    expect(Object.keys(tools).sort()).toEqual(['b_search', 'search'])
    await tools.search.execute?.({ q: 'first' }, { toolCallId: '1', messages: [] })
    await tools.b_search.execute?.({ q: 'second' }, { toolCallId: '2', messages: [] })
    expect(clients[0].callTool).toHaveBeenCalledWith({ name: 'search', arguments: { q: 'first' } })
    expect(clients[1].callTool).toHaveBeenCalledWith({ name: 'search', arguments: { q: 'second' } })
  })

  it('returns an empty tool set for no servers', async () => {
    const { tools, close } = await mcpServersToToolsWith({}, () => fakeClient())
    expect(tools).toEqual({})
    await expect(close()).resolves.toBeUndefined()
  })

  it('closes already-started clients when tool discovery fails, then rethrows', async () => {
    const ok = fakeClient()
    const failing = fakeClient()
    failing.listTools.mockRejectedValueOnce(new Error('tools/list failed'))
    const clients = [ok, failing]
    let i = 0
    const two: Record<string, McpServerSpec> = {
      a: { type: 'http', url: 'https://a' },
      b: { type: 'http', url: 'https://b' }
    }
    // A discovery failure would otherwise leak the first client's child process; it must be closed.
    await expect(mcpServersToToolsWith(two, () => clients[i++])).rejects.toThrow('tools/list failed')
    expect(ok.close).toHaveBeenCalledOnce()
    expect(failing.close).toHaveBeenCalledOnce()
  })
})
