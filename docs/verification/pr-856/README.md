# PR 856 review

The review includes the transcript changes and the steering / switch-preference changes
stacked from PRs 845 and 846. Implementations remain ace-owned under ADR 0001.

## Findings corrected

- **History retention:** removing the page capacity made history grow without a bound, while
  the next live delivery still trimmed it to 200 items. A delta or progress delivery could
  therefore remove the history being read. The transcript now pages with the existing
  independent, bounded history window; its live subscription remains intact. Sliding older
  recomputes overlap, so the UI exposes a gap instead of connecting nonadjacent history.
- **Prefetch:** `getVirtualItems()` includes the retained jump target, even offscreen. Reading
  its first entry as the viewport position could load older history during unrelated
  scrolling. Prefetch now uses the visible range and requires upward scroll intent for
  each read. Replies, failed reads and short tool-heavy windows cannot repeatedly load
  themselves. The existing newer-direction travel threshold is retained.
- **Live title:** the newest tool can finish before an earlier parallel tool. The title now
  selects the newest unfinished step, and approval waits say “Waiting for your approval”.
  Expanding a mixed group preserves its reasoning rows.

## t3code comparison

Read-only reference: the public timeline interface in
[t3code MessagesTimeline.tsx](https://github.com/pingdotgg/t3code/blob/bb4e4e7eca1d0de27efbc9fb9eab69e5463b9374/apps/web/src/components/chat/MessagesTimeline.tsx).
No implementation was copied or adapted.

| Concern          | t3code interface                                                                                         | ace decision                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| History          | `MessagesTimelineHistoryControls` separates availability, loading, errors and an earlier-history action. | Keep these states explicit; reuse ace's bounded bidirectional window instead of growing the live store. |
| Reading position | `liveFollowEnabled`, manual navigation and anchor callbacks are separate inputs.                         | Keep history scrolling separate from following the live tail; only reader input triggers prefetch.      |
| Waiting          | `awaitingUser` is separate from working and active-turn flags.                                           | Preserve daemon-derived whole-tree status and label an approval-gated group as waiting.                 |

These are interface comparisons, not claims about t3code's memory bounds or performance.
ace's independent history window remains governed by ADRs 0056 and 0062.

## Verification

Public behavior regressions cover bounded paging through new live deliveries, detaching
and rejoining the live tail, expansion of thought/tool groups, parallel tool completion,
approval waits, and settling back to the group summary. Existing transcript, long-thread,
steering, Git preparation and switch-preference suites were also exercised.

A real Chromium session against the in-page fake daemon checked upward-scroll history
prefetch and Jump to live after new output. No provider CLI or subscription quota was used.
The collapsed title fits all four widths; [measured bounds](geometry.json) accompany captures.

| Width | Light                        | Dark                        |
| ----- | ---------------------------- | --------------------------- |
| 390   | [Screenshot](light-390.png)  | [Screenshot](dark-390.png)  |
| 768   | [Screenshot](light-768.png)  | [Screenshot](dark-768.png)  |
| 1440  | [Screenshot](light-1440.png) | [Screenshot](dark-1440.png) |
| 1920  | [Screenshot](light-1920.png) | [Screenshot](dark-1920.png) |

Formatting, protocol generation, lint, source size, UI values, dependency checks and
TypeScript passed. Dependency-cruiser emits its existing TypeScript 7 compatibility warning.

The full `bun run check` attempt hit UI failures and was stopped; a lower-concurrency
restart was also stopped after confirming a baseline blocker. The dialog Escape regression
in `apps/web/src/components/ui/overlay-behavior.test.tsx` fails on both the corrected branch
and the original PR head `9b5cf9fbb`: the Rename dialog remains open after Escape. That
isolated baseline run used the original source and the same installed dependency versions.
The dialog code is outside this change. This PR does **not** have a green repository gate.

The forge stack and hosted-repository suites passed on rerun. Creation recovery, fork
lineage and handoff refusal passed with one worker and a 60-second test deadline, without
changing their assertions. These reruns do not replace a passing full check. Issue 849's
body-height reservation work remains separate.

`bun run check:perf` stops in the daemon idle-import guard because `imports.log` is
missing (`ENOENT`). Running `node apps/daemon/bench/idle-imports.ts` on the original PR
head reproduces that error too. The separate web static-performance check also fails its
bundle budgets: initial JS is 319.20 KB (limit 270), CSS 25.10 KB (21), the largest first
screen 621.60 KB (405), and the thread route 235.47 KB (138). The client and machine workers
also exceed their budgets. Bundle sizes here describe the corrected branch; no baseline
bundle comparison or passing soak/timing qualification is claimed.
