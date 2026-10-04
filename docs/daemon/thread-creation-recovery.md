# First-message recovery

Socket `thread.create` and `thread.prepare` in worktree mode prepare the physical worktree before committing a thread, command receipt or delivery intent. A preparation failure returns `commandResult` with `ok: false` and the existing `workspace_unavailable` error code. The client retains its draft and can retry after fixing the repository or base branch. Preparation errors do not create an empty failed thread or an accepted receipt. Concurrent retries share preparation, and completed receipts skip preparation. The prepared root and branch enter thread metadata and the engine session binding in the acceptance transaction.

Internal admissions, previously prepared threads, restarts, provider session opening, and checkpoint preparation can still fail after acceptance. A typed `DeliveryNotStarted` failure retains the original command input and context as a queued user message, pauses its queue for manual recovery, and records the error notice. The thread stays waiting on its queue. `queue.get` exposes the retained input after reconnect or restart; the user can `queue.edit` and `queue.resume`, or remove it and resend.

Failures whose consumption is unknown retain the existing uncertain-message behavior. They require review and explicit removal/resending rather than automatic replay. An acknowledged message never becomes runnable again because a later transport operation failed.

`fs.home` now returns both `path`, the configured home for display, and `canonicalPath`, its realpath. Clients should compare canonical project roots with `canonicalPath`. The fake daemon follows the same rule when its seeded home has a display alias.
