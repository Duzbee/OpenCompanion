import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStateStore } from '../src/storage/state-store'

/** A fresh temp app-data dir under the OS temp root. */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'opencompanion-state-'))
}

const BACKEND = 'https://buyer.example'

describe('state store', () => {
  it('generates a stable device id once and reuses it', () => {
    const store = createStateStore({ cwd: freshDir() })
    const first = store.getDeviceId()
    expect(first).toMatch(/[0-9a-f-]{36}/)
    expect(store.getDeviceId()).toBe(first)
  })

  it('persists the device id across store instances (atomic conf write)', () => {
    const dir = freshDir()
    const deviceId = createStateStore({ cwd: dir }).getDeviceId()
    expect(createStateStore({ cwd: dir }).getDeviceId()).toBe(deviceId)
  })

  it('upserts and reads a paired backend', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertPairedBackend({ backendUrl: BACKEND, deviceId: 'd1', companionId: 'c1' })
    expect(store.getPairedBackend(BACKEND)).toEqual({
      backendUrl: BACKEND,
      deviceId: 'd1',
      companionId: 'c1'
    })
    expect(store.listPairedBackends()).toHaveLength(1)
  })

  it('records and lists per-CLI connections under a backend', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertConnection(BACKEND, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    store.upsertConnection(BACKEND, { toolId: 'codex', source: 'installed', authHealth: 'needs-reauth' })
    expect(store.getConnection(BACKEND, 'claude-code')?.authHealth).toBe('healthy')
    expect(store.listConnections(BACKEND)).toHaveLength(2)
  })

  it('removes one CLI connection under a backend and reports whether it existed', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertConnection(BACKEND, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    store.upsertConnection(BACKEND, { toolId: 'codex', source: 'installed', authHealth: 'healthy' })
    expect(store.removeConnection(BACKEND, 'codex')).toBe(true)
    expect(store.getConnection(BACKEND, 'codex')).toBeNull()
    // The other connection is untouched.
    expect(store.getConnection(BACKEND, 'claude-code')?.authHealth).toBe('healthy')
    expect(store.listConnections(BACKEND)).toHaveLength(1)
    // Removing an absent connection is a no-op that reports false.
    expect(store.removeConnection(BACKEND, 'opencode')).toBe(false)
    expect(store.removeConnection('https://other.example', 'claude-code')).toBe(false)
  })

  it('persists a connection removal across store instances (fresh read sees it)', () => {
    const dir = freshDir()
    const first = createStateStore({ cwd: dir })
    first.upsertConnection(BACKEND, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    first.removeConnection(BACKEND, 'codex')
    // A freshly-created store re-reads the file, so the daemon's per-call fresh read sees the removal.
    expect(createStateStore({ cwd: dir }).getConnection(BACKEND, 'codex')).toBeNull()
  })

  it('returns the full stock-parity default ceiling when unset (auto-edit + network on)', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(store.getPolicyCeiling(BACKEND)).toEqual({
      permissionMode: 'auto-edit',
      network: 'on'
    })
  })

  it('sets and reads back a policy ceiling for a paired backend (a fresh read sees it)', () => {
    const dir = freshDir()
    const store = createStateStore({ cwd: dir })
    store.upsertPairedBackend({ backendUrl: BACKEND, deviceId: 'd1' })
    store.setPolicyCeiling(BACKEND, { permissionMode: 'full', network: 'on' })
    expect(store.getPolicyCeiling(BACKEND)).toEqual({ permissionMode: 'full', network: 'on' })
    // A fresh store re-reads the file, so the daemon's per-call fresh read picks up the new ceiling.
    expect(createStateStore({ cwd: dir }).getPolicyCeiling(BACKEND)).toEqual({
      permissionMode: 'full',
      network: 'on'
    })
  })

  it('refuses to set a policy ceiling for a backend that is not paired', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(() =>
      store.setPolicyCeiling('https://unpaired.example', { permissionMode: 'full', network: 'on' })
    ).toThrow()
  })

  it('defaults auto-update to on when unset', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(store.getAutoUpdate()).toBe(true)
  })

  it('persists an auto-update toggle across store instances', () => {
    const dir = freshDir()
    createStateStore({ cwd: dir }).setAutoUpdate(false)
    // A fresh store re-reads the file, so the daemon's per-call fresh read sees the toggle.
    expect(createStateStore({ cwd: dir }).getAutoUpdate()).toBe(false)
    createStateStore({ cwd: dir }).setAutoUpdate(true)
    expect(createStateStore({ cwd: dir }).getAutoUpdate()).toBe(true)
  })

  it('removing a backend clears all its derived state', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertPairedBackend({ backendUrl: BACKEND, deviceId: 'd1' })
    store.upsertConnection(BACKEND, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    store.removePairedBackend(BACKEND)
    expect(store.getPairedBackend(BACKEND)).toBeNull()
    expect(store.listConnections(BACKEND)).toHaveLength(0)
  })
})
