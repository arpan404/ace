# 0034: Attachments, mentions and message context

Date: 2026-10-02. Status: accepted.

## Context

The competitor inventories supplied for this work describe file context, screenshots, pasted images and phone composers. They do not establish a common resumable attachment contract across providers. Local path references alone cannot carry a photo from a phone to the machine running a CLI. Provider formats differ, too. Claude accepts image and document blocks, Codex accepts local images, OpenCode accepts file parts, and ACP gates images and embedded resources on negotiated capabilities. The provider research in `docs/research/providers/` is the authority for these differences. No competitor implementation is reused.

## Decision

`@ace/context` owns mention resolution, path completion, upload storage, and pure provider projection. The protocol package adds schemas only. The daemon mounts a small authenticated request handler. Clients send workspace-relative mentions or attachment hashes, never daemon paths. The package accepts injected clocks, identifiers, roots, workspace lookup and authorization. Until the workspace service lands, a narrow `WorkspaceFiles` interface uses Git for ignore semantics. Git must be installed; non-Git folders must be initialized before using this implementation.

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

Public API tests use real Git repositories, symlinks, temporary SQLite databases, files and WebSockets. They cover ignore rules, escape attempts, binary detection, file and aggregate caps, inclusive ranges, disconnect and restart resume, duplicate chunks, hash mismatch, quotas, misleading extensions, cheap rejection of oversized PNG dimensions, provider output and fallbacks, authorization and collection across shared references. At least eight production mutations must each fail a behavior test before delivery. `bun run check` is the completion gate; provider CLIs and fixture recording are not run.

## Implementation notes

Remote access PR #13 was merged into this branch. Read operations require the paired device's read scope; upload/release operations require operate. Pending upload work rechecks the transport access callback before writing. Relay and workspace-service work have not landed, so the narrow interfaces remain.

Image-size 2.0.2 is accepted under MIT for bounded header parsing, with attribution in NOTICE. Metadata walks additionally validate PNG/GIF/WebP framing and PNG IHDR CRC. Animated images are rejected to keep the pixel cap meaningful across the whole image. Raster validity is left to the provider decoder; ace never inflates pixels. Long JPEG metadata, non-Git workspaces and all symlink mentions fail conservatively. Line selections operate on the bounded file prefix and report unavailable ranges.

Folder reference counts and child indexes make normal watcher changes proportional to changed paths and subtree enumeration proportional to its descendants. Completion includes folder chips as well as files. Upload GC preserves the renamed blob of a pending commit until recovery or expiry. A released reference cannot be revived by replaying an old completed commit.

The current daemon's command port is synchronous and provider execution has not landed. The additive message context field is preserved for the future intent worker; `startDaemon().context.compose()` is the tested asynchronous preparation hook. Thread deletion must call `releaseThread()` before its owner removes the thread. These lifecycle hooks are explicit rather than introducing another engine in the context package.
