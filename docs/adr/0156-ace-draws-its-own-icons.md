# 0156: ace draws its own icons

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-14 and 2026-11-15, after
reviewing drafts in chat). Amends [ADR 0056](0056-web-performance-architecture.md) (icon weights
and icon chunks) and the iconography rules in [DESIGN.md](../../DESIGN.md) and the
[design language](../design/design-language.md).

## Context

The web and desktop app draws 273 Phosphor icons and 10 of ace's own glyphs. Phosphor was picked
screen by screen, so the set reads as a stock library rather than as ace. Its shapes round only
their outer corners and leave inner ones square. Meanings also drifted: one drawing stands for
unrelated things (the moon is both Snooze and Dark mode, the wrench is Advanced settings, MCP tools
and Fix with agent), and one idea has several drawings (a skill is a stack, a book or a cube).

The owner asked for a complete redesign: a fresh, modern set that is clean, properly rounded and
consistent, rather than the old designs adapted.

## Decision

1. **ace draws every icon itself** in a new package, `@ace/icons`. Phosphor leaves the web app once
   every icon it draws has an ace drawing. Provider marks, Git host marks and editor marks stay brand
   marks, as do platform logos (Apple, Android, GitHub).
2. **One drawing, every weight.** A glyph is a list of parts on a 24 box, each with a role: shape,
   detail, line or spot. Outline (regular), bold, two-tone (duotone) and solid (fill) are painted from
   the same parts at render time. The stroke is 1.75 (2.25 bold). Corners round inside and out, from
   per-vertex radii. No weight is stored twice, so the build no longer trims weights.
3. **Each icon is recognisable by its own outline at 16 px.** Related icons share the style, not a
   frame. The owner rejected a grammar of shared frames with corner badges because the icons looked
   alike. Two modifiers remain: a slash for "off" and a corner plus for "new".
4. **Decided drawings:** the chat bubble is round with a short tail. Threads is two round bubbles.
   The agent is Buddy, a round-headed bot with two antennae and oval eyes. The agent pointer
   ("Pebble") keeps meaning computer use and browser use, never "agent".
5. **Icons keep the props the app passes today** (`size`, `weight`, `color`, `mirrored`, the rest to
   the `<svg>`), so the switch is a change of import, and the existing rule stands: regular when
   inactive, fill when active or a status, duotone for empty states.
6. **One module per icon**, so a page loads only what it draws. The icon chunk groups of ADR 0056
   apply to `@ace/icons` modules as they did to Phosphor's.
7. **Clean room.** Every drawing is made fresh from the geometry helpers. No path data is copied or
   traced from Phosphor or any other set.

## Consequences

- `apps/web/icon-weights.ts` and its guard go away when Phosphor does. `icon-chunk.ts` matches
  `@ace/icons` modules instead.
- New icons are added as glyph modules, checked with the package's zoom and contact sheets
  (`sheet/`), then `bun run --filter @ace/icons index`.
- The iPhone keeps SF Symbols for now. The geometry is platform-neutral, so native assets can be
  generated from it later.
- Fixing the drifted meanings (one drawing per idea where it matters) is follow-up work, done
  screen by screen once the set is in.
