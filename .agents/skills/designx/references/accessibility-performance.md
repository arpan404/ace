# Accessibility and Performance

Accessibility:

- semantic HTML or native equivalents
- labels for inputs and icon buttons
- visible focus states
- keyboard access for all controls
- logical focus order
- contrast-safe text and controls
- color not the only signal
- reduced-motion support
- errors tied to fields/actions
- modals trap focus and restore focus
- ARIA only when native semantics are insufficient

Keyboard:

- Tab/Shift+Tab moves predictably
- Enter/Space activate controls
- Escape closes transient surfaces
- arrows navigate menus, lists, tabs, grids where expected
- shortcuts must not block browser/system shortcuts

Performance:

- avoid unnecessary re-renders
- virtualize large lists/tables
- lazy-load heavy media/routes
- optimize images
- keep animation transform/opacity-based
- no layout thrash
- skeletons match final layout
- handle slow, failed, and partial data
- no console errors
