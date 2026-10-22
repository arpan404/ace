# 0096: Rich content in pull request and issue text

Date: 2026-10-22. Status: accepted.

## Context

Pull request descriptions, comments, reviews and issues are written for GitHub's renderer. People
paste screenshots (`<img width="…" src="https://github.com/user-attachments/assets/<id>">`),
drop in screen recordings (a bare attachment URL on its own line), use light and dark
`<picture>`s, `<details>`, alerts (`> [!NOTE]`), task lists, emoji shortcodes, @mentions and
footnotes. ace drew images as link chips and raw HTML as literal text, so these pages could not
replace github.com.

Attachments need GitHub's session even on public repositories: the upload URL answers 404 without
one. GitHub's own rendering of the same text replaces each attachment with a signed URL on
`private-user-images.githubusercontent.com` (a JWT in the query, valid for five minutes, the
asset id in the path), turns a bare attachment URL that is a video into `<video>`, and replaces
every other image with its camo proxy URL (`camo.githubusercontent.com`, original in
`data-canonical-src`). This holds for the REST `body_html` media types, GraphQL `bodyHTML`, and
`POST /markdown` with `mode: gfm` and `context: owner/name`; all were checked against real
responses, including a private repository. ace never reads, stores or proxies credentials
(ADR 0002) and its browser is not signed in to GitHub.

## Decision

### Media through the daemon

- A client asks `forge.media.resolve` (`@ace/protocol/forge-media`, additive) with up to 32 URLs
  exactly as the text wrote them, each with a role: `image` (markdown image, `<img>`,
  `<source srcset>`) or `link` (a link alone on its line, which may be a video). It gets one
  result per item: `ready` with the kind, a hash, the sniffed type, the size and, for images,
  the pixel size from the header; `none` for a link that is not media; or `unavailable` with a
  fixed reason (`too_large`, `unsupported`, `not_found`, `forbidden`, `offline`, `rate_limited`,
  `failed`).
- Bytes are read with the `forge.media.download` file operation, by hash, scoped to a registered
  project. The daemon binds it to a plain read-only download from a files service rooted at its
  media cache, so it streams through the same pull channel as other downloads, including the
  encrypted relay. Paired devices and phones never contact GitHub.
- The daemon looks each URL up by its media key: an attachment by its asset id (whether written
  as the upload URL or a pasted signed URL), anything else by its URL without a fragment. A key
  already cached answers at once and asks GitHub nothing. The rest are rendered in one
  `gh api markdown` request whose text holds only those URLs, each after a marker
  (`<img src>` for images, the bare URL for links); the media after each marker in GitHub's HTML
  (parsed with parse5) is what to fetch. Only the URLs reach GitHub, never the surrounding text.
- Polls are unchanged: no comment read asks for HTML. Rendering happens only when a page shows
  media that is not cached, and only for that media.
- Fetching: only URLs on GitHub's media hosts (`private-user-images`, `camo`, `user-images`,
  `raw`, `objects`, `avatars` under `githubusercontent.com`, `github.githubassets.com`), or an
  Enterprise host and its subdomains for that host's repositories, over https, through the
  public-web fetch: no cookies, credentials or referrer, every address and redirect hop checked,
  15 s per hop. Bytes stream to a temporary file in the cache folder while they are hashed; past
  32 MiB the fetch stops (`too_large`). The result is kept only if its leading bytes are PNG,
  JPEG, GIF, WebP, AVIF, BMP, ICO, SVG, MP4/QuickTime or WebM; the host's Content-Type is ignored.
- A signed URL that fails (expired between render and fetch, or refused) is rendered once more
  and fetched again. Signed URLs live only in memory for the length of one resolve; they are
  never written to disk, logged or sent to clients.
- `gh api markdown` is a read: the forge mutation classifier no longer counts it as a write, so
  it neither fences writes nor clears the read caches.

### Cache and limits

- `<data>/forge-media/<sha256>` with an in-memory index persisted to `index.json`; at most 2,048
  files and 512 MiB, least recently used first; temporary files from a crash are removed at
  start. Attachment entries never go stale; other entries are fetched again after a week, the old
  bytes standing until a fetch succeeds.
- Misses that won't change soon (`none`, `not_found`, `unsupported`, `too_large`) are remembered
  for ten minutes, passing failures for 15 s, at most 2,048 entries. Three fetches run at once.
  Concurrent resolves of the same URL share one fetch.
- Clients keep resolve answers for the session (passing failures for 15 s) and up to 64 files /
  96 MiB of bytes; byte reads share the transcript image loader's queue, budget, reconnect wait
  and retries.

### Rendering

- `ForgeProse` draws forge text. It composes the shared markdown renderer with forge-only
  extensions (`components/markdown/extensions.ts`): hooks for runs that hold raw HTML, images,
  blockquotes, paragraphs, task boxes, and one pass over the document. Agent prose passes no
  extensions: its rendering and cost are unchanged (the only added work is checking whether a
  run of tokens holds raw HTML, which it already did by type).
- Raw HTML is tokenized to the HTML standard with parse5's tokenizer and built into a tree across
  markdown tokens, so `<details>` can hold the code block after it and inline tags wrap the text
  between them. It is drawn as React elements; no HTML string is ever injected.
- Allowed elements: `a abbr b bdo blockquote br caption center cite code dd del details dfn div dl
dt em figcaption figure h1–h6 hr i img ins kbd li mark ol p picture pre q rp rt ruby s samp small
source span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr`.
  Allowed attributes: `href title name id` (a; ids are prefixed per document), `src alt title
width height align` (img), `srcset media type` (source), `open` (details), `colspan rowspan`,
  `start type` (ol), `align` on block and cell elements, `dir`, `datetime`, `cite`. Everything
  else is dropped: classes, inline styles and event handlers never reach the DOM. A tag outside
  the list is shown as its source text (`<script>…</script>` reads as text). HTML comments are
  hidden. Links are kept only for http(s), mailto and in-page anchors; images only for http(s);
  root-relative paths resolve against the forge host.
- SVG is only ever drawn as an `<img>` from a blob URL, where its scripts never run.
- Images take the size their text asks for (`width`/`height`), else their own, never wider than
  the column, with their box held while loading (from the attributes or the daemon's header
  read). A click opens the existing lightbox; an image inside a link follows the link. A video
  plays inline with controls at its own size. `<picture>` picks the `<source>` whose
  `prefers-color-scheme` matches ace's resolved mode. Media that can't be shown leaves one quiet
  line ("“alt” couldn't load.") with "Open on GitHub".
- Alerts are monochrome (an icon and the word): colour in ace means agent state (DESIGN.md).
  Emoji shortcodes use GitHub's published `gemoji` list, loaded as its own chunk only when text
  holds a shortcode. @people and @org/team link to GitHub; `#123` links (the PR view opens its
  own); footnotes are numbered in definition order with back links.
- Task boxes tick where the viewer may edit the text: the PR description through the lifecycle
  edit against the snapshot version (only while that version's body is the one shown), the
  viewer's own PR comments through the comment edit with its expected-body guard, and issue
  bodies through the issue edit with its expected-updated-at guard. Only the box's mark changes;
  if the boxes on the page can't be matched one to one with the source (outside fenced code),
  they only show their state.

## Consequences

- Private screenshots and recordings show in ace on every device, with GitHub contacted once per
  file by the daemon and never by clients.
- Mermaid diagrams stay code blocks: ace has no diagram renderer to reuse. Images by relative
  repository path in comments are not fetched (GitHub resolves them against the page, which
  usually breaks there too); repository files remain in the Code tab. Custom GitHub emoji that are
  images (`:octocat:`) stay text. Commit SHAs and `owner/repo#123` are not linked yet.
- The iOS client can adopt the same resolve and download operations later.

## Testing

A fake `gh` serves recorded `POST /markdown` HTML; a local HTTP server stands in for the media
host, refusing a lapsed token, so the re-render path, sniffing, size caps, host checks and the
cache (budget, LRU, restart) run for real. Web tests render forge text against the fake daemon's
resolve and download. A one-off run against a real private repository through the real forge and
daemon code fetched two private screenshots, a recording and a camo image, wrote no signed URL to
disk, and answered the second resolve from the cache without contacting GitHub.
