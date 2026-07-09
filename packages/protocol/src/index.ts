/**
 * The fully-serializable wire protocol shared by the companion daemon and the product
 * backend. Pure types + `zod` schemas, zero runtime side effects, so both ends
 * agree on one wire contract. NO live `ToolSet` crosses this boundary.
 */
export type {
  WebToolManifestEntry,
  RunStart,
  RunCancel,
  ToolResult,
  RunEventMsg,
  RunConversationMsg,
  ToolCall,
  AuthHealth,
  CliConnectionInfo,
  ConnectInstruction,
  ConnectResultStatus,
  ConnectResultBody,
  ConnectResponse,
  ConnectableToolId
} from './messages'
export {
  CONNECTABLE_TOOL_IDS,
  COMPANION_PROTOCOL_VERSION,
  isConnectableToolId,
  WebToolManifestEntrySchema,
  McpServerSpecSchema,
  ReasoningEffortSchema,
  RunStartSchema,
  RunCancelSchema,
  ToolResultSchema,
  ToolCallSchema,
  RunConversationMsgSchema,
  AuthHealthSchema,
  CliConnectionInfoSchema,
  ConnectInstructionSchema,
  ConnectResultStatusSchema,
  ConnectResultBodySchema,
  ConnectResponseSchema
} from './messages'
export type { McpServerSpec, PermissionMode, ReasoningEffort, RunEvent, TokenUsage } from './vocab'
export { REASONING_EFFORTS, isReasoningEffort } from './vocab'

export type { RunPolicy } from './policy'
export { RunPolicySchema, PermissionModeSchema, clampPolicy, comparePermissionModes } from './policy'
