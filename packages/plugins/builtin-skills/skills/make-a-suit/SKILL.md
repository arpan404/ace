---
name: make-a-suit
description: Make or edit a Suit, a whole look for ace, from a description; check it as rendered, then preview it.
---

# Make a Suit

A Suit restyles all of ace: colours, fonts, shape, layout, CSS for every published part, ornaments, a few labels, the terminal and animated scenes. The person gives you a sentence ("brushed steel and amber", "a quiet paper notebook"); you design the look, write the files, and loop on `suit_apply` until what the checks and the screenshot show matches what they asked for. Use this skill to make a new Suit, or to change or fix one that exists.

Tool names: Claude Code `mcp__ace__suit_apply`; OpenCode and Pi `ace_suit_apply`; elsewhere `suit_apply`.

## References

Read a reference when its step needs it. With native skills it is the file beside this one; otherwise call `guide { topic: "make-a-suit", file: "<path>" }`.

| File                      | Read it for                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `references/design.md`    | Step 2, always: palette, type, shape, ornament and motion for a premium result; the checklist. |
| `references/suit-json.md` | Every `suit.json` field, its range and default.                                                |
| `references/suit-css.md`  | Selectors per area of the app, states, region backgrounds, fonts, keyframes.                   |
| `references/scenes.md`    | Only if the look moves: the `ace.scene` API, budget, signals, still frames.                    |
| `references/problems.md`  | Every check name and its fix; editing an existing Suit.                                        |

## The folder

```
~/.ace/suits/<id>/
  suit.json     required: colours, fonts, shape, motion, layout, labels, ornaments, scenes, reveal, regions, terminal
  suit.css      optional: styles for the published parts
  scene.js      optional: the app's backdrop; other regions name their own .js files
  assets/       optional: fonts, images, ornament .svg/.html
```

The id is lower-case words joined by dashes, at most 48 characters, and equals the folder name. To start from an existing look, copy any folder in `~/.ace/suits` to the new id and change `id` and `name`.

## The loop

1. **Understand the look.** Name its material (paper, glass, steel, felt, phosphor…), its light (one scheme or both), its era and its mood in a few words. If the sentence leaves one of these open, pick the reading that makes the strongest look; ask only when two readings would produce opposite Suits.
2. **Plan** before writing: the neutral ramp and the one accent per scheme, the type pairing, radius and density, the layout choices, and the one or two signature details (an ornament, a region background, a scene). Read `references/design.md`. Done when every palette field you will set has a value and a reason.
3. **Write** `suit.json` first (`references/suit-json.md`), then `suit.css` (`references/suit-css.md`), then any ornaments and scenes.
4. **Preview**: `suit_apply { mode: "preview", id }`. Static checks run first: `status: "refused"` returns `problems` and nothing applies.
5. **Read what the devices saw.** A preview that applies returns the live check's `problems`, `live.devices`, `live.unchecked`, and from the desktop app a screenshot. `live.source: "static"` means no window answered: look yourself with `browser_open` and `browser_screenshot` on ace's web app, in each scheme the Suit has.
6. **Fix** each problem at its `field` and in its `scheme`, nothing else (`references/problems.md`). Every save re-runs the checks and swaps the Suit into the open app; preview again for fresh problems and a new screenshot. Then polish: compare the screenshot with your plan and the person's sentence, and fix what reads wrong even when no check flags it.
7. **Keep or revert.** Done when `problems` is empty, the screenshot matches the plan in every scheme the Suit has, and the person chose. Ask within the turn (`ask`, or your own question tool), then `suit_apply { mode: "keep" }` or `{ mode: "revert" }`. A preview ends with your turn, so if you ask in your reply instead, tell them how to get it back ("say _keep <name>_") and `keep` with that `id` next turn. After a keep, one `revert` restores the look before it.

## Hard rules

- **Agent state is ace's.** `working-line`, `approval-strip`, `question-card` and `status-icon` are guarded parts: a Suit may frame them (padding, border, radius, font family, weight, text transform) and nothing more. Status colours, the danger fill and status words are never a Suit's. The accent stays clearly apart from the status hues (blue, amber, green, red, violet, pink).
- **Select parts only.** suit.css selectors use `[data-part]`, `[data-page]`, `[data-state]`, `[data-variant]`, `[data-scheme]`, allowed pseudo-classes and pseudo-elements. Each selector ends on a part. Classes, ids, element names and other attributes are refused.
- **Own variables are `--suit-*`.** Set ace's colour tokens in `suit.json`; suit.css defines only `--suit-` custom properties and reads ace's (`var(--color-foreground)`).
- **Files stay in the folder.** Every `url()` points into `assets/` (small raster `data:` images up to 8 KB excepted). No `@import`, no remote fonts, no `attr()`.
- **Normal declarations only.** `!important` is refused; a Suit's layer already wins over ace's own styles.
- **Motion yields.** Suit animations stop under Reduce motion automatically; design the still state as the real look, and give scenes a calm still frame.
