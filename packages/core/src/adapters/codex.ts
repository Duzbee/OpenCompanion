import type { AdapterCapabilities, DetectResult, ModelInfo } from '@opencompanion/core-types'
import type { RunContext, RunContextResolvers } from '../context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../runtime-types'
import {
  apiKeyAuthStatus,
  detectBinary,
  registryModelsOrFallback,
  runAgenticDriver,
  subscriptionStatusCheck
} from './agentic-run'
import { prependSystemPrompt } from './mapping'
import type { AgenticCliDriver, CommonAdapterDeps } from './types'

/** Dependencies for the Codex adapter (all injectable for unit tests). */
export interface CodexAdapterDeps extends CommonAdapterDeps {
  /** SDK glue that drives Codex for one run. */
  driver: AgenticCliDriver
}

/** The `codex` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = 'codex'
const NOT_INSTALLED = 'Codex is not installed'

const CAPABILITIES: AdapterCapabilities = {
  kind: 'agentic',
  supportedAuthModes: ['subscription', 'apiKey'],
  // Codex's SDK has no per-action approval hook; it runs a static safe posture.
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  // Codex is the ONE adapter that can OS-enforce network-off: its SDK sets
  // `networkAccessEnabled: false`, so a `network: 'off'` run is genuinely blocked.
  enforcesNetworkOff: true,
  // Codex consumes an http MCP server via its `mcp_servers.*` config, so the
  // app-MCP reaches it (native coding stays on; our integration tools are added).
  httpMcp: true
}

/**
 * Builds the Codex adapter as a {@link RuntimeToolAdapter}. Drives the user's installed
 * `codex` via the injected {@link AgenticCliDriver}; subscription mode uses the user's
 * `codex login` (ChatGPT) and BYOK passes a stored API key. Codex has no interactive
 * approval hook, so it runs the static posture derived from the run's permission mode.
 * Binary + key resolve THROUGH the per-run resolvers (no module global), `req.conversationId`
 * is threaded to the driver as `resume`, and `req.network` is threaded as the OS-enforced
 * sandbox egress flag so an unattended `network: 'off'` actually blocks the network.
 *
 * @param deps - The injected driver, binary resolver, key loader, and registry lookup.
 * @returns The Codex runtime adapter.
 */
export function createCodexAdapter(deps: CodexAdapterDeps): RuntimeToolAdapter {
  const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY)

  return {
    id: 'codex',
    displayName: 'Codex',
    capabilities: CAPABILITIES,
    detect,
    async authStatus(conn) {
      if (conn.authMode === 'apiKey') return apiKeyAuthStatus(deps, conn)
      return subscriptionStatusCheck(deps, {
        binary: BINARY,
        notInstalledDetail: NOT_INSTALLED,
        statusArgs: ['login', 'status'],
        okDetail: 'Signed in with ChatGPT',
        failDetail: 'Not signed in (run: codex login)',
        errorDetail: 'Could not determine login status'
      })
    },
    listModels(): Promise<ModelInfo[]> {
      return registryModelsOrFallback(deps, 'openai')
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
        start: ({ binaryPath, apiKey, signal }) =>
          deps.driver({
            prompt: prependSystemPrompt(req.systemPrompt, req.prompt),
            cwd: req.cwd,
            model: req.modelId,
            apiKey,
            binaryPath,
            permissionMode: req.permissionMode,
            effort: req.effort,
            mcpServers: req.mcpServers,
            // Thread the run's network posture into the driver's OS-enforced sandbox flag (I2);
            // an unattended `network: 'off'` actually blocks egress, not just records the intent.
            ...(req.network ? { network: req.network } : {}),
            ...(req.conversationId ? { resume: req.conversationId } : {}),
            signal
          })
      })
    }
  }
}
