# Cursor SDK accounts integration

This branch refreshes onto train 2 and Claude SDK changes at `6a26d03`.
Accounts PR #25 is now merged. The earlier handoff patch has been applied and
adapted directly through the accounts package public exports.

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
after hosts drain. Browser login/logout socket UI and that lifecycle composition
remain product integration work; no authentication request is inferred from an
ordinary model turn.

Runtime guards and multi-instance assembly tests need run at merge. There is no
native ACP-to-SDK checkpoint conversion or cross-account SDK checkpoint copying;
use the shared bounded context handoff, preserving source provenance and loss.
