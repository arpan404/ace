# 0056: Web performance architecture

Date: 2026-10-03. Status: accepted.

## Context

A thread can hold 10–20 billion tokens of context and an agent can run for a minute or for a month. The web client (ADR 0045) must stay responsive at the start of such a run and at its end, with several tabs open, while the daemon streams thousands of events a second. The main thread has one job: turn input into the next frame. Socket I/O, frame decoding, projection, markdown, highlighting and diffing compete with it unless they run elsewhere, and any cache that grows with history eventually takes the tab down.

ADR 0045 set budgets but left them unenforced. This ADR records where each kind of work runs, what bounds every cache, and how the budgets are checked.

## Decision

### Where work runs

| Work                                                   | Where                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Socket, frame decode (Zod), projection, intents outbox | The client worker: one `SharedWorker` per origin; a dedicated `Worker` per tab where SharedWorker is missing; in the page where neither exists (tests) |
| Store reads by selectors, React rendering              | The page, against mirrors of the worker's stores                                                                                                       |
| Markdown lexing and code highlighting                  | The markdown worker (dedicated); a streaming message is lexed from its last settled block on, highlighting cached by content hash                      |
| File diffs (an LCS per file)                           | The diff worker (dedicated), cached in memory and IndexedDB by content key                                                                             |
| Very large diffs (flag `gpuText`)                      | The GPU: WebGPU, else WebGL2, else the virtualized DOM view                                                                                            |
| Terminal drawing                                       | xterm.js with its WebGL renderer; the accessible DOM line screen where WebGL2 is missing                                                               |

### React Compiler

The app and its Vitest projects compile with React Compiler (Babel preset through `@rolldown/plugin-babel`, `apps/web/react-plugins.ts`), so tests run the memoised components the browser runs. `eslint-plugin-react-hooks`' compiler rules run under oxlint as the `react-compiler/*` JS plugin for `apps/web` and `packages/client-react`; a component the compiler would skip is a lint error unless the line says why. Two escape hatches are in use: TanStack Virtual's `useVirtualizer` (its callbacks are unstable by design; the compiler skips that component, its rows are compiled), and `"use no memo"` for hooks that read a mutable external source by version (the compiler memoizes calls by their arguments, so such a read must either be the `useSyncExternalStore` snapshot or opt out).

### The client worker

`@ace/client` exposes `ClientApi`, `ThreadSource` and `SidebarSource`; `Client` implements them in-process and `@ace/client-worker`'s `RemoteClient` implements them in a tab. UI code and `@ace/client-react` depend only on the interfaces.

- `ClientHost` (worker) keeps one `Client` per daemon target (URL, device and token), so every tab of the origin shares one socket, one decode, one projection and one outbox. Requests (`command`, `registry`, `itemsPage`, `loadOlder`, `outputRead`, `text`, `output`) cross the port with their abort signals.
- Stores gained `observe(tap)` (every emitted key, or `"all"` after a snapshot) and `export()`. A tab leases a store; the host forwards the keys it emits, coalesced per frame (16 ms), as patches: a key's current value, or for a streaming message only the text it gained. The mirror applies them and notifies the same keys, so selectors re-render exactly as in-process. Work is proportional to what changed in a frame, not to history.
- A hidden tab (`visibilitychange`) receives nothing; when shown it receives every key that changed meanwhile, or one copy of the store once more than 1,024 keys changed, so a tab hidden through a month of streaming holds a bounded backlog in the worker.
- Liveness: where Web Locks exist a tab holds a lock named for itself for its lifetime and the worker asks for the same lock, which the browser grants only once the tab has closed or crashed; such a tab is never dropped for silence. Elsewhere tabs ping every 5 s; a visible tab silent for 30 s, or a hidden one silent for 10 minutes, is dropped and its leases released. (Browsers throttle a hidden page's timers to one wake a minute after five minutes, or freeze the page, so a 30 s window dropped live tabs and left them on stale mirrors.) A client outlives its last tab by 10 s so a reload reattaches to a warm socket.
- Messages, reasoning and notices stream to tabs as the text they gained, not the whole item each frame.
- The outbox moves from `localStorage` (unreachable from workers) to IndexedDB, one record per daemon and device, replaced in one transaction. An older build's `localStorage` outbox is carried over once.
- Decoding: `@ace/protocol` keeps the core stream (hello and welcome, subscriptions, snapshots, events, commands and their results, item pages, output reads) in `wire-core.ts` as `CoreClientMessage` and `CoreServerMessage`; the full `ClientMessage` and `ServerMessage` add the service families to them. The client's `WireCodec` decodes core frames with the core schemas and loads the service families (settings, history, registry, files, terminals, ...) as a lazy chunk when the client starts. A service frame that arrives first waits for them, and every frame after it waits too, so order is kept; service requests await them, item pages and output reads never do. The core keeps of a service family only what commands and their results carry: the project commands and the workspace a receipt returns, and `thread.markRead`; project requests and pushes (`project-requests.ts`) and the long-thread reads are service families. The worker decodes a tab's long-thread read arguments with the service schemas and gives a tab's channels the full `ClientMessage` from them too, so neither adds a chunk of its own. Every message is still parsed with its full schema before use.
- Trust boundary: tab and worker are the same build on one origin. Envelopes are checked with Zod at both ends and request arguments are decoded in the worker; entity payloads were decoded from the daemon's frames by `@ace/protocol` schemas in the worker and are not decoded a second time in the page (`trusted()` in `packages/client-worker/src/trusted.ts` is the only place that asserts their type).

### Rendering cadence

`ClientProvider` takes a `NotifyBatch`. The browser entry uses `frameBatch(requestAnimationFrame)`: every selection that changed during a frame reaches React together on the next animation frame, where React renders them as one update. Hidden documents get no animation frames and so render nothing. Tests notify immediately. A subscribed selection is kept current by its keys, so React reading its snapshot on a render with nothing new does no work; an unsubscribed one reads again only after its store changed. Views over the whole thread list subscribe to the list's `threads` key (any entry or membership changed) rather than one key per thread. Clocks ("4m ago", "Working for 12s") are one shared timer per period, stopped while the page is hidden. Panel tabs that are not showing stay mounted inside React `<Activity mode="hidden">`: their effects (subscriptions, xterm, GPU views) stop, updates render at idle priority, and the tab comes back as it was left.

### Bounded memory

Nothing grows with history. Every cache is an `LruCache` (`@ace/ui-core`, bounded by entries and by weight) or an existing client limit:

| Holder                                   | Bound                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Thread window (client, and each mirror)  | 200 items; older history pages in on demand and the window stays at 200                                                               |
| Cached thread stores                     | 32, least recently used released first                                                                                                |
| Item text                                | 64 Ki UTF-16 units per item; overflow keeps the tail and marks truncation                                                             |
| Agents, runs, interactions, tasks, usage | Soft target of 4,096 retained entities; settled entries are evicted, while active entries and required ancestors remain               |
| Thread list order                        | Deleted threads leave it                                                                                                              |
| A hidden tab's backlog in the worker     | 1,024 changed keys, then one copy of the store when shown                                                                             |
| Sent commands nobody watches (tab)       | The newest 64                                                                                                                         |
| Markdown documents                       | 400 unwatched documents and 16 MB (page); 64 open streams and 8 MB of text, highlight 512 and 4 MB (worker)                           |
| File diffs                               | 600 diffs and 200,000 rows in memory, shown diffs held; 2,000 entries and 128 MB in IndexedDB, oldest use pruned                      |
| Terminal                                 | 1 M characters of raw output per watched PTY; unwatched ones released on exit, after 5 idle minutes or past 4; xterm scrollback 5,000 |
| Preview and device frames                | One object URL per view, revoked when replaced; nothing decoded or acked while hidden; 8 unwatched threads' state                     |
| Virtual lists                            | Measured sizes of rows no longer listed are forgotten; rows fading out at most 12 changes                                             |
| Activity read marks                      | The newest 10,000                                                                                                                     |
| Selection listeners                      | 4,096 per store                                                                                                                       |

The month-long soak found the first unbounded holder: every run stayed in the thread store, and after 4,096 turns the thread failed with "Entity capacity exceeded". Ended runs that no loaded item belongs to are now evicted oldest first; active runs and the window's runs stay, so status and turn grouping never depend on an evicted run. Closed interactions and ended tasks followed the same way (a pending interaction and a running or `unknown` task always stay). The browser memory run found the second: TanStack Virtual keeps the measured size of every row key it has seen, so a streaming transcript's page heap grew 12 MB in 10 minutes at 5,000 events/s; keys of rows that left are now forgotten.

### Markdown and highlighting

Markdown becomes top-level blocks, built in the markdown worker with highlighting cached per (language, code). An assistant message is a stream named by its id: the page sends the worker only the text appended since its last job, the worker keeps a settled head of finished blocks (each lexed once) and lexes only the open tail, and a reply carries the blocks that settled and the open ones, never the whole document. Blocks are keyed by position, so a settled block keeps its object and never renders again, and the open block keeps its key when it settles. Other prose (a file preview, a task prompt) is a stream named by the hash of its text, built once. Each stream has at most one job in flight, always for its newest text, and keeps its previous document on screen until the next is ready. No HTML string is ever produced; blocks render through the same safe React renderer as before. See the amendment of 2026-10-05.

### Diffs

`@ace/ui-core` splits diffing into `groupFileChanges` (cheap), `fileDiffKey` (a content key over every change of a file, standing in for old and new blob ids, plus the diff options) and `diffFile`. The Changes tab and its stat read diffs through a service: memory LRU, then the diff worker, which checks its IndexedDB copy before computing, so a reload or another tab does not diff the same content twice. Files over 400 rows mount only the rows near the panel's viewport (`VirtualRows`, rows kept in flow so wide lines still scroll sideways). With the `gpuText` flag (`localStorage["ace.flag.gpuText"] = "1"`), a diff of 5,000 or more rows is drawn by the GPU text renderer: a glyph atlas rasterised once and one instanced draw per frame of the visible lines and columns, at whole-device-pixel cells. The renderer is chosen by capability (a WebGPU adapter, else WebGL2), downgrades on the first validation error or lost context, and "Show as text" returns to the DOM view, which remains the accessible one (line comments need it).

### Terminal

Where WebGL2 exists, PTY terminals use xterm.js (loaded on first show) with its WebGL addon, falling back to xterm's DOM renderer if the context is lost; elsewhere the accessible line screen stays. Sessions keep a bounded raw output log so a view mounting late replays what it missed. Colours come from the theme tokens through `lib/css-color.ts`, which turns any CSS colour syntax into RGBA for canvas and GPU consumers.

### Budgets

`bun run check:perf` (part of `bun run check`; `tools/web-perf`) enforces, from `tools/web-perf/src/budgets.ts`:

| Budget                                                                                        | Limit     | Measured on 2026-10-03                   |
| --------------------------------------------------------------------------------------------- | --------- | ---------------------------------------- |
| Initial JS, gzip (entry and its static imports)                                               | ≤ 270 KB  | 262 KB (was 295)                         |
| First screen: shell plus the heaviest route, gzip                                             | ≤ 405 KB  | 396 KB, thread (was 434)                 |
| Any route's own chunks, gzip                                                                  | ≤ 138 KB  | thread 134 KB, settings 123 KB           |
| CSS, gzip                                                                                     | ≤ 21 KB   | 20.2 KB                                  |
| Each worker's eager script, gzip                                                              | ≤ 60 KB   | client 56 (was 68), markdown 33, diff 24 |
| A worker with its lazy chunks, gzip                                                           | ≤ 73 KB   | client 69                                |
| Month-long soak: 3,000,000 events through client, host and mirrors, retained heap growth      | ≤ 6 MB    | −3 MB (flat, 28.5 MB)                    |
| Events streamed in the browser run                                                            | ≥ 5,000/s | 5,000/s                                  |
| Input to next paint, p95, while streaming                                                     | ≤ 100 ms  | 40 ms                                    |
| Longest main-thread task while streaming                                                      | ≤ 200 ms  | none over 50 ms                          |
| Share of the run in long tasks                                                                | ≤ 10 %    | 0 %                                      |
| Transcript and composer usable after navigation                                               | ≤ 3 s     | 1.4 s (first contentful paint 0.2 s)     |
| DOM nodes at any point (streaming, or a 1,000,000-item thread paged back)                     | ≤ 1,500   | 840 peak                                 |
| Retained page heap growth while streaming at 5,000 events/s, or paging back through 1 M items | ≤ 4 MB    | 0.8 MB in 5 minutes (was 12.4 in 10)     |
| Retained client worker heap growth while streaming                                            | ≤ 3 MB    | 0.4 MB                                   |
| One 40 KB markdown answer streaming: input to next paint, p95 (2026-10-05)                    | ≤ 100 ms  | 40–56 ms                                 |
| Same: longest main-thread task                                                                | ≤ 50 ms   | none over 50 ms                          |
| Same: markdown worker ms per update, last quarter of the answer over the first (median)       | ≤ 3×      | 1.0× (4.7× before)                       |
| Same: main-thread busy ms per drawn frame                                                     | ≤ 4 ms    | 2.6 ms (3.9 before)                      |
| Same: markdown blocks whose DOM node was replaced                                             | ≤ 20      | 9–10 (430–462 before)                    |
| Long thread (1,000,000 items, 2,000 turns): transcript and composer usable after navigation   | ≤ 3 s     | 0.39 s (measured 2026-10-04)             |
| Long thread: input to next paint, p95, over jumps, window scrolling, search and Jump to live  | ≤ 100 ms  | 56 ms, no long tasks                     |
| Long thread: DOM nodes at any sample (a jumped window, search open, the live tail)            | ≤ 1,500   | 1,038 peak                               |
| Long thread: retained page heap growth from the first round to the sixth                      | ≤ 4 MB    | 2.3 MB                                   |

- Bundle: one production build, weighed per route from the Vite manifest.
- Soak: `SoakDaemon` (`@ace/fake-daemon`) is an endless agent: one exchange folded through `@ace/core` once and replayed with fresh ids, keeping a bounded window, so it publishes millions of events at a fixed cost and growth measured in the process is the client's. Its clock runs 30 days over the run.
- Browser: the production build in `--mode perf`, whose client worker is fed by `SoakDaemon` at 5,000 events/s, in Chromium while a person types into the composer and scrolls the transcript. Long tasks and Event Timing are recorded from first paint; the run first checks that its detector sees a deliberate 120 ms task.
- Memory (`tools/web-perf/src/memory.ts`): the same build. It times the load; opens a thread with 1,000,000 items of history (`SoakDaemon` makes pages of it on demand, `?history=`) and pages back through it; then streams at 5,000 events/s for `MEMORY_MINUTES` (2 in CI). The page heap and the client worker's heap are read through DevTools after forced garbage collection, so growth is what is retained.
- Bundle: workers are weighed by following their own chunk imports, eager and lazy, so splitting a worker never hides bytes.
- Long thread (`tools/web-perf/src/long-thread.ts`): the same build with `?long=1`, whose client worker serves `multiDayThread` (one million items over five days, 2,000 turns, 48 subagent threads) on demand through `LongThreadSoak` while a live turn adds 20 items a second. Each of six rounds opens the turn timeline and jumps across days by keyboard, scrolls the jumped window toward the present, steps between turns, searches the thread and steps through hits, then jumps back to live. It also reports, without a budget, how long a jump and a search take to show (medians of 0.3 to 0.46 s for a jump and 0.28 s for a search across runs, in the worker's synthetic daemon).

The initial-JS budget is a ratchet at today's size. Declaring `sideEffects` in `apps/web` (so a route importing one component from a slice's index no longer pulls in the slice) and loading the palette lazily took it from 501 KB to 328 KB. The page then still bundled the in-page `Client` (used only where the browser has neither worker) and with it the protocol's frame schemas; loading that fallback on demand (`boot/page-client.ts`) and declaring `sideEffects: false` in `@ace/client` and `@ace/client-worker` (so the page's `RemoteClient` no longer drags in `Client`, `ClientHost` and their request schemas through the package indexes) took it to 312 KB. ADR 0045's 200 KB target needs the shell's view chrome split by route. Then (2026-10-03): the page's own schemas (tab and worker envelopes, connection target, layout, appearance, route search) moved to `zod/mini`, so classic Zod loads only with routes that parse protocol replies; the connection screen and its TanStack Form load on demand; `cn` uses tables compiled ahead of time (`bun run --filter @ace/web cn:tables`) instead of compiling them at startup; Phosphor icons keep only the four weights the design draws (`apps/web/icon-weights.ts`); browser builds leave out Zod's JSON Schema generator, which nothing there calls (`apps/web/zod-json-schema.ts`); and a thread's step detail and interaction card load after first paint, warmed while idle, through `deferredComponent`. Initial JS went from 295 to 262 KB and the first screen from 434 to 396 KB. Of the 396 KB, React DOM, the router, Base UI's popups and classic Zod (which the thread route needs to parse protocol replies on the page) are the bulk; reaching 200 KB would need those parsed in the worker or loaded in pieces. Then (2026-10-04), with the long-thread tools added (first screen 406.5 KB): the jump-to-live pill, the folded header's ⋯ popover, the narrow window's sidebar sheet and the pinned summary's ⋯ menu load when first needed (the last three behind a look-alike button that opens them once their code arrives), which takes Base UI's Popover and Dialog off the thread route's first paint: 397.5 KB.

Then (2026-10-04), to give the chat work queued behind it room under the same budgets: Rolldown splits modules by the set of entries (the page and every lazy import) that reach them, so code the shell shares with any route sat in a chunk of its own, although the shell always loads it before a route can ask. The first paint was 97 files, each gzipped alone, repeating its imports and exports and named in every preload list. The entry's static closure is now one chunk (`initialChunk` in `apps/web/initial-preloads.ts`, from Rolldown's `$initial` tag). Classic Zod installs every method on its schema prototypes, so each bundle kept 23 string formats, the codecs and a few wrappers that nothing in the browser calls; browser builds replace those with a stand-in that throws (`apps/web/zod-methods.ts`). Worker builds now drop annotation comments, as page builds already did. Initial JS went from 269.5 to 227.4 KB, the first screen from 400.6 to 354.8 KB (shell plus a settings page; the thread route went from 127.6 to 125.1 KB), and the client worker with its lazy chunks from 71.9 to 68.5 KB. The bundle check had been weighing a page chunk, `components/markdown/worker.ts`, as a worker; it now weighs only the workers' own files.

CI runs the bundle and soak budgets in the `check` job and the browser and memory budgets in the `browser` job.

## Consequences

- The UI binds to interfaces, not to `Client`. Anything that needs the concrete class (tests, the worker) constructs it; everything else takes `ClientApi`.
- One socket per origin instead of one per tab. A crashed tab holds its leases until its Web Lock frees (at once), or up to 30 s (10 minutes if it was hidden) where there are no Web Locks.
- Where only dedicated workers exist, each tab has its own client and they share one outbox key, as tabs did with `localStorage` before; concurrent tabs can overwrite each other's pending intents there.
- `vite --mode fake` keeps the fake daemon and client in the page (the console handle `ace.daemon` needs it); `--mode perf` exercises the worker path.
- The GPU diff view is read-only and not readable by screen readers; it announces itself and offers "Show as text". It stays behind a flag until it supports line comments.
- Evicted runs mean history paged in long after its turn ended may not group under that turn in the Changes tab; an evicted closed interaction or ended task is no longer shown for such history either.
- Browser budgets depend on the runner; a budget failure on a loaded machine is re-run before it is believed.

Long-thread follow-up (2026-10-03): daemon snapshots window settled entity history independently of items and expose `entities.page`. Historical count no longer causes client failure. Item deletion also removes creation/hydration metadata, notifies item/order readers, and journals a tombstone so an in-flight older page cannot resurrect it.

## Amendment, 2026-10-05: hybrid streaming markdown

A streaming answer used to cost work proportional to the whole answer on every frame: the page hashed the full text on each render, the worker lexed the whole message for each job and cloned the whole token tree back, and the growing last block got a new key (the hash of its source) on each update, so React remounted its DOM. A 40 KB answer remounted 430 blocks and the worker's time per update grew 4.7× from the start of the answer to its end.

Streaming markdown is now parsed paragraph-wise:

- **Settling.** `BlockStream` (`components/markdown/block-stream.ts`) keeps a settled head and an open tail. Each append is block-lexed from the tail's start; every block before the last one settles, and so does the last one's predecessor once the last block's first line is complete (`#` can still become `#tag`, which continues the paragraph above). A link reference definition settles only after a blank line, since its title can continue on the following lines. A fence left open, a list that may continue after a blank line, a table still growing and a setext heading all stay in the last block until another block has begun, so they stay open. When the text is final everything settles.
- **References.** Settled blocks resolve references against the definitions settled before or with them, wherever those sit (top-level, in a quote or a list item), and the first definition of a label wins. Labels live in prototype-free dictionaries, so `constructor` or `__proto__` is a label like any other. A settled definition with a new label, after a settled block containing `[`, re-lexes the head once. An open definition never resolves a settled block, since its URL may still be growing.
- **Inline state.** marked carries inline HTML state (`inLink`, `inRawBlock`, `linkEmitted`) from one block's inline text to the next: an `<a>` left open in one paragraph turns autolinks off in the next. Each lex starts from the state the settled head ended in, so a split never changes it.
- **Equivalence.** The settled blocks of a final text equal one lex of the whole text, token for token. A property test streams agent-shaped samples (fences with blank lines and nested fences, loose and nested lists, setext headings, tables interrupting paragraphs, quotes with lazy lines, HTML blocks, late and duplicate definitions, multi-line titles, CRLF) at every chunk size from one character to whole lines and at seeded random sizes. It checks the final blocks against the full parse, and checks that a settled block is never revised.
- **Protocol.** A job is `{stream, at, append, final}`. The worker holds one parser per open stream (`StreamRegistry`, 64 streams and 8 MB) and answers `{from, settled, open}`, or `resync` when it holds the stream at another length (evicted, restarted) so the page sends the text whole. Settled blocks are lexed and highlighted once and cross to the page once; they are keyed by stream and position. No per-block source hash is kept: the parser guarantees a settled block never changes, so a hash would only cost time. A final job ends the stream in the worker, and so does a `{release}` job when no view shows a stream that was still being written. The page validates every reply against a schema.
- **Lifecycle.** When the last view of a stream unmounts, the page cancels its pending wait and queued text, ignores replies to jobs sent before then (each stream has an epoch), frees the worker's parser and parks the document. A parked document never changes again and is weighed by what it holds (its text plus three times its blocks' source), so the 16 MB budget is real.
- **Rendering.** Keys are positions. Settled blocks keep their objects, so `TopBlock` skips them. Open blocks are patched in place and keep their key when they settle. An open code block shows plain text in the same frame and is highlighted when it settles, so settling changes colour only, never layout.
- **Cadence.** `MarkdownStore` paces jobs for a streaming message at 50–100 ms: four times the last round trip within that range, and 100 ms under `prefers-reduced-motion`. The first job of a message and its final job go at once (a final text cancels a pending wait), and the plain text shows until the first document is ready, so time to first text is unchanged. The virtualizer measures rows through a ResizeObserver, so a row is re-measured only when its markdown changes, at this cadence, and no longer every frame. No fade or typing animation was added.
- **The client worker.** `ThreadReader.appended(previous, next)` says whether the client's delta path made `next` from `previous` by appending alone. A run of appends shares one prefix array, and every clip makes a new one. The host's `appendedText` uses it to take the gained text without comparing the whole message each frame. Text it did not build, such as an adapter upserting whole messages, still falls back to the comparison. The client worker with its lazy chunks went from 72.981 to 72.989 KB.

`tools/web-perf/src/markdown-stream.ts` streams a ~40 KB answer (prose, nested and task lists, fenced code, tables) at 4 KB/s in 20-character deltas while a person types. It enforces the budgets above. Before and after on the same machine:

| Measure                                       | Before    | After           |
| --------------------------------------------- | --------- | --------------- |
| Worker ms per update, median (first → last ¼) | 0.3 → 1.4 | 0.1 → 0.1       |
| Worker ms per update, p95                     | 1.6–1.7   | 0.2             |
| Markdown updates over the answer              | 376–399   | 187–189 (paced) |
| Main-thread busy ms per frame                 | 3.7–4.0   | 2.6             |
| Block remounts                                | 430–462   | 9–10            |
| Input to next paint, p95                      | 56 ms     | 40–56 ms        |
| Long tasks                                    | none      | none            |

The remaining remounts are open blocks that change kind as they grow, such as a table's header line, which is a paragraph until its delimiter row arrives.

## Amendment (2026-10-05): initial JS budget 270 → 272 KB

Main reached 269.7 KB gzip of initial JS. Browser parity (#153) adds protocol schemas the page validates (0.6 KB) and the computer-use UI (#155) adds about 0.6 KB of shell wiring. The owner accepted a 2 KB raise rather than blocking both features on sub-kilobyte overruns. An initial-JS diet PR is in progress and is expected to restore at least 10 KB of headroom, after which this budget returns to 270 KB or lower.

## Amendment (2026-10-05): shell menus deferred, 270 KB budget restored

The sidebar's account, daemon and More buttons, and the header's title-menu button, now paint
without loading Base UI's menu implementation. `deferredMenuButton` warms that implementation
with `whenIdle`; a press before it loads keeps the original button focused until the code is
ready, then replays the click or keyboard activation through Base UI. Escape cancels a pending
open, arrow keys preserve first/last-item focus, and Strict Mode cannot replay a press twice.
Once opened, the menu stays mounted so its closing animation and focus return work as before.
The toast queue and surface, visible shell controls and boot-splash dismissal remain eager.

The page build now guards its entry's actual static closure in `apps/web/initial-bundle.ts`,
rejecting eager menus, popup wrappers, palette and project dialogs. The existing
`initial-preloads.ts` still removes that closure from lazy preload lists. `bundle.ts --analyze`
reports retained page packages and modules as well as the client worker. Gzip chunk weights are
additive; module weights are retained source bytes before minification.

Measured against main after #153 (`db7e3a86`), on the same machine:

| Measure                        | Before        | After         |
| ------------------------------ | ------------- | ------------- |
| Initial JS, gzip               | 270.3 KB      | 252.0 KB      |
| Heaviest first screen, gzip    | 392.1 KB      | 388.3 KB      |
| Heaviest lazy route, gzip      | 121.8 KB      | 136.3 KB      |
| CSS, gzip                      | 20.7 KB       | 20.7 KB       |
| Base UI retained source        | 342,037 bytes | 211,151 bytes |
| Browser first contentful paint | 708 ms        | 456 ms        |
| Interaction p95                | 48 ms         | 40 ms         |
| Long tasks                     | none          | none          |

These browser timings are local samples, not a portable speedup claim. Worker weights are
unchanged. Initial JS saves 18.3 KB and the temporary 272 KB budget returns to 270 KB; all route,
first-screen, CSS and worker budgets stay unchanged.
