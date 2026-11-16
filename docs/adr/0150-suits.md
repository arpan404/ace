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
  the scheme it has and says so. Partial palettes fill from a base theme (`base: "ace"`).
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
- A browser's `backdrop-filter` can't reach into the sandboxed, out-of-process scene frame, so
  glass over a scene would show it sharp. The host sends the frame `glass`, the rounded rectangles
  its glass covers with their blur and saturation, again whenever they move; the runtime draws the
  scene's own canvas, blurred, inside them after every frame (small copies the browser stretches
  and clips). The host's glass keeps its tint and edge. (Added 2026-11-15.)

### Where Suits live and how they reach clients

- The daemon owns the library: list, read, install, remove, validate, apply. Web, desktop and
  every paired device get Suits over the existing authenticated socket, so a Suit made on the
  desktop shows up in the browser as is.
- Which Suit is on stays a per-device appearance setting (`appearance.suit`), as theme already
  is. A project may name a default Suit that devices without a choice follow.
- The boot appearance cache (`ace.boot-appearance`) stores the applied Suit's resolved tokens,
  so first paint is right. The scene starts after first paint.
- Suits are for web and desktop only. The iPhone and Android apps keep ace's own themes and don't
  read the Suit library; the owner decided on 2026-11-15 that Suits don't fit the phone apps.

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
- Raw CSS reaches ace only through the published parts below, so a UI refactor that keeps the
  parts keeps every Suit working.
- New panes and behaviour (code running beside the UI) stay out of scope; that would be a plugin
  capability with its own ADR. Everything visual is in scope.
- A scene costs one iframe and one canvas at 30 fps at most, paused whenever the window isn't in
  use. A benchmark records its frame time and battery cost on the Mac.

## Full customisation (amended 2026-11-14)

The owner reviewed the first build: colours and one backdrop are not enough. A Suit must be able
to restyle every visible part of ace (rail, sidebar, header, transcript, messages, tool rows, code,
composer, menus, settings) and move the layout, and it must render exactly as intended. This
amendment replaces "Raw CSS overrides are not supported".

### Parts: a published styling contract

- Every visible region and repeated element carries `data-part="<name>"`, with its state in
  `data-state` (`active`, `selected`, `open`, `disabled`, `working`, `waiting`, …) and its variant
  in `data-variant`. The names are a versioned list in `@ace/protocol/suit-parts`
  (`suitParts`), documented with a sentence each in `docs/design/suit-parts.md`.
- Parts are public API. Renaming or removing one is a breaking change: it needs an alias for one
  release and a note in the parts doc. A test walks the rendered app and fails when a listed part
  is missing, so the list never drifts from the UI.
- Class names, DOM depth and Tailwind utilities are not part of the contract. A Suit that
  targets them is refused (see "suit.css").

### suit.css

- A Suit may ship `suit.css`. It is parsed (never applied as text), and only rules whose
  selectors are built from `[data-part]`, `[data-state]`, `[data-variant]`, `[data-scheme]`,
  pseudo-classes and pseudo-elements survive. Every rule is scoped to `[data-suit="<id>"]` and
  placed in `@layer suit`.
- Refused: `@import`, `url()` to anything but the Suit's own `assets/`, `expression`, `behavior`,
  `-moz-binding`, `content` with `attr()` of hidden data, and any selector naming a class, id or
  element. Each refusal comes back as a `SuitProblem` with the line, so an agent can fix it.
- Allowed: anything visual. Backgrounds (gradients, patterns, bundled images), borders, radius,
  shadows, filters, backdrop filters, fonts, letter spacing, text transform, `::before` and
  `::after` decoration, transitions and keyframe animations (bounded: see "Guard").
- Region backgrounds are first-class: the sidebar, rail, header, transcript, composer and every
  floating layer each read `--suit-<part>-background` and friends, so a Suit can give the sidebar
  its own image or pattern without CSS at all.

### Layout

`suit.json` gains `layout`, each from a fixed set so the app stays usable:

- `sidebar`: `left` or `right`; `rail`: `shown`, `hidden` or `merged` into the sidebar;
  `sidebarWidth` and `transcriptWidth` within ranges.
- `composer`: `docked` or `floating`; `header`: `bar`, `minimal` or `hidden` (title moves into
  the sidebar).
- `messages`: `bubbles`, `flat` or `cards`; `toolRows`: `compact`, `detailed` or `terminal`.

### Ornaments

- `ornaments` places static, sanitised SVG or HTML (no script, no event handlers, no external
  references) into named slots: sidebar header and footer, transcript top, empty states, the
  composer's top edge and the window's corners. This is how a Suit adds hazard stripes, stamps,
  title plates or a logo of its own.
- Short labels in fixed places (the composer placeholder, empty-state lines, the Working word)
  may be replaced from `labels`, a fixed map with a length cap. Status words stay ace's.

### Scenes per region

`scenes` maps a region (`app`, `sidebar`, `header`, `composer`) to a scene file. Each runs in
its own sandboxed iframe under the same rules, budget and watchdog as the app scene, sharing one
30 fps clock. Each region sets how much of its scene shows (`--suit-<part>-scene-opacity`),
within what the readability checks allow, so a backdrop is as visible as the Suit wants.

### Celebration (added 2026-11-15)

`scenes.celebration` is a moment, not a backdrop: a full-window scene ace mounts ABOVE the UI
only when the open thread's run finishes (`done`) or a linked pull request merges
(`pr-merged`). The scene hears that one signal right after `init` (`view.region` is
`celebration`), plays, and calls `ace.finish()`; ace unmounts it then, or after 4 s at the
latest. It plays at most once per 10 s, never on a hidden window and never under Reduce motion
(there is no still frame of a celebration). The pointer passes through it, and the live check
never samples it as a backdrop.

It never covers a protected part. Those sit inside stacking contexts of their own (the shell's
isolation, the composer, sheets and menus portaled to the body), so no z-index could slide the
layer between them and what surrounds them. Instead the layer sits over everything and its
`clip-path` cuts a hole, a few pixels larger, around every protected part's box, measured again
every 100 ms while it plays.

### Guard

ace's own `@layer guard` comes after `@layer suit` and keeps the state of an agent readable
whatever a Suit does:

- the approval strip, the Working line, waiting and failed markers, thread status icons and
  focus rings keep `display`, `visibility`, `opacity: 1`, a minimum size and ace's colours;
- no animation on them, `pointer-events` intact, never covered by an ornament or scene;
- Suit animations stop under Reduce motion, and infinite animations are limited to parts the
  contract marks decorative.

### Shown perfectly: checked in the browser

Static checks cannot see what CSS produces, so every apply also runs a live check in the client:
it renders the Suit, reads the computed colours of every text-bearing part over its actual
background (scene frames included), measures that protected parts are visible and unobscured,
and checks that nothing overflows its region at three window sizes. The result comes back to the
agent through `suit_apply` as `SuitProblem`s plus screenshots of the app in the Suit, so the
agent fixes what the person would have seen before the person ever sees it.

How it runs (added 2026-11-14):

- **Asking.** After a preview or keep passes the static checks, the daemon sends `suitCheck
{ checkId, suitId }` to every socket that may read the calling thread. A client that shows
  that Suit runs the check and answers once with the one-way `suitReport { report }`
  (`SuitLiveReport`: problems, the widths measured, parts it couldn't check, and a screenshot or
  why there is none). The daemon takes a report only from a socket it asked, for that check.
- **Waiting.** `suit_apply` waits at most 9 s for reports, and 1.5 s more once the first one
  lands, so a device without a live check (a phone) doesn't hold the agent. With no report it
  says only the static checks ran and points the agent at ace's browser.
- **Reading the scene.** The host may send a scene `sample { id, columns, rows }` (at most
  32 × 32); the runtime averages the canvas into that grid and answers `sample` with its RGBA
  bytes. The scene's code takes no part and the sandbox is unchanged: nothing reaches into the
  frame. A canvas the runtime can't read (it drew an image, which taints it under the opaque
  origin) answers nothing, and the text over it is reported as unchecked, never guessed.
- **Contrast.** Each text-bearing part's text and icon colours are composited over every layer
  up to the first opaque one: background colours, gradient stops (worst stop counts), element
  opacity and, under a scene, the sampled cells beneath the text. Text needs 4.5:1 (3:1 when
  large), icons 3:1.
- **Widths.** A page can't resize its window, so the narrower widths (1024 and 760 px, when
  the window is wider) are simulated by narrowing the app's container for a moment; media
  queries keep the real width, and problems say which widths were simulated.
- **Screenshots.** The desktop app captures its own window (`window.capture`, a JPEG under the
  socket's frame limit). A browser tab can't capture itself without asking the person, so it
  sends none and says so.

### On the fly

The daemon watches each Suit folder; any saved change re-runs the checks and pushes the new Suit
to every client, which swaps it without a reload. An agent editing `suit.css` sees each save
land in the open app.
