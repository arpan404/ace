# @ace/web

The ace client: React 19, Vite, TanStack Router (file routes), shadcn/ui on Base UI, Tailwind v4. Electron will load this same bundle. Read ADR 0045 (stack), 0004 (agent tree and status), 0006 (windowing) and 0030 (client SDK) first. The approved design is `ace-ui-prototype/index-fable.html` with its spec `DESIGN-fable.md`; match it (see Rail and sidebar below for the current shell).

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
| `components/`       | foundation | `Icon`, `SettingRow` / `SettingSection`, `StatusLabel`, `DataTable`                                                                 |
| `lib/`              | foundation | `keymap.ts` (every shortcut), `hotkeys.ts` (`useHotkey`), `layout.tsx` (sidebar and panels), `history-nav.ts`, `time.ts` (`useNow`) |
| `boot/`             | foundation | Client construction, daemon URL and token handling, fake boot, the fake backend for features without protocol (`fake-backend.ts`)   |
| `features/shell/`   | foundation | `Rail`, `AppSidebar`, `SidebarFrame`, `ViewFrame`, `ViewSidebar`, `AppHeader`, `Screen`, panels, connection notice                  |
| `features/<slice>/` | the slice  | Everything for one slice: components, hooks, adapters, tests. Its `index.ts` is the only door in                                    |
| `app/`              | app        | Composition of several slices: `AppShell` (rail, sidebar, palette, notifier), `ConnectionGate`                                      |
| `routes/`           | per route  | TanStack file routes: route definition, search schema and params only. Screens live in the slice                                    |

Headless view logic (status wording, Home ordering and settling, thread cards, work-log and diff
summaries, relative time) lives in `packages/ui-core` (`@ace/ui-core`) so the Expo
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
one and panels open as a sheet over the content. Below 768px, and on short touch screens (a phone
held sideways), the sidebar is a sheet opened from the header (it closes once a place is chosen,
a link in it is followed, or the search dialog or a dialog opens from it), and a view's index page
shows its own list (`ViewListPage`). From 897px to 1100px the sidebar steps aside while a right
panel is open, so the panel docks beside the column; at 896px and below panels float over the
content and the sidebar stays as the person left it.

## Sidebar

As in desktop chat apps: one sidebar (composed in `app/app-shell.tsx`), no rail.

- **Top** (`features/shell/app-sidebar.tsx`): "ace ▾" (the daemon: its state and address,
  pairing, connection settings), Search (⇧⌘K: a dialog over any screen, `features/search`; the
  palette's "Search all threads for …" opens it too). Then New thread (⌘N; Add project while
  there is none), Automations (`g u`) and Skills (`g s`), listed in `features/shell/views.ts`.
  Activity is available through the command palette and its `g a` shortcut.
- **Body**: the thread list (`ThreadsSidebar`), the only part that scrolls. A view's list is the
  `sidebar` of its layout route's `<ViewFrame>`, placed by `place`: `threads` (Home and pages that
  keep the thread list), `sidebar` (Settings' pages take the body, through a portal, so they keep
  the route's providers) or `pane` (Automations, Skills and Activity draw their list at
  the start of their own column).
- **Foot**: the profile, full width (initials, name, the connection dot; its menu holds
  Appearance, Keyboard shortcuts and Usage & accounts, the only way to `/accounts`), the sign of
  computer use while agents hold an app, and the Settings gear (⌘,).
- Old addresses still land (route redirects and `lib/legacy-paths.ts`): `/deck…`, `/offsets…` and `/offshifts…` → Home, `/more` and
  `/more/accounts` → `/accounts`, `/more/files` → Home (Files is a pinned tab of each thread's
  side panel), `/more/search?q=` → the search dialog over Home.
- **Home's list** (`features/home`): one flat list of tasks across projects, pinned first, then
  Home order (needs you, work in motion, trouble, the rest, most recent first), then the
  collapsible Settled section. `homeOrder`, `homeRows` and `homeRowKey` in `@ace/ui-core` build
  it; threads and the Settled heading have their own key prefixes, so no thread id can take the
  heading's key. Each row is a three-line card: the project's badge (`projectBadge`: initials on
  a tint derived from the project id) and name, then a pin, a snooze and the status pill
  (`taskPill`; a working thread counts its seconds) or the age; the title (medium when it needs
  you or is unread, quiet once done and read); the branch or worktree, the diff or pull request
  and the provider with its running subagents. A thread that needs you carries a warm tint. The
  marks are decoration: the words stay in the row's name and its tooltip. Settle and Snooze float
  over the first line on hover; ↑↓ (or j and k) move between rows. The Threads heading carries
  the project filter and Add project (⇧⌘O) on hover.
- `SidebarFrame` owns where they sit and stays mounted for the app's life. `⌘\` is bound there:
  it hides or shows the sidebar (persisted as `sidebarOpen` in `ace.layout`), and
  on a narrow window opens and closes the sheet without touching that choice.
- The daemon and profile menus are there from the start; their contents load just after the first
  paint (`SidebarMenu`), keeping their icons and wording out of the initial bundle. The thread list
  loads beside the first route (`ThreadsSidebar`), keeping its rows and dialogs out of it too.
- New thread (the row and ⌘N) starts in the project Home is narrowed to, else the last one used.
- The desktop app styles the `sidebar-top` and `header-nav` slots and `data-sidebar`
  (`shown`, `hidden`, `sheet`) so the macOS traffic lights never cover a control.

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

| Slice                                                                              | Folder                 | Routes                                                        |
| ---------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| Home (thread list, New thread)                                                     | `features/home`        | `_home.tsx` (its sidebar), `_home.index.tsx`, `_home.new.tsx` |
| Thread (transcript, composer, header actions)                                      | `features/thread`      | `_home.t.$threadId.tsx`                                       |
| Thread workspace tools (Changes, Files, Browser, Preview, Agents, Terminal, Logs)  | `features/panels`      | tab kinds of the thread screen (`threadWorkspace`)            |
| Devices (a catalog of simulators and emulators, a tab per device)                  | `features/devices`     | none; loaded with the panel tabs                              |
| Activity                                                                           | `features/activity`    | `activity.tsx`, `activity.index.tsx`                          |
| Automations                                                                        | `features/automations` | `automations.tsx`, `automations.index.tsx`                    |
| Skills                                                                             | `features/skills`      | `skills.tsx`, `skills.index.tsx`                              |
| Thread organization (actions, Undo, the shared thread menu)                        | `features/organize`    | none; used by Home, the thread ⋯ menu and the palette         |
| Projects (Add project: open, create, clone; rename, remove; first-run empty state) | `features/projects`    | none; `/new?folder=` renders its `OpenFolderScreen`           |
| Model catalog (pickers)                                                            | `features/models`      | none; used by thread and Home                                 |
| Usage & accounts                                                                   | `features/accounts`    | `accounts.tsx`                                                |
| Search (a dialog over any screen)                                                  | `features/search`      | none; `more.tsx` sends old search links to it                 |
| Settings                                                                           | `features/settings`    | `settings.*.tsx`                                              |
| Palette                                                                            | `features/palette`     | none; register commands in `commands.ts`                      |

Rules:

- A screen renders `<Screen title subtitle menu summary actions workspace>` from `features/shell/screen.tsx`. Don't build another header or panel container. Docks and their tabs are declared as tab kinds (see Workspace tabs); the shell owns open state, order, sizes, persistence and the shortcuts.
- A view's list in the sidebar is the `sidebar` of its layout route's `<ViewFrame>`. Use `<ViewSidebar title actions toolbar>` or `<SidebarHeader>` for its heading.
- Live state (threads, sidebar, agent tree, interactions, intents) comes only from `@ace/client-react` hooks. TanStack Query is only for one-off reads. Never copy live state into Query or React state.
- Primitives you need but don't find in `components/ui` belong to the foundation: add them there, styled from the design tokens, not inside your feature folder.
- Shortcuts are added to `lib/keymap.ts` and bound with `useHotkey(keymap.x.keys, …)`; tooltips take `shortcut="x"`.
- Provider, ACP agent and model marks are `ProviderIcon` / `ProviderIconTip` from
  `components/ui/provider-icons.tsx`, never an inline logo. Which brand stands for what is
  `@ace/ui-core/provider-icons`; the marks are LobeHub Icons plus the official OpenAI Blossom in
  `scripts/brand-marks/`, regenerated with `bun run icons:providers`.
  They draw in brand colour (gradients included); black-and-white brands draw in the text colour
  at full strength. `variant="mono"` is for a tiny inline mark in the surrounding text colour.
- Colour has jobs, never decoration:
  - **Accent** (`--ring`): `bg-tint text-tint-foreground` as a fill (labels are black or white,
    always AA), `text-link` as text (links, the current rail view: the accent nudged until it
    reads at AA on every surface, so any custom colour stays legible), `bg-ring/10` for its soft
    wash and `bg-ring/45` for drawn lines. Each theme has its own (`--accent-theme`);
    Appearance can pin another.
  - **Status** through `data-tone="working | needs-you | waiting | failed | done | idle"`, which
    sets `--tone` (`styles/index.css`) for dots, rings and the spinner (working blue), and
    `--tone-text` for words: the hue made AA on every surface (`theme/status-text.ts`). A status
    is coloured words (`StatusLabel`) with a dot or icon, never a fill, border or tinted row.
    Words always carry the status too. Waiting and limited share the violet: a thread held at a
    usage limit waits on its provider, not on you, so its row dot is a hollow violet ring beside a
    violet Limited; amber is only for needs you.
  - **Diff**: green added, red removed (`--diff-add`, `--diff-del`, `text-status-done/failed` for counts).
  - **Projects**: `var(--project-${projectTint(id)})` from `@ace/ui-core`, twelve tints per theme
    that read as text at AA; a badge draws its letters in the tint on a wash of it.
- Greys: `text-muted-foreground` / `text-subtle-foreground` for hierarchy (both AA on every
  surface, `theme/surfaces.ts`). Ink washes are the opacity shorthand on four steps only:
  `bg-foreground/3` quiet fills, `/5` hover and fields, `/8` the selected row or tab, `/10` the
  selected nav item or pressed state (`bun run check:ui` rejects raw `color-mix` washes).
  Weights 400/500 (600 for titles only).
- Keep files under ~400 lines (hard limit 1,500, `bun run check:size`).

## Workspace tabs (the side panel)

A screen with a side panel passes `workspace={{ scope, definition }}` to `<Screen>`; the thread
screen passes its id and `threadWorkspace` (`features/panels/thread-workspace.ts`). A **tab** is
one opened resource (Changes, a terminal, Logs, a browser page, a file); the **side panel** beside
the column shows one tab at a time. There is no bottom panel: terminals and Logs are tabs like the
rest. Hiding the panel keeps its tabs; closing a tab removes one resource. Each scope (thread)
keeps its own tabs, showing tab, whether the panel shows, its width and full view
(`lib/workspace`, persisted under `ace.workspace`, the 64 most recently changed threads); the last
resize anywhere is the width new threads start at. A thread saved by an older build with a bottom
panel comes back with that panel's tabs (its terminals and Logs) after the side panel's, the one
that was showing still showing.

The shell owns the strip (order, drag and keyboard reorder, close, pin, overflow, the + launcher),
the width, full view, motion, persistence and shortcuts. A tool declares a
**kind** in `features/panels/thread-kinds.tsx`, a module that loads after the thread screen's
first paint, so a kind's icon, badge and loader never weigh on the route (ADR 0056):

```ts
import { defineTabKind } from "@/lib/workspace/index.ts";

export const fileKind = defineTabKind({
  kind: "file", // persisted with every tab: never rename one that shipped
  label: "Files",
  icon: FilesIcon,
  singleton: false, // one tab per id; `true` for a per-thread tool like Changes
  pinned: false, // `true` opens as a tool tab at the front, without a close button
  launcher: 30, // position on the + launcher; leave out to keep it off
  title: (tab) => basename(tab.id), // else the title the view last reported, else `label`
  load: () => import("./file-tab.tsx"), // { default: View, Actions? }, loaded on first show
  onClose: (scope, tab) => {}, // release what only this tab held
  fromFile: (path) => ({ kind: "file", id: path }), // lets the launcher's Suggested open files
  fromUrl: (url, workspace) => ({ kind: "browser", id: "2", data: { url } }), // the launcher's address bar
  onShortcut: (scope) => {}, // the tool's shortcut does this instead of showing its tab (⌘P)
  Overlay: QuickOpen, // drawn once per screen outside the panel (a palette the shortcut opens)
});
```

- List the kind in `threadKinds`. If it has a shortcut, add `kind → keymap id` to `shortcuts` in
  `thread-workspace.ts` (bound from first paint; pressed before the kinds have loaded, the tool
  opens once they have). Nothing in the shell changes.
- The view gets `TabViewProps` (`scope`, `tab`) and reads live state from
  `@ace/client-react` as any screen does. Tabs not showing stay mounted inside
  `<Activity mode="hidden">`; a view whose code fails to load shows the error and Try again in
  its own tab.
- `Actions` renders at the end of the panel's strip while one of the kind's tabs shows (a
  terminal's Find and sessions menu, Clear).
- Open things from anywhere with `useWorkspaceActions(threadId).open({ kind, id?, data? })`;
  opening a resource that is already open shows it (applying `data`). `data` is JSON kept with the
  tab across reloads: validate it in the view, it comes from storage.
- A view that learns a better title (a page's title, a file name) calls
  `useWorkspaceActions(scope).update(tab.key, { title })`.
- A tool the daemon can't serve yet still registers, with a view that says exactly what is
  missing (`features/panels/placeholders.tsx`); replace it by registering a kind with the same id.
- A view that needs another slice's components (an agent tab draws the transcript's blocks)
  reads them from `useThreadParts()`: the thread screen hands them down through `ThreadPartsProvider`, since those slices import the panels
  and the panels can't import them back. Hand down lazy components so the route stays light.
- Resource tabs so far: `agent` (one per agent of the tree), `device`
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

Shortcuts (`lib/keymap.ts`): ⇧⌘B side panel, ⌥⌘O the thread's work card, ⇧⌘F full view, ⌥⌘T new tab,
⌥⌘W close tab, ⇧⌘] and ⇧⌘[ next and previous tab, and each tool's own (⇧⌘D Changes, ⌃⇧A Agents,
⌃` or ⌘J Terminal, ⌃⇧B Browser, ⌃⇧P Preview, ⌃⇧M Devices, ⌃⇧L Logs, ⌘P quick open, ⌥⌘S Side chat).
In a browser tab: ⌘L the address, ⌘R reload, ⌘[ and ⌘] back and forward; in a file, ⌘F find. While a
terminal shows, ⌃⇧` opens another and ⌘F finds in its scrollback.

### Terminals, agent shells and Logs

`features/panels/terminal/tabs.ts` names them (open them with `useWorkspaceActions(threadId).open`):

- `{ kind: "terminal", id: <pty id> }`: one of your PTYs. Closing its tab ends the shell (through
  `terminal/closing.ts`, since `onClose` has no client); hiding the panel never does. Rename keeps a
  tab title for this thread on this device.
- `{ kind: "terminal" }`: a terminal that starts when it first shows, picking up a running PTY of
  the thread that no tab shows, else opening one (the launcher, ⌃`and ⌘J).`openNewTerminal` always starts a new shell, reusing that tab if it hasn't started yet.
- `{ kind: "shell", id: <task id> }`: an agent's background shell, read-only (Stop where the
  provider allows; Take over says why it can't). Closing the tab leaves the shell running.
- `{ kind: "logs", id? }`: the thread's log (no id), one agent's subtree (`agent:<id>`) or the
  daemon's health (`daemon`); the level and source filters are kept in the tab's `data`.

Inside a terminal the shell keeps Ctrl keys (`terminal/keys.ts`); ⌘ and Ctrl+Shift shortcuts stay
ace's, and ⌃` always leaves. Colours come from the theme (`terminal/palette.ts`): 13px text on 20px
rows. In a strip: arrows
move between tabs and show them, Home and End jump, Delete closes, Alt+Shift+arrows reorder;
right-click (or the context-menu key) for full view, pin, move and close.

### The thread header and its work card

The thread header holds only navigation, the title, its ⋯ menu (the thread's actions, then
Search this thread and Turns), the work card's button and the side panel's toggle. The work card
(`features/thread/header/work-card*.tsx`, loaded after first paint) floats under the header's
right end, a sheet on a phone: the project and where the thread runs (the environment menu:
folder, branch, commit, machine; switch branch, move to a worktree), Changes, the branch with its
next git step (Commit & push, Push, Create PR) and every git action, the branch's pull request,
the project's scripts as Actions (searchable, each running in a terminal tab), Open in (each
editor with its own app icon from the OS in the desktop app, `shell.editorIcon`) and the tools
the thread's agents have as Sources. Escape or a click outside closes it.

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
closed.

Add project has three tabs (Open folder, New project, Clone; ⌘1–⌘3, or ←/→ from an empty box)
and, when the window's machine pool (`lib/machine-pool.ts`, ADR 0059) holds more than one
machine, a machine picker (⌘M cycles). `lib/machines.ts` lists the targets; every read and
command goes to the chosen machine's client and never falls back to another. A project added on
another machine is announced, not opened: the rest of the app still shows this window's daemon.

One search box (`folder-search.tsx`, a combobox over a listbox with active descendant) serves
Open folder and the New project and Clone locations. Letters search with the daemon's `fs.search`;
`/`, `~` and `./` browse a path (`@ace/ui-core` `parseFolderQuery`), Tab completes with
`fs.complete`, Backspace on an empty segment and ⌘↑ go up, Esc clears. Enter opens a folder (a
project with threads opens at them), ⌘Enter opens it in a new thread. Recent projects from every
machine come from `fs.recentFolders`; a folder's own insides from `fs.browse`, ranked with
`@ace/project-picker`'s rules. Clone reads `owner/repo` and addresses with
`workspace.clone.validate` and suggests a free folder beside the machine's latest project.

Every path is the machine's: the desktop app adds its native picker and dropped-folder paths
(`boot/desktop-folders.ts`, `window.ace.dialogs` and `window.ace.files`). `/new?folder=<path>`
(the desktop's `ace://open?folder=`) adds or finds the folder and opens New thread in it. Wording,
name and address checks live in `@ace/ui-core` (`projects.ts`, `folder-search.ts`). In fake mode
`hostFolders()` seeds a home to browse, a second fake machine (`boot/fake-machines.ts`) fills the
picker, and `aceFakeWorld = "empty"` boots the first run. Tests get the same pool with
`harness({ machines })`.

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
thread's `items.page`), automations
(`automation.*`), skills and plugins (`pluginRequest`), and the Activity feed (forge `pr.status`
and thread requests). In fake mode `@ace/fake-daemon` serves the same messages from its catalogs
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
(`features/settings/data/access-gaps.ts`). More › Files has no upload: it would need a
project-scoped transfer; the side panel's Files tool uploads into a thread's checkout over the
files channel.
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
- Everything the first paint loads is one chunk (`initialChunk` in `initial-preloads.ts`); lazy chunks import what they share with the shell from it.
- Browser builds leave out the classic Zod methods listed in `zod-methods.ts` (string formats other than `url`, `uuid` and `date`, codecs, a few wrappers); calling one throws. Take a name off the list to use it.
- `cn` uses tables compiled ahead of time; after upgrading `cn` or changing `lib/cn-extension.ts`, run `bun run --filter @ace/web cn:tables`.
- A view over the whole thread list uses `useSidebarAll` (one key), never one key per thread. A virtualizer whose keys change over time calls `useForgetGoneRows`.
- Timers that drive the UI pause while the page is hidden: use the shared clocks in `lib/time.ts` and `lib/page-visibility.ts` rather than your own `setInterval`.

## Tests

Test behaviour through the UI with Testing Library: what a person sees and does, and what the daemon ends up holding. No snapshots, no markup-structure assertions, no "renders without crashing". jsdom has no layout; `src/test/setup.ts` gives the transcript virtualizer a tall viewport.
