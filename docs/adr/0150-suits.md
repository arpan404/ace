# 0150: Suits, looks an agent makes for ace

Date: 2026-11-14. Status: proposed.
Amends the "Removed" section of [ADR 0075](0075-themes-mode-surfaces-motion.md): custom themes
come back, as Suits.

## Context

ADR 0075 removed custom themes and the theme editor, because hand-edited token files broke
contrast and nobody wanted to work a colour editor. Two things changed:

- An agent can now do the editing. A person says "a synthwave sunset with neon pink" and gets a
  look, without ever opening an editor.
- 0075 made a theme pure data checked by tests (`contrastWarnings`, `accent-fit.ts`, the glass
  readability floor). The same checks can check a theme ace didn't ship.

The owner wants people to restyle ace however they like, on web and desktop alike, without
rebuilding the app.

## Decision

### What a Suit is

A **Suit** is a folder the daemon keeps per user, made of data plus one optional sandboxed
scene:

```
~/.ace/suits/<id>/
  suit.json      name, description, version, colours, fonts, shape, motion
  scene.js       optional animated backdrop (see "Scenes")
  assets/        optional images and fonts the scene or suit uses, bundled
```

`suit.json` is parsed with a Zod schema in `@ace/protocol` and holds:

- **Colours**: a light and a dark palette over 0075's `Palette` fields (surfaces, text levels,
  accent, syntax, diff, material, glass tint). A Suit may leave out a scheme; then it runs only in
  the scheme it has and says so. Partial palettes fill from a base theme (`base: "graphite"`).
- **Fonts**: UI, transcript and code families from bundled `assets/` or system fonts. No remote
  fonts.
- **Shape and density**: corner radius scale, border weight, density and transcript size,
  each from a fixed range.
- **Motion**: speed scale for the 0075 motion tokens.

A Suit cannot set: status colours, row status colours, the approval strip, the Working line, the
"waiting on you" markers or the danger fill. Those stay ace's own in every Suit, so the state of
an agent always reads the same (AGENTS.md priority 1).

### Checked before it applies

The daemon runs the same checks the built-in themes pass before a Suit can be applied:
`contrastWarnings` on every surface, accent fit, and the glass floor over the Suit's own scene
(scene frames sampled as extra backdrops). A Suit that fails is stored but not appliable, and
the failures come back as a list the agent can fix. There is no "apply anyway".

### Scenes

A scene is the animated backdrop behind the transcript and sidebar.

- It runs in a sandboxed iframe (`sandbox="allow-scripts"`, opaque origin) whose CSP is
  `default-src 'none'; script-src 'self'; img-src 'self' blob:`, served from the Suit's folder.
  It has no DOM access to ace, no network, no storage and no daemon socket.
- It draws on one canvas (2D or WebGL) and gets a small fixed set of events by `postMessage`:
  scheme, size, reduce motion, visibility, and thread signals (`working`, `waiting`, `done`,
  `failed`, `pr-merged`). It gets no thread contents, names or paths.
- ace shows it at 30 fps at most, pauses it when the window is hidden, blurred for a while or on
  battery saver, and stops it under Reduce motion (it draws one still frame). `check:ui`'s
  perpetual-animation rule is unchanged for app code; scenes are outside it because ace owns
  their clock.
- Surfaces over a scene are glass by 0075's rules; text sits on the readability floor.

### Where Suits live and how they reach clients

- The daemon owns the library: list, read, install, remove, validate, apply. Web, desktop and
  every paired device get Suits over the existing authenticated socket, so a Suit made on the
  desktop shows up in the browser as is.
- Which Suit is on stays a per-device appearance setting (`appearance.suit`), as theme already
  is. A project may name a default Suit that devices without a choice follow.
- The boot appearance cache (`ace.boot-appearance`) stores the applied Suit's resolved tokens,
  so first paint is right. The scene starts after first paint.
- iPhone and Android apply colours, fonts and shape through `@ace/design-tokens`; scenes show as
  a still frame.

### How an agent makes one

- A built-in ace skill, `make-a-suit`, teaches the format, the checks and the scene contract.
- An ace tool, `suit_apply`, with `preview` (applies to this device until the turn ends or the
  person keeps it), `keep` and `revert`. Every apply records the previous look, so undo is one
  step.
- The agent sees the result in ace's browser, which the person watches.

### Escape hatch

`?suit=off` in the URL, a reserved shortcut and `ace doctor` turn Suits off on that device. A
scene that throws, stalls the frame budget three times or fails to load is stopped and the Suit
falls back to its colours with no scene.

### Sharing

A Suit is a folder, so it can live in a git repo or be zipped. Installing a Suit from elsewhere
shows its files and whether it has a scene; scenes are trusted per version, the way 0014 trusts
plugins.

## Consequences

- People get any look they can describe, and ace's state markers stay readable in all of them.
- Raw CSS overrides are not supported. Any look reaches ace through tokens and scenes, so UI
  refactors never break a Suit.
- Restyling components themselves (custom panes, replaced rows) is out of scope; that would be a
  plugin capability with its own ADR.
- A scene costs one iframe and one canvas at 30 fps at most, paused whenever the window isn't in
  use. A benchmark records its frame time and battery cost on the Mac.
