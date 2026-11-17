# 0175: The daemon always comes up; a slow part degrades only itself

Date: 2026-11-16. Status: proposed. Decided by: the owner (goal), the startup-resilience work (policy).

## Context

A Mac running 0.0.23 logged 48 daemon starts between 10 and 17 November. 24 reached listening.
The other 24 stopped with `Daemon cannot start: Service engine: Service engine startup exceeded
15000ms`, up to 10 starts in an hour. Five stops in a row also overran the 7 s shutdown
deadline. The same machine had a command folder that stopped answering a `stat`, and its disk
was nearly full.

The engine was the one essential service, and its start awaited:

- each provider CLI's `--version` probe (10 s timeout each, run in parallel), Pi's and
  Antigravity's probes, and the Cursor SDK;
- Cursor sign-in;
- the listing of skill folders the last run left, then restart recovery, then removing up to
  64 of those folders.

All of that waits on other programs and on the disk. With one CLI that never answers, the
endpoint appeared after 10.5 s on a fast Mac; add a slow disk and the engine passed 15 s.

At shutdown, each service's cleanup had its own 6 s bound, but a service waits for its
dependents first, so the bounds added up along a chain: a `browser` cleanup stuck on Chromium
held `settings` past the daemon's 7 s deadline (seen in the logs as `service settings (waiting
for dependents)`).

The desktop supervisor already restarted a crashed daemon with exponential backoff and gave up
after five fast failures in a row. Each start failed the same way.

## Options considered

- **Raise the engine's deadline.** Rejected: a CLI or folder that never answers still stops the
  start, only later.
- **Make the engine non-essential.** Rejected: without it every command fails with
  `engine_unavailable`, and its dependents (agent control, machines, transfers) would need a
  restart path of their own. The engine's own work, the store and the recovery, is fast and
  local.
- **Start the engine at once and read providers after it is up (chosen).** The engine already
  answers `engine_starting` to new threads before it is ready, and every session open and
  command already waits on `providerActivation`.

## Decision

1. **The daemon's start awaits only what correctness needs.** The lock, the home's format, the
   event store and the socket are fatal and are opened before any service. Of the services, one
   marked `essential` (today the engine) and everything it requires, transitively (today
   `accounts`), stop the start: without a required service the essential one cannot start
   either. `criticalServices()` and `failurePolicy()` in `services/` say which.
2. **Provider discovery runs after the engine is published** (`services/provider-activation.ts`).
   Adapters join the engine's registry as they are found and are bound before any session opens:
   sessions and commands wait on `providerActivation`, and so does restart recovery, so whether
   an interrupted turn may continue is still decided against the CLIs actually installed (ADR
   0170 decision 5). Skill folders are recorded before any adapter is bound, and are removed in
   the background. The engine reports `starting` until providers are read and recovery has run,
   and `degraded`, with the reason, if discovery failed.
3. **Every other service that fails or misses its deadline degrades alone**, says so in
   `/v1/status`, and is retried after 30 s, 1, 2, 5 and 10 minutes once the daemon listens. A
   retry starts only once the last attempt's own calls (its start, its listeners, its cleanup)
   have settled; deadlines stop the waiting, never the fence. Services that require it start
   again once it recovers.
4. **Service cleanup at shutdown shares one 6 s budget.** Once it is spent, a service stops
   waiting for its dependents and leaves a stuck cleanup running; the process exits next. A stop
   stays inside the daemon's 7 s deadline.
5. **A stuck start is remembered, and so is a crash.** Each service's start is recorded in
   `startup-attempts.json` until all of that service's calls settle. A daemon that dies partway
   leaves the names behind. Each service's start and listeners run in an `AsyncLocalStorage`
   scope carrying its name (`services/service-scope.ts`), which the timers, callbacks and promise
   continuations they leave running inherit. A fatal error raised in that scope is recorded
   against the service in `service-crashes.json` before the process dies
   (`service-crashes.ts`).
6. **The app starts a crash loop in safe mode.** After two fast failures in a row, the
   supervisor starts the next daemon with `ACE_SAFE_MODE=1`; that daemon leaves off the services
   its last run never finished starting, and those that crashed the daemon twice within 10
   minutes, except the critical ones of decision 1, until ace restarts. A port
   conflict never starts safe mode, because leaving services off cannot free a port. The person
   reads one sentence, while restarting and then in the tray: ace is running without the part
   that kept it from starting, and a restart of ace turns it back on. A stable run (60 s) or a
   repair ends safe mode. Backoff and the five-failure limit stay as they were.
7. **An account home that doesn't answer holds up only its own account.** The accounts service
   opens its index and returns; each saved account's home is then checked on its own, one after
   another, and a check that hasn't answered within 2 s is left running while the next starts.
   Until its check answers, an account reads as `home_checking`: listed and named, never
   missing, never available. A session bound to it waits for that check, says so in the thread
   after 2 s, and after a minute fails with the reason, its message kept; a pick by limits waits
   for every candidate's check, and so does a delegation, within its model-load budget. Commands,
   skills and account restoration never wait for the whole pass, only for the account they
   concern. No work moves to another account and nothing is deleted because
   a folder is silent; once it answers, the account works without a restart.
8. **The home's lock needs no reclaiming.** It is a kernel lock held by an open SQLite
   transaction, so a daemon that crashes, overruns its shutdown or is killed releases it with its
   process.

## Consequences

- Clients can connect while providers are still being read. A new thread for a provider not
  read yet waits for it, as it already did when a provider was enabled later.
- `/v1/status` can show the engine as `starting` for up to a CLI's probe timeout after listening.
- A service's start function may now run more than once in one process, each attempt with its
  own resources. A service that keeps state outside its `ServiceContext` must reset it.
- A cleanup cut short at shutdown may still be running as the process exits; that is the same
  outcome as the forced stop it replaces, minus the overrun.
- `accounts` stays critical: without it the engine would open sessions on each CLI's own login,
  the wrong account for a thread pinned to another. Its start now only opens the account index
  (local SQLite), so it no longer waits on any home folder (decision 7).
- Bun, which releases ship, carries the scope into an uncaught exception's monitor but not into
  an `unhandledRejection` listener. There a rejection nobody caught is not attributed and safe
  mode can't leave its service off; on Node it is. Thrown errors are attributed on both.
- Work is charged to the service whose start or listener created it. Shared machinery (worker
  threads, idle-worker timers, the probe thread) is made in no service's context, and the probe
  thread handles each reply in the context of the caller that asked
  (`@ace/provider-kit/unscoped`), so a crash there is never charged to whoever first started it.
- The supervisor only asks for safe mode after fast failures (under 60 s). A service that
  crashes the daemon later in each run is recorded, but nothing leaves it off yet.

## Tests

- `apps/daemon/src/services/startup-resilience.test.ts`: a start that never returns degrades
  alone; an essential failure still stops startup; retries recover a service and its
  dependents, stop after the last delay, and never stack on a stuck attempt; shutdown ends within
  one budget despite a dependent that never closes; safe mode leaves off the stuck service, never
  the essential one.
- `apps/daemon/src/services/provider-activation.test.ts`: the engine stays `starting` and
  sessions wait while a CLI never answers; adapters registered before a failure are still
  bound; skill folders are recorded before binding.
- `apps/daemon/src/engine-startup.process.test.ts`: the real daemon publishes its endpoint while
  a provider CLI hangs.
- `apps/daemon/src/daemon-lock.process.test.ts`: a killed lock holder leaves the lock free.
- `packages/accounts/src/home-checks.process.test.ts` and
  `apps/daemon/src/account-home-stall.process.test.ts`: with one account folder that never
  answers, the daemon listens, other accounts' threads run, that account reads as checking, its
  thread waits (and says so), then runs on it once the folder answers; a session that waits too
  long fails with the reason; a pick by limits waits for every candidate.
- `apps/daemon/src/service-crashes.test.ts`, `service-crashes.process.test.ts` and
  `services/startup-resilience.test.ts`: work a service leaves running is charged to it; a
  service whose background work throws (on Node, or rejects) after listening, twice, is left
  off by the next safe-mode start, never a critical one.
- `apps/desktop/src/main/daemon/exit-policy.test.ts` and `supervisor-safe-mode.test.ts`: when
  safe mode starts, when it ends, and what the person reads.
