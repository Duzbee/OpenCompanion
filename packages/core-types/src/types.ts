/**
 * The local-runtime backend contract: the seam that names the execution backend that
 * orchestrates the user's own installed, vendor-authenticated AI coding tools (Claude
 * Code, Codex, ...) so the user's subscription - or their own API key - pays. Its
 * accounting is separate from the hosted API-provider path (it does NOT debit token-cost
 * credits).
 *
 * These are pure, dependency-light types (zero runtime beyond the `ai` type re-exports and
 * the protocol's tiny wire helpers). They live in `@opencompanion/core-types` - a leaf package
 * that depends on nothing but `@opencompanion/protocol` - so a web-only, AI-enabled buyer
 * pulling `@repo/ai` never drags in the process/SDK machinery of `@opencompanion/core` (and its
 * platform-specific agentic-CLI SDK binaries). `@opencompanion/core` and `@repo/ai/backends`
 * both re-export every type below unchanged, so their existing consumers change no imports.
 */

import type { ModelMessage, ToolSet } from 'ai'
import type {
  McpServerSpec,
  PermissionMode,
  ReasoningEffort,
  RunEvent
} from '@opencompanion/protocol'

export type { McpServerSpec, PermissionMode, ReasoningEffort, RunEvent, TokenUsage } from '@opencompanion/protocol'
export { REASONING_EFFORTS, isReasoningEffort } from '@opencompanion/protocol'

/**
 * Per-connection authentication strategy: the user's vendor subscription, a
 * stored API key, or an OAuth browser/device sign-in that issues a token.
 */
export type AuthMode = 'subscription' | 'apiKey' | 'oauth'

/** A connection the user configured. Non-secret; any API key lives in the OS keychain. */
export interface ConnectionRef {
  /** Stable id (e.g. `crypto.randomUUID()`), used as the keychain entry key. */
  id: string
  /** Which adapter handles this connection, e.g. `"claude-code"` or `"codex"`. */
  toolId: string
  /** Whether the connection drives the user's subscription or a stored API key. */
  authMode: AuthMode
  /** Optional pinned model id; falls back to the adapter/tool default when absent. */
  modelId?: string
  /** Optional API base URL override (for OpenAI-compatible / self-hosted endpoints). */
  baseUrl?: string
}

/**
 * The user's chosen default tool + model ("main model"), persisted for the app.
 * Product code reads this to know which tool and model to drive by default.
 */
export interface DefaultSelection {
  toolId: string
  modelId: string
}

/** Result of probing whether a tool is installed. */
export interface DetectResult {
  installed: boolean
  /** Tool version string when resolvable (e.g. from `--version`). */
  version?: string
  /** Resolved absolute path to the tool binary, when found. */
  path?: string
}

/** Result of probing whether a connection can authenticate. */
export interface AuthStatus {
  authenticated: boolean
  mode: AuthMode
  /** Human-readable detail for the UI (e.g. why auth failed, or which login is used). */
  detail?: string
}

/**
 * A model the tool can run. `source` records where it came from: a runtime query
 * of the tool itself (preferred), the models.dev registry (enrichment/fallback),
 * or a hardcoded declarative fallback.
 */
export interface ModelInfo {
  id: string
  label?: string
  contextWindow?: number
  source: 'tool' | 'registry' | 'fallback'
  /** ISO date the model was released, when known (drives recency sort). */
  releaseDate?: string
  /** True for the newest model in its family (UI may badge it). */
  recommended?: boolean
}

/**
 * The canonical renderer<->main model reference: a provider (matching a connection's
 * `toolId`) + a model id, with an optional {@link ReasoningEffort}. Single source of
 * truth for the `{ providerId, modelId, effort? }` shape threaded across the desktop
 * IPC boundary (renderer override -> preload -> IPC validate -> run dispatch), so a
 * field add/rename is made once here rather than re-declared per site.
 */
export interface ModelRef {
  /** The provider to run on; matches a connection's `toolId`. */
  providerId: string
  /** The model id within the provider. */
  modelId: string
  /** Reasoning effort for this run; absent leaves the model's native behaviour. */
  effort?: ReasoningEffort
}

/** One streamed run request. */
export interface RunRequest {
  connectionId: string
  prompt: string
  /**
   * Typed multi-turn history for a completion run, preferred over `prompt` when
   * present and non-empty. The chat handler builds it from the session's turns so
   * the model sees real `user`/`assistant` roles instead of a flattened string.
   * Completion-only: agentic CLI adapters ignore this and use `prompt` (string).
   */
  messages?: ModelMessage[]
  /** Overrides the connection's pinned model for this run. */
  modelId?: string
  /** Reasoning effort for this run; absent/`"default"` leaves the model's native behaviour. */
  effort?: ReasoningEffort
  /** Working directory the agentic run operates in (validated by the caller). */
  cwd: string
  /** Permission posture; defaults to `read-only` at the call site. */
  permissionMode: PermissionMode
  /** Best-effort tool allowlist (mapped natively or coarsely per adapter). */
  allowedTools?: string[]
  /** Best-effort tool denylist (mapped natively or coarsely per adapter). */
  disallowedTools?: string[]
  /** Optional extra system prompt appended for the run. */
  systemPrompt?: string
  /** Builder-configured MCP servers for this run (threaded to the tool natively). */
  mcpServers?: Record<string, McpServerSpec>
  /**
   * Main-process only; never serialized across IPC (functions cannot cross the
   * bridge); populated by runTask for completion providers from MCP-derived and
   * builder-registered tools. Agentic adapters ignore this.
   */
  tools?: ToolSet
}

/** A decision returned for a pending permission request. */
export type PermissionDecision = 'allow' | 'deny'

/** Handle to an in-flight run. */
export interface RunHandle {
  /** Cancel the in-flight run (AbortController / process signal). Idempotent. */
  cancel(): void
  /**
   * Answer a pending permission request. A no-op for adapters whose
   * {@link AdapterCapabilities.interactiveApproval} is `false`.
   */
  respondToPermission(requestId: string, decision: PermissionDecision): void
}

/** Capabilities an adapter declares so the orchestrator and UI adapt to it. */
export interface AdapterCapabilities {
  /** Auth modes this tool supports legitimately. */
  supportedAuthModes: readonly AuthMode[]
  /** Execution shape: an agentic CLI acting in a working dir, or a completion API. */
  kind: 'agentic' | 'completion'
  /** True if the tool can pause and ask for per-action approval (forwarded to the UI). */
  interactiveApproval: boolean
  /** True if selecting subscription mode must show a blocking ToS risk disclosure first. */
  subscriptionRequiresDisclosure: boolean
  /**
   * True when this agentic adapter can OS-enforce `network: 'off'` (actually cut all egress)
   * for the run it drives. Codex sets it: its SDK exposes `networkAccessEnabled: false`, an
   * OS-enforced sandbox switch, so an unattended `network: 'off'` run is genuinely blocked.
   * Omitted (falsy) for adapters that cannot - Claude Code (the Agent SDK has no single egress
   * boolean; restriction is permission-rule + sandbox based, platform-dependent, and can
   * hard-fail) and OpenCode (`opencode run` exposes no network flag). This is the honest
   * contract the orchestrator/UI reads to decide whether a requested network-off is a real
   * guarantee or merely advisory: when a run requests `network: 'off'` against an adapter whose
   * `enforcesNetworkOff` is falsy, the run still proceeds (non-fatal, since Claude Code is the
   * primary CLI) but the runtime surfaces a per-run "network-not-enforced" signal rather than
   * letting it pass under a silent false guarantee. Irrelevant to completion adapters; omitted.
   */
  enforcesNetworkOff?: boolean
  /**
   * True when this agentic adapter can consume an `http` MCP server, so the runtime
   * may serve the app's tool surface over loopback HTTP and point the CLI at it
   * (its native coding tools stay on; ours are added). Adapters that cannot accept a
   * per-run http MCP server omit it (falsy): their integration/app-MCP tools degrade
   * visibly while native coding still works. Irrelevant to completion adapters
   * (which run tools in-process), so omitted there.
   */
  httpMcp?: boolean
  /**
   * True when starting this provider's OAuth sign-in must show the subscription ToS
   * disclosure first (subscription-backed OAuth like ChatGPT/Codex or Google/Gemini).
   */
  oauthRequiresDisclosure?: boolean
  /**
   * True for a completion provider whose endpoint is user-supplied (local/self-hosted,
   * OpenAI-compatible); the connect UI then requires a base URL. Omitted (falsy) for
   * agentic adapters and hosted API providers with a fixed endpoint.
   */
  supportsBaseUrlOverride?: boolean
  /**
   * The provider's default API base URL, surfaced so the connect UI can pre-fill
   * an editable base-URL field (regional/coding endpoints reachable with one key).
   * Omitted for agentic adapters and providers with no fixed default.
   */
  defaultBaseUrl?: string
}

/**
 * The generic tool adapter every integration implements. Construction is
 * side-effect-free; all I/O happens in the async methods. `run` is push-based:
 * the adapter calls `emit` for each {@link RunEvent} and returns a {@link RunHandle}.
 */
export interface ToolAdapter {
  /** Stable adapter id, e.g. `"claude-code"`. */
  readonly id: string
  /** Display name for the UI (must not mimic a vendor's protected identity). */
  readonly displayName: string
  readonly capabilities: AdapterCapabilities
  /** Probe whether the tool is installed. */
  detect(): Promise<DetectResult>
  /** Probe whether the connection can authenticate. */
  authStatus(conn: ConnectionRef): Promise<AuthStatus>
  /** Discover available models (runtime query first; registry/fallback otherwise). */
  listModels(conn: ConnectionRef): Promise<ModelInfo[]>
  /** Start a streamed run; returns a handle to cancel / answer permission requests. */
  run(req: RunRequest, emit: (event: RunEvent) => void): RunHandle
}
