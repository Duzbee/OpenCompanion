import { join } from 'node:path'
import { argv as processArgv, execPath } from 'node:process'
import { BRAND } from '../brand'
import {
  installService,
  serviceStatus,
  uninstallService,
  SERVICE_LABEL,
  type ServiceSpec
} from '../service'
import * as ui from '../ui'
import { flagValue, openStores, positionalArg } from './shared'

/**
 * Builds the service spec that runs `<launcher> serve` (bare), threading the installing shell's
 * PATH. A bare `serve` serves EVERY paired backend and hot-picks up backends paired later, so the
 * boot service is not pinned to one URL - it tracks the live pairing set on its own.
 *
 * A versioned install runs through a stable ROOT launcher that resolves the active version from its
 * `current` pointer and exports its own absolute path as `OPENCOMPANION_ROOT_LAUNCHER` before exec.
 * When that marker is present the boot service runs `<root launcher> serve`, so a later update that
 * flips `current` to a new version dir is picked up on the next start without touching the OS unit -
 * the alternative (node+cli paths baked inside one version dir) would be orphaned by that flip.
 *
 * Without the marker (a dev build), it falls back to `<node> <cli.js> serve`, where the entry is
 * `process.argv[1]` - the script the launcher actually invoked (`daemon/cli.js` in the standalone,
 * `dist/cli.js` from the dev build, or `src/cli.ts` under tsx), the same entry `isEntryPoint` keys
 * off. Reading it here is correct however the daemon is bundled, where an `import.meta.url` would
 * resolve to THIS module (right only while esbuild happens to inline it into the entry).
 *
 * @param appDataRoot - The app-data root (the service log dir lives under it).
 * @returns The service spec running a bare `serve`.
 */
export function buildServiceSpec(appDataRoot: string): ServiceSpec {
  const rootLauncher = process.env.OPENCOMPANION_ROOT_LAUNCHER
  const program = rootLauncher ? [rootLauncher, 'serve'] : [execPath, processArgv[1], 'serve']
  return {
    label: SERVICE_LABEL,
    program,
    logDir: join(appDataRoot, 'logs'),
    // A login/boot service starts with a minimal PATH, so pass the installing shell's PATH through
    // (plus HOME) - the daemon needs them to find the user's `claude`/`codex` and app-data dir.
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.HOME ? { HOME: process.env.HOME } : {})
    }
  }
}

/** Runs the `service <install|uninstall|status>` command and exits with the appropriate code. */
export async function cmdService(argv: string[]): Promise<void> {
  const { appDataRoot, state } = openStores()
  const action = positionalArg(argv)
  if (action === 'install') {
    // The boot service runs a bare `serve` (every paired backend + hot pickup), so it is no longer
    // pinned to one backend and takes no --url. A --url passed by an old caller is tolerated but
    // ignored with a notice. REFUSE to install an unusable daemon, though: a bare `serve` with nothing
    // paired exits non-zero and the OS would restart it into a crash loop, so require a pairing first.
    if (flagValue(argv, '--url') !== undefined) {
      ui.line("Note: 'service install' no longer needs --url; the boot service serves every paired backend. Ignoring --url.")
    }
    if (state.listPairedBackends().length === 0) {
      process.stderr.write(`No backend paired. Run '${BRAND.binary} pair' (or '${BRAND.binary} setup') first.\n`)
      process.exit(1)
      return
    }
    const { message } = installService(buildServiceSpec(appDataRoot))
    ui.line(message)
    process.exit(0)
    return
  }
  if (action === 'uninstall') {
    const { message } = uninstallService()
    ui.line(message)
    process.exit(0)
    return
  }
  if (action === 'status') {
    const { message } = serviceStatus()
    ui.line(message)
    process.exit(0)
    return
  }
  process.stderr.write(`Usage: ${BRAND.binary} service <install|uninstall|status>\n`)
  process.exit(1)
}
