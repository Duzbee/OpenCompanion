import type { AdapterCapabilities, DetectResult, ModelInfo } from '@opencompanion/core-types'
import type { RunContext, RunContextResolvers } from '../context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../runtime-types'
import {
  apiKeyAuthStatus,
  detectBinary,
  registryModelsOrFallback,
  runAgenticDriver
} from './agentic-run'
import type { ClaudeDriver, CommonAdapterDeps } from './types'

/** Dependencies for the Claude Code adapter (all injectable for unit tests). */
export interface ClaudeAdapterDeps extends CommonAdapterDeps {
  /** SDK glue that drives Claude Code for one run. */
  driver: ClaudeDriver
}

/** The `claude` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = 'claude'
const NOT_INSTALLED = 'Claude Code is not installed'

const CAPABILITIES: AdapterCapabilities = {
  kind: 'agentic',
  supportedAuthModes: ['apiKey', 'subscription'],
  interactiveApproval: true,
  subscriptionRequiresDisclosure: true,
  // The Agent SDK has no single egress boolean (network restriction is permission-rule +
  // sandbox based, platform-dependent, and can hard-fail), so it cannot OS-enforce network-off.
  enforcesNetworkOff: false,
  // The Agent SDK threads http/sse MCP servers natively, so the app-MCP reaches it.
  httpMcp: true
}

/**
 * Builds the Claude Code adapter as a {@link RuntimeToolAdapter}. Drives the user's
 * installed `claude` via the injected {@link ClaudeDriver}; subscription mode relies on
 * the user's own `claude login` (the tool resolves its own auth) and BYOK passes a stored
 * `ANTHROPIC_API_KEY`. Interactive permission requests are forwarded to the UI and
 * answered via the run handle. Binary + key resolve THROUGH the per-run resolvers (no
 * module global), and `req.conversationId` is threaded to the driver as `resume`.
 *
 * @param deps - The injected driver, binary resolver, key loader, and registry lookup.
 * @returns The Claude Code runtime adapter.
 */
export function createClaudeCodeAdapter(deps: ClaudeAdapterDeps): RuntimeToolAdapter {
  const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY)

  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: CAPABILITIES,
    detect,
    async authStatus(conn) {
      if (conn.authMode === 'apiKey') return apiKeyAuthStatus(deps, conn)
      // Subscription mode: the CLI resolves its OWN login, so the binary's PRESENCE on disk is the
      // auth evidence - resolved the SAME way a run resolves it (`resolveBinary`, whose paths are
      // existence-checked by `resolveToolBinary`), never a `--version` spawn. `detect()` spawns
      // `--version`, which under the daemon's minimal-PATH service env or a loaded host can fail even
      // though the resolved binary runs fine; mapping that DETECTION miss onto `authenticated: false`
      // is exactly the false "needs re-auth" prompt we must avoid (the run still works from the
      // resolved path). So: a resolved binary => authenticated. NO binary at all means the CLI is
      // genuinely NOT INSTALLED, which is likewise not a sign-out - THROW so the auth-health monitor
      // keeps the last known health (its `catch` never false-flags a re-auth on a thrown probe)
      // rather than flipping a healthy connection to needs-reauth.
      if (deps.resolveBinary(BINARY)) {
        return { authenticated: true, mode: 'subscription', detail: 'Uses your local Claude Code login' }
      }
      throw new Error(NOT_INSTALLED)
    },
    listModels(): Promise<ModelInfo[]> {
      return registryModelsOrFallback(deps, 'anthropic')
    },
    run(
      req: RuntimeRunRequest,
      ctx: RunContext,
      resolvers: RunContextResolvers,
      emit: (event: RuntimeRunEvent) => void
    ) {
      return runAgenticDriver(req, ctx, resolvers, emit, {
        binary: BINARY,
        notInstalledMessage: NOT_INSTALLED,
        capabilities: CAPABILITIES,
        start: ({ binaryPath, apiKey, signal, requestPermission }) =>
          deps.driver({
            prompt: req.prompt,
            cwd: req.cwd,
            model: req.modelId,
            apiKey,
            binaryPath,
            permissionMode: req.permissionMode,
            allowedTools: req.allowedTools,
            disallowedTools: req.disallowedTools,
            systemPrompt: req.systemPrompt,
            effort: req.effort,
            mcpServers: req.mcpServers,
            ...(req.conversationId ? { resume: req.conversationId } : {}),
            signal,
            requestPermission
          })
      })
    }
  }
}
