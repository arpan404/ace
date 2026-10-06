# Browser panel sandbox regression pass

This change was originally stacked on #163, which is now merged into main. That fix preserves `auto`, allowing the desktop
backend to be selected. This pass supplies native control parity and corrects
placement and input after selection.

## Root causes and changes

| Bug                                             | Cause                                                                                                                                                | Change                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Stale bounds while a panel moves                | Resize/Intersection observers do not report every position change or transition                                                                      | Measure the displayed page each animation frame; deduplicate placement IPC; hide on unmount or Activity suspension |
| Address suggestions covered by the native page  | Overlay detection examined portals only                                                                                                              | Include marked inline suggestions and errors in intersection checks                                                |
| Page clipped after resize or zoom               | A fixed CDP metrics override outlived placement                                                                                                      | Fit mode follows native content bounds and clears fixed overrides; account for renderer zoom                       |
| Distorted device emulation                      | Width and height were clamped independently, and native placement discarded mobile/DPR metadata                                                      | Fit both dimensions with one aspect-preserving scale and retain the emulated viewport, mobile mode and DPR         |
| Native tabs and popups absent                   | Embedded backend exposed one primary page and denied `window.open`                                                                                   | Bounded native tab group, per-tab CDP/origin guards, managed popup tabs and active-target capture                  |
| Forms lost on Back/Forward                      | Toolbar replayed URLs instead of traversing document history                                                                                         | Use Chromium navigation history and real reload                                                                    |
| Find control absent                             | No panel command or UI                                                                                                                               | Add native Electron find and headless text selection with panel controls                                           |
| Dialogs unavailable                             | Native dialogs were dismissed; Electron lacks prompt                                                                                                 | Scoped primitive-only preload bridges page dialogs to daemon-owned answers                                         |
| Downloads refused                               | Embedded hook denied every native download                                                                                                           | Pause native transfers until shared origin/download consent, then publish bounded quarantined artifacts            |
| Editing and app shortcuts failed in fallback    | Key releases/modifiers and Mac editor commands were dropped, pointer input did not focus the pane, and all keys were prevented before window hotkeys | Forward complete key events, focus on pointer-down, preserve configured app chords                                 |
| Another device appeared to control this client  | UI used the generic human-controller flag                                                                                                            | Require this connection's lease for interactive input and takeover controls                                        |
| Persistent native threads shared storage        | Embedded still used ADR 0054's workspace partition after ADR 0067 made profiles thread-scoped                                                        | Scope persistent partitions to workspace/thread, matching headless isolation                                       |
| Browser keys reached the composer               | Returning native focus to the renderer left its old DOM focus in the composer                                                                        | Deliver typed, thread-scoped toolbar shortcut events directly to the browser controls                              |
| Page-size menu kept the page hidden             | Size radio items did not dismiss the covering menu                                                                                                   | Close after selecting a size and save it only after successful emulation                                           |
| Recording could not stop after private takeover | Stop used the agent privacy check even for the human connection                                                                                      | Carry the requesting actor through stop; keep private frames and agent operations fenced                           |
| Wrong page frames after native tab switch       | Late frames lacked a target identity                                                                                                                 | Tag native frames with tab identity and discard old-target deliveries                                              |

Native pages use sandboxed, isolated Electron contexts. Each thread owns its
partition (ADR 0067 browser parity, superseding the workspace profile lease); native
tabs share only that thread's partition. The page preload
exposes dialog primitives, never the desktop application's bridge. Iframe preloads
require Electron's subframe-preload setting; the preload refuses to run without
the OS sandbox, and tests verify that pages and frames have no Node `require`. Native input
still requires the registered daemon lease and the displaying renderer's claim.

## Reproduction

The two desktop e2e files create a temporary ace home, real daemon, packaged-like
Electron layout and production renderer. The fallback file also opens the web UI
in an independent fresh Chromium context at DPR 2. HTTP fixture pages are served
on localhost and include animation, long scroll, forms, canvas-fed video,
iframes, popups, downloads and dialogs. All sandbox resources close on success
or failure. No installed application, owner home or personal profile is used.

Run serially from `apps/desktop`:

```sh
ACE_E2E_ELECTRON=1 GOMAXPROCS=1 bun x vitest run --config vitest.e2e.config.ts e2e/browser-panel.e2e.ts e2e/browser-fallback.e2e.ts --no-file-parallelism --maxWorkers=1
```

Core/React regressions run from the repository root:

```sh
bun run test packages/browser/src/page-controls.process.test.ts apps/web/src/features/panels/browser/parity.test.tsx apps/web/src/features/panels/browser/native-view.test.tsx --no-file-parallelism --maxWorkers=1 --testTimeout=30000
```

## Original branch verification results

All 27 touched core/React tests and both desktop/web e2e scenarios passed, run
serially. Native coverage includes main/same-origin/cross-origin frame dialogs,
video and scroll, address/autocomplete, history with form restoration, tab and
popup lifecycle, downloads, takeover/handback, recording, clipboard and external
routing. Geometry coverage includes splitter drag, panel toggles, sidebar collapse,
full view, window resize, renderer zoom (DPR 2.4), and iPhone/laptop emulation
(DPR 3/1). Separate persistent threads retain separate cookies.

Formatting, lint, typecheck, size, UI, dependency and protocol checks pass. The web
bundle passes: initial JS 271.0 KB against 272 KB, CSS 20.7 KB against 21 KB,
and heaviest first screen 394.2 KB against 405 KB; worker budgets pass.

## Main integration revision

Merged `origin/main` at `77338ea8` after #163 and #160 landed. The input-type
import and shared frame-discovery helper remain alongside main's DPR capture
hook and headless sizing. The regenerated protocol includes both browser control
commands and delegation error schemas. Main's dependency/export changes are
retained and `bun install` was rerun. Browser access uses the public protocol's
`DeviceScope` type restricted to read/operate; authorization behavior is unchanged.

This revision uses static review only. The original runtime results above do not
certify the merged head. Tests, benchmarks and full `bun run check` need run at
merge under the owner's current rule. No integration-rehearsal comment was
present on #168 when issue comments, review comments and reviews were read.

Existing behavior tests guard the preserved paths. The mutation cases below are
not executed (tests run at merge):

| Regression coverage                                              | Mutation cases it is designed to kill                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop/e2e/browser-fallback.e2e.ts`                       | Remove DPR capture demand; drop pointer focus or modifiers/key releases; stop forwarding hover; swallow app shortcuts          |
| `apps/web/src/features/panels/preview/use-capture-size.test.tsx` | Remove the capture hook or reconnect re-subscription; replace viewer DPR with 1; resize the page from a view-only subscription |
| `packages/browser/src/parity.process.test.ts`                    | Drop child frame sessions or OOPIF parent identity; route frame refs to the root target                                        |
| `packages/browser/src/adaptation.process.test.ts`                | Remove headless content resizing/DPR sizing; ignore viewer dimensions or pressure; stop frame acknowledgements                 |
| `packages/browser/src/page-controls.process.test.ts`             | Replay URLs for history; omit Mac select-all; apply agent privacy checks to human recording stop                               |

## Merge-gate follow-up

Preserved the orchestrator's merge `b54629b3`, including #161 and #162. The gate
reported two failures in `browser.test.tsx`. Its input assertion omitted the
key-up now required for complete keyboard input. Back used document history even
when a failed address had not replaced the current document, and successful
history traversal did not clear the failure UI. The fake daemon also returned
success without implementing document history or its read command.

The input test now checks both key events and their code, text and modifiers.
Back dismisses an uncommitted failed address without traversing or reloading the
retained document, even when the backend has no earlier history entry. Successful
document traversal clears the failure UI. The fake daemon implements per-tab
history through the shared pure history core and permits history reads without
a control lease. New UI regressions cover successful Back/Forward/Reload,
document preservation after a failed first address, and Back after a committed
error document. The preservation test waits for the requested viewport before
retaining the frame sequence.

Under the owner's narrow exception, only
`bunx vitest run apps/web/src/features/panels/browser/browser.test.tsx --no-file-parallelism --maxWorkers=1`
ran: all 13 tests passed. Formatting, lint and typecheck also pass. Other runtime
claims still need run at merge. Issue
comments, inline review comments and reviews contained no integration-rehearsal
findings.

Mutation cases for these regressions are not executed (tests run at merge): drop
key-up or its code/modifiers; make document history commands return success
without navigating; reload or traverse the retained document on failed-address
Back; keep Back disabled when the first attempted navigation fails; leave the
failure UI after successful document traversal; make Reload leave the frame
unchanged.

## Iframe prompt follow-up

The desktop merge gate reported that an iframe prompt received its default
`seed` instead of `iframe answer`. An isolated run reproduced the failure.
Temporary tracing showed the field edit belonged to the previous main-page
dialog, while the OK submission belonged to the newer iframe dialog. Native
IPC received `seed`; the frame bridge delivered exactly the submitted answer.

An answered prompt now disables its field and controls until authoritative
browser state removes or replaces that dialog. Submission state belongs to the
dialog ID, so a late refusal cannot unlock a newer answer. Prompt fields remount
when their dialog ID changes. Failed answers re-enable their own draft for retry.
The desktop scenario waits for each answered dialog to disappear before opening
the next; its main-page, same-origin iframe and cross-origin iframe result
assertions remain unchanged.

The two new UI regressions use explicitly resolved promises for answer replies
and rerenders for browser-state publication. They cover acknowledgment arriving
before state, a new prompt's answer, a late refusal for an old dialog, and retry
with the draft preserved. Mutation cases are not executed (tests run at merge):
re-enable an answered prompt on acknowledgment; leave its field editable during
submission; clear a newer submission on an older reply; never unlock a refused
answer; reuse the previous dialog's draft.

Only the two files authorized for this follow-up ran, serially:

- `apps/web/src/features/panels/browser/browser.test.tsx`: 15 tests passed.
- `apps/desktop/e2e/browser-panel.e2e.ts`: the complete native browser scenario
  passed with a temporary home, real daemon and localhost fixtures. The clipboard
  assertion now waits for the async write's observable result, with the exact URL
  comparison preserved.

No other tests, probes, benchmarks or CI ran. Broader runtime validation still
needs run at merge.

## Performance qualification

The host remained heavily loaded during this pass (observed one-minute load
averages above 50, with peaks above 300). The requested below-15 condition was
not met. Daemon idle-memory benchmarking and qualified native/fallback fps and
input-to-pixel latency measurements therefore remain unverified; no speed claim
is made from these runs. #163's contention captures remain in
`docs/perf/browser-panel/` and are not measurements of this change.

After load drops below 15, run `node apps/daemon/bench/check.ts` and the local
animation capture bench `node packages/browser/bench/crisp.ts`. Physical monitor
migration also needs a desktop with multiple displays; sandbox window resize,
renderer zoom and forced DPR 2 do not establish that hardware result.
