/**
 * Public surface of `@opencompanion/core`: the CLI-driving lower seam extracted from
 * `@repo/agent-runtime`. It owns the process/SDK primitives that drive the user's own
 * installed, vendor-authenticated AI coding CLIs (Claude Code / Codex / OpenCode /
 * Hermes Agent) - the adapter {@link buildAgentRuntimeRegistry registry}, the
 * {@link createSessionManager session manager} that owns the multi-turn run lifecycle
 * the companion daemon drives, per-run {@link RunContext} isolation, the local-MCP /
 * env / binary / PATH helpers, and the digest-verified managed-CLI installer
 * ({@link installCli} / {@link cliLoginCommand}). It carries no `@repo/config`,
 * `@repo/ai`, `@repo/knowledge`, or `@repo/agent-runtime` dependency, so the companion's
 * whole dependency closure is publishable; `@repo/agent-runtime` and `@repo/ai/backends`
 * re-export this surface so their own consumers change no imports.
 */

// Backend contract seam types + wire vocabulary, re-exported from the pure leaf package
// (`@opencompanion/core-types`) so this barrel's consumers change no imports.
export * from '@opencompanion/core-types'

export type { AgentRuntimeRegistry } from './registry'
export { buildAgentRuntimeRegistry, detectInstalled } from './registry'
export type { AgentRuntimeRegistryDeps } from './registry'

export { makeRunContext } from './context'
export type { RunContext, RunContextResolvers } from './context'

export type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from './runtime-types'

export { createSessionManager } from './sessions'
export type { SessionDeps, SessionManager, StartRunOptions } from './sessions'

export { serveToolsOverHttp, shouldServeLocalTools } from './local-mcp'
export type { LocalMcpHandle, McpServerFactory, McpServerLike } from './local-mcp'

export { mcpServersToTools, mcpServersToToolsWith } from './mcp-tools'
export type { McpClientLike } from './mcp-tools'

export { buildCliEnv, ENV_ALLOWLIST_EXACT, ENV_ALLOWLIST_PREFIXES } from './env-scrub'

export { runTool } from './exec'
export type { RunToolOptions } from './exec'

export { binaryCandidateDirs, isWindowsShimPath, resolveToolBinary } from './binaries'

export {
  captureLoginShellPath,
  enhancedPath,
  INSPECTOR_ENV_VARS,
  mergePaths,
  nodeDirOnPath,
  sanitizeNodeOptions,
  stripInspectorEnv
} from './shell-path'

export { CLAUDE_CODE_VERSION_FALLBACK, getClaudeCodeVersion } from './claude-version'

export { cachedDetect, clearDetectCache } from './detect-cache'

export {
  CLI_INSTALL_SPECS,
  cliLoginCommand,
  installCli,
  isInstallableCli,
  managedBinaryPath,
  managedCliBinDirs,
  requireInstallSpec,
  SYSTEM_CLI_SPECS,
  systemInstallGuidance
} from './cli-install'
export type {
  CliInstallSpec,
  CliLoginCommand,
  ExtractArchive,
  FetchFn,
  InstallDeps,
  SystemCliSpec
} from './cli-install'

// Small declarative model fallback, owned by the pure leaf package so the agentic adapters
// need no `@repo/ai`; `@repo/ai/discovery` re-exports it so its own resolver keeps one source.
export { FALLBACK_MODELS } from '@opencompanion/core-types'

// Agentic-adapter primitives the engine-half host (and its tests) compose over: the shared
// run-loop, the normalized driver-message mapper, the driver bundle type, and the Codex/Claude
// native-config maps the terminal-args builder reuses.
export { emitDriverMessage, runAgenticDriver } from './adapters/agentic-run'
export type { AgenticDriverMessage, RunTool } from './adapters/types'
export type { AgentDrivers } from './drivers'
export { mapCodexMcpServers, mapMcpServers, serializeCodexConfigOverrides } from './adapters/mapping'

// Vercel AI SDK tool primitives re-exported from npm `ai` so the companion builds a `ToolSet`
// (its loopback MCP tool surface) with `@opencompanion/core` as its only workspace dependency here.
export { jsonSchema, tool } from 'ai'
export type { ToolSet } from 'ai'
