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
- A hidden tab (`visibilitychange`) receives nothing; when shown it receives every key that changed meanwhile. Tabs ping every 5 s; a tab silent for 30 s is dropped and its leases released. A client outlives its last tab by 10 s so a reload reattaches to a warm socket.
- The outbox moves from `localStorage` (unreachable from workers) to IndexedDB, one record per daemon and device, replaced in one transaction. An older build's `localStorage` outbox is carried over once.
- Trust boundary: tab and worker are the same build on one origin. Envelopes are checked with Zod at both ends and request arguments are decoded in the worker; entity payloads were decoded from the daemon's frames by `@ace/protocol` schemas in the worker and are not decoded a second time in the page (`trusted()` in `packages/client-worker/src/trusted.ts` is the only place that asserts their type).

### Rendering cadence

`ClientProvider` takes a `NotifyBatch`. The browser entry uses `frameBatch(requestAnimationFrame)`: every selection that changed during a frame reaches React together on the next animation frame, where React renders them as one update. Hidden documents get no animation frames and so render nothing. Tests notify immediately. Panel tabs that are not showing stay mounted inside React `<Activity mode="hidden">`: their effects (subscriptions, xterm, GPU views) stop, updates render at idle priority, and the tab comes back as it was left.

### Bounded memory

Nothing grows with history. Every cache is an `LruCache` (`@ace/ui-core`, bounded by entries and by weight) or an existing client limit:

| Holder                                   | Bound                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Thread window (client, and each mirror)  | 200 items; older history pages in on demand and the window stays at 200              |
| Cached thread stores                     | 32, least recently used released first                                               |
| Item text                                | 64 Ki UTF-16 units per item; overflow keeps the tail and marks truncation            |
| Agents, runs, interactions, tasks, usage | 4,096 each; the oldest ended runs no loaded item belongs to are evicted              |
| Markdown documents / blocks              | 400 documents and 16 MB / 4,000 blocks (page); highlight 512 and 4 MB (worker)       |
| File diffs                               | 600 diffs and 200,000 rows in memory; 2,000 in IndexedDB, oldest use pruned          |
| Terminal                                 | 1 M characters of raw output per PTY for late-mounting views; xterm scrollback 5,000 |
| Selection listeners                      | 4,096 per store                                                                      |

The month-long soak found the one unbounded holder: every run stayed in the thread store, and after 4,096 turns the thread failed with "Entity capacity exceeded". Ended runs that no loaded item belongs to are now evicted oldest first; active runs and the window's runs stay, so status and turn grouping never depend on an evicted run.

### Markdown and highlighting

Markdown becomes top-level blocks keyed by the hash of their source (`contentHash`, a fast non-cryptographic hash, in `@ace/ui-core`), built in the markdown worker with highlighting cached per (language, code). The page interns blocks by key, so an unchanged block keeps its object and skips rendering; while a message streams only its last block changes. Each mounted message asks for at most one document at a time, always for its newest text, and keeps its previous document on screen until the next is ready. No HTML string is ever produced; blocks render through the same safe React renderer as before.

### Diffs

`@ace/ui-core` splits diffing into `groupFileChanges` (cheap), `fileDiffKey` (a content key over every change of a file, standing in for old and new blob ids, plus the diff options) and `diffFile`. The Changes tab and its stat read diffs through a service: memory LRU, then the diff worker, which checks its IndexedDB copy before computing, so a reload or another tab does not diff the same content twice. Files over 400 rows mount only the rows near the panel's viewport (`VirtualRows`, rows kept in flow so wide lines still scroll sideways). With the `gpuText` flag (`localStorage["ace.flag.gpuText"] = "1"`), a diff of 5,000 or more rows is drawn by the GPU text renderer: a glyph atlas rasterised once and one instanced draw per frame of the visible lines and columns, at whole-device-pixel cells. The renderer is chosen by capability (a WebGPU adapter, else WebGL2), downgrades on the first validation error or lost context, and "Show as text" returns to the DOM view, which remains the accessible one (line comments need it).

### Terminal

Where WebGL2 exists, PTY terminals use xterm.js (loaded on first show) with its WebGL addon, falling back to xterm's DOM renderer if the context is lost; elsewhere the accessible line screen stays. Sessions keep a bounded raw output log so a view mounting late replays what it missed. Colours come from the theme tokens through `lib/css-color.ts`, which turns any CSS colour syntax into RGBA for canvas and GPU consumers.

### Budgets

`bun run check:perf` (part of `bun run check`; `tools/web-perf`) enforces, from `tools/web-perf/src/budgets.ts`:

| Budget                                                                                   | Limit     | Measured on 2026-10-03          |
| ---------------------------------------------------------------------------------------- | --------- | ------------------------------- |
| Initial JS, gzip (entry and its static imports)                                          | ≤ 345 KB  | 312 KB                          |
| Any route's own chunks, gzip                                                             | ≤ 140 KB  | thread 134 KB, settings 70 KB   |
| CSS, gzip                                                                                | ≤ 22 KB   | 18 KB                           |
| Each worker, gzip                                                                        | ≤ 70 KB   | client 60, diff 48, markdown 39 |
| Month-long soak: 3,000,000 events through client, host and mirrors, retained heap growth | ≤ 12 MB   | −3 MB (flat, 24 MB)             |
| Events streamed in the browser run                                                       | ≥ 5,000/s | 5,000/s                         |
| Input to next paint, p95, while streaming                                                | ≤ 100 ms  | 80 ms                           |
| Longest main-thread task while streaming                                                 | ≤ 200 ms  | none over 50 ms                 |
| Share of the run in long tasks                                                           | ≤ 10 %    | 0 %                             |

- Bundle: one production build, weighed per route from the Vite manifest.
- Soak: `SoakDaemon` (`@ace/fake-daemon`) is an endless agent: one exchange folded through `@ace/core` once and replayed with fresh ids, keeping a bounded window, so it publishes millions of events at a fixed cost and growth measured in the process is the client's. Its clock runs 30 days over the run.
- Browser: the production build in `--mode perf`, whose client worker is fed by `SoakDaemon` at 5,000 events/s, in Chromium while a person types into the composer and scrolls the transcript. Long tasks and Event Timing are recorded from first paint; the run first checks that its detector sees a deliberate 120 ms task.

The initial-JS budget is a ratchet at today's size. Declaring `sideEffects` in `apps/web` (so a route importing one component from a slice's index no longer pulls in the slice) and loading the palette lazily took it from 501 KB to 328 KB. The page then still bundled the in-page `Client` (used only where the browser has neither worker) and with it the protocol's frame schemas; loading that fallback on demand (`boot/page-client.ts`) and declaring `sideEffects: false` in `@ace/client` and `@ace/client-worker` (so the page's `RemoteClient` no longer drags in `Client`, `ClientHost` and their request schemas through the package indexes) took it to 312 KB. ADR 0045's 200 KB target needs the shell's view chrome split by route.

CI runs the bundle and soak budgets in the `check` job and the browser budgets in the `browser` job.

## Consequences

- The UI binds to interfaces, not to `Client`. Anything that needs the concrete class (tests, the worker) constructs it; everything else takes `ClientApi`.
- One socket per origin instead of one per tab. A crashed tab holds its leases for up to 30 s.
- Where only dedicated workers exist, each tab has its own client and they share one outbox key, as tabs did with `localStorage` before; concurrent tabs can overwrite each other's pending intents there.
- `vite --mode fake` keeps the fake daemon and client in the page (the console handle `ace.daemon` needs it); `--mode perf` exercises the worker path.
- The GPU diff view is read-only and not readable by screen readers; it announces itself and offers "Show as text". It stays behind a flag until it supports line comments.
- Evicted runs mean history paged in long after its turn ended may not group under that turn in the Changes tab.
- Browser budgets depend on the runner; a budget failure on a loaded machine is re-run before it is believed.
