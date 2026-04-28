# Design Systems

Pick a system strategy before styling. Use systems as constraints, not as untouched visual output.

## Selection

- Android-first: Material Design 3.
- iOS-first: Apple HIG.
- Windows / Microsoft ecosystem: Fluent 2.
- Data-heavy enterprise, operations, government: Carbon-inspired or custom enterprise.
- CRUD/admin/B2B management: Ant-inspired density or custom compact.
- Devtools, IDEs, monitoring: Primer-inspired, Data Terminal, Swiss Grid, or custom devtool.
- Commerce admin/storefront: Polaris-inspired or custom commerce.
- Code collaboration: Primer-inspired.
- Project/team workflows: Atlassian-inspired.
- Creative/pro media tools: Spectrum-inspired or custom workspace.
- Public sector/legal/accessibility-critical: GOV.UK, USWDS, Carbon, or accessibility-first custom.
- Luxury/editorial/brand-heavy: custom editorial, luxury, or Swiss.
- AI/agent workspace: custom split workspace with traceability and control.

## System Notes

Material 3: color roles, tonal elevation, adaptive nav, chips, bottom sheets, snackbars, FAB only for one dominant mobile creation action.

Apple HIG: clarity, safe areas, large titles, tab bars, stack nav, swipe-back, sheets, SF-symbol-like icons, Dynamic Type mindset.

Fluent 2: command bars, tree views, pivot tabs, contextual menus, dense grids, keyboard accelerators.

Carbon: productive density, strong grid, tables/forms, restrained color, notification taxonomy, accessibility discipline.

Ant: dense tables, advanced forms, filters, modals/drawers, confirmation flows, batch actions. Customize styling.

Polaris: resource lists, filters, bulk actions, contextual save bars, commerce empty states, trust patterns.

Primer: compact nav, code-like type, issue/PR labels, timelines, markdown, command/search.

Atlassian: boards, issue drawers, inline editing, comments/mentions, activity, permissions/workflow states.

Spectrum: canvas-first, toolbars, panels, inspectors, precision inputs, mode-aware controls.

GOV.UK / USWDS: plain language, contrast, accessible forms, step-by-step flows, clear errors, minimal decoration.

Radix / shadcn: use as accessible primitives only. Replace default radius, color, spacing, and composition.

Custom system must define: primitive tokens, semantic tokens, component tokens, typography, spacing, radius, elevation, motion, icon style, chart palette, state taxonomy, density modes, and themes when relevant.
