# Designing a premium Suit

A premium Suit reads as one deliberate object: a single material, a calm neutral ramp, one accent used sparingly, type that suits the material, and one or two signature details. Restraint is the leading word: every addition must earn its place in a tool people stare at for hours.

## Palette

Build each scheme as a **neutral ramp** plus **one accent**.

1. **Pick the ramp's hue and chroma.** Neutrals carry the material: warm grey for paper, blue-grey for steel, green-black for a CRT terminal. Keep chroma low (OKLCH chroma under about 0.03) so the accent and code colours stand out.
2. **Step the surfaces in lightness**, all one hue. Dark scheme, from deepest: `sidebar` ≤ `code` ≤ `canvas` < `surface` < `raised` < `hover` < `active`, each a few OKLCH lightness points apart (about 0.02–0.04). Light scheme: `canvas` and `surface` near white (`surface` may be pure white over an off-white `canvas`), `sidebar` a step darker, `raised` the lightest.
3. **Lines**: `border` a small step off the surfaces, `borderStrong` a clear step more. Hairlines should be felt, not seen.
4. **Text levels**, the same hue as the ramp: `text` at 12:1 or more on `canvas` (never pure white on dark; off-white with the ramp's tint), `muted` about 7:1, `subtle` 4.5:1 or a little more on every surface, `faint` 3:1 on `canvas` and only for icons.
5. **The accent**: one hue, used for focus, selection, primary actions and links. Choose it away from the status hues (blue working, amber needs you, green done, red failed, violet waiting, pink unresponsive): copper, bronze, warm orange, ice, rose-gold, chalk and graphite sit in the gaps; turn the hue 20–40° toward the middle of a gap rather than nudging one digit. Set `accentHover` one step brighter (dark) or deeper (light), `accentFg` white or near-black whichever reaches 4.5:1 on the accent, `accentText` a step toward the text colour so links read at 4.5:1 on `canvas`.
6. **Code**: `syntax` hues drawn from the material, with lightness kept close together so no token shouts; comments (`com`) near `subtle`. Diff fills (`diffAdd`, `diffDel`) are low-chroma washes of the canvas, their `Fg` colours saturated enough to read.
7. **Glass**: frosted floating layers suit glass, ice and night skies; set `glass` to `null` for paper, steel, terminals and anything flat.

Contrast targets in short: body and secondary text 4.5:1 on every surface they sit on, large text and icons 3:1, the accent 3:1 on `canvas`.

## Light and dark parity

Give both schemes unless the look is inherently one (a CRT terminal is dark; a paper notebook may be light). In two schemes the Suit must read as the same object: same hue family for the ramp, the same accent hue (tuned in lightness per scheme), the same type and shape. Derive one scheme from the other by mirroring lightness, never by inventing new hues. Check both in screenshots.

## Type

- **One family for the interface, at most one more for character.** Pair a neutral UI sans (`fonts.ui`) with either a distinctive prose face (`fonts.prose`) or a distinctive mono (`fonts.mono`), not both.
- Match the material: humanist sans and a book serif for paper; a grotesk and a technical mono for steel and drafting; a bitmap or terminal mono only where the whole look is a terminal.
- Bundle display faces in `assets/` as `.woff2`, with a system stack after them. System stacks (`"SF Pro Text", Inter, system-ui, sans-serif`) are fine and load instantly.
- Uppercase and letter-spacing belong to small labels and section titles only, never to body text.

## Shape and spacing

- `shape.radius`: 0–0.4 for technical, printed or brutalist looks; 0.8–1.2 for ace's own softness; 1.4–2 for friendly, glassy looks. One value for the whole Suit; suit.css corner radii should agree with it.
- `shape.border` 1 unless the material is engraved (1.5) or very fine (0.5–0.75).
- `shape.density`: `compact` for terminals and dense tools, `spacious` for reading-first looks; leave it unset to respect the person's choice.
- Layout changes are strong medicine: `messages: "flat"` and `toolRows: "detailed"` suit editorial and technical looks; `composer: "floating"` suits glass; move the sidebar or hide the header only when the look demands it.

## Ornament and motion

- At most one or two signature details: a title plate in `sidebar-footer`, a hairline gradient under `sidebar-header`, a paper grain on `transcript`, a corner mark. Ornaments use `currentColor` so they follow the scheme.
- Region backgrounds beat ornaments: a texture on the sidebar or a soft gradient on the app frame changes the whole feel at no reading cost.
- Motion: transitions 120–200 ms on hover and selection; at most one ambient animation (a scene or a slow decorative loop). Nothing moves under text. Under Reduce motion the still look must be complete.
- `labels` are seasoning: one placeholder in the Suit's voice is charming; five is a costume.

## Checklist

Before keeping, every line is true:

- [ ] Each scheme sets the whole ramp: every surface, both lines, all four text levels and the four accent fields.
- [ ] One accent hue, clear of every status hue; no second accent appears anywhere in suit.css.
- [ ] Text levels step evenly; `muted` and `subtle` are visibly different.
- [ ] Type: at most two families plus mono, each chosen for the material.
- [ ] Corner radii in suit.css agree with `shape.radius`.
- [ ] Hover, active, selected, focus and disabled states look intentional on thread rows, buttons, menu items and tabs.
- [ ] Settings' controls match the rest: buttons and links, switches and their thumbs, sliders, segmented controls and their selected segment.
- [ ] The work log's group headers and step icons, and the composer's strip with a queued message, belong to the Suit.
- [ ] Menus, dialogs, toasts and the composer look like the same material as the sidebar.
- [ ] Code blocks, diffs and the terminal belong to the palette.
- [ ] Settings, Usage and a pull request page look as finished as a thread (open them in the screenshot or in ace's browser).
- [ ] The screenshot in each scheme reads calmly at a glance and matches the person's sentence.
- [ ] `suit_apply` returned no problems, and `live.unchecked` parts were judged from the screenshot.
