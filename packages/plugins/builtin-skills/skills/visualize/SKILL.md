---
name: visualize
description: Show an HTML page inline in chat (diagram, mockup, chart, explainer, quiz) when seeing beats prose. How to pick the form, design a page that holds from phone to full screen, preview it and publish it.
---

# Visualize in ace chat

`html_render` puts a self-contained HTML page inline in your reply, on the chat's background, at the full width of the message column. Its height grows to fit the content. The same page shows at **360 px on a phone, about 760 px on a desktop, and about 1200 px** full screen in the side panel.

`html_preview` lays the page out exactly as the app will and returns screenshots plus a report, including what `html_render` would refuse. Nothing is published.

Tool names: Claude Code `mcp__ace__html_render` / `mcp__ace__html_preview`; OpenCode and Pi `ace_html_render` / `ace_html_preview`.

**The page is yours.** Write whatever HTML, CSS, SVG and script the content needs. ace adds three things underneath: the app theme as CSS variables, quiet defaults for plain elements, and a few optional helper classes. Your CSS always wins over them.

The bar: someone understands the point in ten seconds, and the page could only have been made for this topic.

## The workflow

1. **Decide a page beats prose.** Use one when the reader learns faster by seeing or doing: how something works, what changed, a comparison, data, a UI proposal, a parameter to move, a quiz. A single fact, a one-step action or a short clear list stays prose. One page per idea.
2. **Write the takeaway**: the one sentence the reader should leave with ("Transfers resume from the last acknowledged chunk"). It becomes the page's first line.
3. **Gather the real material.** Every name, number, state and label comes from the task, the conversation or code you read. When the page shows something that already exists (a screen, a component, a flow in the codebase), find and read its code first and take its real structure, wording and design tokens. Done when you can point to a source for every fact the page will show.
4. **Plan, then check the plan.** Before any HTML, write a short plan:
   - the figures, one per point (see [Show, don't tell](#show-dont-tell)), in reading order;
   - an ASCII sketch of the layout at 360 px, and what changes at 760 and 1200 px;
   - what colour means on this page, and the one element that gets the emphasis.

   Then read the plan as if it were for a different topic. Any part that would come out the same for any similar request, or that appears in [Generic defaults](#generic-defaults), gets replaced with a choice made for this content.

5. **Build it** with your own markup and CSS ([Responsive layout](#responsive-layout), [Design](#design)).
6. **Preview** with `html_preview`. Add `widths: [360, 760, 1200]` for anything people will open full screen: dashboards, wide tables, desktop mockups. Check `scheme: "light"` too when you set colours yourself. Go through [Before you publish](#before-you-publish) against the screenshots and fix with small edits. Done when your last preview is of the exact page you will publish, its report lists nothing `html_render` would refuse, and every checklist line holds.
7. **Publish** with `html_render` (`{ title, html, mode, height? }`). The `title` is a short caption above the page. In your reply, say only what the page doesn't already show.

## Show, don't tell

The figures carry the meaning; words label them.

- **One point per figure.** Each figure has a caption or heading that states its point as a sentence ("Cache hits skip Postgres"), not a topic ("Caching").
- **Draw the mechanism, not the name.** Show the request travelling through the cache, not a box labelled "cache". Every arrow carries a verb: "writes", "polls every 30 s", "retries 3×".
- **Draw the difference.** A comparison shows what each option adds, removes or reroutes, side by side, with the changed parts emphasised.
- **Give every number a picture**: a bar, a sparkline, a dimension line on the span it measures, or the limit it is measured against. A number with nothing to compare to tells the reader little.
- **Repeat for cases.** Several scenarios or failure modes become small multiples: the same small diagram once per case.
- **Turn descriptions into labels.** A sentence that describes the picture becomes a label, a callout or an edge verb inside it. Keep prose for reasoning and trade-offs, a few short sentences at most.
- **Encode with position and shape first:** position for order and rank, size for amount, closeness for what belongs together, lines for flow and dependency, shape or pattern for kind. Colour adds one meaning along one axis (status, or series, or team) and keeps it across the whole page. State is never shown by colour alone.

| You're showing                    | A figure that works                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| How a system or request works     | Boxes laid out where they sit, arrows with verbs, the path of one request highlighted |
| Steps, a pipeline, a lifecycle    | A flow or state diagram; a stepper when the order of events is the point              |
| What happened when                | A timeline on a real time axis, gaps drawn to scale when they matter                  |
| Messages between parties          | Lanes per party with arrows between them, or a timeline of "A → B: what"              |
| Choices and branches              | A decision tree: the question, then each answer's path                                |
| 2–4 options                       | Side-by-side drawings of the difference, then a table of trade-offs                   |
| Quantities                        | A chart (see [Charts](#charts))                                                       |
| A setting with an effect          | A slider with the result drawn right beside it                                        |
| A UI proposal                     | A mockup (see [Mockups](#mockups))                                                    |
| Facts or properties with no shape | Hairline rows of label and value                                                      |

## Responsive layout

The page's viewport is the chat column itself, so `@media (width < 520px)` asks how wide the column is. Build layouts that adapt by themselves, and add breakpoints only where the design changes shape.

- **Columns that wrap by themselves:** `grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr))`.
- **Rows that wrap:** `display: flex; flex-wrap: wrap` with `flex: 1 1 200px` on the children.
- **Tracks that can shrink:** `minmax(0, 1fr)`, and `min-width: 0` on text containers inside flex and grid, so long words can't push a column wider.
- **Sizes with a ceiling:** `width: min(100%, 480px)`, `max-width`, `clamp()` for type and gaps.
- **Components that adapt to their own box:** `container-type: inline-size` on the component and `@container (width < 420px)` inside it.
- **Line length at 1200 px:** prose near 70 characters (`max-width: 70ch`); grids, charts and tables use the width.
- **Content that is wide by nature** (a 12-column table, a long timeline) goes in a box with `overflow-x: auto`.
- **SVG:** draw the `viewBox` about as wide as it will be shown (360–600 units) and scale it with `width: 100%`; 13–14 unit labels then stay readable on a phone. When a diagram must reflow (three boxes across on desktop, stacked on a phone), build it in HTML with CSS connectors, or draw two SVGs and show one per width.

### What the frame needs

The frame sizes itself to your page. `html_render` refuses a page that breaks these:

- **Height comes from content.** Viewport units (`vh`, `dvh`, `svh`) and `height: 100%` on `html` or `body` make the frame grow without end.
- **Overlays sit in a positioned box.** `position: fixed` pins to the whole page. Put sheets, menus, dialogs and toasts in a `position: relative` box with a fixed height, using `position: absolute`. `position: sticky` works.
- **At 360 px, nothing reaches past the edge** except inside an `overflow-x: auto` box, and **no text renders under 9 px**. `html_render` lays the page out at 360 px to check. Aim for 12 px or more.

## Design

Choose the visual language for the content, then hold it across the page.

- **Explanations, diagrams, charts and data** read best as part of ace: theme variables for every colour, ace's type sizes (12 px metadata, 13 px controls and dense lists, 14 px body, 16 px a lead line, about 20 px a heading), hairlines and space to separate things, the accent on the one thing to look at, status colours only for status.
- **Anything with its own identity**, such as another product's UI, a game or a poster-like explainer, takes its own palette, type, depth and texture when they serve it. If it ignores the theme variables, set its own background and text colours so it reads in light and dark mode.

Whatever the language:

- **Spend boldness in one place.** One element is the memorable thing (the diagram's highlighted path, the recommended option, the number that changed); everything around it is quiet. Before publishing, remove one thing.
- **A clear hierarchy:** a few type sizes with real jumps between them, two or three text tones, weight for emphasis, one left edge per column. Space on a 4 px grid (4, 8, 12, 16, 24).
- **Words like ace's:** sentence case, short labels, buttons that name their action ("Show the retry path"). The page states things; it doesn't narrate itself ("This diagram shows…").
- **Motion answers the reader:** 150–300 ms on what changed after a click or a drag, a stepper that advances, a dot travelling along a flow to show direction. Honour `prefers-reduced-motion`.

### Generic defaults

These come out of any request when no choice was made, and they make a page read as generated. Each has a better move:

| Default                                                       | Instead                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A small uppercase label above every heading                   | A heading that states the point                                                    |
| Everything in identical rounded cards with soft shadows       | Space and hairlines for grouping; a box only for a separate object, like an option |
| A giant number with a tiny label                              | The number beside what it's measured against: a bar, a limit, last week            |
| `01 / 02 / 03` markers                                        | Numbers only for real steps; otherwise the content's own order                     |
| Metadata strung together with `·`, `→` on every link          | A short phrase that says the fact                                                  |
| Gradient text, glows, blobs, emoji as markers                 | Emphasis spent on the data or the path that matters                                |
| A fade-and-slide on every section, a hover lift on every card | Motion only where something changes for the reader                                 |
| Everything centred                                            | One left edge; centre only a lone number or an empty state                         |
| Boxes labelled with component names, joined by bare arrows    | The mechanism, with verbs on the arrows                                            |

### Theme variables

The app theme arrives as CSS variables and updates live when the person switches theme or light/dark mode. Leave the page background transparent unless the design has its own.

- **Surfaces and text:** `--background`, `--foreground`, `--muted-foreground`, `--subtle-foreground`, `--card`, `--surface-2`, `--muted`, `--hover`, `--border`, `--input` (control edges), `--field`.
- **Emphasis:** `--accent` (the person's accent colour), `--accent-foreground` (text on it), `--accent-text` (accent-coloured text), `--primary`, `--primary-foreground`.
- **Status:** `--success`, `--warning`, `--info`, `--destructive`.
- **Data series:** `--chart-1` to `--chart-6`, six distinct colours that read on the background.
- **Shape and type:** `--radius`, `--font-sans`, `--font-mono`.

A script reads them with `getComputedStyle(document.documentElement)` and redraws on the `ace:theme` window event.

## Charts

- **Pick the chart by the question:** bars to compare categories, a line for change over time, a scatter for a relationship, small multiples to compare across groups. Stack only when the total matters. Parts of a whole: three parts at most. Two measures get two small charts, not two axes.
- **Sort categories** by value unless the order means something (days, steps).
- **Label directly:** values on or beside the marks, series names at the line ends, units written out. A legend only past three series.
- **Put the accent on the focal point:** the bar, line or dot the headline is about. The rest stays in a muted tone or lighter series colour.
- **Headline the finding** above the chart, with its number ("Thursday peaked at 510 messages, 4× Sunday").
- **Quiet scaffolding:** 12 px axis labels in `--muted-foreground`, a few horizontal gridlines in `--border`, axes only where data is, bars from zero. A sparkline beside a number shows its trend in a line of text.
- **Build it** as inline SVG with a `viewBox` about as wide as it shows, as HTML for bar lists, or as a `<canvas>` sized from its container (`ResizeObserver`) at `devicePixelRatio`.

## Mockups

- **Start from the real thing.** For a change to something that exists, read its code first and build the mockup in its actual layout, wording, tokens and icons. Show the current state next to the proposal, so the difference is visible.
- **Give the screen a box:** `position: relative`, `overflow: hidden`, `container-type: inline-size`, and a fixed pixel height on desktop. Inside it, a header and footer keep their height and the body scrolls (`overflow: auto; min-height: 0`).
- **Let it collapse on a phone:** `@container (width < 520px)` hides or narrows sidebars, and lets the screen's height follow its content (`height: auto`, the body `overflow: visible`), so nothing is cut off at the bottom.
- **For ace's own UI, use ace's measurements:** 13 px controls and list text, 14 px titles, 12 px metadata; 30 px controls, 32–36 px rows; 8 px radius on rows and buttons, 12 px on cards and dialogs, 18 px on the composer; hairline `--border` edges; round send and stop buttons. Icons are inline SVG line icons, `stroke="currentColor"`, 1.5 px stroke, 16 px beside 13–14 px text.
- **Show states and options with tabs** above the screen, one muted line under each saying what it is.
- **Make it clickable** (`mode: "interactive"`) when the interaction is the point.

## Interactive or static

- **`interactive`** when the reader manipulates the page: sliders, steppers, quizzes, simulations, sortable tables, clickable mockups. Put each control next to what it changes, update on `input`, use real `<button>`, `<input>` and `<label>` elements, keep focus outlines, and announce changing results with `aria-live="polite"`. Keep state in variables and render from it: a page scrolled far away is unloaded and rebuilt when it returns.
- **`static`** for read-only pages. Scripts are removed, so draw the result as markup.

Left out, `mode` is static for a page with no script and interactive otherwise.

## Before you publish

Look at the preview screenshots, not the source, and check each line:

- **The first screen is the answer:** the takeaway sentence and the main figure.
- **Each figure makes one point**, stated in its caption or heading, and draws the mechanism or the difference.
- **Every fact has a source.** Nothing invented: no labels, limits, names or numbers the task didn't give. Where something is illustrative, the page says so.
- **It is specific:** swap the topic and the page would have to change. Nothing from [Generic defaults](#generic-defaults) is there by accident.
- **It holds at every width:** one column on the phone with nothing cut off, the layout you sketched at 760 and 1200 px.
- **It reads in light and dark mode**, and nothing relies on colour alone.
- **Every control changes something visible**, right beside it.
- **One thing removed** that the page didn't need.

## ace's defaults and helpers

Every page starts with a small stylesheet in the `ace` cascade layer, so any rule you write beats it.

- **Plain elements** take ace's look: type, headings, lists, links, `code`/`pre`/`kbd`, tables (full width, hairline rows, tabular figures), `<details>`, form controls, sliders, `<progress>` and `<meter>`. `box-sizing: border-box` applies everywhere; SVG keeps its own paint.
- **Buttons:** a `<button>` with a class of your own (`<button class="option">`) starts as a plain box with no padding, border or background, so your CSS lays it out as written. A bare `<button>`, a lone state class (`active`, `selected`, `current`, `on`, `checked`), or `ace-button`, `primary`, `ghost`, `small`, `icon` or `danger` give ace's 30 px button. A button with one of those state classes or `aria-pressed="true"` also gets an accent tint until your CSS sets its own `background` and `color`.
- **Optional helpers**, all prefixed `ace-` (name your own classes anything else):

| Class                                            | What it does                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `ace-stack`, `ace-row`, `ace-grid`, `ace-split`  | Column; wrapping row; `auto-fit` columns at least `--min` wide; two columns, one under 520 px |
| `ace-scroll-x`                                   | Sideways scroller; its child is at least `--min-width` (default 640 px)                       |
| `ace-rows`, `ace-kv`                             | Hairline-separated list; a `<dl>` as label and value columns                                  |
| `ace-flow`, `ace-timeline`                       | Simple step list joined by arrows (stacks under 560 px); events along a line with dots        |
| `ace-frame` (`phone`)                            | Mockup screen with fixed height `--h`, clipping, size container; `ace-scroll` scrolls inside  |
| `ace-tabs` or `role="tablist"`                   | Segmented control; your script moves `aria-selected="true"`                                   |
| `ace-badge`, `ace-callout`, `ace-bar`            | Small pill; tinted note; thin bar (`--value`, `--c`)                                          |
| `ace-muted`, `ace-subtle`, `ace-mono`, `ace-num` | Text tones, monospace, tabular figures                                                        |

## The sandbox

The page runs in an opaque-origin sandbox and can't read the app, storage, cookies or the parent page.

- **Everything inline, no network.** External images, fonts, scripts, stylesheets, `fetch` and WebSocket are refused, as are web or file addresses in CSS. `data:` URLs and in-page references (`url(#arrow)`) work. The page is at most 16 MiB.
- **Images as base64:** `<img src="data:image/png;base64,…" alt="…">`. Get the string with `base64 -i shot.png` (macOS) or `base64 -w0 shot.png` (Linux); downscale first (`sips -Z 1600 -s format jpeg shot.png --out shot.jpg`).
- **No navigation, dialogs, `eval` or storage.** `#fragment` links work; keep state in variables.

`invalid_html` means nothing was published; fix every listed problem and call again. Besides unsafe content (frames, forms, plugins, `<link>`, external addresses), it refuses `viewport-height`, `root-height` and `fixed-position` ([What the frame needs](#what-the-frame-needs)), and at 360 px `overflow` and `text-too-small`. `fixed-width` and `svg-text-too-small` are the same checks guessed from the markup when the page can't be laid out.

## Posting an image

For real pixels (a screenshot, a rendered plot), call `image_show` (`mcp__ace__image_show` in Claude Code, `ace_image_show` in OpenCode and Pi) instead of building a page. Pass `data` as raw base64 of a PNG, JPEG, WebP or GIF (no `data:` prefix, up to 16 MiB), or `path` for a larger file (up to 128 MiB, not a symbolic link). `alt` says what it shows; `caption` is optional. `invalid_image` means the bytes aren't one of those formats: convert to PNG and call again.
