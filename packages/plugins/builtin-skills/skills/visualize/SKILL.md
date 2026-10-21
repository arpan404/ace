---
name: visualize
description: Show an interactive or static HTML page inline in ace chat when seeing or trying something explains better than prose, such as explainers, quizzes, simulations, comparisons, diagrams, mockups and charts.
---

# Visualize in ace chat

`html_render` puts a self-contained HTML page inline in your reply. It renders at the full width of the message column, on the chat's own background, and grows to fit its content. In `interactive` mode its scripts run; in `static` mode they are stripped.

## When to use it

Use a page when the reader learns faster by seeing or doing:

- **Explaining a concept:** an explainer with a slider that changes a parameter and shows the effect, or a step-through ("Next" walks through an algorithm one state at a time).
- **Interactive learning:** a quiz with feedback, a small simulation, a sandbox to try inputs, or a tiny game that teaches a rule.
- **Comparing options:** tabs or toggles between approaches, or a side-by-side table that can be sorted or filtered.
- **Structure:** diagrams, flows, timelines and architecture sketches.
- **Mockups:** a clickable sketch of a UI under discussion.
- **Data:** charts with hover detail or a control for the range.

## Interactive or static

Choose a `mode` for every page:

- **`interactive`** when the reader manipulates it: sliders, step-throughs, quizzes, simulations, sandboxes, sortable or filterable tables, clickable mockups.
- **`static`** for read-only explanations, charts and diagrams. Scripts and event handlers are removed. A static page is lighter, and it loses nothing when it is unloaded offscreen. Draw it with HTML, CSS and inline SVG.

If you leave `mode` out, a page with no script is static and a page with a script is interactive. Choose static even when a script only draws something once; render the result as markup instead.

Use prose for a single fact, a one-step action, or a short list that is already clear. Use one page per idea, not a page for every reply.

## How

1. Write one complete HTML document with inline `<style>`, plus inline `<script>` for an interactive page. Keep it at or below 16 MiB of UTF-8. Draw with HTML, inline SVG or `<canvas>`. Embed every image as base64 (see [Images: base64 only](#images-base64-only)).
2. Call `html_render` with `{ title, html, mode, height? }`. Claude Code exposes it as `mcp__ace__html_render`, OpenCode and Pi as `ace_html_render`. The title is short and descriptive. `height` is an optional maximum (80–2000 CSS px); a taller page scrolls inside it.
3. If it returns `invalid_html`, nothing was published: fix every problem listed in `issues` and call it again.
4. In the reply, say only what the page doesn't already show.

## Images: base64 only

To show an image (a screenshot, a plot, a photo, a generated picture) inside a page, encode it as base64 and put it in the page as a `data:` URL. The page has no file access and no network, so anything else renders as a broken image.

- Wrong: `<img src="/tmp/shot.png">`, `<img src="shot.png">`, `<img src="file:///…">`, `<img src="https://…">`. The same goes for CSS `url(…)`, `<source>`, `<image href>` in SVG and `<link rel="icon">`.
- Right: `<img src="data:image/png;base64,iVBORw0KGgo…" alt="What it shows">`. Use `image/jpeg`, `image/gif` or `image/webp` in the prefix for those formats.
- Get the string with `base64 -i shot.png` on macOS or `base64 -w0 shot.png` on Linux, and paste it after the `data:image/png;base64,` prefix.
- Images count toward the 16 MiB page cap, and base64 is a third larger than the file. Downscale a large image before encoding it, for example `sips -Z 1600 -s format jpeg shot.png --out shot.jpg` on macOS.
- To show an image on its own, with no page around it, use `image_show` instead (see [Posting an image](#posting-an-image)).

## The sandbox

Both modes use the same sandbox; a static page also runs no authored script. The page runs in an opaque-origin sandbox. It cannot read the app, its storage, cookies, the daemon token or the parent page.

- **No network.** `fetch`, XHR, WebSocket, beacons, external images, fonts, scripts, stylesheets, `<link>` elements and frames are refused. Put every library, data set and asset inside the document.
- **No navigation.** Links to other pages, forms, pop-ups, downloads and dialogs (`alert`, `confirm`) do nothing. Use in-page state for steps and tabs.
- **No `eval`.** `new Function` and string timers are blocked too.
- **Storage.** `localStorage`, cookies and IndexedDB are unavailable; keep state in variables.
- **Inserting HTML.** `innerHTML` works, but `<link>`, `<meta>`, `<base>` and frame elements are dropped from it. `document.createElement` refuses those elements.

The page can be unloaded while it is scrolled far out of view and rebuilt when it returns. An interactive page loses its in-memory state then, so derive what it shows from its own state.

## Look like ace

Every page starts with ace's own style kit, so plain markup already looks like the app: write semantic HTML first and add your own CSS only where the kit doesn't cover it. Headings, paragraphs, lists, links, `code`/`pre`/`kbd`, `<button>`, text inputs, `<select>`, `<textarea>`, checkboxes, `<input type="range">`, `<progress>`, `<meter>`, `<table>` and `<details>` are styled with the app's type, hairlines, corners and accent. Your own CSS always wins over the kit; it never needs `!important` or extra specificity.

Classes for what pages often need:

| Class                                                                 | What it is                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `card` (`card raised`, `card plain`)                                  | A bordered panel for one group of content.                      |
| `stack` (`tight`, `loose`), `row` (`between`, `end`)                  | Vertical and wrapping horizontal layouts with gaps.             |
| `grid` (`grid two`)                                                   | Responsive columns; set `--min` on it for the narrowest column. |
| `stat` with `.label`, `.value`, `.delta`                              | A metric tile. `up` / `down` colour a change.                   |
| `badge` (`success`, `warning`, `danger`, `info`, `accent`, `dot`)     | A small status pill.                                            |
| `callout` (`info`, `success`, `warning`, `danger`)                    | A tinted note.                                                  |
| `tabs` with `<button aria-selected="true">` (or any `role="tablist"`) | A segmented control; your script moves `aria-selected`.         |
| `button.primary`, `button.ghost`, `button.small`, `button.icon`       | Button variants; a plain `<button>` is the secondary style.     |
| `bar` with a `<span>` and `--value: 40%`                              | A thin horizontal bar; `--c` sets its colour.                   |
| `muted`, `subtle`, `mono`, `num`, `eyebrow`, `lead`, `swatch` (`--c`) | Text tiers and helpers.                                         |

The app theme arrives as CSS variables and updates live when the person changes theme or light/dark mode:

- **Surfaces and text:** `--background`, `--foreground`, `--muted-foreground`, `--subtle-foreground`, `--card`, `--surface-2`, `--hover`, `--border`, `--input` (control edges), `--field`.
- **Emphasis:** `--accent` (the person's accent colour), `--accent-foreground` (text on it), `--accent-text` (accent-coloured text), `--primary`, `--primary-foreground`.
- **Status:** `--success`, `--warning`, `--info`, `--destructive`.
- **Data series:** `--chart-1` to `--chart-6`.
- **Shape and type:** `--radius`, `--font-sans`, `--font-mono`.

Use `var(--…)` instead of fixed colours. A `<canvas>` reads the variables with `getComputedStyle(document.documentElement)` and redraws on the `ace:theme` window event. In SVG, set `fill`/`stroke` to `var(--chart-1)`, `currentColor` and so on.

Make it feel like part of ace, not a web page dropped into the chat:

- Leave the page background transparent. Don't wrap the whole page in a card, add a page title bar or repeat the `title` as a big heading; it sits in the conversation like a message.
- Use one accent. Colour means state or data series, never decoration: no gradients, glows or emoji headings.
- Match the chat's density: 13–14px text, 8–16px gaps, hairline borders. Separate with hairlines and space before adding boxes.
- Prefer a few well-made controls over many; put the thing that changes right next to the control that changes it.

## Before you publish

Check the page against this list; fix anything that fails:

- It answers the question better than prose would, with one clear idea.
- It is mostly the style kit's markup and classes; your own CSS is short.
- Every control does something visible right away, and its result sits beside it.
- Nothing decorative: no gradients, glows, shadows on content, emoji, stock icons or filler text.
- It reads in light and dark, at 360 px and at 1200 px.
- Every image is a base64 `data:` URL: no `src`, `href` or CSS `url(…)` points at a file path or a web address.

## Layout and access

- **Responsive.** The same page shows inline (about 360–760 px wide, phone to desktop) and full screen in the side panel (up to about 1200 px). Build with `grid`/`row`, `minmax()` and `clamp()`, never fixed pixel widths; let multi-column layouts collapse to one column below about 520 px, and cap prose at about 70 characters. No horizontal scrolling except inside a wide table or code block.
- **Height.** Let content set the height. Avoid `100vh` and percentage heights on `html`/`body`; they create resize loops.
- **Controls.** Use real `<button>`, `<input type="range">` and `<label>` elements. Support the keyboard and keep focus outlines visible.
- **Readable values.** Give essential values as text or a table, not only as colour or position. Add labels or patterns when colour separates categories.
- **Motion.** Honour `prefers-reduced-motion`.

The reader can view the page full screen (it opens at full size in the side panel), copy its source or download it. A page in the side panel fills the panel's height, so let it scroll naturally rather than fixing its height.

## Posting an image

For real pixels, such as a screenshot you took, a plot a script rendered or a generated picture, call `image_show` (`mcp__ace__image_show` in Claude Code, `ace_image_show` in OpenCode and Pi) instead of building a page. Anything you would draw with HTML or SVG still belongs in `html_render`.

- Pass the image as base64 in `data`: the raw base64 of a PNG, JPEG, WebP or GIF, with no `data:image/...;base64,` prefix, up to 16 MiB of image. For example, `base64 -i shot.png` on macOS or `base64 -w0 shot.png` on Linux gives you the string.
- Only for an image over 16 MiB, pass `path` instead (up to 128 MiB, relative to your working directory or absolute). The file itself must not be a symbolic link.
- `alt` says what the image shows. `caption` is an optional short line shown under it.
- `invalid_image` means the bytes are not one of those formats, so nothing was posted. Convert the image to PNG and call `image_show` again.
