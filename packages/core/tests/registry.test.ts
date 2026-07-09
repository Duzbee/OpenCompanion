import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@opencompanion/core'
import {
  buildAgentRuntimeRegistry,
  detectInstalled,
  type AgentRuntimeRegistryDeps
} from '../src/registry'

/** Builds the registry deps with overridable fakes (no electron, no config). */
function deps(over: Partial<AgentRuntimeRegistryDeps> = {}): AgentRuntimeRegistryDeps {
  return {
    resolveBinary: () => null,
    loadApiKey: () => null,
    listRegistryModels: async (): Promise<ModelInfo[]> => [],
    runTool: async () => ({ code: 0, stdout: '' }),
    ...over
  }
}

describe('buildAgentRuntimeRegistry', () => {
  it('exposes exactly the four agentic adapters in order', () => {
    const registry = buildAgentRuntimeRegistry(deps())
    expect(registry.getAdapters().map((a) => a.id)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'hermes'
    ])
  })

  it('looks up an adapter by id', () => {
    const registry = buildAgentRuntimeRegistry(deps())
    expect(registry.getAdapter('codex')?.displayName).toBe('Codex')
    expect(registry.getAdapter('claude-code')?.displayName).toBe('Claude Code')
    expect(registry.getAdapter('opencode')?.displayName).toBe('OpenCode')
    expect(registry.getAdapter('hermes')?.displayName).toBe('Hermes Agent')
  })

  it('returns undefined for an unknown adapter and never builds completion/gemini', () => {
    const registry = buildAgentRuntimeRegistry(deps())
    expect(registry.getAdapter('gemini')).toBeUndefined()
    expect(registry.getAdapter('anthropic')).toBeUndefined()
    expect(registry.getAdapter('nope')).toBeUndefined()
  })

  it('requireAdapter throws for an unknown id', () => {
    const registry = buildAgentRuntimeRegistry(deps())
    expect(() => registry.requireAdapter('nope')).toThrow(/nope/)
    expect(registry.requireAdapter('codex').id).toBe('codex')
  })

  it('builds adapters whose detect resolves through the injected resolveBinary/runTool', async () => {
    const registry = buildAgentRuntimeRegistry(
      deps({
        resolveBinary: (name) => `/bin/${name}`,
        runTool: async () => ({ code: 0, stdout: '1.2.3' })
      })
    )
    const detected = await registry.getAdapter('claude-code')?.detect()
    expect(detected).toEqual({ installed: true, version: '1.2.3', path: '/bin/claude' })
  })
})

describe('detectInstalled', () => {
  it('returns a record keyed by the four adapter ids using the injected resolvers', async () => {
    const resolveBinary = vi.fn((name: string) => `/bin/${name}`)
    const registry = buildAgentRuntimeRegistry(
      deps({ resolveBinary, runTool: async () => ({ code: 0, stdout: 'v' }) })
    )
    const result = await detectInstalled(registry)
    expect(Object.keys(result).sort()).toEqual(['claude-code', 'codex', 'hermes', 'opencode'])
    expect(result['codex']).toEqual({ installed: true, version: 'v', path: '/bin/codex' })
    expect(result['hermes']).toEqual({ installed: true, version: 'v', path: '/bin/hermes' })
    expect(resolveBinary).toHaveBeenCalledWith('claude')
    expect(resolveBinary).toHaveBeenCalledWith('codex')
    expect(resolveBinary).toHaveBeenCalledWith('opencode')
    expect(resolveBinary).toHaveBeenCalledWith('hermes')
  })

  it('reports not installed when a binary cannot be resolved', async () => {
    const registry = buildAgentRuntimeRegistry(deps({ resolveBinary: () => null }))
    const result = await detectInstalled(registry)
    expect(result['claude-code']).toEqual({ installed: false })
  })
})
