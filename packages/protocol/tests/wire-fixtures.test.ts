import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AuthHealthSchema,
  CliConnectionInfoSchema,
  ConnectInstructionSchema,
  ConnectResponseSchema,
  ConnectResultBodySchema,
  ConnectResultStatusSchema,
  CONNECTABLE_TOOL_IDS,
  McpServerSpecSchema,
  PermissionModeSchema,
  ReasoningEffortSchema,
  RunCancelSchema,
  RunConversationMsgSchema,
  RunPolicySchema,
  RunStartSchema,
  ToolCallSchema,
  ToolResultSchema,
  WebToolManifestEntrySchema
} from '../src/index'

/**
 * Baseline wire-shape freeze for the v1.42.0 companion protocol. Every exported schema is pinned
 * against a hand-written JSON fixture in `tests/fixtures/`: the fixture must both parse AND survive
 * `schema.parse(fixture)` deep-equal to the input, which proves the schema neither strips a field
 * nor coerces a value. Later tasks restructure these packages; keeping this suite green is the
 * compatibility gate that a restructure did not silently change the wire.
 *
 * Object fixtures are MAXIMAL - every optional field is populated so a dropped optional is caught.
 * A maximal object therefore encodes a field set that is deliberately fuller than any single real
 * message (for example `tool.result` carries both `result` and `error`, and a connect result body
 * carries every optional at once); realism of a field combination is not the point, freezing the
 * shape is. Union schemas (the bare enums, and `McpServerSpec` discriminated by `type`) get one
 * fixture per branch instead.
 */

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))

/**
 * Reads and JSON-parses a wire fixture from `tests/fixtures/`.
 *
 * @param file - The fixture filename (for example `run-start.json`).
 * @returns The parsed JSON value, before any schema validation.
 */
function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'))
}

const cases: ReadonlyArray<{ schema: z.ZodType; name: string; file: string }> = [
  { schema: RunStartSchema, name: 'RunStartSchema', file: 'run-start.json' },
  { schema: RunCancelSchema, name: 'RunCancelSchema', file: 'run-cancel.json' },
  { schema: ToolResultSchema, name: 'ToolResultSchema', file: 'tool-result.json' },
  { schema: ToolCallSchema, name: 'ToolCallSchema', file: 'tool-call.json' },
  { schema: RunConversationMsgSchema, name: 'RunConversationMsgSchema', file: 'run-conversation.json' },
  { schema: CliConnectionInfoSchema, name: 'CliConnectionInfoSchema', file: 'cli-connection-info.json' },
  { schema: ConnectInstructionSchema, name: 'ConnectInstructionSchema', file: 'connect-instruction.json' },
  { schema: ConnectResultBodySchema, name: 'ConnectResultBodySchema', file: 'connect-result-body.json' },
  // The `/connect` handshake response, ENRICHED with the additive `protocolVersion`: freezing it here
  // proves the versioned response both parses and round-trips (no field dropped), while the frozen
  // baseline fixtures above stay untouched.
  { schema: ConnectResponseSchema, name: 'ConnectResponseSchema', file: 'connect-response.json' },
  // The BARE pre-versioning response (only the required `wireToken`, no `protocolVersion` or other
  // optionals): freezing it locks the backward-compat guarantee - a body from a backend that predates
  // the additive field still parses and round-trips with nothing injected.
  { schema: ConnectResponseSchema, name: 'ConnectResponseSchema', file: 'connect-response.bare.json' },
  { schema: WebToolManifestEntrySchema, name: 'WebToolManifestEntrySchema', file: 'web-tool-manifest-entry.json' },
  { schema: RunPolicySchema, name: 'RunPolicySchema', file: 'run-policy.json' },
  { schema: McpServerSpecSchema, name: 'McpServerSpecSchema', file: 'mcp-server-spec.stdio.json' },
  { schema: McpServerSpecSchema, name: 'McpServerSpecSchema', file: 'mcp-server-spec.sse.json' },
  { schema: McpServerSpecSchema, name: 'McpServerSpecSchema', file: 'mcp-server-spec.http.json' },
  { schema: AuthHealthSchema, name: 'AuthHealthSchema', file: 'auth-health.healthy.json' },
  { schema: AuthHealthSchema, name: 'AuthHealthSchema', file: 'auth-health.needs-reauth.json' },
  { schema: AuthHealthSchema, name: 'AuthHealthSchema', file: 'auth-health.unknown.json' },
  { schema: ConnectResultStatusSchema, name: 'ConnectResultStatusSchema', file: 'connect-result-status.connected.json' },
  { schema: ConnectResultStatusSchema, name: 'ConnectResultStatusSchema', file: 'connect-result-status.needs-login.json' },
  {
    schema: ConnectResultStatusSchema,
    name: 'ConnectResultStatusSchema',
    file: 'connect-result-status.installed-needs-login.json'
  },
  {
    schema: ConnectResultStatusSchema,
    name: 'ConnectResultStatusSchema',
    file: 'connect-result-status.not-installed.json'
  },
  { schema: ConnectResultStatusSchema, name: 'ConnectResultStatusSchema', file: 'connect-result-status.failed.json' },
  { schema: ReasoningEffortSchema, name: 'ReasoningEffortSchema', file: 'reasoning-effort.default.json' },
  { schema: ReasoningEffortSchema, name: 'ReasoningEffortSchema', file: 'reasoning-effort.off.json' },
  { schema: ReasoningEffortSchema, name: 'ReasoningEffortSchema', file: 'reasoning-effort.low.json' },
  { schema: ReasoningEffortSchema, name: 'ReasoningEffortSchema', file: 'reasoning-effort.medium.json' },
  { schema: ReasoningEffortSchema, name: 'ReasoningEffortSchema', file: 'reasoning-effort.high.json' },
  { schema: PermissionModeSchema, name: 'PermissionModeSchema', file: 'permission-mode.read-only.json' },
  { schema: PermissionModeSchema, name: 'PermissionModeSchema', file: 'permission-mode.auto-edit.json' },
  { schema: PermissionModeSchema, name: 'PermissionModeSchema', file: 'permission-mode.full.json' }
]

describe.each(cases)('wire fixture $name ($file)', ({ schema, file }) => {
  it('parses and round-trips deep-equal to the fixture', () => {
    const fixture = loadFixture(file)
    const parsed: unknown = schema.parse(fixture)
    expect(parsed).toEqual(fixture)
  })
})

describe('connectable tool id set', () => {
  it('freezes CONNECTABLE_TOOL_IDS to its v1.42.0 value', () => {
    expect(CONNECTABLE_TOOL_IDS).toEqual(['claude-code', 'codex', 'opencode', 'hermes'])
  })
})
