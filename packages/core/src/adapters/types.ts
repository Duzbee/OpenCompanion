import type { ModelInfo } from '@opencompanion/core-types'
import type {
  McpServerSpec,
  PermissionMode,
  ReasoningEffort,
  TokenUsage
} from '@opencompanion/protocol'

/** Result of running a tool binary for detection / status probes. */
export interface ExecResult {
  code: number
  stdout: string
}

/** Runs a tool binary with an argument array (never a shell). Injected for testing. */
export type RunTool = (bin: string, args: string[]) => Promise<ExecResult>

/** Dependencies shared by every adapter (all injectable for unit tests). */
export interface CommonAdapterDeps {
  /** Resolves a tool binary from validated known locations, or `null`. */
  resolveBinary: (name: string) => string | null
  /** Loads a connection's stored BYOK key (presence => apiKey mode). */
  loadApiKey: (connectionId: string) => string | null
  /** Returns registry model metadata for a provider (already gated by config). */
  listRegistryModels: (provider: string) => Promise<ModelInfo[]>
  /** Runs a binary for `--version` / status probes. */
  runTool: RunTool
}

/**
 * A normalized message yielded by any agentic driver, decoupled from each SDK. The
 * adapter run-loop maps it to a {@link RuntimeRunEvent} in one place. The
 * `conversation` variant (spike D) carries the SDK session/thread id for resume.
 */
export type AgenticDriverMessage =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; status: 'started' | 'completed' | 'failed'; detail?: string }
  | { kind: 'conversation'; id: string }
  | { kind: 'done'; usage?: TokenUsage }
  | { kind: 'error'; message: string }

/** Alias retained for the Codex mapping glue (`mapping.ts`); the shape is shared. */
export type CodexDriverMessage = AgenticDriverMessage

/** Inputs the Claude driver needs for one run. */
export interface ClaudeDriverParams {
  prompt: string
  cwd: string
  model?: string
  /** BYOK key; absent means subscription mode (the tool resolves its own login). */
  apiKey?: string
  /** Resolved absolute path to the user's `claude` binary. */
  binaryPath: string
  permissionMode: PermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
  systemPrompt?: string
  /** Reasoning effort; absent/`"default"` leaves the model's native behaviour. */
  effort?: ReasoningEffort
  /** Builder-configured MCP servers, passed natively to the Agent SDK. */
  mcpServers?: Record<string, McpServerSpec>
  /**
   * SDK session id to resume (spike D). When set, the Claude driver passes
   * `options.resume` so turn N continues turn N-1 without replaying the transcript.
   */
  resume?: string
  signal: AbortSignal
  /** Forward a permission request to the UI; resolves with the user's decision. */
  requestPermission: (toolName: string, input: unknown) => Promise<'allow' | 'deny'>
}

/** Drives Claude Code for one run, yielding normalized messages. SDK glue. */
export type ClaudeDriver = (params: ClaudeDriverParams) => AsyncIterable<AgenticDriverMessage>

/**
 * Inputs every headless agentic-CLI driver needs for one run (Codex, OpenCode). One
 * shape - binary path, prompt, cwd, model, permission mode, optional reasoning effort,
 * optional MCP servers, optional resume id, and an abort signal.
 */
export interface AgenticCliDriverParams {
  prompt: string
  cwd: string
  model?: string
  apiKey?: string
  binaryPath: string
  permissionMode: PermissionMode
  /** Reasoning effort; absent/`"default"` leaves the model's native behaviour. */
  effort?: ReasoningEffort
  /** Builder/integration MCP servers, threaded to the CLI via its native MCP config. */
  mcpServers?: Record<string, McpServerSpec>
  /**
   * Whether the run may reach the network. Only the Codex driver enforces `"off"`: it maps to
   * the OS-enforced sandbox flag `networkAccessEnabled: false`, so an unattended Codex run's
   * egress is actually blocked, not merely recorded for audit. The OpenCode CLI exposes no
   * network flag on the `opencode run` path, so it ignores this field (its egress is NOT
   * enforced - the adapter run-loop discloses that). Absent leaves the CLI's network-on default.
   */
  network?: 'on' | 'off'
  /**
   * Codex thread id to resume (spike D). When set, the Codex driver calls
   * `codex.resumeThread(id)` instead of `startThread(...)`, continuing the thread.
   * Ignored by OpenCode (its CLI has no resume primitive on this path).
   */
  resume?: string
  signal: AbortSignal
}

/**
 * Drives one headless agentic CLI (Codex or OpenCode) for a run, yielding normalized
 * messages. SDK/CLI glue; the two share this one signature.
 */
export type AgenticCliDriver = (
  params: AgenticCliDriverParams
) => AsyncIterable<AgenticDriverMessage>

/** Re-export so callers can build `McpServerSpec` maps without a second import. */
export type { McpServerSpec }
