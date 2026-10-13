---
name: visualize
description: Show an interactive or static HTML page inline in ace chat when seeing or trying something explains it better than prose. Use for explanations and step-throughs, interactive learning (sliders, quizzes, simulations, small games), comparisons, diagrams, UI mockups, and charts.
---

# Visualize in ace chat

`ace_html_render` puts a self-contained HTML page inline in your reply. It renders at the full width of the message column, on the chat's own background, and grows to fit its content. In `interactive` mode its scripts run; in `static` mode they are stripped.

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

1. Write one complete HTML document with inline `<style>`, plus inline `<script>` for an interactive page. Keep it at or below 256 KiB of UTF-8. Draw with HTML, inline SVG or `<canvas>`. Embed raster images as base64 `data:` PNG, JPEG, GIF or WebP.
2. Call `ace_html_preview` with `{ html }`. Claude Code exposes it as `mcp__ace__ace_html_preview`; Codex uses the ace MCP server's tool name. Fix every diagnostic until `valid` is true.
3. Call `ace_html_render` with `{ title, html, mode, height? }`. The title is short and descriptive. `height` is an optional maximum (80–2000 CSS px); a taller page scrolls inside it.
4. In the reply, say only what the page doesn't already show.

## The sandbox

Both modes use the same sandbox; a static page also runs no authored script. The page runs in an opaque-origin sandbox. It cannot read the app, its storage, cookies, the daemon token or the parent page.

- **No network.** `fetch`, XHR, WebSocket, beacons, external images, fonts, scripts, stylesheets, `<link>` elements and frames are refused. Put every library, data set and asset inside the document.
- **No navigation.** Links to other pages, forms, pop-ups, downloads and dialogs (`alert`, `confirm`) do nothing. Use in-page state for steps and tabs.
- **No `eval`.** `new Function` and string timers are blocked too.
- **Storage.** `localStorage`, cookies and IndexedDB are unavailable; keep state in variables.
- **Inserting HTML.** `innerHTML` works, but `<link>`, `<meta>`, `<base>` and frame elements are dropped from it. `document.createElement` refuses those elements.

The page can be unloaded while it is scrolled far out of view and rebuilt when it returns. An interactive page loses its in-memory state then, so derive what it shows from its own state.

## Look like ace

Every page receives the app theme as CSS variables. They update live when the person changes theme or light/dark mode:

- **Surfaces and text:** `--background`, `--foreground`, `--muted`, `--muted-foreground`, `--card`, `--card-foreground`, `--border`.
- **Emphasis:** `--primary`, `--primary-foreground`, `--accent`, `--accent-foreground`.
- **Status:** `--success`, `--warning`, `--info`, `--destructive`.
- **Data series:** `--chart-1` to `--chart-6`.
- **Shape and type:** `--radius`, `--font-sans`, `--font-mono`.

Style with `var(--…)` instead of fixed colours. A `<canvas>` reads the variables with `getComputedStyle(document.documentElement)` and redraws on the `ace:theme` window event.

Leave the page background transparent and don't wrap the whole page in a card or add a title bar; it sits in the conversation like a message. Give individual panels padding and `--border` outlines where structure needs them. Match the chat's density, around 13–14px body text.

## Layout and access

- **Fluid width.** Use fluid widths that work from 360 px to about 760 px.
- **Height.** Let content set the height. Avoid `100vh` and percentage heights on `html`/`body`; they create resize loops.
- **Controls.** Use real `<button>`, `<input type="range">` and `<label>` elements. Support the keyboard and keep focus outlines visible.
- **Readable values.** Give essential values as text or a table, not only as colour or position. Add labels or patterns when colour separates categories.
- **Motion.** Honour `prefers-reduced-motion`.

The reader can open the page in a window, view it full screen, copy its source or download it.
