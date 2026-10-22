# Idle daemon automation verification

Run:

```sh
bun run test apps/daemon/src/automation-idle.process.test.ts
```

Each case starts the real daemon with a fresh temporary data directory, no threads,
an ephemeral authenticated WebSocket endpoint, and real SQLite databases. The
scheduler uses the system clock and real timers. The test disconnects every client
while waiting for scheduled work. Only the provider CLI is replaced with the
scripted adapter; these cases do not exercise a logged-in provider or spend quota.

The suite crosses actual minute boundaries and can take two minutes. Cases run
concurrently in separate data directories. Daemons are closed and their temporary
files removed on completion.

| Case                       | Observable result                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recurring scheduled prompt | Two minute-spaced runs deliver the saved prompt without an open client, complete successfully, and exhaust COUNT without a trigger error.                         |
| Pause, edit, resume        | Pause persists across restart, the original deadline creates no thread, and resume delivers only the edited prompt at its new deadline.                           |
| Missed run: run once       | Restart after the deadline executes one catch-up run even when another automation has an invalid file workspace.                                                  |
| Missed run: skip           | Restart after the deadline creates no thread; the invalid file trigger remains visible as unhealthy.                                                              |
| Manual retry and delete    | Reusing the same request after restart returns the original run without another provider input; committed deletion survives another restart and refuses new runs. |

Related socket tests cover stale edits, revision conflicts, restoring a deleted
definition with its history intact, and saved schedule read-back:

```sh
bun run test packages/automations/src apps/daemon/src/automation-durability.process.test.ts
```
