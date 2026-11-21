# Android navigation spec (A00.02)

Status: specification only. No app edits. Reference: HEAD `b92d9d26`.
Sources (all read locally): `apps/ios/Sources/Views/InboxView.swift`,
`InboxStack.swift`, `InboxSplit.swift`, `InboxPlaces.swift`, `InboxRoute.swift`,
`InboxCommands.swift`, `ThreadToolbar.swift`, `Settings/SettingsSheet.swift`,
`Settings/SettingsTools.swift`; matrix `docs/mobile/android-ios-capabilities.md`;
plan `docs/plans/android-ios-parity.md` (A04.05, A04.07, A15.02).

## 0. Adopted vs proposed (read first)

- ADOPTED (existing product, do not relitigate): two roots Threads + Pulls;
  New thread is a detached ACTION, never a page (`InboxView.swift:4,89-101`);
  one open thread at a time, always on Threads (`openThread`, `InboxView.swift:225-234);
per-tab stacks (`threadsPath`/`pullsPath`); thread identity is
machine+thread (`InboxRoute.swift:5-7`, `InboxKey.place`); Settings owns
Machines/Notifications/Lock/Appearance/Archive/Profiles/Tools/Licences
(`SettingsSheet.swift:4-10`); thread ⋯ owns its 9 destinations
(`ThreadToolbar.swift:4`); hardware keys are New/Search/Next/Previous
(`InboxCommands.swift:28-41`); status/auth vocabulary and grant gates stay
  identical to the matrix (view-only/operate/Projects/Accounts).
- PROPOSED (Android platform choices, recorded as proposed, no approval flow
  invented here): routes owned by the existing React Navigation native-stack
  (`createNativeStackNavigator`, `apps/android/src/App.tsx:8,18-21`); bars,
  sheets and FAB via existing React Native primitives and the narrow Compose
  adapters already in use (`@expo/ui/jetpack-compose`, `App.tsx:9`); adaptive
  tablet/foldable layout via existing RN primitives + narrow native views;
  ongoing-notification status surface; biometric unlock hold-and-route. A new
  platform dependency (nav library, scaffold, store) requires its own
  evidence/task — never a blanket prerequisite. Marked `PROPOSED` below.

## 1. Obsolete mockup resolved

The old no-tab `mobilev2` mockup is OBSOLETE and must not be cited as a
target. Current iOS has two roots (Threads, Pulls) plus detached New thread,
and Settings › Tools per machine REPLACES the old Browse sheet as the
entry to Projects/Automations/Usage/Skills/Providers/Source-control/
Prompts/Computer/Devices (`SettingsTools.swift:5-9,59-92`). There is no
Browse root on Android either.

## 2. Roots (phone)

- `threads` — merged inbox list (default start). PROPOSED: bottom tab bar
  with Threads + Pulls on the native-stack-owned graph; New thread is a
  FAB/top-bar action opening a modal bottom sheet, never a third tab
  (matches detached `compose` role).
- `pulls` — Forge lists (PRs / Issues / Notifications via kind switch,
  `InboxStack.swift:64-67`) + `forge/{machine}/{kind}/{id}` pages.
- `settings` — full-screen graph opened from the Threads/Pulls top-bar gear
  (`InboxStack.swift:130,164-167`), NOT a root tab.
- Per-root histories RETAINED: independent stacks `threadsStack`,
  `pullsStack`, `settingsStack` (≡ `threadsPath`/`pullsPath` + Settings `path`).
  Switching roots never clears the other root's stack.

## 3. Family → route/entry map (every family reachable)

| Family                       | Android entry / route                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-NV/C-IN threads+search     | `threads`, `threads/thread/{machine}/{id}[/child…]`, in-list search field, `settings/archive`, `settings/archive/thread/…`                                                                                                                               |
| C-TH transcript              | thread page + `…/search` (find in thread), `…/message/{id}` full read, change-chip → Changes                                                                                                                                                             |
| C-CO composer/cards          | inline composer on thread page; queue/approval/question/plan/MCP/browser/goal as inline cards + bottom sheets (no new roots)                                                                                                                             |
| C-NT/C-FL projects/files     | New-thread sheet: `newThread/{machine?}/{project?}`; project picker, add/clone/import, past sessions; `…/files[…]` tree/viewer/edit/recently-deleted                                                                                                     |
| C-AG/C-CH/C-TR               | thread ⋯ menu → `…/agents[/lane]`, `…/changes[/diff/commit]`, `…/transfer/{id}` sheet; completion routes to destination `threads/thread/{m}/{id}`                                                                                                        |
| C-FG Pulls                   | `pulls?kind=pulls\|issues\|notifications`, `pulls/{machine}/{kind}/{repo}/{number}[/timeline\|files[/{path}]\|review]`; notification row → same in-app page                                                                                              |
| C-AD pairing/machines/admin  | `settings/machines`, `settings/machines/{host}`, `settings/pair`, `settings/notifications`, `settings/lock`, `settings/tools/{tool}/{machine}` (= 9 `SettingsTool`s), `settings/profiles`, `settings/appearance`, `settings/licences`, diagnostics share |
| C-TL tools/terminal/media    | thread ⋯ → `…/terminal`, `…/tools/{catalog\|mcp}`, `…/fork`, published media viewer (sandboxed, no new root)                                                                                                                                             |
| C-BR/DV/CU live/remote       | thread ⋯ or `settings/tools/{computer,devices}/{machine}` → `…/browser[/{session}]`, `…/devices[/{device}[/live]]`, `…/computer[/live]`                                                                                                                  |
| C-NO/C-TA/C-AP status/finish | ongoing-notification surface → thread route; appearance/keyboard/diagnostics under `settings/*`; tablet rail+detail (§5)                                                                                                                                 |

## 4. Route identity, back, sheets

- Identity: every thread route carries BOTH machine and thread id
  (`machineId + id`, ≡ `InboxKey.place`); same thread id on two hosts never
  collides; opening a thread on machine B backs the previous thread VIEW on
  machine A out (`inbox.client(openMachine)?.back()`, `InboxView.swift:227`)
  — view/subscription only. It never shuts down machine A's runtime: both
  machines stay connected concurrently (plan M03 gate); stale callbacks after
  back/removal are dropped
  (plan cross-cutting: route/runtime generations).
- Threads-tab discipline: opening from Pulls/search/notification/archive/
  transfer always lands on `threads/thread/{m}/{id}` with `openTab=.threads`;
  Pulls keeps its page (`InboxView.swift:223-234`). Parent/child push appends,
  back pops and reopens parent under a new generation (`pathChanged`).
- Back (PROPOSED, system back on the native-stack graph): sheet/dropdown →
  detail page → list/empty detail → root; never cross from one root's stack
  into another's; Esc-equivalent closes top sheet only (≡ `escapeCloses`,
  composer Send/Stop owns its keys).
- Sheets: New thread, snooze/archive confirm, transfer, tools/agents/terminal/
  browser-console are modal bottom sheets (phone) / side sheets (expanded);
  Undo toast 5 s mirrors `toast` (`InboxView.swift:192-221`).

## 5. Tablet / foldable / state / IME / a11y

- PROPOSED responsive (≡ `InboxSplit`/`ThreadColumns`): list beside detail
  on expanded width via existing RN adaptive primitives + narrow native views,
  stack on compact; `InboxPlaces`-equivalent Threads/Pull-requests switch sits
  in the rail/list foot on expanded, bottom bar on compact; resize/fold/
  rotate/split-screen preserves route + draft + reading anchor (no second data
  owner; M15 A15.02 owns it).
- Restoration: persist per-root stacks + `lastPlace` (`ace.inbox.openThread`)
  via the app's existing persistence primitives + `NavigationContainer`
  restoration state; restore only if the row exists on its machine, else fall
  back to `threads` (≡ `restorable`, `InboxView.swift:108-117`).
- Unlocked deep links/notifications: `ace://threads/{m}/{id}`,
  `ace://pulls/{m}/{kind}/{repo}/{n}`, notification tap → same; when locked,
  hold the pending route and fire AFTER biometric/device-credential unlock
  (≡ A02.07; never render content pre-unlock).
- IME/a11y: `adjustResize`, composer stays above keyboard, focus returns to
  invoker on sheet close; every route/action has TalkBack label + test tag
  mirroring iOS `accessibilityIdentifier`s (`inbox.*`, `thread.*`,
  `settings.*`, `library.*` kept per `SettingsTools.swift:35-43`); targets
  ≥48dp, status never colour-only; reuse DESIGN attention/contrast rules.

## 6. Apple-specific equivalents (limits preserved)

Face ID → BiometricPrompt + device credential (same 60 s re-lock posture);
icons follow DESIGN.md §2 (Phosphor regular + provider marks, no new icon
library); native system chrome where the platform draws it (notification
area, share sheet, system back); iOS share/Quick Look → Android Sharesheet +
system viewer (NO new share targets/widgets — deferred per matrix §13); Live Activity → ongoing notification surface under A14.05
(best-effort, Doze/battery truthful; FCM/APNs remote push explicitly OUT of
scope); budgeted `wake()` refresh kept, no always-on socket promise (A14.04).

## 7. GAP-KBD resolved → plan task A04.07 (no app edits)

Matrix C-IN-06 maps to plan task **A04.07 Hardware keyboard + shortcuts**
(`docs/plans/android-ios-parity.md` A04.07; ledger records the four commands as owned): Ctrl+N new thread (disabled when
all view-only), Ctrl+F search, Ctrl+]/Ctrl+[ next/previous thread in list
order read at press time (≡ `InboxCommands.swift:28-65`,
`InboxStack.swift:102-117`); Chromebook/external-keyboard + TalkBack safe;
modifier choice stays proposed. A04.05 keeps phone nav/back/route
identity; A04.07 owns ONLY the key bindings.

## 8. Leaf acceptance cases (exact)

1. Phone cold start lands on `threads`; bottom bar shows Threads + Pulls only; New thread is an action (FAB/top bar), not a tab.
2. Switching Threads↔Pulls preserves each stack; back never jumps roots.
3. Opening any thread/search-hit/notification/archive-row/transfer lands on `threads/thread/{correct-machine}/{id}`; Pulls page unchanged.
4. `threads/thread/A/x` and `threads/thread/B/x` are distinct; opening B backs A's thread view out while A's runtime stays connected; stale action cannot hit the new thread.
5. Relaunch restores last thread iff its machine still lists it, else `threads`.
6. Locked tap/link waits for unlock, then routes; nothing renders pre-unlock.
7. Expanded tablet shows list+detail with rail switch; fold/rotate keeps route, draft, anchor.
8. Every family in §3 opens at its route; view-only disables the same mutations as iOS (no blind sends).
9. Shortcuts Ctrl+N/F/]/[ behave per §7 incl. view-only New-thread gating.
10. No Browse root exists; all 9 machine tools open only via Settings › Tools.
