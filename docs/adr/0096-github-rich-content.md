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
- Access follows the repository. Cache keys are the repository (`host/owner/name`) plus the media
  key, so what one repository's text resolved never answers another's: another repository asks
  GitHub itself, through the user's own access. Kept bytes are served only while the user's `gh`
  still reads the repository: a cache hit re-confirms it at most every ten minutes per repository
  (one metadata read, cached by ETag). A refusal (no access, gone) withholds them; a check that
  can't be answered now (offline, rate-limited) leaves what was resolved before standing. A hash
  is granted to the project whose resolve answered with it, and a download is served only to a
  project granted that hash; knowing a hash from elsewhere is not enough. Grants are per project
  rather than per repository on purpose: every project reaches the same forge through the same
  `gh` sign-in, and forge reads already let a project name any repository that sign-in can read,
  so the repository check above is the boundary, not the project. Grants live in memory; after a
  restart a download answers NOT_FOUND, and the client drops its saved answer and resolves once
  more, which answers from the cache and grants it again (the same path recovers media the
  cache evicted).
- The daemon looks each URL up by its key: an attachment by its asset id (whether written as the
  upload URL or a pasted signed URL), anything else by its URL without a fragment. A key already
  cached answers at once and asks GitHub nothing; one past its week answers with the kept bytes
  while a refresh runs behind it. The rest are rendered in one `gh api markdown` request whose
  text holds only those URLs, each after a marker paragraph carrying a per-request random nonce
  (`<img src>` for images, the bare URL for links); the media after each marker in GitHub's HTML
  (parsed with parse5) is what to fetch, and only a paragraph that is exactly a marker counts,
  so nothing in a URL can pose as one. Only the URLs reach GitHub, never the surrounding text.
  A batch runs on its own, so one requester going away never fails it for others.
- Polls are unchanged: no comment read asks for HTML. Rendering happens only when a page shows
  media that is not cached, and only for that media.
- Fetching: only URLs on GitHub's media hosts (`private-user-images`, `camo`, `user-images`,
  `raw`, `objects`, `avatars` under `githubusercontent.com`, `github.githubassets.com`), or an
  Enterprise host and its subdomains for that host's repositories, over https, through the
  public-web fetch: no cookies, credentials or referrer. Every redirect hop must pass the same
  host check over https (a redirect elsewhere is refused, not followed), and every address is
  checked and pinned: public addresses on 443, plus, for an Enterprise forge only, private
  addresses of that host and its subdomains. The connection may sit idle 15 s; the whole fetch
  may take 10 minutes as long as bytes keep arriving, so a slow link finishes a large video. Bytes stream to a temporary file in the cache folder while they are hashed; past
  32 MiB the fetch stops (`too_large`). The result is kept only if its leading bytes are PNG,
  JPEG, GIF, WebP, AVIF, BMP, ICO, SVG, MP4/QuickTime or WebM; the host's Content-Type is ignored.
- A signed URL that fails (expired between render and fetch, or refused) is rendered once more
  and fetched again. Signed URLs live only in memory for the length of one resolve; they are
  never written to disk, logged or sent to clients.
- `gh api markdown` is a read: the forge mutation classifier no longer counts it as a write, so
  it neither fences writes nor clears the read caches.

### Cache and limits

- `<data>/forge-media/<sha256>` with an in-memory index persisted to `index.json` (writes gathered
  over a second on an injected timer and written at shutdown, recency order kept across
  restarts); at most 2,048 files and 512 MiB, least
  recently used first; temporary files from a crash are removed at start. A hash is counted once
  however many stores of the same bytes race. Attachment entries never go stale; other entries are
  fetched again after a week, the old bytes answering until a fetch succeeds.
- Misses that won't change soon (`none`, `not_found`, `unsupported`, `too_large`) are remembered
  for ten minutes; passing failures for 15 s, doubling with each further failure up to 30 minutes;
  at most 2,048 entries. Kept bytes always answer before a remembered miss. Three fetches run at
  once. Concurrent resolves of the same URL share one fetch.
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
  `start type` (ol; the type is drawn), `src` (video), `align` on block and cell elements, `dir`,
  `datetime`, `cite`. A `<video src>` plays an upload through the daemon with controls forced;
  anything inside it is dropped. Everything
  else is dropped: classes, inline styles and event handlers never reach the DOM. A tag outside
  the list is shown as its source text (`<script>…</script>` reads as text). HTML comments are
  hidden. Links are kept only for http(s), mailto and in-page anchors; images only for http(s);
  root-relative paths resolve against the forge host.
- SVG is only ever drawn as an `<img>`, and from a `data:` URL, never a same-origin `blob:`: a
  document opened from it on its own (a new tab) has no origin, so its scripts can't reach the
  app's storage or pairing. The page runs under the app's Content Security Policy in both
  builds, defined once (`@ace/html/app-policy`): the desktop shell sends it as a header, and the
  hosted web build writes it into `index.html` as it is built, hashing its inline boot scripts
  (the host adds `frame-ancestors 'none'`, `nosniff` and `no-referrer`). Scripts come only from
  the bundle; nothing inline runs otherwise; plugins are off; images, media and frames come only
  from the page itself (`data:`/`blob:`) and the places listed.
- Images take the size their text asks for (`width`/`height`), else their own, never wider than
  the column, with their box held while loading (from the attributes or the daemon's header
  read). A click opens the existing lightbox; an image inside a link follows the link. A video
  plays inline with controls at its own size. `<picture>` picks the `<source>` whose
  `prefers-color-scheme` matches ace's resolved mode. Media that can't be shown leaves one quiet
  line ("“alt” couldn't load.") with "Open on GitHub", or "Open original" for media off the
  forge.
- Alerts are monochrome (an icon and the word): colour in ace means agent state (DESIGN.md).
  Emoji shortcodes use GitHub's published `gemoji` list, loaded as its own chunk only when text
  holds a shortcode; GitHub's image-only emoji (`:octocat:`) come from its emoji list
  (`forge.emoji.images`, read once per host when a shortcode isn't Unicode; a failed read waits
  ten minutes before it is asked again) and load through the
  daemon as media. @people and @org/team link to GitHub; `#123` and `owner/repo#123` link and open
  inside ace where the page can; commit SHAs (40 characters, or 7 and up mixing digits and
  letters, since ace can't ask GitHub whether each exists) and `owner/repo@sha` link to the
  commit; footnotes are numbered in definition order with back links. None of these apply inside
  link text or code, as on GitHub.
- Mermaid diagrams draw as images. The renderer loads as its own chunk only when a page shows a
  ```mermaid block. A diagram's own configuration (`%%{init}%%` directives, front matter) is
  removed before it renders, and every setting that could turn on HTML labels, lower the security
  level or restyle it is locked (`secure`), so it renders at `securityLevel: "strict"` with
  plain-text labels and no error drawing. Renders run one at a time (mermaid's settings are
  global), in an off-screen, inert container of ours that is removed afterwards; its output is
  sanitized by mermaid and, under the policy above, nothing inline in it could run even while it
  is there. The SVG is shown only as an `<img>` from a `data:` URL. The code block stays while it
  loads and if it can't be drawn. (A sandboxed opaque-origin frame was considered: its module
  scripts would need CORS from every host the app is served from, including the desktop's own
  scheme, for no gain over the above.)
- Task boxes tick where the viewer may edit the text: the PR description through the lifecycle
  edit against the snapshot version (only while that version's body is the one shown), the
  viewer's own PR comments through the comment edit with its expected-body guard, and issue
  bodies through the issue edit with its expected-updated-at guard. Each box is placed in the
  text by walking the lexer's own tokens through the source, read with its line endings as the
  lexer reads them (CRLF, as GitHub's editor saves, mapped back to the original): a token the
  lexer re-indented or unquoted spans exactly its own lines, so code it holds is never searched
  again; a box is placed only where its item's own line holds it; loose lists' boxes (inside
  their first paragraph) tick too. Only that box's mark changes, and a box that can't be placed
  only shows its state. Each box is named by its item's words.

## Consequences

- Private screenshots and recordings show in ace on every device, with GitHub contacted once per
  file by the daemon and never by clients.
- Images by relative repository path in comments are not fetched (GitHub resolves them against
  the page, which usually breaks there too); repository files remain in the Code tab.
- Short commit SHAs that are all digits or all letters stay text, and a SHA-shaped word that
  isn't a commit still links (to a page GitHub answers with not found).
- The iOS client can adopt the same resolve and download operations later.

## Testing

A fake `gh` serves recorded `POST /markdown` HTML (echoing each request's nonce); a local HTTP
server stands in for the media host, refusing a lapsed token, redirecting away, dripping slowly or
stalling, so the re-render path, per-hop checks, idle timeout, backoff, stale answers, sniffing,
size caps, per-repository keys, grants and the cache (budget, LRU, restart) run for real. Web tests render forge text against the fake daemon's
resolve and download. A one-off run against a real private repository through the real forge and
daemon code fetched two private screenshots, a recording and a camo image, wrote no signed URL to
disk, and answered the second resolve from the cache without contacting GitHub.
