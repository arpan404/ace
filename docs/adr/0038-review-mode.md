# 0038: Local review sessions and structured agent fixes

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories describe Codex's base-branch and uncommitted review, Claude's inline diff comments and auto-fix, Cursor's Bugbot and Autofix, Antigravity's artifact comments, and t3code's forge review UI. Those inventories do not establish a portable local comment identity across edits, explicit uncertainty when anchors disappear, or a provider-independent structured fix contract. They are requirements references only. This implementation uses no competitor code.

ace needs backend review state independent of provider transcripts. A changed line is evidence that an agent touched a finding, not evidence that the finding is resolved. Completion still belongs to the whole-tree engine in ADR 0004.

## Decision

Add `@ace/review`, using `@ace/git` for diffs, immutable worktree checkpoints and checked patch application. Sources cover a thread's registered workspace against its base, checkpoint ranges and arbitrary commit refs. The host resolves workspace/thread worktree identity; clients cannot supply filesystem roots. A working-tree side becomes an immutable checkpoint before review. The host may supply a thread-worktree resolver when isolated thread worktrees become available.

Each SQLite session has open, changes-requested or approved status. Comments have stable ids, replies, suggestions, a resolution flag, and an anchor state of active, outdated or addressed-pending-review. Resolving remains an explicit human action. Refresh compares immutable revisions on each side; it maps positions through intervening hunks, handles renames, then searches bounded text/context candidates. Exact unique content can follow moves. Fuzzy context matching requires a confidence threshold and rejects tied candidates. Deleted selections stay outdated unless unique matching content survives elsewhere. Last position and original fingerprint remain available for outdated findings.

Anchoring is pure and deterministic. One transition index serves a batch of comments. Fingerprints contain selected text and up to three context lines on either side, bounded by line count and total characters. A refreshed anchor records new context. Original deletion evidence prevents fuzzy matching from attaching a deleted finding to a neighboring line. Missing or truncated data fails explicitly instead of manufacturing an anchor.

Suggestions apply only on the new side of the current working tree. Exact selected text and context enter a unified patch. Git checks and applies under its repository lock, without shell interpolation, external diff drivers, unsafe paths or hooks. A conflict leaves files and review state untouched. Successful application marks the comment addressed-pending-review.

## Protocol and wire additions

New schema-only `protocol/review.ts` exports sources, sessions, anchors, comments, replies, reviewer output and bounded fix intents. Add command union members for `review.open`, `review.comment`, `review.reply`, `review.resolve`, `review.applySuggestion`, `review.sendToAgent` and `review.list`. Also add `review.refresh`, `review.status` and `review.askReviewer` to expose the full loop. Results extend command receipts with optional typed review data; existing clients and commands remain valid. Lists are cursor-paged and bounded.

Send-to-agent includes selected comment ids, file, side, range, text, optional replacement and a bounded excerpt. It requires an explicit target thread and rejects resolved/outdated findings. An engine executor accepts an idempotent request id and typed intent; it owns provider delivery and agent-tree lifecycle. Reviewer execution receives a bounded diff and the shared output schema. Parse and validate the complete result and all anchors before committing any comments. No provider CLI is invoked by review itself. Hosts without an executor reject agent actions explicitly.

The daemon routes review commands through a dedicated async port and Node worker. Its private SQLite database owns review receipts. Commands serialize with bounded admission. A started external operation without a terminal receipt after a crash is reported as recovery-required on retry, rather than replayed or reported successful. Engine executors must deduplicate their request ids. Review polling is separate from canonical thread event replay.

## Security

Existing authenticated command envelopes and device identity checks apply. Listing needs read scope; mutations need operate scope. Review reads only host-registered repositories. Validate paths, ids, refs, line ranges, text and database records at boundaries. Reject traversal, absolute paths, NUL and unsupported binary anchors. Patch application is constrained to the comment's path. Code excerpts and comments remain in the user's private daemon directory and authenticated channel. They are untrusted input to the engine, never commands or credentials.

## Performance and limits

Cap diff text, comments per session, replies per comment, reviewer findings, selected fixes, context and wire results. Keep historical sessions on disk with indexed cursor pagination, no permanent history cache. SQLite uses prepared statements and atomic batches. The worker keeps git and synchronous SQLite off the daemon event loop. Transition parsing is O(diff lines); line mapping uses binary search. Exact text candidate indexes are built once per transition, and fuzzy matching uses bounded candidates from indexed context lines. The non-gating benchmark re-anchors 1,000 comments across a 10,000-line patch and records throughput and peak RSS. Conservative ambiguity handling trades recall for correct placement.

## Testing

Test the public package with pure anchor examples, real temporary git repositories and SQLite reopened from disk. Cover inserts, deletes and moves above comments, deleted selections, edited text, ambiguous context, renames and both sides. Verify clean and conflicting suggestions, bounded fix payloads, malformed reviewer output, replies and resolution, status transitions, atomic reviewer import, persistence and command retry behavior. Use real authenticated daemon sockets for routing and scope checks. No provider prompts or recorder runs. Before delivery, kill and revert at least eight production mutations, record benchmark results and pass `bun run check`.
