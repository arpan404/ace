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
