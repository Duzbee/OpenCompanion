# Integrate OpenCompanion with your own backend

OpenCompanion is not tied to any vendor. A daemon pairs with **any backend that speaks this wire**: RFC 8628 device-authorization pairing plus six HTTP endpoints under your API base. The daemon always pulls; you never connect to the user's machine.

The machine-readable contract is [`packages/protocol`](../packages/protocol) - zod schemas for every message - and the frozen fixture suite in `packages/protocol/tests`, which doubles as a conformance test for your implementation.

## The shape of the integration

```
daemon                                your backend ({API_URL})
  |-- POST /auth/device/code  ------->  RFC 8628 device authorization
  |-- POST /auth/device/token ------->  (user approves in a signed-in browser)
  |-- POST /companion/connect ------->  device bearer -> short-lived wire token
  |-- GET  /companion/poll    ------->  { runs, cancel, connects, wireToken }
  |-- POST /companion/runs/:runId/ack
  |-- POST /companion/events  ------->  streamed result frames (idempotent batches)
  |-- POST /companion/tool-call ----->  your app resolves the agent's tool calls
  |-- POST /companion/connects/:requestId/result
```

## 1. Pairing (RFC 8628)

The daemon runs standard OAuth device authorization against `{API_URL}/auth/device/code` and `{API_URL}/auth/device/token` with grant type `urn:ietf:params:oauth:grant-type:device_code`.

- **`client_id` is the literal string `companion`.** This is wire-frozen: every deployed backend allowlists exactly it, so never rename it.
- Your backend shows the `user_code` approval page to a signed-in user; on approval the token endpoint returns an access token (the **device bearer**), which the daemon stores per backend.
- Any RFC 8628 implementation works. The reference implementation uses Better Auth's `deviceAuthorization` plugin.

## 2. The wire endpoints

All request/response bodies are defined in `@opencompanion/protocol` - validate with the schemas, do not hand-roll shapes.

| Endpoint | Auth | Contract |
| --- | --- | --- |
| `POST /companion/connect` | device bearer | Body: `deviceId` + presence metadata (version, hostname, CLI connections; see `ConnectResponseSchema`'s request counterpart in the daemon). Verify the bearer, then return `{ companionId, wireToken, pollIntervalMs, protocolVersion }` (`ConnectResponseSchema`). |
| `GET /companion/poll` | wire token | The heartbeat and the work channel. Return `{ runs: RunStart[], cancel: string[], connects: ConnectInstruction[], wireToken }` (`RunStartSchema`, `ConnectInstructionSchema`). Presence metadata rides query params; re-mint the wire token so an active daemon never expires mid-session. |
| `POST /companion/runs/:runId/ack` | wire token | The daemon accepted a run; remove it from the queue. |
| `POST /companion/events` | wire token | `{ batchId, events }` - streamed run frames (`RunEventMsg`, deltas / tool activity / terminal `done` or `error`). Make the append idempotent by `batchId` (a retried batch must not duplicate frames). Respond `{ cancel }` for the fastest cancel path. |
| `POST /companion/tool-call` | wire token | `ToolCallSchema` in, `ToolResultSchema` out. The agent called one of the capabilities you injected; resolve it server-side and make it exactly-once by `runId:callId` (a retry replays the cached result rather than re-executing a mutating tool). |
| `POST /companion/connects/:requestId/result` | wire token | `ConnectResultBodySchema` - the typed outcome of a connect instruction your UI enqueued (result-POST-as-ack). |

**Wire token**: on `/connect`, exchange the long-lived device bearer for your own short-lived signed token carrying `{ userId, deviceId }`; authenticate every other endpoint with it. This keeps per-request auth cheap and lets a "forget this device" action invalidate live tokens by bumping a per-device auth version.

## 3. Dispatching work

Queue a `RunStart` (prompt, tool manifest, requested policy, target `companionId = userId:deviceId`); the daemon collects it on its next poll, runs it with the user's own coding CLI, streams frames to `/events`, and calls back `/tool-call` for every capability the agent uses. **The tool manifest you send is exactly what the agent can call** - you compose capabilities server-side; the daemon injects them into the run over loopback MCP and drops any MCP server a backend tries to push.

How you store frames and surface them (SSE to a dashboard, plain persistence, a schedule's output) is your product's design; the wire does not care.

## 4. Security invariants to keep

These are enforced by the daemon's reference backend and your implementation should match them:

- **Ownership on every write**: authorize `/events` and `/tool-call` frames against the wire token's user; drop frames for runs the user does not own.
- **Bind the grant to its first `deviceId`**: `deviceId` is a client claim. Bind it to the pairing grant at first connect and refuse a different device on the same grant, or a stolen bearer sidesteps device revocation.
- **Revocation outlives the bearer**: record "forget this device" with a timestamp and refuse connects whose grant predates it; a genuine re-pair is a new grant and clears the marker.
- **Policy is clamp-only**: `RunPolicySchema` describes what you request; the daemon clamps it to the user's local ceiling. Never assume the requested mode ran.

## 5. Compatibility promise

- The wire is **additive-only within a major**: new optional fields may appear; strip unknown fields, never reject them.
- `client_id` stays `companion`; the endpoint paths above are frozen.
- A breaking change means a protocol major bump and a dual-stack window - required because daemons auto-update by default and must keep working against backends that have not updated.
- Run the fixture suite in `packages/protocol/tests` against your payloads: if your messages round-trip those fixtures, a real daemon pairs with you.

## Reference implementation

This repository is generated from the GenerateSaaS monorepo, whose backend implements this exact wire in production. The daemon's half lives here in [`daemon/src`](../daemon/src) (`pair.ts`, `poll-client.ts`, `backend-session.ts`) and is the authoritative view of what a daemon sends and expects.
