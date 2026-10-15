# DESIGN.md

The convention every UI change in ace follows and every UI review checks. It names tokens; raw values live in the token source (`apps/web/src/theme/sources/*.ts`, `apps/web/src/styles/tokens.css`, `motion.css`, `glass.css`) and are documented in [docs/design/visual-language.md](docs/design/visual-language.md). The reasoning behind the current direction is in [docs/design/2026-10-14-ui-quality-proposal.md](docs/design/2026-10-14-ui-quality-proposal.md). When this file and `visual-language.md` disagree, this file wins for _what to do_; `visual-language.md` wins for _what a token is worth_. (`DESIGN-fable.md`, referenced in old comments, lived in the prototype folder and is superseded by this file.)

## 1. Principles

1. **Every element shows state the user acts on.** If it only describes the UI, it goes.
2. **Hierarchy by one step at a time.** Text tiers, weights, surfaces and hairlines each move exactly one step between neighbours; never two devices for one distinction.
3. **Colour means state.** Status hues are the only colour in lists and chrome. Identity (projects, providers) is monochrome ink.
4. **Edges before air.** Separate things with hairlines, weight and size before adding space.
5. **Materials, not panels.** Floating layers are glass with an edge and a shadow; content is opaque. Controls and the composer carry a little depth (a lit top edge, a 1px lift); content never does.
6. **Density is a setting, hierarchy is not.** Compact removes padding, never tiers.
7. **Motion confirms, never entertains.** Things arrive; they don't fly.
8. **Correct before pretty.** Never show an agent as done while any part of its tree works or waits (AGENTS.md priority 1).

## 2. Tokens

### Colour roles and text tiers

| Token                                            | Use when                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `--foreground` (text)                            | The thing to read: titles, answers, selected labels, values.                                          |
| `--muted-foreground`                             | Secondary: project names, descriptions, tool rows, metadata beside a title.                           |
| `--subtle-foreground`                            | Tertiary: timestamps, counts, shortcuts, placeholders, branch names.                                  |
| `--faint-foreground`                             | Decorative icons, carets, disabled-looking affordances. Never for words.                              |
| `--ring` / `--ring-foreground`                   | The accent as a fill and the label on it: primary button, checked controls, caret, Send.              |
| `--ring-text`                                    | The accent as text: links, the current view.                                                          |
| `--status-*` / `--status-*-text` via `data-tone` | Dots and words for working, needs-you, waiting, unresponsive, failed, done. The only colour in lists. |
| `--destructive` / `--danger`                     | Destructive labels; the solid danger button.                                                          |

Rules: never hard-code a colour; never put a status hue on something that is not that status; icons take `currentColor` at the row's tier.

### Surfaces and elevation

`--background` (page and reading column) → `--sidebar` / `--panel` (navigation, side panels) → `--surface-1` / `--card` / `--bubble` (grouped content, user bubble, code) → `--surface-2` / `--popover` (solid floating). Washes: `--hover`, `--active` (= `--fill`, `--fill-strong`). Elevation is an edge plus a shadow (`--float-edge`, `--float-shadow`); content never casts a shadow.

**Depth** is a separate, smaller device for things you press or type into, from the `--depth-*` tokens in `theme/tokens.ts`. Use only these; never write a one-off shadow.

| Token               | Where                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `--depth-highlight` | Lit top edge: the composer, the attached strip, the active tab.                                      |
| `--depth-dock`      | The composer's soft lift off the page.                                                               |
| `--depth-strip`     | The smaller lift of the card attached above the composer.                                            |
| `--depth-raise`     | 1px rest shadow: secondary, outline and split buttons, active tab, picker previews.                  |
| `--depth-fill`      | Highlight and bottom shade on an ink or coloured fill: primary, danger, Send/Stop, checked checkbox. |
| `--depth-well`      | Slight recess of text inputs.                                                                        |

Pressed controls drop their depth (`active:shadow-none`). Rows, cards, bubbles, the sidebar, settings cards and the header stay flat.

### Hairlines

`--border` between rows and sections; `--border-strong` (= `--input`) on control edges and text fields. Use the separator helpers in `components/ui/rules.ts` (`toolbarEdge`, `sectionRule`, `listDivider`, `controlDivider`); don't draw ad-hoc borders. Nothing in the sidebar is ruled: task rows are separated by space, not dividers.

### Radius

One scale, from `tokens.css` ("Corners"); never a literal radius.

| Class                                           | Default | Use                                                                                |
| ----------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `rounded-xs`                                    | 4       | Tags, inline code, project marks                                                   |
| `rounded-sm`                                    | 6       | Controls ≤ 26px, tooltips, previews inset in a card                                |
| `rounded-md`                                    | 8       | Buttons, inputs, selects, rows (sidebar, menu, palette, list), segmented tab lists |
| `rounded-lg` / `rounded-card` / `rounded-popup` | 12      | Cards, popovers, menus, dialogs, bubbles, code blocks, toasts                      |
| `rounded-xl`                                    | 18      | The composer, its attached strip, the file-drop target                             |
| `rounded-full`                                  | —       | Send/Stop, avatars, accent discs, segmented control, pills                         |

The Appearance **Corners** setting (Sharp 2/3/4/6/10, Default, Round 6/9/12/16/24) rescales every step, so any component built from the scale follows it.

**Radius agrees with padding.** The corner must never be larger than the padding beside it, or the content looks pinched into the curve:

- A surface's radius is at most its horizontal padding (a 12px-padded row takes 8, not 12 or 14).
- Pick the radius by the element's size: about a quarter of its height for controls (24px → 6, 30–36px → 8). Larger radii make a control read as a pill; use `rounded-full` if that is what you mean.
- **Concentric nesting:** inner radius = outer radius − the inset between them. A 12px menu with a 4px inset has 8px items; a 12px picker card with a 6px inset has a 6px preview; a 8px segmented list with a 2px inset has 6px tabs. When the arithmetic doesn't land on the scale, change the inset, not the radius.
- A floating ring or focus ring outside an element follows its radius automatically (box-shadow spread); don't give it its own.

### Spacing

4px grid: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48 (2px steps below 12 for row and control insets only). Insets `--surface-inset` (12) and `--surface-gap` (8). Row heights from `--row-height`, `--setting-row-height`, `--picker-row-height`, `--control-height`, `--composer-control`. No 14px insets.

### Type

`text-2xs` 10.5 badges · `text-xs` 12 metadata and shortcuts · `text-ui` / `text-sm` 13 controls, menus, tool rows · `text-base` / `text-md` 14 titles and the composer · `text-prose` the transcript (`--transcript-size`) · `text-lg` 18 dialog titles · `text-xl` / `text-2xl` page titles. Weights: 400 body, **500 titles and selected labels**, 600 page titles and bold in prose. `tracking-title` on titles 18px and up. Mono (`font-mono`) for branches, paths, commands, code. `text-meta` (11.5) for a row's project, branch and status lines. Themes never change type.

### Icons

Phosphor only, `regular` weight. 16px beside 13–14px text, 14px beside 12px, 12px for status glyphs (`bold` at 12px only). Provider marks keep their own colours; project marks are quiet (greyed and dimmed) on settled rows. When a provider has more than one account, the account's mark sits as an 11px ink bubble on the provider glyph's bottom-right corner (`ProviderAccountIcon`), its outline cut out of the glyph with a mask rather than a ring, so it reads on any surface. One account: no bubble. Favicons and app icons at 16px with `rounded-xs`.

### Motion

`--motion-fast` hover, colour, press · `--motion-base` popovers, menus, tooltips, new rows · `--motion-slow` panels, sheets, list moves, theme cross-fade · `--motion-exit` anything leaving. Curves `--ease-out` (default), `--ease-spring` (arrivals, segmented thumbs), `--ease-sheet` (sheets), `--ease-exit`. Animate only `transform` and `opacity`. No `infinite` animation except the live-activity indicators listed in `visual-language.md`.

### Glass

Two levels. **`glass-thin`** (`.ace-floating`): menus, popovers, selects, context menus, hover cards, toasts, the palette panel. **`glass-regular`** (`.ace-glass-dock`): the composer and the cards attached above it, one material, one blur. **Solid** (`.ace-floating-solid`): dialogs, tooltips, the Work card, anything that holds content, anything opened from glass. Never glass on glass; never glass on a scrolling area; the sidebar, page and side panels are opaque. Text on glass uses the glass inks the material provides; status words keep their opaque colours.

## 3. Layout

- **Shell:** `[sidebar 280] [header 44 / content / composer]` with an optional right panel. Header order in a thread: `[sidebar toggle] [mark] project / Title … [⋯] [Work] [panel toggle]`. The header draws a `--border` under itself once the content has scrolled.
- **Content widths:** the transcript and the composer share `--column` (Chat width setting). Settings pages use `--settings-column`. Wizards and empty states centre a 480px column.
- **Settings page anatomy:** page title (`text-xl` 600), optional one-line description (`muted`), then `SettingSection`s 24px apart. A section is a header plus one card. The title row carries **at most one action** on the right; an Enabled toggle is the first row of the first card; other actions live in the header ⋯ menu.
- **Section header:** 13px/500 `--muted-foreground`, 6px above the card. Explanations of a whole group go in the section `note` above the card, one or two lines.
- **Setting row:** `--setting-row-height`, label (`text-ui` 500) left, optional one-line description (`text-xs` subtle) under it, the control right-aligned at a fixed width (select 160–200, text 160, number 80 + unit, toggle, segmented). Add actions are a `SettingAddRow` inside the card. Notes and footers use `SettingNote` and `SettingFooter`.
- **List row (sidebar task):** 80px, three lines of 16/20/16 with 4px between them and 10px above and below, 12px side padding, `rounded-md`, inset 8px from the sidebar edge, 4px between rows, no dividers. Line 1 (`text-meta` muted): project mark + project name … status word or relative time. Line 2: title (`text-md` 500). Line 3 (`text-meta`): branch (mono) · PR … machine only with more than one device · provider glyph with the account bubble. Open thread: `--active` fill, no bar; hover: `--hover`. Hover actions appear beside the status, which stays. Settled rows are one 32px line, muted (title subtle, project mark greyed), showing the PR or `+added −removed`, then the age.
- **View rows** (settings nav, automations, skills): `ViewRow`, 32px, `rounded-md`, selected = the same `--active` fill as the task list.
- **Side panel:** toolbar (44px, `toolbarEdge`) with a `SegmentedControl` or `Tabs`, a close and an expand icon; body opaque; sections separated by `sectionRule`; `rowCard` for outlined list rows. Nothing else is drawn.
- **Dialog:** `rounded-card`, 20px padding, solid, 480px (confirmations) or 640px, title `text-lg` 600, body `text-ui` muted, footer right-aligned: Cancel then the action. Danger confirmations: solid red action, focus starts on Cancel.
- **Popover / menu:** `rounded-popup`, 4px padding, 30px rows `rounded-md` (concentric), 16px icon muted, label `text-ui`, shortcut `text-xs` subtle right-aligned; `--border` separators with 6px margins; destructive rows in `--destructive`.
- **Toast:** bottom-right of the content column above the composer dock, 320px, `glass-thin`, icon + one line + optional action, gone in 4s. Never over the header, never under the composer.
- **Empty state:** `EmptyState` centred: faint icon, title (`text-base` 500), one muted line, one secondary action. Never a bare sentence at the top of a page. Before a query, search and the palette offer recents and commands, not prose.
- **Error state:** the same anatomy with the failed glyph; the line says what happened and what to do, in that order.
- **Loading:** skeleton pills (`--skel`) in the value slots at the control's size; labels and headers render as normal. Spinners only for live work (the working glyph, Send → Stop), never as a page's loading state. The boot splash is the only full-page spinner.

## 4. Components

| Component               | Rule                                                                                                                                                                                                                               | Do                                           | Don't                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| **Button `primary`**    | The one action a surface exists for. Ink fill, white label, `--depth-fill` + `--depth-raise`, flat when pressed.                                                                                                                   | "Allow once", "Run now", "Save"              | Two primaries on one surface; a primary in a toolbar    |
| **Button `secondary`**  | Any other labelled action; outlined so it reads as a button at rest.                                                                                                                                                               | "Deny", "Cancel" beside a primary, "Preview" | Outlined buttons as tabs or filters                     |
| **Button `ghost`**      | Actions inside dense chrome: toolbars, row hovers, dialog Cancel.                                                                                                                                                                  | Row actions, header icons                    | Ghost for the main action of a page                     |
| **Button `danger`**     | The confirming action of a destructive confirmation only.                                                                                                                                                                          | "Stop and delete", "Revoke"                  | Red for "Stop" or "Archive"; red outlines               |
| **`tone="danger"`**     | A ghost or secondary that _opens_ a destructive confirmation; destructive menu rows.                                                                                                                                               | "Delete thread" menu row                     | Colouring the confirming button with it                 |
| **IconButton**          | Square, 30px (`sm` 24, `lg` 34), `rounded-md` (`sm` `rounded-sm`), `aria-label` is the tooltip.                                                                                                                                    | Header ⋯, panel toggle                       | Icon-only without a label; icon + text in an IconButton |
| **Input**               | 32px, `rounded-md` like buttons and selects, `--field` fill, `--border-strong` edge, `--depth-well`, placeholder subtle.                                                                                                           | Settings text fields, search                 | Underlines; borderless inputs outside sidebars          |
| **Select**              | `Select` (never native) for 4+ options; shows the value, caret faint.                                                                                                                                                              | Default provider, Chat width                 | A select for 2–3 states                                 |
| **Toggle**              | `Switch` for on/off that applies at once.                                                                                                                                                                                          | Notifications, Enabled                       | A toggle that needs Save                                |
| **Slider**              | `Slider` with the value at the right (tabular numbers) and a one-shot preview when the setting is visual.                                                                                                                          | Contrast, Translucency, Motion speed         | Sliders for discrete choices under 5                    |
| **SegmentedControl**    | 2–4 exclusive states in a toolbar or row; 28px; thumb springs.                                                                                                                                                                     | Read-only / Ask / Auto review / Full access  | Segments as page navigation; more than 4                |
| **Tabs**                | Panel sections: 28px, `rounded-sm`; the active tab takes an 8% ink fill with `--depth-highlight` + `--depth-raise`.                                                                                                                | Side panel sections                          | Underlines and pills mixed in one bar                   |
| **Chip / Badge**        | `rounded-xs`, 20px, `text-xs`, surface fill, monochrome.                                                                                                                                                                           | File chips, model chip, counts               | Coloured badges for identity                            |
| **Status glyph + word** | `StatusGlyph` 12px and `StatusLabel`, via `data-tone`. Colour never alone: a glyph or a word accompanies it.                                                                                                                       | "● Approve", "✕ Failed"                      | A bare coloured dot; a coloured title                   |
| **Link**                | `text-link`, no underline at rest, underline on hover; only for navigation.                                                                                                                                                        | "Open source", docs                          | Links styled as buttons; buttons styled as links        |
| **Disclosure**          | `Disclosure` / `SettingDisclosure` with the Phosphor caret.                                                                                                                                                                        | "Worked for 2m ›", "Advanced ›"              | The browser's triangle; chevrons that don't turn        |
| **Picker card**         | Mode and Theme: the preview is the choice, no card around it; name centred below; the chosen one takes the accent ring 2px outside its edge. Previews are the app in miniature in the theme's own tokens, in the scheme on screen. | Mode, Theme                                  | Grey cards, check badges, heavy outlines                |
| **Code**                | Inline `code` on `--code` at 0.92em; blocks with a header that holds the language and Copy (muted, brighter on hover).                                                                                                             |                                              | Copy buttons floating over content                      |

## 5. State and attention

- **Attention levels** (`rowAttention`): _needs-you_ is always strong (status colour, 500). _failed_ is strong until seen, then a quiet word. _working_ and _background_ are muted (muted ink, no clock) unless the row is selected, when the word takes its colour and shows elapsed time. _done-read_ is muted with only a relative time. The open thread reads at full contrast.
- **Colour means state.** Working blue, needs-you amber, failed red, done green, waiting violet, unresponsive pink. Never reuse these for anything else; never show a status by colour alone.
- **Focus:** `focus-ring` (2px gap, 2px `--focus`) on controls; `focus-ring-inset` on rows inside scrollers; on glass the ring is the full-strength ink. A dialog's auto-focused Cancel shows a hairline until a key is pressed. Programmatic focus targets show no ring.
- **Hover:** `--hover` wash, text one tier stronger. **Press:** `--active` wash, `scale(0.98)` (not under reduced motion), shadows removed. **Open/expanded:** `aria-expanded` takes the `--active` wash.
- **Disabled:** 40–50% opacity, no pointer events, and a `reason` tooltip when the user could fix it.
- **Selection:** `--active` fill on the row's rounded box for lists; the primary fill for checked controls; `::selection` is the accent at 32%.

## 6. Copy

- Plain, direct, present tense. Say what happened, then what to do. No exclamation marks.
- **Sentence case** everywhere, including view names: "Back to home", "Go to activity". Product names keep their case.
- **Buttons are verbs** that name the outcome: "Allow once", "Stop and delete", "Pair a device". Never "OK", "Yes", "Submit".
- Status words are the vocabulary in `@ace/ui-core`: Approve, Answer, Working, Failed, Done, Waiting. Don't invent synonyms.
- **Errors** name the thing and the cause in one line and offer the next step: "Couldn't copy the link. Clipboard access is blocked in this browser." No codes in the first line; Details holds them.
- **Nothing narrates the UI**: no "Beginning of thread", no hint prose under controls, no "Tip:" rows, no always-visible explanations of what a button does. Explanation goes in a section note, once, or in a tooltip.
- Numbers use tabular figures; times are relative in lists ("9m", "2h", "Mon") and absolute in detail views.

## 7. Accessibility

- Text ≥ 4.5:1 on every surface it sits on (`--foreground`, `--muted-foreground`, status words); tertiary hints and icons ≥ 3:1. The theme tests enforce this for every theme × scheme × accent, and the glass solver enforces it over blurred backdrops. Contrast settings may not drop below these floors.
- Hit targets: 30px on fine pointers; 44px on coarse pointers via `touch-hit` (never by growing the control). Rows ≥ 32px.
- Keyboard: everything reachable in DOM order; lists use arrow keys and `data-row-focus`; menus trap focus; `Escape` closes the top layer only. Focus returns to the control that opened a layer.
- Reduced motion (`[data-reduce-motion]`): fades stay, distances and scaling go to zero, `.fx-flourish` stops; live-activity indicators keep running.
- Reduced transparency (`prefers-reduced-transparency`) and the Solid setting: `data-surface="solid"`, no backdrop filter anywhere; the same edge and shadow carry elevation.
- Every icon-only control has an `aria-label`; every status has a word for assistive tech, never a colour alone.

## 8. Owner decisions (binding)

- **Clean, T3-like UI:** every element shows state the user acts on; nothing narrates the UI to itself.
- **Sidebar:** one flat task list across projects, never grouped by project; three-line rows as specified in §3; no dividers, space between rows like T3; the open row is a soft rounded fill; settled threads are one muted line with their PR or diff.
- **Attention levels:** as in §5.
- **Composer:** nothing renders below it; exactly one strip slot above it (approval/question first), tucked under the composer's edge; Send and Stop are round; live state is the inline "Working for …" line at the end of the transcript; finished turns fold into "Worked for …" disclosures.
- **Themes:** Mode (Light/Dark/System) is separate from Theme; themes are **colour only** (no fonts, material or spacing) and the set is ace (default), Paper, Midnight, Grove, Harbor, Dusk, with status colours the same in every theme; the accent picker stays; floating layers are glass and the composer is translucent glass; motion is 120/200/320 with the spring `linear()` curve. Mode keeps its three preview cards. Corners is a user setting (Sharp, Default, Round).
- **Depth:** the composer, its strip and pressable controls carry subtle depth (§2 Surfaces and elevation); the earlier "no material effects" rule is retired.
- **Danger confirmations:** solid red button, focus starting on Cancel.
- **Header order:** `[title] [⋯] [Work icon] [panel toggle]`; Work info is a compact floating card.
- **Model control:** one composer control (model chip + speed icon + effort label) with a T3-style list popover.
- **Real icons only:** provider marks, Phosphor, favicons. No emoji.

## 9. Review checklist

Answer every one with yes before approving a UI PR.

1. Does every new element show state the user can act on, with no narrating or hint prose?
2. Are all colours tokens, with status hues used only for status?
3. Do text tiers follow §2 (title 500, secondary muted, tertiary subtle, icons faint)?
4. Are rows, controls and insets on the grid at the token heights, with no 14px literals?
5. Are radii from the scale, no larger than the padding beside them, sized to the element, and concentric when nested (§2 Radius)? Does the page still look right under Corners → Sharp and Round?
6. Do separators come from `rules.ts`, with nothing in the sidebar ruled?
7. Is depth only from `--depth-*`, on controls and the composer, never on content? Is every floating layer `.ace-floating`, `.ace-glass-dock` or `.ace-floating-solid`, with no glass on glass or on a scroller?
8. Do primary/secondary/ghost/danger follow §4, with one primary per surface and danger only on the confirming action?
9. Does the page title row carry at most one action, and do add actions sit inside cards?
10. Do empty, error and loading states use `EmptyState` and `--skel` as in §3?
11. Are tabs either `SegmentedControl` or `Tabs`, never a third style?
12. Does every animation use `--motion-*` and `--ease-*`, animate only transform/opacity, and respect `[data-reduce-motion]`?
13. Is focus visible on every interactive element, and does focus return to the opener when a layer closes?
14. Are hit targets 30px fine / 44px coarse, and does every icon-only control have an `aria-label`?
15. Is copy in sentence case with verb buttons, and do errors say what happened and what to do?
16. Were the 390, 768, 1440 and 1920 widths checked in light and dark, with screenshots in the PR?
17. Does `bun run check` pass, including `check:ui` and the theme contrast tests?
