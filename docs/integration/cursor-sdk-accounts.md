# Cursor SDK accounts handoff

The accounts package is absent on this implementation worktree's `main` baseline.
This patch targets `origin/feat/accounts` at `a30aa2c85849b92ee471f0ccc6147f0b3a6f6492`. Apply it after the accounts
train lands using `git apply --unidiff-zero`, then run static checks. Its runtime guards need run at merge.

The SDK adapter exports the official login driver, safe auth status/source,
selected-home environment composition, host disposal, authenticated model worker
and shared `CursorHostSlots`. Accounts remains the owner of registry selection,
writer reservations and quota status. No SDK credentials are copied into ace.

The patch adds a narrow `instanceEnv(instance, base, backend)` exception only for
Cursor SDK. ACP and every other backend continue masking environment credentials.
Factory and session wrappers preserve the backend, private home, instance ID and
durable command operation ID. `bindCursorSdk` consumes those public contracts.
`cursorSdkLoginDriver` publishes safe auth facts after official SDK operations;
its login URL callback must be an authorized ephemeral UI and never a frame log.

The train still needs to route its CLI login command through this SDK driver,
persist safe auth source in account summaries, and provide the selected factory's
`stopInstance` fence to logout. Share one `CursorHostSlots` across all selected
factories, catalog workers and auth drivers. Reservations release after confirmed
host exit, never after issuing cancellation. If hosts fail to exit, retain the
reservation. Successful sign-in must rebuild/rebind an adapter after its logout
fence; this implementation intentionally does not reopen a signed-out owner.

This is an integration dependency, not a claim that the accounts daemon routes
are available on this branch. The patch was not executed or typechecked against
an assembled train, and the package was not imported wholesale from the other
worker's branch.
