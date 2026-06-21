# Telemetry Event Contract

## Goals

- Keep event names stable and versioned.
- Support provider prioritization with explicit provider-usage metrics.
- Avoid sensitive data collection.

## Global Event Properties (all events)

| Property                      | Type                | Required | Description                                                   |
| ----------------------------- | ------------------- | -------- | ------------------------------------------------------------- |
| `eventSchemaVersion`          | integer             | yes      | Current contract version. Start at `1`.                       |
| `identityType`                | enum                | yes      | `anonymous-installation` or `ace-user`.                       |
| `platform`                    | string              | yes      | Runtime platform (`darwin`, `linux`, `win32`).                |
| `arch`                        | string              | yes      | Runtime architecture (`arm64`, `x64`, etc.).                  |
| `wsl`                         | string \| undefined | no       | WSL distro marker when present.                               |
| `aceVersion`                  | string              | yes      | App/server version from `package.json`.                       |
| `clientType`                  | enum                | yes      | `desktop-app` or `cli-web-client`.                            |
| `providerIdentity.<provider>` | string              | no       | Namespaced provider identity token (`<provider>:<hashedId>`). |

## Identity Rules

- `distinct_id`: anonymous installation id hash by default.
- Optional override: `ACE_TELEMETRY_USER_ID` => `distinct_id = hash("ace-user:<id>")`.
- Optional provider identities are traits only (not `distinct_id`) from `ACE_TELEMETRY_PROVIDER_IDENTITIES_JSON`.

## Current Production Events

### `server.boot.heartbeat`

When server runtime startup finishes heartbeat collection.

Required props:

- `threadCount`: number
- `projectCount`: number
- `providerCounts`: record<string, number> (persisted thread->provider distribution)

### `provider.session.policy_stopped`

When policy sweep stops an idle/excess session.

Required props:

- `provider`: provider enum
- `reason`: string enum-like (`provider.idle_ttl_expired`, `provider.max_open_enforced`, ...)

### `provider.session.recovered`

When a session is recovered or adopted.

Required props:

- `provider`: provider enum
- `strategy`: enum (`adopt-existing`, `resume-thread`, `resume-thread-with-local-fallback`, `rebuild-local-transcript`)
- `hasResumeCursor`: boolean

### `provider.session.started`

When a provider session starts.

Required props:

- `provider`: provider enum
- `runtimeMode`: enum
- `hasResumeCursor`: boolean
- `hasCwd`: boolean
- `hasModel`: boolean

### `provider.turn.sent`

When a turn is sent to provider.

Required props:

- `provider`: provider enum
- `attachmentCount`: number
- `hasInput`: boolean

Optional props:

- `model`: string
- `interactionMode`: string

### `provider.turn.steered`

When an active turn is steered.

Required props:

- `provider`: provider enum
- `attachmentCount`: number
- `hasInput`: boolean

Optional props:

- `model`: string
- `interactionMode`: string

### `provider.turn.interrupted`

When a turn is interrupted.

Required props:

- `provider`: provider enum

### `provider.request.responded`

When approval/request response is sent.

Required props:

- `provider`: provider enum
- `decision`: string enum-like

### `provider.session.stopped`

When a specific session is stopped.

Required props:

- `provider`: provider enum

### `provider.conversation.rolled_back`

When rollback is executed.

Required props:

- `provider`: provider enum
- `turns`: number

### `provider.sessions.stopped_all`

When stop-all runs.

Required props:

- `sessionCount`: number

## Recommended Next Events (for provider prioritization)

### `provider.turn.completed`

Required props:

- `provider`: provider enum
- `model`: string
- `latencyMs`: number
- `timeToFirstTokenMs`: number
- `tokensIn`: number
- `tokensOut`: number
- `toolCallCount`: number

### `provider.turn.failed`

Required props:

- `provider`: provider enum
- `model`: string
- `failureClass`: enum (`timeout`, `network`, `provider`, `validation`, `internal`)
- `latencyMs`: number

### `provider.selected`

Required props:

- `provider`: provider enum
- `source`: enum (`default`, `user-select`, `auto-recover`, `fallback`)

### `provider.switched`

Required props:

- `fromProvider`: provider enum
- `toProvider`: provider enum
- `reason`: enum (`manual`, `failure-fallback`, `performance`, `cost`)

## Property Constraints

- Provider enum should match `ProviderKind` values.
- No raw prompt text.
- No raw attachment content.
- No repo/file paths.
- No auth/session tokens.
- High-cardinality values should be bucketed or hashed.

## Dashboard Starter Queries

- Provider share: `count(provider.turn.sent) by provider`.
- Provider reliability: `count(provider.turn.failed) / count(provider.turn.sent)` by provider.
- Median latency: `p50(latencyMs)` from `provider.turn.completed` by provider/model.
- Startup footprint: top `providerCounts` entries from `server.boot.heartbeat`.
