import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BRAND } from '../brand'
import { appDataDir } from '../paths'
import { restartService } from '../service'
import { createStateStore } from '../storage/state-store'
import * as ui from '../ui'
import {
  checkLatest,
  flipCurrent,
  pruneVersions,
  readCurrent,
  rollbackTarget,
  stageVersion,
  type UpdaterDeps
} from '../update/updater'
import { flagValue } from './shared'

/**
 * Downloads `url` to `dest`, throwing on a non-200 so a missing release asset surfaces as a failure
 * rather than a truncated file. Uses the global `fetch` (web-standard, no dependency).
 *
 * @param url - The asset URL.
 * @param dest - The absolute file to write.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`)
  writeFileSync(dest, new Uint8Array(await res.arrayBuffer()))
}

/**
 * Runs a command, resolving whether it exited 0 and its captured stdout (never rejecting - callers
 * branch on `ok`). A Windows batch launcher (`.cmd`/`.bat`) is run through the shell, which Node
 * requires for batch files.
 *
 * @param cmd - The program to run.
 * @param args - The program arguments.
 * @returns Whether the command exited 0 and its stdout.
 */
function runCommand(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    const child = spawn(cmd, args, { shell: isBatch, windowsHide: true })
    let stdout = ''
    if (child.stdout) child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString('utf8')))
    child.on('error', () => resolve({ ok: false, stdout }))
    child.on('close', (code) => resolve({ ok: code === 0, stdout }))
  })
}

/**
 * The versioned install root: the directory the stable root launcher exports as its own location
 * (`OPENCOMPANION_ROOT_LAUNCHER`), else `OPENCOMPANION_HOME`, else `~/.opencompanion` - matching what
 * the install scripts lay down.
 *
 * @returns The absolute install root that holds `versions/` and the `current` pointer.
 */
function resolveInstallDir(): string {
  const launcher = process.env.OPENCOMPANION_ROOT_LAUNCHER
  if (launcher) return dirname(launcher)
  return process.env.OPENCOMPANION_HOME ?? join(homedir(), `.${BRAND.appDirName}`)
}

/** The release download base: the `OPENCOMPANION_RELEASE_BASE` override, else the brand's latest-download URL. */
function resolveReleaseBase(): string {
  return (process.env.OPENCOMPANION_RELEASE_BASE ?? BRAND.installBase).replace(/\/+$/, '')
}

/**
 * Builds the real-environment updater deps (install root, release base, platform, and the IO seams).
 * Reused by the daemon's auto-update loop (`serve`), so it takes an optional `log` sink - the daemon
 * routes staging progress through its own writer rather than the interactive `ui.line` default.
 *
 * @param log - Where staging progress lines go (defaults to {@link ui.line}).
 * @returns The updater deps.
 */
export function buildUpdaterDeps(log: (line: string) => void = ui.line): UpdaterDeps {
  return {
    installDir: resolveInstallDir(),
    releaseBase: resolveReleaseBase(),
    platform: process.platform,
    arch: process.arch,
    download: downloadFile,
    run: runCommand,
    log
  }
}

/** Restarts the service so the flipped version takes effect, degrading to a manual-restart hint if it can't. */
function restartOrHint(target: string): void {
  try {
    ui.line(restartService().message)
  } catch {
    ui.line(`Restart ${BRAND.name} (or reboot) to run ${target}.`)
  }
}

/** `update --check`: reports the installed and latest versions and the auto-update setting without changing anything. */
async function cmdUpdateCheck(): Promise<void> {
  const check = await checkLatest(buildUpdaterDeps())
  const autoUpdate = createStateStore({ cwd: appDataDir() }).getAutoUpdate()
  ui.line(`current: ${check.current}`)
  ui.line(`auto-update: ${autoUpdate ? 'on' : 'off'}`)
  if (check.latest === null) {
    ui.line('latest: unknown (could not reach the release server)')
    process.exit(1)
    return
  }
  ui.line(`latest: ${check.latest}`)
  ui.line(
    check.updateAvailable
      ? `Update available. Run '${BRAND.binary} update' to install ${check.latest}.`
      : 'Up to date.'
  )
  process.exit(0)
}

/** `update`: stages, verifies, flips to, and restarts on the latest release; a no-op when already current. */
async function cmdUpdateApply(): Promise<void> {
  const deps = buildUpdaterDeps()
  const check = await checkLatest(deps)
  if (check.latest === null) {
    process.stderr.write('Could not reach the release server. Try again later.\n')
    process.exit(1)
    return
  }
  if (!check.updateAvailable) {
    ui.line(`Already up to date (${check.current}).`)
    process.exit(0)
    return
  }
  try {
    await stageVersion(deps, check.latest)
    flipCurrent(deps.installDir, check.latest)
    pruneVersions(deps.installDir)
  } catch (err) {
    process.stderr.write(`Update failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
    return
  }
  ui.line(`Updated ${check.current} -> ${check.latest}.`)
  restartOrHint(check.latest)
  process.exit(0)
}

/** `update --rollback`: flips to the newest other installed version and restarts. */
async function cmdUpdateRollback(): Promise<void> {
  const installDir = resolveInstallDir()
  const current = readCurrent(installDir)
  const target = rollbackTarget(installDir)
  if (target === null) {
    process.stderr.write('No earlier version to roll back to.\n')
    process.exit(1)
    return
  }
  flipCurrent(installDir, target)
  ui.line(`Rolled back ${current ?? 'current'} -> ${target}.`)
  restartOrHint(target)
  process.exit(0)
}

/** `update --auto on|off`: persists whether the daemon self-updates. */
function cmdUpdateAuto(argv: string[]): void {
  const value = flagValue(argv, '--auto')
  if (value !== 'on' && value !== 'off') {
    process.stderr.write(`Usage: ${BRAND.binary} update --auto <on|off>\n`)
    process.exit(1)
    return
  }
  createStateStore({ cwd: appDataDir() }).setAutoUpdate(value === 'on')
  ui.line(`Automatic updates: ${value}.`)
  process.exit(0)
}

/**
 * Runs the `update` command family: apply the latest release (default), `--check` for a dry
 * report, `--rollback` to the previous installed version, or `--auto on|off` to toggle the daemon's
 * self-update. Each mode prints a clear line and exits with the appropriate code; it never throws to
 * the top level.
 *
 * @param argv - The process arguments (`argv[0]` is `"update"`).
 */
export async function cmdUpdate(argv: string[]): Promise<void> {
  if (argv.includes('--auto')) return cmdUpdateAuto(argv)
  if (argv.includes('--check')) return cmdUpdateCheck()
  if (argv.includes('--rollback')) return cmdUpdateRollback()
  return cmdUpdateApply()
}
