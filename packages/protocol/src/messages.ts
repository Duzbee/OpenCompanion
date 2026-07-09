import { z } from 'zod'
import type { McpServerSpec, ReasoningEffort, RunEvent } from './vocab'
import { RunPolicySchema, type RunPolicy } from './policy'

/**
 * The coding CLI ids the companion daemon can connect and drive - the single source of truth for
 * every `connectionId`/`toolId` allowlist on both ends of the wire (backend dispatch/enqueue,
 * daemon connect/run execution, the backend companion-key codec). Adding a CLI here is the one
 * required list change; both packages import it, so the two ends can never drift.
 */
export const CONNECTABLE_TOOL_IDS = ['claude-code', 'codex', 'opencode', 'hermes'] as const

/** A CLI tool id the companion daemon can connect and drive (see {@link CONNECTABLE_TOOL_IDS}). */
export type ConnectableToolId = (typeof CONNECTABLE_TOOL_IDS)[number]

/**
 * Whether a string is a CLI tool id the companion daemon can connect and drive - the shared
 * allowlist predicate both the backend (dispatch, connect enqueue) and the daemon (connect-runner,
 * run execution) apply.
 *
 * @param value - The candidate tool/connection id.
 * @returns True when it is a connectable CLI id.
 */
export function isConnectableToolId(value: string): value is ConnectableToolId {
  return (CONNECTABLE_TOOL_IDS as readonly string[]).includes(value)
}

/**
 * `zod` schema for the {@link ReasoningEffort} ladder carried in a
 * {@link RunStart}. The `satisfies` guard keeps the wire enum in lockstep with the canonical union:
 * adding a level to `ReasoningEffort` fails this line until the schema is updated too.
 */
export const ReasoningEffortSchema = z.enum([
  'default',
  'off',
  'low',
  'medium',
  'high'
]) satisfies z.ZodType<ReasoningEffort>

/**
 * `zod` schema for a {@link McpServerSpec} carried in a {@link RunStart}.
 * Mirrors the type field-for-field so a wire payload can be validated before the companion
 * launches the server. The schema is the runtime guard; the static type stays the source of truth.
 */
export const McpServerSpecSchema = z.object({
  type: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional()
}) satisfies z.ZodType<McpServerSpec>

/**
 * One web-side tool the agent may call over the daemon transport (knowledge etc.), described as a
 * serializable manifest entry - NO live `ToolSet` (functions cannot cross the wire). The
 * companion turns each entry into a loopback-MCP tool whose `execute` proxies a `tool.call`.
 */
export interface WebToolManifestEntry {
  /** Tool name the model invokes. */
  name: string
  /** Human-readable description surfaced to the model. */
  description?: string
  /** The tool's JSON Schema (object schema). */
  inputSchema: Record<string, unknown>
}

/** `zod` schema for a {@link WebToolManifestEntry}. */
export const WebToolManifestEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown())
})

/**
 * DOWN (backend -> companion): start a fully-composed run. The backend composes the
 * grounded `systemPrompt`, model, web-tool manifest, and policy; the companion fills
 * only the local bits (cwd, binary, loopback MCP). Fully serializable - no `ToolSet`.
 */
export interface RunStart {
  type: 'run.start'
  /** Idempotency key; the companion acks and dedupes by this. */
  runId: string
  /** The composed agent's id (for logging/telemetry). */
  agentId: string
  /** The product this run executes on behalf of (isolation boundary). */
  productId: string
  /** The end user whose subscription pays. */
  userId: string
  /** The connection (tool + auth mode) to drive. */
  connectionId: string
  /** The user prompt / task input. */
  input: string
  /** The grounded system prompt the backend composed. */
  systemPrompt?: string
  /** Pinned model id for this run. */
  modelId?: string
  /**
   * Reasoning effort for this run, mapped by the daemon onto the CLI's native reasoning knob (Claude
   * Code adaptive thinking + effort, Codex `modelReasoningEffort`); a CLI without one ignores it.
   * Absent/`"default"` leaves the model's native behaviour, so a default dispatch is unchanged.
   */
  effort?: ReasoningEffort
  /**
   * The schedule this run finalizes, when the run was dispatched by a scheduled companion task
   * (PARITY-D). Set ONLY on scheduled dispatch; a chat/ad-hoc run omits it. The backend tags the
   * run with it so the terminal-frame handler can record the schedule's last-run + assistant output
   * and fire the schedule's notification, the same way the cloud schedule path does.
   */
  scheduleId?: string
  /** SDK session/thread id to resume a multi-turn conversation. */
  conversationId?: string
  /** The web-side tools (knowledge etc.) the agent may call over the daemon transport. */
  webToolManifest: WebToolManifestEntry[]
  /**
   * Reserved, IGNORED by the daemon. A historical field for backend-composed MCP servers. The
   * companion deliberately does NOT launch a server pushed over the wire: a `stdio` spec would
   * spawn an arbitrary local command outside the run's confinement, permission mode, and network
   * sandbox, so the daemon drops `mcpServers` entirely (the loopback web-tools MCP is added locally
   * by the executor, never from this field). Kept on the schema only so an older backend's payload
   * still parses; it has no effect.
   */
  mcpServers?: Record<string, McpServerSpec>
  /** The requested policy (clamped by the per-backend ceiling on arrival). */
  policy?: RunPolicy
}

/** `zod` schema for {@link RunStart}. */
export const RunStartSchema = z.object({
  type: z.literal('run.start'),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  productId: z.string().min(1),
  userId: z.string().min(1),
  connectionId: z.string().min(1),
  input: z.string(),
  systemPrompt: z.string().optional(),
  modelId: z.string().optional(),
  effort: ReasoningEffortSchema.optional(),
  scheduleId: z.string().optional(),
  conversationId: z.string().optional(),
  webToolManifest: z.array(WebToolManifestEntrySchema),
  mcpServers: z.record(z.string(), McpServerSpecSchema).optional(),
  policy: RunPolicySchema.optional()
})

/** DOWN: cancel an in-flight run by id (idempotent). */
export interface RunCancel {
  type: 'run.cancel'
  runId: string
}

/** `zod` schema for {@link RunCancel}. */
export const RunCancelSchema = z.object({
  type: z.literal('run.cancel'),
  runId: z.string().min(1)
})

/** DOWN: the reply to a web-side `tool.call` the companion proxied (knowledge result). */
export interface ToolResult {
  type: 'tool.result'
  runId: string
  /** Correlates with the `ToolCall.callId` the companion sent up. */
  callId: string
  /** Whether the web-side tool succeeded. */
  ok: boolean
  /** The serialized tool result (when `ok`). */
  result?: unknown
  /** The error message (when not `ok`). */
  error?: string
}

/** `zod` schema for {@link ToolResult}. */
export const ToolResultSchema = z.object({
  type: z.literal('tool.result'),
  runId: z.string().min(1),
  callId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional()
})

/** UP (companion -> backend): one streamed run event, tagged with its run id. */
export interface RunEventMsg {
  type: 'run.event'
  runId: string
  /** The runtime event (the pure {@link RunEvent} union; the SDK session/thread id rides the separate {@link RunConversationMsg}). */
  event: RunEvent
}

/**
 * UP (companion -> backend): the SDK session/thread id a run produced, carried up so the backend
 * can persist it against the run and set `RunStart.conversationId` on the NEXT dispatch to resume
 * the multi-turn conversation (I1). The runtime surfaces this once per run (Claude `session_id` /
 * Codex `thread_id`); the executor forwards it here instead of dropping it.
 */
export interface RunConversationMsg {
  type: 'run.conversation'
  /** The run that produced the session/thread id (correlates with the dispatched `RunStart.runId`). */
  runId: string
  /** The SDK session/thread id to persist and replay as `conversationId` on the next turn. */
  conversationId: string
}

/** `zod` schema for {@link RunConversationMsg}. */
export const RunConversationMsgSchema = z.object({
  type: z.literal('run.conversation'),
  runId: z.string().min(1),
  conversationId: z.string().min(1)
})

/** UP: the agent invoked a web-side tool; the backend resolves it and replies `tool.result`. */
export interface ToolCall {
  type: 'tool.call'
  runId: string
  /** Correlation id the backend echoes on `tool.result`. */
  callId: string
  /** The web-side tool name from the manifest. */
  name: string
  /** The tool arguments the model produced. */
  args: Record<string, unknown>
}

/** `zod` schema for {@link ToolCall}. */
export const ToolCallSchema = z.object({
  type: z.literal('tool.call'),
  runId: z.string().min(1),
  callId: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown())
}) satisfies z.ZodType<ToolCall>

/** The daemon's lazily probed CLI-auth lifecycle state, carried up over presence. */
export type AuthHealth = 'healthy' | 'needs-reauth' | 'unknown'

/** `zod` schema for {@link AuthHealth}. */
export const AuthHealthSchema = z.enum(['healthy', 'needs-reauth', 'unknown'])

/**
 * One coding CLI the daemon has connected on a device, with its last observed auth-health. Reported
 * UP by the daemon at connect so the backend can surface which CLIs a device actually has wired up
 * (and whether each needs re-auth) to the web - the model picker offers only connected CLIs and the
 * Providers section shows each CLI's real status. The daemon's own richer per-connection record
 * (which also tracks reuse vs install) stays local; only this connection-status subset crosses the wire.
 */
export interface CliConnectionInfo {
  /** The connected CLI's tool id (one of {@link CONNECTABLE_TOOL_IDS}). */
  toolId: string
  /** The CLI's last observed auth-health, so the web can flag a connected-but-needs-reauth CLI. */
  authHealth: AuthHealth
}

/** `zod` schema for {@link CliConnectionInfo}. */
export const CliConnectionInfoSchema = z.object({
  toolId: z.string().min(1),
  authHealth: AuthHealthSchema
}) satisfies z.ZodType<CliConnectionInfo>

/** An instruction (backend -> daemon) to run the headless connect flow for one coding CLI. */
export interface ConnectInstruction {
  /** The instruction's idempotency + result-correlation key (backend-minted UUID). */
  requestId: string
  /** The CLI to connect; the allowlist is enforced backend-side at enqueue AND daemon-side at execution. */
  toolId: string
  /** Whether a missing installable CLI may be managed-installed (set only by an explicit user action). */
  install: boolean
}

/** Runtime schema for {@link ConnectInstruction} (validated per-item at the daemon's hostile edge). */
export const ConnectInstructionSchema = z.object({
  requestId: z.string().min(1),
  toolId: z.string().min(1),
  install: z.boolean()
})

/** The typed outcome of one daemon-side headless connect (the extensibility seam for future statuses). */
export const ConnectResultStatusSchema = z.enum([
  'connected',
  'needs-login',
  'installed-needs-login',
  'not-installed',
  'failed'
])

/** One headless connect outcome status. */
export type ConnectResultStatus = z.infer<typeof ConnectResultStatusSchema>

/** The result body the daemon POSTs back for one connect instruction. */
export interface ConnectResultBody {
  /** The CLI the instruction targeted. */
  toolId: string
  /** The typed outcome. */
  status: ConnectResultStatus
  /** The recorded auth health (present on `connected`). */
  authHealth?: AuthHealth
  /** Vendor install guidance (present on `not-installed` for a system-install-only CLI). */
  guidance?: string
  /** The failure reason (present on `failed`). */
  reason?: string
  /** The daemon's fresh per-CLI connections snapshot, so the backend can update the device registry. */
  connections?: CliConnectionInfo[]
}

/** Runtime schema for {@link ConnectResultBody} (the transport validates the daemon's POST with it). */
export const ConnectResultBodySchema = z.object({
  toolId: z.string().min(1),
  status: ConnectResultStatusSchema,
  authHealth: AuthHealthSchema.optional(),
  guidance: z.string().optional(),
  reason: z.string().optional(),
  connections: z.array(CliConnectionInfoSchema).optional()
})

/**
 * The current companion wire-protocol version the backend advertises on `/connect`. Additive and
 * monotonic: bump it when the wire contract changes in a way a daemon must be able to detect. A
 * pre-versioning backend omits it, so a daemon reads "absent" as the un-versioned baseline.
 */
export const COMPANION_PROTOCOL_VERSION = 1

/**
 * The `/connect` handshake response the backend returns to a pairing daemon. It carries the
 * short-lived wire token the daemon authenticates every subsequent poll/POST with, its resolved
 * companion id, the poll cadence, and - additive - the {@link COMPANION_PROTOCOL_VERSION} the backend
 * speaks so a daemon can detect the backend's capabilities. Only `wireToken` is required; every other
 * field is optional so a leaner or older backend response still connects, and a daemon that does not
 * know a field simply ignores it.
 */
export interface ConnectResponse {
  /** The daemon's resolved companion id (`<userId>:<deviceId>`). */
  companionId?: string
  /** The short-lived HMAC wire token that authenticates every subsequent poll/POST. */
  wireToken: string
  /** The poll cadence (ms) the backend wants the daemon to use. */
  pollIntervalMs?: number
  /** The wire protocol version the backend speaks; absent from a pre-versioning backend. */
  protocolVersion?: number
}

/** `zod` schema for {@link ConnectResponse} (the transport can validate the handshake body with it). */
export const ConnectResponseSchema = z.object({
  companionId: z.string().optional(),
  wireToken: z.string().min(1),
  pollIntervalMs: z.number().optional(),
  protocolVersion: z.number().int().positive().optional()
}) satisfies z.ZodType<ConnectResponse>
