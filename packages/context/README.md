# @ace/context

Backend context preparation for the user's own daemon. No provider credentials, prompts, image rendering or archive extraction.

## Public API

- `ContextService.open({root, now, id, authorize, workspace})` creates the store and workspace cache. `root` is a private data directory, `authorize` checks device/thread access, and `workspace` returns a canonical Git workspace root.
- `handle(device, ContextRequest, access?)` handles a validated wire operation and returns a typed result. A transport may supply `access` to recheck revocation when queued work starts.
- `compose(device, thread, MessageContext, ProjectionCapabilities)` resolves mentions, checks thread-owned blob references, prepares bounded inline bytes, and returns native provider input, diagnostics and an idempotent `release()` callback. All attachment references are pinned together before preparation. The engine must call `release()` in a `finally` block after provider consumption, including cancellation. This is the hook for the engine's asynchronous intent worker. `startDaemon()` exposes its context service. The synchronous command receipt handler must not perform this I/O.
- `deliverContext(service, command, capabilities, consume)` validates an accepted `thread.send`, prepares its context, passes the original input/delivery mode and native projection to the injected consumer, and releases in `finally`. The consumer must settle after local files are consumed or consumption has stopped. It returns typed diagnostics. The engine owns command idempotency, capability selection and queue/steer execution; native documents/resources must survive adapter submission.
- `projectAttachments(prepared, capabilities)` is pure. Native inputs are discriminated by provider. `claude` supports PNG/JPEG/GIF/WebP images and PDF/plaintext documents when negotiated; `codex` uses local images; `opencode` uses file parts; `acp` uses images and embedded resources for Cursor/Antigravity as negotiated by the adapter. Pass actual MIME allowlists and the installed provider's inline-media byte limit. Selected mention text has its own aggregate cap.
- `GitWorkspace` implements the narrow `WorkspaceFiles` interface. `initialize()` streams Git's index and untracked files, removing ignored tracked files. `update(changedPaths)` applies watcher changes, including subtree additions/removals. `PathIndex.complete()` returns files and folder paths with a trailing slash. `under(folder)` enumerates only that subtree.
- `UploadStore` is independently usable. `acquire(device, thread, hashes)` returns an atomic batch of thread-owned descriptors and paths with an explicit `release()` callback. Use it whenever paths or bytes will be consumed asynchronously. `attachment(device, thread, sha256)` is an unleased inspection snapshot. `releaseThread(thread)` is the hook for thread deletion. `collect(batch)` expires uploads and deletes unreferenced/orphan files in bounded batches. The daemon runs it on startup and once per minute. `close()` drains accepted work and closes SQLite and watchers.

## WebSocket

After authenticated hello, send one request at a time:

```json
{
  "type": "context.request",
  "requestId": "request-1",
  "operation": {
    "op": "upload.begin",
    "threadId": "existing-thread-id",
    "sha256": "<64 lowercase hex digits>",
    "bytes": 12345,
    "name": "phone-photo.png"
  }
}
```

The response is `{type:"context.result", requestId, result}`. A begin/status/chunk result has `{kind:"upload", uploadId, offset, bytes}`. Send `upload.chunk` with `uploadId`, the acknowledged `offset`, and canonical base64 `data` containing at most 64 KiB. Resume by asking `upload.status` after reconnect, using the same paired device. Chunks ahead of the offset or different retransmitted bytes are rejected. A full upload still requires `upload.commit`. Commit returns `{kind:"attachment", attachment}` with the sniffed MIME and sha256. Retrying commit is safe until the receipt expires or its thread releases the attachment.

Other operations are `upload.cancel`, `attachment.list`, `attachment.release`, `mention.complete {threadId, query, limit?}` and `mention.resolve {threadId, mentions}`. A mention is `{path, lines?:{start,end}}`, with inclusive one-based lines. `thread.send` and `thread.create` accept optional `context: {mentions, attachments:[{sha256}]}`. Uploads require an existing thread; allocating drafts and invoking the composition hook belong to the future engine/client work.

Local token-file clients have admin rights. Remote `read` permits status, attachment listings, mention completion and resolution; `operate` permits upload mutations and attachment release; `admin` includes both. A normal composer needs both read and operate. Every operation also checks thread access. Remote transport uses the merged pairing/ticket/pinned-TLS service. There is no separate upload HTTP endpoint.

Errors and diagnostics use `ContextErrorCode`: quota, busy, forbidden, not_found, offset, hash_mismatch, invalid_image, outside_workspace, ignored, binary, truncated, unsupported and invalid_request. Unsupported provider input becomes a text path reference with a diagnostic. Binary mentions produce a diagnostic and validated path reference during composition.

## Bounds and durability

Defaults are 32 MiB per upload, 128 MiB per thread and 2 GiB globally; 256 references/reservations per thread, 65,536 globally, 1,024 pending/completed upload receipts and 32 queued store operations. Each socket accepts one outstanding context operation. Upload receipts expire after 24 hours. Quotas count reservations and references; global accounting deliberately counts each thread reference even when physical bytes deduplicate. A separate occupied-disk counter retains the charge for unreferenced blobs until GC removes them.

Mentions read at most 64 KiB per file, emit at most 256 KiB total context and expand at most 128 files. Line selection operates within the bounded prefix; ranges beyond it return a diagnostic. Paths and folder traversal reject symlink components, absolute paths and parent traversal. The fallback implementation needs Git and canonical roots. Workspace PR #26 has landed; migration of raw-prefix reads and watcher disposal remains follow-up work, as recorded in ADR 0034. The file/folder index has 100,000 entries and 1,024-character paths. Four workspace indexes are cached with LRU eviction. Watch queues cap at 4,096 changes; overflow or ignore changes rebuild the index. Completion returns at most 50 results and serves the published index while watcher updates continue. Failed updates and watcher errors recover autonomously through one timer per cache entry; delays increase from 100 ms to a 5 s cap, new notifications preserve backoff, and eviction/shutdown cancel the timer. The scheduler and watcher factory are injectable. Subtree updates filter tracked ignored and deleted descendants. Git I/O uses an injected provider-kit process owner, cancellation and a 30-second deadline. Overflow and cancellation kill and reap the whole process group.

Each chunk is synced before SQLite records the acknowledged offset. Startup/retry truncates unacknowledged trailing bytes. Commit streams sha256 and renames bytes into `blobs/<sha256>`; a crash between rename and the reference transaction can be recovered. GC preserves blobs pinned by pending uploads, thread references and active composition leases. At most 128 leases of 64 references are admitted; excess work returns `busy`. Leases are process local and must be released after consumption. Shutdown ends their lifetime. The injected `syncChunk` storage boundary defaults to file fsync, and must resolve only after durability. Metadata uses a separate SQLite database and byte counters, so upload chunks do not enter the event log.

Image-size 2.0.2 is accepted under MIT for bounded header dimension parsing; see NOTICE. Limits are 16,384 pixels per side and 40 million pixels total. Header input is capped at 64 KiB, so JPEG files needing longer metadata fail conservatively. PNG/GIF/WebP container walks cap at 4,096 metadata reads, validate framing, and reject animation. GIF frame rectangles must fit the validated canvas. VP8 and VP8L frame dimensions must equal the validated WebP canvas, including its pixel limits. PNG checks IHDR CRC. This is metadata/container validation, not proof that every compressed pixel decodes successfully. No raster decode runs in this package. SVG and unknown binary files remain opaque attachments.

## Verification and measurement

Behavior tests exercise real Git, files, symlinks, SQLite, owned child processes and WS/WSS. Their final execution needs run at merge.

The repo owner's current rule permits only static checks before merge. Behavior tests, mutation runners and benchmarks are **not executed (tests run at merge)** except for explicitly permitted focused tests recorded in `VERIFICATION.md`. Do not run `bun run check`, which includes tests. Static checks are `bun run fmt`, `bun run lint`, `bun run check:size` and `bun run typecheck`.

The original mutation runner describes 16 cases, the review runner describes 28 cases, and `packages/context/bench/verify-mutations.ts` describes 19 verifier-round cases. They require behavior assertions rather than compilation errors or timeouts. Their execution is reserved for the merge-time owner.

The context benchmark creates a real 50,000-file Git repository and measures indexing, completion, incremental updates, autonomous recovery, mentions, upload throughput, projection and GC, plus peak RSS. The daemon benchmark measures the real loopback WebSocket; both stream a 16 MiB payload as 64 KiB chunks. `packages/context/bench/delivery.ts` measures native delivery and lease lifetime for 64 references. These are non-gating and need run at merge; no new benchmark is run under the current policy.
