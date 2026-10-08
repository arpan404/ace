# Worktree creation progress

Creation runs before thread admission. The first message stays in a daemon-owned draft keyed by
its original create command ID. Cancel leaves that draft unsent; no provider session opens.
A cancelled or failed draft is also retained across reconnects and daemon restarts. The draft
store holds at most 16 unresolved commands and refuses more rather than evicting queued input.
Successful admission saves the completed progress in `thread.details.worktreeCreation` and deletes
the draft; the ordinary command receipt handles later replays.

`thread.create` and `thread.prepare` keep their existing shapes. A worktree create now emits
`worktree.creation.progress`, correlated by `commandId` and the normalized `threadId`. Its
`attempt` increases on retries. The step order is:

1. `preparing`
2. `fetching`, for an explicitly selected remote base
3. `creating`, for branch and worktree registration
4. `checking_out`, with a monotonic integer `percent`
5. `setup`, when root scripts named `setup` exist
6. `done`

`startedAt`, `elapsedMs`, and `steps` supply overall and per-step timings. `details` contains
only the newest 200 redacted output lines, each at most 1,024 characters, within 128 KiB of JSON. Framing occurs before
redaction, so a secret split across chunks cannot bypass redaction. Oversized source lines are
omitted whole. Git and setup output reaches clients only in this log. Failures use the fixed
message "We couldn't create the worktree. Try again or use the local checkout."

Clients send `worktree.creation.request` with `requestId`, `commandId`, and one action:

| Action   | Behavior                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------- |
| `get`    | Returns retained progress after reconnect. Requires read scope and the owning device.              |
| `cancel` | Marks creation as cancelling, then cancelled after owned cleanup. Retains input.                   |
| `local`  | Cancels and cleans creation, admits a local-checkout thread, and delivers the original input once. |
| `retry`  | Repeats creation from the original selection and input with the same command ID.                   |

`worktree.creation.result` acknowledges the request. The original `commandResult` still reports
creation admission. `actions` tells the UI which controls are currently available. While cleanup
runs the state is `cancelling` and actions are empty. `cleanupComplete: false` blocks fallback
and retry; uncertain writers and changed resource identities retain the existing Git quarantine
and creation journal. UI clients should show the fixed cleanup message in that case.

Checkout counts files actually processed by Git in batches of 128. It registers the worktree
with `--no-checkout`, loads its index, and writes batches using `checkout-index`. Cancellation
waits for the current supervised batch to complete, then stops before the next batch and removes
only the checkout and unchanged branch owned by this attempt. No running checkout process is
killed merely because Cancel was pressed. Git deadlines retain the conservative containment
rules in ADR 0068. Fetch cancellation uses Git's existing bounded remote-ref-only fetch path.
Setup uses the existing root script discovery and runs targets named `setup` through the Git
mutation supervisor. Cancellation waits for an in-flight setup command, or its Git deadline.
Setup failure can remove its generated files, but a changed branch head is preserved.

Socket creation work is tracked separately from the serial input queue, with at most 16 flights
per socket and the existing global creation capacity. Controls remain readable during checkout.
A disconnected socket cancels its pending creation. After a restart, physical journal recovery
and workspace admission fences are checked before Retry or local fallback can admit a provider.

The fake daemon sends the same wire messages. Set `FakeDaemonOptions.worktreeCreationSlow` to
`true` for 1.5-second progress ticks. `worktreeCreationSchedule` lets tests advance steps without
sleeping. Direct synchronous fake `command()` remains available for fixture seeding; wire
creation and `commandAsync()` simulate the steps. Root setup scripts are simulated in the fake.

The web card, disclosure, and client-side bindings are owned by the following UI implementation.
It should render the first message on the pending command route until the create receipt supplies
an admitted thread, and use the retained progress for Cancel, Retry, and "Don't use worktree".
