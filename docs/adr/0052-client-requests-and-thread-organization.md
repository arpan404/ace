# 0052: Daemon-owned thread organization and client requests

Date: 2026-10-02. Status: accepted.

The web app needs authoritative organization, workspace details and service reads across devices. Keep organization in additive thread events and projections, separate from the whole-tree execution status in ADR 0004. Settle never changes execution status and auto-settle only applies to a fully done tree. Archive commits immediately and unarchive reverses it; delete is a durable tombstone that denies further execution and reads without removing replay coverage.

`Client.request()` sends schema-validated, correlated service messages directly through the connection. It uses the existing bounded request map, deadline and cancellation owner, rejects on disconnect, and never enters the intents outbox or replays a read. Existing command APIs remain durable. Add a direct health request while retaining the legacy diagnostics command. Service change messages have a bounded listener API rather than another per-service transport.

Register thread organization and workspace actions through the daemon service registry. Resolve workspace roots on the host, use the public git and forge packages, and keep script process/output ownership with the terminal service. Open-in-editor returns a validated launch descriptor for the desktop bridge; the daemon does not launch an editor on a remote client's machine. Commands with asynchronous effects use persisted admission and receipts, and report failures explicitly.

New thread creation carries account, workspace mode, base branch, model and execution options, and receipts carry its thread id. Next-turn selections reach the provider before that queued turn starts. Live metadata belongs to daemon projections, with incremental counters for agents and background work. Context-meter calculation and queue removal remain owned by queue/recovery; fork and merge and selection switching are covered by PR #69. Agent delegation/control, device streams and browser backends remain with their respective workers.

Auto-settle reads typed settings, tracks inactivity from execution events, and persists its decision. A snooze is an absolute daemon timestamp. Manual unsettle resets the inactivity deadline. PR terminal state can trigger settlement only after execution is done. Timers select indexed due rows in bounded batches and recheck current status before writing, including after restart. Clients display these persisted facts instead of evaluating their own clocks.

Plugin requests and browser messages join the canonical wire unions additively. Existing plugin trust review remains mandatory. Conductor and automations reads use their public stores and bounded progress/list APIs; unavailable execution ports report unavailable rather than simulate work. Attachment preparation before creation uses a device-owned draft scope that is explicitly adopted into the created thread, retaining attachment authorization and lifecycle ownership.

Tests cover public socket results, replay, restart, idempotency, selection delivery, organization and read correlation. They are written but not executed under the owner's merge-only test policy. Benchmarks are non-gating and unmeasured until merge.
