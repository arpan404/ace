# Layouts, Dashboards, Data

## Layout Archetypes

Command Center: nav + summary + live queue/table + map/timeline/detail drawer. Use for operations, logistics, monitoring.

Master-Detail: list/table + detail panel. Use for CRM, email, tickets, records, files.

Data Grid First: filters + table + bulk bar + detail drawer. Use for admin, finance, inventory, procurement.

Canvas Workspace: canvas + toolbar + layers + inspector. Use for design, diagrams, maps, whiteboards.

Editor Shell: resource tree + tabs + editor + terminal/problems/status. Use for IDEs, docs editors, AI coding tools.

AI Workspace Split: conversation + artifact/editor + tool trace + sources/context. Use for agents and assistants.

Inbox / Triage: queue + priority + assignment + detail/actions. Use for support, moderation, approvals.

Map + Data Split: map + list/table + filters + selected detail. Use for fleet, delivery, field ops, real estate.

Timeline / Activity: chronological stream + filters + object detail. Use for audit, patient/project/incident history.

Wizard / Focus Flow: steps + validation + progress + recovery. Use for setup, onboarding, checkout, imports.

Dashboard Grid: summary + charts + raw data + drill-down. Do not let cards become the product.

## Dashboards

Types:

- executive: high-level KPIs and trends
- operational: alerts, queues, actions
- analytical: filters, comparisons, drill-down
- personal: user-owned tasks/progress
- IoT/device: status, alerts, real-time controls
- financial: periods, variance, risk, transaction detail

Chart choices:

- trend over time: line/area
- category comparison: bar
- composition: stacked bar; pie only for few stable categories
- distribution: histogram/box
- relationship: scatter
- status mix: compact bars/badges
- geography: map only when location matters

Rules:

- answer one primary question in 3 seconds
- alerts beat decorative metrics
- raw data reachable from summaries
- visible date range and filters
- custom tooltips
- empty charts explain missing data
- numbers have units, formatting, and comparison periods

## Dense Data UI

Use for operations, finance, admin, dashboards, inventory, procurement, CRM, enterprise apps.

Support when relevant:

- saved views
- advanced filters
- filter chips
- search/sort
- column resize/reorder/visibility/pinning
- grouped/expandable rows
- inline edit
- bulk actions
- row actions
- detail drawer
- audit trail
- export/import
- pagination or virtualization
- keyboard navigation
- empty dataset and empty filtered states

Density:

- comfortable: 56px rows
- standard: 44px rows
- compact: 32-36px rows

Numbers:

- right-align
- tabular figures
- units visible
- avoid needless decimals
- show comparison period
- distinguish zero, null, missing, and N/A

Filters:

- field
- operator
- value
- date range
- saved filters
- reset/clear
- visible active chips
