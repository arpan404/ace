# @ace/web

The ace client: React 19, Vite, TanStack Router (file routes), shadcn/ui on Base UI, Tailwind v4. Electron will load this same bundle. Read ADR 0045 (stack), 0004 (agent tree and status), 0006 (windowing) and 0030 (client SDK) first. The approved design is `ace-ui-prototype/index-fable.html` with its spec `DESIGN-fable.md`; match it, except that its rail and per-view second sidebar are now one sidebar (see Sidebar below).

```sh
bun run web:dev:fake   # whole app against the in-page fake daemon
bun run web:dev        # against a real daemon (`ace start`); the app asks for the token
bunx vitest run apps/web/src/features/<slice>   # your tests only
bun run web:e2e        # Playwright journeys: fake daemon + a real daemon with scripted providers
bun run web:screens    # every screen in Dark and Light to /tmp/aceshots-web
```

Import `cn` from `@/lib/cn.ts`, never from `cn` directly: the local one knows the type scale
(`text-ui`, `text-md`, ...), so a font size never knocks out a text colour.

## Layout of `src/`

| Path                | Owner      | What lives there                                                                                                                    |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `theme/`            | foundation | Theme engine: presets from seeds, token list, CSS generation, contrast checks, custom theme files, `ThemeProvider` / `useTheme()`   |
| `styles/`           | foundation | Static tokens (`tokens.css`), Tailwind mapping and base styles (`index.css`), vendored shadcn variants                              |
| `components/ui/`    | foundation | Owned primitives restyled to the design. Slices use them, never fork them                                                           |
| `components/`       | foundation | `Icon`, `SettingRow` / `SettingSection`, `StatusPill`, `DataTable`                                                                  |
| `lib/`              | foundation | `keymap.ts` (every shortcut), `hotkeys.ts` (`useHotkey`), `layout.tsx` (sidebar and panels), `history-nav.ts`, `time.ts` (`useNow`) |
| `boot/`             | foundation | Client construction, daemon URL and token handling, fake boot, the fake backend for features without protocol (`fake-backend.ts`)   |
| `features/shell/`   | foundation | `AppSidebar`, `SidebarFrame`, `ViewFrame`, `ViewSidebar`, `AppHeader`, `Screen`, panels, connection notice, `useWorkspaces`         |
| `features/<slice>/` | the slice  | Everything for one slice: components, hooks, adapters, tests. Its `index.ts` is the only door in                                    |
| `app/`              | app        | Composition of several slices: `AppShell` (sidebar, palette, notifier), `ConnectionGate`                                            |
| `routes/`           | per route  | TanStack file routes: route definition, search schema and params only. Screens live in the slice                                    |

Headless view logic (status wording, Home ordering and settling, thread cards, work-log and diff
summaries, relative time, the Deck model) lives in `packages/ui-core` (`@ace/ui-core`) so the Expo
app shares it. Put a pure rule there, with its tests, rather than in a slice.

## Motion and states

One motion system, in `styles/motion.css` (tokens `--dur-1..4`, `--dur-exit`, curves `--ease`,
`--spring`, `--sheet`, `--leave`, distances `--rise`, `--slide`, all zeroed under
`prefers-reduced-motion`) and `lib/motion.ts` (when things enter, leave or move). Animate
transform and opacity only.

- Popovers, menus, selects and tooltips use `popupMotion` from `components/ui/menu-styles.ts`.
- Panels and the sidebar: `usePresence(open)` keeps them mounted for their exit;
  `panelMotion(presence)` plays `fx-panel-in` / `fx-panel-out` only after a toggle.
- Virtualized lists: `useListMotion(items, keyOf)` gives each row a phase (`rowMotion`) and a
  `moving` flag for `fx-list-moving`; put the class on an inner wrapper, never on the row that
  carries the virtualizer's transform. The list choreography itself is `diffList` /
  `withLeaving` in `@ace/ui-core`.
- Plain lists: wrap in `ArrivalScope` and give rows `useArrival()`; rows that mount after the
  list painted rise in.
- Theme and accent switches cross-fade through `withViewTransition`.
- Loading: `ListSkeleton`, `SkeletonText` and `LoadingRegion` from `components/ui/skeleton.tsx`,
  shaped like the content. Never show an empty state before the data has arrived
  (`useSidebarLoaded()` for the thread list, `query.data === undefined` for reads).
- Boot: `index.html` paints a static, themed shell (`#boot`) before the script runs; the app
  shell and the connection screen fade it out with `useDismissBootSplash()` (`lib/boot-splash.ts`).
- Toasts stand clear of the composer: it registers with `useToastClearance` (`lib/toast-clearance.ts`).

## Window sizes

The widths the shell adapts at live in `lib/breakpoints.ts` (`usePhone`, `useSidebarInline`, ...),
in line with Tailwind's `sm` and `md`. Below 640px the header folds its actions and ⋯ menu into
one and panels open as a sheet over the content. Below 768px the sidebar is a sheet opened from the
header (it closes once a place is chosen); below 1100px it steps down to icons while a right panel
is open; below 1152px panels float over the content.

## Sidebar

One sidebar, as in desktop chat apps (`features/shell/app-sidebar.tsx`, composed in
`app/app-shell.tsx`): the `ace` wordmark (Home), New thread (⌘N) and Search (⌘K); a row per view,
Activity with its needs-you count, Deck, Automations and Skills (`g a`, `g d`, `g u`, `g s`;
`g h` is Home); More, a menu of usage and accounts, files and search; the current view's own list;
and at the foot the connection dot and account menu, Settings (⌘,) and the switch to icons.

- `SidebarFrame` owns where it sits (inline, sheet, hidden with `⌘\`, collapsed to a 68px column
  of icons with tooltips) and stays mounted for the app's life. Hidden and collapsed are the
  person's choice, persisted in `ace.layout` (`sidebarOpen`, `sidebarCollapsed`).
- A view's list is the `sidebar` of its layout route's `<ViewFrame>`, drawn into the sidebar's
  body through a portal, so it keeps the route's providers. It is the only part that scrolls;
  collapsed, it stays mounted and hidden.
- The More and account menus are there from the start; their contents load just after the first
  paint (`SidebarMenu`), keeping their icons and wording out of the initial bundle. More's pages
  are defined once, in `features/more/pages.ts`; the app layer hands the sidebar More's menu.
- `⌘\` is bound by `SidebarFrame`: it opens and closes the sheet on a narrow window and hides or
  shows the sidebar elsewhere, so a narrow window never changes the wide window's choice.
- New thread (the row and ⌘N) starts in the project Home is narrowed to, else the last one used.
- The desktop app styles `data-sidebar` (`expanded`, `collapsed`, `hidden`) and the `sidebar-top`,
  `sidebar-wordmark` and `header-nav` slots so the macOS traffic lights never cover a control (as
  icons, the top row grows so the wordmark, the Home link, sits below them).

## Module boundaries

`bun run check:deps` (dependency-cruiser, config in `.dependency-cruiser.cjs`, part of `bun run check`) enforces:

- A slice is imported only through `features/<x>/index.ts`; inside a slice, import files directly, never its own index.
- `components/`, `lib/`, `theme/`, `styles/` and `boot/` never import `features/`, `app/` or `routes/`.
- Slices never import `app/` or `routes/` (tests may mount the whole app).
- No circular imports, type-only ones included, in `apps/web` and the client packages.
- `@ace/ui-core` imports no React, DOM libraries, Node built-ins or app code.

Inside a slice, keep the split: pure view-model mappers (in `@ace/ui-core` when the logic is
platform-free), a data hook that reads `@ace/client-react` and returns the view model, and pure
presentational components that render it (see `home/use-thread-card.ts` and `home/row-parts.tsx`).

## Feature-folder convention

Each slice owns `src/features/<slice>/` and the route files for its screens:

| Slice                                                                              | Folder                                                                       | Routes                                                          |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Home (thread list, New thread)                                                     | `features/home`                                                              | `_home.tsx` (its sidebar), `_home.index.tsx`, `_home.new.tsx`   |
| Thread (transcript, composer, header actions)                                      | `features/thread`                                                            | `_home.t.$threadId.tsx`                                         |
| Thread workspace tools (Changes, Files, Browser, Preview, Agents, Terminal, Logs)  | `features/panels`                                                            | tab kinds of the thread screen (`threadWorkspace`)              |
| Devices (a catalog of simulators and emulators, a tab per device)                  | `features/devices`                                                           | none; loaded with the panel tabs                                |
| Activity                                                                           | `features/activity`                                                          | `activity.tsx`, `activity.index.tsx`                            |
| Deck (`@ace/conductor`)                                                            | `features/deck`                                                              | `deck.tsx`, `deck.index.tsx`, `deck.new.tsx`, `deck.$runId.tsx` |
| Automations                                                                        | `features/automations`                                                       | `automations.tsx`, `automations.index.tsx`                      |
| Skills                                                                             | `features/skills`                                                            | `skills.tsx`, `skills.index.tsx`                                |
| Thread organization (actions, Undo, the shared thread menu)                        | `features/organize`                                                          | none; used by Home, the thread ⋯ menu and the palette           |
| Projects (Add project: open, create, clone; rename, remove; first-run empty state) | `features/projects`                                                          | none; `/new?folder=` renders its `OpenFolderScreen`             |
| Model catalog (pickers)                                                            | `features/models`                                                            | none; used by thread and Home                                   |
| More: accounts, files, search                                                      | `features/more` (+ `features/accounts`, `features/files`, `features/search`) | `more.*.tsx`                                                    |
| Settings                                                                           | `features/settings`                                                          | `settings.*.tsx`                                                |
| Palette                                                                            | `features/palette`                                                           | none; register commands in `commands.ts`                        |

Rules:

- A screen renders `<Screen title subtitle menu summary actions workspace>` from `features/shell/screen.tsx`. Don't build another header or panel container. Docks and their tabs are declared as tab kinds (see Workspace tabs); the shell owns open state, order, sizes, persistence and the shortcuts.
- A view's list in the sidebar is the `sidebar` of its layout route's `<ViewFrame>`. Use `<ViewSidebar title actions toolbar>` or `<SidebarHeader>` for its heading.
- Live state (threads, sidebar, agent tree, interactions, intents) comes only from `@ace/client-react` hooks. TanStack Query is only for one-off reads. Never copy live state into Query or React state.
- Primitives you need but don't find in `components/ui` belong to the foundation: add them there, styled from the design tokens, not inside your feature folder.
- Shortcuts are added to `lib/keymap.ts` and bound with `useHotkey(keymap.x.keys, …)`; tooltips take `shortcut="x"`.
- Provider, ACP agent and model marks are `ProviderIcon` / `ProviderIconTip` from
  `components/ui/provider-icons.tsx`, never an inline logo. Which brand stands for what is
  `@ace/ui-core/provider-icons`; the marks are LobeHub Icons, regenerated with `bun run icons:providers`.
- Colour only for diff +/− and the needs-you and failed dots. Use `text-muted-foreground` / `text-subtle-foreground` for hierarchy, and weights 400/500 (600 for titles only).
- Keep files under ~400 lines (hard limit 1,500, `bun run check:size`).

## Workspace tabs (side and bottom docks)

A screen with docks passes `workspace={{ scope, definition }}` to `<Screen>`; the thread screen
passes its id and `threadWorkspace` (`features/panels/thread-workspace.ts`). A **tab** is one
opened resource (Changes, a terminal, a browser page, a file); a **dock** (`right` beside the
column, `bottom` under the column and the right dock) shows one tab at a time. Hiding a dock keeps
its tabs; closing a tab removes one resource. Each scope (thread) keeps its own tabs, showing tab,
open docks, sizes, full view and pinned summary (`lib/workspace`, persisted under
`ace.workspace`, the 64 most recently changed threads); the last resize anywhere is the size new
threads start at.

The shell owns the strip (order, drag and keyboard reorder, close, pin, move between docks,
overflow, the + launcher), sizes, full view, motion, persistence and shortcuts. A tool declares a
**kind** in `features/panels/thread-kinds.tsx`, a module that loads after the thread screen's
first paint, so a kind's icon, badge and loader never weigh on the route (ADR 0056):

```ts
import { defineTabKind } from "@/lib/workspace/index.ts";

export const fileKind = defineTabKind({
  kind: "file", // persisted with every tab: never rename one that shipped
  label: "Files",
  icon: FilesIcon,
  docks: ["right"], // allowed docks, preferred first (default: right)
  singleton: false, // one tab per id; `true` for a per-thread tool like Changes
  pinned: false, // `true` opens as a tool tab at the front, without a close button
  launcher: 30, // position on the + launcher; leave out to keep it off
  title: (tab) => basename(tab.id), // else the title the view last reported, else `label`
  load: () => import("./file-tab.tsx"), // { default: View, Actions? }, loaded on first show
  onClose: (scope, tab) => {}, // release what only this tab held
  fromFile: (path) => ({ kind: "file", id: path }), // lets the launcher's Suggested open files
  fromUrl: (url, workspace) => ({ kind: "browser", id: "2", data: { url } }), // the launcher's address bar
  onShortcut: (scope) => {}, // the tool's shortcut does this instead of showing its tab (⌘P)
  Overlay: QuickOpen, // drawn once per screen outside the docks (a palette the shortcut opens)
});
```

- List the kind in `threadKinds`. If it has a shortcut, add `kind → keymap id` to `shortcuts` in
  `thread-workspace.ts` (bound from first paint; pressed before the kinds have loaded, the tool
  opens once they have). Nothing in the shell changes.
- The view gets `TabViewProps` (`scope`, `tab`, `dock`) and reads live state from
  `@ace/client-react` as any screen does. Tabs not showing stay mounted inside
  `<Activity mode="hidden">`; a view whose code fails to load shows the error and Try again in
  its own tab.
- `Actions` renders at the end of the dock's strip while one of the kind's tabs shows (New
  terminal, Clear).
- Open things from anywhere with `useWorkspaceActions(threadId).open({ kind, id?, data? })`;
  opening a resource that is already open shows it (applying `data`). `data` is JSON kept with the
  tab across reloads: validate it in the view, it comes from storage.
- A view that learns a better title (a page's title, a file name) calls
  `useWorkspaceActions(scope).update(tab.key, { title })`.
- A tool the daemon can't serve yet still registers, with a view that says exactly what is
  missing (`features/panels/placeholders.tsx`); replace it by registering a kind with the same id.
- A view that needs another slice's components (an agent tab draws the transcript's blocks, a
  deck-lane tab draws Deck's lane) reads them from `useThreadParts()`: the thread screen and the
  thread route hand them down through `ThreadPartsProvider`, since those slices import the panels
  and the panels can't import them back. Hand down lazy components so the route stays light.
- Resource tabs so far: `agent` (one per agent of the tree), `deck-lane` (`run/card`), `device`
  (one per simulator or emulator, from the Devices catalog) and `port` (one per dev server,
  from Preview).

Files (`features/panels/files`): one tab per checkout file (`files:file:<path>`; the empty tab is
"Open file"), the checkout tree beside it (over it in a narrow panel) and ⌘P quick open. Search
is the daemon's path index (`context.request` `mention.complete`); bytes go through the files
channel (`ClientApi.downloadFile` / `uploadFile`, thread-scoped `files.request`). The wire has no
directory listing, so the unfiltered tree shows the files the thread touched and says so. A click
in the tree previews a file in the tab it came from; Enter, double-click or quick open keeps it.

Browser (`features/panels/browser`): one tab per page over the thread's single live page (the
browser service keeps one session per thread). Each tab keeps its address and history in its
data; the tab that last navigated shows the page live (`loading.ts` `pageOwners`), others offer to
load their own address there. Navigating takes the control lease (the daemon refuses a person's
commands without it). In the desktop app an `embedded` page is the app's own native view,
drawn over the tab's page area (`browser/native-view.ts`); it steps aside while anything is
drawn over it, and the last screencast frame shows meanwhile. A tab whose page isn't open (after
a restart) offers to open its address again. Back and Forward re-open the tab's earlier
addresses: the relay has no history or stop commands. Preview is only a thread's dev servers through the preview gateway.

Shortcuts (`lib/keymap.ts`): ⇧⌘B side panel, ⌘J bottom panel, ⇧⌘F full view, ⌥⌘T new tab,
⌥⌘W close tab, ⇧⌘] and ⇧⌘[ next and previous tab, and each tool's own (⇧⌘D Changes, ⌃⇧A Agents,
⌃` Terminal, ⌃⇧B Browser, ⌃⇧P Preview, ⌃⇧M Devices, ⌃⇧L Logs, ⌘P quick open, ⌥⌘S Side chat).
In a browser tab: ⌘L the address, ⌘R reload, ⌘[ and ⌘] back and forward; in a file, ⌘F find. While a
terminal shows, ⌃⇧` opens another and ⌘F finds in its scrollback.

### Terminals, agent shells and Logs

`features/panels/terminal/tabs.ts` names them (open them with `useWorkspaceActions(threadId).open`):

- `{ kind: "terminal", id: <pty id> }`: one of your PTYs. Closing its tab ends the shell (through
  `terminal/closing.ts`, since `onClose` has no client); hiding the dock never does. Rename keeps a
  tab title for this thread on this device.
- `{ kind: "terminal" }`: a terminal that starts when it first shows, picking up a running PTY of
  the thread that no tab shows, else opening one (the launcher, ⌃`, the bottom panel's first tab).
`openNewTerminal` always starts a new shell, reusing that tab if it hasn't started yet.
- `{ kind: "shell", id: <task id> }`: an agent's background shell, read-only (Stop where the
  provider allows; Take over says why it can't). Closing the tab leaves the shell running.
- `{ kind: "logs", id? }`: the thread's log (no id), one agent's subtree (`agent:<id>`) or the
  daemon's health (`daemon`); the level and source filters are kept in the tab's `data`.

Inside a terminal the shell keeps Ctrl keys (`terminal/keys.ts`); ⌘ and Ctrl+Shift shortcuts stay
ace's, and ⌃` always leaves. Colours come from the theme (`terminal/palette.ts`): 13px text on 20px
rows. In a strip: arrows
move between tabs and show them, Home and End jump, Delete closes, Alt+Shift+arrows reorder;
right-click (or the context-menu key) for pin, move, full view and close.

## Long threads

A thread can run for days: millions of items, thousands of approvals, dozens of subagents. The
thread screen reads it through the daemon's long-thread APIs (ADR 0062), never by holding it.
`features/thread/long/` owns this:

- **Navigation state** (`nav.tsx`): one `ThreadNavProvider` per open thread holds the jump
  controller, which tools are open, and two values the transcript reports as the reader scrolls
  (the turn at the top, whether the reader follows the live end), as small external stores so
  a scroll re-renders only what reads them. It also tracks the newest turn the live tail shows.
- **Jumping** (`jump-controller.ts`): beside the leased live tail, at most one window of up to
  200 items (`items.window`) around a turn or a sequence (a search hit). A new jump replaces it.
  It slides 100 items at a time only as the reader scrolls toward an edge (code moving the view
  never slides it), never growing. When it overlaps the tail it joins it: the transcript shows
  the window then the tail's newer items, deduplicated, until the reader follows the live end
  and the window is dropped. The transcript renders both through `ThreadWindowProvider` from
  `@ace/client-react`, so every thread hook reads the window's items while agents, runs and
  interactions stay live. Pure rules (sliding, meeting the tail, a window item's turn) are in
  `@ace/ui-core` (`jump-window.ts`).
- **Turn index** (`turn-index.ts`): `turns.page` read in fixed blocks of 50 ordinals, each a
  TanStack Query entry dropped 20 s after nothing shows it. The newest turn the live tail shows
  keys the head read, so new turns re-read the head and the block they land in without polling.
- **Transcript rows** (`transcript/rows.ts`): live, the three newest turns show whole and older
  ones fold to one digest row (`FoldedTurn`); in a jumped window the turn jumped to and later
  ones show whole and earlier ones fold. Opening a folded turn adds a header that folds it again.
- **Follow mode**: at the live end new output scrolls into view; scrolling up pauses it and
  `LivePill` offers Jump to live with how many items arrived meanwhile.
- **Catch-up and read state** (`catch-up.ts`): on opening, this device's `thread.readState`; if
  the thread moved on since, `thread.catchUp` from that cursor fills the card (lazy). Reading it
  never asks a provider; Summarise sends one ordinary `thread.send`. While the reader follows the
  live end of a visible page the cursor advances (`markThreadRead`, coalesced by the client).
- The timeline (`timeline.tsx`), search (`search-bar.tsx`, CSS Custom Highlight marks in the
  transcript), the catch-up card, the jump bar and gap, folded turns' digests and `LivePill`
  load after first paint through `deferred.ts`; so do the jump controller (`jump.ts` loads it on
  the first jump or when idle) and ⌥⌘↑ ⌥⌘↓.

Shortcuts: ⌥⌘G turns, ⌘F search this thread (a file or terminal tab's own find wins while it
has focus), ⌥⌘↑ and ⌥⌘↓ the previous and next turn (past the loaded turns they jump), and in
the timeline ↑↓, Page Up/Down, Home/End, Enter and Esc. `/t/<id>?seq=<n>&q=<words>` opens a
thread at an item (a search hit in a linked subagent thread). `bun run --filter @ace/web-perf
long-thread` measures all of it on the synthetic million-item thread (`?long=1` in perf mode).

## Projects

`features/projects` adds and manages projects over `ClientApi.projects` (ADR 0063). `ProjectsHost`
(in the app shell) owns ⇧⌘O, a folder dropped on the window, the dialogs and keeping the shared
project list (`lib/project-cache.ts`) live from the daemon's workspace pushes; open a dialog from
anywhere with `useProjectDialogs().open({ kind: "add", tab })` (or `rename`, `remove`). The dialogs
load on first use (`dialogs-loader.ts`) and stay mounted, so a clone carries on with its dialog
closed. Every path is the daemon host's: the web picks folders with `fs.browse`; the desktop app
adds its native picker and dropped-folder paths (`boot/desktop-folders.ts`, `window.ace.dialogs`
and `window.ace.files`). `/new?folder=<path>` (the desktop's `ace://open?folder=`) adds or finds
the folder and opens New thread in it. Wording, name and address checks live in
`@ace/ui-core` (`projects.ts`). In fake mode `hostFolders()` seeds a home to browse, and
`aceFakeWorld = "empty"` boots the first run.

## Daemon services and protocol gaps

One-off daemon reads and writes go through `Client.request` (correlated, never queued while
offline) with `useDaemonQuery` from `lib/daemon-query.ts`, which waits for a ready connection
and reads again after a reconnect. Live state still comes only from `@ace/client-react`.

Wired on the wire in every mode: accounts and usage (`accounts.list`, `usage.series`,
`usage.summary`, `usage.session_totals`), threads
per account from the live list and moving a limited thread (`queue.get`, `thread.limit` /
`migrate_now`), search (`search.query`), models (`models.list`, `models.refresh`), settings
(`settings.subscribe` / `settings.set`, every key in the protocol's `SettingsValues`, including the
run-out policy `threads.limitPolicy`; `lib/daemon-setting.ts` for one key), slash commands
(`commands.list`), mentions and uploads (`context.request`, with a draft scope before New thread's
first send), thread organization and transitions (rename, pin, read, settle, snooze, archive,
delete, fork, switch; `lib/daemon-command.ts` turns refusals into sentences), card details (each
entry's `details`), New thread's branches (`branches.list`) and `thread.create` options, the
server queue with its recovery and limit controls (`queue.get`, `queue.*`, `thread.limit`;
`lib/server-queue.ts`), the thread's checkout (`workspace.request` reads; `workspace.script.run`,
`workspace.editor.open`, `git.commit`, `git.push` and `forge.pr.create` commands), terminals
(`terminal.request`, credit-paced `terminal.output`), the browser relay (`browser.*`, ACKed
frames), dev servers (`preview.request`), shell output (`output.read`) and More › Files (each
thread's `items.page`), Deck runs (`conductor.request` and `conductor.*` commands), automations
(`automation.*`), skills and plugins (`pluginRequest`), and the Activity feed (forge `pr.status`
and Deck escalations). In fake mode `@ace/fake-daemon` serves the same messages from its catalogs
(`packages/fake-daemon/src/services/`), so a feature has one code path.

Beside the socket, the connection carries its `endpoint` (`boot/connection.tsx`): the daemon's HTTP
access routes for paired devices, pairing and revoking (`AccessClient`; the daemon allows these
bearer-token routes from the app's origin), and the dedicated devices channel for the Devices panel
(`DeviceClient` over `deviceTransport` from `@ace/client/devices`). Fake mode points both at the
fake daemon (`FakeAccess`, `FakeAppDevices`).

What `main` cannot carry yet sits behind one adapter per feature marked
`// TODO(client-gaps): feat/client-protocol-gaps`. In fake mode it serves the fake daemon's
stand-in; against a real daemon it reports the feature empty or unavailable, never fixture data.
Today: a list of machines and adding an ACP agent by command
(`features/settings/data/access-gaps.ts`), and More › Files uploads (`features/files/files-source.ts`;
the side panel's Files tool already uploads into the thread's checkout over the files channel).
When the backend lands, wiring a feature changes only its adapter.

## Fake-daemon scenarios

`packages/fake-daemon` speaks the real wire protocol in memory, and scenario facts are folded through `@ace/core`, so status is derived the way the daemon derives it.

- Add a scenario under `packages/fake-daemon/src/scenarios/<name>.ts` returning a `Scenario` (`thread` plus `steps` of facts or `await` an interaction). Use the builders in `facts.ts`. Label the steps tests need to reach (`runThrough("label")`).
- Export it from `packages/fake-daemon/src/index.ts`.
- To seed `dev:fake`, play it in `src/boot/fake.ts` (`runUntilBlocked()` for a static state, `autoplay(timer)` for a live one). `workbench()` is the realistic Home list from the design.
- Use realistic content (projects, branches, commands, findings), not placeholder text.
- Backdate seeded history: a step's `agoMs` stamps it that long before now, and
  `new ScenarioPlayer(daemon, scenario, { agoMs })` plays a whole scenario earlier, so ages and
  "Worked for" durations read as real time. `daemon.itemId(threadId, key)` gives the item id an
  adapter key became (the fake boot uses it to seed where the reader left the hero thread).
- `dedupeReconnect()` is the design's hero thread (work log, answer, changed files, subagents,
  background relay, a finding after the reader left); `bun run web:screens` shoots it.
- In tests, `harness()` (`src/test/harness.tsx`) gives you the real app, a real client and a `FakeDaemon`: `app.play(scenario)`, `await app.open(path)`.

## Performance

Read ADR 0056. In short:

- The client runs in a SharedWorker (`boot/client-worker.ts`); the page holds mirrors of the stores it reads. Code takes `ClientApi` from `useClient()`, never the `Client` class.
- Heavy derived work goes off the main thread through `lib/off-thread.ts` (see `markdown.worker.ts`, `diff.worker.ts`), and every cache is an `LruCache` from `@ace/ui-core`. Nothing may grow with a thread's history.
- React Compiler memoizes everything. A hook that reads a mutable source by version must return that read as the `useSyncExternalStore` snapshot or opt out with `"use no memo"`.
- Lists that can be long use TanStack Virtual (`components/virtual-rows.tsx` for rows inside a panel).
- `localStorage["ace.flag.gpuText"] = "1"` draws diffs of 5,000+ rows with the GPU text renderer.
- `bun run check:perf` runs the budgets; `bunx vite --mode perf` serves the app against an endless agent (`?rate=` events per second, `?history=` items of older history). `bun run --filter @ace/web-perf memory` measures heaps and DOM size; `MEMORY_MINUTES=60` for a long run.
- Code on the first paint parses with `zod/mini`; classic Zod belongs to routes that parse protocol replies. Something only some screens show loads lazily: a whole surface through a route or `lazy()`, a piece of a screen through `deferredComponent` (`lib/deferred-component.tsx`), warmed with `whenIdle` (`lib/idle.ts`).
- Icons draw only the weights in `icon-weights.ts` (regular, fill, duotone, bold); the build drops the others from every icon.
- `cn` uses tables compiled ahead of time; after upgrading `cn` or changing `lib/cn-extension.ts`, run `bun run --filter @ace/web cn:tables`.
- A view over the whole thread list uses `useSidebarAll` (one key), never one key per thread. A virtualizer whose keys change over time calls `useForgetGoneRows`.
- Timers that drive the UI pause while the page is hidden: use the shared clocks in `lib/time.ts` and `lib/page-visibility.ts` rather than your own `setInterval`.

## Tests

Test behaviour through the UI with Testing Library: what a person sees and does, and what the daemon ends up holding. No snapshots, no markup-structure assertions, no "renders without crashing". jsdom has no layout; `src/test/setup.ts` gives the transcript virtualizer a tall viewport.
