declare const __OPENCOMPANION_VERSION__: string

/**
 * The daemon's build version. tsup injects `__OPENCOMPANION_VERSION__` from package.json at bundle
 * time (both configs); an un-defined build (vitest, tsx) falls back to `0.0.0-dev`. The `typeof`
 * guard is what makes the un-defined case safe - a bare read would throw ReferenceError.
 *
 * @returns The semver the daemon reports on presence and prints for `--version`.
 */
export function daemonVersion(): string {
  return typeof __OPENCOMPANION_VERSION__ === 'string' ? __OPENCOMPANION_VERSION__ : '0.0.0-dev'
}
