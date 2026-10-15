# Worktree creation progress

Creation runs before thread admission. The first message stays in a daemon-owned draft keyed by
its original create command ID. Cancel leaves that draft unsent; no provider session opens.
A cancelled or failed draft is also retained across reconnects and daemon restarts. At most 16
starts may be running or awaiting cleanup at once; more are refused rather than evicting queued
input. Settled failed or cancelled starts never count: they are forgotten on `dismiss`, after an
hour, or beyond the newest 64.
Successful admission saves the completed progress in `thread.details.worktreeCreation` and deletes
the draft; the ordinary command receipt handles later replays.

`thread.create` and `thread.prepare` keep their existing shapes. A worktree create now emits
`worktree.creation.progress`, correlated by `commandId` and the normalized `threadId`. Its
`attempt` increases on retries. The step order is:

1. `preparing`
2. `fetching`, for an explicitly selected remote base
3. `creating`, for branch and worktree registration
4. `checking_out`, with a monotonic integer `percent`
5. `setup`, when a root script named `setup` exists. Only one runs: package.json's first, then
   Procfile, Makefile, justfile. A checkout whose scripts can't be listed has no setup.
6. `done`

`startedAt`, `elapsedMs`, and `steps` supply overall and per-step timings. `details` contains
only the newest 200 redacted output lines, each at most 1,024 characters, within 128 KiB of JSON. Framing occurs before
redaction, so a secret split across chunks cannot bypass redaction. Oversized source lines are
omitted whole. Git and setup output reaches clients only in this log. A failure carries a fixed
`error` code (`git_quarantined` with `lockPath`, `not_a_repo`, `no_commits`, `invalid_ref`,
`branch_exists`, `ref_conflict`, `workspace_preparation_collision`, `setup_failed`,
`preparation_timeout`, `worktree_base_not_found`, ...) and a readable `message`; the failed
`commandResult` carries the same code with a `title` and `detail`. The daemon logs the cause.
"Clear stale lock" for a quarantined project is `workspace.git.lock.clear`, which also retries
the cleanups the lock held back.

Clients send `worktree.creation.request` with `requestId`, `commandId`, and one action:

| Action     | Behavior                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `get`      | Returns retained progress after reconnect. Requires read scope and the owning device.              |
| `cancel`   | Marks creation as cancelling, then cancelled after owned cleanup. Retains input.                   |
| `local`    | Cancels and cleans creation, admits a local-checkout thread, and delivers the original input once. |
| `retry`    | Repeats creation from the original selection and input with the same command ID.                   |
| `continue` | After `setup_failed`: admits the thread in the kept worktree without running setup.                |
| `dismiss`  | Forgets a settled failed or cancelled start, removing a worktree kept after failed setup.          |

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
Setup runs through the Git mutation supervisor. Cancel during setup stops waiting at once and
removes the worktree after the script exits (or reaches its Git deadline): killing it would leave
an unconfirmed writer fencing the repository. A failed setup keeps the worktree, reports
`setup_failed` with the output in `details`, and offers Retry (setup again in the kept
worktree), Continue and Use local. Read-only preparation before `git worktree add` has a
60-second deadline (`preparation_timeout`) and stops waiting on Cancel or Use local. A project in
a repository subfolder runs in the same subfolder of its worktree. When an earlier cleanup kept
the thread's branch, a retry uses `ace/<key>-2` and so on rather than adopting it.

Socket creation work is tracked separately from the serial input queue, with at most 16 flights
per socket and the existing global creation capacity. Controls remain readable during checkout.
A disconnected socket no longer cancels its creation: the start finishes, and the same device's
replay of the same command attaches to the running operation (or reads its recorded receipt).
After a restart, physical journal recovery runs in batches, logs what still needs cleanup and
never blocks later starts; workspace admission fences are checked before Retry or local
fallback can admit a provider.

The fake daemon sends the same wire messages. Set `FakeDaemonOptions.worktreeCreationSlow` to
`true` for 1.5-second progress ticks. `worktreeCreationSchedule` lets tests advance steps without
sleeping. Direct synchronous fake `command()` remains available for fixture seeding; wire
creation and `commandAsync()` simulate the steps. Root setup scripts are simulated in the fake.

The web app renders the first message on the pending command route with a card under it: one line
per reached step, checkout's percent, a "More details" disclosure over `details`, and the actions
in `actions`. The composer's tab mirrors the state. `WorktreeCreations` (`@ace/client/worktree-creations`)
holds the newest progress per command ID, asks `get` when a view opens it and after each
reconnect, and sends the actions. Retry and local fallback reopen the create's failed intent, so
the next receipt moves the route to the admitted thread. That thread shows
`details.worktreeCreation` under its first message as one folded line, such as
"Worktree ready · branch · 4.2s". Set `?fakeWorktree=slow` in `dev:fake` to watch the steps.
