# Frontend Architecture and Code

## Architecture

- split by feature or route when app is large
- keep UI, state, data fetching, and formatting boundaries clear
- use reusable components only when reuse is real
- keep visual tokens centralized
- avoid magic values where tokens fit
- normalize API data before rendering
- format dates, money, units in a formatting layer
- do not expose raw backend errors
- handle null, missing, partial, loading, and failed data

Suggested structure:

```txt
components/
features/
routes|app/
lib/
hooks/
styles/
tokens/
```

State:

- local state for local UI
- URL state for filters, tabs, pagination, searchable state
- server cache for fetched data
- global store only for cross-cutting app state
- optimistic updates need pending, success, failure, rollback

## shadcn / Tailwind

shadcn:

- primitives only, not finished design
- customize tokens, radius, spacing, colors, density
- avoid wrapping every region in `Card`
- prefer drawers, split panes, tables, command palettes, and inspectors when fitting

Tailwind:

- use semantic tokens/classes where possible
- avoid default Tailwind colors as brand
- avoid one-off arbitrary values unless layout-specific
- keep responsive rules intentional

## Framework Notes

React:

- compose components clearly
- avoid prop explosion
- memoize only when useful
- keep effects minimal
- derive state instead of duplicating it

Next.js:

- server components for server data where appropriate
- client components for interaction
- route-level loading/error states
- metadata where relevant

Vue/Svelte:

- keep component props/events explicit
- use framework-native stores/reactions
- avoid hidden global state

React Native / Expo:

- use platform navigation conventions
- respect safe areas
- use native gestures
- avoid web-only layout assumptions
