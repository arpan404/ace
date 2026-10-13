# 0077: Interactive chat visualizations

Date: 2026-10-13. Status: accepted. Supersedes the static-only decision in commit e6a090b53.

## Context

`ace_html_render` publishes an agent-written HTML page into the transcript. Commit e6a090b53
stripped every authored script and event handler, because Blink dispatches `preconnect` and
`dns-prefetch` hints without a CSP check. A script that creates `<link rel=preconnect>` could
therefore reach the network from a page whose CSP said `connect-src 'none'`. The result was a
"Static view": charts only, inside a titled card with a button row.

The owner's direction is that visualize is not only for charts. It is dynamic UI inside the
conversation, closer to T3 Code's inline HTML and ChatGPT's interactive learning pages: full
message width, height that fits the content, the app's live theme, and working sliders, tabs,
step-throughs, quizzes and small simulations. Actions are hover-only. Scripts must run, and
must not reach the network or the app.

## Decision

Scripts run. The isolation is layered, and its boundary differs by client.

1. **Same document on every path.** An opaque-origin `sandbox="allow-scripts"` page (never
   `allow-same-origin`, popups, top navigation, modals, forms or downloads) sits inside a
   trusted outer document whose `frame-src 'none'` stops the page navigating its frame. The
   page CSP is `default-src 'none'` with inline script and style only. `data:`/`blob:` cover
   images, fonts and media, and `connect-src`, `frame-src`, `worker-src`, `form-action`,
   `base-uri` and `object-src` are `'none'`. `eval` is unavailable, and Trusted Types are
   limited to the bridge's policies. Only height crosses out and only theme crosses in.
2. **Page bridge.** It runs before authored code and closes what CSP does not govern. It
   removes WebRTC and XSLT. Element creation (including customized built-ins) refuses `<link>`,
   `<meta>`, `<base>` and frames; a frame would hand back an unguarded realm. A Trusted Types
   default policy drops those elements from every HTML string sink.
3. **Desktop network layer.** Visualizations are `<webview>` guests in a dedicated in-memory
   session. Its `webRequest` cancels everything except the page's own `data:`/`blob:`/`about:`
   documents, its proxy is unreachable (loopback included), and its permissions and downloads
   are refused. Chromium runs with `dnsPrefetchingEnabled=false`, since a DNS-only hint goes
   straight to the host resolver. `will-attach-webview` admits only that partition with a
   `data:` document and forced sandboxed, Node-free preferences. "Open in window" uses the same
   session through the main process.
4. **Web client.** Scripts run with layers 1–2 only. There is no browser API to put a page's
   network hints behind a deny policy, and ace is never hosted behind a proxy it controls. The
   residual risk is documented rather than hidden:
   - an unknown hint path or browser bug;
   - browsers without Trusted Types;
   - exported files, which run outside any ace session.

   The worst case is a DNS-encoded hostname revealing that a page was viewed, or what the person
   typed into that page. A page can never read the app, its storage or the daemon token. The
   agent that wrote the page already has network access on the daemon's machine.

5. **Resource limits.** A page stays loaded only near the viewport, with at most four live
   pages per transcript (most recently revealed first). The rest keep their height and reload
   when they return.

6. **Agent-chosen mode.** The owner's decision is "interactive and static, the agent will
   decide". `ace_html_render` takes `mode: "interactive" | "static"`, which the agent picks for each
   page. An omitted mode is `static` when the page has no script element or inline handler, and
   `interactive` otherwise. The daemon stores the resolved mode on the item, so it survives reload
   and reaches every client.
   - **Static.** Authored scripts and handlers are stripped, and the page's CSP admits only the
     bridge by hash. It renders as a plain themed page.
   - **Interactive.** Scripts run under layers 1–4.

   Desktop and web honour the agent's choice alike. On the web client an interactive page runs
   with layers 1–2 only. By letting agents choose interactive there, the owner accepted the
   residual DNS-hint risk in layer 4. The UI shows no mode label.

## Consequences

- **Rendering.** The visualize skill and the MCP tool descriptions now steer agents toward
  interactive pages that use the theme variables and need no network. The `static-view`
  diagnostic and the "Static view" label are gone. The packaged renderer CSP no longer
  carries visualization script hashes or `data:` frames.
- **Proof.** Desktop isolation is proven with real Electron and NetLog in
  `apps/desktop/src/main/visualization-isolation.process.test.ts`. A leaking page with no
  in-page defences produces no request, socket or resolver lookup inside the session, the same
  page outside it does, and the visualization's own slider still works.
- **Web guard tests.** `tools/web-e2e/e2e/fake/html-network-hints.spec.ts` checks that the page
  bridge keeps every known hint element out of the page. Playwright's Chromium resolves no
  DNS-only hints even for an unguarded control. That test therefore asserts on the DOM for those
  hints and on NetLog for fetch-backed ones.
- **Webviews.** Enabling `webviewTag` widens the app window's surface. The attach gate is the
  only way in; a renderer compromise could create a visualization guest, but only a locked one.
- **Lost state.** An unloaded page loses its in-memory state when it scrolls far away. Pages
  derive what they show from their own state, as the skill tells authors.

See [HTML visualizations in chat](../daemon/html-visualizations.md) for the full mechanics.
