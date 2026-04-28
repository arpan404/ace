# Anti-Patterns and Output

## Avoid

Visual:

- Inter + purple gradient default SaaS look
- every section in a card
- generic centered hero with two buttons
- decorative icons with no meaning
- random grays
- shadows everywhere
- oversized type in operational tools
- filler subtitles or slogans
- fake SaaS jargon
- text over images without contrast treatment

Layout:

- fixed screenshot-only widths
- horizontal overflow
- no max-width for reading
- dashboard made only of metric cards
- hamburger desktop nav
- margins where layout gap should be used

UX:

- no empty/loading/error states
- placeholder-only labels
- disabled buttons without explanation
- competing primary CTAs
- no submit feedback
- no permission states

Interaction:

- missing hover/focus states
- `outline: none` without replacement
- click handlers on `div`s instead of buttons
- missing aria-label on icon buttons
- `alert()` / `confirm()` for app dialogs
- toast for critical persistent errors

Mobile:

- targets under 44px/48dp
- hover-only controls
- body text under 14px
- desktop layout on phone

Library:

- unmodified shadcn card stack
- default MUI/Bootstrap/Ant look
- assuming imported components equal design

## Output Contracts

Full UI:

1. Brief
2. Classification
3. System
4. Direction
5. Layout
6. Flow
7. States
8. Components
9. Responsive behavior
10. Implementation
11. QA

Redesign:

1. Audit
2. Problems by severity
3. Direction
4. Layout changes
5. Component/system changes
6. Interaction fixes
7. Implementation
8. QA

Code:

1. Summary
2. Files/components
3. Code
4. State/responsive/accessibility notes

Shorten output for small tasks.

Every screen must answer:

- Where am I?
- What matters most?
- What can I do?
- What happened?
- What happens next?
- What if something goes wrong?
