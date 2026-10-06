# Browser parity review regressions (PR #153)

The owner requires tests to run only at merge. No tests, probes, mutations,
flakiness runs or benchmarks were executed during these review fixes. Regression
tests were written before their blocker fixes. The failure traces below are
static reasoning from the previous code, not observed execution results. Every
runtime claim **needs run at merge**.

## Blocking regressions

| Review item                | Public behavior scenario and expected result                                                                                                                                                                                                                            | Regression test                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable download approval | Complete one plain same-URL download, deny the second: only one artifact. A preceding attachment-like fetch cannot grant the later download. Previously URL credits bypassed the second approval.                                                                       | `packages/browser/src/parity.process.test.ts`: “each same-URL download needs its own approval”; “attachment-like reads cannot authorize a later download”                    |
| Connected private crash    | Take over privately while the socket stays connected, terminate the daemon with SIGKILL/SIGTERM, restart and reopen its persistent browser: private/paused until explicit handback. Previously only disconnect persisted the gate.                                      | `apps/daemon/src/browser-private-crash.process.test.ts`; `browser-private-recovery.process.test.ts` also reconstructs real SQLite/service state without manufacturing a gate |
| Delayed private capture    | Hold a tab seed screenshot across private takeover/handback, or deliver a screencast with a private-period capture timestamp after handback: its pixels never reach recording files; a fresh public frame does. Previously current-mode checks admitted delayed pixels. | `packages/browser/src/session-races.process.test.ts`: “a delayed %s captured during private control never enters the recording after handback”                               |
| Cross-tab dialog queue     | Evaluate a prompt on A, request a read on B, answer A: the read surfaces A's dialog and the answer completes; both pages remain usable. Previously the read switched to B and waited on A ahead of the answer.                                                          | `packages/browser/src/parity.process.test.ts`: “a dialog on A can be answered after a read targets B”                                                                        |
| Lease dispatch gaps        | Take over/hand back during capture preparation or each emulation await: reject stale work before any subsequent input effect; a fresh retry succeeds. Previously scroll/resize/emulation continued.                                                                     | `packages/browser/src/session-races.process.test.ts`: scroll/resize and resize/metrics/touch barriers                                                                        |
| Evaluate cancellation      | Abort an evaluate while its engine host interaction waits: expire it, refuse late allow, release the browser queue. Previously the command signal did not reach the interaction.                                                                                        | `apps/daemon/src/browser-approval-races.process.test.ts`: “canceling evaluate expires its host interaction and releases the browser queue”                                   |
| Approval shutdown race     | Hold authority lookup, shut down or abort, then release it: no interaction or retained deadline is created. Previously opening resumed after shutdown.                                                                                                                  | `apps/daemon/src/browser-approval-races.process.test.ts`: “%s during authority lookup cannot open a late approval”                                                           |

## Mutation coverage

Each case below is **not executed (tests run at merge)**. “Designed to kill” means
the stated observable assertion would fail if the mutation restored the reviewed
behavior; it is not a claim of a measured mutation score.

| Mutation case                                   | Test designed to kill it                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove thread tab cap                           | parity: background tabs reject ninth tab                                                                                                                                                             |
| Remove daemon tab cap                           | parity: second thread rejects admission at shared cap; closing releases it                                                                                                                           |
| Reuse active page for new tab                   | parity: typed input survives switching and the new tab starts empty                                                                                                                                  |
| Suppress popup enrollment                       | parity: popup increases tab list to three                                                                                                                                                            |
| Share persistent profiles                       | lifecycle: persistent thread storage remains isolated between parallel threads                                                                                                                       |
| Remove download byte limit                      | parity: oversized download never publishes an artifact                                                                                                                                               |
| Publish canceled download                       | parity: controlled HTTP completion after private takeover leaves no artifact/path                                                                                                                    |
| Reuse download approval                         | parity: repeated same-URL and attachment-like preview cases                                                                                                                                          |
| Allow outside or symlink uploads                | parity: both outside physical path and workspace symlink are refused                                                                                                                                 |
| Ignore checkbox desired state                   | parity: repeated check stays checked; repeated uncheck stays unchecked                                                                                                                               |
| Remove frame coordinate offset                  | parity: same/cross-origin frame buttons and inputs change their own elements                                                                                                                         |
| Ignore role/name filter                         | parity: find returns only the two matching frame buttons                                                                                                                                             |
| Auto-dismiss prompt                             | parity: explicit pending prompt is answered and sets the page's answer                                                                                                                               |
| Block dialog answers behind a cross-tab wait    | parity: dialog A/read B/answer A sequence completes                                                                                                                                                  |
| Disable throwOnSideEffect                       | parity: isolated read succeeds; mutation/navigation/POST reject and body, URL and server write count stay unchanged                                                                                  |
| Let a site grant permit unrestricted JavaScript | daemon browser-approvals: restored read-only site grant still asks for unrestricted evaluation                                                                                                       |
| Ignore grant revocation                         | daemon browser-approvals: revoke empties list and expires pending evaluation                                                                                                                         |
| Remove body redaction                           | inspection: secret value absent, safe marker retained                                                                                                                                                |
| Remove body or retention limits                 | inspection: 300 KiB response refused, older body/log entries evicted after 205 responses, return limit honored; inspection-limits: underestimated byte lengths and base64/unicode data still bounded |
| Remove private read epoch                       | ref-dispatch: interrupted snapshot/screenshot/recording remains forbidden after handback                                                                                                             |
| Omit durable takeover or capture epoch          | daemon private-crash/private-recovery; session-races delayed seed/screencast files                                                                                                                   |
| Omit post-await lease checks                    | session-races capture preparation and all three emulation barriers                                                                                                                                   |
| Drop cancellation or shutdown fencing           | daemon browser-approval-races command cancellation, authority lookup and injected deadline cases                                                                                                     |

Additional behavior tests cover iframe detachment rejecting an outstanding public
snapshot while its parent remains usable, and the injected 60-second approval
expiry refusing a late allow. Fake-daemon tests use the typed client API and the
same private ownership timing, cross-tab dialogs and one-shot wire results.

## Static checks and performance evidence

Use only the owner's permitted static checks during development. Chromium tests
use isolated temporary profiles and can skip when no explicit executable is
available; the package's owned-Chromium integration remains the required real
edge at merge. Timeouts are deadlock ceilings, not performance measurements.

Historical measurements from the pre-review implementation: idle RSS 215.1 MiB
against a 256 MiB cap, startup 815 ms, throughput 380.95 events/s, p99 5.86 ms,
shutdown 110 ms, no budget violations, startup module-load guards passed in main
and workers. These figures were not rerun or independently reproduced for the
review-fix commits. Current performance, memory, serial Chromium behavior and
mutation outcomes **need run at merge**.
