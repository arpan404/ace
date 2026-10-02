# 0037: Remote file transfer and workspace mutations

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories describe workspace editors, screenshot and recording artifacts, and phone controls for agents. They do not establish a general, resumable host filesystem transfer channel across every remote transport. ace needs the same downloads on loopback, LAN, Tailscale and the encrypted relay, without a second HTTP listener. This implementation is written from our requirements, Node APIs and the WebSocket specification, without competitor code.

ADR 0006 separates large output and blobs from event payloads. `@ace/workspace` already owns containment, safe file handles, bounded traversal and gitignore rules. File operations must use that implementation.

## Decision

`@ace/files` owns transfers, mutation transactions, trash and an artifact registry. The daemon attaches it to an authenticated socket. Authorization is an injected `authorize(device, capability)` check with `files.read` and `files.write`. Checks run for every control request and upload frame, allowing revocation during a transfer. Workspace selection is a daemon configuration decision, never a path supplied by a device.

Downloads pull at most 64 KiB per credit. A credit grants one frame; at most eight outstanding credits are accepted. The sender awaits the WebSocket write callback before reading again. Four active transfers per service, bounded control queues, socket payload limits and upload quotas prevent memory growth from slow or hostile devices. Cancellation and socket close release handles and compression streams. Files have no download size cap.

## Protocol and wire additions

New schemas live in `protocol/files.ts`; existing message definitions remain additive. JSON controls use `files.request` with a request ID and an operation: stat, download, archive.preview, archive.download, upload.begin, upload.resume, upload.commit, upload.cancel, write, create, mkdir, rename, move, delete, restore, artifacts.list. Transfer controls grant credits or cancel. Responses use `files.result`, `files.error`, `files.ready`, `files.end`, `files.upload` and `files.changed`.

Binary frames use a shared upload/download envelope: four ASCII bytes `ACEF`, a 32-bit big-endian channel number and a 64-bit byte offset, followed by at most 64 KiB of payload. Channel numbers belong to a socket, not a persistent upload. Upload IDs belong to a device and survive reconnect and daemon restart. The next offset is acknowledged only after the bytes reach the temp file. Clients send one frame per acknowledgement. Invalid offsets and excess frames fail without appending bytes.

Downloads accept an offset and require the previous validator for nonzero offsets. Validators contain device, inode, size, mtime and ctime. The open handle and path are checked again at completion. A SHA-256 trailer covers the transmitted range; clients retain their own prefix digest/state or hash the assembled file. An interrupted transfer has no successful trailer. A changed file produces a typed conflict.

ADR 0034 attachment uploads should reuse this binary envelope, channel ownership and acknowledgement discipline. Destination resolution is the difference: workspace uploads commit to a version-checked path, attachment uploads commit to a content-addressed blob. `feat/context` was unavailable when this ADR was written; convergence requires an additive blob destination resolver rather than a second frame format. Artifacts register trusted producer paths under configured artifact roots and stream through the same download code.

## Archives

A minimal ustar writer and Node gzip avoid a new dependency. A preview records file versions and total uncompressed bytes, with a capped entry count and metadata budget. Archive creation rechecks this snapshot and streams each file into gzip. Symlinks and special files are excluded, `.git` is excluded, and workspace gitignore rules apply by default. Long paths use ustar's prefix field or fail before transfer. Archives are streamed as `.tar.gz`. Previews expire and have a service-wide cap. Archives start at zero; file and artifact streams support range/resume. A caller can download a completed archive saved by a producer as an artifact for resumable archive delivery.

## Mutations and security

Every mutation supplies the observed version, with null meaning absent. Rename/move also supply the destination version. Uploads write an exclusive temp file in the target directory, fsync it and atomically rename after a final version check. Inline edits are capped at 1 MiB. Service mutations serialize without an unbounded waiting queue. Version checks prevent overwrites by another client or agent between requests. Mutation paths reject symlinks, the root and `.git`; reads use workspace's existing safe handle rules.

Node lacks a portable descriptor-relative rename API. Parent identities are checked immediately before and after filesystem effects. This protects accidental replacement but cannot provide a kernel-level compare-and-swap against a malicious local process racing the final syscall. Local filesystem permissions remain the trust boundary. A post-operation path race is reported and never treated as success.

Deletes rename into ace trash under the data directory, with durable metadata, restore conflict checks, retention expiry and quotas. Cross-filesystem trash moves return an error rather than permanently deleting the source. No request permanently deletes workspace content. Expiry cleanup applies only to retained trash and abandoned upload temp files. Registry metadata and on-disk files have bounded counts and byte quotas. Mutation events go to connected devices and an injected daemon event sink so orchestration can observe them without coupling this package to the engine.

## Verification and performance

Tests use real files and real daemon WebSockets. They cover a 200 MiB download with withheld credits, exact resumed hashes, validator conflicts, gitignored archive entries, atomic and resumed uploads, conflicts, trash restore, operation-wide path escapes, scope denial, malformed frames, quotas and cancellation. Watchdogs detect hangs; elapsed-time thresholds are not correctness assertions. A separate benchmark measures local and simulated slow-link throughput and peak RSS. Before delivery at least eight production mutations must each make a behavioural test fail, then be reverted.
