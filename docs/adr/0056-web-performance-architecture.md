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
| Markdown lexing and code highlighting                  | The markdown worker (dedicated), cached by content hash                                                                                                |
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
| Markdown documents / blocks              | 400 documents and 16 MB / 4,000 blocks and 16 MB (page); highlight 512 and 4 MB (worker); a streaming draft is not kept               |
| File diffs                               | 600 diffs and 200,000 rows in memory, shown diffs held; 2,000 entries and 128 MB in IndexedDB, oldest use pruned                      |
| Terminal                                 | 1 M characters of raw output per watched PTY; unwatched ones released on exit, after 5 idle minutes or past 4; xterm scrollback 5,000 |
| Preview and device frames                | One object URL per view, revoked when replaced; nothing decoded or acked while hidden; 8 unwatched threads' state                     |
| Virtual lists                            | Measured sizes of rows no longer listed are forgotten; rows fading out at most 12 changes                                             |
| Activity read marks                      | The newest 10,000                                                                                                                     |
| Selection listeners                      | 4,096 per store                                                                                                                       |

The month-long soak found the first unbounded holder: every run stayed in the thread store, and after 4,096 turns the thread failed with "Entity capacity exceeded". Ended runs that no loaded item belongs to are now evicted oldest first; active runs and the window's runs stay, so status and turn grouping never depend on an evicted run. Closed interactions and ended tasks followed the same way (a pending interaction and a running or `unknown` task always stay). The browser memory run found the second: TanStack Virtual keeps the measured size of every row key it has seen, so a streaming transcript's page heap grew 12 MB in 10 minutes at 5,000 events/s; keys of rows that left are now forgotten.

### Markdown and highlighting

Markdown becomes top-level blocks keyed by the hash of their source (`contentHash`, a fast non-cryptographic hash, in `@ace/ui-core`), built in the markdown worker with highlighting cached per (language, code). The page interns blocks by key, so an unchanged block keeps its object and skips rendering; while a message streams only its last block changes. Each mounted message asks for at most one document at a time, always for its newest text, and keeps its previous document on screen until the next is ready. No HTML string is ever produced; blocks render through the same safe React renderer as before.

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
