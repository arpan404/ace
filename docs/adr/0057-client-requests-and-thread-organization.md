# 0057: Daemon-owned thread organization and client requests

Date: 2026-10-03. Status: accepted.

The web app needs authoritative organization, workspace details and service reads across devices. Keep organization in additive thread events and projections, separate from the whole-tree execution status in ADR 0004. Settle never changes execution status and auto-settle only applies to a fully done tree. Archive commits immediately and unarchive reverses it; delete is a durable tombstone that denies further execution and reads without removing replay coverage.

`Client.request()` sends schema-validated, correlated service messages directly through the connection. It uses the existing bounded request map, deadline and cancellation owner, rejects on disconnect, and never enters the intents outbox or replays a read. Existing command APIs remain durable. Add a direct health request while retaining the legacy diagnostics command. Service change messages have a bounded listener API rather than another per-service transport.

Register thread organization and workspace actions through the daemon service registry. Resolve workspace roots on the host, use the public git and forge packages, and keep script process/output ownership with the terminal service. Open-in-editor returns a validated launch descriptor for the desktop bridge; the daemon does not launch an editor on a remote client's machine. Commands with asynchronous effects use persisted admission and receipts, and report failures explicitly.

New thread creation carries account, workspace mode, base branch, model and execution options, and receipts carry its thread id. Next-turn selections reach the provider before that queued turn starts. Live metadata belongs to daemon projections, with incremental counters for agents and background work. Context-meter calculation and queue removal remain owned by PR #72; fork and merge and selection switching are covered by PR #69. Agent delegation/control, device streams and browser backends remain with PR #70, PR #71 and PR #74 respectively. The ADR was first committed as 0052, then renumbered to 0056 above concurrently published ADRs through 0055.

Auto-settle reads typed settings, tracks inactivity from execution events, and persists its decision. A snooze is an absolute daemon timestamp. Manual unsettle resets the inactivity deadline. PR terminal state can trigger settlement only after execution is done. Timers select indexed due rows in bounded batches and recheck current status before writing, including after restart. Clients display these persisted facts instead of evaluating their own clocks.

Plugin requests and browser messages join the canonical wire unions additively. Existing plugin trust review remains mandatory. Conductor and automations reads use their public stores and bounded progress/list APIs; unavailable execution ports report unavailable rather than simulate work. Attachment preparation before creation uses a device-owned draft scope that is explicitly adopted into the created thread, retaining attachment authorization and lifecycle ownership.

Tests cover public socket results, replay, restart, idempotency, selection delivery, organization and read correlation. They are written but not executed under the owner's merge-only test policy. Benchmarks are non-gating and unmeasured until merge.

Stable turn ordinals and a paged `runs.list` read outlive the transcript window. The daemon snapshots the working tree through `@ace/git` before user delivery and after the root turn and its children finish. A following turn waits for the preceding snapshot. Checkpoint failures and interrupted boundaries are explicit; a restart never guesses a missing final revision. Existing review sources accept these checkpoint refs. Native automatic turns without a captured admission boundary report unavailable.

The persisted provider session cwd is the only execution-root authority. A new isolated request stores an unready binding until Git preparation atomically installs its worktree. Forks bind to the inherited session cwd. Client details only project this binding; actions and checkpoints reject unready bindings. Git refresh compares the binding after awaited reads and retries a changed root before publishing. Prepared directory paths are canonicalized so restart lookup finds an existing worktree even through filesystem aliases.

A thread cannot be deleted while it owns any terminal, including an exited terminal awaiting release. The terminal owner maintains a bounded per-thread count; deletion requires explicit terminal close first. Receipt lookup is device-authorized before tombstone admission, and an ID collision from another device is rejected. The fake uses the same ownership and retry rules.

Plugin catalog pages cache validated accepted snapshots by a persisted installation revision, with cross-process invalidation and a bounded component index. Warm pages perform a revision point read and page-sized metadata reads. Execution still revalidates package integrity. Inline command source names a virtual document and its physical owning manifest; CAS edits modify only a staged manifest and preserve unknown fields before requiring acceptance of its new hash.

A cached catalog never authorizes current physical source bytes. Source reads open without following symlinks and without blocking on a replacement FIFO, validate the descriptor's regular-file type and accepted length, and stream-check the accepted SHA-256 before returning a page. A changed source is rejected, including at a truncated EOF. The reader retains one 64 KiB read buffer and at most a 64 KiB page plus one UTF-8 boundary byte. Nonempty pages advance only across complete code points. Inline command pages cache validated encoded bytes by snapshot generation, capped at 2,048 entries and 32 MiB with FIFO eviction. Acceptance/removal replaces the generation and clears this cache. Editing still resolves the original manifest and requires a new trust review.

Context mention reads use the same persisted execution binding as scripts, Git and checkpoints. An unready isolated binding cannot fall back to the registered project. Draft adoption continues to authorize against the logical project root; composition reads the actual prepared execution root.

Integration train 3 keeps these services in the named startup graph: workspace actions initialize before engine admission; preview, organization, automation and conductor initialization follow endpoint publication. Optional failures degrade by service name. Context combines draft ownership and execution-root authority with the agent-control family reference policy and queue attachment retention. The ADR moved to 0057 because main allocated 0056 to in-app devices, now [ADR 0064](0064-in-app-devices.md).

### Moving between projects

`thread.move` changes registration and execution together while preserving history and
organization, including pins. It refuses the same live work and terminal ownership as
delete, and refuses isolated/inherited nonlocal execution roots. It never transfers Git
branches or worktrees. Idle managed sessions close through the existing workspace fence;
the new cwd, cleared resume id, events and receipt commit atomically. The next session
receives a history handoff. See [thread moves](../daemon/thread-move.md).

Clients offer it as Move to project… in every thread menu, the selection bar and ⌘K. Like the
other organize actions it shows the thread in its new project at once, offers Undo (a move
back), and puts it back with the daemon's reason when refused.
