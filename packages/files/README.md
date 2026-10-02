# @ace/files

Daemon-side file transfer and workspace mutations over the authenticated WebSocket. It uses `@ace/workspace` for path resolution, handles and traversal. No HTTP file endpoint, provider credential or client implementation is added.

Enable the daemon service with `ACE_WORKSPACE_ROOT=/path/to/repo`. The daemon keeps transfer metadata and trash under `ACE_HOME/files` and trusted producer artifacts under `ACE_HOME/artifacts`. Remote `read` scopes permit downloads, stat, archive previews and artifact listings. `operate` permits mutations. Revocation closes active channels and prevents queued writes from starting.

## Public API

```ts
import { FilesService } from "@ace/files";

const files = await FilesService.create({
  workspace: root,
  dataDir,
  artifactRoots: [artifactRoot],
  now: clock,
  id: generateId,
  authorize: checkDeviceCapability,
  onChange: publishToEngine,
});
```

`request(device, operation)` executes metadata, archive preview, upload control and mutation requests. `download(device, operation)` returns a bounded async byte generator, validator, offset and size. Close it on abandonment; exhausting its generator also releases the transfer reservation. `append` accepts a single upload chunk. The WebSocket adapter owns those operations for normal clients. `downloadForTransport` borrows one read buffer; each chunk remains valid until the next read, so the adapter awaits transport writes before advancing. Public `download` chunks remain stable when retained. `attachFilesChannel` accepts an injected bounded transport, and `attachFilesRelay` binds an authenticated encrypted relay host channel. The relay owner verifies hello/device authority, calls its `authorize`, and supplies a live read/operate scope check. Consume its `frames()` iterator and pass controls to `accept`, binary frames to `binary`. This preserves the same file API across transports.

`subscribe` and `onChange` deliver successful mutations to local consumers, including the engine. `attachFilesSocket` publishes the same events to authorized connected devices. Events carry versions and IDs, never file content. Delivery is live; reconnecting consumers refetch metadata. An event sink failure cannot undo a filesystem effect. The engine integration must provide its own durable publication policy if it requires replay.

`registerArtifact` registers a trusted producer's regular file under a configured canonical root. It returns an opaque ID usable by `artifact.download`. `removeArtifact` removes its registration without deleting producer content. Categories include recordings, screenshots, support bundles and output blobs. `startDaemon` exposes its enabled service as `files` for producer and engine registration.

`sweep` removes expired upload temp files and trash. The daemon owns a periodic sweep and runs one at startup. An expired upload whose parent was removed or moved outside the workspace loses its registration without following that parent. `close` drains queued mutations and closes the catalog; its socket owner first cancels transfers.

## Wire sequence

Send `files.request` with `requestId` and an `operation` from the additive protocol schemas. A file download returns `files.ready` containing a socket-local channel, total size, start offset and validator. Grant `files.credit` to receive binary frames. Each credit permits one payload of at most 64 KiB, and the window cannot exceed eight. A file's last chunk is followed by `files.end`; unknown-size archives need credits until their trailer arrives.

Frames contain `ACEF`, a big-endian uint32 channel, a big-endian uint64 byte offset, then the payload. There is no base64 conversion. `encodeFileFrame` and `decodeFileFrame` implement the common envelope for workspace transfers and blob-store attachments. `session.bindUpload(BinaryUploadDestination)` binds a destination-owned writer to the same capped channel namespace, offset checks and acknowledgements. The destination owns durable offsets, thread/device checks, deduplication and quotas, and rechecks the supplied authorization guard before its queued write commits. Existing ADR 0034 base64 JSON chunks can remain available alongside the binary channel.

`files.end.sha256` hashes the transmitted range, starting at the requested offset. A reconnect retains its prefix, sends its previous validator with a nonzero offset and hashes the assembled result locally. A failed or cancelled stream has no success trailer. `files.cancel` releases a channel and returns `files.cancelled` when release completes. Upload channel cancellation disconnects the channel; `upload.cancel` also removes the durable upload and temp file.

Start an upload with a target path, its expected version or null, and total size. `files.upload` returns the persistent upload ID, channel and acknowledged offset. Send one frame per acknowledgement. Resume with the same device and upload ID after reconnect or restart. Commit with the full SHA-256. The service checks size, hash, temp identity and destination version, syncs the file, then renames it atomically. Existing destinations remain visible until commit. Existing regular file permissions survive replacement; new files use 0600.

Inline write/create accepts up to 1 MiB of UTF-8 bytes, also subject to the daemon's 1 MiB total control-frame limit. Larger edits use uploads. `mkdir`, `rename`, `move`, `delete` and `restore` carry expected versions. Move and restore destinations must be absent. A directory's version includes descendant metadata so a nested agent edit prevents deletion or moving with a stale version. Directly targeted mutation paths cannot be the root, `.git`, internal upload temp names or symlinks. A pending upload prevents moving or deleting its containing directory.

## Archives and limits

`archive.preview` reports uncompressed content bytes, entry count and a preview ID. `archive.download` streams `.tar.gz`, using POSIX ustar/PAX headers and Node gzip. Long UTF-8 names and files beyond 8 GiB use PAX records. `.git` is always excluded, gitignored entries are excluded by default, and symlinks/special files are excluded. The preview and each entry are checked for changes. One reusable input buffer is refilled only after gzip releases ownership. Output pauses after each gzip data event, avoiding concatenation copies. Archives restart at zero. A producer can save an archive and register it as an artifact when resumable archive downloads are needed.

| Resource                              | Default bound                    |
| ------------------------------------- | -------------------------------- |
| Active transfer channels              | 4 service-wide and 4 per socket  |
| Credits                               | 8 per download                   |
| Chunk payload                         | 64 KiB                           |
| Queued mutations / socket requests    | 16 each                          |
| Uploads retained for resume           | 32                               |
| Single upload / reserved upload bytes | 10 GiB / 20 GiB                  |
| Trash entries / logical bytes         | 128 / 20 GiB                     |
| Trash and abandoned upload retention  | 7 days                           |
| Artifact registrations                | 1,024                            |
| Local mutation subscribers            | 1,024                            |
| Archive previews                      | 4, expiring after 5 minutes      |
| Preview metadata / entries            | 16 MiB / 100,000 per preview     |
| Directory entries                     | 10,000, inherited from workspace |

Configured byte quotas and retention are injectable. The service refuses requests at capacity; there is no unbounded waiting queue. SQLite stores small resource metadata only and reuses prepared statements. Trash moves require the data directory and deleted path to share a filesystem. `EXDEV` leaves the source intact. Node does not provide portable descriptor-relative rename or compare-and-swap. Parent and temp identities are verified around effects, but local filesystem permissions remain the boundary against a process racing the final syscall.

## Verification

`bun run test -- packages/files apps/daemon/src/files.server.test.ts` runs real-file, real-WebSocket and pinned-WSS behaviors. Large download and archive tests use isolated Node server processes and assert bounded peak RSS. Credits, socket replies and injected clocks synchronize tests; timing thresholds are not correctness criteria.

Run `bun run --filter @ace/files bench` for local download, a simulated 2 MiB/s receiving link, streamed archive and durable upload measurements. It prints throughput, frame rate and daemon RSS from isolated server processes. The local/archive dataset repeats a random 64 KiB block outside gzip's dictionary window; the slow-link file is sparse. `bun run --filter @ace/files bench:relay` measures binary download through the real encrypted relay, reporting combined host/client/relay process RSS and relay queue peaks. Results and applied production mutations are recorded in `REVIEW-VERIFICATION.md`.
