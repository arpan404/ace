# OpenCode thread-open failure

The failure occurs before HTTP session creation. Catalog normalization retained
`id = opencode-go/muse-spark-1.3-contributor` but overwrote `nativeModelId` with
`muse-spark-1.3-contributor`. The client builds New thread choices from
`nativeModelId`, sends that value unchanged in `thread.create.model`, and the
engine passes it through session metadata to `SessionContext.model`.
`selectedModel()` requires a provider/model selector and throws
`OpenCode model must be provider/model`. The session-open catch discarded that
exception and returned `OpenCode session opening failed`.

The relevant sources are `packages/models/src/open-code.ts`,
`packages/models/src/opencode-discovery.ts`, `packages/ui-core/src/models.ts`,
`apps/web/src/features/home/new-thread/new-thread-page.tsx`,
`apps/web/src/features/home/new-thread/use-create-thread.ts`,
`apps/daemon/src/engine/sessions.ts`, and
`packages/adapter-opencode/src/input.ts`.

## Real installed CLI verification

The machine has Homebrew OpenCode 1.18.4 first on PATH and OpenCode v2.0.22 at
`<HOME>/.opencode/bin/opencode`. The reproduction explicitly selected the latter.
A disposable Git repository and linked worktree, HOME, and all four XDG roots
were created under a temporary directory. No ace account home was accessed.
The adapter started its own authenticated loopback server using its usual stdin
lease and readiness checks.

The initial run against the unchanged adapter reproduced the generic failure
for the actual UI selector in every mode. The same qualified selector opened
successfully in every mode. After the error-handling fix, a differential rerun
captured the underlying exception for the bare selector and HTTP create/get
results for the qualified selector. A fetch guard permitted only GET requests
and POST `/api/session`; cleanup interrupts were blocked locally. No prompt or
chat message was sent to any real CLI. Both selected-model cases used the same
temporary worktree and permission rules.

| Permission mode | Session rules                                 | Bare UI selector before fix     | Qualified selector after fix      |
| --------------- | --------------------------------------------- | ------------------------------- | --------------------------------- |
| auto-review     | `action: "*", resource: "*", effect: "ask"`   | selector rejected before create | create 200, get 200, same session |
| ask             | `action: "*", resource: "*", effect: "ask"`   | selector rejected before create | create 200, get 200, same session |
| read-only       | `action: "*", resource: "*", effect: "ask"`   | selector rejected before create | create 200, get 200, same session |
| full-access     | `action: "*", resource: "*", effect: "allow"` | selector rejected before create | create 200, get 200, same session |

Captured failure after preserving the cause:

```json
{
  "model": "muse-spark-1.3-contributor",
  "permissionMode": "auto-review",
  "error": "OpenCode session opening failed: OpenCode model must be provider/model"
}
```

The successful create body used:

```json
{
  "title": "ace",
  "model": { "providerID": "opencode-go", "id": "muse-spark-1.3-contributor" },
  "location": { "directory": "<TEMP>/worktree" },
  "permissions": [{ "action": "*", "resource": "*", "effect": "ask" }]
}
```

The installed official `@opencode/client` 2.0.22 declarations and observed server
responses confirm that model and permission payload. An attempted real catalog
metadata refresh timed out in the fresh home. Catalog-to-open behavior is tested
with the local v2 boundary fixture, including metadata and CLI-list fallback.
Session create/get verification does not establish inference entitlement.

## Delivery and diagnostics

OpenCode closes its partially opened session on failure and invokes `onExit`.
Previously that callback expired the pending delivery as uncertain while
`openSession` was still running. The later `DeliveryNotStarted` handling retained
the input but left the uncertainty flag behind. Open callbacks now expire
pending delivery only after a usable session has been returned. Retaining a
provably unsent input clears its uncertainty flag and pauses it for manual retry.
Post-send transport failures keep their existing uncertainty handling.

OpenCode and ACP now preserve bounded, redacted code/title/detail fields instead
of replacing structured failures with generic errors. Claude, Codex, Pi and
Cursor open catch blocks rethrow their exceptions; the shared engine opening
boundary sanitizes them, reports a warn diagnostic and passes structured details
through the delivery failure to the persisted notice. ProviderErrorDetails keeps
its existing code/provider/model fields and adds optional title/detail fields.
Raw exceptions and provider stacks are not retained in the sanitized error.

The regressions failed before the fix for both catalog discovery paths, all four
permission modes, create/get/update error detail, and the exit-during-open
uncertainty race. The persisted-catalog regression also opens an older cached
choice after restart without a successful metadata refresh.
