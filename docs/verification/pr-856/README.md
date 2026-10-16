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
in `apps/web/src/components/ui/overlay-behavior.test.tsx` (the Rename dialog stayed open
after Escape) is fixed by letting a tooltip's Escape propagate to the dialog containing
its trigger (`apps/web/src/components/ui/tooltip.tsx`); the suite passes (5 tests).
`bun run lint`, `bun run typecheck` and `bun run fmt:check` pass. This PR does **not**
have a green repository gate (bundle budgets below remain red).

The forge stack and hosted-repository suites passed on rerun. Creation recovery, fork
lineage and handoff refusal passed with one worker and a 60-second test deadline, without
changing their assertions. These reruns do not replace a passing full check. Issue 849's
body-height reservation work remains separate.

`bun run check:perf` stopped in the daemon idle-import guard because `imports.log` was
missing (`ENOENT`): the daemon can rename an unversioned data home on startup, moving the
guard's output out from under its reader. Fixed in `apps/daemon/bench/idle-imports.ts` by
keeping the guard output outside that home; `node apps/daemon/bench/idle-imports.ts` now
passes ("Idle import guard passed in the main isolate and startup workers"). The web
static-performance check still fails its bundle budgets, but a build of the merge-base
`38ee7436a` (same installed dependencies, no PR changes) fails identically, so the overage
is pre-existing on main and not caused by this PR:

| Budget                                 | This branch      | Merge-base `38ee7436a` | Limit   |
| -------------------------------------- | ---------------- | ---------------------- | ------- |
| initial JS                             | 319.22 KB        | 319.20 KB              | 270     |
| CSS                                    | 25.10 KB         | 25.10 KB               | 21      |
| first screen (shell + `_home.new.tsx`) | 621.62 KB        | 621.35 KB              | 405     |
| route `_home.new.tsx`                  | 302.40 KB        | 302.15 KB              | 138     |
| route `_home.t.$threadId.tsx`          | 235.48 KB        | 235.16 KB              | 138     |
| route agents `$agentId`                | 188.52 KB        | 188.28 KB              | 138     |
| worker client-worker (+lazy)           | 65.14 (82.81) KB | 65.14 (82.81) KB       | 60 (73) |
| worker machine-worker (+lazy)          | 65.07 (82.74) KB | 65.07 (82.74) KB       | 60 (73) |

No soak/timing qualification is claimed, and no budget number was changed (budgets change
only with a reason in ADR 0056).
