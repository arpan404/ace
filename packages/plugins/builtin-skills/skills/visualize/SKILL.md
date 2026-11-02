---
name: visualize
description: Show an HTML page inline in chat (diagram, mockup, chart, explainer, quiz) when seeing beats prose. How to pick the form, design it well, build it with ace's style kit, preview it and publish it.
---

# Visualize in ace chat

`html_render` puts a self-contained HTML page inline in your reply. It sits on the chat's own background at the full width of the message column and grows to fit its content. The same page shows **360 px wide on a phone, about 760 px on a desktop, and up to about 1200 px** when opened full screen in the side panel. Design for all three.

`html_preview` renders a page exactly as the app will show it, at 360 px and 760 px, and returns screenshots plus measured problems. Nothing is published. Use it before every page you're unsure of, and always for mockups and diagrams.

Tool names: Claude Code `mcp__ace__html_render` / `mcp__ace__html_preview`; OpenCode and Pi `ace_html_render` / `ace_html_preview`.

## The workflow

1. **Decide a page beats prose** (next section). If not, write prose.
2. **Write the takeaway first**: one sentence the reader should leave with. Every element on the page serves it; cut what doesn't.
3. **Pick the form** from [Pick the form](#pick-the-form) and build it with the kit's building blocks.
4. **Preview** with `html_preview`. Look at both screenshots and fix what's wrong.
5. **Publish** with `html_render` (`{ title, html, mode, height? }`). In your reply, say only what the page doesn't already show.

## When a page beats prose

Use a page when the reader learns faster by seeing or doing:

- **Structure:** flows, sequences, timelines, decision trees, architecture.
- **Comparison:** options side by side, before and after, trade-offs.
- **Data:** a chart, a table you can sort or filter, a few key numbers.
- **Mockups:** a clickable sketch of a UI under discussion.
- **Explaining:** a slider that changes a parameter and shows the effect, a step-through, a small simulation.
- **Checking understanding:** a quiz with feedback.

Use prose for a single fact, a one-step action, or a short list that is already clear. One page per idea, not a page for every reply.

## Pick the form

| You're showing                                 | Form          | Build with                                                                                      |
| ---------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| Steps in order, a pipeline                     | Flow          | `ace-flow` (up to 5 steps run across; more, or long text: `ace-flow vertical`)                  |
| What happened when, a history                  | Timeline      | `ace-timeline`                                                                                  |
| Messages between parties (A asks B, B answers) | Sequence      | `ace-timeline` with "A → B: what" per step; an SVG only with ≤ 4 lanes and a viewBox ≤ 600 wide |
| Choices and branches                           | Decision tree | A question, then `ace-split` with one `ace-flow vertical` per answer                            |
| Parts of a system and how they connect         | Architecture  | `ace-grid` of components, each listing what it talks to; SVG only if it fits 600 units          |
| 2–4 options                                    | Comparison    | A `<table>` (options as columns, criteria as rows), or tabs with one option per tab             |
| Settings, facts, properties                    | Hairline list | `ace-rows` or `ace-kv`                                                                          |
| One to four numbers that matter                | Stats         | `ace-stat` in an `ace-grid`                                                                     |
| Quantities across categories or time           | Chart         | See [Charts](#charts)                                                                           |
| A UI proposal                                  | Mockup        | `ace-frame`; see [Mockups](#mockups)                                                            |
| A concept with a parameter                     | Explainer     | A slider or step buttons, with the result right beside it                                       |

Prefer HTML layout to SVG whenever the picture is mostly words: HTML text reflows at every width, SVG text only shrinks.

## Design it well

These are what separate a page that reads as part of ace from one that reads as a web page dropped into chat.

1. **Lead with the answer.** The first line is the takeaway as a sentence ("Transfers resume from the last acknowledged chunk"), not a heading that repeats the `title`. The `title` is a short caption shown above the page; don't repeat it.
2. **One focal point per section.** The accent colour marks the one thing to look at: the recommended option, the step that changed, the current state. Everything else is ink.
3. **Three text tiers, used consistently.** `--foreground` for what to read, `--muted-foreground` (`ace-muted`) for descriptions and secondary values, `--subtle-foreground` (`ace-subtle`) for timestamps, counts and captions. Weights: 400 body, 500 titles and labels, 600 only for a page heading or emphasis.
4. **Type sizes from one scale:** 12 px metadata and axis labels, 13 px controls and dense lists, 14 px body (the default), 16 px a lead line, 20 px at most for a heading. Never under 11 px.
5. **Edges before boxes.** Separate with hairlines (`ace-rows`, `<hr>`) and space first. Use a card (`ace-card`) only for things that are separate objects, like options to compare. Never wrap the whole page in a card and never nest cards.
6. **Colour means something.** Status colours (`--success`, `--warning`, `--destructive`, `--info`) only for status. `--chart-1` to `--chart-6` for data series, in that order. Never colour for decoration: no gradients, glows, shadows on content, tinted backgrounds behind sections, or emoji.
7. **Label directly.** Put labels at the end of lines and on bars instead of a legend. Write units. Use tabular figures for numbers (`ace-num`, tables do it already) and right-align numbers in columns.
8. **Real content only.** Use the real names, numbers, paths, and states from the task. No lorem ipsum, "Item 1", "Lorem Corp" or made-up metrics.
9. **Align to one edge.** Left-align text, keep one left edge per column, keep row heights consistent. Centre only a lone number or an empty state.
10. **Space on a 4 px grid:** 4, 8, 12, 16, 24. 8–12 inside a group, 16–24 between groups.
11. **Words like ace's:** sentence case, short labels, buttons that name the action ("Show the retry path"), no narration ("This diagram shows…", "Click below to…").
12. **Motion confirms, never entertains.** Transitions of 150–300 ms on what changed; nothing loops; honour `prefers-reduced-motion`.

## Layout that holds at every width

`html_render` refuses a page that breaks these rules (see [What publishing refuses](#what-publishing-refuses)); the rest `html_preview` shows you.

- **Fluid widths.** Build with `ace-grid`, `ace-split`, `ace-row`, flex and grid with `minmax(0, 1fr)`, `min()` and `clamp()`. No fixed width over 360 px: write `width: min(100%, 480px)` or `max-width: 480px`.
- **Collapse under 520 px.** Side-by-side content becomes one column on a phone. `ace-split` and `ace-grid` do this; your own grids need `@media (max-width: 519px)`.
- **Let content set the height.** Never `vh`/`dvh`/`svh` units and never `height: 100%` on `html` or `body`: the frame grows to fit the page, so they make it grow without end. A mockup gets a fixed pixel height through `ace-frame`.
- **No `position: fixed`.** It pins to the whole page, which is as tall as its content. Put overlays, sheets and toasts in an `ace-frame` with `position: absolute`.
- **SVG text must stay readable.** An SVG scales to fit the column, and its text scales with it. Draw the viewBox about as wide as you want it shown (360–600 units) with labels of 13–14 units. Publishing refuses an SVG whose smallest label would render under 9 px at 360 px wide.
- **Wide by nature?** A wide table or a long horizontal timeline goes in `<div class="ace-scroll-x" style="--min-width: 720px">`, which scrolls sideways inside the page.
- **Long words wrap.** The kit breaks long paths and identifiers in `code`; give your own long-text containers `min-width: 0`.
- **Name your own classes anything except `ace-…`.** The kit owns that prefix. Don't restyle kit classes to mean something else.

## The style kit

Every page starts with ace's style kit, so plain markup already looks like the app. Write semantic HTML first and add your own CSS only where the kit doesn't cover it. Your CSS always wins over the kit; it never needs `!important` or extra specificity.

**Styled elements:** headings, paragraphs, lists, links, `code`/`pre`/`kbd`, `<table>`, `<details>`, text inputs, `<select>`, `<textarea>`, checkboxes, radios, `<input type="range">`, `<progress>`, `<meter>`.

**Buttons:** a `<button>` with no class looks like an ace button (30 px, hairline edge). Add `primary` (one per page, the main action), `ghost`, `small`, `icon` or `danger`. A button with a class of your own (`<button class="option">`) is reset to a plain box with no padding, border or background, so you can build rows, nav items and option cards from real buttons. A button whose only class is a state (`active`, `selected`, `current`, `on`, `checked`) or that has `aria-pressed="true"` keeps the ace look and shows as selected. Add `ace-button` to give any classed button the ace look.

### Building blocks

| Class                                                  | What it is                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `ace-stack` (`tight`, `loose`)                         | Vertical stack with 12 px gaps (6, 24).                                                                                 |
| `ace-row` (`between`, `end`, `nowrap`, `top`)          | Horizontal row that wraps, 8 px gaps. `ace-grow` on a child takes the free space.                                       |
| `ace-grid`                                             | Responsive columns; `--min` sets the narrowest column (default 180 px).                                                 |
| `ace-split` (`keep`)                                   | Two columns, collapsing to one under 520 px (`keep` never collapses). `--side` sets the first column (`--side: 220px`). |
| `ace-scroll-x`                                         | Sideways scroller for wide content; its child is at least `--min-width` (default 640 px).                               |
| `ace-rows`                                             | List with hairlines between rows. Put an `ace-row between` inside each row for label + value.                           |
| `ace-kv`                                               | A `<dl>` as two aligned columns: `<dt>` label (muted), `<dd>` value.                                                    |
| `ace-flow` (`vertical`, `numbered`)                    | `<ol>` of steps with arrows between them. Runs across on wide screens and stacks under 560 px.                          |
| `ace-timeline`                                         | `<ol>` of events on a line with dots. Each `<li>`: optional `<time>`, a `<strong>` title, then detail.                  |
| `ace-frame` (`phone`)                                  | Mockup frame: fixed height (`--h`, default 480 px; `phone` is 390 × 640), clips its content, holds overlays.            |
| `ace-scroll`                                           | A region that scrolls inside a frame.                                                                                   |
| `ace-card` (`raised`, `plain`)                         | A bordered panel for one separate object. Use sparingly.                                                                |
| `ace-stat` with `.label`, `.value`, `.delta`           | A key number. `ace-up` / `ace-down` colour a change.                                                                    |
| `ace-badge` (`dot`)                                    | A small pill for a state or count.                                                                                      |
| `ace-callout`                                          | A tinted note for the one warning or key point on a page.                                                               |
| `ace-tabs` (or any `role="tablist"`) with `<button>`s  | Segmented control; your script moves `aria-selected="true"`.                                                            |
| `ace-bar` with a `<span>` and `--value: 40%`           | A thin horizontal bar; `--c` sets its colour.                                                                           |
| `ace-muted`, `ace-subtle`, `ace-mono`, `ace-num`       | Text tiers, monospace, tabular figures.                                                                                 |
| `ace-eyebrow`, `ace-lead`, `ace-divider`, `ace-swatch` | Small uppercase section label, larger intro line, hairline, colour square (`--c`).                                      |

**Tones:** add `success`, `warning`, `danger`, `info` or `accent` to an `ace-badge`, `ace-callout`, or a step (`<li>`) in `ace-flow` or `ace-timeline`.

### Recipes

A flow:

```html
<ol class="ace-flow numbered">
  <li><strong>Check</strong>Thread idle, link exists</li>
  <li class="accent"><strong>Snapshot</strong>Bundle uncommitted changes</li>
  <li><strong>Send</strong>4 MiB chunks, resumable</li>
  <li class="success"><strong>Import</strong>Verify, start the thread</li>
</ol>
```

A timeline (also good for a sequence between parties):

```html
<ol class="ace-timeline">
  <li class="success">
    <time>09:12</time><strong>MacBook → Studio: begin</strong>Method, project, origin URL
  </li>
  <li><time>09:13</time><strong>Studio → MacBook: ready</strong></li>
  <li class="warning">
    <time>09:20</time><strong>Connection dropped</strong>Resumes from the last acknowledged chunk
  </li>
</ol>
```

Settings or facts as hairline rows:

```html
<ul class="ace-rows">
  <li>
    <div class="ace-row between">
      <span>Default provider</span><span class="ace-muted">Claude Code</span>
    </div>
  </li>
  <li>
    <div class="ace-row between">
      <span>Use a worktree</span><span class="ace-badge success dot">On</span>
    </div>
  </li>
</ul>
```

Two columns that stack on a phone:

```html
<div class="ace-split" style="--side: 1fr">
  <section>
    <h3>Today</h3>
    …
  </section>
  <section>
    <h3>Proposed</h3>
    …
  </section>
</div>
```

### Theme variables

The app theme arrives as CSS variables and updates live when the person changes theme or light/dark mode. Use `var(--…)` instead of fixed colours, so the page reads in both modes.

- **Surfaces and text:** `--background`, `--foreground`, `--muted-foreground`, `--subtle-foreground`, `--card`, `--surface-2`, `--hover`, `--border`, `--input` (control edges), `--field`.
- **Emphasis:** `--accent` (the person's accent colour), `--accent-foreground` (text on it), `--accent-text` (accent-coloured text), `--primary`, `--primary-foreground`.
- **Status:** `--success`, `--warning`, `--info`, `--destructive`.
- **Data series:** `--chart-1` to `--chart-6`.
- **Shape and type:** `--radius`, `--font-sans`, `--font-mono`.

Leave the page background transparent.

## Mockups

A mockup shows a UI proposal, so it must look like ace and work at every width.

- **Frame it.** Put the UI in `<div class="ace-frame" style="--h: 520px">` (or `ace-frame phone` for iPhone). The frame has a fixed height, clips what overflows, and is the anchor for overlays: sheets, menus and dialogs inside it use `position: absolute`.
- **Lay out inside the frame** with flex: a `<header>` and `<footer>` keep their height, the body is `ace-scroll` so long content scrolls inside the frame instead of being cut off.
- **Collapse inside the frame.** The frame is a size container, so `@container (max-width: 520px) { … }` rules apply to what's inside it. Hide or narrow a sidebar there; never let a 220 px sidebar squeeze the content to 100 px.
- **Use ace's real measurements:** 13 px controls and list text, 14 px titles, 12 px metadata; 30 px controls, 32–36 px rows; 8 px radius on rows and buttons, 12 px on cards and dialogs, 18 px on the composer; hairline `--border` edges; status colours only for status; send and stop buttons round.
- **Icons:** small line icons drawn as inline SVG, `stroke="currentColor"`, 1.5 px stroke, 16 px beside 13–14 px text. Never emoji, never filled clip-art.
- **Build rows from classed buttons** (`<button class="nav-item">`): they start as plain boxes, so your flex layout and left alignment apply as written.
- **Show states with tabs, not side by side.** If the proposal has states (waiting, answered, error) or options (A, B, C), put a tab bar above the frame and switch what the frame shows. Under each option, one muted line says what it is.
- **Make it clickable** where the interaction is the point (`mode: "interactive"`); keep the script small.

## Charts

- **Pick the chart by the question:** bars for comparing categories (sorted, unless the order means something), a line for change over time, a scatter for a relationship. Stack only when the total matters. No pie or donut beyond three parts, no 3D, no dual axes.
- **Build it** as inline SVG, or as HTML for simple bar lists (`ace-bar` rows with the value as text). Give the SVG a viewBox about as wide as it shows (360–600 units) and let it scale; or measure the container and draw a `<canvas>` at `devicePixelRatio`.
- **Style:** axis and tick labels 12 px in `--muted-foreground`; gridlines `--border`, horizontal only; series `--chart-1`, `--chart-2`, …; highlight the one series that matters and mute the rest. Bars start at zero. Label values directly; a legend only when there are more than three series.
- **Headline:** state the finding above the chart ("Cold starts fell 41% after caching"), not "Chart of cold starts".
- **Theme:** in SVG set `fill`/`stroke` to `var(--chart-1)`, `currentColor` and so on. A `<canvas>` reads the variables with `getComputedStyle(document.documentElement)` and redraws on the `ace:theme` window event and when its width changes (`ResizeObserver`).
- **Give the numbers as text too:** a table under the chart, or values on the marks, so nothing is only colour or position.

## Interactive or static

Choose a `mode` for every page:

- **`interactive`** when the reader manipulates it: sliders, step-throughs, quizzes, simulations, sortable or filterable tables, clickable mockups.
- **`static`** for read-only explanations, charts and diagrams. Scripts and event handlers are removed; draw it with HTML, CSS and inline SVG. Choose static even when a script would only draw something once: render the result as markup instead.

If you leave `mode` out, a page with no script is static and one with a script is interactive.

For interactive pages:

- Put each control right next to what it changes; update immediately on `input`, not on a separate Apply.
- Use real `<button>`, `<input type="range">` and `<label>` elements; support the keyboard; keep focus outlines; announce changing results with `aria-live="polite"`.
- Keep state in variables and render the page from that state: the page can be unloaded when it's scrolled far away and rebuilt when it returns.

## Check, then publish

Run `html_preview` with the page. Look at both screenshots and read the report. Fix and preview again until all of these hold:

- Nothing is cut off at the right edge or the bottom at 360 px, and nothing scrolls sideways except an `ace-scroll-x`.
- All text is readable at 360 px (the report lists anything under 11 px).
- Columns collapse on the phone; no column is squeezed to a sliver.
- The takeaway is the first thing you read; the accent marks one thing.
- It reads in dark mode (pass `scheme: "light"` to check light too).
- Every control does something visible right away, next to the control.
- Nothing decorative: no gradients, glows, shadows on content, emoji or filler text.

If `html_preview` isn't available, check your code against [Layout that holds at every width](#layout-that-holds-at-every-width) at 360 px before publishing.

### What publishing refuses

`html_render` checks the page before publishing. If it returns `invalid_html`, nothing was published; fix every problem in `issues` and call it again. It refuses:

- **Unsafe content:** frames, forms, plugins, `<link>`, base URLs, `http-equiv` metadata, and any external URL in markup or CSS (see [The sandbox](#the-sandbox)).
- **`viewport-height`, `root-height`:** viewport units, or `height: 100%` on `html`/`body`.
- **`fixed-position`:** `position: fixed`.
- **`fixed-width`:** a fixed `width` over 360 px outside an `ace-scroll-x` and outside a `@media (min-width: …)` block.
- **`text-too-small`:** a font size under 10 px.
- **`svg-text-too-small`:** an SVG whose smallest label would render under 9 px at 360 px wide.

## Images: base64 only

To show an image (a screenshot, a plot, a photo) inside a page, encode it as base64 and put it in the page as a `data:` URL. The page has no file access and no network, so anything else renders as a broken image.

- Right: `<img src="data:image/png;base64,iVBORw0KGgo…" alt="What it shows">` (`image/jpeg`, `image/gif` or `image/webp` for those formats).
- Wrong: a file path, `file://`, or `https://` URL in `src`, `href`, CSS `url(…)`, `<source>`, `<image href>` in SVG or `<link rel="icon">`.
- Get the string with `base64 -i shot.png` on macOS or `base64 -w0 shot.png` on Linux.
- Images count toward the 16 MiB page cap, and base64 is a third larger than the file. Downscale first, for example `sips -Z 1600 -s format jpeg shot.png --out shot.jpg` on macOS.
- To show an image on its own, with no page around it, use `image_show` (see [Posting an image](#posting-an-image)).

## The sandbox

The page runs in an opaque-origin sandbox. It cannot read the app, its storage, cookies, the daemon token or the parent page. A static page also runs no authored script.

- **No network.** `fetch`, XHR, WebSocket, beacons, external images, fonts, scripts and stylesheets are refused. Put every library, data set and asset inside the document; keep the whole page at or below 16 MiB of UTF-8.
- **No navigation.** Links to other pages, forms, pop-ups, downloads and dialogs (`alert`, `confirm`) do nothing. Use in-page state for steps and tabs; `#fragment` links work.
- **No `eval`.** `new Function` and string timers are blocked too.
- **No storage.** `localStorage`, cookies and IndexedDB are unavailable; keep state in variables.
- **Inserting HTML.** `innerHTML` works, but `<link>`, `<meta>`, `<base>` and frame elements are dropped from it, and `document.createElement` refuses them.

The reader can view the page full screen in the side panel, copy its source or download it.

## Posting an image

For real pixels, such as a screenshot you took, a plot a script rendered or a generated picture, call `image_show` (`mcp__ace__image_show` in Claude Code, `ace_image_show` in OpenCode and Pi) instead of building a page. Anything you would draw with HTML or SVG still belongs in `html_render`.

- Pass the image as base64 in `data`: the raw base64 of a PNG, JPEG, WebP or GIF, with no `data:image/...;base64,` prefix, up to 16 MiB of image.
- Only for an image over 16 MiB, pass `path` instead (up to 128 MiB, relative to your working directory or absolute). The file itself must not be a symbolic link.
- `alt` says what the image shows. `caption` is an optional short line shown under it.
- `invalid_image` means the bytes are not one of those formats, so nothing was posted. Convert the image to PNG and call `image_show` again.
