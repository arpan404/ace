# @ace/review

Local review sessions backed by SQLite and immutable git revisions. No provider CLI execution lives here.

`ReviewWorker(path, executor?)` is the daemon-facing API. `handle(command, worktree?)` accepts the shared command envelope, owns retry receipts and returns `CommandResult.review`. Supply a host-resolved worktree only for `review.open`. `ReviewService` provides the same API directly for integration tests or hosts already running off the event loop. Clocks and ids are injected there.

The protocol exports session sources, line positions, fingerprints, comments, replies, `ReviewerOutput`, `ReviewFixIntent` and `ReviewReviewerIntent`. Commands are open, comment, reply, resolve, applySuggestion, sendToAgent, askReviewer, refresh, status and list. List sessions without sessionId, comments with sessionId, and replies with both sessionId and commentId. The last id is the next cursor; an empty page ends iteration.

`ReviewExecutor.fix(intent, signal)` must durably accept and deduplicate the request id. The engine calls `worker.afterFix(sessionId, requestId)` after its whole agent tree settles. This compares the saved target revision to a new worktree checkpoint and marks touched comments addressed-pending-review. `ReviewExecutor.review(intent, signal)` starts a reviewer run and returns its JSON object. Review parses that object and imports all valid findings atomically. Executors must honor cancellation when the worker closes. An absent executor rejects both commands. Neither action changes canonical agent status.

`anchorComment`, `anchorComments` and `reanchorComments` are pure. Re-anchoring takes the transition between the old and new revision of the comment's own side. Pass old-side comments the base-to-base transition, and new-side comments the target-to-target transition. Immutable source refs are stored at open and refresh. Deleted or ambiguous findings keep their last position and become outdated; changed findings require human review. Original anchor evidence never changes.

Limits: 1 MiB complete diff, 1,000 comments per session, 100 replies per comment, 100 reviewer findings, 100 selected lines, 8,192 fingerprint characters and 16 outstanding worker commands. Fix requests select at most 20 comments, carry 2,048-character excerpts and fit within 64 KiB of UTF-8 JSON. Reviewer runs accept at most 64 KiB of diff. Oversized inputs fail instead of silently truncating suggestions or findings. Lists return at most 20 records. Historical sessions remain on disk without an in-memory cache.

SQLite and git cannot share an atomic transaction with filesystem effects or engine acceptance. A crash after an operation starts leaves a receipt that returns `review_recovery_required` on retry. This deliberately requires inspection rather than repeating an uncertain effect. Completed receipts survive restart. Session deletion and automatic recovery are future work. Suggestions on files without a final newline may fail Git's context check; they never rewrite the file with a guessed newline.

The daemon starts a worker in its private data directory. It resolves registered workspaces and validates thread ownership. `createDaemonReview` accepts a thread-worktree resolver for hosts with isolated thread worktrees. A read-scoped device can list; mutations require operate scope. Clients cannot choose filesystem paths.

Run `bun run test packages/review/src --maxWorkers=2` and `bun run --filter @ace/review benchmark`. The benchmark covers 1,000 comments across a 10,000-line transition without a timing assertion.
