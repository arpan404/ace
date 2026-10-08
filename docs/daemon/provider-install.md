# Provider CLI installation contract

`provider.install.*` is additive to provider login, readiness and the ACP registry. Every request and progress subscription needs **operate** scope. The frontend owns confirmation and presentation; the daemon owns reviewed commands and processes. See [ADR 0069](../adr/0069-provider-cli-installation.md) and the [providers design](../design/providers-experience.md).

```ts
// action defaults to install for older callers that send only provider.
{ type: "provider.install.plan", requestId, provider, action?: "install" | "update" | "uninstall", agent? }
{ type: "provider.install.run", requestId, provider, action, method: "npm" | "bun" | "brew" | "script", agent? }
{ type: "provider.install.poll", requestId, session }
{ type: "provider.install.cancel", requestId, session }
```

For `provider: "acp"`, `agent` chooses a reviewed manifest entry: `gemini`, `qwen-code`, `claude-acp`, `codex-acp`, `goose`, or `auggie`. Other providers omit it. Registry IDs, packages, versions, scripts, paths and command text cannot be supplied by a client. ACP installation is separate from binding and launch approval.

Every correlated reply is `provider.install.result { requestId, result }`. A plan succeeds with `result: { ok: true, plan }`; run, poll and cancel return `{ ok: true, progress }`. Errors return `{ ok: false, error }`, where `error` is `forbidden`, `unavailable`, `busy`, `not_found` or `invalid_method`.

A plan carries `provider`, optional `agent`, `action`, `status`, `method`, `methods`, `commands`, `verify`, `sourceUrl`, `needsAdmin` and optional installed/latest version facts and `message`. `commands` is an ordered list of `{ command, args, display }`; display uses shell quoting and contains no client input. Render the exact steps and source before confirming. The statuses are:

- `ready`: reviewed commands are available. `needsAdmin: true` means the person must approve a terminal flow; running through the daemon returns `needs_admin` without executing the mutation.
- `manual`: installation ownership is unknown or there is no documented automated lifecycle for this runtime/action. Show `message` and the source.
- `sign_in`: Cursor's SDK ships with ace. Open the existing sign-in flow.
- `unavailable`: required manager, installed runtime or reviewed ACP target is missing, or the selected manager differs from the existing owner.

Run returns an ephemeral `session` immediately in `planning`. Subscribe to `provider.install.progress { progress }`, and use poll after reconnect or remount. A retry with the same request ID and owning device returns the retained session. Progress contains `sequence`, zero-based `step`, the selected plan, `lines` as a replacement tail rather than append deltas, optional numeric/null `exit`, `version`, and a safe `message`. Ignore older sequences. Retain no more than the returned tail.

States are `planning`, `running`, `verifying`, `succeeded`, `failed`, `cancelled`, and `needs_admin`. The last four are terminal. Cancel waits for process cleanup. Failure and cancellation can leave partial package-manager changes; refresh readiness before retrying. Sessions belong to devices, survive socket disconnects, and are evicted oldest-terminal-first after 32 retained sessions. They do not survive daemon restart.

Success publishes `providers.changed` after discovery refresh, invalidates model installation metadata, and announces the verified version in final progress. Provider readiness now includes `latestVersion`, `versionCheckedAt` and the existing `updateAvailable`. An absent update field means unknown; offline checks can retain last-good facts with their observation timestamp. The UI should choose the normal signed-out/ready/attention state from readiness, never infer authentication from installer success.

The fake daemon exposes `daemon.services.providerInstalls.scenarios[provider]` as `success`, `failure` or `needs_admin`. By default it completes on a microtask. Set `autoComplete = false` to hold a session, `advance(session, line)` to stage log progress, and `complete(session, success)` to finish without timers. Its default Codex readiness has `updateAvailable: true`.
