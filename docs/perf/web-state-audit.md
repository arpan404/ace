# Web state and render audit

Date: 2026-10-28

## Scope

The initial static scan covered 1,725 production TypeScript files in `apps/web/src`
and `packages/client-react/src`, finding 1,016 direct `useState(...)` calls before
these changes. It excludes tests, generated routes, qualified hook calls and
custom hooks that encapsulate state. Hook counts are an inventory, not a measure
of wasted work.

The review traced effect-only setters, context consumers, clocks, selector
subscriptions and transcript rendering. No app-wide CPU or frame-time speedup is
claimed.

## Changes

| Problem                                                                                           | Result                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage and workspace readers subscribed to the entire shell context.                             | A separate stable services context prevents palette, sidebar and composer-action updates from waking these readers. Transcript scroll memory and visualization height caches use it too.                           |
| Highlight completion copied its result through a second state value in an effect.                 | One highlighting hook stores the completed result and retained rich lines together. Cache hits retain their colors before commit. Late replies cannot overwrite the current source.                                |
| Opening one disclosure copied the entire open-state map and changed the context for every reader. | A stable per-log store updates one key and notifies its subscribers. Groups subscribe to their own key and child keys. Explicit group choices still override opened children, and opened steps survive regrouping. |
| Device leases, recent-use ages and recording elapsed time owned private wall-clock timers.        | They use the shared second/minute clocks, which stop while the page is hidden and catch up when shown. Every recording starts at zero.                                                                             |
| Stream statistics owned another second timer.                                                     | The shared ticker schedules sampling. A precise injected wall clock still timestamps frames and samples, preserving the meter's millisecond timing.                                                                |
| Browser touch detection duplicated media-query state and an effect.                               | It uses the existing media-query external store.                                                                                                                                                                   |
| The browser device stage created fresh size objects for equal resize observations.                | Browser and device stages share `lib/client-size.ts`. Equal dimensions return before scheduling state updates. Client dimensions are preserved; bounding-rect and window-fallback sizing remain separate.          |

The shell's services still live for its provider's lifetime, and storage remains
optional outside it. User drafts, selections, delayed status, worker results and
DOM measurements retain the state needed to render their behavior. No general
memoization layer was added.

## Session channels

The device and computer-use session hooks were evaluated but retain their original
lease bridge. An experimental external-store adapter changed mount/hidden-view
ordering and failed the Recent-device boot regression. It was removed. Reducing
state here requires a channel ownership design that preserves effect ordering;
there is no verified optimization to ship in that path yet.

## Regression evidence

- Shell changes leave storage and workspace render counts unchanged; workspace
  width changes still update their reader.
- Opening a disclosure leaves an unrelated step's render count unchanged. Groups
  follow their child IDs after regrouping, and explicit group choices persist.
- Highlight completion commits once. Cache hits retain the right colors while a
  new source is pending, and stale worker replies cannot replace them.
- Recording tests cover starting again after a long idle period, no updates while
  hidden, and catching up after visibility returns.
- Equal client-size observations do not rerender; changed dimensions update.

## Repository gate limits

The earlier full repository check reported these six failures. Each reproduced on
unchanged base commit `845a9ed03` in a temporary checkout. The queue baseline used
an expanded Vite filesystem allowlist for the shared installed dependencies, with
unchanged application source. That full run was interrupted after the baseline
comparison. These failures are outside the optimization changes.

| Baseline failure                                   | Observed result                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/fake-daemon/src/long-thread.test.ts`     | Catch-up reports two agents where three are expected.                           |
| `packages/fake-daemon/src/client-protocol.test.ts` | Editor discovery includes `fileManager: "Finder"` beyond the expected response. |
| `packages/fake-daemon/src/home-list.test.ts`       | Home-list playback differs from the expected state.                             |
| `packages/adapter-codex/src/fixtures.test.ts`      | Subagent fixture status is waiting where working is expected.                   |
| `apps/ios/bridge/checkout-transfers.test.ts`       | Archive transfer times out waiting for the bridge.                              |
| `apps/web/src/features/thread/queue.test.tsx`      | Refused edit does not show the expected alert dialog.                           |

The full repository gate has not passed. Dependency-cruiser also warns about
TypeScript 7 compiler support; it is configured to parse imports with SWC.

## Optimization validation

- Focused run: 44 files, 255 tests passed. After the precise sampling change,
  the device catalog, recording and clock suites passed again, 27 tests. The
  additional fractional-timestamp clock regression also passed.
- Browser smoke check: thread view loaded, command palette opened and closed.
- Client-store soak passed after 3,050,004 events. Its retained window stayed at
  200 items; heap fell from 55.6 MB to 52.2 MB. This exercises client stores, not
  browser frame-time performance.
- Bundle budgets remain exceeded on both the base and this work. No limits were
  increased. Values below are the tool's compressed KB measurements.

| Budget                          |   Base | Optimized | Limit |
| ------------------------------- | -----: | --------: | ----: |
| First thread screen             | 682.18 |    682.47 |   680 |
| Thread route                    | 352.12 |    352.30 |   345 |
| Client worker with lazy chunks  | 102.24 |    102.24 |   102 |
| Machine worker with lazy chunks | 102.15 |    102.15 |   102 |

The context and subscription changes trade a small amount of bundle code for
fewer UI updates. These measurements do not establish an app-wide speedup.

The latest `bun run check` passed formatting, protocol generation, lint, size,
generated assets, UI-value checks, dependency boundaries and incremental
typechecking. It then reproduced the existing fake-daemon catch-up and editor
response failures listed above. The remaining suite was interrupted at that point;
the full gate remains blocked. The complete performance script also remains
unverified; bundle and client-store soak were run separately as described above.
