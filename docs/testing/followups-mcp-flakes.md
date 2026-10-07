# MCP discovery and loaded-host reliability

The daemon advertises ace instructions through MCP initialize and current server
discovery. `ace_status` and the authenticated `ace://status` resource share the same
live result: caller thread/agent, effective ace permission mode, and tool-group
availability. The result contains no session secret, filesystem path, provider
credential, or transcript. A null mode means the standalone MCP host has no policy
reader. Daemon hosts supply the engine's effective mode.

Availability combines registered toolkits, the provider lease's capabilities and
live feature switches. Disabled screen and device tools stay discoverable when the
lease permits them; their descriptions explain the human enablement step. Status
does not enable features or grant app/device access. Files have no standalone MCP
group yet; status explains their provider-workspace and client entry points.

## Races found

- File, plugin and relay attachment readers assumed the next socket frame was the
  reply. Model catalog pushes may arrive between any request and its reply. Those
  readers now ignore catalog pushes; browser test support follows the shared socket
  helper's opt-in convention. Remote tests already use that shared helper. The
  dedicated device relay channel has no catalog subscription.
- The web harness transformed deferred components inside its first test. Under
  contention, that test timed out, and its unfinished mount could race cleanup and
  the next test. Deferred components now load at test-module evaluation. Workspace
  metadata and each tab body load separately, so both are warmed before tests.
- Activity asserted an array captured from a partial render, and compared rounded
  ages. It now reads both columns until all six cards and the fixture's actual
  chronological order appear. Lightbox teardown awaits focus restoration as well
  as dialog removal.
- After abrupt daemon exit, Chromium's browser parent could exit while its network
  helper survived. After graceful close, a surviving helper could still write into
  a profile during removal. On POSIX the default launcher now owns an IPC guardian
  before launch. EOF rechecks the exact private profile, kills its remaining process
  groups through the existing Chromium killer, and observes kernel exit before
  releasing cleanup. The regression fixture also starts a detached profile helper
  that survives pipe EOF deterministically, so both signals must clean it up.
  No polling runs while the daemon is alive. Windows retains
  the existing taskkill cleanup; abrupt Windows ownership was not verified here.

## Daemon throughput qualification

`apps/daemon/bench/check.ts` gates the metric from `measure.ts`: 1,000 scripted
provider events, persisted to SQLite and received through a real WebSocket. The
floor remains **300 events/s**, with the existing workload, memory ceilings,
delivery p99 limit and per-attempt deadlines unchanged. Wall time includes fsync,
filesystem scheduling and delivery; replacing it with process CPU time would
exclude part of the behavior the budget protects.

Like the device bench, the daemon gate now requires an idle host. It explicitly
reports timing as deferred at a one-minute host load of **8 or greater**, including
moderate load around 10 that produced the reported failures. Eight is a conservative
qualification threshold below that observed failure range, not a new throughput
budget. It is checked before the workload and after measurement. Import checks
still run on busy hosts. If load rises during a completed measurement, resource
violations and measurement deadlines still fail; timing requires another idle-host
run. A deferred run is not evidence that the performance budget passed.

## Validation

Each Vitest invocation selects one file. CPU contention used eight temporary
Python workers doing arithmetic, alongside independent web/process invocations.
Before the fixes this reproduced file-message decoding failures, first-test web
timeouts, Devices/Preview lazy-body delays, a SIGKILL ownership timeout and a
SIGTERM profile-removal race. Fixtures used isolated homes, fake providers and
private Chromium profiles, never the personal profile or live ace home.

The targeted passing results and static checks are recorded in the PR. Full-suite
verification remains the orchestrator's merge gate. `check:perf` was not run because
host load exceeded the owner's limit of 15; idle-host timing qualification remains
required. No retries or skips were added to tests and no performance budget was
raised.
