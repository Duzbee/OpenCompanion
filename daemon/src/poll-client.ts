import {
  ConnectInstructionSchema,
  RunStartSchema,
  ToolResultSchema,
  type AuthHealth,
  type CliConnectionInfo,
  type ConnectInstruction,
  type ConnectResultBody,
  type RunConversationMsg,
  type RunEventMsg,
  type ToolCall
} from '@opencompanion/protocol'
import { z } from 'zod'
import { BRAND } from './brand'
import type { Executor, RunHooks } from './executor'

/** The companion routes are mounted under the app's API base (`{API_URL}/companion/...`). */
const COMPANION_PATH = '/companion'
/** How often (ms) buffered run frames are flushed to the backend while a run streams. */
const FLUSH_INTERVAL_MS = 300
/** Cap on buffered frames so a backend outage cannot grow the buffer without bound. */
const MAX_PENDING_FRAMES = 2000
/**
 * Max frames per `/events` POST. The backend caps a batch at 200 (`eventsSchema`), so a busy run's
 * buffer is flushed in ordered chunks of this size rather than one oversized POST that would 400.
 */
const MAX_EVENTS_PER_BATCH = 200
/**
 * Cap on remembered accepted/completed run ids (the dedupe ledger). Bounds memory while still covering
 * far more concurrent + recently-finished runs than a daemon ever has in flight, so a redelivered
 * completed run is not re-executed.
 */
const MAX_DEDUPE_RUN_IDS = 4000

/**
 * Runtime schema for the `/poll` response ENVELOPE at the hostile-backend edge. `runs` and `connects`
 * are kept as unknown arrays here so ONE malformed item is skipped individually (each is validated with
 * {@link RunStartSchema} / {@link ConnectInstructionSchema} in `pollOnce`) rather than dropping the
 * whole batch; `cancel` is a plain string array and `wireToken` is optional. A body that is not even
 * shaped like this is rejected outright, so nothing propagates `undefined` into
 * `remember`/`hooksFor`/`resolveWorkFolder`.
 */
const PollResponseSchema = z.object({
  runs: z.array(z.unknown()).optional(),
  cancel: z.array(z.string().min(1)).optional(),
  connects: z.array(z.unknown()).optional(),
  wireToken: z.string().optional()
})

/**
 * Runtime schema for the `/connect` response envelope at the hostile-backend edge. `wireToken` is the
 * essential value (a body without it is a failed connect); `companionId` and `pollIntervalMs` are
 * optional and tolerated so a leaner/older backend response still connects. Validating here removes the
 * blind cast that trusted the body's shape.
 */
const ConnectResponseSchema = z.object({
  companionId: z.string().optional(),
  wireToken: z.string().min(1),
  pollIntervalMs: z.number().optional()
})

/**
 * Runtime schema for the cancel-carrying `/events` (and `/poll`-adjacent) response envelope. `cancel`
 * is an optional array of run ids; a body that is not shaped like this validates to no cancels rather
 * than throwing at the cancel loop, so a malformed `cancel` cannot crash the flush.
 */
const EventsResponseSchema = z.object({
  cancel: z.array(z.string().min(1)).optional()
})

/** A minimal HTTP response surface (a subset of `fetch`'s `Response`), injectable for tests. */
export interface HttpResponse {
  /** The HTTP status code. */
  status: number
  /** Parses the JSON body. */
  json(): Promise<unknown>
}

/** A minimal HTTP client (a subset of `fetch`), injectable for tests. */
export type HttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<HttpResponse>

/**
 * The daemon's current self-update state, reported to the backend for presence so the app can badge a
 * device that has an update waiting. Both fields optional: `latestVersion` is the newest version the
 * checker has seen; `updateAvailable` is whether that is newer than the running build. Task 5 wires the
 * real checker - until then the daemon reports neither.
 */
export interface UpdateState {
  /** The newest companion version the update checker has seen, when known. */
  latestVersion?: string
  /** Whether a newer version than the running build is available, once the checker has run. */
  updateAvailable?: boolean
}

/** Injected dependencies for {@link createPollClient}. */
export interface PollClientDeps {
  /** The buyer backend origin the companion is paired with (e.g. `https://app.com`). */
  backendUrl: string
  /** The Better Auth device-authorization bearer (exchanged at `/connect` for a wire token). */
  bearer: string
  /** This companion's device id. */
  deviceId: string
  /** The companion build version (reported to the backend for presence). */
  version: string
  /** This daemon's host machine name (reported for presence so the app can label the device). Omitted = not reported. */
  hostname?: string
  /**
   * Returns the daemon's CURRENT self-update state, called every poll (a function, not a snapshot, so
   * each poll reports fresh state). Omitted (or returning empty) means the daemon reports no update
   * state; task 5 supplies the real checker.
   */
  updateState?: () => UpdateState
  /** Executes dispatched runs (its hooks push frames / resolve tool calls over HTTP). */
  executor: Pick<Executor, 'start' | 'cancel'>
  /** The initial CLI-auth health reported to the backend (defaults to `"unknown"`). */
  authHealth?: AuthHealth
  /**
   * Returns the CLIs this companion has connected (tool id + auth-health), reported to the backend on
   * connect so the web can offer only connected CLIs and show each CLI's real status. Optional and
   * back-compat: when unset the daemon simply omits `connections` from the connect body.
   */
  listConnections?: () => CliConnectionInfo[]
  /** The HTTP client (defaults to a `fetch` wrapper). */
  http?: HttpClient
  /** Fired per validated connect instruction the poll delivered (the serve runner's intake). */
  onConnectInstruction?: (instruction: ConnectInstruction) => void
  /** Fired when a run surfaces a terminal error, so the daemon can lazily re-probe CLI-auth health. */
  onRunError?: () => void
  /** Fired per run that requested `network: 'off'` against an adapter that cannot OS-enforce egress. */
  onNetworkNotEnforced?: (runId: string, adapter: string) => void
  /** Sink for diagnostic lines (defaults to a no-op). */
  log?: (line: string) => void
}

/** A running HTTP poll client. */
export interface PollClient {
  /** Exchanges the device token for a wire token + poll cadence. Returns false on failure. */
  connect(): Promise<boolean>
  /** Runs one poll cycle: collect dispatched runs + cancels, ack + start new runs, cancel stopped ones. */
  pollOnce(): Promise<void>
  /** Flushes buffered run frames to the backend and applies any cancels it returns. */
  flushEvents(): Promise<void>
  /** POSTs one connect instruction's result; throws on a non-200 so the runner can retry via redelivery. */
  postConnectResult(requestId: string, body: ConnectResultBody): Promise<void>
  /** Starts the background poll + flush loops (production). */
  start(): void
  /** Stops the loops and flushes any remaining frames; resolves once the final flush completes. */
  stop(): Promise<void>
  /** Updates the CLI-auth health reported on the next connect/poll. */
  setAuthHealth(health: AuthHealth): void
}

/** Sleeps `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wraps the global `fetch` as an {@link HttpClient}. */
function defaultHttp(): HttpClient {
  return async (url, init) => {
    const res = await fetch(url, init)
    return { status: res.status, json: () => res.json() }
  }
}

/**
 * Builds the companion's HTTP poll client - the stateless replacement for the Socket.IO relay client.
 * It exchanges the daemon's device token for a short-lived wire token at `/connect`, then PULLS
 * dispatched runs (`GET /poll`, which doubles as the presence heartbeat) and PUSHES the runs' live
 * frames (`POST /events`, flushed in ordered chunks of at most 200 with a per-chunk idempotency batch
 * id) plus synchronous tool-call results (`POST /tool-call`). A 401 on any call transparently
 * re-connects and retries once, so an expired wire token never interrupts a run. Cancels ride back on
 * the poll AND events responses. Nothing is held open: idle, the client just polls on a relaxed
 * cadence the backend hands it.
 *
 * @param deps - The backend URL, device bearer + id, executor, and optional http/hooks overrides.
 * @returns The poll client.
 */
export function createPollClient(deps: PollClientDeps): PollClient {
  const http = deps.http ?? defaultHttp()
  // `backendUrl` is the app's API base (`API_URL`: origin + base path, e.g. `https://app.com/api` in
  // fullstack or `https://api.example.com` for a separate backend). The companion routes hang off it,
  // so append the relative path rather than assuming a hardcoded `/api` on the bare origin.
  const base = `${deps.backendUrl.replace(/\/+$/, '')}${COMPANION_PATH}`
  /**
   * The dedupe ledger of run ids ever accepted (bounded, insertion-ordered). It is the SOLE dedupe
   * mechanism and is NEVER cleared on a run closing, so a redelivered completed run (a lost ack + a
   * queue redelivery after it finished) is skipped rather than re-executed.
   */
  const accepted = new Set<string>()
  /** Buffered run frames awaiting a flush to `/events`. */
  const pending: Array<RunEventMsg | RunConversationMsg> = []

  let wireToken: string | null = null
  let pollIntervalMs = 10_000
  let authHealth: AuthHealth = deps.authHealth ?? 'unknown'
  let running = false
  /**
   * Set by `stop()` so an already-dispatched poll bails BEFORE acking or starting any new run: acking
   * removes a run from the backend queue, so acking during shutdown would either lose the run (acked
   * but never started, as the daemon is exiting) or start it after the final flush has drained. Once
   * this is set, no un-acked run is committed - it stays queued for redelivery on the next boot.
   */
  let stopping = false
  /** The in-flight poll cycle, so `stop()` can await it before the final flush (never mid-ack). */
  let pollInFlight: Promise<void> | null = null
  /** The in-flight connect, so concurrent 401s (poll + flush loops) share ONE token exchange. */
  let connecting: Promise<boolean> | null = null
  /**
   * The single in-flight `/events` flush, so `stop()` and the flush loop serialize on it: `stop()`
   * awaits any flush already running THEN runs exactly one final flush, never racing a mid-POST splice.
   */
  let flushInFlight: Promise<void> | null = null
  /**
   * A per-daemon monotonic `/events` batch id. Sent with every flush chunk so the backend can dedupe a
   * resent batch (a lost response makes us resend the SAME id), making the append idempotent.
   */
  let batchSeq = 0

  /** Records a run id in the bounded dedupe ledger, evicting the oldest when it overflows. */
  function remember(runId: string): void {
    accepted.add(runId)
    if (accepted.size > MAX_DEDUPE_RUN_IDS) {
      const oldest = accepted.values().next().value
      if (oldest !== undefined) accepted.delete(oldest)
    }
  }

  /** Issues an authenticated request; on a 401 it re-connects once and retries. */
  async function request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<HttpResponse> {
    const send = (): Promise<HttpResponse> =>
      http(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${wireToken ?? ''}`
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    let res = await send()
    if (res.status === 401 && (await connect())) res = await send()
    return res
  }

  /** Resolves a web-side tool call over HTTP (the executor awaits this). */
  async function postToolCall(call: Omit<ToolCall, 'callId'>): Promise<unknown> {
    const callId = crypto.randomUUID()
    const res = await request('POST', '/tool-call', {
      runId: call.runId,
      callId,
      name: call.name,
      args: call.args
    })
    if (res.status !== 200) throw new Error(`tool-call failed (${res.status})`)
    // Validate the reply instead of trusting a blind cast: a malformed tool.result fails THIS tool call
    // (the model sees a tool error) rather than propagating an unchecked value into the run.
    const parsed = ToolResultSchema.safeParse(await res.json())
    if (!parsed.success) throw new Error('Malformed tool.result from backend')
    const result = parsed.data
    if (result.ok) return result.result
    throw new Error(result.error ?? 'Web tool failed')
  }

  /** Buffers a frame for the next flush, dropping the oldest if the buffer is saturated. */
  function buffer(frame: RunEventMsg | RunConversationMsg): void {
    pending.push(frame)
    if (pending.length > MAX_PENDING_FRAMES) pending.splice(0, pending.length - MAX_PENDING_FRAMES)
  }

  /** Builds the executor hooks for a run: frames buffer to `/events`, tool calls go to `/tool-call`. */
  function hooksFor(runId: string): RunHooks {
    return {
      onEvent: (msg: RunEventMsg) => {
        if (msg.event.type === 'error') deps.onRunError?.()
        buffer(msg)
      },
      onConversation: (msg: RunConversationMsg) => buffer(msg),
      onToolCall: postToolCall,
      onNetworkNotEnforced: (adapter: string) => deps.onNetworkNotEnforced?.(runId, adapter),
      onClose: () => {
        // The dedupe ledger (`accepted`) deliberately KEEPS this run id, so a redelivered
        // completed run (lost ack + queue redelivery) is not re-executed.
      }
    }
  }

  /** Exchanges the device token for a wire token, deduping concurrent callers onto one request. */
  function connect(): Promise<boolean> {
    if (connecting) return connecting
    connecting = doConnect().finally(() => {
      connecting = null
    })
    return connecting
  }

  async function doConnect(): Promise<boolean> {
    try {
      // Report the CLIs this companion has connected (tool id + auth-health) so the backend can surface
      // connected-only CLIs + per-CLI status to the web. Omitted when the host wires no reader (fully
      // back-compat: an older backend ignores the field, a newer one keeps the prior connections).
      const connections = deps.listConnections?.()
      // Presence metadata (host name + self-update state) rides the connect body too, additive and
      // optional: an older backend ignores the fields, and a daemon that reports none simply omits them.
      const updateState = deps.updateState?.()
      const res = await http(`${base}/connect`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.bearer}`
        },
        body: JSON.stringify({
          deviceId: deps.deviceId,
          version: deps.version,
          authHealth,
          ...(connections ? { connections } : {}),
          ...(deps.hostname ? { hostname: deps.hostname } : {}),
          ...(updateState?.latestVersion ? { latestVersion: updateState.latestVersion } : {}),
          ...(updateState?.updateAvailable !== undefined ? { updateAvailable: updateState.updateAvailable } : {})
        })
      })
      if (res.status !== 200) {
        deps.log?.(`${BRAND.binary} connect failed (${res.status})\n`)
        return false
      }
      // Validate the envelope instead of trusting a blind cast: a body without a usable `wireToken` is a
      // failed connect (rather than a client that then authenticates with `undefined`).
      const parsed = ConnectResponseSchema.safeParse(await res.json())
      if (!parsed.success) {
        deps.log?.(`${BRAND.binary} connect: malformed response body\n`)
        return false
      }
      const body = parsed.data
      wireToken = body.wireToken
      if (body.pollIntervalMs !== undefined && body.pollIntervalMs > 0) pollIntervalMs = body.pollIntervalMs
      return true
    } catch (err) {
      deps.log?.(`${BRAND.binary} connect error: ${String(err)}\n`)
      return false
    }
  }

  /**
   * Runs one poll cycle, tracking it as the in-flight poll so `stop()` can await it. Not re-entrant in
   * production (the poll loop awaits each cycle before the next); a direct caller that overlaps calls
   * simply overwrites the tracked handle with the latest, which is all `stop()` needs.
   */
  function pollOnce(): Promise<void> {
    const cycle = doPollOnce()
    pollInFlight = cycle
    const clear = (): void => {
      if (pollInFlight === cycle) pollInFlight = null
    }
    void cycle.then(clear, clear)
    return cycle
  }

  async function doPollOnce(): Promise<void> {
    if (stopping) return
    if (!wireToken && !(await connect())) return
    if (stopping) return
    // The poll carries presence metadata as query params so the backend keeps version + auth-health
    // fresh without a separate heartbeat call (the poll IS the heartbeat). The connection set changes
    // mid-session (an external `companion connect`/`disconnect` writes the state file), so re-report it
    // here too - not just on connect - so a connect/disconnect reaches the durable device registry
    // within one poll. Omitted when no reader is wired (back-compat: an older backend ignores it).
    const conns = deps.listConnections?.()
    const connectionsParam =
      conns !== undefined ? `&connections=${encodeURIComponent(JSON.stringify(conns))}` : ''
    // Presence metadata rides the poll query alongside version/auth-health (the poll IS the heartbeat),
    // each appended only when the daemon has it. `updateState()` is read fresh every poll so a newly
    // detected update propagates on the next heartbeat, not just at connect. `updateAvailable` is
    // serialized as the literal `true`/`false` so an explicit `false` is reported, not omitted.
    const updateState = deps.updateState?.()
    const hostnameParam = deps.hostname ? `&hostname=${encodeURIComponent(deps.hostname)}` : ''
    const latestParam = updateState?.latestVersion
      ? `&latestVersion=${encodeURIComponent(updateState.latestVersion)}`
      : ''
    const availableParam =
      updateState?.updateAvailable !== undefined ? `&updateAvailable=${updateState.updateAvailable}` : ''
    const query = `?version=${encodeURIComponent(deps.version)}&authHealth=${encodeURIComponent(authHealth)}${connectionsParam}${hostnameParam}${latestParam}${availableParam}`
    const res = await request('GET', `/poll${query}`)
    if (res.status !== 200) return
    // Shutdown began while this poll was in flight: do not ack/start anything the response carried;
    // leave the runs queued so they redeliver on the next boot rather than starting mid-teardown.
    if (stopping) return
    // Validate the response ENVELOPE before touching any run: a hostile/buggy backend must not
    // propagate `undefined` runs into `remember`/`hooksFor`/`resolveWorkFolder`. A body that is not
    // even shaped like the envelope is logged and dropped (treated as an empty poll).
    const parsed = PollResponseSchema.safeParse(await res.json())
    if (!parsed.success) {
      deps.log?.(`${BRAND.binary} poll: malformed response body, ignoring\n`)
      return
    }
    const body = parsed.data
    if (body.wireToken) wireToken = body.wireToken
    const cancelSet = new Set(body.cancel ?? [])
    for (const runId of cancelSet) deps.executor.cancel(runId)
    for (const raw of body.connects ?? []) {
      // Re-check between items: if shutdown began, stop delivering the rest so they redeliver on the
      // next boot instead of being handed to the runner as the daemon tears down.
      if (stopping) return
      // Validate EACH instruction at the hostile-backend edge; a malformed one is skipped + logged
      // individually (mirror of the runs validation). Idempotency/dedupe is the runner's job.
      const instruction = ConnectInstructionSchema.safeParse(raw)
      if (!instruction.success) {
        deps.log?.(`${BRAND.binary} poll: skipping malformed connect instruction\n`)
        continue
      }
      deps.onConnectInstruction?.(instruction.data)
    }
    for (const raw of body.runs ?? []) {
      // Re-check between runs: if shutdown began during a prior run's ack, stop acking the rest so
      // they redeliver on the next boot instead of being committed as the daemon tears down.
      if (stopping) return
      // Validate EACH run at the hostile-backend edge with the shared protocol schema; a malformed
      // run is skipped + logged individually (never dropping the whole batch, never starting an
      // ill-shaped run). The parse is what removes the blind `as RunStart[]` cast.
      const run = RunStartSchema.safeParse(raw)
      if (!run.success) {
        deps.log?.(`${BRAND.binary} poll: skipping malformed run.start\n`)
        continue
      }
      const start = run.data
      // Skip a run already accepted (its ack was lost and it was redelivered) so a completed run is
      // never re-executed - the dedupe ledger outlives the run and is never cleared on close.
      if (accepted.has(start.runId)) continue
      // A run returned in the SAME response as its cancel must not start: ack-discard it (remove it
      // from the queue) and remember it so a later redelivery is deduped, but never start it. Mutate
      // the ledger ONLY after the ack succeeds, so a failed ack-discard does not permanently dedupe
      // a run that is still queued backend-side.
      if (cancelSet.has(start.runId)) {
        const ack = await request('POST', `/runs/${encodeURIComponent(start.runId)}/ack`)
        if (ack.status === 200) remember(start.runId)
        continue
      }
      // Ack BEFORE starting so a redelivered run (a lost ack) is deduped by the ledger, never run
      // twice - but mutate the dedupe ledger ONLY on a 200 ack. A throwing ack must not leave a run
      // permanently deduped-but-unstarted, and a non-200 ack must not start it; both cases simply let
      // the next poll redeliver and retry.
      const ack = await request('POST', `/runs/${encodeURIComponent(start.runId)}/ack`)
      if (ack.status !== 200) continue
      // Shutdown may have begun WHILE this ack was in flight - the top-of-loop `stopping` check cannot
      // catch that. Re-check now, BEFORE committing the dedupe ledger or launching the run: starting it
      // here would strand its async frames past the final flush (stop() awaits this poll cycle, but the
      // run's events arrive afterwards). Bail WITHOUT remembering it, so a redelivery runs it cleanly on
      // the next boot rather than half-running it during teardown.
      if (stopping) return
      remember(start.runId)
      // The run is acked (removed from the queue), so it will not be redelivered. Preparing it
      // locally can still throw synchronously (e.g. a hostile `productId` that `resolveWorkFolder`
      // refuses), so surface a terminal error for the run instead of silently forgetting it.
      try {
        deps.executor.start(start, hooksFor(start.runId))
      } catch (err) {
        buffer({
          type: 'run.event',
          runId: start.runId,
          event: { type: 'error', message: err instanceof Error ? err.message : 'run failed to start' }
        })
      }
    }
  }

  /**
   * Drains the pending buffer to `/events` in ordered chunks of at most {@link MAX_EVENTS_PER_BATCH}
   * (the backend caps a batch at 200). Each chunk carries a fresh monotonic batch id so a resent chunk
   * is deduped backend-side. On a failed chunk it re-queues ONLY that chunk plus the still-unsent
   * remainder, in order (front of the buffer), and stops - so order is preserved and a transient
   * failure never drops or reorders frames. Not re-entrant: callers serialize via {@link flushEvents}.
   */
  async function drainPending(): Promise<void> {
    while (pending.length > 0) {
      const chunk = pending.splice(0, MAX_EVENTS_PER_BATCH)
      const batchId = batchSeq++
      let res: HttpResponse
      try {
        res = await request('POST', '/events', { events: chunk, batchId })
      } catch (err) {
        // Re-queue this chunk ahead of the unsent remainder so order is preserved, then rethrow (the
        // caller's loop logs it). The resend reuses the same batchId, so the backend dedupes it.
        batchSeq--
        pending.unshift(...chunk)
        if (pending.length > MAX_PENDING_FRAMES) pending.splice(0, pending.length - MAX_PENDING_FRAMES)
        throw err
      }
      if (res.status !== 200) {
        // Re-queue this chunk ahead of the unsent remainder (order-preserving, bounded) and stop; the
        // next flush retries it with the SAME batchId, so the backend never double-appends.
        batchSeq--
        pending.unshift(...chunk)
        if (pending.length > MAX_PENDING_FRAMES) pending.splice(0, pending.length - MAX_PENDING_FRAMES)
        return
      }
      // Validate the cancel envelope: a malformed body (or a non-array `cancel`) must not throw at the
      // loop below, so it degrades to no cancels rather than crashing the flush.
      const parsed = EventsResponseSchema.safeParse(await res.json())
      const cancels = parsed.success ? (parsed.data.cancel ?? []) : []
      for (const runId of cancels) deps.executor.cancel(runId)
    }
  }

  async function flushEvents(): Promise<void> {
    // Serialize on a single in-flight flush so the flush loop and stop() never run two drains at once
    // (a mid-POST splice racing a second drain would reorder / drop frames). Callers await the SAME
    // promise, so whoever arrives during a flush simply waits for it.
    if (flushInFlight) return flushInFlight
    flushInFlight = drainPending().finally(() => {
      flushInFlight = null
    })
    return flushInFlight
  }

  async function pollLoop(): Promise<void> {
    while (running) {
      try {
        await pollOnce()
      } catch (err) {
        deps.log?.(`${BRAND.binary} poll error: ${String(err)}\n`)
      }
      await sleep(pollIntervalMs)
    }
  }

  async function flushLoop(): Promise<void> {
    while (running) {
      try {
        await flushEvents()
      } catch (err) {
        deps.log?.(`${BRAND.binary} flush error: ${String(err)}\n`)
      }
      await sleep(FLUSH_INTERVAL_MS)
    }
  }

  return {
    connect,
    pollOnce,
    flushEvents,
    async postConnectResult(requestId: string, body: ConnectResultBody): Promise<void> {
      const res = await request('POST', `/connects/${encodeURIComponent(requestId)}/result`, body)
      if (res.status !== 200) throw new Error(`connect result post failed (${res.status})`)
    },
    start(): void {
      running = true
      // Attach a terminal `.catch` so an unexpected throw that escapes the loops' own try/catch (the
      // loops already guard `pollOnce`/`flushEvents`) surfaces as a log line rather than an unhandled
      // rejection that could crash the daemon process.
      void pollLoop().catch((err: unknown) => deps.log?.(`${BRAND.binary} poll loop crashed: ${String(err)}\n`))
      void flushLoop().catch((err: unknown) => deps.log?.(`${BRAND.binary} flush loop crashed: ${String(err)}\n`))
    },
    async stop(): Promise<void> {
      running = false
      stopping = true
      // Await any poll already in flight BEFORE the final flush: its `stopping` guards make it bail
      // before acking/starting any new run, so shutdown never acks a run after the final flush drains
      // (which would strand that run's events). Only then serialize with the flush loop.
      const inFlightPoll = pollInFlight
      if (inFlightPoll) await inFlightPoll.catch(() => undefined)
      // Serialize with any flush already mid-POST: await it first (it may still be draining or have
      // just re-queued a failed chunk), THEN run exactly one final flush so the last batch - which
      // routinely carries a run's terminal `done`/`error` frame - is drained before we resolve. Awaiting
      // the shared in-flight promise (not starting a second drain) is what makes shutdown race-free.
      if (flushInFlight) await flushInFlight.catch(() => undefined)
      await flushEvents()
    },
    setAuthHealth(health: AuthHealth): void {
      authHealth = health
    }
  }
}
