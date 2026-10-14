# 0079: Shared provider processes

Date: 2026-10-14. Status: accepted. Refines the lifecycle section of ADR 0007 for Codex.

## Context

Every ace thread ran its own `codex app-server`. After a thread had been done for the idle
window (five minutes), ace stopped that process. The next message then paid for a cold start
(spawn, `initialize`, the permission profile catalog, `thread/resume`) before Codex saw it, and a
failure anywhere in that path showed as "Not sent".

Codex is built to host many threads in one app-server. `thread/start` subscribes the
connection, and `thread/unsubscribe` lets go of a thread without touching the others. The
provider research already recommended one long-lived app-server per Codex home
(`docs/research/providers/codex.md` §2).

## Decision

**One app-server per Codex account, shared by that account's threads.** A pool in the Codex
adapter keys live app-servers by everything fixed at spawn: the executable, the environment
(which selects the account home) and process-level arguments. Thread-level settings (cwd, model,
permissions, the ace MCP server and its bearer) already travel in `thread/start`, so they do not
split the pool.

- **Each session gets a channel, not a process.** A channel sees only the native threads its
  session opened, plus every descendant those threads reveal. Responses follow the request
  that asked for them. A frame for a thread nobody owns yet is held. The host then reads Codex's
  own ancestry (`thread/read`) and delivers the frame to the owner of the nearest owned
  ancestor. While an open is still in flight, the host waits for it to claim its thread rather
  than guess. If ancestry cannot be read, every channel receives the frame and runs its own
  discovery, as a private process would.
- **Neighbours are not rediscovered.** `thread/loaded/list` on a shared process lists every
  session's threads. A session skips threads another channel provably owns, so a turn never
  waits on reading its neighbours' histories.
- **A request that names only its turn** goes to the owner of that turn.
- **Idle release unsubscribes; it does not kill.** The engine's per-thread idle window is
  unchanged. On release, the session unsubscribes its threads and the process keeps running.
  A process with no sessions left stops after ten minutes, or at once on daemon shutdown.
- **Stopping a thread must not stop its neighbours.** Closing a session whose tree still has
  turns or shells running (delete, user stop, a failed transport) interrupts that tree first. If
  ace cannot confirm the interrupt, it stops the whole process. Priority 1 outranks the
  neighbours' uptime, and they recover through the normal exit path.
- **A crash ends every session on the process.** Each session gets
  `process.exited{deliberate:false}` exactly as before, and the next open starts a fresh
  process.
- **Initialization is replayed.** Each new channel receives the process's `initialize` frames
  first, so translation still sees `process.started`.
- **Built-in skills are projected once per daemon for Codex.** The projection is the shipped
  bundle, so sharing it changes nothing a session sees. It keeps spawn arguments identical. A
  root is replaced when its process lease is full and is removed once nothing uses it.

A session opened without a pool (direct adapter tests) still gets a private process that stops
with it, so the single-process behaviour stays covered.

## Other providers

| Provider   | Shared process?                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex      | Yes, as above.                                                                                                                                                                                                      |
| OpenCode   | Already pooled per account (ADR 0047). A session that injects ace MCP still gets its own server, because MCP registration is process-wide there. Sharing it needs per-session server names; that is follow-up work. |
| Claude     | No. One SDK `query()` is one process, and model, permissions, MCP servers and system prompt are fixed at spawn.                                                                                                     |
| Pi         | No. One process has one active session, and its control secret and MCP bearer are per process (ADR 0050).                                                                                                           |
| Cursor SDK | No for now. The SDK could hold several agents, but HOME and the API key cache are process-wide (ADR 0043).                                                                                                          |
| ACP agents | No. The protocol allows several sessions per connection, but agents resolve skills and model selection against process state (`docs/research/providers/cursor.md`).                                                 |

## Consequences

- Reopening a Codex thread after its idle release costs one `thread/resume` on a running
  process. A new thread on an account in use costs one `thread/start`.
- One Codex crash interrupts every thread on that account, where before it cost one thread.
- Backpressure is shared: the process pauses its output while any session is out of room,
  so no session loses a frame.
- Process-level stderr appears in every attached session's diagnostics.
