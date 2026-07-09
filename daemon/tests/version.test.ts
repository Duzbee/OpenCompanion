import { describe, expect, it } from 'vitest'
import { daemonVersion } from '../src/version'

describe('daemonVersion', () => {
  it('returns a non-empty version string', () => {
    const v = daemonVersion()
    expect(v.length).toBeGreaterThan(0)
  })
  it('falls back to 0.0.0-dev when no build define is present', () => {
    // Under vitest no tsup define runs, so the fallback IS the observable value.
    expect(daemonVersion()).toBe('0.0.0-dev')
  })
})
