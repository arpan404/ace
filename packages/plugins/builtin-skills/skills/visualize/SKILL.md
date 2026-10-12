---
name: visualize
description: Create charts, diagrams, comparisons, simulations or mockups in ace chat when a visual explains more than prose. Use for requested visualizations and interactive explanations.
---

# Visualize in ace chat

1. Decide whether a visual helps the reader. Use prose for a single fact, a one-step action or a short list that is already clear.
2. Write one self-contained HTML document with inline CSS and JavaScript. Keep the UTF-8 document at or below 256 KiB. Draw with HTML, SVG or canvas; embed raster assets as base64 PNG, JPEG, GIF or WebP data images.
3. Call `ace_html_preview` with `{ html }`. Claude Code exposes it as `mcp__ace__ace_html_preview`; Codex uses the ace MCP server's tool name. This validates size and unsupported features without executing or publishing the page. Fix every diagnostic until `valid` is true.
4. Call `ace_html_render` with `{ title, html, height? }`. Use a short descriptive title. Height is an optional initial cap of 80–2000 CSS pixels; the frame fits shorter content and scrolls longer pages.
5. The visual appears above your next reply and survives reload. Keep the reply focused on information the visual does not already communicate.

The page runs in an opaque-origin sandbox. Inline scripts can implement local interaction, but external requests, imports, frames, forms, workers, popups and navigation are blocked. Bundle libraries inline. Keep all data in the document. Build dynamic UI with `createElement`, `textContent`, event listeners and DOM properties; HTML injection sinks such as `innerHTML` and `document.write` are blocked by Trusted Types. WebRTC is unavailable. The page cannot read the app, its cookies, the daemon token or the parent DOM. Send HTML through these tools; HTML in a normal message stays text.

Use fluid widths that work around 360 px and 728 px. Let content determine height; avoid `100vh` or percentage document heights that can create resize loops. The reader can expand, fullscreen, open a sandboxed window, copy or download the page.

Use the passed CSS variables for light and dark themes: `--background`, `--foreground`, `--muted-foreground`, `--card`, `--border`, `--primary`, `--primary-foreground`, `--accent`, `--chart-1` through `--chart-6`, `--radius`, `--font-sans`, and `--font-mono`. Leave the outer background transparent. Match the chat's density; give individual panels padding, without wrapping the entire visual in a decorative card.

Label controls and charts, support keyboard interaction, and provide readable text or a table for essential chart values. Use colours with readable contrast in both themes, and add labels or patterns when colour distinguishes categories. Honour reduced motion. Keep focus indicators visible.
