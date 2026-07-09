import { describe, expect, it } from 'vitest'
import { compareSemver } from '../src/update/semver'

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('orders by patch ascending and descending', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1)
    expect(compareSemver('1.2.4', '1.2.3')).toBe(1)
  })

  it('orders by minor ahead of patch', () => {
    expect(compareSemver('1.2.9', '1.3.0')).toBe(-1)
    expect(compareSemver('1.3.0', '1.2.9')).toBe(1)
  })

  it('orders by major ahead of minor', () => {
    expect(compareSemver('1.9.9', '2.0.0')).toBe(-1)
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
  })

  it('compares each field numerically, not lexically', () => {
    // A string compare would rank "10" below "9"; the numeric triple must not.
    expect(compareSemver('1.2.10', '1.2.9')).toBe(1)
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1)
  })

  it('ignores a pre-release suffix and compares by the numeric triple', () => {
    expect(compareSemver('1.2.3-rc.1', '1.2.3')).toBe(0)
    expect(compareSemver('1.2.3', '1.2.4-rc.1')).toBe(-1)
    expect(compareSemver('2.0.0-beta', '1.9.9')).toBe(1)
  })

  it('throws on a malformed version', () => {
    expect(() => compareSemver('1.2', '1.2.3')).toThrow()
    expect(() => compareSemver('1.2.3', 'not-a-version')).toThrow()
    expect(() => compareSemver('', '1.2.3')).toThrow()
    // The remote VERSION marker is the tag WITHOUT its leading "v"; a stray "v" is malformed.
    expect(() => compareSemver('v1.2.3', '1.2.3')).toThrow()
  })
})
