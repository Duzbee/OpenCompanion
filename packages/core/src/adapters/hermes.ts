import realSpawn from 'cross-spawn'
import type { AdapterCapabilities, AuthStatus, DetectResult, ModelInfo } from '@opencompanion/core-types'
import { probeAcpAuth, type AcpAuthProbeResult } from '../acp-driver'
import type { RunContext, RunContextResolvers } from '../context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../runtime-types'
import { detectBinary, runAgenticDriver } from './agentic-run'
import { prependSystemPrompt } from './mapping'
import type { AgenticCliDriver, CommonAdapterDeps } from './types'

/** Dependencies for the Hermes adapter (all injectable for unit tests). */
export interface HermesAdapterDeps extends CommonAdapterDeps {
  /** ACP glue that drives `hermes acp` for one run. */
  driver: AgenticCliDriver
  /**
   * Probes the resolved binary's ACP auth (injectable so tests fake the child). Defaults to
   * `probeAcpAuth(realSpawn, binaryPath, ['acp'])`. THROWS on a spawn failure or timeout (both
   * NON-EVIDENCE of a sign-out), so the auth-health caller keeps the connection's last-known health.
   */
  probeAuth?: (binaryPath: string) => Promise<AcpAuthProbeResult>
}

/** The `hermes` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = 'hermes'
const NOT_INSTALLED = 'Hermes Agent is not installed'

const CAPABILITIES: AdapterCapabilities = {
  kind: 'agentic',
  // Hermes owns its own provider auth (its own login/config), so we drive that single
  // subscription rather than offering a BYOK key.
  supportedAuthModes: ['subscription'],
  // The ACP run is non-interactive: permission requests are auto-answered from the posture.
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  // The ACP `session/prompt` path exposes no OS-enforced egress switch, so a `network: 'off'`
  // run cannot be genuinely blocked - the run-loop discloses that gap rather than guaranteeing it.
  enforcesNetworkOff: false,
  // Hermes consumes an http MCP server via ACP `session/new` (`mcpServers`), so the app's
  // in-process tools are served to it - the parity payoff (native coding stays on; ours are added).
  httpMcp: true
}

/**
 * The single informational model entry Hermes reports: the agent resolves its own model from its
 * own config, so there is nothing to pick here (unlike Codex/OpenCode which enumerate models). This
 * is a {@link ModelInfo} for the runtime's picker; the backend route defines its own `CatalogModel`
 * copy - the two shapes are deliberately not shared.
 */
const CONFIGURED_MODEL_ENTRY: ModelInfo = {
  id: 'default',
  label: "Agent's configured model",
  source: 'fallback',
  recommended: true
}

/**
 * Builds the Hermes Agent adapter as a {@link RuntimeToolAdapter}. Drives the user's installed
 * `hermes` via its ACP (`hermes acp`) session over the injected {@link AgenticCliDriver}; auth is
 * subscription-only (Hermes owns its provider login, so there is no BYOK key). The auth probe does
 * only the ACP `initialize` handshake and THROWS on non-evidence (binary miss, spawn failure,
 * timeout) so a transient failure never flips a connection to needs-reauth. `req.conversationId`
 * threads to the driver as `resume` (ACP `session/load`), and `req.mcpServers` are forwarded so the
 * app's tools reach the agent (`httpMcp`). `req.effort` and `req.network` are accepted for shape
 * parity but ignored: the ACP protocol has no reasoning-effort channel and no egress switch on this
 * path (the run-loop discloses the network-off gap since `enforcesNetworkOff` is false).
 *
 * @param deps - The injected driver, auth probe, binary resolver, key loader, and registry lookup.
 * @returns The Hermes runtime adapter.
 */
export function createHermesAdapter(deps: HermesAdapterDeps): RuntimeToolAdapter {
  const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY)
  const probeAuth =
    deps.probeAuth ?? ((binaryPath: string) => probeAcpAuth(realSpawn, binaryPath, ['acp']))

  return {
    id: 'hermes',
    displayName: 'Hermes Agent',
    capabilities: CAPABILITIES,
    detect,
    async authStatus(): Promise<AuthStatus> {
      const path = deps.resolveBinary(BINARY)
      // A binary miss is NON-EVIDENCE of a sign-out (matching `subscriptionStatusCheck`): THROW so
      // the auth-health caller keeps last-known health rather than falsely prompting for re-auth.
      if (!path) throw new Error(NOT_INSTALLED)
      const result = await probeAuth(path)
      return {
        authenticated: result.authenticated,
        mode: 'subscription',
        ...(result.detail ? { detail: result.detail } : {})
      }
    },
    listModels(): Promise<ModelInfo[]> {
      return Promise.resolve([CONFIGURED_MODEL_ENTRY])
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
            ...(req.network ? { network: req.network } : {}),
            ...(req.conversationId ? { resume: req.conversationId } : {}),
            signal
          })
      })
    }
  }
}
