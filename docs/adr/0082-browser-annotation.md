# 0082: Browser annotation

Date: 2026-10-17. Status: accepted. Amends [ADR 0009](0009-browser-service.md),
[ADR 0055](0055-browser-backends.md) and [ADR 0069](0069-shared-native-browser.md).

Amended 2026-10-17 by [ADR 0083](0083-browser-v2-daemon-chrome.md): in the daemon's Chrome the overlay is reinstalled after a renderer crash, and annotate mode belongs to one tab's runtime.

## Context

People reviewing a page in ace's Browser want to point at things: "this heading", "this
button's padding". Typing a description of where an element is loses precision and costs a turn.
The person should be able to click elements, pin numbered comments on them, and send the agent
a message that says exactly which elements, with images, in a form the agent can act on in
source code.

The Browser has three surfaces: the desktop's native view, the JPEG screencast the web and
phone clients draw, and the headless page the daemon runs. Annotation must work on all three
without a second implementation per client.

## Decision

**The overlay lives in the page.** The daemon installs one overlay script over CDP into an
isolated world named `ace-annotate` in the top document. Because it is in the page, it draws
the hover outline, numbered markers, comment editor and floating bar in the frames every client
already receives, and input from any client (native events or `browser.input`) reaches it. Page
scripts cannot see the world's globals. The overlay is one host element on `<html>` with a
closed shadow root, put in the top layer with the Popover API when available. Every style is
adopted through CSSOM and every node is built with DOM calls, so pages with a strict CSP or
required Trusted Types still mount it. Overlay pointer events stop at its own root so page
"click outside" handlers do not see them.

The overlay source is `packages/browser-annotate/src/overlay` (DOM code, its own type-check
guard without Node types). A build step bundles it into a generated string module,
`overlay-bundle.gen.ts`. Node programs import only that string and the expression helpers in
`@ace/browser-annotate`, so they never type-check DOM sources, and the release minifier cannot
break the injected code. `bun run check:annotate` fails when the committed bundle no longer
matches its sources.

**Isolation from the page.** `Runtime.addBinding` registers `__aceAnnotateEmit` for contexts
named `ace-annotate` only (after `Runtime.enable`, which bindings need on the session). The
daemon then creates the world with `Page.createIsolatedWorld` and evaluates the bundle with
`Runtime.evaluate { contextId }`. Binding calls are accepted only from that context id and
decoded with `BrowserAnnotationEvent`; an `ended` event from the page is dropped because only
the daemon ends a session. The overlay ignores untrusted events: a page's synthetic clicks pass
through to the page and pin nothing.

**Input while annotating.** Capture-phase listeners on `window` swallow trusted pointer
activation (pointer/mouse down and up, click, double and aux click, context menu, touch start and
end, drag and select start) aimed at the page; a trusted primary click picks the element under
the point with `elementsFromPoint`. Wheel is never intercepted: inner containers and the page
scroll as usual, and a wheel over a marker scrolls what is beneath it. Keyboard, text and focus
events inside the overlay are handled by the overlay and stopped before page listeners, so page
shortcuts cannot swallow typing. Page listeners registered on `window` in the capture phase
before the overlay still run first; this is a known limit of injecting into a loaded page.

A primary press that moves 4 px or more before release is a drag instead of a click: a dashed
marquee follows it, and release makes a region annotation (below); the click that ends a drag
picks nothing. While Space is held with focus on the page (not in a page text field, not in the
overlay's editor), pointer input passes through to the page untouched: no outline, no picking,
no drag, frames take input again, and markers let clicks through. The Space key events are kept
from the page, so it neither scrolls nor activates a focused control. Releasing Space, or the
window losing focus, resumes annotating; a press that began while Space was held still delivers
its release to the page.

**Markers.** A marker sits just outside its element's top-left corner, so it never covers the
start of the element's text; an element at the very top or left of the document has no room
there and gets its marker just inside. `point` records where the person clicked, not where the
marker is drawn. The comment editor opens below the element (else above its marker, else beside
it) so live previews stay visible. Deleting an annotation closes the gap: later numbers move
down by one and each renumbered record is reported with `saved`. The client's draft keeps the
same rule, and after removing a record on its side sends `renumber` and the next number.

**Regions.** A record's `kind` is `element` (the default, so older records read unchanged) or
`region`. A region carries `region.box`, the dragged area in document CSS px, and
`region.elements`: up to eight page elements whose boxes are at least 60% inside it, outermost
first in document order; when that is a single wrapper its children are named instead. Subtrees
whose box misses the area are not walked. `element` is the smallest element containing the
whole area, for context. The region keeps a dashed outline and its marker sits on its
bottom-right corner; both are placed from document coordinates, so they follow page scrolling
but not scrolling inside inner containers. A drag thinner than 8 px picks the element where it
started. A region's crop is the area exactly, without the element margin. The style inspector
is element-only: its button is disabled for a region and says why. The agent reads a region as
`[3] Region x,y w×h containing: <button> "Get started", …` followed by its box, the element
holding it and one line per contained element with its selector.

**Style inspector and live edits.** The editor's sliders button opens an inspector for the
element: text (only for an element without child elements, so no markup is lost), colours,
opacity, font family, size and weight, border, size, and padding and margin per side. Every
change previews immediately as an inline `!important` declaration; the element's own inline
value and priority are remembered and restored exactly. Text is edited in the element's existing
text nodes, so frameworks holding those nodes keep working after a revert. Cancel rolls the
element back to how it was when the editor opened. Save puts the computed value before the
first edit and the computed value now into `styles`, and `{ before, after }` into `text`.
Previews stay on the page while annotating, are undone when their annotation is deleted or
annotate mode ends, and are reapplied by `restore`. The bar's "Hold to view original" (enabled
while any preview exists) hides every preview while the pointer is held on it.

**One-shot per document.** The overlay is installed into the current document only; there is no
script for new documents. A cross-document main-frame navigation (`Page.frameNavigated` without
a parent) ends annotate mode. Same-document navigations keep it, and markers whose elements
leave the DOM hide until the elements return.

**Ownership.** Annotate mode belongs to the person holding the page's control lease. Starting,
driving and capturing are `browser.execute` commands that need the lease (`operate` scope) and
a human actor; agents get `lease_required` and no MCP tool exists for them. One connection owns
a session: its events go only to that connection through its browser subscription. A session
ends, with an `ended` event to its owner, when:

| Reason       | Cause                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| `navigated`  | The top document navigated.                                                |
| `lease`      | The owner handed back control.                                             |
| `tab`        | The active tab changed.                                                    |
| `restart`    | The backend was lost or replaced, or the overlay could not be reinstalled. |
| `disconnect` | The owning connection went away.                                           |
| `stopped`    | The owner stopped it, the page's ✕ closed it, or the browser closed.       |

When the desktop recovers a crashed renderer (`ace.rendererRestarted`), the CDP session that
held the world and binding is gone. The daemon reinstalls the overlay on the reloaded page; it
reports `ready` again with a new `documentId`, and the client restores its markers with the
`restore` command.

**The daemon keeps no records.** Annotation records are composer draft data on the person's
device. The daemon installs the overlay, relays its events, runs page commands and captures
images. `BrowserState.annotation.owner` says a session is active; `BrowserState.features`
contains `annotate` when the daemon supports it.

**Captures.** `annotate_capture` returns an image inline (`BrowserAnnotationCapture`, base64 at
most 768 KiB, the relay's frame bound). The overlay hides the bar, editor, outline and toast and
freezes its animations for two frames; markers stay so the agent sees the numbers. A page
capture is the visual viewport as JPEG quality 80 (60 when too large), long edge at most
1920 px. An element crop is the element's visible box (clipped by scrolling ancestors) plus an
8 px margin within the viewport, long edge at most 1024 px, PNG first and JPEG when too large.
Width and height are read from the image header.

**Agent snapshots exclude the overlay.** Snapshot collection asks the active session for the
host's backend node and removes its accessibility subtree from the top document's tree.

**Delivery** (implemented by the web client, phase 2). The person's text is followed by a
versioned `<browser_annotations version="1">` text part and the images, last and in fixed order.
No daemon, engine or adapter change is involved.

## Wire

- `BrowserCommand` adds `{ action: "annotate", operation: "start", config }`,
  `{ action: "annotate", operation: "stop" }`,
  `{ action: "annotate", operation: "command", command: BrowserAnnotationPageCommand }` and
  `{ action: "annotate_capture", target: { kind: "page" } | { kind: "annotation", id } }`.
  Start is idempotent for its owner and answers `{ documentId }`; stop is idempotent.
- `BrowserServerMessage` adds `{ type: "browser.annotation", threadId, event }`. `event` keeps
  unknown kinds and fields; clients decode it with `BrowserAnnotationEvent`.
- Page commands: `configure`, `edit`, `remove`, `clear`, `renumber`, `toast`, `restore`.
- Overlay events: `ready`, `saved`, `removed`, `discard`, `screenshot`, `send`, `close`, `bar`.
  The daemon adds `ended`. After relaying `close` it ends the session.

## Consequences

- One overlay serves the native view, the screencast and headless pages; clients only add a
  button, a draft field and a composer chip.
- The desktop relay needs no change: `Runtime.addBinding`, `Page.createIsolatedWorld` and
  `Runtime.evaluate { contextId }` pass through `ace.tabs.cdp`, and `Runtime.bindingCalled`
  returns as an `ace.tabs.event`. A process test drives a real Chrome behind a stand-in desktop
  to keep this true, including the renderer-restart reinstall.
- Content inside iframes is not annotatable in this version. While annotating, the overlay
  adopts a stylesheet that sets `pointer-events: none` on `iframe`, `frame`, `embed` and
  `object`, so pointer input never reaches an embedded document: a click pins the frame element
  itself, and wheel input over a frame scrolls the embedding page. The sheet is removed when
  annotate mode ends. Picking inside same-origin frames needs the intercept installed per frame
  and frame-relative marker geometry; it is left for later.
