# Move a thread to another project

Send a durable command with payload
`{ type: "thread.move", threadId, workspaceId }`. It requires the thread's
existing operate authority and a registered destination. It does not register,
clone or move folders. The receipt returns the same thread id.

The daemon first settles what dead work left behind: exited or externally killed
terminals are closed, and a thread whose provider is no longer running is marked
stopped, with its orphaned approvals and controls retired. It then refuses a live
tree, a live terminal, or durable input that can still run. An isolated worktree or a session
whose execution root differs from the old project's root returns
`thread_move_requires_local_workspace`. Switch that thread to local mode first.
There is no branch or worktree transfer between repositories.

A local thread retains its transcript, runs, lineage, organization, read state,
pin and pin order. `thread.updated.workspaceId` moves it between project groups;
its updated timestamp orders it as a recent change. A following
`thread.client.updated` replaces its current workspace details. Old branch, HEAD,
base branch, repository, PR and diff metadata are cleared and later refreshed
from the destination. Historical events and checkpoint records remain unchanged.

For an engine-managed thread, the existing workspace fence closes the thread's idle session
and captures a history handoff before rebinding execution. The destination cwd,
cleared native resume id, move events and successful command receipt commit in
one SQLite transaction. New sends use a fresh provider session in the destination.
A restart cannot observe a committed move with the old execution binding. A crash
before that commit leaves the existing workspace-change fence and uncertain
action receipt, so execution stays blocked pending explicit recovery.

Other threads in either project retain their sessions and terminals. Root reservations
still serialize this rebind against concurrent Git/worktree changes. Pending peer inputs
are woken when the reservation is released.

A thread with no engine session moves atomically without starting a provider.
Moving to its current registered project is a successful no-op. The fake daemon
implements the same busy checks, event pair, metadata replacement and pin rules.
