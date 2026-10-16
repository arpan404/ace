# Long transcript reproduction and validation

Base: 67fa95d4e (#887). Reproduction used the in-page fake daemon and temporary
state. No provider sessions or recorder were run.

## Confirmed behavior

Source-backed assistant messages stopped at a 4,096-character wire preview.
While streaming, the UI required waiting for completion; afterward, “Show full
answer” was required to retrieve the rest. Source-backed reasoning never fetched
its missing text. The SDK can retain a clipped tail, so preview length cannot
safely stand in for an already fetched source prefix.

Cold Markdown initialization separately hid arrived assistant text behind a
skeleton. In a browser run, thinking appeared after 30 ms but the answer remained
hidden through a five-second stream. A controlled worker-boundary test reproduces
this with a delayed real parser response.

Ordinary thinking and messages already streamed independently on the base.
Ordinary upward scrolling already loaded older transcript pages, and #886/#887
already implemented gesture-driven newer paging. Their intent guards are
preserved. Normal history loading no longer presents a load button; a failed read
retains an explicit retry action.

## Changes

Displayed thoughts and answers hydrate automatically in bounded chunks. Each
item reads its source once, then resumes at the fetched UTF-16 byte offset as its
source grows. New descriptors do not cancel in-flight progress. Replacing or
unmounting an item aborts its old reads; a read failure retains visible text and
offers retry. The existing 8 MiB display limit remains.

Streaming text is readable as escaped plain text while the renderer or Markdown
worker starts. Settled Markdown blocks, worker parsing, syntax highlighting and
transcript virtualization retain their existing ownership and caching. Plain
text changing into rich Markdown can reflow on a cold start; steady streaming is
measured separately with the worker warm.

## Measurements

The browser fixture streams 100 source-backed deltas, one every 50 ms, while
reasoning and the assistant answer remain incomplete. It records DOM arrival,
rAF intervals, keydown-to-next-frame intervals and the unpinned scroll offset.
Timing is evidence rather than a load-sensitive CI threshold.

| Observation                 | Before                                                 | After (warm worker)           |
| --------------------------- | ------------------------------------------------------ | ----------------------------- |
| Source-backed suffix        | Absent until click/completion; reasoning suffix absent | Thinking 23 ms; message 23 ms |
| First source-backed delta   | Not visible from the preview                           | 40.8 ms after emission        |
| p95 frame interval          | 16.7 ms in ordinary unsourced control                  | 16.7 ms                       |
| Maximum frame interval      | 16.8 ms in ordinary control                            | 16.8 ms                       |
| Frames above 50 ms          | 0 in ordinary control                                  | 0                             |
| Input to next frame         | Not recorded in ordinary control                       | 13.1 ms maximum               |
| Reader offset during stream | Existing ordinary gesture tests                        | 7,083 px → 7,083 px           |

The ordinary control is not a source-backed before/after timing comparison: its
first appended section appeared after 63 ms including the fixture's initial
50 ms interval. The source-backed before case never exposed its suffix unaided.

## Re-run

```sh
ACE_DEV_DIR=/tmp/ace-transcript-dev ACE_DEV_WEB_PORT=5196 bun run dev:fake
ACE_E2E_FAKE_PORT=5196 bun run --filter @ace/web-e2e e2e:fake long-output.spec.ts --workers=1 --output=/tmp/ace-transcript-e2e
bun run test apps/web/src/features/thread/items/source-streaming.test.tsx apps/web/src/features/thread/items/answer-text.test.tsx apps/web/src/components/markdown/markdown-loading.test.tsx apps/web/src/features/thread/transcript.test.tsx apps/web/src/features/thread/newer-intent.test.tsx apps/web/src/features/thread/transcript-hygiene.test.tsx
bun run check
```

Set the installed Playwright browser path when running from an isolated provider
home. The browser fixture attaches JSON measurements and captures light/dark
screens at 390, 768, 1440 and 1920 px.

## Repository checks

The full check's static stages passed on the first run. The full test suite
reported 12,816 passing tests, 62 failures across 37 files, and four teardown
errors. Several failures were caused by the isolated shell not finding the
installed Chromium. With its path corrected, the IndexedDB and DOM-budget suites
passed; the forge-stack and daemon thread-tree failures persisted. Both also fail
on an untouched temporary checkout of 67fa95d4e. The thread-tree test reports
“Invalid tool arguments”; the forge-stack test cannot find its stack region.
These failures are outside the transcript change.

The separate performance gate reached its bundle check and failed the same
budgets on the change and the untouched base. Base initial JS was 319.16 KB
against 270 KB and its thread route was 229.93 KB against 138 KB; the changed
build measured 319.19 KB and 230.59 KB respectively. Daemon timing was deferred because host load exceeded its gate. The PR
records final reruns; this document does not claim a green full repository gate.

## Screenshots

| Width | Light                                                        | Dark                                                        |
| ----- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| 390   | [Screenshot](long-output-screens/long-output-390-light.jpg)  | [Screenshot](long-output-screens/long-output-390-dark.jpg)  |
| 768   | [Screenshot](long-output-screens/long-output-768-light.jpg)  | [Screenshot](long-output-screens/long-output-768-dark.jpg)  |
| 1440  | [Screenshot](long-output-screens/long-output-1440-light.jpg) | [Screenshot](long-output-screens/long-output-1440-dark.jpg) |
| 1920  | [Screenshot](long-output-screens/long-output-1920-light.jpg) | [Screenshot](long-output-screens/long-output-1920-dark.jpg) |
