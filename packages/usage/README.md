# @ace/usage

Local usage accounting over committed canonical events. The daemon runs SQLite
in `UsageWorker`; `UsageStore` is the synchronous boundary for tests, benchmarks
and hosts that already own a worker. Neither class starts provider processes.
See [ADR 0040](../../docs/adr/0040-usage-analytics.md).

## Wire API

Authenticated devices with read scope can send:

```json
{
  "type": "usage.summary",
  "requestId": "usage-1",
  "query": {
    "from": "2026-10-01",
    "to": "2026-10-31",
    "groupBy": ["provider", "account", "model"],
    "filters": { "workspace": ["workspace-id"] },
    "equivalentApiCost": true,
    "limit": 100
  }
}
```

`usage.series` takes the same query and includes daily groups ordered by date.
Both return `usage.result` with the matching request id, kind and a result.
Results include the processed canonical cursor, fixed timezone, price-table
version, rows and a truncation flag. Backfill is asynchronous; compare cursor
to the daemon log head to determine whether history is caught up.

Group/filter dimensions are `day`, `thread`, `agent`, `provider`, `account`,
`model` and `workspace`. Dates are inclusive local calendar dates, up to 366
in one request. At most 1,000 rows return. Missing model/account groups are
null. Unknown models retain tokens and increment `unpricedTokens`.

For top threads or agents, group by that dimension, choose `orderBy: "tokens"`
or `"cost"`, and set a limit. Cost ranking prefers the group's reported dollars
when positive, otherwise its API estimate. `agentTree` selects a parent's
inclusive subtree; agent grouping inside that subtree still reports each
agent's direct usage once. Late linking/reparenting affects subtree membership,
including previously recorded consumption, without duplicating rollups.

Input includes cached input and cache writes. Output includes reasoning.
Those subsets have their own counters and are never added to total tokens
again. `cacheWrite1hTokens` is a subset of `cacheWriteTokens`.

`providerReportedUsd` and `estimatedUsd` are alternative observations. Do not
add them. The latter is the current table estimate for API-mode tokens,
including tokens for which the provider supplied a cost. It is a comparison,
not an invoice. Subscription usage has tokens and zero billed/reported dollars;
requesting `equivalentApiCost` exposes a separate equivalent amount. That amount
is null if any selected consumption has an unknown model. Unknown billing mode
has no estimated bill, though explicit provider-reported amounts remain visible.
The `subscriptionTokens` and `unknownBillingTokens` counters expose coverage.

## Adapter contract

Canonical `usage.updated` and core `usage` facts accept optional usage metadata:

- `counterMode: "cumulative" | "incremental"` and `counterKey`;
- `reasoningTokens`, `cacheWriteTokens`, `cacheWrite1hTokens`;
- `accountId`, `model`, `billingMode: "api" | "subscription" | "unknown"`.

Adapters must normalize inclusive input/output before using explicit
`counterMode`. Unknown provider fields continue to live in canonical raw data,
which this projection never reads.

A cumulative key is an agent-local logical counter scope. Namespace it by
native session, message, run or step and model where appropriate. Reports
advance component-wise high-water marks. Repeats and decreases add nothing;
a reset needs a new key. Missing optional fields preserve existing counters.
A keyed incremental sample is immutable and accepted once. Unkeyed incremental
samples add once per canonical sequence. Scope rows live in SQLite, so process
memory does not grow with historical messages.

Provider contracts validated against existing recordings:

| Provider | Accounting source                                 | Key                             |
| -------- | ------------------------------------------------- | ------------------------------- |
| Codex    | `tokenUsage.total`, never `last` as well          | Native session                  |
| Claude   | Message-scoped usage OR result totals, never both | Session/message or run/model    |
| OpenCode | Step-finish, not assistant aggregate as well      | Step id, shared by SSE and sync |
| ACP      | Usage when the installed CLI supplies it          | Explicit provider scope         |

Claude result `modelUsage`, when available, should emit one report per model
and include auxiliary-model calls; aggregate `usage` is only the fallback.
A parent's result must exclude separately emitted child usage. ace cannot
disentangle provider totals that already include independently reported children.
Cursor's recorded ACP fixtures have no usage; absent reports do not fabricate
zero-cost execution.

Historical events without counter metadata use Codex agent totals, Claude
run totals, and incremental counters for other providers. Claude/OpenCode
legacy input adds separately reported cache tokens; legacy OpenCode output
adds reasoning. Existing events do not retain enough information to infer
account, billing plan, session resets or duplicated OpenCode step identities.
These missing facts cannot be reconstructed from totals alone.

## Settings

The daemon reads an optional `usage-settings.json` in its private data directory
at startup. It must be a regular JSON file under 128 KiB. For example:

```json
{
  "timezone": "America/Chicago",
  "overrideVersion": "negotiated-2026-10",
  "priceOverrides": {
    "custom-model-id": {
      "input": 2,
      "cached": 0.2,
      "write": 2.5,
      "write1h": 4,
      "output": 10
    }
  }
}
```

Rates are USD per million tokens. Overrides are complete exact model entries;
no fuzzy matching or provider credential inspection occurs. `prices` can
replace the entire versioned table. Overrides revalue existing estimates at
query time, preserving reported costs. Source URLs accompany the bundled JSON.
The initial table includes selected Claude models and GPT-5.3-Codex standard
rates from [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
and [OpenAI's model page](https://developers.openai.com/api/docs/models/gpt-5.3-codex).
Cache-write rates for GPT-5.3-Codex use ordinary input pricing. Tier, regional,
large-context, tool and tax charges are outside this estimate; encode known
rate differences as exact model overrides.

The timezone defaults to the daemon host timezone and is fixed in the derived
database. To change it, stop the daemon, remove only `usage.sqlite` and its WAL/
SHM sidecars, then restart to replay retained canonical history. Do not remove
`events.sqlite`. Estimates are dated when the provider reports the increment;
late reports cannot recover the sampling time when that timestamp was absent.

## Backfill and accounts

`backfillBatch(sink, history)` reads one page of at most 256 canonical sequences,
projects only needed metadata, and sends frames of at most sixteen records.
A page may contain no usage but still advances coverage. Store replay excludes
transcript/output payloads in SQL. Cursor, counters and daily upserts commit
together. Daemon scheduling yields between batches and coalesces live wakeups;
there is no in-memory history queue.

`QuotaReader.windows(account)` returns up to twenty windows with id, unit
`tokens` or `usd`, start/end milliseconds and nullable remaining units.
`createDaemonUsage` accepts this read port; it is optional until accounts lands.
Set `quotaAccount` in a query to return local observed burn per hour and an
exhaustion time when projected exhaustion falls inside that window. Token burn
uses inclusive input plus output; dollar burn uses provider-reported dollars
only. API estimates never debit a provider quota. Windows use exact timestamps,
independent of daily rollups. Percent-only quotas have no token conversion and
must stay in accounts. Usage from other applications is outside ace's log.

## Validation and measurement

```sh
bun run test packages/usage/src apps/daemon/src/usage.server.test.ts -- --maxWorkers=2
bun run --filter @ace/usage bench
bun run check
```

The benchmark ingests 73,000 cumulative facts into 365 days of rollups for 200
agents, then measures summary, series, top-thread and subtree queries. It prints
throughput, p50/p95 latency and peak RSS, without a gating time threshold.
