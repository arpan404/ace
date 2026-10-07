# Model catalog contract

`models.list` reads the daemon's persisted catalog immediately. It never waits
for a provider CLI. `models.refresh` requires operate scope, waits for discovery,
and returns the same shape. Reads and resolutions require read scope.

```ts
// models.result.result for list and refresh
{
  models: CatalogModel[]; // at most 100 rows; includes hidden and legacy choices
  instances: ModelInstanceStatus[]; // selected provider/accounts, at most 64
  nextOffset?: number;
}
```

The existing execution and capability fields remain unchanged. Each discovered
row adds these fields:

| Field            | Meaning                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | Catalog selection identity. Send this exact value when selecting a model.                                                                                                                                                       |
| `displayName`    | Human model name, such as `Haiku 4.5` or `GPT-6.1 Sol`. A good provider-supplied name takes precedence.                                                                                                                         |
| `detail?`        | Snapshot suffix, such as `20251001`, `latest`, or `preview-abc123`. Display in a detail line or tooltip.                                                                                                                        |
| `family?`        | Parsed family/tier identity, such as `claude-opus`, `gpt`, `gpt-sol`, or `gpt-luna`. Unknown names may have no parsed family.                                                                                                   |
| `version?`       | Numeric dotted version, such as `4.5` or `6.1`. Snapshot dates never become versions. Unknown names may have no parsed version.                                                                                                 |
| `tier`           | `current` or `legacy`. Newest numeric version per family, account, and upstream provider is current. Provider deprecation/legacy flags win over the small exception table.                                                      |
| `sortKey`        | Opaque ascending lexical order within a provider/account. Current precedes legacy, then flagship family preference, descending version, and stable identity. Do not parse this field.                                           |
| `isDefault`      | One concrete default per provider/account, when a usable model exists.                                                                                                                                                          |
| `defaultSource?` | `built-in` or `user`, on that default row only. Settings may select a legacy model explicitly.                                                                                                                                  |
| `source`         | `{ kind: "local" \| "subscription" \| "api_key" \| "account" \| "other", id: string, label: string }`. `service?` is `opencode_go` or `opencode_zen` for those gateways. Group by instance and source identity; show the label. |

These additions are optional at the protocol boundary for compatibility with old
embedded catalogs. Native discovery and the fake daemon populate them. Keep
`group`, `legacy`, `stale`, `refreshing`, and the old error code fields during the
UI transition. New pickers should use `tier`, `source`, and `status`.

Derived legacy rows remain visible for a Legacy models submenu. The default
hide-deprecated setting still hides provider-deprecated rows. Setting
`hideDeprecated: true` explicitly also hides derived legacy rows. Favourites
bypass lifecycle hiding, and an explicit selection remains resolvable even when
legacy. An explicit provider/group/model hide still wins in the picker.

## Freshness and errors

Each `instances` row retains provider, instance, enabled, and any ACP identity.
It adds or populates:

```ts
{
  status: "fresh" | "refreshing" | "stale";
  lastRefreshedAt?: number; // epoch milliseconds; absent before any good refresh
  error?: "discovery_failed" | "timeout" | "persistence_failed"; // compatibility
  errorDetail?: {
    code: "not_configured" | "auth_expired" | "unreachable" | "cli_too_old" | "rate_limited"
      | "parse_failure" | "timeout" | "persistence_failed" | "discovery_failed";
    message: string;
    hint: string;
  };
  sources: Array<{
    source: { kind: string; id: string; label: string };
    status: "fresh" | "refreshing" | "stale";
    lastRefreshedAt?: number;
    error?: { code: string; message: string; hint: string };
  }>;
}
```

An instance is stale if any source failed. Healthy sources in that same instance
remain fresh. A partial refresh advances the instance timestamp but retains each
failed source's previous timestamp and models. An error on the instance applies
to all its sources. Show source errors even when the failing connection has no
model rows. All client-visible errors use fixed human messages and hints, including
unknown failures. Provider messages, stderr, response bodies, stacks, headers, and
credentials never enter catalog errors or client pushes. Cached source errors are
rebuilt from their classified code before use. The daemon logs the same structured
categories with provider, instance, and optional source ID. Only local logs may
include a redacted free-text reason for an unclassified failure, capped at 200 characters.

All authenticated main sockets with read scope receive:

```ts
{ type: "models.changed", filter: { provider: ProviderKind, instance: string } }
```

This is an invalidation, not a catalog page. Subscribe through `Client.onMessage`,
coalesce invalidations, and re-read affected catalog pages. Start and completion
of refresh, settings changes, account replacement, and session metadata updates
notify clients. Dedicated browser/files/screen/devices channels receive none.
Reconnects should always re-read. Continue showing cached models during refresh
and beside errors. A correlated request reply may be interleaved with pushes.

## Defaults and execution

Defaults rank only discovered, usable models. Claude prefers the newest Opus;
Codex prefers the newest Sol, then Codex, then base GPT and Luna. OpenCode prefers
Muse Spark, then Opus and other known families; Pi prefers Opus and the other
listed families. Cursor prefers the newest Composer, then other concrete
flagships over Auto, while Auto stays an explicit usable route. Unknown families
use the CLI's reported concrete
default, then a deterministic fallback. No policy contains a preferred model ID.
Settings can override per provider or account.

Custom routes retain the person's supplied name and Settings order. Numeric
selector suffixes outside recognized model families do not imply versions.

Stored `default` and `Default (recommended)` selections resolve at read/admission
time to the concrete default. Existing engine startup migration rewrites cached
thread selections and display metadata; settings are interpreted at read time.
This changes execution semantics for people who previously relied on omitting
`--model`: when a catalog model is available, ace sends its concrete route to the
CLI. It no longer follows an unrelated native CLI default setting. With no usable
catalog at all, the existing engine metadata-discovery attempt and implicit CLI
fallback remain; ace does not manufacture a model or an entitlement.

## Source evidence and cache lifetime

OpenCode grouping reads only the CLI's credential-free connection status.
`opencode-go` is Go and `opencode`/`opencode-zen` is Zen. CLI local flags,
loopback base-URL metadata and known local provider IDs identify local sources.
OAuth/Go/Copilot flags identify subscriptions. Zen is an API-key gateway with
`service: "opencode_zen"`; Go has `service: "opencode_go"`. Render the two services
separately from ordinary provider API-key groups. The official
[Zen guide](https://opencode.ai/docs/zen) describes its per-request credit billing.
Exposed API-key/environment connection types identify API keys. A generic
credential connection does not establish a payment method; without a CLI-exposed
API-key or OAuth flag it remains `other`. Unknown types also remain other
configured providers. Endpoint values
are used only to recognize loopback and never persist in grouping fields.
The official [OpenCode provider guide](https://opencode.ai/v2/docs/providers)
describes provider identities, Go, and custom endpoints; ace reads no config or
credential file to obtain them. If the installed CLI does not expose a custom
endpoint's local flag or base URL, its source remains `other` rather than
asserting it is local.

Pi uses the provider identity in its own `get_available_models` metadata, with
GitHub Copilot labelled as a subscription. Other Pi provider groups do not imply
an authentication/payment method when Pi has not supplied it. Codex, Claude and
Cursor use account IDs and account labels; a client may render one account flat.

Cache payload schema v2 accepts unversioned/v1 rows, repairs old OpenCode
execution IDs, and cleans names/classification before serving. The next durable
replacement writes v2. Startup serves the persisted rows and revalidates in the
background even if they are younger than the six-hour maximum age. Ordinary
stale reads trigger one coalesced refresh. Failed discovery uses a separate
exponential schedule for each instance/source, starting at 30 seconds and doubling
to a 30-minute cap, with ±20% jitter and no delay above the cap. Success clears the
recovered source's failure history. Explicit Refresh models, login/settings/CLI
version changes, and changed connection fingerprints reset the affected instance's
schedule. Retry history is in memory, bounded to 512 source entries per instance,
and is discarded on removal or daemon restart.

Automatic reads, age revalidation, and connection reconciliation all honor the
schedule. OpenCode's model query covers all connected sources, so it waits until
every failing source is eligible. Healthy cached choices remain usable meanwhile.
Connection metadata still polls every minute to detect changes; failures of that
probe back off too. Warn logs record the first failure, changed reason, and changed
exponential delay. Unchanged failures at the cap log at debug, including when
jitter changes the actual delay. The structured `retryInMs` field reports the next
eligible delay without exposing vendor diagnostics.

Cursor SDK checks `Cursor.auth.status()` inside its isolated host before listing
models. A missing SDK sign-in or empty environment override produces
`not_configured`; auth rejections produce `auth_expired`. The instance remains
visible so its sign-in and Settings → Providers hide hints are discoverable. The
SDK owns credential access; ace does not read credential contents. OpenCode model
HTTP status, error codes/messages, and nested client causes choose fixed categories:
401/403 are `auth_expired`, 429 is `rate_limited`, and network/5xx are `unreachable`.
GitHub Copilot auth failures instruct the user to reconnect through
`opencode auth login`. Classification runs before the startup wrapper discards
nested HTTP/client causes, including identity, spec, and SSE admission failures.
Unrelated null fields do not discard usable status/code fields. Generic outer
wrappers cannot hide specific nested categories. Unknown failures use the fixed
`discovery_failed` message and hint in the picker. A bounded, redacted reason may
be passed separately to the local logger, never stored with catalog state or errors.
Cursor host startup failures retain a scrubbed first stderr explanation and exit
status when no RPC reply arrives. Raw response objects, stacks, credential fields,
and unredacted diagnostics never leave these boundaries. Existing picker and
Settings rows render these hints.

Provider status probes notify catalog invalidation when a CLI version changes.
Version notifications apply only to their runtime, so Cursor CLI versions do
not invalidate SDK catalogs. An explicit refresh waits for a replacement
discovery when the same account's runtime version changes during its flight.
OpenCode/Pi connection metadata is reconciled every minute. An unchanged
non-secret fingerprint leaves the catalog alone; connect/disconnect or changed
availability triggers discovery. Settings changes affect only changed provider
configurations. Login revisions revoke the old account immediately, rather
than displaying a different person's cached choices. Other invalidations retain
the last good catalog. Unavailable CLIs and unknown auth probes retain the last
good account cache; only confirmed auth changes advance the login revision.
Late results cannot replace a newer generation. Replacing a login outside ace
without changing CLI-exposed connection flags or model availability cannot be
detected from those flags alone; explicit refresh always discovers again.

The internal `ModelCatalog.invalidate` API remains an account-revocation
boundary: it immediately removes choices and drains obsolete writes before
durable deletion. Ordinary age/settings/version changes and refresh use the
retaining path; `markStale` also exposes that path to local owners. Cache
retention never crosses an account revocation or removal.

Existing bounds remain: 64 instances, 512 models and sources per instance,
4 MiB persisted payload per instance, 2 KiB raw metadata per model, 128 queued
writes, and 8 MiB pending write bytes. Probes use bounded supervised output,
coalescing, deadlines and cancellation. No discovery sends provider prompts.
The fake daemon includes all five native providers, both Claude/Codex accounts,
current and legacy choices, local/Go/Zen/API-key OpenCode sources with a failing
OpenRouter connection, Copilot/Anthropic Pi groups, and stale Cursor sign-in.

A connected OpenCode source with no enabled chat models, after its ID-only
fallback also reports no choices, has a fresh `no_models` advisory in the
existing source `error` field. This additive code carries a fixed message and
hint. Settings and the picker show it as information without a failure icon. It removes previously enabled choices for that source, logs once at info
per transition, and does not schedule failure-backoff retries. Explicit Refresh,
connection or login changes, settings changes and maximum age still revalidate
the catalog. Explicit metadata or fallback failures retain failure semantics.
