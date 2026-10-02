# Provider model catalog

`@ace/models` discovers model choices through local CLIs without sending a prompt.
Use the same catalog for pickers, role settings and orchestration.

```ts
import { ModelCatalog, createModelDiscovery, openModelStorage } from "@ace/models";

const catalog = new ModelCatalog({
  storage: openModelStorage("/private/ace/models.sqlite"),
  instances: [
    {
      id: "codex-personal",
      provider: "codex",
      loginRevision: "login-generation-1",
      executable: "/usr/local/bin/codex",
      cwd: "/private/ace/discovery",
      env: { CODEX_HOME: "/home/me/.codex-personal" },
    },
  ],
  discover: createModelDiscovery(),
  now: Date.now,
  deadline(expire, ms) {
    const timer = setTimeout(expire, ms);
    return () => clearTimeout(timer);
  },
});
const cached = catalog.list({ provider: "codex", limit: 100 });
await catalog.refresh({ instance: "codex-personal" });
const choice = catalog.resolve({
  role: "coder",
  provider: "codex",
  selection: "strongest",
  preferenceOrder: ["preferred-model", "fallback-model"],
  tier: "fast",
  effort: "high",
});
await catalog.loginChanged("codex-personal", "login-generation-2");
await catalog.close();
```

The instance owner supplies a non-secret revision that changes on login/logout
or account switch. Registration loads matching persisted rows immediately;
unregistered instances are invisible. `registerInstance` also updates launch
configuration. Await `removeInstance` to confirm durable deletion. It hides cached
rows immediately and cancels discovery, then reports storage failures. Failed
deletions remain pending for an explicit removal retry, re-registration refresh,
or close. Close retries pending deletes and rejects if any still fail, leaving
storage open so close can be retried after recovery. Caller
launch arguments precede provider-specific arguments. ACP/Antigravity arguments
must include whatever starts the installed server. Do not put secrets in revision
strings. Environment overrides never enter cache rows or wire responses.

List returns a page of up to 100 models, `nextOffset` and per-instance freshness,
refreshing state and sanitized error codes. A cold list returns an empty page and
starts background discovery. An expired list returns stale rows immediately.
Failed discovery keeps those rows and retries after a cooldown; explicit refresh
bypasses the cooldown. Refresh returns statuses, so partial failure is visible.
SQLite writes run on a dedicated worker with a 128-request queue cap.
Refresh also retries pending deletions for other accounts, but only a failed
deletion of the refreshed account prevents its update. SQLite rejects new
accounts at 64 durable rows; a failed unrelated removal cannot block a valid
update or insertion below capacity.
SQLite corruption fails startup rather than silently trusting invalid rows.
The caller owns the catalog and must await close during shutdown. Injected
discovery implementations must settle after abort only after releasing owned
resources. The built-in implementation reaps its CLI before settling; shutdown
awaits those cleanup promises separately from timeout responses.

Resolve never runs inference. It picks only compatible reported choices and
returns their native tier parameters plus a reason. Effort names on OpenCode
are native variant IDs; pass them as `variant`. Explicit model IDs can select
hidden/deprecated models. Automatic choices exclude them. Strongest requires a
preference order maintained by the role-policy owner. Duplicate IDs keep their
first priority. Reasons are capped at 1,024 characters; concrete model, tier and
effort fields remain complete. Without an order, the reason
states the default fallback. Unknown image support cannot satisfy imageInput.
Catalogs report choices, not verified subscription entitlement.

The daemon opens this SQLite cache and exposes `models.list`, `models.refresh`
and `models.resolve` over its authenticated socket. Configure local instances
with `ACE_MODEL_INSTANCES`, a JSON array of the instance objects above. Embedders
may pass instances as the fifth argument to `startDaemon`, after MCP toolkits and
optional notification channels; its returned `models`
object supports local registration and login-change notifications. The account
manager workstream must call these hooks. No credentials or launch configuration
are accepted from wire clients. Catalog queries do not append thread events. Remote list/resolve require read
scope; explicit refresh requires operate scope.

Each probe is capped at 4 MiB, each raw row at 2 KiB, each instance at 512 models,
and the catalog at 64 registered instances, 64 outstanding refresh flights and
64 unsettled discovery cleanups. Pending deletions are capped at 128.
Normalized rows are capped at 8 KiB and persisted instances at 4 MiB.
Four probes run concurrently by default. Over-limit payloads fail the refresh
instead of silently dropping models. Cached model objects are frozen; callers
must copy a model before editing it. Pages can change across refreshes, so start
from offset zero after an explicit refresh.

OpenCode metadata is parsed line by line, retaining one bounded native object
plus normalized rows. No complete listing is joined and split again.

Run `bun run --filter @ace/models bench` for non-gating list, resolve and streaming
parser measurements.
See [ADR 0036](../../docs/adr/0036-model-catalog.md) for sources and tradeoffs.
