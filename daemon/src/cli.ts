import { realpathSync } from 'node:fs'
import { argv as processArgv } from 'node:process'
import { fileURLToPath } from 'node:url'
import { BRAND } from './brand'
import { cmdBackends, cmdStatus } from './commands/backends'
import { cmdConnect, cmdDisconnect } from './commands/connect'
import { cmdLog } from './commands/log'
import { cmdPair, cmdUnpair } from './commands/pair'
import { cmdPolicy } from './commands/policy'
import { cmdServe } from './commands/serve'
import { cmdService } from './commands/service'
import { cmdSetup, cmdUninstall } from './commands/setup'
import { cmdUpdate } from './commands/update'
import { daemonVersion } from './version'

/** The usage banner printed for an unknown or missing command. */
const USAGE =
  `Usage: ${BRAND.binary} <command>\n` +
  '  setup [--url <backend>]                      pair + connect the CLIs + install the service (one-shot)\n' +
  '  uninstall                                    remove the service, drop pairings, delete all data\n' +
  '  pair [--url <backend>] [--client-id <id>]   pair with a buyer backend (device authorization)\n' +
  '  unpair [--url <backend>]                     remove a backend pairing and its stored bearer\n' +
  '  connect [claude-code|codex|opencode|hermes]  detect / install / log in the coding CLIs\n' +
  `  disconnect <claude-code|codex|opencode|hermes>  stop ${BRAND.name} driving a CLI (keeps it installed)\n` +
  '  status                                       print pairing + per-CLI connection state\n' +
  '  backends                                     list paired backends (device id, connected CLIs, ceiling, daemon state)\n' +
  '  log [--url <backend>] [--json] [-n <count>]  print the local audit trail (oldest-first; --json for piping)\n' +
  '  policy show [--url <backend>]                show each backend permission ceiling, network, and confined work root\n' +
  '  policy set --url <backend> [--permission-mode <read-only|auto-edit|full>] [--network <on|off>]\n' +
  '                                               clamp a backend ceiling (at least one flag; an unset field is kept)\n' +
  '  serve [--url <backend>] [--if-paired]        pair + connect a CLI if needed, then run the daemon\n' +
  '                                               (--if-paired: run only when already paired, else print a hint and exit 0)\n' +
  '  service <install|uninstall|status>           manage the always-on OS service\n' +
  '  update [--check|--rollback|--auto on|off]     update to the latest release (default: on, checked periodically)\n' +
  '  --version                                    print the installed version\n'

/**
 * The OpenCompanion headless CLI entry. `opencompanion setup` pairs, connects the CLIs, and installs the
 * always-on service in one step (what the installer runs); `opencompanion pair` runs the RFC-8628 device-authorization
 * grant against a buyer backend's Better Auth and stores the session bearer; `opencompanion connect`
 * detects / installs / logs in the user's subscription coding CLIs; `opencompanion disconnect <tool>` stops
 * the companion driving one CLI (leaving it installed + signed in); `opencompanion status` prints
 * the non-secret pairing + connection state; `opencompanion backends` lists each paired backend with its
 * device id, connected-CLI count, capability ceiling, and daemon state; `opencompanion policy show` prints
 * each backend's capability ceiling, network, and confined work root, and `opencompanion policy set` clamps
 * a backend's ceiling (permission mode and/or network, auditing the change); `opencompanion log` prints the
 * local audit trail read-only (pretty by default, `--json` for piping, `--url`/`-n` to filter); `opencompanion unpair` removes a
 * pairing (auditing the event, and a running daemon stops serving it within one reconcile); `opencompanion
 * serve` pairs + connects a CLI on demand then boots the daemon (foreground) so it receives + executes dispatched runs; `opencompanion
 * service` manages the always-on per-user OS service; `opencompanion update` applies the latest release
 * (staged + checksum-verified, with `--check`, `--rollback`, and `--auto on|off`). `--help`/`-h`/`help` prints the usage banner to
 * stdout and exits 0. Never throws to the top level: a failure prints a clear line and exits non-zero.
 *
 * @param argv - The process arguments (defaults to `process.argv.slice(2)`).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command] = argv

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    process.exit(0)
    return
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${BRAND.binary} ${daemonVersion()}\n`)
    process.exit(0)
    return
  }
  if (command === 'setup') {
    await cmdSetup(argv)
    return
  }
  if (command === 'uninstall') {
    cmdUninstall()
    return
  }
  if (command === 'pair') {
    await cmdPair(argv)
    return
  }
  if (command === 'unpair') {
    await cmdUnpair(argv)
    return
  }
  if (command === 'connect') {
    await cmdConnect(argv)
    return
  }
  if (command === 'disconnect') {
    await cmdDisconnect(argv)
    return
  }
  if (command === 'status') {
    cmdStatus()
    return
  }
  if (command === 'backends') {
    cmdBackends()
    return
  }
  if (command === 'log') {
    cmdLog(argv)
    return
  }
  if (command === 'policy') {
    await cmdPolicy(argv)
    return
  }
  if (command === 'serve') {
    await cmdServe(argv)
    return
  }
  if (command === 'service') {
    await cmdService(argv)
    return
  }
  if (command === 'update') {
    await cmdUpdate(argv)
    return
  }

  process.stderr.write(USAGE)
  process.exit(1)
}

/** True when this module is the process entry point (not imported by a test/build). */
function isEntryPoint(): boolean {
  const entry = processArgv[1]
  if (!entry) return false
  try {
    // Compare REAL paths: `import.meta.url` resolves symlinks (e.g. macOS /var -> /private/var) while
    // `process.argv[1]` keeps the path as it was invoked, so a raw string compare misfires whenever the
    // install dir sits under a symlink and the daemon would silently never dispatch. realpathSync
    // normalizes both so the versioned launcher (and every command it runs) dispatches regardless.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
}

if (isEntryPoint()) void main()
