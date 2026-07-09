import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  installService,
  restartService,
  SERVICE_LABEL,
  serviceStatus,
  uninstallService,
  unitPath,
  WINDOWS_TASK_NAME,
  type ServiceSpec
} from '../src/service'

const spec: ServiceSpec = {
  label: SERVICE_LABEL,
  program: ['/opt/node', '/app/cli.js', 'serve'],
  logDir: '/home/u/.local/share/opencompanion/logs',
  env: { PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/home/u' }
}

describe('service unit builders', () => {
  it('launchd plist carries the program args, env, and RunAtLoad + KeepAlive', () => {
    const plist = buildLaunchdPlist(spec)
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`)
    expect(plist).toContain('<string>/opt/node</string>')
    expect(plist).toContain('<string>/app/cli.js</string>')
    expect(plist).toContain('<string>serve</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('<string>/usr/bin:/opt/homebrew/bin</string>')
    // The daemon log file carries the opencompanion brand stem.
    expect(plist).toContain(join(spec.logDir, 'opencompanion.log'))
    expect(plist).toContain(join(spec.logDir, 'opencompanion.err.log'))
  })

  it('systemd unit carries ExecStart, Restart=always, and Environment', () => {
    const unit = buildSystemdUnit(spec)
    expect(unit).toContain('ExecStart=/opt/node /app/cli.js serve')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('Environment="PATH=/usr/bin:/opt/homebrew/bin"')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('quotes systemd ExecStart args that contain spaces', () => {
    const unit = buildSystemdUnit({ ...spec, program: ['/opt/node', '/App Support/cli.js', 'serve'] })
    expect(unit).toContain('ExecStart=/opt/node "/App Support/cli.js" serve')
  })
})

describe('unitPath', () => {
  it('resolves the launchd plist path on macOS', () => {
    expect(unitPath('darwin', '/home/u')).toBe(
      join('/home/u', 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    )
  })
  it('resolves the systemd user unit path on Linux', () => {
    expect(unitPath('linux', '/home/u')).toBe(
      join('/home/u', '.config', 'systemd', 'user', 'opencompanion.service')
    )
  })
})

/** Captures the injected side effects for assertions. */
function fakeDeps(platform: NodeJS.Platform) {
  const writes: Array<{ path: string; content: string }> = []
  const removes: string[] = []
  const runs: Array<{ cmd: string; args: string[] }> = []
  return {
    deps: {
      platform,
      home: '/home/u',
      uid: 501,
      writeFile: (path: string, content: string) => void writes.push({ path, content }),
      removeFile: (path: string) => void removes.push(path),
      run: (cmd: string, args: string[]) => {
        runs.push({ cmd, args })
        return ''
      }
    },
    writes,
    removes,
    runs
  }
}

describe('installService', () => {
  it('macOS: writes the plist then bootout (best-effort) + bootstrap into the gui domain', () => {
    const f = fakeDeps('darwin')
    const { path } = installService(spec, f.deps)
    expect(path).toBe(unitPath('darwin', '/home/u'))
    expect(f.writes[0]?.path).toBe(path)
    expect(f.writes[0]?.content).toContain('<key>KeepAlive</key>')
    expect(f.runs.map((r) => `${r.cmd} ${r.args.join(' ')}`)).toEqual([
      `launchctl bootout gui/501/${SERVICE_LABEL}`,
      `launchctl bootstrap gui/501 ${path}`
    ])
  })

  it('Linux: writes the systemd unit then daemon-reload + enable --now', () => {
    const f = fakeDeps('linux')
    installService(spec, f.deps)
    expect(f.writes[0]?.content).toContain('Restart=always')
    expect(f.runs).toEqual([
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--now', 'opencompanion.service'] }
    ])
  })

  it('Windows: registers a logon Scheduled Task and starts it immediately', () => {
    const f = fakeDeps('win32')
    const { message } = installService(spec, f.deps)
    expect(message).toContain('Scheduled Task')
    expect(f.runs[0]?.cmd).toBe('schtasks')
    expect(f.runs[0]?.args).toContain('/Create')
    expect(f.runs[0]?.args).toContain(WINDOWS_TASK_NAME)
    // Without an immediate /Run the companion would stay offline until the next logon.
    expect(f.runs[1]?.cmd).toBe('schtasks')
    expect(f.runs[1]?.args).toContain('/Run')
    expect(f.runs[1]?.args).toContain(WINDOWS_TASK_NAME)
  })
})

describe('uninstallService', () => {
  it('macOS: bootout then removes the plist', () => {
    const f = fakeDeps('darwin')
    uninstallService(f.deps)
    expect(f.runs[0]).toEqual({ cmd: 'launchctl', args: ['bootout', `gui/501/${SERVICE_LABEL}`] })
    expect(f.removes).toEqual([unitPath('darwin', '/home/u')])
  })
})

describe('serviceStatus', () => {
  it('Linux: reports the systemctl is-active state', () => {
    const f = fakeDeps('linux')
    f.deps.run = () => 'active'
    expect(serviceStatus(f.deps).message).toBe('systemd: active')
  })
})

describe('restartService', () => {
  it('macOS: kickstarts the launchd agent in the gui domain', () => {
    const f = fakeDeps('darwin')
    const { message } = restartService(f.deps)
    expect(f.runs).toEqual([
      { cmd: 'launchctl', args: ['kickstart', '-k', `gui/501/${SERVICE_LABEL}`] }
    ])
    expect(message.length).toBeGreaterThan(0)
  })

  it('Linux: restarts the systemd user unit', () => {
    const f = fakeDeps('linux')
    restartService(f.deps)
    expect(f.runs).toEqual([{ cmd: 'systemctl', args: ['--user', 'restart', 'opencompanion.service'] }])
  })

  it('Windows: ends then re-runs the logon Scheduled Task', () => {
    const f = fakeDeps('win32')
    restartService(f.deps)
    expect(f.runs[0]?.cmd).toBe('schtasks')
    expect(f.runs[0]?.args).toContain('/End')
    expect(f.runs[0]?.args).toContain(WINDOWS_TASK_NAME)
    expect(f.runs[1]?.cmd).toBe('schtasks')
    expect(f.runs[1]?.args).toContain('/Run')
    expect(f.runs[1]?.args).toContain(WINDOWS_TASK_NAME)
  })
})
