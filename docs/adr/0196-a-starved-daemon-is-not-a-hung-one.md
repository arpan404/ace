# 0196: A starved daemon is not a hung one

Status: accepted. Date: 2026-11-19. Decided by: the owner (the incident and the fix asked for),
the build of this ADR's PR (how). Amends the desktop supervisor's health and restart rules from
[ADR 0186](0186-the-daemon-outlives-the-app.md) and the service startup deadline of
[ADR 0175](0175-the-daemon-always-comes-up.md).

## Context

On the owner's Linux machine about eight agent sessions drove the load to 70–108 with all memory
used and zram swapping. The daemon's event loop went silent for 3–35 s at a time. Its own stall
watchdog logged `cpuMs: 107` over `silentMs: 38911`: the process got no CPU, it was not stuck.

The desktop supervisor could not tell the difference. Three missed health checks (10 s each)
and it stopped the daemon, then SIGKILLed it. The restart then failed on the same machine:
`Service engine startup exceeded 15000ms` (exit 1), then `database is locked` at store open (a
fatal exit), then two more stops as `not-ready` while it was still starting. Every stop
interrupted every agent thread and made the fleet see the machine as unreachable for 45–80 s.
The daemon's attempt to raise itself to nice -7 failed with EACCES, as it does for any ordinary
Linux user, and the agents' builds ran at the daemon's own priority.

## Decision

1. **Missed health checks are judged before the daemon is stopped.** After the usual missed
   checks the supervisor reads the machine's pressure and the daemon's own stall report, and
   decides with one pure function (`apps/desktop/src/main/daemon/grace.ts`, `healthVerdict`):
   - Pressure is Linux PSI (`/proc/pressure/{cpu,memory,io}`) and load average per CPU, macOS's
     memory pressure level (`kern.memorystatus_vm_pressure_level`) and load average, and free
     memory on Windows (`@ace/diagnostics/pressure`). It is read only when a decision needs it.
   - The stall report is the file the daemon's watchdog thread already writes while a stall
     lasts (`ACE_HOME/logs/stall-<pid>.json`). It is now rewritten every 2 s during a stall, so it
     is a live signal: CPU used well under the silence, with the watchdog itself running late or
     the machine under pressure, is *starved*. CPU close to the silence is *busy*.
   - Starved, or on a machine under heavy pressure: the daemon stays running (its clients and
     agents carry on) and is checked again for a grace of 15 s that doubles each time, up to two
     minutes per grace. An answer resets it.
   - Silent with CPU to spare (busy or blocked on a calm machine), or silent for five minutes in
     all, it is stopped as before.
   Each decision is logged with its numbers: load, PSI or memory level, the stall's `silentMs`,
   `cpuMs` and `watchdogLateMs`, and the grace given.
2. **A start is not stopped while it gets somewhere.** Past the ready budget (120 s) the
   supervisor looks for progress: the size and time of the daemon's `logs/ace.jsonl`,
   `startup-attempts.json` and its stall report. A start that progressed, or one on an
   overloaded machine, gets another 60 s, up to 15 minutes in all. A quiet start on a calm
   machine is stopped as `not-ready` as before.
3. **Restarts back off further under pressure.** On an overloaded machine the wait before a
   restart is at least 5 s, doubling to two minutes, instead of the 0.5 s crash backoff.
4. **The daemon's own startup is load-aware.** It reads the machine's pressure while its store
   opens. Under heavy pressure each service gets four times the 15 s startup deadline.
5. **A busy store at open is waited out.** `database is locked` (SQLITE_BUSY or SQLITE_LOCKED) when
   the event store opens is retried with backoff for about a minute (`apps/daemon/src/busy-open.ts`)
   before the start fails. What a killed daemon left behind lets go once it is gone.
6. **No privileged priority attempt.** On Linux the daemon asks for nice -7 only when
   `/proc/self/status` shows CAP_SYS_NICE or `/proc/self/limits` an RLIMIT_NICE that allows it.
   Otherwise it does not ask, and says so once at info.
7. **Agent work runs below the daemon.** Every child started through provider-kit's supervised
   spawn (provider CLIs, git, gh, toolchains) is lowered right after spawn: nice 5 on Linux,
   macOS and the BSDs (each existing thread on Linux, where nice is per thread), BELOW_NORMAL on
   Windows. What they start inherits it. Lowering one's own child needs no privilege. The pid,
   process group and spawn errors are unchanged: no wrapper command is involved, so a missing
   CLI still fails as ENOENT.

## Consequences

- A daemon on an overloaded machine stays up, and its agents keep running. A genuinely hung one
  is stopped after the usual 45 s on a calm machine, and after at most five minutes otherwise.
- The desktop shows the daemon as running during a grace. Clients see a slow daemon, not a
  missing one.
- The stall watchdog writes a small file every 2 s while a stall lasts, and its report is also
  written for a short stall during the look cooldown.
- Agents' builds get less CPU than the daemon under contention, and a little less than they would
  have alongside other user work. They are not otherwise throttled. macOS's `taskpolicy -b`
  (background QoS: efficiency cores, throttled I/O) was rejected as too slow for builds.

## Proposed, not built: a systemd scope for agent work

On Linux with a systemd user session, provider CLIs could run inside
`systemd-run --user --scope --slice=ace-agents.slice -p CPUWeight=50 -p IOWeight=50 -p MemoryHigh=…`,
so the kernel's cgroup controller (not just nice) holds agent work back on CPU, I/O and memory,
and memory pressure from builds reclaims there before it touches the daemon. It was left out
here because a scope runs the command through `systemd-run`: a spawn of a missing CLI no longer
fails as ENOENT, each spawn waits on a D-Bus round trip to the user manager, and the process
inventory and group stop would need checking against the extra parent. It should be built as a
pure "how to launch a child" decision (scope, nice or plain) with its own probe that systemd and
the user manager answer, and fall back to the nice of point 7 when they do not.
