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
and external resource declarations. Diagnostics are authoring guidance. Every display path removes authored
executable content; CSP limits the trusted resize bridge and resource loading.

The web renderer is lazy-loaded only for a canonical HTML item. Its outer frame
loads a data document with an opaque origin and `sandbox="allow-scripts"`. The
trusted outer document has `frame-src 'none'` and holds the authored page in a
second sandboxed `srcdoc` frame. This prevents the inner page navigating its own
frame to an external address. Both documents deny external resources, fetch,
WebSocket, workers, forms and plugins through CSP. Each head starts with a DNS
prefetch opt-out meta element before any author content. No frame has same-origin,
popup, top-navigation, storage-access or download permissions.

Authored scripts and event handlers are removed on every render and export path.
The guest CSP permits only the hash of the fixed resize bridge. Every client gets
a static view, including browsers with Trusted Types. The preview's `static-view`
diagnostic tells authors to replace script-driven content with HTML or SVG.

This fallback is necessary because Blink's `DnsPrefetchIfNeeded` checks its frame
settings instead of `document.IsDNSPrefetchEnabled()`. Its `PreconnectIfNeeded`
also dispatches to the network-hints interface without a document opt-out or CSP
check. Setting `x-dns-prefetch-control=off` changes the document flag and latches it
off, but does not block those explicit link-loader paths. Preload, prefetch and
modulepreload use the resource fetch machinery and its CSP checks. Static link
markup is rejected by validation, and inactive authored code cannot create any
of these hints at runtime. Electron sets `blink-settings=dnsPrefetchingEnabled=false` before Chromium
starts as defense in depth; this setting is not relied on for preconnect isolation.

Scripted visuals can return only when a browser-owned network-hint deny policy is
available and verified. Source inspection used Chromium's
[preload helper](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/loader/preload_helper.cc),
[HTTP-equivalent metadata handling](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/loader/http_equiv.cc),
[document DNS control](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/dom/document.cc),
and [command-line Blink settings](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/exported/web_view_impl.cc).

Height messages contain exactly `{ type: "ace.html.height", height }`. Both
bridges validate the sending window, opaque origin, finite number and bounds.
No other child message becomes an app action. Frame height is capped, changes
are coalesced by animation frame, and the virtualizer measures the resulting row.
Theme CSS tokens follow the app theme. The static document is rebuilt when the
theme changes or virtualization remounts the row. Published document bytes remain
durable.

The title and compact action row follow the existing chat density tokens. Expand,
fullscreen, new window, copy and download are user actions. New windows and
exports contain the same sandbox wrapper. Desktop viewer windows have no Node
integration or preload bridge. An exported file can be viewed offline; it does
not receive subsequent theme changes.

DNS-level regression coverage reads Chromium NetLog host-resolver events for
published and exported pages, with an unprotected DNS/preconnect hint as a positive
control. Other behavior guards cover inactive authored scripts and event handlers,
resource requests, frame navigation, parent data, popups, forged resize messages,
normal-message text, and daemon restart/replay. They were
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

The skill teaches when a visual is useful, self-contained assets, accessible
colour and semantic HTML, fluid widths, theme tokens, preview before render,
and concise prose after publication. Native provider skill discovery sees it as
part of the `ace-builtins` plugin.
