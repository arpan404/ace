# Flows, Interactions, Components

## Flow

Map:

```txt
Entry -> primary intent -> main action -> feedback -> next action -> recovery path
```

Define for each screen:

- user goal
- primary action
- secondary actions
- destructive actions
- async actions
- errors
- empty/loading/partial/forbidden states
- next best action

Navigation:

- Few destinations: top nav or bottom nav.
- Many destinations: sidebar or rail.
- Hierarchical content: tree/sidebar.
- Dense app: command palette plus persistent nav.
- Mobile: bottom tabs for top-level, stack for depth.
- Canvas/tool: toolbar + panels + inspector.

Multi-screen patterns:

- onboarding/setup: stepper or focused flow
- record browsing: master-detail
- editing: editor shell or inspector
- approval/triage: inbox queue
- monitoring: command center
- creation: wizard, modal, drawer, or full editor depending on complexity

## Interaction

Timing:

- hover/focus: 100-150ms
- small UI transition: 150-220ms
- panel open: 180-280ms
- page transition: 200-350ms
- avoid slow decorative motion

Feedback:

- every click/tap shows response
- async actions show pending state
- destructive actions confirm or offer undo
- errors explain cause and next step
- optimistic updates include rollback

Micro-interactions:

- button press
- field focus
- save/pending/saved
- row selected
- filter applied
- drawer open/close
- tab switch
- upload progress
- drag/drop target
- validation

Forms:

- labels, not placeholder-only
- inline validation
- clear required/optional handling
- input masks when useful
- error summary for long forms
- save/cancel states
- unsaved-change warning
- keyboard submit behavior
- disabled-state reason when needed

## Components

Reusable component contract:

- purpose
- props/API
- variants
- states
- responsive behavior
- accessibility behavior
- error behavior
- loading behavior
- content limits

Typography:

- use a type scale
- app body usually 14-17px
- use tabular figures for numeric data
- avoid all-caps for long content
- use semantic text tokens

Buttons:

```txt
Primary: one main action per scope
Secondary: alternative action
Tertiary/ghost: low-emphasis action
Destructive: dangerous action
Icon-only: aria-label, tooltip where useful
Loading: keep label visible
```

Inputs:

- visible labels
- focus state
- validation state
- help text only when needed
- disabled/read-only distinction
- prefix/suffix for units/currency
- clear button for search

Navigation:

- show current location
- preserve selection across refresh
- support keyboard navigation
- use breadcrumbs for hierarchy
- selected state must not rely on color alone

Feedback components:

- toast: non-critical confirmation
- inline error: field/action issue
- banner: persistent page/system issue
- modal: blocking decision
- empty state: plain reason + useful next action
- skeleton: predictable loading layout

Data display:

- table for comparison and operations
- cards for browseable objects only
- list for feeds/queues
- timeline for history
- map for spatial tasks
- chart for pattern/trend, not as decoration
