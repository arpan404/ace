---
name: visualize
description: Show an HTML page inline in chat (diagram, mockup, chart, explainer, quiz) when seeing beats prose. How to pick the form, design a page that holds from phone to full screen, preview it and publish it.
---

# Visualize in ace chat

`html_render` puts a self-contained HTML page inline in your reply, on the chat's background, at the full width of the message column. Its height grows to fit the content. The same page shows at **360 px on a phone, about 760 px on a desktop, and about 1200 px** full screen in the side panel.

`html_preview` lays the page out exactly as the app will and returns screenshots plus a report, including what `html_render` would refuse. Nothing is published.

Tool names: Claude Code `mcp__ace__html_render` / `mcp__ace__html_preview`; OpenCode and Pi `ace_html_render` / `ace_html_preview`.

**The page is yours.** Write whatever HTML, CSS, SVG and script the content needs. ace adds three things underneath: the app theme as CSS variables, quiet defaults for plain elements, and a few optional helper classes. Your CSS always wins over them without `!important`.

## The workflow

1. **Decide a page beats prose.** Use one when the reader learns faster by seeing or doing: structure (flows, timelines, architecture, decision trees), comparison, data, a UI mockup, an explainer with a parameter to move, or a quiz. A single fact, a one-step action or a short clear list stays prose. One page per idea.
2. **Write the takeaway**: the one sentence the reader should leave with. It becomes the page's first line, and every element serves it.
3. **Design it phone first.** Decide what the page is at 360 px: one column, the takeaway, then the content in reading order. Then decide what each part becomes at 760 px and at 1200 px. Done when you can say, for every part, how it lays out at all three widths.
4. **Build it** with your own markup and CSS. Use [Responsive layout](#responsive-layout) for the structure and [Design](#design) for the look.
5. **Preview** with `html_preview`. Add `widths: [360, 760, 1200]` for anything people will open full screen: dashboards, wide tables, desktop mockups. Done when the report lists nothing `html_render` would refuse, and each screenshot matches what you designed for that width.
6. **Publish** with `html_render` (`{ title, html, mode, height? }`). The `title` is a short caption above the page. In your reply, say only what the page doesn't already show.

## Responsive layout

The page's viewport is the chat column itself, so `@media (width < 520px)` asks how wide the column is, not the screen. Build layouts that adapt by themselves first. Add breakpoints only where the design changes shape.

- **Columns that wrap by themselves:** `grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr))`. Cards, stats and options flow from one column on a phone to three or four on a wide panel.
- **Rows that wrap:** `display: flex; flex-wrap: wrap` with `flex: 1 1 200px` on the children.
- **Tracks that can shrink:** `minmax(0, 1fr)`, not `1fr`, so long words and code can't push a column wider. Give text containers inside flex and grid `min-width: 0`.
- **Sizes with a ceiling:** `width: min(100%, 480px)`, `max-width`, `clamp(14px, 2.4cqi, 18px)` for type that grows with its box, `clamp()` for gaps.
- **Components that adapt to their own box:** put `container-type: inline-size` on a component and use `@container (width < 420px)` inside it. The same card can then sit in a narrow column or a wide one.
- **Line length at 1200 px:** keep prose near 70 characters (`max-width: 70ch`). Let grids, charts and tables use the width.
- **Content that is wide by nature** (a 12-column table, a long horizontal timeline) goes in a box with `overflow-x: auto`. It scrolls sideways inside the page; nothing else does.
- **SVG:** draw the `viewBox` about as wide as it will be shown (360–600 units) and let it scale with `width: 100%`. Its text scales with it, so 13–14 unit labels stay readable on a phone. Prefer HTML when the picture is mostly words: HTML text reflows, SVG text only shrinks.
- **Media:** `max-width: 100%` and `aspect-ratio` keep images, canvases and video in proportion.

### What the frame needs

The frame sizes itself to your page, and these rules follow from that. `html_render` refuses a page that breaks them:

- **Height comes from content.** Viewport units (`vh`, `dvh`, `svh`) and `height: 100%` on `html` or `body` make the frame grow without end. A mockup's screen gets a fixed pixel height on its own box instead.
- **Overlays sit in a positioned box.** `position: fixed` pins to the whole page, which is as tall as its content. Put sheets, menus, dialogs and toasts in a `position: relative` box with a fixed height, using `position: absolute`. `position: sticky` works.
- **At 360 px, nothing reaches past the edge** except inside an `overflow-x: auto` box, and **no text renders under 9 px**. `html_render` lays the page out at 360 px to check this. Aim for 12 px or more for text.

## Design

Choose the visual language for the content, then apply it consistently.

- **Explanations, diagrams, charts and data** read best as part of ace: theme variables for every colour, ace's type scale (12 px metadata, 13 px controls and dense lists, 14 px body, 16 px a lead line, about 20 px a heading), hairlines and space to separate things, the accent on the one thing to look at, and status colours only for status.
- **Mockups of ace** match ace exactly; see [Mockups](#mockups).
- **Anything with its own identity**, such as another product's UI, a game, a poster-like explainer or a landing-page proposal, takes its own palette, type, depth and texture. Gradients, shadows, illustration and custom fonts are fine when they serve the content. If it ignores the theme variables, set its own background and text colours so it reads in both light and dark mode.

Whatever the language:

- **Lead with the answer.** The first line is the takeaway as a sentence ("Transfers resume from the last acknowledged chunk"), not a heading that repeats the title.
- **One focal point per section.** Emphasis marks what changed, what is recommended or what is current.
- **A clear hierarchy:** a few type sizes, two or three text tones, weight for emphasis. Space on a 4 px grid (4, 8, 12, 16, 24).
- **Real content:** the real names, numbers, paths and states from the task, never placeholder text or invented metrics.
- **Label directly:** labels on lines and bars instead of a legend, units written out, tabular figures (`font-variant-numeric: tabular-nums`) and right-aligned numbers in columns.
- **Words like ace's:** sentence case, short labels, buttons that name their action ("Show the retry path"), and the content speaking for itself rather than narrating ("This diagram shows…").
- **Motion confirms a change:** 150–300 ms on what changed, honouring `prefers-reduced-motion`.

### Theme variables

The app theme arrives as CSS variables and updates live when the person switches theme or light/dark mode. Use them for colour and the page follows. Leave the page background transparent unless the design has its own.

- **Surfaces and text:** `--background`, `--foreground`, `--muted-foreground`, `--subtle-foreground`, `--card`, `--surface-2`, `--muted`, `--hover`, `--border`, `--input` (control edges), `--field`.
- **Emphasis:** `--accent` (the person's accent colour), `--accent-foreground` (text on it), `--accent-text` (accent-coloured text), `--primary`, `--primary-foreground`.
- **Status:** `--success`, `--warning`, `--info`, `--destructive`.
- **Data series:** `--chart-1` to `--chart-6`.
- **Shape and type:** `--radius`, `--font-sans`, `--font-mono`.

A script reads them with `getComputedStyle(document.documentElement)` and redraws on the `ace:theme` window event.

### ace's defaults and helpers

Every page starts with a small stylesheet in the `ace` cascade layer, so any rule you write beats it.

- **Plain elements** take ace's look: type, headings, paragraphs, lists, links, `code`/`pre`/`kbd`, tables (full width, hairline rows, tabular figures), `<details>`, inputs, `<select>`, `<textarea>`, checkboxes, radios, range sliders, `<progress>` and `<meter>`. `box-sizing: border-box` applies to everything, and SVG keeps its own paint.
- **Buttons:** a `<button>` with a class of your own (`<button class="option">`) is yours. It starts as a plain box with no padding, border or background, so your CSS lays it out exactly as written. A bare `<button>`, a lone state class (`active`, `selected`, `current`, `on`, `checked`), or the classes `ace-button`, `primary`, `ghost`, `small`, `icon` or `danger` give ace's 30 px button. Any button carrying one of those state classes or `aria-pressed="true"` also gets an accent tint, until your CSS sets its own `background` and `color`.
- **Helper classes** are optional shortcuts. They all start with `ace-`, so name your own classes anything else:

| Class                                                                                                    | What it does                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ace-stack` (`tight`, `loose`)                                                                           | Column with 12 px gaps (6, 24).                                                                                                    |
| `ace-row` (`between`, `end`, `nowrap`, `top`)                                                            | Wrapping row, 8 px gaps; `ace-grow` on a child takes the free space.                                                               |
| `ace-grid`                                                                                               | `auto-fit` columns at least `--min` wide (default 180 px).                                                                         |
| `ace-split` (`keep`)                                                                                     | Two columns (`--side` sets the first, default `1fr`), one column under 520 px unless `keep`.                                       |
| `ace-scroll-x`                                                                                           | Sideways scroller; its child is at least `--min-width` (default 640 px).                                                           |
| `ace-rows`, `ace-kv`                                                                                     | Hairline-separated list; a `<dl>` as aligned label and value columns.                                                              |
| `ace-flow` (`vertical`, `numbered`)                                                                      | `<ol>` of bordered steps joined by arrows; stacks under 560 px.                                                                    |
| `ace-timeline`                                                                                           | `<ol>` of events along a line with dots: optional `<time>`, a `<strong>` title, detail.                                            |
| `ace-frame` (`phone`)                                                                                    | Mockup screen: fixed height `--h` (default 480 px; `phone` 390 × 640), clips, is a size container. `ace-scroll` scrolls inside it. |
| `ace-card` (`raised`, `plain`)                                                                           | Bordered panel.                                                                                                                    |
| `ace-stat` with `.label`, `.value`, `.delta`                                                             | A key number; `ace-up` / `ace-down` colour a change.                                                                               |
| `ace-badge` (`dot`), `ace-callout`                                                                       | Small pill; tinted note.                                                                                                           |
| `ace-tabs` or `role="tablist"` with `<button>`s                                                          | Segmented control; your script moves `aria-selected="true"`.                                                                       |
| `ace-bar` with a `<span>` and `--value: 40%`                                                             | Thin bar; `--c` sets its colour.                                                                                                   |
| `ace-muted`, `ace-subtle`, `ace-mono`, `ace-num`, `ace-eyebrow`, `ace-lead`, `ace-divider`, `ace-swatch` | Text tones, monospace, tabular figures, section label, intro line, hairline, colour square.                                        |

Tones `success`, `warning`, `danger` and `info` apply to `ace-badge`, `ace-callout`, and steps in `ace-flow` and `ace-timeline`; `accent` to badges and steps.

## Charts

- **Pick the chart by the question:** bars to compare categories (sorted, unless the order means something), a line for change over time, a scatter for a relationship. Stack only when the total matters. Use parts-of-a-whole charts for three parts at most, and one axis per chart.
- **Build it** as inline SVG with a `viewBox` about as wide as it shows, as HTML for bar lists, or as a `<canvas>` you size from its container (`ResizeObserver`) at `devicePixelRatio`.
- **Style:** 12 px axis labels in `--muted-foreground`, horizontal gridlines in `--border`, series in `--chart-1`, `--chart-2`, … in order, the series that matters highlighted and the rest muted. Bars start at zero.
- **Headline the finding** above it ("Cold starts fell 41% after caching"), and give the numbers as text too (values on the marks or a table), so nothing depends on colour alone.

## Mockups

- **Give the screen a box:** a fixed pixel height, `overflow: hidden`, `position: relative` for overlays and `container-type: inline-size` (`ace-frame` does all four). Inside it, a header and footer keep their height and the body scrolls (`overflow: auto; min-height: 0`).
- **Make it collapse inside the box:** `@container (width < 520px)` hides or narrows a sidebar, so a phone never shows content squeezed to a sliver.
- **For ace's own UI, use ace's measurements:** 13 px controls and list text, 14 px titles, 12 px metadata; 30 px controls, 32–36 px rows; 8 px radius on rows and buttons, 12 px on cards and dialogs, 18 px on the composer; hairline `--border` edges; round send and stop buttons. Icons are inline SVG line icons, `stroke="currentColor"`, 1.5 px stroke, 16 px beside 13–14 px text.
- **Show states and options with tabs** above the screen, with one muted line under each saying what it is.
- **Make it clickable** (`mode: "interactive"`) when the interaction is the point.

## Interactive or static

- **`interactive`** when the reader manipulates the page: sliders, step-throughs, quizzes, simulations, sortable tables, clickable mockups. Put each control next to what it changes, update on `input`, use real `<button>`, `<input>` and `<label>` elements, keep focus outlines, and announce changing results with `aria-live="polite"`. Keep state in variables and render from it: a page scrolled far away is unloaded and rebuilt when it returns.
- **`static`** for read-only pages. Scripts and handlers are removed, so draw the result as markup, even when a script would only run once.

Left out, `mode` is static for a page with no script and interactive otherwise.

## The sandbox

The page runs in an opaque-origin sandbox. It can't read the app, storage, cookies or the parent page.

- **Everything inline.** No network: `fetch`, WebSocket, and external images, fonts, scripts and stylesheets are refused, as are `@import` and web or file addresses in CSS `url()`. Inline `data:` URLs and in-page references (`url(#arrow)`) work. The whole page is at most 16 MiB.
- **Images as base64:** `<img src="data:image/png;base64,…" alt="…">`, or the same `data:` URL in CSS. Get the string with `base64 -i shot.png` on macOS or `base64 -w0 shot.png` on Linux, and downscale first (`sips -Z 1600 -s format jpeg shot.png --out shot.jpg`).
- **No navigation or dialogs:** links to other pages, forms, pop-ups, downloads, `alert` and `confirm` do nothing. `#fragment` links work.
- **No `eval`**, `new Function` or string timers, and no storage: keep state in variables.
- **Markup inserted by script** drops `<link>`, `<meta>`, `<base>` and frames.

The reader can open the page full screen in the side panel, copy its source or download it.

### What publishing refuses

`invalid_html` means nothing was published. Fix every listed problem and call `html_render` again.

- **Unsafe content:** frames, forms, plugins, `<link>`, base URLs, `http-equiv` metadata, and any file or web address in markup or CSS.
- **`viewport-height`, `root-height`, `fixed-position`:** see [What the frame needs](#what-the-frame-needs).
- **`overflow`:** at 360 px, something reaches past the edge outside an `overflow-x: auto` box. The message names it.
- **`text-too-small`:** at 360 px, text renders under 9 px, often SVG labels in a `viewBox` drawn too wide.
- **`fixed-width`, `svg-text-too-small`:** the same two checks guessed from the markup, used when the page can't be laid out.

## Posting an image

For real pixels (a screenshot, a rendered plot, a generated picture), call `image_show` (`mcp__ace__image_show` in Claude Code, `ace_image_show` in OpenCode and Pi) instead of building a page.

- `data` is the raw base64 of a PNG, JPEG, WebP or GIF, with no `data:` prefix, up to 16 MiB of image. Only for a larger image, pass `path` (up to 128 MiB, relative to your working directory or absolute, and not a symbolic link).
- `alt` says what it shows; `caption` is an optional line under it.
- `invalid_image` means the bytes aren't one of those formats: convert to PNG and call again.
