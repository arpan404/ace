---
name: designx
version: 1.0.0
description: Frontend UI/UX design, redesign, design systems, responsive app screens, dashboards, admin tools, accessibility, and implementation guidance.
---

# DesignX

Build specific, usable software interfaces. Avoid generic AI SaaS UI, card spam, default library styling, purple gradients, fake jargon, and oversized text unless the brief asks for it.

## Load Rules

Load only files needed for the task.

New UI:
`product-classification.md`, `design-systems.md`, `aesthetic-directions.md`, `user-flow-interactions-components.md`, `layouts-dashboards-data.md`, `accessibility-performance.md`, `frontend-architecture-code.md`, `quality-gates-and-tokens.md`, `sizing-and-copy.md`, `anti-patterns-and-output.md`

Dashboard or analytics:
`product-classification.md`, `layouts-dashboards-data.md`, `quality-gates-and-tokens.md`, `sizing-and-copy.md`

Admin, internal tool, or dense data UI:
`product-classification.md`, `design-systems.md`, `user-flow-interactions-components.md`, `layouts-dashboards-data.md`, `frontend-architecture-code.md`, `quality-gates-and-tokens.md`, `sizing-and-copy.md`, `anti-patterns-and-output.md`

Mobile:
`product-classification.md`, `design-systems.md`, `user-flow-interactions-components.md`, `mobile-cross-platform.md`, `accessibility-performance.md`, `quality-gates-and-tokens.md`, `sizing-and-copy.md`

Cross-platform, PWA, or desktop app:
`product-classification.md`, `design-systems.md`, `user-flow-interactions-components.md`, `mobile-cross-platform.md`, `frontend-architecture-code.md`, `workflow-collaboration-i18n.md`, `quality-gates-and-tokens.md`, `sizing-and-copy.md`

Redesign or screenshot audit:
`redesign-methodology.md`, `aesthetic-directions.md`, `layouts-dashboards-data.md`, `accessibility-performance.md`, `sizing-and-copy.md`, `anti-patterns-and-output.md`

Frontend code:
`accessibility-performance.md`, `frontend-architecture-code.md`, `quality-gates-and-tokens.md`, `anti-patterns-and-output.md`

Design system:
`product-classification.md`, `design-systems.md`, `aesthetic-directions.md`, `user-flow-interactions-components.md`, `quality-gates-and-tokens.md`, `sizing-and-copy.md`

UX flow:
`user-flow-interactions-components.md`, `layouts-dashboards-data.md`, `workflow-collaboration-i18n.md`

## Core Process

For full UI work:

1. Classify product and platform.
2. Pick design system strategy.
3. Pick visual direction.
4. Choose density, type scale, sizing, and layout archetype.
5. Map primary flow, navigation, and states.
6. Define component and interaction behavior.
7. Implement with semantic, accessible, responsive code.
8. QA desktop, tablet, mobile, keyboard, states, overflow, and console errors.
9. Revise if product fit, hierarchy, accessibility, responsiveness, or states are below 8/10.

## Hard Rules

- Full UI work needs product fit, layout archetype, states, responsiveness, accessibility, realistic data, and QA.
- Use tokens for color, spacing, type, radius, motion, and semantic states.
- Include loading, empty, error, pending, disabled, partial-data, and forbidden states when relevant.
- Use semantic HTML or platform-native equivalents.
- Preserve visible focus states and keyboard behavior.
- Use restrained type by default: body usually 14-17px for app UI.
- Use relative sizing: `rem`, `%`, `fr`, `minmax()`, `clamp()`, container queries where useful.
- Avoid default shadcn, Tailwind, MUI, Ant, Bootstrap, or Material appearance.
- Use tables, split panes, drawers, inspectors, command palettes, and filters where they fit better than cards.
- Do not add filler copy, slogans, dramatic labels, or implementation details to normal user-facing UI.
- Do not implement interactive workflows as static markup.

## Brief Handling

Clear brief: choose a direction and build.

Ambiguous brief: offer 3 concrete directions with palette, typography, layout, interaction model, and tradeoff.

Redesign: audit first, then propose evolutionary, pivotal, or transformative changes.

Partial stack: use the stack, but still create a custom visual system.

No stack: use React for complex apps; HTML/CSS/JS for simple standalone pages; responsive React for mobile-like prototypes unless native is requested.

For full UI work, start with a short brief:

```txt
PRODUCT:
PLATFORM:
SYSTEM:
AESTHETIC:
LAYOUT:
SIZE:
KEY DECISION:
```
