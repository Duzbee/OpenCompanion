/**
 * ACP wire frames copied VERBATIM from a live `hermes acp` session (Hermes v0.18.0,
 * captured 2026-07-07). These are the ground truth the driver unit tests replay; do
 * not hand-edit the shapes - they mirror exactly what the installed CLI emits.
 */

/** The `initialize` response (agentCapabilities + authMethods, trimmed to the fields the driver reads). */
export const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentInfo: { name: 'hermes-agent', version: '0.18.0' },
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true },
    sessionCapabilities: { fork: {}, list: {}, resume: {} }
  },
  authMethods: [
    { id: 'openrouter', name: 'openrouter runtime credentials', description: 'Authenticate Hermes using the currently configured openrouter runtime credentials.' },
    { id: 'hermes-setup', name: 'Configure Hermes provider', type: 'terminal', args: ['--setup'] }
  ]
} as const

/** An `initialize` result with NO non-terminal provider (unauthenticated). */
export const INITIALIZE_RESULT_UNAUTH = {
  protocolVersion: 1,
  agentInfo: { name: 'hermes-agent', version: '0.18.0' },
  agentCapabilities: { loadSession: true },
  authMethods: [
    { id: 'hermes-setup', name: 'Configure Hermes provider', type: 'terminal', args: ['--setup'] }
  ]
} as const

/** The `session/new` response. */
export const NEW_SESSION_RESULT = {
  sessionId: 'd984d67d-f883-422f-aee1-81fcf01d3dd1',
  models: { availableModels: [{ modelId: 'openrouter:deepseek/deepseek-v4-flash', name: 'deepseek/deepseek-v4-flash', description: 'current' }], currentModelId: 'openrouter:deepseek/deepseek-v4-flash' },
  modes: {
    availableModes: [
      { id: 'default', name: 'Default', description: 'Ask before edits.' },
      { id: 'accept_edits', name: 'Accept Edits', description: 'Auto-allow workspace edits.' },
      { id: 'dont_ask', name: "Don't Ask", description: 'Auto-allow file edits.' }
    ],
    currentModeId: 'default'
  }
} as const

const SESSION_ID = NEW_SESSION_RESULT.sessionId

/** A streamed reasoning chunk. */
export const THOUGHT_CHUNK = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: SESSION_ID, update: { content: { text: 'The', type: 'text' }, sessionUpdate: 'agent_thought_chunk' } }
} as const

/** A streamed assistant text chunk. */
export const MESSAGE_CHUNK = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: SESSION_ID, update: { content: { text: 'Zephyr', type: 'text' }, sessionUpdate: 'agent_message_chunk' } }
} as const

/** A tool call start (title carries the mcp-namespaced tool name). */
export const TOOL_CALL = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: SESSION_ID, update: { kind: 'other', locations: [], title: 'mcp__generatesaas_app_tools__codename_lookup', toolCallId: 'tc-279aac6f79c6', sessionUpdate: 'tool_call' } }
} as const

/** A tool call completion (status field distinguishes completed/failed). */
export const TOOL_CALL_UPDATE = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: SESSION_ID, update: { toolCallId: 'tc-279aac6f79c6', status: 'completed', kind: 'other', content: [{ content: { text: '{"result":"Zephyr-Nine-Delta-ACP"}', type: 'text' } }], sessionUpdate: 'tool_call_update' } }
} as const

/** An agent->client permission request (schema-verified; auto-answer with a selected option). */
export const PERMISSION_REQUEST = {
  jsonrpc: '2.0',
  id: 99,
  method: 'session/request_permission',
  params: {
    sessionId: SESSION_ID,
    options: [
      { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }
    ]
  }
} as const

/**
 * A permission request offering ONLY allow options (derived from {@link PERMISSION_REQUEST}; the
 * protocol does not require a reject option). A read-only run must answer it with the `cancelled`
 * outcome - never auto-allow a mutation.
 */
export const PERMISSION_REQUEST_ALLOW_ONLY = {
  jsonrpc: '2.0',
  id: 99,
  method: 'session/request_permission',
  params: {
    sessionId: SESSION_ID,
    options: [
      { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'allow-always', kind: 'allow_always', name: 'Allow always' }
    ]
  }
} as const

/**
 * An INTERMEDIATE tool progress update (derived from {@link TOOL_CALL_UPDATE} with status
 * `in_progress`). The mapper must IGNORE it: the tool is still running, and the initial
 * `tool_call` already reported it as started.
 */
export const TOOL_CALL_UPDATE_IN_PROGRESS = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: SESSION_ID, update: { toolCallId: 'tc-279aac6f79c6', status: 'in_progress', kind: 'other', content: [], sessionUpdate: 'tool_call_update' } }
} as const

/** A `usage_update` (must be IGNORED by the mapper). */
export const USAGE_UPDATE = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: SESSION_ID, update: { size: 1048576, used: 18066, sessionUpdate: 'usage_update' } }
} as const

export { SESSION_ID }
