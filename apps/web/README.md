# @ace/web

The ace client: React 19, Vite, TanStack Router (file routes), shadcn/ui on Base UI, Tailwind v4. Electron will load this same bundle. Read ADR 0045 (stack), 0004 (agent tree and status), 0006 (windowing) and 0030 (client SDK) first. The approved design is `ace-ui-prototype/index-fable.html` with its spec `DESIGN-fable.md`; match it.

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
| `features/shell/`   | foundation | Rail, `ViewFrame`, `ViewSidebar`, `AppHeader`, `Screen`, panels, connection notice, `useWorkspaces`                                 |
| `features/<slice>/` | the slice  | Everything for one slice: components, hooks, adapters, tests. Its `index.ts` is the only door in                                    |
| `app/`              | app        | Composition of several slices: `AppShell` (rail, palette, notifier), `ConnectionGate`                                               |
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
- Panels and the second sidebar: `usePresence(open)` keeps them mounted for their exit;
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
in line with Tailwind's `sm` and `md`. Below 640px the rail is a bottom tab bar (Home, Activity,
Deck, More), the header folds its actions and ⋯ menu into one, and panels open as a sheet over the
content. Below 768px the second sidebar is a sheet; below 1100px it steps aside while a right panel
is open; below 1152px panels float over the content.

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

| Slice                                                              | Folder                                                                       | Routes                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Home (thread list, New thread)                                     | `features/home`                                                              | `_home.tsx` (its sidebar), `_home.index.tsx`, `_home.new.tsx`   |
| Thread (transcript, composer, header actions)                      | `features/thread`                                                            | `_home.t.$threadId.tsx`                                         |
| Right and bottom panels (Changes, Preview, Agents, Terminal, Logs) | `features/panels`                                                            | panel tabs of the thread screen (`threadPanels(threadId)`)      |
| Devices (simulators and emulators, a right-panel tab)              | `features/devices`                                                           | none; loaded with the panel tabs                                |
| Activity                                                           | `features/activity`                                                          | `activity.tsx`, `activity.index.tsx`                            |
| Deck (`@ace/conductor`)                                            | `features/deck`                                                              | `deck.tsx`, `deck.index.tsx`, `deck.new.tsx`, `deck.$runId.tsx` |
| Automations                                                        | `features/automations`                                                       | `automations.tsx`, `automations.index.tsx`                      |
| Skills                                                             | `features/skills`                                                            | `skills.tsx`, `skills.index.tsx`                                |
| Model catalog (pickers)                                            | `features/models`                                                            | none; used by thread and Home                                   |
| More: accounts, files, search                                      | `features/more` (+ `features/accounts`, `features/files`, `features/search`) | `more.*.tsx`                                                    |
| Settings                                                           | `features/settings`                                                          | `settings.*.tsx`                                                |
| Palette                                                            | `features/palette`                                                           | none; register commands in `commands.ts`                        |

Rules:

- A screen renders `<Screen title subtitle menu actions right bottom>` from `features/shell/screen.tsx`. Don't build another header or panel container. Pass panel tabs as data (`{ id, label, badge, shortcut, content }`); the shell owns open state, sizes, persistence and the panel shortcuts.
- A view's second sidebar is the `sidebar` of its layout route's `<ViewFrame>`. Use `<ViewSidebar title actions toolbar>` or `<SidebarHeader>` for the header.
- Live state (threads, sidebar, agent tree, interactions, intents) comes only from `@ace/client-react` hooks. TanStack Query is only for one-off reads. Never copy live state into Query or React state.
- Primitives you need but don't find in `components/ui` belong to the foundation: add them there, styled from the design tokens, not inside your feature folder.
- Shortcuts are added to `lib/keymap.ts` and bound with `useHotkey(keymap.x.keys, …)`; tooltips take `shortcut="x"`.
- Colour only for diff +/− and the needs-you and failed dots. Use `text-muted-foreground` / `text-subtle-foreground` for hierarchy, and weights 400/500 (600 for titles only).
- Keep files under ~400 lines (hard limit 1,500, `bun run check:size`).

## Daemon services and protocol gaps

One-off daemon reads and writes go through `Client.request` (correlated, never queued while
offline) with `useDaemonQuery` from `lib/daemon-query.ts`, which waits for a ready connection
and reads again after a reconnect. Live state still comes only from `@ace/client-react`.

Wired on the wire in every mode: accounts and usage (`accounts.list`, `usage.series`), threads
per account from the live list and moving a limited thread (`queue.get`, `thread.limit` /
`migrate_now`), search (`search.query`), models (`models.list`, `models.refresh`), settings
(`settings.subscribe` / `settings.set`, every key in the protocol's `SettingsValues`, including the
run-out policy `threads.limitPolicy`), slash commands (`commands.list`), mentions and uploads
(`context.request`). In fake mode `@ace/fake-daemon` serves the same messages from its catalogs
(`packages/fake-daemon/src/services/`), so a feature has one code path.

Beside the socket, the connection carries its `endpoint` (`boot/connection.tsx`): the daemon's HTTP
access routes for paired devices, pairing and revoking (`AccessClient`; the daemon allows these
bearer-token routes from the app's origin), and the dedicated devices channel for the Devices panel
(`DeviceClient` over `deviceTransport` from `@ace/client/devices`). Fake mode points both at the
fake daemon (`FakeAccess`, `FakeAppDevices`).

What `main` cannot carry yet sits behind one adapter per feature marked
`// TODO(client-gaps): feat/client-protocol-gaps`. In fake mode it serves the fake daemon's
stand-in; against a real daemon it reports the feature empty or unavailable, never fixture data.
Settings still waits for a list of machines and for adding an ACP agent by command
(`features/settings/data/access-gaps.ts`); other slices list theirs in their own adapters. When the
backend lands, wiring a feature changes only its adapter.

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
- `bun run check:perf` runs the budgets; `bunx vite --mode perf` serves the app against an endless agent (`?rate=` events per second).

## Tests

Test behaviour through the UI with Testing Library: what a person sees and does, and what the daemon ends up holding. No snapshots, no markup-structure assertions, no "renders without crashing". jsdom has no layout; `src/test/setup.ts` gives the transcript virtualizer a tall viewport.
