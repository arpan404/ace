# @ace/web

The ace client: React 19, Vite, TanStack Router (file routes), shadcn/ui on Base UI, Tailwind v4. Electron will load this same bundle. Read ADR 0045 (stack), 0004 (agent tree and status), 0006 (windowing) and 0030 (client SDK) first. The approved design is `ace-ui-prototype/index-fable.html` with its spec `DESIGN-fable.md`; match it.

```sh
bun run web:dev:fake   # whole app against the in-page fake daemon
bun run web:dev        # against a real daemon (`ace start`); the app asks for the token
bunx vitest run apps/web/src/features/<slice>   # your tests only
```

## Layout of `src/`

| Path                | Owner      | What lives there                                                                                                                       |
| ------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `theme/`            | foundation | Theme engine: presets from seeds, token list, CSS generation, contrast checks, custom theme files, `ThemeProvider` / `useTheme()`      |
| `styles/`           | foundation | Static tokens (`tokens.css`), Tailwind mapping and base styles (`index.css`), vendored shadcn variants                                 |
| `components/ui/`    | foundation | Owned primitives restyled to the design. Slices use them, never fork them                                                              |
| `components/`       | foundation | `Icon`, `SettingRow` / `SettingSection`, `StatusPill`, `DataTable`                                                                     |
| `lib/`              | foundation | `keymap.ts` (every shortcut), `hotkeys.ts` (`useHotkey`), `layout.tsx` (sidebar and panels), `history-nav.ts`, `storage.ts`, `time.ts` |
| `boot/`             | foundation | Client construction, the connection gate, daemon URL and token handling, fake boot                                                     |
| `features/shell/`   | foundation | Rail, `ViewFrame`, `ViewSidebar`, `AppHeader`, `Screen`, panels, connection notice                                                     |
| `features/<slice>/` | the slice  | Everything for one slice: components, hooks, adapters, tests                                                                           |
| `routes/`           | per route  | TanStack file routes. Each slice owns the route files of its screens                                                                   |

## Feature-folder convention

Each slice owns `src/features/<slice>/` and the route files for its screens:

| Slice                                         | Folder                                                                       | Routes                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Home (thread list, New thread)                | `features/home`                                                              | `_home.tsx` (its sidebar), `_home.index.tsx`, `_home.new.tsx`   |
| Thread (transcript, composer, header actions) | `features/thread`, `features/agents`                                         | `_home.t.$threadId.tsx`                                         |
| Review (Changes tab)                          | `features/review`                                                            | panel tab in the thread screen                                  |
| Preview                                       | `features/preview`                                                           | panel tab in the thread screen                                  |
| Terminal and logs                             | `features/terminal`                                                          | bottom panel tabs                                               |
| Activity                                      | `features/activity`                                                          | `activity.tsx`, `activity.index.tsx`                            |
| Deck (`@ace/conductor`)                       | `features/deck`                                                              | `deck.tsx`, `deck.index.tsx`, `deck.new.tsx`, `deck.$runId.tsx` |
| Automations                                   | `features/automations`                                                       | `automations.tsx`, `automations.index.tsx`                      |
| Skills                                        | `features/skills`                                                            | `skills.tsx`, `skills.index.tsx`                                |
| More: accounts, files, search                 | `features/more` (+ `features/accounts`, `features/files`, `features/search`) | `more.*.tsx`                                                    |
| Settings                                      | `features/settings`                                                          | `settings.*.tsx`                                                |
| Palette                                       | `features/palette`                                                           | none; register commands in `commands.ts`                        |

Rules:

- A screen renders `<Screen title subtitle menu actions right bottom>` from `features/shell/screen.tsx`. Don't build another header or panel container. Pass panel tabs as data (`{ id, label, badge, shortcut, content }`); the shell owns open state, sizes, persistence and the panel shortcuts.
- A view's second sidebar is the `sidebar` of its layout route's `<ViewFrame>`. Use `<ViewSidebar title actions toolbar>` or `<SidebarHeader>` for the header.
- Live state (threads, sidebar, agent tree, interactions, intents) comes only from `@ace/client-react` hooks. TanStack Query is only for one-off reads. Never copy live state into Query or React state.
- Primitives you need but don't find in `components/ui` belong to the foundation: add them there, styled from the design tokens, not inside your feature folder.
- Shortcuts are added to `lib/keymap.ts` and bound with `useHotkey(keymap.x.keys, …)`; tooltips take `shortcut="x"`.
- Colour only for diff +/− and the needs-you and failed dots. Use `text-muted-foreground` / `text-subtle-foreground` for hierarchy, and weights 400/500 (600 for titles only).
- Keep files under ~400 lines (hard limit 1,500, `bun run check:size`).

## Features whose protocol is not on `main` yet

Accounts (#25), file transfer (#44), search (#47), slash commands (#46) and screen/computer use (#29) are built against the fake daemon. Put the boundary in one file in your feature folder, for example `features/search/search-source.ts`:

```ts
// TODO(train-2): wire to protocol when merged
export interface SearchSource {
  search(query: string, signal: AbortSignal): Promise<SearchHit[]>;
}
export function fakeSearchSource(): SearchSource { … }
```

Components depend on the interface only, so wiring the real protocol later changes that one file.

## Fake-daemon scenarios

`packages/fake-daemon` speaks the real wire protocol in memory, and scenario facts are folded through `@ace/core`, so status is derived the way the daemon derives it.

- Add a scenario under `packages/fake-daemon/src/scenarios/<name>.ts` returning a `Scenario` (`thread` plus `steps` of facts or `await` an interaction). Use the builders in `facts.ts`. Label the steps tests need to reach (`runThrough("label")`).
- Export it from `packages/fake-daemon/src/index.ts`.
- To seed `dev:fake`, play it in `src/boot/fake.ts` (`runUntilBlocked()` for a static state, `autoplay(timer)` for a live one). `workbench()` is the realistic Home list from the design.
- Use realistic content (projects, branches, commands, findings), not placeholder text.
- In tests, `harness()` (`src/test/harness.tsx`) gives you the real app, a real client and a `FakeDaemon`: `app.play(scenario)`, `await app.open(path)`.

## Tests

Test behaviour through the UI with Testing Library: what a person sees and does, and what the daemon ends up holding. No snapshots, no markup-structure assertions, no "renders without crashing". jsdom has no layout; `src/test/setup.ts` gives the transcript virtualizer a tall viewport.
