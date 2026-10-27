# Thread-open watchdog regression, 2026-10-27

PR #1481 introduced a render feedback loop in the New thread toolbar button.
`InboxView.swift:227` supplied `startNewThread` as a new closure each time its
thread-page builder ran. `ThreadView` read that closure from the environment and
passed it into its toolbar. Toolbar environment/layout resolution repeatedly
invalidated the page. SwiftUI's Changed Body Properties log reported
`ThreadView: _startNewThread changed.` on every pass, including while idle.

The main thread consumed one CPU core in SwiftUI graph/layout/environment updates.
This prevented bridge patches and scene updates from being serviced, explaining
both the persistent skeleton and background watchdog termination. The failure is
independent of thread history size. A fixture using the shipping inbox and thread
navigation reproduces it without a real daemon or provider processes.

The fix passes the existing New thread presentation binding through the environment
instead. The button writes that binding to open the same sheet. Permission-based
button visibility, glass, menus and the composer remain intact.

## Evidence and scope

The four supplied afternoon reports are FRONTBOARD `0x8BADF00D` kills: two scene
updates exceeded ten seconds, two process exits exceeded five seconds. Their
JavaScript threads were waiting in their run loops while the main thread was in
SwiftUI. The matching Debug dylib remains in `/tmp/ace-iphone-main/apps/ios/.build/`:
UUID `0D370381-B06F-3D03-B4DF-59630AFDCE5D`. No dSYM was found there. `atos` resolves
the app frames from that binary, but the watchdog main stacks contain only the app
entry frames below system layout code, so they alone do not locate the source bug.

The older 12:04 SIGABRT has a different binary UUID and a UIKit background snapshot
assertion on a cooperative executor. It is not evidence that this change resolves
that separate abort. A matching binary/dSYM and the exception reason would be
needed to investigate it separately.

Crash metadata reports iPhone17,2 on iOS 27.0.1. Reproduction used an isolated
simulator on iOS 27.0. No build was installed on a physical phone.

Against the owner's daemon 0.0.12 over Tailscale, a read-only pairing loaded the long
originating iOS thread in 477 ms, painted in 652 ms and remained responsive.
Temporarily rendering writable controls locally, with the daemon grant still
read-only, reproduced the loop. The binding fix made that same check pass.
All temporary overrides and logging were removed. No messages were sent and no
agents or provider CLIs were started.

The audit found no initial-readiness dependency on `turn.steps` or `native.message`.
Those reads are on demand; SDK requests have deadlines, and follow-up settings have
a one-second fallback. The ledger and anchored positions contain no network waits.

## Focused verification

Use one simulator and `-jobs 4`, with `-parallel-testing-enabled NO` for tests.
Start `ACE_IOS_SPIKE_PORT=18941 bun scripts/spike-daemon.ts` from `apps/ios`, then run
`AceUITests/ThreadUITests/testThreadLoadsAndNewThreadOpensAfterBackgrounding` with
`TEST_RUNNER_ACE_IOS_SPIKE_PORT=18941`. It must reach Ready, survive a scene update,
and open New thread from the thread toolbar without submitting anything.

For opt-in real-data verification, provide a fresh read-only pairing link through
`TEST_RUNNER_ACE_PAIR_LINK` and optionally select a thread with
`TEST_RUNNER_ACE_PAIR_THREAD`. Run `AceUITests/RealDaemonPairUITests` on an isolated,
unpaired simulator. Pairing material and xcresult captures remain local.

The regression test froze the original app at a full CPU core. After 108 seconds,
terminating the unresponsive simulator app unblocked XCTest, which reported a lost
application connection and failed the test. With the fix it passed in 14.205
seconds, including opening the New thread sheet. The test now has a 60-second
execution allowance to bound future hangs.

Final Debug simulator build, file-size check and documentation formatting passed.
The final read-only real-daemon pairing/thread/scene-update check passed in 27.503
seconds against daemon 0.0.12 over Tailscale.
The focused bridge tests for thread sessions, native ledgers and native thread
indexes passed, 25 tests. The full suite and recorder were not run.

## Device verification

After the owner installs the fixed build, open several threads, including a long
one. Each must replace its skeleton with messages, remain scrollable and keep the
sidebar usable. Background and reopen the app, then tap the thread's New thread
button: the sheet must open. Dismiss it without sending.

If a hang remains, capture a Time Profiler trace beginning before the thread tap
and continuing for 10–15 seconds into the freeze, with the main-thread call tree and
SwiftUI body/environment invalidations. Also collect `app.ace.ios` launch/perf logs
with `-ace-host-trace` enabled, the exact app binary UUID and matching dSYM. These
separate failure to receive `thread.ready` from a main-thread rendering loop.
