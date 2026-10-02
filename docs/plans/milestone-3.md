# Milestone 3: real CLIs end to end

Goal: a user sends a message from a client, the daemon drives the real provider CLI, and every client sees the agent tree, items, approvals and a correct "done", for Claude, Codex, OpenCode and Cursor.

Prerequisites: PRs #1 (core), #2 (daemon) and #3 (provider-kit) merged; ADRs 0006 and 0007 accepted.

## Workstreams and order

```
3.0 foundations ──┬── 3.1 Claude adapter ──┐
                  ├── 3.2 Codex adapter  ──┤
                  ├── 3.3 OpenCode adapter ┼── 3.5 engine ── 3.7 end-to-end check
                  ├── 3.4 Cursor/ACP adapter┘
                  └── 3.6 large payloads (ADR 0006)
```

Every workstream follows AGENTS.md (clean room, behaviour tests, `bun run check`), works in its own git worktree and branch, and opens one PR.

### 3.0 Foundations (one worker, small, first)

- New `@ace/engine-api` package (types only): `ProviderAdapter`, `Translator`, `SessionContext`, `ProviderSession`, `Frame` (moved from the recorder; the recorder imports it).
- `@ace/core`: `nextDeadline(state)`, a `process.started` fact, and `provider` in `CoreConfig` (review follow-ups from PR #1).
- One shared delta function in `@ace/projection`, used by core (PR #1/#2 follow-up).
- Expectation files `fixtures/**/<scenario>.expect.json` for every committed fixture, written from the checkpoints in `docs/research/fixtures/*.md`, plus a shared replay harness (`replayFixture(adapter, file) → {checkpoints, final}`) that adapters use in tests.

### 3.1–3.4 Adapters (four workers in parallel)

Each worker owns one package: `packages/adapter-claude`, `adapter-codex`, `adapter-opencode`, `adapter-acp` (generic ACP plus a Cursor quirks module).

- **Translator:** implements section 4 of its fixture analysis. Every fixture for that provider must meet its expectation file.
- **Session:** built on provider-kit. It uses the integration surface chosen in `docs/research/providers/<provider>.md`. Key settings:
  - Claude: SDK with the user's `claude` binary, `forwardSubagentText`, `perTaskStopAffordance`, `permissionMode: "default"`
  - Codex: `codex app-server`, `experimentalApi`
  - OpenCode: `opencode serve` with a password, plus `/global/event`
  - Cursor: `agent acp` with `_meta.subagents`
- **Capabilities** come from the discovered CLI version.
- **Opt-in live tests** (`ACE_LIVE_CLI=1`) cover the handshake only. No prompts are sent unless `ACE_LIVE_PROMPTS=1`, which spends quota and runs only when the user asks.

### 3.5 Engine (one worker, after 3.0 and at least one adapter)

ADR 0007 "Engine":

- thread actors, with the state snapshot written in the same transaction as the events;
- an intents table and worker;
- first-answer-wins resolution;
- the `nextDeadline` timer;
- session lifecycle (lazy open, idle close and resume, graceful shutdown, crash recovery on startup);
- a queue with `queue.changed`.

It replaces the stub `CommandHandler`. Tests use a fake adapter whose translator replays fixtures.

### 3.6 Large payloads (one worker, in parallel with the adapters)

ADR 0006: output streams and `output.read`, capped raw payloads with blobs, windowed snapshots with `items.page`, and the protocol, core, projection and daemon changes. It touches shared packages, so it merges before 3.5 starts, or 3.5 rebases onto it.

### 3.7 End-to-end check (orchestrator)

Run each provider once through the daemon with a real prompt (this spends quota, so only when the user approves): tool read, approval, subagent, background shell, interrupt. Compare the live thread status timelines with the fixture expectations.

## Parallelism and quota

- Up to five workers at once (3.1–3.4 and 3.6), spread across both Codex accounts so one limit can't stall everything.
- No worker sends real prompts. Quota is spent only on the workers themselves and on 3.7.
