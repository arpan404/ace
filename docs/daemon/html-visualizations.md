# HTML visualizations in chat

Agents use `ace_html_preview({ html })` to validate a page, then
`ace_html_render({ title, html, height? })` to publish it inline in their reply.
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

A visualization is a page, not a picture: explainers, step-throughs, quizzes, simulations,
comparisons, diagrams, mockups and charts. Authored scripts run. The decision and its proof
are in [ADR 0077](../adr/0077-interactive-visualizations.md).

`@ace/html` owns the pure validator, the document builder and the two fixed bridge scripts
(`@ace/html/scripts`). The validator parses with parse5 and rejects authored frames, forms,
plugins, `<link>`, base URLs, HTTP-equivalent metadata and every external URL in markup or
CSS. Every display path wraps the page the same way:

- **Outer document.** A trusted document with `frame-src 'none'` holds the page in a
  `sandbox="allow-scripts"` `srcdoc` frame, so the page cannot navigate its frame elsewhere.
  Its bridge relays only height out and theme in.
- **Page.** It gets an opaque origin: no `allow-same-origin`, popups, top navigation, modals,
  forms, downloads or storage access. Its CSP is `default-src 'none'`, with inline scripts and
  styles only; `data:`/`blob:` for images, fonts and media; `connect-src`, `frame-src`,
  `worker-src`, `form-action`, `base-uri` and `object-src` all `'none'`; no `eval`; and Trusted
  Types with only the bridge's two policies. A DNS-prefetch opt-out meta element comes first in
  each head.
- **Page bridge.** It runs before any authored script and locks what CSP does not govern. It
  removes WebRTC and `XSLTProcessor`. `createElement`, `createElementNS` and customized
  built-ins refuse `link`, `meta`, `base` and every frame element; a frame would hand back a
  fresh realm with unguarded constructors. The Trusted Types default policy drops those
  elements from every HTML string sink (`innerHTML`, `insertAdjacentHTML`, `DOMParser`,
  `document.write`).

### Desktop: a locked session

Blink's `PreconnectIfNeeded` and `DnsPrefetchIfNeeded` dispatch network hints without a CSP
check, so CSP alone cannot keep a scripted page off the network. In the desktop app a
visualization is therefore a `<webview>` in its own in-memory session, `ace-visualization`.
`apps/desktop/src/main/visualization-isolation.ts` locks that session:

- `webRequest.onBeforeRequest` cancels everything except `data:`, `blob:`, `about:blank` and
  `about:srcdoc`. That covers fetch, XHR, images, CSS, prefetch, preload, beacons, pings and
  WebSocket.
- The session proxy is an unreachable `http://0.0.0.0:0` with `<-loopback>`, so a request
  that reached the network stack without passing `webRequest` (a preconnect) could not
  resolve or connect anywhere, loopback included.
- Every permission request and check is refused, downloads are cancelled and the spellchecker
  is off.
- Chromium starts with `blink-settings=dnsPrefetchingEnabled=false`. A DNS-only hint goes
  straight to the host resolver and never meets `webRequest` or the proxy; this frame setting
  is what `DnsPrefetchIfNeeded` reads.

The app window enables `webviewTag`, but `will-attach-webview` refuses any guest that is not in
that partition or does not load a `data:text/html` document. It strips any preload and forces
sandboxed, context-isolated, Node-free preferences with dialogs disabled. Each guest denies
window opening, every navigation and redirect, and any subframe navigation other than
`about:srcdoc`. A webview has no preload, so the outer document reports height through its own
title (`ace.html.height:N`), which the authored page cannot set. The renderer sends theme
updates with `executeJavaScript` as a message from the outer document's own window.

"Open in window" asks the main process (`visualization.open`) for a plain window in the same
session with the same guards. The renderer's packaged CSP no longer allows any `data:` frame or
visualization script hashes: nothing of the visualization runs under the app's policy.

`visualization-isolation.process.test.ts` proves this with real Electron and a real resolver.
The test renders two pages under the packaged renderer CSP. The first is the real
visualization document. The second is the same leaking page with none of the in-page defences.
Both try preconnect and dns-prefetch hints (to a counting local server and to unresolvable
names), prefetch, preload, `insertAdjacentHTML` links, fetch, an external image, a WebSocket and
`sendBeacon`. Neither produces a request, a socket connection or a NetLog resolver lookup. The
first page's inline slider handler runs and its height crosses out. A control run of the same
page in the default session without the isolation reaches the server and the resolver, and
disabling the session guards makes the test fail.

### Web client: residual risk

A browser offers a page no equivalent of a session network layer, and the daemon serves the
web client from the person's own machine without a proxy. The web client still runs scripts:
it is how the owner uses visualizations away from the desktop app, and the remaining channel
is narrow. With the page bridge, a script has no known way to create a hint element in
Chromium. `html-network-hints.spec.ts` tries direct creation, namespaced creation, markup sinks,
`DOMParser`, a customized built-in and a fresh frame realm. No `<link>` ever enters the page,
and NetLog shows no lookup for the page's hosts. The control frame's fetch-backed hints are
observed. Every other channel is CSP-governed.

What remains is defence in depth, not a boundary:

- **Unknown paths.** A browser bug or an element-creation path the bridge does not know could
  still produce a hint.
- **Browsers without Trusted Types.** There, HTML string sinks are not routed through the
  sanitizing policy.
- **Exported files.** A downloaded page opened later runs with the same CSP and bridge, but
  outside any ace session.

A hint carries no request body or response. The page can read only what the agent wrote and
what the person types into it; it cannot read the app or its data. The worst case is a
DNS-encoded hostname that reveals the page was viewed (and from which network), or what the
person typed into that page. The agent that wrote the page already has its own network access
on the daemon's machine.

### Height, theme and resources

- **Height.** Height messages contain exactly `{ type: "ace.html.height", height }`. Both
  bridges validate the sending window, opaque origin, finite number and bounds. The frame
  fits the content height up to the item's `height` (default 800 px) and scrolls inside beyond
  it. Full screen fills the screen.
- **Theme.** A page receives the app theme as CSS variables (`themeProperties`): surfaces,
  text, border, primary, accent (the accent picker), status colours (`--success`, `--warning`,
  `--info`, `--destructive`), `--chart-1`…`--chart-6`, radius and fonts. When the theme or mode
  changes, the renderer posts `{ type: "ace.html.theme", tokens, scheme }`. The outer bridge
  forwards it only from its parent, and the page bridge applies the values and its
  `color-scheme`, then fires `ace:theme`. The page is not rebuilt, so its state survives.
- **Resources.** Each page runs its own scripts (a separate renderer process on desktop). A
  page stays loaded only while its row is within a viewport of the visible area, and the
  transcript keeps at most four live pages (`LiveFrames`), the most recently revealed. An
  unloaded page keeps its last height and is rebuilt when it returns. The virtualizer
  unmounts rows further away.

The item renders inline in the agent's reply at the message column's full width, on the
thread's background, with no card or title bar. Open in window, full screen, copy source (the
authored HTML) and download sit in one row that appears only on hover or focus. The fake
daemon seeds `thread-explainer`, an interactive binary search explainer, and `visualize-inline.spec.ts`
covers inline width, running scripts, fitted height, live theme and hover-only actions.

Browser rules are based on the [HTML iframe specification](https://html.spec.whatwg.org/multipage/iframe-embed-object.html),
[CSP](https://www.w3.org/TR/CSP/) and [Trusted Types](https://www.w3.org/TR/trusted-types/).
Chromium source inspection used the
[preload helper](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/loader/preload_helper.cc)
and [document DNS control](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/dom/document.cc).

## Built-in skills

`packages/plugins/builtin-skills` is ace's shipped, data-only plugin bundle. Its
manifest lists skills; it may not contain commands, rules, agents, MCP servers
or hooks. The first skill is `visualize`. Adding another skill means adding its
`SKILL.md` and manifest entry. This bundle is shipped with the application rather
than installed through third-party plugin consent.

The daemon uses the ADR 0014 plugin projector and writer for each launched
Claude Code or Codex session. Claude's SDK receives a local plugin directory.
Codex's app-server process receives session-only local marketplace/plugin
configuration arguments. Each session owns a separate ace data directory.
A private process lease records its daemon owner and each provider's PID, kernel
start identity, UID and process group. Linux uses procfs start ticks with the boot
ID; macOS uses the kernel start timeval through
[Apple's proc_bsdinfo interface](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h).
No command arguments, environment, provider input or credentials enter the lease.

Before native spawn, the lease atomically persists a pending marker. After spawn,
it records the provider identity. A crash in that gap leaves the root retained.
The shared provider-kit spawn boundary brackets launches for both Claude and
Codex, including subsequent SDK spawns. A recording failure stops the newly
spawned group; its uncertain lease remains available for inspection.

Startup captures old roots before the engine starts. Database recovery only
reconciles agent state; it does not prove OS process exit. Cleanup separately
checks the kernel identities and groups. A live owning daemon, live provider or
surviving provider group retains the projection. A closed session can release its
root only after its providers and their groups are gone. Cleanup never signals
surviving providers. UID or group changes do not turn a matching live kernel start
identity into evidence of exit.

Missing, malformed or unreadable leases, interrupted spawn recording, and
unverifiable kernel liveness retain their roots. This includes legacy projections
without process evidence. New roots created after the startup snapshot and roots
from failed recovery are retained. The plugin writer still refuses unowned
nonempty roots and symlinks, with cleanup diagnostics logged. User CLI homes and
project files are unchanged. Release packaging copies the bundle beside the
daemon's split modules.

The unrun process regression kills a simulated daemon while its detached local
Node provider survives, verifies that restart keeps the skill, then terminates the
provider and verifies reclamation. Additional guards cover pending spawn records,
missing evidence, denied inspection, failed recovery and fresh projections.

The skill teaches when a page helps (explanations, interactive learning, comparisons,
diagrams, mockups and charts) and how to write one: self-contained, theme variables, no
network, fluid width, content-driven height, accessible controls. It covers preview before
render and concise prose after publication. Native provider skill discovery sees it as part
of the `ace-builtins` plugin.
