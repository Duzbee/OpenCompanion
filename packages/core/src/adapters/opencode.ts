import type { AdapterCapabilities, DetectResult, ModelInfo } from '@opencompanion/core-types'
import type { RunContext, RunContextResolvers } from '../context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../runtime-types'
import {
  apiKeyAuthStatus,
  detectBinary,
  runAgenticDriver,
  subscriptionStatusCheck
} from './agentic-run'
import { prependSystemPrompt } from './mapping'
import type { AgenticCliDriver, CommonAdapterDeps } from './types'

/** Dependencies for the OpenCode adapter (all injectable for unit tests). */
export interface OpenCodeAdapterDeps extends CommonAdapterDeps {
  /** CLI glue that drives `opencode run` for one run. */
  driver: AgenticCliDriver
}

/** The `opencode` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = 'opencode'
const NOT_INSTALLED = 'OpenCode is not installed'

const CAPABILITIES: AdapterCapabilities = {
  kind: 'agentic',
  // OpenCode manages its own provider credentials (`opencode auth`), so we drive
  // the user's configured providers rather than offering a single BYOK key.
  supportedAuthModes: ['subscription'],
  // `opencode run` is non-interactive; permissions are a static posture (no hook).
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  // `httpMcp` is deliberately NOT declared: `opencode run` exposes no per-invocation MCP flag
  // (unlike Claude Code's `--mcp-config` or Codex's `--config mcp_servers.*`), so the app's
  // in-process tools cannot be served to it - `shouldServeLocalTools` therefore excludes it and the
  // run surface degrades those tools visibly, and the run loop does not thread `mcpServers` into the
  // `opencode run` argv. OpenCode runs with its own native coding tools only.
  // `opencode run` exposes no network flag on this path, so it cannot OS-enforce network-off.
  enforcesNetworkOff: false
}

/**
 * Small fallback model list used when `opencode models` cannot be queried (e.g.
 * OpenCode is not installed). Distinct from the shared
 * `FALLBACK_MODELS`: OpenCode addresses models as `provider/model`, so its ids
 * carry a provider prefix the other adapters' ids do not - the shadow is
 * intentional. The picker still shows representative entries; the real list is
 * discovered from the tool at runtime when it is installed.
 */
const OPENCODE_FALLBACK_MODELS: ModelInfo[] = [
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', source: 'fallback' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', source: 'fallback' }
]

/**
 * Parses `opencode models` stdout (one `provider/model` per line) into ModelInfo.
 *
 * @param stdout - The raw `opencode models` output.
 * @returns The parsed model list.
 */
function parseModelLines(stdout: string): ModelInfo[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('/') && !line.startsWith('#'))
    .map((id) => ({ id, source: 'tool' as const }))
}

/**
 * Builds the OpenCode adapter as a {@link RuntimeToolAdapter}. Drives the user's installed
 * `opencode` via its non-interactive `opencode run` CLI; subscription mode uses the user's
 * own `opencode auth` (their configured providers), and BYOK passes a stored key. Binary +
 * key resolve THROUGH the per-run resolvers (no module global); `req.conversationId` is
 * ignored because OpenCode's CLI has no resume primitive on this path.
 *
 * @param deps - The injected driver, binary resolver, key loader, and registry lookup.
 * @returns The OpenCode runtime adapter.
 */
export function createOpenCodeAdapter(deps: OpenCodeAdapterDeps): RuntimeToolAdapter {
  const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY)

  return {
    id: 'opencode',
    displayName: 'OpenCode',
    capabilities: CAPABILITIES,
    detect,
    async authStatus(conn) {
      if (conn.authMode === 'apiKey') return apiKeyAuthStatus(deps, conn)
      return subscriptionStatusCheck(deps, {
        binary: BINARY,
        notInstalledDetail: NOT_INSTALLED,
        statusArgs: ['auth', 'list'],
        okDetail: 'Uses your OpenCode providers',
        failDetail: 'No providers (run: opencode auth login)',
        errorDetail: 'Could not determine auth status'
      })
    },
    async listModels(): Promise<ModelInfo[]> {
      const path = deps.resolveBinary(BINARY)
      if (!path) return OPENCODE_FALLBACK_MODELS
      try {
        const { code, stdout } = await deps.runTool(path, ['models'])
        const models = code === 0 ? parseModelLines(stdout) : []
        return models.length > 0 ? models : OPENCODE_FALLBACK_MODELS
      } catch {
        return OPENCODE_FALLBACK_MODELS
      }
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
            signal
          })
      })
    }
  }
}
