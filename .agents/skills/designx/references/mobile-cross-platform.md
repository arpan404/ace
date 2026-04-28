# Mobile and Cross-Platform

## Mobile

Universal:

- 44pt/48dp touch targets
- safe areas
- keyboard-aware forms
- thumb-reachable primary actions
- bottom tabs for top-level destinations
- stack navigation for depth
- no hover-only controls
- preserve platform back behavior
- offline/retry for field or unreliable-network apps

iOS:

- large titles where useful
- tab bars
- sheets/action sheets
- swipe-back
- SF-symbol-like icons
- Dynamic Type mindset

Android:

- Material navigation patterns
- system back behavior
- FAB only for one dominant create action
- snackbars for temporary feedback
- bottom sheets when appropriate

Mobile web:

- avoid fixed desktop sidebars
- collapse dense tables into cards only when comparison is not central
- keep filters reachable
- avoid body text under 14px
- test 375px and 430px

## Cross-Platform

Shared:

- shared tokens
- platform-specific navigation
- platform-specific gestures
- adaptive layout
- offline/install behavior where relevant
- keyboard/right-click/context menus for desktop

Electron/Tauri:

- menu bar where useful
- command palette
- status bar
- window controls awareness
- file/resource trees
- tabs
- context menus for files, rows, tabs, canvas objects, selected text

PWA:

- install prompt only when useful
- offline state
- update available state
- app shell loading
- push notification permissions with clear rationale
