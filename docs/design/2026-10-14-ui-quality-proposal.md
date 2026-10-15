# ace web UI: why it reads below t3code, and what to change

Date: 2026-10-14. Status: proposal, not implemented. Mockup: [2026-10-14-ui-quality-mockup.html](2026-10-14-ui-quality-mockup.html). Screenshots: [2026-10-14-screens/](2026-10-14-screens/) (1440×900 at 2×, fake daemon, default ace theme, light and dark).

Everything here respects the settled owner decisions (flat task list, three-line rows, one strip slot, round Send/Stop, six themes with Mono as default, glass on floating layers and the composer, Phosphor icons). Where a finding touches one of those decisions it is raised as a question in §5, not changed.

How this was measured: the app was run with `bun run dev:fake`, screenshotted with Playwright, and computed styles were read from the DOM. t3code was studied by reading its stylesheet and screenshots to extract decisions and numbers; no code was copied.

## 1. Diagnosis

The short version: ace's tokens are sound and its layout rules are right, but the **rendering of hierarchy is flat**. Text tiers are too close together, weights are uniform, colour is spent on things that are not state, surfaces are separated by air instead of edges, and the glass reads as grey instead of glass. t3code looks better not because it has more decoration but because every level of its UI is one clear step from the next.

### 1.1 Secondary text is nearly primary, so nothing recedes

| Tier   | ace light | ratio on white | ace dark | ratio on #0D0D0D |
| ------ | --------- | -------------- | -------- | ---------------- |
| text   | #111111   | 18.9:1         | #F0F0F0  | 17.1:1           |
| muted  | #454545   | **9.6:1**      | #B2B2B2  | **9.2:1**        |
| subtle | #646464   | 5.9:1          | #949494  | 6.4:1            |
| faint  | #939393   | 3.1:1          | #636363  | 3.2:1            |

(Source: `apps/web/src/theme/sources/ace.ts`; computed values from the running app.)

The muted tier sits at 9–10:1. In the sidebar crop ([10-crop-sidebar-light](2026-10-14-screens/10-crop-sidebar-light.jpg)) the project name, the title and the branch all read at roughly the same darkness; the eye has to parse the row by position. In the transcript ([02-thread-long-light](2026-10-14-screens/02-thread-long-light.jpg)) tool labels, timestamps and the "Worked for" line are the same ink as the answer. t3code's principle: secondary text sits around **4.5–5:1**, tertiary near 3.5:1, and only the thing you are supposed to read sits above 12:1. The gaps between tiers are what make a screen feel designed.

### 1.2 One weight everywhere

Measured in the DOM: sidebar title 14px/400, project line 12px/400, status word 12px/400, header title 14px/400, menu items 13px/400. `index.css` says "Weights: 400 and 500; 600 for titles only", and in practice 500 is rare. t3code sets row titles and dialog titles a step heavier than their metadata (medium/semibold against regular), and uses that single weight step as the main hierarchy device. In ace the title line of a sidebar row is not visibly the title.

### 1.3 Sidebar rows are rounded cards, not list rows

`features/home/thread-row.tsx` (line 21) says it in a comment: "Rows are apart by the list's spacing, not rules: hover fills a rounded box, and the open thread is a raised card." The row is `rounded-md` (10px), 80px tall, and the open thread gets a grey slab ([01-home-light](2026-10-14-screens/01-home-light.jpg)). This is the opposite of the settled decision (full-width rows, hairline dividers, no rounded cards or tints), and it is the single biggest reason the sidebar looks heavier than t3code's. The t3code list ([/tmp/t3ref/shot1.jpg](/tmp/t3ref/shot1.jpg)) is hairline-divided, edge to edge, with selection shown by a quiet fill that runs to both edges.

Two smaller issues on the same row: on hover the status word is replaced by a clock and a "⋯" ([13-crop-sidebar-hover-dark](2026-10-14-screens/13-crop-sidebar-hover-dark.jpg)), so the one piece of state the row exists to show disappears exactly when the user looks at it; and the row keeps a 10px radius on hover and selection, which is where the "card" feel comes from.

### 1.4 Colour is spent on identity, not state

In one sidebar viewport there are purple, teal, amber and red project badges, a red-orange Claude mark and a black OpenAI mark per row, green pull-request numbers, blue working glyphs and amber "Approve" words. The default theme's own description is "status is the only colour". t3code's row has a **monochrome** project mark (dark square with a letter), a monochrome provider glyph, and exactly one coloured element: the status word. Colour then means "something changed", which is what an attention list needs.

### 1.5 The transcript has no vertical rhythm

In the long thread each short agent message is its own block with its own margin, so consecutive one-line paragraphs sit about 72px apart ([02-thread-long-light](2026-10-14-screens/02-thread-long-light.jpg)); the "Worked for" disclosure then opens into a left-ruled list with 48px steps ([15-worked-for-open-light](2026-10-14-screens/15-worked-for-open-light.jpg)). Prose is 14px/22.4px. Tool rows ("Searched …", "Running in background …") are the same 14px ink as the answer, so a tool call and a sentence weigh the same. t3code's transcript ([/tmp/t3ref/shot3.jpg](/tmp/t3ref/shot3.jpg)) keeps the answer at a comfortable reading size, shrinks process rows a step and mutes them, and separates turns with a hairline plus a "Worked for" summary rather than with air. Air between equal-weight blocks reads as emptiness; a hairline plus a size step reads as structure.

The minimap tick marks in the left gutter (visible in every long-thread screenshot) look like rendering artifacts at 1440px. They may be useful at 1920px but they add noise to the reading column.

### 1.6 The composer and the strip are two grey slabs

Measured: composer radius 22px, border 1px #E6E6E6, background `white at 52%`, box-shadow none; the approval card above it is another 22px-radius slab with ~24px padding ([11-crop-composer-strip-dark](2026-10-14-screens/11-crop-composer-strip-dark.jpg)). Over a white page a 52% white tint with a hairline looks like a flat grey rectangle; there is nothing behind it to frost at the bottom of a thread, so the glass does not read as glass. t3code's composer is a raised object: a soft shadow pulled in under the surface (`0 12px 28px -18px`), a seam gradient where an attached card meets it, and a tighter radius relative to its height. The principle: a floating control needs an **edge and a shadow**, in that order, before transparency means anything.

### 1.7 Buttons and controls are flat

`components/ui/button.tsx`: primary is a solid fill, secondary is a 1px inset hairline, ghost is text. There is no press state beyond `scale(0.98)` and no surface cue. "Allow once" / "Deny" in the strip read as a black pill and a grey outline ([04-thread-approval-light](2026-10-14-screens/04-thread-approval-light.jpg)). t3code gives every solid or outlined control a **1px border, a 1px inner highlight at the top, and a very small drop shadow**, removed on press. It is almost invisible as decoration but it makes controls feel like objects. This is the "craft" gap the owner is sensing.

### 1.8 Radii are not concentric

Current: tags 4, controls 8, `--radius` 10 (used for 30px buttons and 80px rows alike), cards and popups 14, composer 22, menu rows 10 inside 14px popups with 4px padding (which is concentric), settings previews 14. A 30px-tall button with a 10px radius is a pill-ish blob; an 80px row with a 10px radius is a card. t3code: control radius 8px, base 10px, and large surfaces step up by exactly the padding. A fixed rule (inner radius = outer radius − padding) and fewer values would make everything look like one family.

### 1.9 Glass does not read as a material

The owner's words: "our UI translucency is not actual Apple-style translucency, it feels weird." The crops agree: [21-glass-menu-over-sidebar-light](2026-10-14-screens/21-glass-menu-over-sidebar-light.jpg) shows sidebar text legible through the menu; [21-glass-menu-over-sidebar-dark](2026-10-14-screens/21-glass-menu-over-sidebar-dark.jpg) shows a flat #2A2A2A panel that could be solid; [20-glass-composer-over-text-light](2026-10-14-screens/20-glass-composer-over-text-light.jpg) shows a milky slab with a sharp transcript line cutting across its bottom edge. The causes are specific and are taken apart in **§6 Glass**, with a recipe that keeps the slider's 100% end clearly translucent and gets readability from vibrancy-style aids rather than opacity.

### 1.10 Dark mode: sidebar darker than the page, borders too faint, text too bright

Dark canvas #0D0D0D, sidebar #080808, border #212121, muted #B2B2B2. The sidebar being darker than the content inverts the light-mode relationship (where the sidebar is darker too, but the content is white) and makes the window read as OLED black with light grey text. The 1px #212121 hairline is 1.2:1 against #0D0D0D, so panels do not separate ([01-home-dark](2026-10-14-screens/01-home-dark.jpg)). t3code's dark mode uses a near-black canvas but borders as **white at 6–8% alpha**, hover as white at 4%, and keeps secondary text around #a3a3a3. The alpha approach makes the same hairline work on every surface.

### 1.11 Settings → Appearance is oversized

Three 270px-wide "Mode" preview cards and six theme cards fill the page before the user reaches anything else ([09-settings-appearance-light](2026-10-14-screens/09-settings-appearance-light.jpg)). The accent picker uses glossy spherical gradients. t3code's appearance page is a segmented control for mode, a row of flat theme swatches with a name, and a list of settings rows. Preview thumbnails are good for themes; they are overkill for Light/Dark/System.

### 1.12 Icons are correct but noisy

Phosphor regular at 16px against 13px text is right. The noise comes from mixed intents: coloured provider marks in rows, a hand glyph for "Ask", a clock for "snooze" appearing on hover, PR icons in green, device icons at 16px beside 12px mono text. Rule needed: icons in a row are `currentColor` at the row's tier; colour only on status glyphs; icon size tracks text size (16 for 13–14px, 14 for 12px, 12 for status dots and glyphs).

### 1.13 Motion is good; one curve is too playful

Tokens (120/200/320, exits 140) match the decision. The spring peaks at 1.033 overshoot, which is visible on menus and reads slightly toy-like for a utility app. Reducing the overshoot to about 1.012 and shortening popover entry to 160ms keeps the life without the bounce. Nothing else here needs to change.

### 1.14 Focus is fine; the "auto-focused" hairline is right

The ring is 2px of ink at 60% with a 2px gap; dialogs auto-focus Cancel with a hairline. This matches t3code's approach (2px inset ring, 1px offset). Keep it. The only change is tied to §1.9: on glass layers the ring colour should be the solid ink, not a 60% mix, or it vanishes against the tint.

### 1.15 Header: right structure, light title

`[sidebar toggle] [badge] project / Title … [⋯] [Work] [panel]` is the agreed order and the Work dot works. The title is 14px/400 on a 44px bar with no bottom rule, so the header does not read as a header when the transcript starts with a user bubble ([01-home-light](2026-10-14-screens/01-home-light.jpg)). A 500 weight title and a hairline under the bar (or a 1px shadow on scroll) fix this.

## 2. Design system proposal

Values are for the default **ace (Mono)** theme. Zero chroma throughout; status is the only colour. All hexes were checked with a WCAG script; OKLCH lightness is given so other themes can be derived on the same curve.

### 2.1 Neutral ramps

**Light**

| Step | Name          | Hex       | OKLCH L | Role                                                    |
| ---- | ------------- | --------- | ------- | ------------------------------------------------------- |
| 1    | canvas        | #FFFFFF   | 1.000   | page, reading column                                    |
| 2    | sidebar       | #F6F6F6   | 0.973   | sidebar, side panel                                     |
| 3    | surface       | #F0F0F0   | 0.955   | cards, user bubble, settings groups, code               |
| 4    | raised        | #FFFFFF   | 1.000   | solid floating layers, composer body                    |
| 5    | hover         | black 5%  | –       | hover wash (alpha, works on 1–4)                        |
| 6    | active        | black 9%  | –       | pressed/selected wash                                   |
| 7    | border        | black 8%  | –       | hairlines (1px)                                         |
| 8    | border-strong | black 16% | –       | control edges, inputs                                   |
| 9    | faint         | #8F8F8F   | 0.650   | decorative icons (3.2:1 on canvas)                      |
| 10   | subtle        | #6A6A6A   | 0.52    | tertiary text, timestamps (5.3:1 canvas, 4.7:1 surface) |
| 11   | muted         | #575757   | 0.457   | secondary text (7.2:1 canvas, 6.3:1 surface)            |
| 12   | text          | #171717   | 0.205   | primary text (17.9:1)                                   |
| –    | disabled      | #A8A8A8   | 0.732   | disabled labels (2.4:1, by design)                      |

**Dark**

| Step | Name          | Hex       | OKLCH L | Role                                   |
| ---- | ------------- | --------- | ------- | -------------------------------------- |
| 1    | canvas        | #111111   | 0.178   | page                                   |
| 2    | sidebar       | #0B0B0B   | 0.150   | sidebar, side panel                    |
| 3    | surface       | #191919   | 0.213   | cards, user bubble, code               |
| 4    | raised        | #1F1F1F   | 0.239   | solid floating layers, composer body   |
| 5    | hover         | white 5%  | –       | hover wash                             |
| 6    | active        | white 9%  | –       | pressed/selected wash                  |
| 7    | border        | white 8%  | –       | hairlines                              |
| 8    | border-strong | white 14% | –       | control edges                          |
| 9    | faint         | #666666   | 0.510   | decorative icons (3.3:1 canvas)        |
| 10   | subtle        | #8A8A8A   | 0.63    | tertiary (5.5:1 canvas, 4.8:1 raised)  |
| 11   | muted         | #A6A6A6   | 0.725   | secondary (7.8:1 canvas, 6.8:1 raised) |
| 12   | text          | #ECECEC   | 0.943   | primary (16:1)                         |
| –    | disabled      | #4F4F4F   | 0.428   | disabled                               |

What changed and why: muted drops from ~9.5:1 to ~7.5:1 and subtle to ~5:1, which opens a visible gap between tiers while keeping AA with margin on every surface text sits on (canvas, sidebar, surface, raised, hover, active; the table in `/tmp/ace-shots/contrast.mjs` output covers each). The dark canvas lifts to #111 so the sidebar at #0B is clearly "behind" it and so borders and shadows have room. Hairlines and washes become alpha so one token works on every step and on glass; `palettes.ts` keeps the AA-stepping logic for text only.

Status hues stay as they are (`ace.ts`): light words 5.5–7.4:1 on white, dark words 6–11:1 on #111. The only change is that the working glyph in a **non-selected** row takes the muted ink, not blue (owner decision: Working is muted unless selected).

### 2.2 Surfaces and edges

| Layer                                         | Background                                                                                                                                  | Edge                                                                  | Shadow                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| App background                                | canvas                                                                                                                                      | –                                                                     | –                                                                                                         |
| Sidebar                                       | sidebar                                                                                                                                     | 1px border on its right edge                                          | –                                                                                                         |
| Content                                       | canvas                                                                                                                                      | –                                                                     | –                                                                                                         |
| Header                                        | canvas                                                                                                                                      | 1px border below, shown only once the transcript has scrolled         | –                                                                                                         |
| Raised (cards, bubbles, settings groups)      | surface                                                                                                                                     | 1px border (light: optional; dark: required)                          | none                                                                                                      |
| Floating solid (dialogs, Work card, tooltips) | raised                                                                                                                                      | 1px border-strong-ish edge via `0 0 0 1px black/8%` (dark: white/10%) | `0 1px 2px black/6%, 0 8px 24px -8px black/18%` (dark: `0 1px 2px black/50%, 0 12px 32px -8px black/55%`) |
| Floating glass (menus, popovers, palette)     | **glass-thin** (§6.3): blur 20, saturate 150, tint `252 252 252 / 72%` light, `40 40 40 / 76%` dark                                         | dark outer hairline + white inner rim (§6.3)                          | same as floating solid                                                                                    |
| Composer dock + strip                         | **glass-regular** (§6.3): blur 28, saturate 140, tint `255 255 255 / 62%` light, `36 36 36 / 64%` dark, over a canvas-coloured dim gradient | 1px outer edge at `black/10%` (light) / `black/60%` (dark), inner rim | `0 10px 28px -16px black/30%` (dark `/70%`)                                                               |
| Modal backdrop                                | unchanged                                                                                                                                   | –                                                                     | –                                                                                                         |

The composer gets a shadow because it is the one glass surface that sits over a plain page most of the time; without a shadow the tint is all it has. Keep the ADR's "never glass on glass" and the liquid rim. The `contrast()`/`brightness()` scrim and the darkened `--glass-*-foreground` inks go away; §6 replaces them with alpha "vibrancy" inks and a dim layer behind the dock.

### 2.3 Type

Font: keep the system stack on Apple (SF Pro Text has the right optical size for 13–15px). On Windows and Linux, bundle **Inter** (variable, OFL) ahead of Segoe UI, and **JetBrains Mono** (OFL) ahead of Consolas; both are already what t3code reaches for and they keep metrics close to SF Pro/SF Mono so layouts do not shift between platforms. Turn on `cv11`/`tnum` as today, plus `ss01` for Inter's open digits. Folio's serif stays New York/Charter; Tty's mono becomes the bundled JetBrains Mono on non-Apple.

| Token          | Size / line  | Weight | Tracking           | Use                                                                     |
| -------------- | ------------ | ------ | ------------------ | ----------------------------------------------------------------------- |
| `label`        | 11 / 14      | 500    | +0.04em, uppercase | section labels only (Settings group titles, "Unsent" dividers)          |
| `meta`         | 12 / 16      | 400    | 0                  | row line 1 and 3, timestamps, counts, shortcuts                         |
| `meta-mono`    | 11.5 / 16    | 400    | 0                  | branch names, inline paths in rows                                      |
| `ui`           | 13 / 18      | 400    | 0                  | menus, buttons, tool rows, settings values, composer footer             |
| `ui-strong`    | 13 / 18      | 500    | 0                  | selected menu item, primary button, status words                        |
| `title`        | 14 / 20      | 500    | −0.005em           | sidebar row title, header title, dialog titles, settings row labels     |
| `prose`        | 15 / 24      | 400    | 0                  | transcript answers and user bubbles (default); 14/22 small, 17/27 large |
| `prose-strong` | 15 / 24      | 600    | 0                  | bold in answers                                                         |
| `prose-h2`     | 17 / 24      | 600    | −0.01em            | headings inside answers (h1 maps here too)                              |
| `prose-h3`     | 15 / 24      | 600    | 0                  |                                                                         |
| `code-inline`  | 13 / inherit | 400    | 0                  | mono, 0.92em of prose, surface background, 4px radius                   |
| `code-block`   | 12.5 / 20    | 400    | 0                  | mono in code blocks and diffs                                           |
| `page-title`   | 20 / 26      | 600    | −0.015em           | Settings page titles, empty states                                      |

The two moves that matter: prose goes to 15/24 by default (the owner's "Default" transcript size is 14; see §5) and **titles get weight 500** everywhere. Line heights are integers on a 2px grid so rows land on the 4px grid.

### 2.4 Shape and space

Radius scale, concentric by rule (inner = outer − padding):

| Token  | Value | Use                                                                   |
| ------ | ----- | --------------------------------------------------------------------- |
| `r-xs` | 4     | tags, inline code, status pills                                       |
| `r-sm` | 6     | controls ≤ 28px tall, menu rows (inside 12px popups with 6px padding) |
| `r-md` | 8     | buttons 30px+, inputs, code blocks, the user bubble's tail corner     |
| `r-lg` | 12    | popovers, menus, cards, the Work card, settings groups                |
| `r-xl` | 16    | the composer, the strip card, dialogs                                 |
| `full` | 9999  | Send/Stop, avatars, accent discs, segmented thumb                     |

22px goes away: a 56–120px composer with a 22px radius is what makes it a slab; 16px with a shadow reads as a precise object. Sidebar rows have **no radius**.

Spacing scale (4px grid): 2, 4, 6, 8, 12, 16, 20, 24, 32, 48. Component insets are 8 (dense), 12 (default), 16 (roomy). No 10 or 14.

Density targets (comfortable / compact):

| Element                 | Height              | Notes                                                            |
| ----------------------- | ------------------- | ---------------------------------------------------------------- |
| Sidebar three-line row  | 68 / 60             | 16 + 20 + 16 lines, 8 / 4 padding; full width, 1px divider below |
| Settled (one-line) row  | 32 / 28             |                                                                  |
| Header                  | 44 / 40             |                                                                  |
| Menu item               | 30 / 28             | 13px text, 16px icon, 8px inset, 6px radius                      |
| Button default          | 28 / 28             | sm 24, lg 32; 12px side padding; 13px/500 label                  |
| Composer footer control | 30                  | round                                                            |
| Composer min height     | 2 lines + 44 footer | 14px side inset                                                  |
| Strip row               | 36                  |                                                                  |
| Settings row            | 48 / 40             | 14px label 500, value 13px muted                                 |
| Tool row in transcript  | 24                  | 13px muted, 16px icon                                            |

### 2.5 Icons

- Phosphor **regular** weight at 16px beside 13–14px text; 14px beside 12px meta; 12px for status glyphs and the Work-card dot's ring. Never scale an icon to a non-integer size.
- `bold` weight only at 12px, where regular strokes disappear.
- Icons inherit the row's text tier via `currentColor`. Provider and project marks are monochrome in rows (ink at the row's tier) and keep their brand colour only in avatars, the model picker's rail and the account menu.
- Status glyphs (needs-you, failed, working, done) are the only coloured icons in lists.
- Favicons and app icons stay full colour at 16px with a 4px radius.

### 2.6 Motion and focus

- Keep 120/200/320/140. Popover entry: 160ms, opacity 0→1 and scale 0.98→1 from the anchor; exit 120ms opacity only.
- Spring: reduce overshoot to about 1.012 (replace the 1.03 and 1.033 stops with 1.010/1.012) so segmented thumbs and menus settle without a visible bounce.
- Hover colour: 100ms; press: 60ms in, 120ms out.
- Focus: 2px solid `--focus` (ink at 70%, as now) with a 2px gap on controls; 2px inset on rows; on glass use the ink at 100%. Keep the auto-focused hairline on Cancel.

### 2.7 The other five themes

Each theme keeps the Mono ramp's **lightness curve** (the L column above) and the same alpha hairlines; what changes is hue, chroma, text ceiling and fonts. Anchor values below extend the existing sources (`apps/web/src/theme/sources/*.ts`) rather than replacing them; the point is that each theme is a different material with the same hierarchy.

| Theme      | Light canvas / text / accent | Dark canvas / text / accent | Direction                                                                                                                                                                                                                                    |
| ---------- | ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ace**    | #FFFFFF / #171717 / ink      | #111111 / #ECECEC / ink     | Zero chroma. Status dots the only colour. No rim light on glass beyond a 0.5px edge.                                                                                                                                                         |
| **Folio**  | #F9F6F0 / #231E17 / #7D3560  | #1C1915 / #EEE6D8 / #D99ABD | Warm paper, hue ≈ 75°, chroma 0.012–0.02 on surfaces. Prose in New York/Charter at 16/26. Hairlines are warm black 10% (not grey). Code blocks on #F1ECE3. The one theme where the user bubble may have a 1px warm border instead of a fill. |
| **Umbra**  | #E7E8EA / #1E2125 / #1F6A73  | #0C0D0F / #D6DAE0 / #5CB4BD | One plane: sidebar = canvas in both modes; separation only by hairlines (white 7% dark). Text ceiling held at L 0.90 in dark so nothing glares. Glass blur 24 (the darkest theme can afford it).                                             |
| **Signal** | #FFFFFF / #000000 / ink      | #000000 / #FFFFFF / ink     | 3:1 borders (#8A8A8A / #7C7C7C), solid layers, 2px focus rings at 100%, status words at AAA, weight 500 for all titles and 600 for primary buttons. No washes under 12% alpha.                                                               |
| **Tty**    | #F6F6F2 / #191A16 / #566A0C  | #0F1110 / #DCE2DD / #C2DC55 | Everything in mono at 12.5/18 UI and 13.5/22 prose; no weight changes, hierarchy by colour tier and uppercase labels. The caret and Send are chartreuse; done is teal. Square radii (2/4/6) and 1px edges.                                   |
| **Harbor** | #F3F5F8 / #161B22 / #13627E  | #171B21 / #E7ECF2 / #6EC3DE | Cool slate, hue ≈ 250°, chroma 0.01–0.02. Mid contrast: text at L 0.22 light / 0.93 dark. The most saturated glass (saturate 185–200).                                                                                                       |

## 3. Component treatments

### Sidebar row (`features/home/thread-row.tsx`, `row-parts.tsx`, `thread-list.tsx`)

Before: 80px, `rounded-md`, hover/selection as a rounded wash, no dividers, coloured badges and marks, 14/400 title, status replaced by action icons on hover.

After (see mockup): 68px, full width, `border-b` hairline between rows, no radius. Line 1: 16px monochrome project mark (square, `r-xs`, surface fill, 11px/600 initials in muted) + project name at `meta` muted; right: the status word at `ui-strong` in its status colour (needs-you always; failed until seen) or the relative time at `meta` subtle. Line 2: title at `title` (14/500), text ink; muted ink when the row's attention is muted. Line 3: branch at `meta-mono` subtle, `·`, machine only if more than one device; right: provider glyph 14px in faint ink. Selected: `active` wash edge to edge plus a 2px ink bar on the left edge (2px, not a radius); hover: `hover` wash. Row actions (snooze, menu) appear on hover **to the left of** the status word, never in its place; the status word stays. Working rows not selected: glyph and word in muted ink, no clock. Settled rows: 32px, title at `ui` muted, time at `meta` subtle, same dividers.

Why: this is the owner's decision as written, and it is the layout t3code uses. The hairline-and-weight structure lets 10 rows fit the same height that holds 9 now, with more hierarchy, not less.

### Transcript (`features/thread/transcript/*`, `items/*`)

- User message: `surface` bubble, `r-lg` with the top-right corner at `r-md`, 12px 14px padding, `prose` size. Timestamp under it at `meta` subtle, shown on hover and on the last message only.
- Assistant answer: plain `prose` on canvas, max width `--column`. Paragraph gap 12px (one `prose` line-height ÷ 2), not a block margin per message. Consecutive agent messages in one turn collapse into one flow.
- Tool rows: 24px, `ui` muted, 16px icon faint, the argument in `code-inline` on `surface`. Consecutive rows group under one summary row as the spec says; the group gets a 1px left rule in `border`, 12px inset, nothing else.
- "Working for …": one 24px line at the end of the turn, glyph in working blue, text muted; the only animated thing on the page.
- "Worked for X ›": 28px row, `ui` muted, caret 14px, with a **hairline above and below** that spans the column. Expanding it reveals the grouped tool rows at the same density, no extra top margin. The time stamp moves into this row's right side at `meta`.
- Turn boundary: the "Worked for" hairline **is** the boundary. No other dividers.
- Minimap ticks: hide below 1600px wide; above that, draw them at 6px length in `border` and only at turn boundaries.

### Composer and strip (`features/thread/composer/*`, `styles/composer-strip.css`, `glass.css`)

- Composer: `r-xl` (16), raised at 88%/84% with blur 16, 1px border-strong, the shadow from §2.2. Input at `prose` size (15/24, 14px side inset, 12px top). Footer 44px: `+` and the permission control as 30px round ghosts in muted ink; model control on the right; Send/Stop 30px round, ink fill, white glyph (unchanged).
- Strip: `r-xl` top corners only, 12px 16px padding, `ui` text; title row ("Run `rm -rf …`?") at `title` 500, the risk line at `meta` in the failed colour, buttons 28px. It tucks 16px under the composer and inherits the composer's material; the seam gets a 1px border-strong line so the two read as one dock with a fold, not two slabs.
- Primary button: ink fill, white label 13/500, 1px border of the same ink, inner top highlight `inset 0 1px white/18%`, `0 1px 1px black/10%` shadow, both removed on press. Secondary: raised fill, 1px border-strong, inner highlight, `0 1px 1px black/5%`; press shows `active` fill. Ghost: unchanged. Danger: as decided (solid failed hue), with the same highlight treatment.

### Model control (`thread-controls.tsx`, `model-control.css`)

One 30px chip: provider mark 14px monochrome, model name `ui` text ink, `·`, effort label `ui` muted, speed bolt(s) 12px before the caret. Caret 12px faint. Hover: `hover` wash; open: `active` wash. The popover (as now, T3-style list) at `r-lg`, 6px padding, rows 30px `r-sm`, provider rail on the left with monochrome marks that take colour only when selected, search field 28px with `border-strong`. The "Your CLI login / Personal / Team" segmented row becomes a `label`-sized row with a 24px segmented control so it stops competing with the model list.

### Header (`features/shell/app-header.tsx`, `features/thread/header/*`)

Title 14/500 ink; project crumb `ui` muted with a monochrome mark; `/` in faint. Right cluster: three 30px icon ghosts at 4px gap. A 1px `border` under the header appears when the transcript's scrollTop > 0 (opacity transition 120ms). Work card: `r-lg`, raised solid, 12px padding, 32px rows at `ui` with 16px icons faint, group labels at `label`.

### Popovers, menus, context menus (`components/ui/menu.tsx`, `menu-styles.ts`, `popover.tsx`)

`r-lg` (12), 6px padding, rows 30px `r-sm`, 13px label ink, icon 16px muted, shortcut `meta` subtle right-aligned with 12px gap. Separators `border` with 6px margins. Destructive rows failed-text. Glass at 84%/80% with the liquid rim; the shadow from §2.2. Hover card for a sidebar row: solid raised, `r-lg`, 12px padding.

### Inputs (`components/ui/input.tsx`, `field.tsx`)

28px (sm 24, lg 32), `r-md`, raised fill with 1px border-strong, inner `inset 0 1px black/3%` in light and `inset 0 1px white/3%` in dark; focus ring per §2.6; placeholder at subtle. Search fields in sidebars: 28px, `surface` fill, no border, 16px icon faint.

### Settings pages (`features/settings/*`, visual-language "Settings")

Mode keeps its three preview cards (owner's call), redrawn at 160×96 with the §2 ramp. Theme stays a grid of **swatch cards**: a split orb (light half, dark half, accent dot) and the name at `ui`, selected ring 2px ink; see §7 for the full page. Accent: 24px flat discs with a 2px gap ring on the selected one; "custom" is a disc with a conic border. Rows: 48px, label `title` 500, value/description `ui` muted, dividers `border`, groups at `r-lg` on `surface` with a 1px border in dark only. Left nav: 32px rows, `ui`, selected row `active` wash full width with a 2px ink bar (same as the task list).

## 4. Prioritised plan

Small PRs, tokens first, each independently shippable and visible.

1. **Ramp and alpha hairlines** (`sources/ace.ts`, `palettes.ts`, `tokens.ts`, glass tint). Muted/subtle/faint per §2.1, borders and washes as alpha, dark canvas to #111, glass body to 84/80%. Expected win: the largest single change in perceived quality; hierarchy appears everywhere at once, menus stop looking muddy. Risk: the AA test in `palettes.ts` needs the alpha tokens resolved against each surface before checking.
2. **Weight and type tokens** (`index.css` `@theme`, a `title` utility, `prose` to 15/24). Apply 500 to row titles, header title, dialog titles, settings labels. Win: rows and headers read as rows and headers.
3. **Sidebar rows to the decided layout** (`thread-row.tsx`, `row-parts.tsx`, `settled-row.tsx`, `thread-list.tsx`): no radius, dividers, 68px, monochrome marks, hover actions beside the status. Win: the sidebar matches t3code's structure and the owner's spec; fixes the §1.3 contradiction.
4. **Radius scale and composer geometry** (`tokens.css`, `composer-styles.ts`, `composer-strip.css`, `button.tsx` sizes): 4/6/8/12/16, composer to 16 with the §2.2 shadow and seam, buttons to 28 with `r-md`. Win: the composer stops being a slab; controls look like one family.
5. **Button and input surfaces** (`button.tsx`, `input.tsx`, `icon-button.tsx`): border + inner highlight + micro shadow, press states. Win: the "craft" feel; small diff.
6. **Transcript rhythm** (`feed.tsx`, `items/messages.tsx`, `step-groups-view.tsx`, `turn-end.tsx`): paragraph gaps, tool rows at 24px muted, "Worked for" hairline row, minimap threshold. Win: long threads become readable and shorter.
7. **Glass material** (`glass.css`, `glass-floor.ts`, `translucency.ts`, `tokens.ts`, `liquid-glass.ts`): the §6 recipe. Two levels (thin for menus, regular for the dock), dim layer behind the dock, alpha inks instead of darkened text, dark outer edge in light mode, scrim pass removed, solver re-run against the blurred fixtures. Win: the thing the owner called "weird" goes away; glass reads as glass at the slider's 100% end.
8. **Settings → Appearance** (`features/settings/appearance*`): segmented mode, swatch cards, flat accent discs. Win: the page the owner uses to judge themes looks finished.
9. **Icon rules** (`provider-icons.tsx`, `project-mark.tsx`, `status-glyph.tsx`): monochrome in rows, sizes by text tier. Win: colour means state. Can ride along with 3.
10. **Motion tune** (`motion.css` spring stops, popover entry 160ms). Win: subtle; last.
11. **Other themes** on the shared curve (`sources/*.ts`): adjust each theme's muted/subtle to the new tier targets, add Folio's warm hairline and Tty's square radii. Win: six distinct, consistent materials.
12. **Appearance: Interface and Motion** (§7.5–7.6): Contrast, Diff colours, Chat width, Panel animation speed with preview. Win: the controls people reach for first, on the new tokens.
13. **Appearance: Typography** (§7.7): bundled Inter and JetBrains Mono, family and size selects, Word wrap, live previews. Win: consistent type on Windows and Linux; the page starts to feel like t3code's.
14. **Appearance: Custom themes** (§7.8): duplicate, edit with AA constraints, import/export JSON, daemon-synced storage. Win: closes the last customisation gap.
15. **Settings consistency** (§8 rows 1–4, 11, 14, 16). Win: every settings-like page reads as one system.
16. **Empty, error, toast** (§8 rows 5–7). Win: no bare-text pages; toasts stop covering the header.
17. **Tabs and data pages** (§8 rows 8–10, 15). Win: one tab vocabulary; Usage joins the system.
18. **Narrow widths** (§8 rows 12–13). Win: phone and tablet stop looking like a desktop layout squeezed.

All UI PRs from here follow [`DESIGN.md`](../../DESIGN.md).

Each PR should include before/after screenshots from the same Playwright script used here (`/tmp/ace-shots/shoot.mjs` is throwaway; a copy under `tools/web-e2e/device-shots.ts` already exists for this purpose).

## 5. Questions for the owner (conflicts, raised not changed)

1. **Transcript default size.** The decision table has "Default" at 14px. The proposal recommends 15/24 as the default (t3code reads at 15–16 on desktop) with 14 and 17 as the other two stops. Keep 14, or move to 15?
2. **Working rows in muted ink.** "Working and Background are muted unless the row is selected" is applied literally here, including the glyph: the small spinner in a non-selected row would be grey, not blue. The current build shows it blue. Is the blue glyph with a muted word acceptable, or should the glyph be muted too?
3. **Coloured project badges.** The fake data gives each project a colour. Under "status dots the only colour" the proposal makes project marks monochrome in rows and keeps colour for the project filter menu. Confirm?
4. **Composer radius.** The decision says the composer is translucent glass; it does not fix a radius. 22 → 16 is proposed. Any attachment to 22?
5. **Sidebar selection bar.** A 2px ink bar at the left edge is proposed as the selection cue alongside the wash, because a wash alone on a full-width row is faint in light mode. This adds a non-status use of the ink; it is not a colour, but it is a mark. Acceptable?
6. ~~Mode previews.~~ Answered: the owner keeps the three preview cards. §3 "Settings pages" and §7.3 now keep them; the segmented control is withdrawn.
7. **Minimap ticks.** Hiding them under 1600px changes an approved feature's visibility. Alternative: keep them but draw at 4px in `border`.

## 6. Glass

### 6.1 What ace does today, measured

From `apps/web/src/styles/glass.css`, `theme/tokens.ts`, `theme/glass-floor.ts`, `theme/translucency.ts`, `theme/glass.ts` and the computed variables on `<html>` at the slider's 100% end:

| Stage            | Light                                                                                                              | Dark                                                             | Where                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------- |
| Blur             | 24px                                                                                                               | 28px                                                             | `sources/ace.ts` `glassy()`               |
| Saturation       | 180%                                                                                                               | 165%                                                             | same                                      |
| Luminosity scrim | `contrast(72%) brightness(114%)`                                                                                   | `contrast(70%) brightness(72%)`                                  | `glass-floor.ts` `scrim`                  |
| Tint             | `#FFFFFF` at 52%                                                                                                   | `#1A1A1A` at 64%                                                 | `glassTintAlpha` floor, `translucency.ts` |
| Rim              | inset `0 1px` white 95%, `0 0 0 1px` white 40%, `0 −1px` white 30%                                                 | inset `0 1px` white 16%, `0 0 0 1px` white 6%, `0 −1px` white 4% | `tokens.ts` `glassRim`                    |
| Edge             | `0 0 0 0.5px` ink at 12%                                                                                           | `0 0 0 0.5px` black at 55%                                       | `--glass-edge`                            |
| Shadow           | three-stop float shadow (5 / 10 / 20%)                                                                             | three-stop (40 / 45 / 60%)                                       | `--float-shadow`                          |
| Lensing          | `feDisplacementMap`, rim ≤ 10px, bend ≤ 7px, Chromium only                                                         | same                                                             | `liquid-glass.ts`                         |
| Text on glass    | `#0A0A0A` / `#2D2D2D` / `#464646` (each tier moved 30–40% toward black)                                            | `#F6F6F6` / `#CDCDCD` / `#B4B4B4`                                | `glassText`                               |
| Double blur      | avoided: the strip is clipped where it tucks under the composer; the palette sits over an already blurred backdrop |                                                                  | `glass.css`                               |
| Noise            | none                                                                                                               | none                                                             |                                           |
| Dock fade        | 16px gradient under the composer                                                                                   |                                                                  | `[data-composer-dock]::before`            |

Why it does not read as Apple material:

1. **The scrim flattens the backdrop into one grey.** `contrast(72%)` pulls every blurred pixel toward mid-grey and `brightness()` then shifts the whole thing up (light) or down (dark). What is left behind the tint is a nearly uniform field, so the layer looks like a painted panel. Apple's materials keep the backdrop's luminance structure (you can see a window's bright and dark regions move behind a menu); they narrow the range with blur and a thin tint, never with a contrast pass.
2. **The blur radius is smaller than the text pitch behind it.** 24px Gaussian over 14px text on 28px lines leaves horizontal bands; with a 52% tint those bands are legible ([21-glass-menu-over-sidebar-light](2026-10-14-screens/21-glass-menu-over-sidebar-light.jpg): "Approve" and "ble-count tax" read through). Apple's effective blur is large relative to any text size, so text behind glass becomes tone, never words.
3. **Saturation 165–180% does nothing on a zero-chroma theme and too much over colour.** Over grey content it is invisible; over a photo or syntax colours it makes blobs. Apple boosts saturation moderately so that colour behind the glass _survives_ the tint, which is what makes a material feel lit from behind.
4. **The light rim is white on white.** Three inset white lines over a white page are invisible; the only edge is a 0.5px ink line at 12%, so a light menu has no silhouette ([06-header-menu-light](2026-10-14-screens/06-header-menu-light.jpg)). Apple's light materials carry a **dark** outer hairline (around 8–15% black) and a bright inner highlight; both are needed.
5. **The dark tint is the canvas colour.** `#1A1A1A` at 64% over `#0D0D0D` lands at about `#15`, within 8 lightness points of the page. Apple's dark materials are _lighter_ than the content behind them (the material lifts), so a dark menu reads as a pane in front of the window rather than a hole in it. In the crop the only separation is the heavy shadow, which is why it looks solid.
6. **Text is darkened, not vibrant.** To keep AA with a thin tint, the inks on glass are pushed toward black (light) or white (dark). The result is text on menus that is heavier than text on the page, which is the reverse of what the eye expects from a translucent layer and part of why it "feels weird". Apple does the opposite: labels on materials are _vibrant_, that is, partly made of the backdrop's own luminance, so they look lighter and more integrated, and legibility comes from the blur, the tint and a scrim behind the whole layer.
7. **The dock fade is too short.** The 16px fade under the composer leaves sharp transcript lines at the composer's bottom edge ([20-glass-composer-over-text-light](2026-10-14-screens/20-glass-composer-over-text-light.jpg)); the eye reads a sharp line next to a blurred field as a rendering fault.
8. **Readability floor solved against the wrong thing.** `glass-floor.ts` solves the tint alpha for 4.5:1 with _opaque_ inks over the blurred fixtures. That forces a thicker tint than Apple would use, and still leaves bleed-through, because opacity is the only lever it has. Give the solver two more levers (a dim layer behind the surface and alpha inks) and the tint can be thinner while the result is more legible.

The lensing rim, the layer registration and filter caching, the "never glass on glass" rule and the clipped strip are all correct and should stay.

### 6.2 What Apple materials do (principles, not code)

From the HIG "Materials" page, the Liquid Glass introduction and WWDC sessions, stated in our own words:

- **A material is a stack:** a large blur of the content behind, a moderate saturation boost so colour survives, a tint whose opacity sets the _thickness_, and foreground content drawn with _vibrancy_. The blur and tint set the mood; the vibrancy keeps it legible.
- **Thickness levels.** macOS offers ultraThin, thin, regular, thick (and chrome/bar variants). Thinner materials show more of the backdrop and are used for small, transient layers (menus, popovers); thicker ones for persistent chrome (sidebars, window backgrounds). The tint colour is roughly the system background at a given opacity: off-white in light, dark grey (not black) in dark.
- **Vibrancy.** Labels, icons and separators on a material are not fixed colours. They are blended with the backdrop's luminance (lighter-than or darker-than blends), so a label over a bright region is slightly brighter and over a dark region slightly darker. There are four label vibrancies (label, secondary, tertiary, quaternary), matching the text tiers. This is why text on Apple glass looks "of the glass" rather than printed on it.
- **Adaptive tint.** Light materials are white-ish and pull the backdrop up; dark materials are grey and pull it up too (they lift above a near-black window). Liquid Glass goes further and flips its own light/dark appearance by what is behind it.
- **Specular rim and lensing.** Liquid Glass bends the backdrop at the edge (refraction) and shows a highlight that follows the light direction (top-left by default), with a darker return on the opposite edge. The body stays undistorted.
- **Readability without opacity.** For glass over busy content Apple adds a **dimming or scrim layer behind the glass** (the "clear" glass variant requires one), keeps blur large, and relies on vibrancy and shadows. It does not thicken the glass to 90%.
- **Shadows and layering.** Materials cast a soft shadow onto content, never onto another material. Materials are for navigation and controls floating above content, not for content itself, and never stacked.
- **No grain.** macOS and visionOS materials are smooth; depth comes from blur, light and shadow, not texture.

### 6.3 Recipe for ace

Two levels plus a solid fallback. All values are for the default Mono theme; other themes change the tint's hue and the shadow tint only.

**Shared base (all glass):**

```
backdrop-filter: blur(<radius>) saturate(<boost>);           /* no contrast(), no brightness() */
background: <tint>;                                           /* a plain rgba, per level and mode */
box-shadow: <inner rim>, <outer edge>, <float shadow>;
```

On Chromium the liquid rim filter is appended as today (`… var(--liquid-filter,)`), unchanged.

**Level 1, `glass-thin`** (menus, popovers, context menus, hover cards, selects, toasts, command palette panel):

|            | Light                                                                                           | Dark                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Blur       | 20px                                                                                            | 20px                                                                               |
| Saturate   | 150%                                                                                            | 140%                                                                               |
| Tint       | `rgb(252 252 252 / 0.72)`                                                                       | `rgb(40 40 40 / 0.76)`                                                             |
| Inner rim  | `inset 0 1px 0 rgb(255 255 255 / 0.90)`, `inset 0 0 0 1px rgb(255 255 255 / 0.35)`              | `inset 0 1px 0 rgb(255 255 255 / 0.12)`, `inset 0 0 0 1px rgb(255 255 255 / 0.05)` |
| Outer edge | `0 0 0 1px rgb(0 0 0 / 0.10)`                                                                   | `0 0 0 1px rgb(0 0 0 / 0.60)`                                                      |
| Shadow     | `0 1px 2px rgb(0 0 0 / 0.06)`, `0 8px 24px -8px rgb(0 0 0 / 0.18)`                              | `0 1px 2px rgb(0 0 0 / 0.50)`, `0 12px 32px -8px rgb(0 0 0 / 0.55)`                |
| Specular   | optional `::after` gradient `linear-gradient(180deg, rgb(255 255 255 / 0.10), transparent 40%)` | same at 0.06                                                                       |

**Level 2, `glass-regular`** (the composer and its attached strip, as one surface):

|                                                     | Light                                                                                                                                        | Dark                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Blur                                                | 28px                                                                                                                                         | 28px                                  |
| Saturate                                            | 140%                                                                                                                                         | 130%                                  |
| Tint                                                | `rgb(255 255 255 / 0.62)`                                                                                                                    | `rgb(36 36 36 / 0.64)`                |
| Dim layer (behind the whole dock, not on the glass) | `linear-gradient(to top, var(--canvas) 0 16px, color-mix(in srgb, var(--canvas) 35%, transparent))` covering the dock's area plus 24px above | same with the dark canvas at 50%      |
| Inner rim                                           | as thin, light                                                                                                                               | as thin, dark                         |
| Outer edge                                          | `0 0 0 1px rgb(0 0 0 / 0.10)`                                                                                                                | `0 0 0 1px rgb(0 0 0 / 0.60)`         |
| Shadow                                              | `0 10px 28px -16px rgb(0 0 0 / 0.30)`                                                                                                        | `0 10px 28px -16px rgb(0 0 0 / 0.70)` |

Strip and composer: one element tree, one `backdrop-filter` region. Keep the existing clip (`.ace-glass-attached`) so the strip's glass stops where it tucks under the composer; the seam is a 1px `border-strong` line. The dim layer replaces today's 16px dock fade and is what makes the thin tint readable: it is a plain gradient, not a filter, so it costs nothing.

**Sidebar:** none. The sidebar, reading column and side panels stay opaque (ADR 0075). A translucent sidebar is the thickest, largest and most-scrolled-behind surface and the one most likely to jank; it is also not needed for the feel.

**Text on glass ("vibrancy" in CSS):** replace the darkened `--glass-*-foreground` inks with alpha inks, so the local backdrop luminance shows through each glyph as it does under Apple's vibrancy:

| Tier      | Light               | Dark                      |
| --------- | ------------------- | ------------------------- |
| label     | `rgb(0 0 0 / 0.88)` | `rgb(255 255 255 / 0.92)` |
| secondary | `rgb(0 0 0 / 0.62)` | `rgb(255 255 255 / 0.66)` |
| tertiary  | `rgb(0 0 0 / 0.45)` | `rgb(255 255 255 / 0.48)` |
| separator | `rgb(0 0 0 / 0.08)` | `rgb(255 255 255 / 0.08)` |

Where supported, add `mix-blend-mode: plus-lighter` to dark-glass text and icons inside `@supports (mix-blend-mode: plus-lighter)` (Chromium, Safari); it gives the slight lift Apple's vibrant labels have. Light glass keeps plain alpha (no `plus-darker` in Chromium). Status words keep their opaque colours.

**Readability check (replaces the current floor solve).** Keep `backdrops.ts`'s four fixtures and the Gaussian pass; drop the `contrast()`/`brightness()` stage; add the dim layer (dock only) and the alpha inks; then require label ≥ 4.5:1, secondary ≥ 4.5:1, tertiary ≥ 3:1 over the darkest and lightest results. Worked by hand for the values above (composite = backdrop → dim → tint → ink):

| Case                            | Backdrop after blur | Under tint                    | Label               | Secondary          |
| ------------------------------- | ------------------- | ----------------------------- | ------------------- | ------------------ |
| light dock over dark code (#3A) | #3A                 | dim 35% → #7F; tint 62% → #D0 | #19 on #D0 → 10.9:1 | #4F on #D0 → 5.4:1 |
| light dock over white page      | #FF                 | #FF                           | #1F on #FF → 16:1   | #61 on #FF → 6.3:1 |
| light menu over black (#00)     | #00                 | tint 72% → #B5                | #16 on #B5 → 9.0:1  | #45 on #B5 → 5.0:1 |
| dark dock over white page       | #FF                 | dim 50% → #88; tint 64% → #43 | #F0 on #43 → 8.1:1  | #C6 on #43 → 4.9:1 |
| dark dock over black            | #00                 | dim → #09; tint → #1A         | #EB on #1A → 13:1   | #A9 on #1A → 7.6:1 |
| dark menu over white page       | #FF                 | tint 76% → #5A                | #F2 on #5A → 5.6:1  | #CF on #5A → 4.6:1 |

Every case clears AA with the tint at 62–76%, which is visibly translucent (the slider's 100% end shows blurred colour and luminance moving behind the layer). The slider still eases toward Solid along the same square root; only the far end changes.

**Fallback.** `:root[data-surface="solid"]` (slider at 0, `prefers-reduced-transparency`, a theme with no glass) and `@supports not (backdrop-filter: blur(1px))` get the raised solid surface with the same outer edge and shadow and opaque inks, exactly as the `.ace-floating-solid` path today. Firefox and Safari get the recipe minus the lensing rim, as now.

**Performance.** Cost is one backdrop pass per glass layer, proportional to the layer's area times the blur kernel; nothing per frame except when content scrolls under the composer. At 2× on a 700×120 CSS-px dock a 28px blur is a few hundred microseconds of GPU time on Apple silicon and still comfortably under a frame on integrated Intel; menus are smaller. The dim layer and the alpha inks are free. Keep the existing rules: no backdrop filter on scrolling areas, filters never animated, at most one glass layer per stacking context, liquid maps cached by geometry. Removing `contrast()` and `brightness()` removes two full-surface passes.

### 6.4 Checklist for the PR

- `glass.css`: drop `contrast()`/`brightness()`; two classes `.ace-glass-thin` and `.ace-glass-regular` (keep `.ace-floating` and `.ace-glass-dock` as aliases); dim layer on `[data-composer-dock]::before`.
- `tokens.ts`: new rim/edge values per mode; alpha inks for glass tiers; dark tint colour `36/40` grey, not `s2`.
- `glass-floor.ts` / `translucency.ts`: solver takes the dim layer and alpha inks; the 100% end is the new floor.
- `sources/*.ts`: per-theme blur stays, saturation drops to 130–150.
- Mockup section "Glass: current vs proposed" in the HTML file shows both recipes over the same busy backdrop in light and dark.

## 7. Appearance customisation

The owner: "we are missing many appearance customisation too like t3." This section specifies ace's Settings → Appearance page. t3code's page was used as a reference for _what_ to offer; every control below is specified against ace's own tokens (§2) and glass solver (§6). Everything stays within the settled decisions: Mode and Theme are separate, the six built-in themes and the accent picker stay, nothing renders below the composer.

### 7.1 Page structure and order

Rows use the existing `SettingSection` / `SettingRow` system (48px rows, grouped cards). Sections, in order, with why each earns its place:

| #   | Section           | Why it is here, in this position                                                                                                                                                                                                      |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Colour scheme** | The first thing anyone changes. Three preview cards (System / Light / Dark), as today; the owner wants the cards kept.                                                                                                                |
| 2   | **Theme**         | The second decision. A grid of theme cards, each showing a light and a dark orb, plus the user's custom themes, "Duplicate" per card, "New theme" and "Import…".                                                                      |
| 3   | **Accent**        | Belongs with the theme because it is fitted to it; stays a row of discs (flat, per §3).                                                                                                                                               |
| 4   | **Interface**     | Global rendering knobs that change how every surface reads: Contrast, Translucency, Diff colours, Chat width, Density.                                                                                                                |
| 5   | **Motion**        | Panel animation speed with a live preview; Reduce motion as the off switch. Separate from Interface because it is about time, not colour.                                                                                             |
| 6   | **Typography**    | Interface font, Transcript size, Monospace font, Word wrap, each with a live preview. Last because it is the deepest and the previews are tall. An "Advanced" disclosure hides ligatures, letter-spacing and the custom-family field. |

Not included:

- **Composer context toggle.** It would place a context row under the composer, which conflicts with "nothing renders below the composer". Context stays in the strip slot above.
- **Environment identification (Dev / Nightly artwork).** ace has one release channel and the fake daemon is a developer tool, not a user-facing environment. The one legitimate case, a developer running `dev:fake` or a local build next to the installed app, is covered by a small "dev" tag beside the wordmark set from the build, not an appearance setting. If a nightly channel ever ships, revisit.

### 7.2 Persistence and sync

- **Per device, in `ace.appearance`** (`theme/appearance.ts`, localStorage, replayed before first paint): everything that is a rendering preference of _this screen_: mode, theme id, accent, translucency, contrast, diff colours, chat width, density, motion speed, reduce motion, interface font + size, mono font + size, word wrap. These differ legitimately between a laptop and a desktop monitor.
- **In the daemon's settings store, synced to every client: custom theme files** (`appearance.themes: ThemeFile[]`). A theme is a thing the user made and expects to find on every device; a client caches the list in localStorage so first paint never waits on the socket. Deleting a theme that a device has selected falls that device back to ace.
- **Export** writes the JSON file (§7.9); **Import** reads one and adds it to the daemon store after validation.

### 7.3 Colour scheme

Unchanged: System / Light / Dark preview cards. `mode` → `data-scheme`. The cards render with the _current_ theme's two palettes so they double as a theme preview.

### 7.4 Theme

- Grid of cards, 4 per row at the settings column width. A card is: name, a split orb (left half light canvas+accent, right half dark), and on hover a "Duplicate" icon button and a "⋯" menu (Duplicate, Export, and for custom themes Edit, Rename, Delete).
- Footer actions on the card group: "New theme" (opens the editor seeded from the current theme) and "Import…" (file picker, accepts `.json`).
- Selecting a custom theme sets `theme` to its id (`custom:<uuid>`); `themes` in `palettes.ts` becomes built-ins + the synced list.

### 7.5 Interface

**Contrast.** Slider, 0–100 in steps of 5, default **50** ("Standard"), ticks at 25 ("Soft"), 50, 75 ("Strong"), 100 ("Maximum"). It drives, per scheme, through a `--contrast` factor resolved in `tokens.ts` (not in CSS, so the AA check runs on the result):

| Token                     | At 0                                                           | At 50 (theme value) | At 100                                       |
| ------------------------- | -------------------------------------------------------------- | ------------------- | -------------------------------------------- |
| `--muted-foreground`      | theme muted mixed 35% toward subtle                            | theme muted         | mixed 60% toward text                        |
| `--subtle-foreground`     | mixed 35% toward faint, **clamped to ≥ 4.5:1 on surface**      | theme subtle        | mixed 60% toward muted                       |
| `--faint-foreground`      | mixed 30% toward border-strong, **clamped to ≥ 3:1 on canvas** | theme faint         | mixed 50% toward subtle                      |
| `--border` (alpha)        | 5%                                                             | 8%                  | 16%                                          |
| `--border-strong` (alpha) | 10%                                                            | 16% (14% dark)      | 30% (≥ 3:1 against canvas)                   |
| `--hover` / `--active`    | 3% / 6%                                                        | 5% / 9%             | 8% / 14%                                     |
| glass inks (§6.3)         | label .84 / secondary .56                                      | .88 / .62           | .95 / .78                                    |
| status words              | unchanged                                                      | unchanged           | unchanged (already ≥ AA; Signal already AAA) |

Rules: Contrast composes with the theme by treating each theme's own values as the 50 point, so Folio at 75 is "Folio, stronger", never "ace". Below 50 the clamps hold the AA floor; the slider's label shows "AA kept" at the point where clamping starts. Signal pins the slider at 100 and disables it ("Signal is already maximum contrast"). The glass solver (§6.3) runs on the resolved inks, so a lower contrast never pushes glass text under AA: if the solver cannot satisfy the floor with the softened inks it thickens the tint one step and the Translucency row says so.

**Translucency.** As today (0–100, default 100), now over the §6 recipe. Label the ends "Solid" and "Glass".

**Diff colours.** Select, default **Red & green**. Each option is a pair of hues; the generator derives four tokens per scheme from the theme: `--diff-add` / `--diff-del` = canvas mixed 12% (light) / 18% (dark) toward the hue, `--diff-add-text` / `--diff-del-text` = the hue stepped to ≥ 4.5:1 on that row. Gutter glyphs (+ / −) always accompany colour.

| Option        | Add hue (light / dark)     | Delete hue (light / dark)             | For                              |
| ------------- | -------------------------- | ------------------------------------- | -------------------------------- |
| Red & green   | #007856 / #57BD9B          | #A3233A / #E4697D                     | default, matches status colours  |
| Blue & orange | #1F5FBF / #8AB4FF          | #B3540A / #F2A25C                     | deuteranopia and protanopia safe |
| Purple & teal | #6A3FB5 / #C79BFF          | #0E7C86 / #6EC3DE                     | tritanopia safe                  |
| Monochrome    | ink at 10% wash, `+` glyph | ink at 6% wash with strike, `−` glyph | no colour reliance               |

**Chat width.** Select, default **Comfortable**: Narrow 640px, Comfortable 760px (today's `--column`), Wide 920px, Full (no max). Drives `--column`; the composer dock and the "Worked for" rules follow it.

**Density.** As today (Comfortable / Compact), moved here from "Display".

### 7.6 Motion

**Panel animation speed.** Slider shown in milliseconds of the base duration: 100–320ms in 20ms steps, default **200ms**. It sets `--motion-scale` = value ÷ 200 on `<html>`; `--motion-fast/base/slow/exit` multiply by it, and `motionMs` in `@ace/ui-core` reads the same value. Live preview: a 200×80 card to the right of the slider that plays one open/close cycle (slide + fade with `--ease-spring`) **each time the thumb moves**, never on a loop, so it stays within the no-perpetual-animation policy. **Reduce motion** (System / On / Off) stays below it as the off switch: when it resolves to on, the speed slider is shown disabled with "Movement is off".

### 7.7 Typography

**Interface font.** Two controls on one row, then a preview card.

- Family select, default **System**. The list is curated per platform from what `document.fonts.check()` confirms is installed, plus the bundled family:
  - Bundled (always available, OFL): **Inter** (variable).
  - macOS: SF Pro (system), Helvetica Neue, Avenir Next, New York (serif, for Folio lovers).
  - Windows: Segoe UI Variable (system), Bahnschrift, Calibri.
  - Linux: Cantarell, Noto Sans, Ubuntu, DejaVu Sans (whichever are present).
  - Advanced: "Custom…" text field; accepted only if the probe finds it, else it shows "Not installed on this device".
  - Web-safe fallback chain is always appended: `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- Size select: 12, **13** (default), 14, 15, 16 px. Sets `--ui-scale` = size ÷ 13; `meta`, `ui`, `title` and `label` scale with it and line heights round to 2px. Prose has its own control.
- Preview: one composer line as it will render ("Fix the flaky checkout test in `checkout.spec.ts` and run the suite") with two inline chips (a file chip, a `@agent` chip) and the footer's model control, at the chosen family and size.

**Transcript size.** As today (Small 14 / Default 15 / Large 17 after §2.3; the owner's answer to question 1 decides the default). Sets `--transcript-size`.

**Monospace font.** Same layout.

- Family select, default **System mono** (SF Mono / Cascadia Mono / DejaVu Sans Mono). List: bundled **JetBrains Mono** (OFL); macOS Menlo, SF Mono; Windows Cascadia Code, Consolas; Linux DejaVu Sans Mono, Noto Sans Mono, Fira Code if installed; Advanced "Custom…". Fallback chain `ui-monospace, Menlo, Consolas, "Liberation Mono", monospace`.
- Size select: 11, 12, **12.5** (default, §2.3), 13, 14 px. Sets `--code-size`; inline code stays at 0.92em of its prose.
- Advanced: Ligatures toggle (default off; sets `font-variant-ligatures`).
- Preview: a five-line diff (two removed, three added, with gutter numbers and the chosen Diff colours) and a six-line terminal block (a prompt line, a build line, a test summary with the status colours, a second prompt), both at the chosen family and size.

**Word wrap.** Toggle, default **On**: long lines in code blocks, diffs, tables and file previews wrap (`--code-wrap: pre-wrap`); Off gives horizontal scroll with a sticky gutter. A code block's header keeps a per-block override. The preview above re-renders with a long line to show the effect.

### 7.8 Custom themes

**Create.** "Duplicate" on any card, or "New theme" (duplicates the current one). The editor opens as a sheet (solid surface, per the modal rules) with the live app visible behind it; every change applies at once through the normal theme provider, so the user judges it in place.

**What is editable (anchors), per scheme (Light tab / Dark tab):**

| Anchor             | Drives                                                                                       | Constraint, enforced live                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Canvas             | `canvas`, `raised` (light: = canvas; dark: canvas + 0.06 L)                                  | –                                                                                                            |
| Sidebar            | `sidebar`                                                                                    | within ±0.06 L of canvas                                                                                     |
| Surface            | `surface`, `code` (= surface − 0.01 L)                                                       | between canvas and the hover wash                                                                            |
| Text               | `text`                                                                                       | ≥ 7:1 on canvas and surface                                                                                  |
| Secondary strength | derives `muted`, `subtle`, `faint` on the §2.1 L curve                                       | muted ≥ 4.5:1 on surface; subtle ≥ 4.5:1 on canvas; faint ≥ 3:1                                              |
| Hairline strength  | `border`, `borderStrong` alphas                                                              | borderStrong ≥ 1.4:1 on canvas                                                                               |
| Accent             | `accent`; `accentHover`/`accentPressed`/`accentText` derived; `accentFg` chosen white or ink | accentFg ≥ 4.5:1 on accent; accentText ≥ 4.5:1 on canvas, surface and sidebar; ΔE ≥ 10 from every status hue |
| Status × 4         | `working`, `needs`, `failed`, `done`; `…Text` derived to ≥ 4.5:1                             | the four stay ≥ ΔE 15 apart                                                                                  |
| Diff pair          | picks one of the §7.5 pairs                                                                  | –                                                                                                            |
| Syntax             | seven swatches, default derived from text/accent                                             | each ≥ 4.5:1 on `code`                                                                                       |
| Fonts              | ui / prose / mono from the §7.7 lists                                                        | –                                                                                                            |
| Material           | Glass: Thin / Regular / None, sets `material.glass` blur+saturate                            | None forces solid layers (as Signal)                                                                         |

The editor shows each constraint as a chip ("AA ✓" or "nudged to #5A5A5A") and never saves a failing value: it nudges toward the nearest passing colour and says so. Duplicating a built-in copies its full `ThemeSource` so the derived roles start from the designed values, not from the generator.

**Import / export.** The file is the token level the system actually uses, `ThemeSource` (`theme/types.ts`) with a header:

```json
{
  "$schema": "https://ace.dev/schemas/theme-1.json",
  "version": 1,
  "id": "custom:2f3c…",
  "name": "Harbor Night",
  "character": "Cool slate, lifted dark",
  "basedOn": "harbor",
  "fonts": { "ui": "...", "prose": "...", "mono": "..." },
  "material": {
    "light": { "glass": { "blur": 20, "saturate": 150 }, "focus": 60 },
    "dark": { "glass": { "blur": 20, "saturate": 140 }, "focus": 60 }
  },
  "light": {
    /* SchemeSource: the 12 ramp steps, code, accent, accentHover, accentFg, accentText,
               working/needs/failed/done + …Text, diffAdd/diffDel + …Fg, syntax{kw,fn,str,num,type,com,punc} */
  },
  "dark": {/* same keys */}
}
```

`SchemeSource` is 36 hex colours per scheme; the file carries all of them so an exported theme renders identically on import, with no generator drift. Validation: a Zod schema `ThemeFile` in `apps/web/src/theme/theme-file.ts` (parse leniently: unknown keys kept and round-tripped, missing optional roles derived, malformed colours rejected with the key named). After parsing, the same AA pass as the editor runs; any nudged role is listed in the import dialog before the user confirms. `version` lets a later schema migrate. Export is the inverse, always writing the current full values.

### 7.9 Order of work (appended to §4)

Three PRs, in this order, each shippable alone:

- **PR 12, Interface and Motion** (small): Contrast, Diff colours, Chat width, Panel animation speed with its preview, Density moved; `tokens.ts` resolves contrast; the glass solver takes the resolved inks. No new UI primitives beyond a `Slider` row with a preview slot.
- **PR 13, Typography**: bundle Inter and JetBrains Mono (`apps/web/public/fonts`, `@font-face` in `tokens.css`), family probe, family/size selects, Word wrap, the two preview cards, Advanced disclosure.
- **PR 14, Custom themes**: card actions, editor sheet with constraints, `theme-file.ts` schema, import/export, daemon storage and client cache, orbs on theme cards.

## 8. Page audit: where pages break the shared conventions

Every route was screenshotted at 1440×900 (light and dark), 768×1024 and 390×844 (light): `2026-10-14-screens/audit/` (62 files) with contact sheets `sheet-A.jpg` … `sheet-J.jpg`. The conventions they are judged against are written up as [`DESIGN.md`](../../DESIGN.md). What is consistent already: the settings shell (nav + 640–900px column), `SettingSection` cards with 52px rows, toggles and selects right-aligned, the delete confirmation (Cancel then a red "Stop and delete", focus on Cancel), the ⌘K palette, and the onboarding wizard. The breaks:

| #   | Page (sheet)                                            | What breaks                                                                                                                                                           | Fix                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Prompts (B), Providers (A)                              | Add actions sit outside the card as a text link ("+ New prompt") or a lone button ("Add an ACP agent…"); Remote devices does it right with an add row inside the card | Use `SettingAddRow` inside the card everywhere                                                                                                                                                                           |
| 2   | Prompts (B), Providers (A), Automations (D), Skills (J) | The page title row carries different things: a "Global" select, a refresh icon, a toggle stacked over a "Run now" button, a secondary button under the description    | One rule: title left, optional one-line description under it, **at most one action** on the right (primary or icon). Enabled toggles become the first row of the first card; secondary actions go into the header ⋯ menu |
| 3   | Computer use (C)                                        | "Computer tools" section is bare rows with status dots and prose, no card, while the two sections above are cards                                                     | Put it on a card; status as a `data-tone` word at the row's end; install hints as `SettingNote`                                                                                                                          |
| 4   | Source control (B)                                      | Rows with two-line descriptions ("Expected account") grow past the row height; three different right-side control widths                                              | Descriptions are one line or move to the section note; controls use the fixed widths (select 160–200, text 160, number 80 + unit)                                                                                        |
| 5   | Archived (D), Pair (E)                                  | Empty states are bare text at the top-left ("Nothing archived") or a title with nothing under it                                                                      | Use `EmptyState` (centred: faint icon, `title`, one `muted` line, one secondary action) for every empty page; "Thread unavailable" (E) already does this                                                                 |
| 6   | Toast (F)                                               | Toasts appear top-centre over the header and cover the breadcrumb                                                                                                     | Anchor toasts bottom-right of the content column (above the composer dock, never over it), 320px, `glass-thin`, 4s                                                                                                       |
| 7   | Error copy (E)                                          | "Back to Home" and "Go to Home" capitalise a view name                                                                                                                | Sentence case: "Back to home". Views are not proper nouns                                                                                                                                                                |
| 8   | Activity (C), Usage (J), side panel (G)                 | Three different "tabs": plain words with counts (Activity), pill segments (Usage: Cost / Tokens / Limits), icon pills (panel: Changes / Files / Browser)              | Two components only: `SegmentedControl` for 2–4 exclusive views inside a toolbar; `Tabs` (underline) for page sections. Counts are `meta` after the label                                                                |
| 9   | Usage (J)                                               | A page with its own type sizes (big percentages, underlined "Under pace", red 0%), no cards, provider sections with their own rule style                              | Provider sections as `SettingSection`s; percentages at `title`, labels at `meta`; pace as a `data-tone` word, not an underline; red only on the failed/limited row                                                       |
| 10  | Thread (G, fan-out)                                     | "Running in background …" renders twice in two styles (a system line, then a tool row with a chip)                                                                    | One row anatomy for background commands: the tool row; the system line goes                                                                                                                                              |
| 11  | Automations detail (D)                                  | "When / Runs on" card has no row dividers while "Recent runs" has; status "Failed" word sits before a date with no gap rule                                           | Both cards use `listDivider`; status word, then time at `meta`, 12px gap                                                                                                                                                 |
| 12  | Phone thread (H)                                        | Header title wraps to two lines; the approval strip's "Details ›" collides with the buttons; theme cards are huge 2-up                                                | Title truncates to one line; strip actions wrap to a second row with Details first; theme cards 3-up at 390 with the orb only                                                                                            |
| 13  | Settings on tablet (I)                                  | Content is left-aligned with a 96px margin and no nav; reads as unfinished                                                                                            | Centre the column at ≤ 900px; show the settings nav as a sheet from the header back control                                                                                                                              |
| 14  | General, light (A)                                      | Loading state shows grey pills in value slots with no labels (correct skeleton) but the section title stays at full ink while rows are empty                          | Skeleton rows keep their labels (labels are static data); only values are `--skel`. Keep this as the convention                                                                                                          |
| 15  | New thread (J)                                          | The environment row above the composer ("This Mac · Worktree · origin/main") is a third chip style (outlined mini-chips with icons)                                   | It is a strip row: `stripRow` with `stripControl`s, same as the approval strip                                                                                                                                           |
| 16  | All settings pages                                      | Section headers are `title`-ish 13px regular; some pages add a description under the page title, others not; spacing between sections varies 24–40px                  | Section header = `label` (11/500 caps) or 13/500, one of the two app-wide; 24px between sections; description only when the page needs it, one line                                                                      |

Appended to §4:

15. **Settings consistency** (rows 1–4, 11, 14, 16): add rows inside cards, one title-row rule, Computer tools on a card, fixed control widths, dividers. Small diff across `features/settings/*`, `features/automations/*`, `features/skills/*`.
16. **Empty, error, toast** (rows 5–7): `EmptyState` on Archived and Pair, toast anchor and material, sentence case sweep (`check:ui` can grep for "Home" in labels).
17. **Tabs and data pages** (rows 8–10, 15): one `SegmentedControl`, one `Tabs`; Usage on sections; the background-command row; the environment strip row.
18. **Narrow widths** (rows 12–13): header title truncation, strip wrapping, settings column on tablet, phone theme grid.

## Appendix: measurements used

- Sidebar row: 80px tall, 263px wide, 10px radius, title rgb(17,17,17), meta rgb(69,69,69) (DOM).
- Header: 44px, no border. Composer: 22px radius, 1px #E6E6E6, `white/52%`, no shadow, 696px wide. Sidebar 280px.
- Transcript prose: 14px, line-height 22.4px; ~72px between consecutive one-line agent messages (screenshot 02).
- Glass tokens: light tint 52%, blur 24; dark tint 64%, blur 28 (`--glass-tint`, `--glass-blur` on `<html>`).
- t3code (from its stylesheet, read for principles only): zinc neutrals in light (canvas oklch 99.2%, sidebar zinc-50, borders zinc-200, muted text zinc-500 ≈ 4.8:1); dark canvas neutral-950 with borders at white 6% and hover white 4%; base radius 10px and control radius 8px; desktop controls 32px (28px small); glass at 80% opacity, 12px blur, 1.14 saturation; composer shadow `0 12px 28px -18px black/40%`; buttons with 1px border, inner top highlight and an extra-small shadow; 11px/600 for small labels; system font stack.
