import { BRAND } from './brand'
import type { StateStore } from './storage/state-store'

/**
 * The device-authorization client id the companion presents when pairing. WIRE-FROZEN: deployed
 * buyer backends (v1.42.0+) allowlist exactly this string in their Better Auth device grant, so
 * renaming it would break pairing against every existing deployment.
 */
export const DEFAULT_CLIENT_ID = 'companion'

/** Options for {@link resolveBackendUrl}. */
export interface ResolveBackendUrlOpts {
  /** Whether an interactive picker may be shown to disambiguate several pairings. */
  interactive: boolean
  /** Picks one of the paired backend URLs (an arrow-key select); used only on the interactive path. */
  prompt?: (urls: string[]) => Promise<string>
}

/**
 * Resolves which backend a command targets now that the companion carries no baked-in default: an
 * explicit `--url` wins; else the sole paired backend is used; else - when several are paired and
 * `opts.interactive` allows it - the injected `prompt` picks one; else it throws. Never invents a
 * URL from an empty pairing set: with nothing paired it throws the pair hint, so pairing (which
 * DEFINES a backend URL) stays the only way a first URL enters the system.
 *
 * @param explicit - The value of an explicit `--url` flag, or `undefined`.
 * @param state - The state store read for the paired backends.
 * @param opts - Whether interaction is allowed and the picker used when it is.
 * @returns The resolved backend URL.
 * @throws When nothing is paired, or several are paired and no explicit or interactive choice resolves one.
 */
export async function resolveBackendUrl(
  explicit: string | undefined,
  state: StateStore,
  opts: ResolveBackendUrlOpts
): Promise<string> {
  if (explicit) return explicit
  const paired = state.listPairedBackends()
  if (paired.length === 1) return paired[0]!.backendUrl
  if (paired.length === 0) {
    throw new Error(`Not paired with any backend. Run '${BRAND.binary} pair --url <backend>' first.`)
  }
  if (opts.interactive && opts.prompt) {
    return opts.prompt(paired.map((backend) => backend.backendUrl))
  }
  throw new Error('Multiple backends are paired. Pass --url <backend>.')
}
