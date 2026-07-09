import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AuditLog } from './audit-log'
import { BRAND } from './brand'
import type { SecretStore } from './storage/secret-store'
import type { PairedBackend, StateStore } from './storage/state-store'

/** The OAuth 2.0 Device Authorization Grant type (RFC 8628). */
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** The default device-authorization scope the companion requests. */
const DEFAULT_SCOPE = 'openid profile email'

/** Better Auth is mounted under the app's API base; its device endpoints are relative to it (`{API_URL}/auth/device/...`). */
const AUTH_PATH = '/auth'

/**
 * The secret-store key prefix the Better Auth bearer is stored under. The full key is
 * `bearer-<sha256(backendUrl)>`, so it is filesystem-safe ({@link SecretStore} only allows
 * `[a-zA-Z0-9_-]`) and one bearer is kept per backend.
 */
const BEARER_KEY_PREFIX = 'bearer-'

/**
 * Derives the per-backend secret-store key for the Better Auth bearer. The backend URL is
 * hashed so the key is always filesystem-safe regardless of the URL's characters, and so
 * one backend maps to exactly one bearer entry.
 *
 * @param backendUrl - The buyer backend base URL the bearer authenticates against.
 * @returns The secret-store key for that backend's bearer.
 */
export function bearerKey(backendUrl: string): string {
  return BEARER_KEY_PREFIX + createHash('sha256').update(backendUrl).digest('hex').slice(0, 32)
}

/** `zod` schema for the RFC-8628 `POST /device/code` response (only the fields we read). */
const DeviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).optional(),
  interval: z.number().int().positive().optional(),
  expires_in: z.number().int().positive().optional()
})

/** The parsed device-code response. */
export type DeviceCodeResponse = z.infer<typeof DeviceCodeSchema>

/** `zod` schema for the RFC-8628 `POST /device/token` success body. */
const DeviceTokenSuccessSchema = z.object({ access_token: z.string().min(1) })

/** `zod` schema for the RFC-8628 `POST /device/token` error body. */
const DeviceTokenErrorSchema = z.object({ error: z.string().min(1) })

/**
 * The next action after one device-token poll, mapped from the backend's RFC-8628 response.
 * Reproduces the desktop's `nextDevicePollResult` logic without importing from the desktop.
 */
export type DevicePollResult =
  | { kind: 'success'; accessToken: string }
  | { kind: 'pending' }
  | { kind: 'slow_down'; nextInterval: number }
  | { kind: 'error'; message: string }

/**
 * Maps one device-token poll response to the next action, per RFC 8628. Pure, so the polling
 * loop's branching is unit-testable without the network: a present access token wins;
 * otherwise the error code decides whether to keep polling (`authorization_pending`), slow
 * down (`slow_down`, +5s), or stop with a specific message (`access_denied`/`expired_token`/
 * anything else).
 *
 * @param input.accessToken - The access token when the grant completed, else nullish.
 * @param input.errorCode - The poll error code, when present.
 * @param input.interval - The current polling interval in seconds.
 * @returns The next polling action.
 */
export function nextDevicePollResult(input: {
  accessToken?: string | null
  errorCode?: string | null
  interval: number
}): DevicePollResult {
  if (input.accessToken) return { kind: 'success', accessToken: input.accessToken }
  switch (input.errorCode) {
    case 'authorization_pending':
      return { kind: 'pending' }
    case 'slow_down':
      return { kind: 'slow_down', nextInterval: input.interval + 5 }
    case 'access_denied':
      return { kind: 'error', message: 'access was denied in the browser' }
    case 'expired_token':
      return { kind: 'error', message: 'the pairing code expired before approval' }
    default:
      return { kind: 'error', message: input.errorCode ?? 'device authorization failed' }
  }
}

/** The subset of the global `fetch` the pairing flow uses (injectable for tests). */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/**
 * Builds the Better Auth device endpoint URL. `backendUrl` is the app's API base (`API_URL`), so the
 * device path is appended RELATIVE to it - `{API_URL}/auth/device/{path}` - rather than resolved
 * against only the origin (which would drop the base path and break a separate backend).
 */
function deviceEndpoint(backendUrl: string, path: string): string {
  return `${backendUrl.replace(/\/+$/, '')}${AUTH_PATH}/device/${path}`
}

/**
 * Requests a device + user code from the buyer backend's Better Auth `POST /device/code`
 * (RFC 8628). The companion supplies its `client_id` (allowlisted by the backend's
 * `deviceAuthorization` plugin) and the OpenID scope; the backend returns the device code,
 * the short user code, the verification URL the user opens in a signed-in browser, and the
 * poll interval.
 *
 * @param backendUrl - The buyer backend base URL.
 * @param clientId - The device-authorization client id (defaults to `"companion"`).
 * @param fetchFn - The injectable fetch (defaults to the global `fetch`).
 * @returns The parsed device-code response.
 * @throws When the backend rejects the request or returns a malformed body.
 */
export async function requestDeviceCode(
  backendUrl: string,
  clientId: string,
  fetchFn: FetchFn
): Promise<DeviceCodeResponse> {
  const res = await fetchFn(deviceEndpoint(backendUrl, 'code'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: DEFAULT_SCOPE })
  })
  if (!res.ok) throw new Error(`device authorization request failed (HTTP ${res.status})`)
  const parsed = DeviceCodeSchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('device authorization response was malformed')
  return parsed.data
}

/**
 * Polls the buyer backend's Better Auth `POST /device/token` once for a given device code and
 * maps the response via {@link nextDevicePollResult}. A 2xx carries the access token; a non-2xx
 * carries an RFC-8628 `error` code that decides whether to keep polling, slow down, or stop.
 *
 * @param backendUrl - The buyer backend base URL.
 * @param clientId - The device-authorization client id.
 * @param deviceCode - The device code from {@link requestDeviceCode}.
 * @param interval - The current polling interval in seconds.
 * @param fetchFn - The injectable fetch.
 * @returns The next polling action.
 */
export async function pollDeviceToken(
  backendUrl: string,
  clientId: string,
  deviceCode: string,
  interval: number,
  fetchFn: FetchFn
): Promise<DevicePollResult> {
  const res = await fetchFn(deviceEndpoint(backendUrl, 'token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: GRANT_TYPE, device_code: deviceCode, client_id: clientId })
  })
  const body: unknown = await res.json()
  if (res.ok) {
    const ok = DeviceTokenSuccessSchema.safeParse(body)
    return nextDevicePollResult({ accessToken: ok.success ? ok.data.access_token : null, interval })
  }
  const err = DeviceTokenErrorSchema.safeParse(body)
  return nextDevicePollResult({ errorCode: err.success ? err.data.error : null, interval })
}

/** Resolved pairing parameters (the baked defaults applied). */
export interface PairConfig {
  /** The buyer backend base URL the companion pairs with. */
  backendUrl: string
  /** The device-authorization client id (defaults to `"companion"`). */
  clientId: string
}

/** Injected dependencies for {@link runPair}. */
export interface PairDeps {
  /** The non-secret state store (device id + paired backend record). */
  state: StateStore
  /** The encrypted secret store (the Better Auth bearer). */
  secrets: SecretStore
  /** The local audit log; when present, a successful pair appends a `pair` event. */
  audit?: AuditLog
  /** The fetch used for the device-code + token requests (defaults to the global `fetch`). */
  fetchFn?: FetchFn
  /** Sink for user-facing output (defaults to `process.stdout.write`). */
  write?(line: string): void
  /** Sleeps `seconds` between polls (injectable for tests; defaults to a real timer). */
  sleep?(seconds: number): Promise<void>
}

/** Sleeps `seconds` using a real timer. */
function realSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

/**
 * Appends a best-effort lifecycle audit entry, swallowing any write failure. Auditing is best-effort
 * here (unlike run dispatch): the action has already committed to durable state by the time this runs
 * (a completed pairing, unpairing, or policy write), so a failed audit write is surfaced as a warning
 * line rather than flipping the outcome or throwing - which keeps the calling commands to their
 * never-throws contract. Shared by {@link runPair}/{@link runUnpair} and the `policy set` CLI command.
 *
 * @param audit - The audit log, or `undefined` to skip auditing.
 * @param entry - The event to append (its `ts`/`seq` are stamped by the log).
 * @param write - Sink for the warning line on a failed write.
 */
export function auditLifecycle(
  audit: AuditLog | undefined,
  entry: Parameters<AuditLog['append']>[0],
  write: (line: string) => void
): void {
  if (!audit) return
  try {
    audit.append(entry)
  } catch (err) {
    write(`Audit write failed: ${err instanceof Error ? err.message : 'unknown error'}\n`)
  }
}

/**
 * Runs the headless RFC-8628 device-authorization pairing against a buyer backend's Better
 * Auth. It requests a device + user code, prints the verification URL and the user code to the
 * terminal (telling the user to open the URL in a browser where they are signed in), then polls
 * `POST /device/token` every `interval` seconds until the grant completes, is denied, or
 * expires. On success the access token (the Better Auth session bearer) is stored in the
 * encrypted {@link SecretStore} and the `{ backendUrl, deviceId, companionId? }` record is
 * persisted in the {@link StateStore}; the stable per-install `deviceId` is reused on re-pair.
 * Never throws: a failure prints a clear line and resolves `{ ok: false }`.
 *
 * @param config - The backend URL and device-authorization client id.
 * @param deps - The stores, fetch, output sink, and sleep.
 * @returns Whether pairing succeeded.
 */
export async function runPair(config: PairConfig, deps: PairDeps): Promise<{ ok: boolean }> {
  const write = deps.write ?? ((line): void => void process.stdout.write(line))
  const fetchFn = deps.fetchFn ?? defaultFetch
  const sleep = deps.sleep ?? realSleep
  const deviceId = deps.state.getDeviceId()

  try {
    const code = await requestDeviceCode(config.backendUrl, config.clientId, fetchFn)
    const verificationUrl = code.verification_uri_complete ?? code.verification_uri
    write(`To pair ${BRAND.name}, open the following URL in a signed-in browser:\n`)
    write(`  ${verificationUrl}\n`)
    write(`Then enter this code: ${code.user_code}\n`)
    write(`Waiting for approval...\n`)

    let interval = code.interval ?? 5
    for (;;) {
      await sleep(interval)
      const result = await pollDeviceToken(
        config.backendUrl,
        config.clientId,
        code.device_code,
        interval,
        fetchFn
      )
      if (result.kind === 'success') {
        deps.secrets.set(bearerKey(config.backendUrl), result.accessToken)
        const record: PairedBackend = { backendUrl: config.backendUrl, deviceId }
        deps.state.upsertPairedBackend(record)
        auditLifecycle(deps.audit, { backendUrl: config.backendUrl, event: 'pair', detail: { deviceId } }, write)
        write(`Paired with ${config.backendUrl}. Run '${BRAND.binary} connect' to set up your coding CLIs.\n`)
        return { ok: true }
      }
      if (result.kind === 'error') {
        write(`Pairing failed: ${result.message}\n`)
        return { ok: false }
      }
      if (result.kind === 'slow_down') interval = result.nextInterval
    }
  } catch (err) {
    write(`Pairing failed: ${err instanceof Error ? err.message : 'unknown error'}\n`)
    return { ok: false }
  }
}

/** Injected dependencies for {@link runUnpair}. */
export interface UnpairDeps {
  /** The non-secret state store (paired backend record). */
  state: StateStore
  /** The encrypted secret store (the Better Auth bearer). */
  secrets: SecretStore
  /** The local audit log; when present, a successful unpair appends an `unpair` event. */
  audit?: AuditLog
  /** Sink for user-facing output (defaults to `process.stdout.write`). */
  write?(line: string): void
}

/**
 * Removes a backend's stored bearer (encrypted secret store) and its paired-backend state
 * (the `conf` store). Server-side session revocation is a named follow-up seam: the bearer is
 * a Better Auth session token, so a future revoke would call the backend's sign-out endpoint
 * before the local delete; today the local credential is removed so the companion can no
 * longer authenticate. Never throws.
 *
 * @param backendUrl - The buyer backend to unpair from.
 * @param deps - The stores and output sink.
 * @returns Whether a paired backend was found and removed.
 */
export function runUnpair(backendUrl: string, deps: UnpairDeps): { ok: boolean } {
  const write = deps.write ?? ((line): void => void process.stdout.write(line))
  const existing = deps.state.getPairedBackend(backendUrl)
  if (!existing) {
    write(`Not paired with ${backendUrl}.\n`)
    return { ok: false }
  }
  // TODO(auth-followup): revoke the Better Auth session server-side before the local delete.
  deps.secrets.delete(bearerKey(backendUrl))
  deps.state.removePairedBackend(backendUrl)
  auditLifecycle(deps.audit, { backendUrl, event: 'unpair', detail: { deviceId: existing.deviceId } }, write)
  write(`Unpaired from ${backendUrl}.\n`)
  return { ok: true }
}

/**
 * Reads the stored Better Auth bearer for a backend, or `null` when not paired. The poll
 * client reads this to authenticate its outbound requests.
 *
 * @param backendUrl - The buyer backend whose bearer to read.
 * @param secrets - The encrypted secret store.
 * @returns The bearer, or `null`.
 */
export function readBearer(backendUrl: string, secrets: SecretStore): string | null {
  return secrets.get(bearerKey(backendUrl))
}

/** The adapter from the global `fetch` to the narrow {@link FetchFn} this module uses. */
const defaultFetch: FetchFn = (url, init) =>
  globalThis.fetch(url, { method: init.method, headers: init.headers, body: init.body })
