import { describe, expect, it } from 'vitest'
import { backendKey } from '../src/backend-key'

describe('backendKey', () => {
  it('is stable across calls for the same URL', () => {
    expect(backendKey('https://a.com/api')).toBe(backendKey('https://a.com/api'))
  })

  it('is distinct across host, port, and path differences', () => {
    const keys = new Set([
      backendKey('https://a.com/api'),
      backendKey('https://a.com:8443/api'),
      backendKey('https://a.com/other'),
      backendKey('https://b.com/api')
    ])
    expect(keys.size).toBe(4)
  })

  it('normalizes host case', () => {
    expect(backendKey('https://A.COM/api')).toBe(backendKey('https://a.com/api'))
  })

  it('normalizes a trailing slash', () => {
    expect(backendKey('https://a.com/api/')).toBe(backendKey('https://a.com/api'))
    expect(backendKey('https://a.com/')).toBe(backendKey('https://a.com'))
  })

  it('emits only the [a-z0-9-] charset', () => {
    expect(backendKey('https://Sub.Example.com:8443/deep/path')).toMatch(/^[a-z0-9-]+$/)
  })

  it('prefixes the sanitized host for readability', () => {
    expect(backendKey('https://a.com/api')).toMatch(/^a-com-[0-9a-f]{8}$/)
  })

  it('caps the readable host prefix at 64 chars without a dangling separator', () => {
    // A pathologically long host must not blow the path-segment length; only the readable prefix is
    // capped (the 8-hex digest still distinguishes it). The `-<8hex>` suffix is 9 chars.
    const longHost = `${'x'.repeat(60)}.${'y'.repeat(60)}.com`
    const key = backendKey(`https://${longHost}/api`)
    const prefix = key.replace(/-[0-9a-f]{8}$/, '')
    expect(prefix.length).toBeLessThanOrEqual(64)
    expect(key).toMatch(/^[a-z0-9-]+$/)
    // A slice that lands mid-separator must not leave a `--` (or a trailing `-` before the digest).
    expect(key).not.toContain('--')
  })

  it('keeps two long hosts sharing the capped prefix distinct via the hash', () => {
    // Both sanitize to the same first 64 chars, so ONLY the digest (hashed over the full normalized
    // URL) keeps them apart - the cap must never collapse distinct backends onto one work tree.
    const base = `${'x'.repeat(60)}.${'y'.repeat(60)}`
    expect(backendKey(`https://${base}.aaa/api`)).not.toBe(backendKey(`https://${base}.bbb/api`))
  })
})
