# Runtime Architecture

## Summary

ace runs as one native desktop process. GPUI owns the main thread. A background
Tokio runtime owns provider processes, the local HTTP/WebSocket server,
persistence, projection workers, and stream fanout.

The active architecture is not a direct port of `.old/ts-port/`. The archive is
reference-only material for behavior and migration clues. New Rust code should
replace old boundaries when doing so improves performance, reliability, or
maintainability.

## Process Model

Desktop startup:

1. Resolve OS paths, config, logs, and persisted auth token.
2. Open SQLite, run migrations, and recover projection checkpoints.
3. Start the runtime supervisor and background Tokio runtime.
4. Start the local HTTP/WebSocket server.
5. Start GPUI on the main thread.
6. On shutdown, cancel runtime tasks, stop provider child processes, flush event
   writes, and close the UI.

GPUI sends typed commands to the runtime and subscribes to compact projection
deltas. Render code reads prepared view models only.

## Event-Sourced Core

Commands enter the runtime, are validated, receive command receipts, and produce
ordered domain events. Events append to SQLite before updating projections.

The event store uses SQLite WAL mode with monotonic sequence numbers, command
receipts, provider session records, settings/device auth records, and projection
checkpoints. Startup replays only events after the latest valid checkpoint.

Projection workers maintain compact read models for shell/sidebar state, thread
detail, provider activity, terminal/log windows, device/server status, and the
provider capability catalog.

## Provider Runtime

Provider support is centralized around a `CliRuntime` that owns process
lifecycle, stdin/stdout/stderr IO, cancellation, restart policy, logging, queue
limits, session registry, and resource limits.

Provider protocol drivers translate native provider protocols into canonical
runtime events:

- `CodexDriver` handles Codex app-server JSON-RPC.
- `ClaudeCodeDriver` handles Claude Code structured messages.
- `CursorDriver` handles Cursor ACP.

Drivers do not own persistence, UI state, WebSocket fanout, or app
orchestration. Those concerns belong to the runtime and projection layers.

Provider capabilities are versioned descriptors rather than scattered branches.
Descriptors cover resume/fork/multi-thread support, subagents, background
agents, tool approval modes, structured user input, attachments, model/options
switching, provider-native slash commands, parallel turns/tasks, rollback,
history access, token usage, and context usage.

## Server And Mobile Path

The desktop app hosts the local server in-process.

- Default bind: `127.0.0.1:3773`.
- Explicit LAN mode binds `0.0.0.0:3773`.
- All non-health endpoints require token auth.
- Initial routes are `GET /health`, `GET /api/status`, `GET /api/config`, and
  authenticated `GET /ws`.

Future mobile apps are remote clients of the desktop host. They send commands
and receive projection deltas through the same versioned protocol. They are not
second runtime owners.

## Backpressure And Resource Control

- All internal channels are bounded.
- Durable domain events are never dropped.
- UI deltas may coalesce.
- Remote clients resume streams by sequence cursor.
- Slow clients that exceed bounded lag are disconnected cleanly.
- Provider child processes have cancellation, restart, log, and resource limits.

## Performance Policy

Hot paths require benchmarks or documented measurements before completion. This
includes event append/replay, projection reducer throughput, protocol
serialization, WebSocket fanout, terminal/log parsing, provider stream
normalization, and large GPUI view-model updates.

