import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLIENT_ID, resolveBackendUrl } from '../src/backend-url'
import { createStateStore, type StateStore } from '../src/storage/state-store'

/** A fresh temp app-data dir under the OS temp root (the state-store test pattern). */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-backend-url-'))
}

/** A real state store with the given backend URLs pre-paired, in insertion order. */
function stateWith(urls: string[]): StateStore {
  const store = createStateStore({ cwd: freshDir() })
  urls.forEach((backendUrl, i) => store.upsertPairedBackend({ backendUrl, deviceId: `d${i}` }))
  return store
}

describe('resolveBackendUrl', () => {
  it('exports the wire-frozen default client id', () => {
    expect(DEFAULT_CLIENT_ID).toBe('companion')
  })

  it('returns the explicit --url even when it matches no pairing', async () => {
    const state = stateWith(['https://a.example', 'https://b.example'])
    await expect(
      resolveBackendUrl('https://explicit.example', state, { interactive: false })
    ).resolves.toBe('https://explicit.example')
  })

  it('auto-selects the sole paired backend when no --url is given', async () => {
    const state = stateWith(['https://only.example'])
    await expect(resolveBackendUrl(undefined, state, { interactive: false })).resolves.toBe(
      'https://only.example'
    )
  })

  it('throws the pair hint when nothing is paired and no --url is given', async () => {
    const state = stateWith([])
    await expect(resolveBackendUrl(undefined, state, { interactive: false })).rejects.toThrow(
      "Not paired with any backend. Run 'opencompanion pair --url <backend>' first."
    )
  })

  it('throws the --url hint when several are paired and non-interactive', async () => {
    const state = stateWith(['https://a.example', 'https://b.example'])
    await expect(resolveBackendUrl(undefined, state, { interactive: false })).rejects.toThrow(
      'Multiple backends are paired. Pass --url <backend>.'
    )
  })

  it('resolves via the injected prompt when several are paired and interactive', async () => {
    const state = stateWith(['https://a.example', 'https://b.example'])
    const prompt = vi.fn(async (urls: string[]) => urls.find((u) => u.includes('b.example'))!)
    await expect(resolveBackendUrl(undefined, state, { interactive: true, prompt })).resolves.toBe(
      'https://b.example'
    )
    expect(prompt).toHaveBeenCalledWith(
      expect.arrayContaining(['https://a.example', 'https://b.example'])
    )
  })

  it('throws the --url hint when interactive is allowed but no prompt is injected', async () => {
    const state = stateWith(['https://a.example', 'https://b.example'])
    await expect(resolveBackendUrl(undefined, state, { interactive: true })).rejects.toThrow(
      'Multiple backends are paired. Pass --url <backend>.'
    )
  })
})
