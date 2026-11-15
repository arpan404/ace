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
| Markdown parsing and code highlighting                 | markit (Rust + Wasm) in its shared worker; each renderer sends only appended text and patches only the blocks that changed                             |
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

| Holder                                   | Bound                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread window (client, and each mirror)  | 200 items; older history pages in on demand and the window stays at 200                                                                                                                                                                                                                                                                             |
| History window (each thread view)        | 2,000 items and about 8 Mi UTF-16 units of text (400 items for a subagent transcript, which is not virtualized); trimmed only at the end away from the reader                                                                                                                                                                                       |
| Cached thread stores                     | 32, and 16 MiB estimated for those no view holds, least recently used released first; held stores pinned                                                                                                                                                                                                                                            |
| Released tab mirrors                     | 32 and 16 MiB estimated per tab, least recently used first; leased mirrors pinned; dropped when the worker is lost                                                                                                                                                                                                                                  |
| Read snapshots (IndexedDB)               | 512 records and 64 MiB across every daemon and device, least recently used pruned in the writing transaction; one write per view per second                                                                                                                                                                                                         |
| Kept daemon lookups (IndexedDB)          | One record per connection beside its read snapshots, at most 200 queries; one write per second while connected                                                                                                                                                                                                                                      |
| Finished turns' steps                    | Unretained turns: 2,000 steps and 100 turns in memory, oldest use first; on disk one record per read turn among the read snapshots (ADR 0062)                                                                                                                                                                                                       |
| Item text                                | 64 Ki UTF-16 units per item; overflow keeps the tail and marks truncation                                                                                                                                                                                                                                                                           |
| Agents, runs, interactions, tasks, usage | Soft target of 4,096 retained entities; settled entries are evicted, while active entries and required ancestors remain                                                                                                                                                                                                                             |
| Thread list order                        | Deleted threads leave it                                                                                                                                                                                                                                                                                                                            |
| A hidden tab's backlog in the worker     | 1,024 changed keys, then one copy of the store when shown                                                                                                                                                                                                                                                                                           |
| Sent commands nobody watches (tab)       | The newest 64                                                                                                                                                                                                                                                                                                                                       |
| Markdown documents                       | Finished thread answers kept drawn off the page, per client: 200 and 12 MB, weighed as the text twice (UTF-16) + 256 bytes per drawn DOM node + 16 KB per renderer; answers drawing images, video or diagrams are never kept; heights of answers drawn before: 2,000 per client, each under a hash of its context (never its text), under 300 bytes |
| File diffs                               | 600 diffs and 16 MiB estimated bytes in memory, including text hidden by folds, shown diffs held; 2,000 entries and 128 MB in IndexedDB, oldest use pruned                                                                                                                                                                                          |
| Terminal                                 | 1 M characters of raw output per watched PTY; unwatched ones released on exit, after 5 idle minutes or past 4; xterm scrollback 5,000                                                                                                                                                                                                               |
| Preview and device frames                | One object URL per view, revoked when replaced; nothing decoded or acked while hidden; 8 unwatched threads' state                                                                                                                                                                                                                                   |
| Virtual lists                            | Measured sizes of rows no longer listed are forgotten; rows fading out at most 12 changes                                                                                                                                                                                                                                                           |
| Activity read marks                      | The newest 10,000                                                                                                                                                                                                                                                                                                                                   |
| Selection listeners                      | 4,096 per store                                                                                                                                                                                                                                                                                                                                     |

The month-long soak found the first unbounded holder: every run stayed in the thread store, and after 4,096 turns the thread failed with "Entity capacity exceeded". Ended runs that no loaded item belongs to are now evicted oldest first; active runs and the window's runs stay, so status and turn grouping never depend on an evicted run. Closed interactions and ended tasks followed the same way (a pending interaction and a running or `unknown` task always stay). The browser memory run found the second: TanStack Virtual keeps the measured size of every row key it has seen, so a streaming transcript's page heap grew 12 MB in 10 minutes at 5,000 events/s; keys of rows that left are now forgotten.

### Markdown and highlighting

Prose is drawn by markit (`@ace/markit-web`, Rust compiled to Wasm), through `MarkitView` (`apps/web/src/components/markdown/markit-view.tsx`). Every renderer on the page shares one markit worker and owns a stream in it. When the text only grew, a renderer sends the worker only the appended text, and the worker returns the blocks from the first one that changed; settled blocks keep their DOM, and the open block is morphed in place. Code is highlighted in the same pass. Markit sanitises its own output: raw HTML outside the safe subset reads as text, links reach the browser only for http(s) and mailto, and images draw only bytes the host hands it. A streaming answer reaches markit at the pace of `cadence.ts` (`StreamPace`: 50–100 ms, from the last update's cost). Its plain text shows until markit's first render lands, and the swap happens in that frame, so an answer is never blank.

A finished thread answer's renderer and the element it drew into outlive its row (`kept-answers.ts`). When the row unmounts (the reader switches threads, or the row leaves the virtualised range), the drawing goes into a bounded LRU. Mounting the same answer again puts that element back in a layout effect, before the first paint: no plain-text frame, no worker job, no change in height, and code views and file links stay as they were (the view re-runs its file-link reconciliation, so a lookup cut short when the row left resumes). Nothing is re-rendered or re-sanitised on the way back. What may come back is scoped tightly:

- Each client (one connection to one daemon) owns its own kept answers, so nothing drawn for one daemon or account is shown for another.
- An entry is one item of one thread, reused only under the exact context recorded when it was drawn: flavour, colour scheme, the item's working directory, the thread's checkout, and the text. A mount under any other context drops the old drawing and draws afresh. Prose outside a thread item (forge bodies, previews) is never kept, so nothing is keyed on text alone.
- A thread the client no longer holds (deleted, evicted from its cache, or the client closed) loses its drawings and heights at the next sweep. Every view sweeps every client as it mounts and as it unmounts, and a client's cache stays in that sweep while it holds any record (retaining one registers it again). The check uses `peekThread`, which leaves the client's own cache order alone.
- While detached an entry calls no view: its hooks are let go, so it keeps no client, store or workspace alive.
- An answer that draws images, video or diagrams is never kept: its cost isn't bounded by its text, and image bytes are resolved per thread. It draws again on remount. Streaming answers and a second copy of an answer already on screen draw afresh too.

An evicted or dropped renderer is destroyed, which frees its worker stream, object URLs and pending jobs. An answer drawn before but no longer kept holds its last measured height (from a shared ResizeObserver, read without a layout pass) until markit's output is in, so the rows under it don't move.

The long-thread check (`tools/web-perf/src/remount.ts`) follows the synthetic thread's last answer, which has several blocks and a code fence (every hundredth turn has one), scrolls it out of the transcript and back, then switches threads and returns. It measures the answer's height on every frame while it remounts, and fails on any plain-text frame, any markit render of that answer, or any change in its height. Before kept answers, each remount showed the raw text for a frame and the row moved by 22 px.

Follow-up: a markit API that takes appended text from the host directly would save the full-text comparison `MarkitRenderer.render` makes on each streamed update.

### Diffs

`@ace/ui-core` splits diffing into `groupFileChanges` (cheap), `fileDiffKey` (a content key over every change of a file, standing in for old and new blob ids, plus the diff options) and `diffFile`. The Changes tab and its stat read diffs through a service: memory LRU, then the diff worker, which checks its IndexedDB copy before computing, so a reload or another tab does not diff the same content twice. Files over 400 rows mount only the rows near the panel's viewport (`VirtualRows`, rows kept in flow so wide lines still scroll sideways). With the `gpuText` flag (`localStorage["ace.flag.gpuText"] = "1"`), a diff of 5,000 or more rows is drawn by the GPU text renderer: a glyph atlas rasterised once and one instanced draw per frame of the visible lines and columns, at whole-device-pixel cells. The renderer is chosen by capability (a WebGPU adapter, else WebGL2), downgrades on the first validation error or lost context, and "Show as text" returns to the DOM view, which remains the accessible one (line comments need it).

### Terminal

Where WebGL2 exists, PTY terminals use xterm.js (loaded on first show) with its WebGL addon, falling back to xterm's DOM renderer if the context is lost; elsewhere the accessible line screen stays. Sessions keep a bounded raw output log so a view mounting late replays what it missed. Colours come from the theme tokens through `lib/css-color.ts`, which turns any CSS colour syntax into RGBA for canvas and GPU consumers.

### Budgets

`bun run check:perf` (part of `bun run check`; `tools/web-perf`) enforces, from `tools/web-perf/src/budgets.ts`:

| Budget                                                                                        | Limit     | Measured on 2026-10-03               |
| --------------------------------------------------------------------------------------------- | --------- | ------------------------------------ |
| Initial JS, gzip (entry and its static imports)                                               | ≤ 335 KB  | 327 KB (2026-10-25)                  |
| First screen: shell plus the heaviest route, gzip                                             | ≤ 680 KB  | 666 KB, thread (2026-10-25)          |
| Any route's own chunks, gzip                                                                  | ≤ 345 KB  | thread 339 KB (2026-10-25)           |
| CSS, gzip                                                                                     | ≤ 30 KB   | 28.2 KB (2026-10-25)                 |
| Each worker's eager script, gzip                                                              | ≤ 85 KB   | client 82, machine 82, markdown 30   |
| A worker with its lazy chunks, gzip                                                           | ≤ 102 KB  | client 99, machine 99                |
| Month-long soak: 3,000,000 events through client, host and mirrors, retained heap growth      | ≤ 6 MB    | −3 MB (flat, 28.5 MB)                |
| Events streamed in the browser run                                                            | ≥ 5,000/s | 5,000/s                              |
| Input to next paint, p95, while streaming                                                     | ≤ 100 ms  | 40 ms                                |
| Longest main-thread task while streaming                                                      | ≤ 200 ms  | none over 50 ms                      |
| Share of the run in long tasks                                                                | ≤ 10 %    | 0 %                                  |
| Transcript and composer usable after navigation                                               | ≤ 3 s     | 1.4 s (first contentful paint 0.2 s) |
| Attached DOM nodes at any sample (streaming, or a 1,000,000-item thread paged back)           | ≤ 1,500   | 840 peak                             |
| Retained page heap growth while streaming at 5,000 events/s, or paging back through 1 M items | ≤ 4 MB    | 0.8 MB in 5 minutes (was 12.4 in 10) |
| Retained client worker heap growth while streaming                                            | ≤ 3 MB    | 0.4 MB                               |
| One 40 KB markdown answer streaming: input to next paint, p95 (2026-10-05)                    | ≤ 100 ms  | 40–56 ms                             |
| Same: longest main-thread task                                                                | ≤ 50 ms   | none over 50 ms                      |
| Same: markdown worker ms per update, last quarter of the answer over the first (median)       | ≤ 3×      | 1.0× (4.7× before)                   |
| Same: main-thread busy ms per drawn frame                                                     | ≤ 4 ms    | 2.6 ms (3.9 before)                  |
| Same: markdown blocks whose DOM node was replaced                                             | ≤ 20      | 9–10 (430–462 before)                |
| Long thread (1,000,000 items, 2,000 turns): transcript and composer usable after navigation   | ≤ 3 s     | 0.39 s (measured 2026-10-04)         |
| Long thread: input to next paint, p95, over jumps, window scrolling, search and Jump to live  | ≤ 100 ms  | 56 ms, no long tasks                 |
| Long thread: attached DOM nodes at any sample (a jumped window, search open, the live tail)   | ≤ 1,500   | 1,038 peak                           |
| Long thread: retained page heap growth from the first round to the sixth                      | ≤ 4 MB    | 2.3 MB                               |

- Bundle: one production build, weighed per route from the Vite manifest.
- Soak: `SoakDaemon` (`@ace/fake-daemon`) is an endless agent: one exchange folded through `@ace/core` once and replayed with fresh ids, keeping a bounded window, so it publishes millions of events at a fixed cost and growth measured in the process is the client's. Its clock runs 30 days over the run.
- Browser: the production build in `--mode perf`, whose client worker is fed by `SoakDaemon` at 5,000 events/s, in Chromium while a person types into the composer and scrolls the transcript. Long tasks and Event Timing are recorded from first paint; the run first checks that its detector sees a deliberate 120 ms task.
- Memory (`tools/web-perf/src/memory.ts`): the same build. It times the load; opens a thread with 1,000,000 items of history (`SoakDaemon` makes pages of it on demand, `?history=`) and pages back through it; then streams at 5,000 events/s for `MEMORY_MINUTES` (2 in CI). The page heap and the client worker's heap are read through DevTools after forced garbage collection, so growth is what is retained.
- Bundle: workers are weighed by following their own chunk imports, eager and lazy, so splitting a worker never hides bytes.
- Long thread (`tools/web-perf/src/long-thread.ts`): the same build with `?long=1`, whose client worker serves `multiDayThread` (one million items over five days, 2,000 turns, 48 subagent threads) on demand through `LongThreadSoak` while a live turn adds 20 items a second. Each of six rounds jumps across days from the conversation rail's turn ticks, scrolls the jumped window toward the present, steps between turns, searches the thread and steps through hits, then jumps back to live. It also reports, without a budget, how long a jump and a search take to show (medians of 0.3 to 0.46 s for a jump and 0.28 s for a search across runs, in the worker's synthetic daemon).

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

Superseded: markit replaced the markdown worker, `BlockStream` and `MarkdownStore` described here. "Markdown and highlighting" above describes what runs now; this section stays as the record of why streaming became incremental.

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

## History window bound (2026-10-18)

A thread view's history window (ADR 0062, "Transcript order and held ranges") used to be 200
items that slid by 100, so reading older history dropped the newer end and every slide parted
the window from the live tail. It is now bounded at 2,000 items and an estimate of their text
(`windowBounds` in `@ace/ui-core`: message, reasoning and notice text plus 1 KiB per item, at
most 8 Mi UTF-16 units); a subagent transcript, which renders every row it holds, keeps 400.
The bound is reached only by reading far: the window trims at the end away from the reader
(its newer end while reading older, its older end while reading newer), never under the rows
on screen, and a full window that the live tail would trim past leaves the tail behind a gap
instead of dropping rows. The live store's own 200-item bound is unchanged. DOM stays bounded
by the virtualizer; block building over a window is linear in its items, as it was over 200.

## Amendment (2026-10-19): a lost client worker is replaced, never fatal

A client worker died at the same second Electron's network service restarted. The tab's pings went unanswered, `RemoteClient` turned fatal ("durable delivery may be uncertain") and stayed so; Retry asked for the SharedWorker by name again and reached the same frozen worker, so only quitting the app helped.

- A tab whose worker stops answering (the 15 s reply deadline) or reports an error tears down that port and asks the page for a fresh worker (`RemoteOptions.respawn`, `worker-link.ts`): none to wait for the first time, then 0.5 s doubling to 30 s, starting over once a worker stays attached for 30 s. While it waits the client is `reconnecting`. The page tries a fresh SharedWorker once after a timeout, then a dedicated Worker, because a frozen SharedWorker keeps its name.
- On a fresh worker the tab sends what the first heard over time: `connect`, its leases (each mirror is reset by the new copy), watched intents and pending sends, message and stream listeners, visibility, its lock, the sidebar window and an offline network.
- Durable delivery: the outbox is in IndexedDB, so intents the dead worker saved are loaded and sent by the new one. A durable call (`enqueue`, `command`, `submitNew`) the dead worker never answered is sent again under its command id: the client's outbox reuses a saved record with that id, and the daemon's command receipts answer a command it already applied with its first result, so the input exists once. A `submitNew` whose id the dead worker had allocated goes again as `command` with that id once the tab has recorded it; one with no id yet allocated had nothing saved or sent, and is submitted afresh. Reads, service requests and streams in flight fail as `offline`, which callers may retry. Only a client given no `respawn` (machine-pool workers) still turns fatal on a lost worker.
- The worker's client reports socket closes (code, reason, missed heartbeat, attempt, retry delay) and recoveries (attempts, time down), forwarded to one attached tab; the tab adds worker losses, respawns and recoveries. The page passes them to the desktop log (`window.ace.diagnostics.report`) or the console.
- The connection heartbeat counts any frame from the daemon as proof of life, not only the pong, which the daemon queues behind its other traffic.

## Amendment (2026-10-25): bundle budgets reset to today's sizes

The bundle budgets had not been met for weeks: main measured 485 KB of initial JS against 270. Accidental eager imports were removed first. Slice indexes that defined their own lazy loaders (`forge`, `panels`, `visualization`) pulled everything they re-export into startup, parse5 and the PR text renderer among them, so the loaders moved to `loaders.ts` beside each index. The open-work warmup, the settings schemas, the Add account row and New thread's thread preload now load where they are used. `forbiddenInitialModules` keeps them out of startup. Initial JS went from 485 to 327 KB and the first screen from 831 to 666 KB.

What remains is growth from features added since 2026-10-06, with no single accidental import left: shell features of a few KB each (notifications, sign-in, organizer, updates, transfers), transcript specs and icon tables in the thread routes, a composer that now carries browser annotations, attachments and preparations, wire schemas that the workers must parse eagerly, and about 570 new CSS selectors. The owner chose to reset each budget to today's size plus a little headroom, so the check is green again and catches further growth: initial 335 KB, first screen 680 KB, route 345 KB, CSS 30 KB, worker 85 KB, worker with lazy chunks 102 KB. ADR 0045's 200 KB first-screen target stands; getting nearer needs a lazy composer and transcript specs split by tool.

The DOM budgets now count the nodes under `<body>` (and open shadow trees) only. `<head>` held about 430 module preload links, one per lazy chunk the shell may load, which say nothing about how well the transcript is virtualized and grew with every route split. With them left out the long-thread journey peaks near 1,340 attached nodes; #1420 added about 270 of those by drawing a screen of rows past each edge of the transcript so a fast flick never shows a gap.

## Amendment (2026-11-12): popup placement and unused icon weights out of the first paint

A tooltip's popup (Base UI's positioner with Floating UI) was in the startup bundle, though nothing draws it until a hover or focus rests on a trigger. It now loads while the browser is idle, or on the first request to open (`tooltip-popup.tsx`, behind `deferredPart`). Until it arrives the root holds the open (`useOpenGate` in `components/ui/open-gate.ts`), then hands the request back to Base UI's own open through the root's handle, with its reason, event and trigger, so it opens exactly as a warm one would (a keyboard focus open stays instant); leaving the trigger, moving focus, Escape or any activation (a press, Enter, Space, an assistive technology's click) cancels the held open, a press keeps it from reopening under a resting pointer, and a failed load leaves the control working and loads again on the next hover. The transcript's agent hover card uses the same gate, so the thread route doesn't take over the placement code. `forbiddenInitialModules` keeps both the popup and `useAnchorPositioning` out of startup.

Phosphor icons now keep only the weights they are drawn in. `iconWeights` (regular, fill, bold) is every icon's; glyph tables (`glyphTables` in `apps/web/icon-weights.ts`) pin the weight they draw (`pinnedGlyph`), and an icon that only tables import keeps only theirs: the file-type marks one, the project glyphs two. Duotone stays only in the empty-state glyphs (`empty-glyphs.ts`). The build reads which modules import each icon, so an icon any other module imports stays whole. It also reads every place a module sets an icon's weight (`icon-weight-guard.ts`) and fails on a weight it drops, or on one the source doesn't spell out (a variable, a call, props spread onto an icon), outside the two modules whose weights are typed to the kept ones.

| Budget, gzip | Before   | After    | Limit    |
| ------------ | -------- | -------- | -------- |
| Initial JS   | 377.7 KB | 363.1 KB | ≤ 335 KB |
| First screen | 715.7 KB | 691.6 KB | ≤ 680 KB |
| Thread route | 338.0 KB | 328.5 KB | ≤ 345 KB |

Both initial and first screen remain over. Coverage of the startup chunk on an open thread (`--mode perf`) puts the rest in a long tail: about 85 KB minified, roughly 25 KB gzip, across 77 shell modules each under 10 % run, beside React DOM, the router, Zod and Base UI's tooltip roots. The thread route's unrun code is transcript content (steps, subagents, attachments, ace tool specs) that a thread holding such items draws on its first paint, so deferring it would make content appear late.

## Amendment (2026-11-12): worker budgets reset; page budgets kept

Both workers outgrew the 102 KB budget for a worker with the chunks it loads later: the client worker measured 126.1 KB and the machine worker 129.4 KB. Their eager scripts stayed near their size at the October reset (81.2 and 84.7 KB); the growth is about 28 KB of later chunks the two share, loaded through `loadServiceWire()`. Part of it is the service schemas of features added since (machine codes, relay pairing, admission, updates, transfers, outside clients, locked use, Skills, Spade), which the workers keep parsing because the socket is a trust boundary (ADR 0125). The rest is transport: the portable relay with its Noise handshake and flow control, which `relay-route.ts` loads on demand. These chunks are not in the page's static closure and run off the main thread, though `ClientCore.start()` asks for the service schemas at once, so they can download while the first screen loads.

The owner chose to reset the worker budgets to today's sizes plus a little headroom: a worker with its later chunks 135 KB, a worker's eager script 87 KB. Both a worker's eager script and its total stay budgeted: the first guards a worker's startup, the second keeps moving bytes behind `import()` from passing the check. The bundle report now also prints each worker's later chunks alone, without a budget of its own.

Initial JS (335 KB), first screen (680 KB), routes (345 KB) and CSS (30 KB) stay as they are. Initial JS is 30 KB over and the first screen 15 KB over; moving startup code into the thread route can't close both, as that route has only 15 KB left, so the round that follows removes code from startup rather than relocating it, starting with the classic Zod schemas startup still reaches.

## Amendment (2026-11-12): round budgets

The owner asked for round bundle budgets, and whole kilobytes in the report: initial JS 350 KB, first screen 700 KB, route 350 KB, CSS 30 KB, a worker's eager script 90 KB, a worker with its later chunks 140 KB. They replace the numbers above (335, 680, 345, 30, 87 and 135). The check still compares exact sizes. The first screen (693 KB) now passes; initial JS (364 KB) stays over until startup code comes out.

## Amendment (2026-11-12): initial JS budget 365 KB

The startup round got initial JS from 364 to 361 KB. Zod stays at startup because the thread route needs it too, so taking it out of startup only moves it into that route. The rest would need the tooltip and hover-card code out of startup (about 17 KB), either as ace's own smaller implementation or by swapping triggers in after their code loads, both UI risks. The owner chose to stop here and set the initial JS budget to 365 KB. The other budgets are unchanged.

## Amendment (2026-11-14): boot and load order

A cold load of a thread over a slow link (`tools/web-perf/src/slow-link.ts`: 300 ms round trip, 1.6 Mbit/s down, cold cache, report only) waited on a chain of requests, each discovered only once the one before it had run. The boot now starts each piece as early as it can be known:

- The built page modulepreloads the entry's static closure, and a small inline script (hashed into the content policy) adds low-priority preloads for every chunk and stylesheet of the route at the loaded address (a thread, or Home; `apps/web/route-preloads.ts`). Low priority, because over HTTP/1.1 the route's many small chunks would otherwise hold the initial chunk and the client worker's script in the browser's six-connection queue.
- The thread route's loader follows the thread on every load, not only on preload, so its saved copy and the daemon's snapshot load alongside the route's code.
- A browser with a machine stored starts its client worker and the kept lookups' code from the page's entry; the gate still decides where the worker connects, and the first worker client takes it.
- An outbox already carried over reads only its own IndexedDB database at start. `connection.start()` still waits for the intents to load: the welcome replays pending intents, and a send before they are loaded fails with `storage`, so starting the socket earlier could leave saved sends unsent until the next reconnect.
- The machine pool starts once the startup screen has left and the browser is idle, unless the address opens a view on another machine (`?machine=`).
- Only the sidebar's thread lists and the thread view hold the startup screen; other skeletons show in place.
- The daemon sends the page and icons `no-cache` with an ETag from a hash of their bytes (304 on a repeat load; an update that keeps size and timestamp still changes it), and serves the `.br` and `.gz` copies the build writes beside each hashed asset of 16 KB or more (`apps/web/precompress.ts`) when they resolve inside the renderer, compressing the rest on the fly as before. The build fails if the written page has an inline script its policy doesn't allow by hash. The release archive leaves those copies out to stay within the oldest updater's 2,048-entry budget; the desktop app ships them.

On the perf build the slow-link load went from 14.6 s to 12.2 s to the first transcript message, and from 5 to 3 sequential round trips. The rest is the thread route's ~175 chunks: on six connections at 300 ms each they take about nine seconds whenever they start. Fewer, larger lazy chunks (or HTTP/2) are what would close it; Rolldown's `entriesAware` merge was tried and left the thread route at about 160 files while changing every route's weight, so it is not part of this change.
