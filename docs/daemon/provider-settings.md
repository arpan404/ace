# Provider settings backend contract

Provider preferences belong to the daemon's global settings layer and synchronize through existing settings subscriptions. They describe installed CLI runtimes; authentication stays with the provider CLI (ADR 0002). No credential fields, environment overrides or shell arguments are accepted here.

## Settings UI API

Read with `settings.get` using `key: "providers.configuration"`, `scope: {}`. Subscribe with `settings.subscribe`, a unique `subscriptionId`, `keys: ["providers.configuration"]`, `scope: {}`. Writes require an admin device and `layer: {kind: "global"}`. Workspace/thread writes are rejected. `settings.result` acknowledges writes; `settings.changed` delivers the effective array to every subscriber. Persisted preferences survive daemon restarts.

```json
{
  "type": "settings.set",
  "requestId": "provider-preferences",
  "key": "providers.configuration",
  "layer": { "kind": "global" },
  "value": [
    {
      "provider": "opencode",
      "enabled": true,
      "hiddenGroups": ["anthropic"],
      "hiddenModels": ["openai/gpt-4o"],
      "shownModels": ["openai/gpt-4o-mini"],
      "favourites": ["opencode-go/muse-spark-1.3-contributor"],
      "showOnlyFavourites": false,
      "hideDeprecated": true,
      "customModels": [{ "id": "my-router/My_Exact.Model-v2", "displayName": "My Router Model" }]
    }
  ]
}
```

The value defaults to `[]`. Each row has required `provider: ProviderKind` and these optional fields:

| Field                                   | Meaning/default                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `instance: string`                      | Existing catalog/account instance ID; omitted means provider-wide defaults. It does not create an account. |
| `enabled: boolean`                      | Defaults true. A provider-wide false overrides every account row.                                          |
| `binaryPath: string`                    | Absolute executable path on the daemon host. Omission uses the installed/default binary.                   |
| `customModels: {id, displayName}[]`     | Exact custom IDs and labels; defaults empty. Discovery metadata wins on ID collision.                      |
| `hiddenModels`, `shownModels`: string[] | Catalog `id` values; default empty. Explicit show can reveal deprecated/provider-hidden models.            |
| `hiddenGroups`, `shownGroups`: string[] | Upstream `nativeProviderId` values; default empty. Explicit shown group overrides a hidden group.          |
| `favourites: string[]`                  | Catalog `id` values; default empty.                                                                        |
| `showOnlyFavourites: boolean`           | Defaults false. Applied after other visibility rules.                                                      |
| `hideDeprecated: boolean`               | Defaults true, including legacy models.                                                                    |

Account fields replace provider fields when present, including arrays. Omitted fields inherit; an empty array clears an inherited list. To reset an account field to inheritance, omit it. There are at most 64 unique provider/instance pairs, 128 unique custom IDs per row, and 512 unique IDs per other list. IDs/instance/group strings have 1–256 characters without whitespace/control bytes. Labels have 1–256 characters and must contain non-whitespace. Binary paths have at most 4096 characters without control bytes and must be absolute; their executability is checked at discovery/launch. No interpolation occurs.

Visibility precedence is disabled provider, hidden group, hidden individual model, explicit shown model, deprecated/legacy default, provider's own hidden flag, then favourites-only. `shownGroups` unmasks its corresponding group; `shownModels` does not unmask a hidden group. If an ID appears in both individual lists, hide wins. Showing or favouriting a model does not authorize an unconnected upstream provider.

Manually added `customModels` are an explicit opt-in: they remain selectable even
when OpenCode reports no connected upstreams. They support user-owned routers and
IDs absent from discovery. They do not prove authentication or entitlement; the
user's CLI decides whether the exact ID can run. Ordinary discovery and visibility
switches never add disconnected upstream models. Provider/account disable still
hides and refuses custom selections.

The settings API replaces the entire array. Clients should read/subscribe, modify their intended row, and preserve other rows. Existing settings last-writer-wins behavior applies; there is no compare-and-swap endpoint.

## Catalog, names and refresh

`models.list` accepts `options: {provider?, instance?, offset?, limit?}` (plus existing ACP identity filters). Defaults are offset 0 and limit 100; follow `nextOffset` until absent. It returns all matching rows, including hidden ones, so Settings can display switches and existing thread selections can retain their labels. Pickers filter `hidden === false` and `providerEnabled !== false`.

Rows retain `provider`, `instance`, `id`, `displayName`, `nativeModelId`, and optional `nativeProviderId`. New flags are `favourite`, `custom`, `providerEnabled`, `legacy`, and optional `visibilityReason`: `provider_disabled | group_hidden | model_hidden | deprecated | not_favourite | provider_hidden`. Group by `(provider, instance, nativeProviderId)`; OpenCode IDs stay qualified as `provider/model` and duplicates are removed within each instance. Custom IDs retain their spelling and pass through to the session adapter. Custom rows do not claim unreported context windows, effort options or tier capabilities.

Use the browser-safe `modelDisplayName(id, suppliedName?)` export from `@ace/models/display-name`. It returns `{displayName, upstreamProvider?}`. The provider's actual label wins; normalization falls back to parsing when its label is just the raw ID. Examples: `opencode-go/muse-spark-1.3-contributor` → `Muse Spark 1.3 Contributor`; `claude-opus-5-5` → `Claude Opus 5.5`; `gpt-6.1-sol` → `GPT-6.1 Sol`; `anthropic/claude-opus-4-8` → `Claude Opus 4.8`, upstream `anthropic`.

`models.list` returns cached rows immediately and schedules stale metadata refresh. TTL is 15 minutes; failures back off 30 seconds, with 15-second probe deadlines and shared concurrency limits. `models.refresh` accepts `filter: {provider?, instance?}` and bypasses TTL/backoff, joining a refresh already in flight. It requires operate scope. The `models.result` response arrives after refresh finishes and contains a normal first catalog page.

For animation, issue `models.refresh` and concurrently poll `models.list` for the same filter while its request is pending. Each `instances[]` entry includes `refreshing`, `stale`, `enabled`, optional `lastRefreshedAt` (Unix milliseconds; same value as retained `refreshedAt`), and sanitized optional `error: discovery_failed | timeout | persistence_failed`. A failed refresh preserves compatible cached rows and the previous success timestamp. No model-progress push subscription exists. FakeDaemon exposes the same fields and preferences.

OpenCode discovery reads only its credential-free `auth list --standalone --format json` status, then filters metadata to upstream IDs with credential/environment connections. An empty connection list yields an empty catalog; failed status never expands into the global catalog. The ID-only fallback applies the same filtering. Old unscoped persisted OpenCode catalogs are invalidated once. This reports connected-provider availability, not per-model subscription entitlements. Refresh after changing external CLI authentication; ace's existing account invalidation also applies. Pi's available-model API and account-local Codex/Cursor APIs already follow this principle.

## Enable/disable and executable changes

Disabled providers do not start metadata probes or new sessions; cached/custom rows remain returned as hidden. `providers.request` with `operation: "list"` retains the provider card with `enabled: false`. Attempts to create, prepare, send, fork, resume, switch, merge, resume queues or change model/mode on a disabled selection return a failed command result with `error: "provider_disabled"`. Persisted thread snapshots/history remain readable. Existing running work is not interrupted automatically; interrupt remains available.

Re-enabling a provider discovers missing adapters without rebinding existing account owners. Cursor SDK activation admits its default account/catalog and initializes authentication even after disabled startup without a Cursor CLI or explicit SDK home. Socket auth requests and explicit model refresh wait for pending activation; cached catalog queries remain immediate. Both source and destination must be enabled for a fork merge, including patch merges.

Explicit global binary paths can admit a missing native CLI without a daemon restart. Preferences affect the next session launch; running sessions keep their process. A binary change fences old discovery results and invalidates incompatible catalog metadata. Account binary overrides apply after account assignment. CLI runtimes honor binary overrides; Cursor SDK module resolution retains its existing SDK configuration. Generic ACP `binaryPath` values are ignored: the registry-approved launch plan's command is authoritative even if a session requests another executable. This setting does not install or create ACP agents.

## UI follow-up for the Claude web agent

Use `Client.settingsGet` and `Client.settingsSet` for preferences; use
`Client.request({type: "settings.subscribe", ...})` and `Client.onMessage` for
`settings.changed`, releasing with `Client.send({type: "settings.unsubscribe", ...})`.
Use `Client.request` with `models.list`, `models.refresh`, and `models.resolve`
for the catalog. Build model/group switches, favourites-only
controls, parsed labels, hidden-selection badges, disabled-provider read-only
states and refresh animation with the polling contract above. Omit the binary-path
editor for registry-backed ACP and SDK-backed Cursor. No UI source is part of this
backend revision.
