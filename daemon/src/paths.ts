import { homedir } from 'node:os'
import { join } from 'node:path'
import { BRAND } from './brand'

/** The app folder name under each platform's data root. */
const APP_DIR = BRAND.appDirName

/** Inputs for {@link appDataDir} (all injectable so the resolution is unit-testable). */
export interface AppDataOpts {
  /** OS platform (defaults to `process.platform`). */
  platform?: NodeJS.Platform
  /** Environment bag (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv
  /** Home directory (defaults to `os.homedir()`). */
  home?: string
}

/**
 * Resolves the companion's per-user app-data directory, host-agnostically: `%APPDATA%`
 * on Windows, `~/Library/Application Support` on macOS, and `$XDG_DATA_HOME` (or
 * `~/.local/share`) on Linux. This folder holds the store, config, secrets, and the
 * `work/` subtree; it is OFF-LIMITS to the agent (only `work/<productId>/` is exposed).
 *
 * @param opts - Platform/env/home overrides for testing.
 * @returns The absolute app-data directory.
 */
export function appDataDir(opts: AppDataOpts = {}): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  if (platform === 'win32') {
    const base = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return join(base, APP_DIR)
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR)
  const base = env.XDG_DATA_HOME ?? join(home, '.local', 'share')
  return join(base, APP_DIR)
}

/**
 * The secrets subdirectory (encrypted credential files, `chmod 700`).
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute secrets directory.
 */
export function secretsDir(root: string): string {
  return join(root, 'secrets')
}

/**
 * The managed-CLI subdirectory the daemon downloads coding CLIs into (`clis/<toolId>/`),
 * injected to `@opencompanion/core` as the `baseDir`. It is OFF the user's global install
 * path, so a managed binary is a fallback resolved AFTER a system install on PATH.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute managed-CLI base directory.
 */
export function managedCliDir(root: string): string {
  return join(root, 'managed-clis')
}

/**
 * The work root that holds every per-product confined folder (`work/<productId>/`).
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute work root.
 */
export function workRoot(root: string): string {
  return join(root, 'work')
}

/**
 * The local audit-log directory (append-only JSONL, daemon-authored and CLI-appended). Shared by the
 * daemon and the `pair`/`unpair` CLI commands so both write the same log.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute audit directory.
 */
export function auditDir(root: string): string {
  return join(root, 'audit')
}
