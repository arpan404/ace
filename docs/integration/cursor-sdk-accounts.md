# Cursor SDK accounts integration

This branch includes main through `c7ca5923`, preserving the accounts, ACP
registry, Claude SDK, OpenCode v2, web and Pi integrations. Accounts PR #25 is
merged; SDK ownership uses the accounts package public exports.

`bindCursorSdk` constructs bounded per-instance owners only after account
assignment. Account wrappers preserve backend, command identity, instance ID,
private home and bounded frame certificates. `instanceEnv(instance, base, backend)`
inherits `CURSOR_API_KEY` only for Cursor SDK; ACP and other backends keep masking
provider credentials. Registry environment entries remain directory selectors.

`cursorSdkLoginDriver` uses official SDK login/status/logout hosts. Safe status
and source persist in `quota.cursorSdkAuth`; login key returns stay in the worker.
`ace accounts add cursor` selects SDK when installed, refuses unsupported SDKs,
and uses its browser URL callback in the caller's terminal. SDK absence keeps the
ACP login path. API key entry through `--console` is unavailable for SDK; the
user configures their launch environment. SDK `accounts status` does not use CLI
login as evidence of SDK authentication.

Daemon account factories and catalogs share `CursorHostSlots`. Sign-out callers
must pass the binding's `stopInstance` fence to the login driver; it fences new
factories and drains selected hosts before credential deletion. Reservations
release on confirmed exit. A successful later sign-in calls `rebindInstance`
after hosts drain. The daemon registers browser auth through its service registry; no auth
request is inferred from an ordinary model turn. `CursorAuthService` owns bounded,
expiring, device-scoped login jobs. The typed WebSocket start/poll/cancel protocol
returns the SDK URL to the authorized client, which opens it on its own device.
No daemon-local browser launch is needed. Successful login rebinds the fenced
instance and invalidates its model catalog; logout cancels an in-flight browser
exchange before deleting the SDK store. Login also drains cached live hosts before
changing the selected credential store. Status returns only effective auth source,
including the environment override.

Default SDK admission registers its original private home when entering accounts
ownership, preserving pre-accounts checkpoints. The configured SDK launch
environment is shared by session/auth/catalog workers through narrow accounts
inheritance.

`cursor.auth.select` stores the default SDK account in accounts SQLite. New
`thread.create` commands pin that account at acceptance, with an optional explicit
`instanceId`. Changing the default never changes an existing thread's account or
checkpoint home. See [browser auth protocol](cursor-sdk-auth.md). The in-app sign-in UI uses this backend without receiving a provider key.

Runtime guards and multi-instance assembly tests need run at merge. There is no
native ACP-to-SDK checkpoint conversion or cross-account SDK checkpoint copying;
use the shared bounded context handoff, preserving source provenance and loss.

Cursor now has one provider and one SDK-owned browser sign-in. The CLI implicit
account is retired; no CLI/app credentials are imported or copied. See the
[ADR 0043 amendment](../adr/0043-cursor-sdk-local-runtime.md) for migration and the
in-app progress driver.
