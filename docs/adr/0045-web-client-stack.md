# 0045: Web client stack

Date: 2026-10-02. Status: accepted.

## Context

ace's clients are thin. The daemon derives agent and thread status (ADR 0004), bounds payloads (ADR 0006) and arbitrates interactions (ADR 0007). `@ace/client` owns reconnect, replay, the durable intents outbox and fine-grained observable stores (ADR 0030). The web UI and the Electron renderer share one bundle; an Expo app follows later.

The client has three jobs: show daemon facts quickly, never invent state the daemon did not report, and keep every interaction reachable from the keyboard. The owner chose the TanStack libraries and shadcn/ui on Base UI. This ADR records those choices, the boundaries between them, and how they meet `@ace/client`.

## Decision

### Stack

| Concern                   | Choice                                                                                         | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI runtime                | React 19                                                                                       | Shared with Expo; `useSyncExternalStore` is the binding point for `@ace/client` stores                                                                                                                                                                                                                                                                                                                                                   |
| Bundler, dev server       | Vite 8                                                                                         | Vitest runs on the same pipeline and plugins, so tests transform code exactly as the app does. TanStack Router's file-route generator and code splitter, Tailwind v4 and the React plugin are first-class Vite plugins. Electron tooling builds on Vite. Bun's bundler has no route-generation or Vitest integration, so choosing it would mean a second toolchain for tests. Bun stays the package manager and script runner (ADR 0003) |
| Language                  | TypeScript, erasable syntax only                                                               | As in ADR 0003. The web app uses `moduleResolution: bundler` and a `@/` alias for `src`; relative imports keep their `.ts`/`.tsx` extensions                                                                                                                                                                                                                                                                                             |
| Routing                   | TanStack Router, file-based routes through `@tanstack/router-plugin/vite`, `autoCodeSplitting` | Type-safe params and search params validated with Zod 4 (`validateSearch`), plus route-level code splitting. The generated `routeTree.gen.ts` is committed and excluded from lint and format                                                                                                                                                                                                                                             |
| SSR                       | None; TanStack Start is not used                                                               | The UI talks to a local daemon over a socket. No server renders pages, and Electron loads static files. Start's server functions and SSR would add a server runtime with nothing to do                                                                                                                                                                                                                                                   |
| Live state                | `@ace/client` stores only, through `@ace/client-react`                                         | See "State" below. No Redux, Zustand or other global store                                                                                                                                                                                                                                                                                                                                                                               |
| Request/response reads    | TanStack Query, wrapping `@ace/client` request APIs                                            | For data that is fetched, not streamed: daemon health today; settings, model catalog, usage and search later                                                                                                                                                                                                                                                                                                                             |
| Transcript and long lists | TanStack Virtual                                                                               | Only visible rows mount; row heights are measured                                                                                                                                                                                                                                                                                                                                                                                        |
| Tables                    | TanStack Table v9 (`useTable` with explicit `tableFeatures`)                                   | Accounts, usage, conductor lanes and search results. An owned `DataTable` follows the shadcn data-table pattern                                                                                                                                                                                                                                                                                                                          |
| Forms                     | TanStack Form with Zod schemas                                                                 | Settings, composer options, approvals that carry fields                                                                                                                                                                                                                                                                                                                                                                                  |
| Local UI state            | Plain React state and context; route-level layout in search params                             | TanStack Store is not needed yet: shell layout (sidebar, panels, sizes) is local state persisted to `localStorage`, so it survives reloads                                                                                                                                                                                                                                                                                               |
| Keyboard shortcuts        | An owned `useHotkey` (`src/lib/hotkeys.ts`)                                                    | `@tanstack/react-hotkeys` (0.12) and `@tanstack/react-pacer` (0.24) are pre-1.0. Revisit when they reach 1.0                                                                                                                                                                                                                                                                                                                             |
| Components                | shadcn/ui, `base-vega` style, on Base UI (`@base-ui/react`)                                    | Components are copied into `apps/web/src/components/ui` and owned. `shadcn/tailwind.css` is vendored (the output of `shadcn eject`), so the CLI is not a runtime dependency                                                                                                                                                                                                                                                              |
| Styling                   | Tailwind CSS v4 with CSS-variable tokens, light and dark                                       | Utilities resolve to token variables, so a theme swap needs no component changes                                                                                                                                                                                                                                                                                                                                                         |
| Tests                     | Vitest, Testing Library, jsdom, and a fake daemon                                              | See "Testing" below                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Components and the AI registry

The shadcn registry now carries chat components built for Base UI: `message`, `bubble`, `marker`, `questionnaire`, `attachment` and `message-scroller`. Messages use `message` and `bubble`; notices, compaction and history boundaries use `marker`. `questionnaire` is the planned UI for question interactions.

Vercel's AI Elements registry (`conversation`, `tool`, `reasoning`, `prompt-input` and the rest) is typed against the `ai` SDK's `UIMessage` and `ToolUIPart` and styled for Radix state attributes. ace's items are its own canonical model (ADR 0004), so we adopt those components' patterns as owned code: a collapsible tool row with a status badge, collapsible reasoning. They map directly from `ToolCall` and `Item`. The `ai` package is not a dependency.

Two registry components are replaced:

- `command` is built on `cmdk`, which depends on Radix. The palette uses Base UI `Dialog` with an inline `Autocomplete`, following Base UI's command-palette example.
- `message-scroller` does not virtualize, so TanStack Virtual owns the transcript instead.

### State

Every live value comes from an `@ace/client` store. `@ace/client-react` (`packages/client-react`) is the only binding, and Expo will reuse it:

- **Leases.** `useThreadStore` and `useSidebarStore` take a reference-counted subscription inside `useSyncExternalStore`'s `subscribe`, so StrictMode and concurrent rendering stay correct.
- **Selectors.** `useThread(threadId, keys, selector, equal)` and `useSidebar(keys, selector, equal)` re-render a component only when an event touches one of its keys and the selected value changes under `equal`.
- **Domain hooks.** `useItem`, `useItemOrder`, `useAgent`, `useAgentTree` (ids only; rows read their own agent), `useInteractions` (pending by default), `useTask`, `useSidebarThread`, `useConnectionState`, `useIntent` and `useIntentSender`.
- **History.** `useHistoryPager` loads `items.page` before the store's cursor and merges the page through the store (ADR 0006).

The boundary with TanStack Query is strict. Query caches request/response results only. Thread, sidebar, agent tree, interaction and intent state never enter the Query cache, because a second copy would drift from the replayed store. Commands that change state are durable intents (`useIntentSender`). Their effects arrive as events, never as Query mutation results.

`@ace/client` gained one additive change: `ThreadReader` exposes `agentIds()`, `children(id)`, `interactionIds()` and `taskIds()`, and the store notifies new `agents`, `interactions` and `tasks` keys on membership changes. Without them the tree and inbox could not enumerate entities.

### Routes and shell

The shell follows the approved design (`DESIGN-fable.md`): a rail of views (Home, Activity, Deck, Automations, Skills, More; Settings and the account at the foot), each view's second sidebar, and a main column with one shared header (history back and forward, title, ⋯ menu, action slots, panel toggles). Thread screens add a resizable right panel (Changes, Preview, Agents) and bottom panel (Terminal, Logs). Sidebar visibility, panel open state, active tab and sizes are local layout state persisted to `localStorage`; one keymap (`src/lib/keymap.ts`) feeds `useHotkey`, tooltips and Settings › Keyboard.

Routes are file routes, one layout route per view (it renders the view's sidebar): `/` and `/t/$threadId` and `/new` under the pathless `_home` layout, `/activity`, `/deck`, `/deck/new`, `/deck/$runId`, `/automations`, `/skills`, `/more/{accounts,files,search}` and `/settings/{general,appearance,providers,notifications,remote,keyboard,advanced,theme-editor}`. "Conductor" is branded Deck in the UI; the package stays `@ace/conductor`. `apps/web/README.md` assigns route files and feature folders to slices.

Below 768px the second sidebar becomes a sheet opened from the header.

The browser build has no daemon until it is given one. A connection gate shows a connection screen (daemon address, default `ws://127.0.0.1:4242/`, and token from `~/.ace/daemon-token` or a paired device) and creates the client once the target parses; the daemon can also hand the token over in the `#token=` fragment. The token is kept in session storage unless the person asks to be remembered on the device. Connection trouble shows as one quiet line under the header; the account dot is the connection state.

### Accessibility

- Keyboard first: `⌘K` opens the palette from anywhere, including text fields; `⌘J` and `⌘⇧D` show the Agents and Changes tabs; `⌃`` toggles the bottom panel; `⌘[` `⌘]`move through history;`G` then a letter jumps between views. Every control is a native button or link.
- Focus: Base UI dialogs trap focus and return it to the opener. Client-side navigation moves focus to the new view's `h1` (the header title). A skip link leads to the main content.
- Semantics: status is conveyed by text, never colour alone. The transcript is a `feed` of `article`s with `aria-posinset` and `aria-setsize` (`-1` while older history exists). The connection badge is a `status` region. Interaction cards are labelled articles.
- `prefers-reduced-motion` disables animation; `prefers-reduced-transparency` turns glass solid.

### Design tokens

Tokens come from the approved `DESIGN-fable.md`. The seven presets (Dark default, Light, Midnight, Graphite, Paper, Slate, High contrast) are small seeds in `src/theme/presets.ts`, expanded into the full shadcn-named token set and injected as `[data-theme]` rules; the theme provider also applies accent (`--ring`), custom accent, glass intensity, density and transcript size on `<html>`. The last applied rules are cached and replayed by an inline script in `index.html` before first paint. Custom themes are stored as `{ id, name, scheme, tokens }` and validated with WCAG contrast checks. Static tokens (type, motion, layout sizes, glass materials) live in `src/styles/tokens.css`; Tailwind utilities map to the variables, so components never hard-code colours. Icons are Phosphor: regular when inactive, fill when active, duotone for empty states.

### Electron

Electron is a thin shell, implemented later. The main process starts or attaches to the daemon (Electron ships the Node runtime the daemon needs, per ADR 0003) and loads this same bundle from disk. It hands the renderer the daemon URL and a token through a `contextBridge` preload, never through the URL. The renderer gets no Node access. Desktop-only features go behind a small injected interface, so the web build never imports Electron.

### Testing

- Component and integration tests use Vitest, Testing Library and jsdom, through the public UI and public SDK state. There are no markup snapshots and no "renders without crashing" tests.
- **Fake daemon.** `@ace/fake-daemon` (`packages/fake-daemon`) implements the daemon wire protocol in memory as an `@ace/client` `Transport`: hello and auth, subscriptions with snapshot or replay from a cursor, host-wide sequence gaps for filtered events, windowed snapshots, `items.page`, and idempotent command receipts with first-answer-wins interaction resolution. Every message is parsed with the `@ace/protocol` Zod schemas. Scripted scenarios are adapter facts folded through `@ace/core`, so status is derived by the same code as in the real daemon. A core-rejected fact throws. Fault injection covers dropped connections and duplicated frames. Scenarios cover subagents with a background shell and an approval, a failing subagent, and long history.
- `bun run --filter @ace/web dev:fake` runs the whole app against the fake daemon in the page. It is code-split, so production builds never include it.
- jsdom has no layout. The test setup gives the virtualizer's viewport a tall box, so a test thread's rows mount without mocking the virtualizer.

### Performance budgets

These numbers are measured on the fake-daemon build. CI enforcement is a follow-up.

| Budget                                 | Limit                                                     | Now                                                   |
| -------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| Initial JS (gzip, shell + first route) | ≤ 200 KB                                                  | ~155 KB (React, router, Base UI, protocol schemas)    |
| Any lazy route chunk (gzip)            | ≤ 60 KB                                                   | thread route ~33 KB, settings ~31 KB                  |
| CSS (gzip)                             | ≤ 20 KB                                                   | ~12 KB                                                |
| Re-renders per streamed delta          | Only the rows that select the changed entity              | Enforced by test                                      |
| Mounted transcript rows                | Visible rows + 2 × 8 overscan, whatever the thread length | Virtualized; the client window is capped at 200 items |
| Sidebar status change                  | Re-renders one row                                        | Per-entry keys                                        |
| Input to next paint                    | ≤ 100 ms p75 on a mid-range laptop                        | Not yet measured                                      |

## Consequences

- Live correctness stays in one place (`@ace/client`). UI components cannot show an agent as done unless the daemon said so.
- The fake daemon depends on `@ace/core`. Its scenarios exercise real status derivation and break when core's fact contract changes, as intended.
- The inbox subscribes to each needs-you thread separately. That is fine at the client's 32-thread cache, but a daemon-side inbox scope will be needed for large hosts.
- Daemon health uses `client.command`, which records a durable intent for a read. A non-durable request API in `@ace/client` for settings, models, usage and search reads should replace it.
- Still to build: the composer and `thread.send`, question and plan-review answering, full shell output through `output.read`, markdown rendering, the Electron shell, and CI checks for the budgets above.
