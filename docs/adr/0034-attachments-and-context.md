# 0034: Attachments, mentions and message context

Date: 2026-10-02. Status: accepted.

## Context

The competitor inventories supplied for this work describe file context, screenshots, pasted images and phone composers. They do not establish a common resumable attachment contract across providers. Local path references alone cannot carry a photo from a phone to the machine running a CLI. Provider formats differ, too. Claude accepts image and document blocks, Codex accepts local images, OpenCode accepts file parts, and ACP gates images and embedded resources on negotiated capabilities. The provider research in `docs/research/providers/` is the authority for these differences. No competitor implementation is reused.

## Decision

`@ace/context` owns mention resolution, path completion, upload storage, and pure provider projection. The protocol package adds schemas only. The daemon mounts a small authenticated request handler. Clients send workspace-relative mentions or attachment hashes, never daemon paths. The package accepts injected clocks, identifiers, roots, workspace lookup and authorization. A narrow `WorkspaceFiles` interface uses Git for ignore semantics. Workspace PR #26 has landed; the migration assessment below records why this merge keeps the current implementation. Git must be installed; non-Git folders must be initialized before using this implementation.

File and folder mentions expand to bounded text with relative names and explicit truncation markers. Line ranges are inclusive and one-based. Binary files produce a diagnostic and path reference rather than text. Resolution refuses absolute paths, parent traversal and every symlink component. This stricter symlink policy avoids races through redirected directory components. Git ignored paths are refused even if tracked. Reads use no-follow file descriptors and verify the opened inode against its resolved path. Folders use the shared cached index rather than walking the tree on every request.

The path index has capped entries and path lengths. It stores lowercase paths and character postings for fuzzy subsequence queries. Updates remove and insert only changed paths. Filesystem notifications feed incremental updates; an overflow or ignore-file change invalidates the index for a bounded rebuild. Initial listing streams Git's NUL-separated output. Queries keep only a bounded set of highest scoring results. An empty query returns a bounded prefix. Workspace indexes are evicted by an LRU cap.

## Protocol and wire additions

Protocol version 1 gains `context.request` and `context.result` messages with a request id. Operations are `upload.begin`, `upload.status`, `upload.chunk`, `upload.commit`, `upload.cancel`, `attachment.list`, `attachment.release`, `mention.resolve` and `mention.complete`. The begin request declares thread, size and sha256. The daemon reserves quota before accepting bytes. Chunks contain at most 64 KiB in canonical base64 plus an offset. Acknowledgments return the durable offset; clients resume using status after a disconnect. Retrying an already written identical chunk is safe; gaps or different bytes fail. Requests are serialized with a bounded store queue; sockets accept one context operation at a time and reject excess work with a typed error.

Attachment references are `{sha256}` and mentions are `{path, lines?}`. The existing message command gains an optional context field. Backend composition resolves these to text and verified local blobs before adapters project them. This does not introduce a provider credential or cloud upload API. The transport remains the daemon's authenticated WebSocket and can be mounted behind the remote or relay workstreams when those land.

Metadata lives in a separate SQLite database under the daemon data directory. Upload bytes go to private temporary files. Each acknowledged chunk is synced before advancing the database offset. After a crash, unacknowledged trailing bytes are truncated. Commit streams sha256, sniffs magic bytes and reads only bounded image headers and trailers for dimensions and container validation. A hash mismatch or unsafe image fails and releases the reservation. Committed bytes are immutable and content addressed. SQLite tracks thread references and byte counters; per-thread and global quotas count pending reservations as well as retained attachments. Global accounting is conservative and counts references, even when physical bytes deduplicate. A second occupied-disk counter includes unreferenced blobs until GC actually removes them, so release cannot bypass the storage quota. Abandoned reservations expire through explicit maintenance using an injected clock.

Garbage collection deletes only blobs with no thread references, in bounded batches. Commit and collection share the same serializer so a newly referenced blob cannot race deletion. Failed commits and crashes can leave an orphan file; collection reconciles filesystem entries in bounded batches. Message owners retain references until attachment release or thread deletion. Deleting or releasing an attachment does not erase another thread's reference.

## Provider projection

Projection is a pure function over prepared attachments and adapter-probed capabilities. It returns a discriminated native input result and typed diagnostics. Claude gets base64 image sources or PDF document sources. Codex gets `localImage` paths. OpenCode gets `file` parts with MIME and file URLs. ACP gets image blocks or embedded text/blob resources only when supported. Text context is preserved, including line selections and truncation markers. Unsupported media, unavailable prepared bytes and unsupported document types fall back to text path references with a diagnostic. Adapter limits determine allowed MIME types and inline byte caps. Preparation checks the full aggregate cap before reading inline bytes; projection never performs I/O.

Primary contracts: [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [Codex app-server](https://developers.openai.com/codex/app-server/), [OpenCode server](https://opencode.ai/docs/server/), and [ACP content](https://agentclientprotocol.com/protocol/v1/content). Capability probing remains the adapter's responsibility.

## Security and performance

Thread lookup and authorization happen before upload status, bytes, references or workspace contents are returned. Resume identifiers are device scoped and thread bound. Names are display metadata only. Client extensions and MIME claims never determine the stored MIME. PNG, JPEG, GIF and WebP dimensions are checked against side and pixel caps before any raster decoding. The package does not render attachments, extract archives or execute content. SVG and unknown binary formats remain opaque files.

Uploads stream through bounded chunks and streaming hashes. No complete file is held during commit. Inline provider preparation has a separate aggregate bound. Limits cover upload size, reservations, references, operation queues, files per mention, context bytes, index entries, path length and workspace caches. Completion uses cached postings and bounded top results, not filesystem I/O. Benchmarks report upload MiB/s, completion latency on 50,000 paths and peak RSS; timings are non-gating.

## Testing

Public API tests use real Git repositories, symlinks, temporary SQLite databases, files and WebSockets. They cover ignore rules, escape attempts, binary detection, file and aggregate caps, inclusive ranges, disconnect and restart resume, duplicate chunks, hash mismatch, quotas, misleading extensions, cheap rejection of oversized PNG dimensions, provider output and fallbacks, authorization and collection across shared references. Behavior tests and at least eight meaningful mutation cases accompany changes. Under the repo owner's current rule, tests run once at merge. Authors run format, lint, type and size checks only; test, mutation, benchmark and probe execution is deferred. Provider CLIs and fixture recording are not run.

## Implementation notes

Remote access PR #13 was merged into this branch. Read operations require the paired device's read scope; upload/release operations require operate. Pending upload work rechecks the transport access callback before writing. The latest main merge also includes relay and notifications. The additive context messages use the same daemon transport contract. Workspace-service work has not landed, so its narrow interface remains.

Image-size 2.0.2 is accepted under MIT for bounded header parsing, with attribution in NOTICE. Metadata walks additionally validate PNG/GIF/WebP framing and PNG IHDR CRC. Animated images are rejected to keep the pixel cap meaningful across the whole image. Raster validity is left to the provider decoder; ace never inflates pixels. Long JPEG metadata, non-Git workspaces and all symlink mentions fail conservatively. Line selections operate on the bounded file prefix and report unavailable ranges.

Folder reference counts and child indexes make normal watcher changes proportional to changed paths and subtree enumeration proportional to its descendants. Completion includes folder chips as well as files. Upload GC preserves the renamed blob of a pending commit until recovery or expiry. A released reference cannot be revived by replaying an old completed commit.

The current daemon's command port is synchronous and provider execution has not landed. The additive message context field is preserved for the future intent worker; `startDaemon().context.compose()` is the tested asynchronous preparation hook. Thread deletion must call `releaseThread()` before its owner removes the thread. These lifecycle hooks are explicit rather than introducing another engine in the context package.

## Review corrections

Composition now atomically acquires a bounded process-local lease for every attachment before any preparation I/O. It returns `release()` for the intent worker to call after provider consumption, including failure or cancellation. Preparation errors release automatically. GC excludes leased hashes through an indexed temporary SQLite table; thread release does not invalidate an active provider path. Leases end at daemon shutdown and are not a durable provider-session mechanism. Admission caps active leases at 128, each with at most 64 references.

Base64 validation checks characters and canonical padding in one linear pass with constant auxiliary memory. WebP container validation checks VP8 and VP8L frame headers against the previously bounded canvas. Subtree updates remove deleted and ignored tracked descendants before publishing. Cached completion uses the current index during watcher churn. Git byte streams reuse provider-kit's process-group owner, with injected spawning, cancellation, bounded output and deadlines; rejection awaits reaping.

Durability fault injection verifies that a failed chunk sync cannot advance an acknowledged offset across reopen. A PNG with oversized dimensions and corrupt compressed data verifies dimension rejection takes precedence over inflation failure. These tests do not claim to simulate power loss or prove raster validity. Socket overlap tests use a ping response as an ordering barrier and fail an assertion when the busy response is missing.

## Verification corrections and integration boundary

A failed watch update or watcher error now starts background recovery independently of later filesystem events or composer queries. Each LRU entry owns at most one retry timer, with exponential delays from 100 ms to a 5 s cap. The scheduler and watch factory are injected I/O boundaries. Rebuilds publish a replacement index and re-arm the watcher; warm queries keep serving the published index while recovery runs. Closing or evicting an entry cancels its timer and prevents an in-flight rebuild from creating a new watcher. Ignore-rule enforcement during mention reads remains authoritative even while completion serves a stale snapshot.

`deliverContext(service, command, capabilities, consume)` is the context-owned intent-worker boundary for accepted `thread.send` commands. It validates the command, authorizes its device and thread, prepares `payload.context`, and passes the original input/delivery mode plus the discriminated native projection to the injected consumer. It returns typed diagnostics and releases every attachment lease in `finally`. The consumer promise must settle only after the CLI has consumed local files, or cancellation/failure has stopped consumption; enqueueing a write alone is insufficient acknowledgement. The engine owns command idempotency, queue/steer handling, capability selection and cancellation.

The engine and adapters are still absent from `origin/main` at `5494e21`; PR #15 is open. Its session launcher must invoke this boundary around its adapter-native send operation, without flattening Claude documents or ACP resources into canonical `ContentPart`. Initial thread creation uses `compose` after the engine has assigned the thread id, with the same consumption/release contract. Accounts, MCP leases, plugin preparation and model resolution remain other services' session-launch responsibilities. This package does not introduce a parallel engine or claim that the default daemon launches provider sessions. Public tests exercise an owned Node CLI sink and collection during delayed consumption; no installed provider is invoked.

Invalid projection padding bits and reserved VP8L version bits now have negative public-API tests, including valid counterparts. The verifier's surviving mutations are killed by assertions rather than compilation errors or test timeouts.

The final main merge includes automations and process-test reliability. Context reuses main's canonical `spawnRawSupervised` boundary instead of retaining a second raw-stream owner. Its real-process and socket suites join the process-test manifest. Only static checks run before delivery under the owner's current policy.

## Main integration follow-up

Workspace PR #26 is now merged. The narrow `WorkspaceFiles` implementation remains for this merge: context requires raw bounded byte prefixes for binary/UTF-8 diagnostics and an incrementally published fuzzy index, while `@ace/workspace.read` returns decoded text or a binary flag and its watcher owns an asynchronous disposal contract. Adapting those contracts safely needs a separate migration rather than a merge-resolution change. Git and canonical roots remain required; every symlink is refused. Remote authorization already uses the merged daemon device scopes via `allows`.

Main at `fe670b0` is merged without rebasing. NOTICE retains both image-size and workspace descriptor notices. The daemon retains model requests, notifications, authenticated context requests and main's injected delivery runtime, connection admission, presence cleanup and shutdown behavior. Engine PR #15 remains open; the context-owned `deliverContext` integration contract is unchanged.

## Image delivery and client reads

The daemon keeps original image bytes unchanged. Provider-local paths use hard links
named with the MIME-derived extension, under the same private blob directory. GC
removes both names. Codex receives `localImage`, Claude receives base64 image sources,
OpenCode 2 receives data URI attachments with MIME, Cursor SDK receives image URLs,
and Pi/ACP receive base64 images. Negotiated capabilities and inline byte limits
still apply. Unsupported media now produce a visible diagnostic naming the file and
provider; the fallback does not suggest opening a daemon path. HEIC upload fails with
an explicit export-to-PNG/JPEG message. Animated containers remain rejected.

User message items gain `attachments` metadata with `sha256` as the content id,
name, MIME, byte size, dimensions and `thumbnailAvailable`. The engine replaces
verified attachment echoes with that metadata. Matched path, URI and base64 fields
in native user envelopes become content-id references; unrelated native fields
remain available for debugging. Claude image-only envelopes also produce a user
item, and OpenCode prompt evidence retains its file parts for correlation.

Attachment metadata and its originating intent id are committed to an indexed
SQLite table before provider send/admission. Native resume resolves each hash
from that table before accepting its echo, including a crash before any user
item was stored. Actor construction reads no transcript bodies and performs no
attachment-history scan; per-echo lookups use the thread/hash primary key.

`context.request` gains `attachment.read`. Reads are thread scoped, require read
permission, and return at most 64 KiB with offset, total bytes, MIME and EOF. The
same operation is supported on the authenticated relay files channel. The client
exposes `attachmentBytes` on each connection, with thumbnails as the default and
an explicit original-size budget. The portable helper also accepts a request port
bound to a dedicated relay channel. A multi-daemon client must call the connection
that owns the thread, rather than cache a global daemon URL.

Authenticated GET/HEAD `/v1/attachments/<threadId>/<sha256>/<original|thumbnail>`
works on both local HTTP and paired-device HTTPS. Tokens belong in the Authorization
header. Every request checks current device/read/thread permission and retained
thread ownership before conditional cache replies. Only single byte ranges up to
1 MiB are accepted. Full originals are streamed in 64 KiB reads, up to the 32 MiB
upload cap. ETags include hash, variant and preview version. Private revalidation
prevents a cached URL from bypassing a later permission check.

Sharp 0.34.5, accepted under Apache-2.0, creates PNG previews bounded to 256 by 256
pixels and 256 KiB. Decoder input has a 40 million pixel cap; at most two decodes
run concurrently. The authorized read path pins blobs while decoding. Eight previews
are cached in memory, at most 2 MiB. No preview replaces or rewrites the original,
including its alpha, ICC profile or EXIF bytes. Standalone releases stage Sharp's
runtime dependency closure and platform binaries, retaining bundled license notices.

Fake daemons retain uploaded bytes and return small original fixtures as previews.
`ServicesSeed.attachmentImages` seeds an orange PNG by thread id; `fixtureImage`
exports its content id for UI fixtures. Production size and authorization guarantees
belong to the real daemon, not the fake image codec.

HTTP admission includes a 30-second absolute response deadline, using the injected
delivery timer. Expiry or transport close releases the slot while a storage read
or a socket drain is pending. Each completed wait detaches its listener; previous
chunks are not retained by a shared unresolved close promise. WebSocket reads,
HTTP reads and relay reads all recheck current thread access after asynchronous
work. Originals require an explicit `maxBytes` budget in the client helper.

Review regressions and benchmark definitions are written but not executed under
the owner policy. `apps/daemon/bench/attachments.ts` reports actor-open/indexed
lookup latency at multiple history sizes, preview/original CPU time and RSS.
Numbers and runtime assertions need run at merge. Client rendering is a separate
UI follow-up: metadata must be displayed using the connection that owns the item.

## Every file type (2026-10-06)

This amendment replaces the image-only refusal and the earlier rejection of unsafe
image containers. An attachment is delivered natively, as inline text, or as a
readable absolute file path. Unsupported native formats never refuse a send.
Malformed, animated, HEIC and oversized raster containers are retained as opaque
files with no thumbnail and no native image input. Hash mismatches, unreadable
files and hard storage/message limits still fail with corrective messages.

Storage continues to use one content-addressed blob pool in the daemon data dir,
with durable per-thread ownership. This deliberately avoids duplicating large
files for each thread. Upload commit streams both hashing and text validation;
duplicate uploads keep the existing inode. Blob files are mode 0400. Paths and
MIME-derived hard-link aliases are stable across restarts and never go into the
user's repository. The same local OS user can change file permissions, so this is
an immutable-input convention rather than isolation from a hostile provider.

Defaults are 512 MiB per file, 1 GiB per message, 2 GiB retained per thread, and
8 GiB globally. Existing reference, reservation and queue caps still apply.
`ACE_ATTACHMENT_FILE_BYTES` and `ACE_ATTACHMENT_MESSAGE_BYTES` override the first
two at daemon startup; ContextService options can override all storage limits.
Unused reservations expire after 24 hours. Deletion releases a thread's references
and schedules collection. Maintenance reconciles deleted owners in bounded batches
after a crash; active provider leases still protect files until consumption ends.
Shared blobs survive until their final owner releases them.

Classification uses magic bytes before extension and declared MIME. Text is
validated incrementally over the entire file with a fatal UTF-8/UTF-16 decoder
and a control-byte check, including a BOM-less UTF-16 ASCII-prefix heuristic.
The extension and MIME claim are hints for opaque files, not permission to enter
the image decoder. Source, CSV, JSON, logs, Markdown and SVG all use text delivery
when decodable, regardless of extension. Empty files are valid attachments.

At most 16 KiB of source bytes per text file and 64 KiB across a message are read
for inline text. Blocks name the file, type, original size and extension language
hint. A truncated block explicitly names the full file path. Remaining text files
use paths when the aggregate prefix budget is spent. File contents are untrusted
context, not instructions. No archive expansion, PDF extraction, Office conversion,
audio transcription or video decoding is added.

Adapters advertise `attachmentInput`: native format, document MIME types,
embedded-context support and aggregate native byte budget. Claude accepts PDF
base64 document blocks using the installed Agent SDK's typed user-message contract;
its native budget is 4 MiB. Codex keeps local images and file-path fallbacks. Pi and
Cursor use a 128 KiB native budget and path fallbacks for documents/binaries. ACP
negotiates `embeddedContext` and then accepts bounded text/blob resources; without
it, paths and ordinary text remain usable. The engine preserves native document
and resource content through additive `ContentPart.file.content` fields.

OpenCode V2 uses native images but **does not expose PDF or arbitrary binary file
parts to the model**. They must be named in prompt text with a readable path,
rather than sent through `files` and silently omitted. See the primary
[OpenCode V2 attachment contract](https://dev.opencode.ai/v2/docs/attachments/) and
[ACP v1 content contract](https://agentclientprotocol.com/protocol/v1/content).
Claude's source format follows the installed SDK declaration and
[streaming input contract](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
Existing recordings in `fixtures/` prove the transport envelopes, not native PDF
processing; this change adds fake CLI wire tests without claiming new recordings.

The current Codex read-only/workspace-write policies permit reading the daemon
blob path without adding writable roots (see the primary
[Codex workspace sandbox description](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/sandbox_mode/workspace_write.md)).
Cursor's exposed SDK read tools can read outside its cwd; its sandbox API exposes
no read-root selector. Claude/Pi/OpenCode tool gates retain their policy. The daemon
persists only exact, prepared attachment paths and treats reads of those paths as
scoped file reads in its existing approval review. This survives restart; it grants
no writes, directory access, unrelated daemon files, shell execution or network
access. Ask mode still asks. Generic ACP has no portable OS sandbox/read-root
configuration; an agent imposing an additional private restriction may ask for its
own read approval. No permission mode is widened to compensate.

`Attachment.kind` and `Attachment.delivery` are optional additive metadata. The
admitted user item receives the actual delivery mode before provider send, and
history/echo reconciliation keeps it. Non-image chips show filename, size and kind;
transcript chips identify inline text, native PDF/resource or a sent file. Existing
queue commands keep hashes durably, and held web sends use the same upload path.
Web SHA-256 runs over file slices with a lazy `@noble/hashes` import; upload chunks
remain bounded on local, paired-device and relay connections.
The dedicated encrypted files relay accepts context uploads with operate scope,
and reads with read scope. Later upload chunks recheck their durable thread owner
against the current device scope, including after thread access is revoked.

Authenticated HTTP additionally accepts `POST /v1/attachments/<thread-or-draft>/upload?name=<encoded-name>`
with Content-Length, X-Ace-Sha256, optional Content-Type and a bearer header. It
feeds the same begin/chunk/commit owner while the request body is still arriving,
reserving space before reading bytes. Errors are JSON with a corrective message;
over-quota requests return 413. HTTP uploads have a ten-minute absolute deadline
and resumable socket uploads remain available for slower links. GET/HEAD originals
now stream retained files beyond
the former 32 MiB response cap. The allocating client `attachmentBytes` helper
retains its independent 32 MiB memory budget; large provider inputs use local paths.
