# HTML visualizations in chat

Agents use `ace_html_preview({ html })` to validate a page, then
`ace_html_render({ title, html, height? })` to publish it above their next reply.
Preview returns size, nesting and unsupported-feature diagnostics. It does not execute
scripts or publish an item. HTML in a normal message remains text.

The document cap is 256 KiB of UTF-8, with a 160-character title and an optional
80–2000 px height cap. Only these structured tools receive a larger MCP input
budget. The HTTP and stdio request envelopes allow up to 2 MiB for JSON escaping;
other tools retain their 64 KiB argument budget.

A canonical `html` item contains title, height and an attachment reference. The
exact document bytes use the existing chunked, thread-scoped attachment store,
outside replay events and snapshots. An indexed canonical reference retains the
attachment for the life of the thread, including after daemon restart. The
attachment endpoint serves the bytes as plain text. No executable HTML endpoint,
preview-gateway link, provider credential or daemon token enters the document.
Remote and relay clients fetch through their owning connection's attachment API.

## Browser execution

`@ace/html` owns the pure validator and document builder. It parses HTML with
parse5 and rejects authored frames, forms, plugins, base URLs, refresh metadata
and external resource declarations. Diagnostics are authoring guidance. Browser
policies enforce execution restrictions even when scripts construct requests.

The web renderer is lazy-loaded only for a canonical HTML item. Its outer frame
loads a data document with an opaque origin and `sandbox="allow-scripts"`. The
trusted outer document has `frame-src 'none'` and holds the authored page in a
second sandboxed `srcdoc` frame. This prevents the inner page navigating its own
frame to an external address. Both documents deny external resources, fetch,
WebSocket, workers, forms and plugins through CSP. No frame has same-origin,
popup, top-navigation, storage-access or download permissions.

WebRTC constructors are locked off before authored scripts run. Trusted Types
with no allowed policies prevents creating another scripted `srcdoc` document
or injecting new HTML to recover those APIs. Clients without Trusted Types show
"view on desktop/web" instead of executing the page. Dynamic UI uses DOM nodes,
text and event listeners; libraries that depend on `innerHTML`, `document.write`
or runtime evaluation need an alternative implementation. The outer document
checks the same capability before activating the inner page, including exports.

Height messages contain exactly `{ type: "ace.html.height", height }`. Both
bridges validate the sending window, opaque origin, finite number and bounds.
No other child message becomes an app action. Frame height is capped, changes
are coalesced by animation frame, and the virtualizer measures the resulting row.
Theme CSS tokens follow the app theme; changing theme reloads the frame and resets
its local interactions. Scrolling a visualization out of the mounted transcript
also resets its local state. Published document bytes remain durable.

The title and compact action row follow the existing chat density tokens. Expand,
fullscreen, new window, copy and download are user actions. New windows and
exports contain the same sandbox wrapper. Desktop viewer windows have no Node
integration or preload bridge. An exported file can be viewed offline; it does
not receive subsequent theme changes.

The behavior guards cover resource requests and frame navigation, parent DOM,
cookies and local storage, popups, WebRTC availability, injected descendants,
forged resize messages, normal-message text, and daemon restart/replay. They were
written but not executed during development, per the owner's verification limit.

Browser rules are based on the [HTML iframe specification](https://html.spec.whatwg.org/multipage/iframe-embed-object.html),
[CSP](https://www.w3.org/TR/CSP/), and [Trusted Types](https://www.w3.org/TR/trusted-types/).

## Built-in skills

`packages/plugins/builtin-skills` is ace's shipped, data-only plugin bundle. Its
manifest lists skills; it may not contain commands, rules, agents, MCP servers
or hooks. The first skill is `visualize`. Adding another skill means adding its
`SKILL.md` and manifest entry. This bundle is shipped with the application rather
than installed through third-party plugin consent.

The daemon uses the ADR 0014 plugin projector and writer for each launched
Claude Code or Codex session. Claude's SDK receives a local plugin directory.
Codex's app-server process receives session-only local marketplace/plugin
configuration arguments. Each session owns a separate ace data directory and
removes it after provider exit or close. User CLI homes and project files are
unchanged. Release packaging copies the bundle beside the daemon's split modules.

The skill teaches when a visual is useful, self-contained assets, accessible
colour and keyboard controls, fluid widths, theme tokens, preview before render,
and concise prose after publication. Native provider skill discovery sees it as
part of the `ace-builtins` plugin.
