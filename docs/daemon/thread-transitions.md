# Fork, merge and switch commands

`thread.fork` supplies a source `threadId`, a `point` identifying a finished
`runId` or `itemId`, and the new fork's first `input` text. An optional selection
changes its provider/model. The receipt returns `forkThreadId`. Native-capable
adapters preserve their history. Unsupported exact boundaries create a portable
fork with citations and explicit omitted-history pointers. Forking a finished
point does not stop later source work. Forks inherit the source workspace; they
do not automatically create an isolated git worktree.

`ace_read_handoff` pages those pointers through MCP. `ace_read_handoff_chunk`
reads full text, reasoning and shell output in chunks of at most 32 KiB.
Cross-thread reads require a durable grant to the fork's chosen cutoff or a
merged fork's history. Grants survive prompt delivery and restart, with eight
source grants per recipient and explicit capacity errors. Unrelated threads and
streams created after a fork's cutoff are denied.

The fork thread and its root agent expose `lineage`, with the parent thread,
parent agent, chosen point, mode and `lossy` flag. `parentId` continues to describe
live execution ownership. An independent fork does not hold its source open.

`thread.merge` targets the fork and supplies a summary and citations to its items.
The daemon validates provenance and queues a synthetic context message in its
source. The next provider turn receives that context before the user's input.
An optional patch up to 64 KiB uses the git service's check/apply path. Both trees
must be quiescent. Pending patch merges guard both threads against new sends,
close their idle provider sessions, and release those guards after completion or
failure. Git conflicts are visible failures. The daemon never sends a summary
prompt on its own.

`thread.switch` supplies a new execution selection. One pending selection per
thread survives restart; the latest queued selection replaces the earlier one.
The current turn continues. The engine applies it when the whole tree is
quiescent, before later queued sends. In-flight switches cannot be replaced.
Each applied provider/model remembers its options, with 32 selections per thread
and explicit capacity errors. Omitting options restores that model's selection;
providing `{}` clears its overrides. A provider with no declared option contract
rejects nonempty options.

Within a provider, the engine configures the live session or resumes the same
native ID. Across providers, it supplies portable context and records `lossy`
plus `recommendation: "delegate_task"` for client warnings. An account switch
closes the source session, migrates its native history and lineage through the
accounts service, then resumes or forks according to the migration result.
Unsupported formats and unavailable writer-exclusion leases fail visibly. The
default accounts service still refuses migration when exclusive safety cannot
be proved; an offline embedding supplies the existing migration safety lease.

Codex supports native turn, whole-session and full-fidelity subagent forks.
Claude supports whole-session forks at its latest finished root run and exact
single-message items with a native UUID. Older Claude turn points or multi-block
items use the portable path rather than guessing a transcript boundary.
OpenCode v2, Pi and Cursor SDK integrations opt in through adapter capabilities;
no provider-name checks select their native-fork path.

New controls are registered with the daemon service registry and require
`operate` authorization. `server.ts` is unchanged. Clients consume the new
protocol fields and commands; this branch does not add visual client controls.
All behaviour tests and benchmarks need run at merge under the owner policy.
