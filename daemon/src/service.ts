import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { BRAND } from './brand'

/** The reverse-DNS service label / unit id used across platforms. */
export const SERVICE_LABEL = BRAND.serviceLabel

/** The Windows Scheduled Task name (no dots; schtasks rejects a reverse-DNS label). */
export const WINDOWS_TASK_NAME = BRAND.name

/** The Linux systemd user unit filename (brand-derived, matching the macOS/Windows identities). */
const SYSTEMD_UNIT = `${BRAND.binary}.service`

/** A platform-neutral description of the long-running service to register. */
export interface ServiceSpec {
  /** The service label / unit id. */
  label: string
  /** The absolute program + args the service runs (e.g. `[nodePath, cliPath, 'serve']`). */
  program: string[]
  /** Directory for the service's stdout/stderr logs (created on install). */
  logDir: string
  /**
   * Environment for the service. PATH matters: a login/boot service starts with a minimal PATH, so
   * the daemon would not find the user's `claude`/`codex`; pass the installing shell's PATH through.
   */
  env: Record<string, string>
}

/** Escapes a string for XML text/attribute content (the plist is XML). */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Builds a macOS launchd LaunchAgent plist. `RunAtLoad` starts it at login and `KeepAlive`
 * restarts it whenever it exits or crashes - the OS-native always-on, scoped to the logged-in
 * user so the daemon runs as them with their CLI auth.
 *
 * @param spec - The service description.
 * @returns The plist XML.
 */
export function buildLaunchdPlist(spec: ServiceSpec): string {
  const args = spec.program.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(spec.logDir, `${BRAND.binary}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(spec.logDir, `${BRAND.binary}.err.log`))}</string>
</dict>
</plist>
`
}

/**
 * Builds a Linux systemd user unit. `Restart=always` restarts it on crash; `WantedBy=default.target`
 * plus `systemctl --user enable` starts it on login (and on boot with `loginctl enable-linger`).
 *
 * @param spec - The service description.
 * @returns The unit file text.
 */
export function buildSystemdUnit(spec: ServiceSpec): string {
  const exec = spec.program.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join('\n')
  return `[Unit]
Description=${BRAND.name}
After=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=2
${env}

[Install]
WantedBy=default.target
`
}

/** Injected side effects so install/uninstall/status are testable without touching the real OS. */
export interface ServiceDeps {
  /** OS platform (defaults to `process.platform`). */
  platform?: NodeJS.Platform
  /** Home directory (defaults to `os.homedir()`). */
  home?: string
  /** Numeric user id for `launchctl` domain targets (defaults to `os.userInfo().uid`). */
  uid?: number
  /** Writes a file (defaults to `fs.writeFileSync`), creating parent dirs. */
  writeFile?: (path: string, content: string) => void
  /** Removes a file (defaults to `fs.rmSync`, ignoring a missing file). */
  removeFile?: (path: string) => void
  /** Runs a command, returning combined output; throws on non-zero unless `allowFail`. */
  run?: (cmd: string, args: string[], allowFail?: boolean) => string
}

/** Resolves the deps, defaulting each to a real implementation. */
function resolveDeps(deps: ServiceDeps): Required<ServiceDeps> {
  return {
    platform: deps.platform ?? process.platform,
    home: deps.home ?? homedir(),
    uid: deps.uid ?? userInfo().uid,
    writeFile:
      deps.writeFile ??
      ((path, content): void => {
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, content)
      }),
    removeFile: deps.removeFile ?? ((path): void => rmSync(path, { force: true })),
    run:
      deps.run ??
      ((cmd, args, allowFail): string => {
        try {
          return execFileSync(cmd, args, { encoding: 'utf8' })
        } catch (err) {
          if (allowFail) return ''
          throw err
        }
      })
  }
}

/**
 * The on-disk path of the platform's service unit for the given home dir.
 *
 * @param platform - The OS platform.
 * @param home - The home directory the per-user unit lives under.
 * @returns The absolute unit path (a sentinel string on Windows, which uses a Scheduled Task).
 */
export function unitPath(platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
}

/**
 * Installs the daemon as a per-user OS service that starts at login and is kept alive by the OS
 * (launchd on macOS, systemd `--user` on Linux, a logon Scheduled Task on Windows). Idempotent: an
 * existing unit is replaced and reloaded.
 *
 * @param spec - The service description (program, logs, env).
 * @param deps - Injected platform side effects (for testing).
 * @returns The path of the written unit and a human-readable status line.
 */
export function installService(
  spec: ServiceSpec,
  deps: ServiceDeps = {}
): { path: string; message: string } {
  const d = resolveDeps(deps)
  if (d.platform === 'darwin') {
    const path = unitPath('darwin', d.home)
    d.writeFile(path, buildLaunchdPlist(spec))
    d.run('launchctl', ['bootout', `gui/${d.uid}/${spec.label}`], true)
    d.run('launchctl', ['bootstrap', `gui/${d.uid}`, path])
    return { path, message: `installed launchd agent ${spec.label} (starts at login)` }
  }
  if (d.platform === 'linux') {
    const path = unitPath('linux', d.home)
    d.writeFile(path, buildSystemdUnit(spec))
    d.run('systemctl', ['--user', 'daemon-reload'])
    d.run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
    return {
      path,
      message: 'installed systemd user service (enable lingering for headless: loginctl enable-linger)'
    }
  }
  if (d.platform === 'win32') {
    const tr = spec.program.map((arg) => `"${arg}"`).join(' ')
    d.run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', WINDOWS_TASK_NAME, '/TR', tr])
    // A logon task alone would leave the companion offline until the NEXT logon, so start it now
    // (matching launchd `bootstrap` / systemd `--now`, which both start the service immediately).
    d.run('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME])
    return { path: `Scheduled Task ${WINDOWS_TASK_NAME}`, message: 'installed and started logon Scheduled Task' }
  }
  throw new Error(`unsupported platform: ${d.platform}`)
}

/**
 * Stops and removes the installed service. Best-effort: a missing unit is not an error.
 *
 * @param deps - Injected platform side effects.
 * @returns A human-readable status line.
 */
export function uninstallService(deps: ServiceDeps = {}): { message: string } {
  const d = resolveDeps(deps)
  if (d.platform === 'darwin') {
    const path = unitPath('darwin', d.home)
    d.run('launchctl', ['bootout', `gui/${d.uid}/${SERVICE_LABEL}`], true)
    d.removeFile(path)
    return { message: 'removed launchd agent' }
  }
  if (d.platform === 'linux') {
    const path = unitPath('linux', d.home)
    d.run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], true)
    d.removeFile(path)
    d.run('systemctl', ['--user', 'daemon-reload'], true)
    return { message: 'removed systemd user service' }
  }
  if (d.platform === 'win32') {
    d.run('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME], true)
    return { message: 'removed logon Scheduled Task' }
  }
  throw new Error(`unsupported platform: ${d.platform}`)
}

/**
 * Reports whether the service is currently registered/running.
 *
 * @param deps - Injected platform side effects.
 * @returns Whether the unit is installed and a human-readable status line.
 */
export function serviceStatus(deps: ServiceDeps = {}): { installed: boolean; message: string } {
  const d = resolveDeps(deps)
  if (d.platform === 'darwin') {
    const installed = existsSync(unitPath('darwin', d.home))
    const listed = d.run('launchctl', ['list', SERVICE_LABEL], true).trim().length > 0
    return {
      installed,
      message: installed ? (listed ? 'installed and loaded' : 'installed (not loaded)') : 'not installed'
    }
  }
  if (d.platform === 'linux') {
    const active = d.run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], true).trim()
    return { installed: existsSync(unitPath('linux', d.home)), message: `systemd: ${active || 'inactive'}` }
  }
  if (d.platform === 'win32') {
    const out = d.run('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], true)
    return { installed: out.includes(WINDOWS_TASK_NAME), message: out ? 'task present' : 'not installed' }
  }
  throw new Error(`unsupported platform: ${d.platform}`)
}

/**
 * Restarts the installed service so a freshly flipped `current` version is picked up. Uses each
 * platform's native restart (launchd `kickstart -k`, systemd `--user restart`, a `schtasks` end +
 * re-run on Windows), which relaunches the daemon through the stable root launcher and therefore the
 * new version dir. On Windows the `/End` is best-effort (the task may not be running); the `/Run`
 * starts it. Same `run` seam and structure as {@link installService} / {@link uninstallService}.
 *
 * @param deps - Injected platform side effects.
 * @returns A human-readable status line.
 */
export function restartService(deps: ServiceDeps = {}): { message: string } {
  const d = resolveDeps(deps)
  if (d.platform === 'darwin') {
    d.run('launchctl', ['kickstart', '-k', `gui/${d.uid}/${SERVICE_LABEL}`])
    return { message: 'restarted launchd agent' }
  }
  if (d.platform === 'linux') {
    d.run('systemctl', ['--user', 'restart', SYSTEMD_UNIT])
    return { message: 'restarted systemd user service' }
  }
  if (d.platform === 'win32') {
    d.run('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME], true)
    d.run('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME])
    return { message: 'restarted logon Scheduled Task' }
  }
  throw new Error(`unsupported platform: ${d.platform}`)
}
