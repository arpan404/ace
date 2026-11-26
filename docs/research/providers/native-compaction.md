# Native context compaction per provider

Researched 2026-11-25 for `thread.compact`. ace asks only for a provider's own compaction; it
never prompts a model to summarise in its place. A provider with no native request gets no
compact control at all.

| Provider | Native compaction                                       | ace                      |
| -------- | ------------------------------------------------------- | ------------------------ |
| Claude   | Agent SDK `/compact` prompt                             | yes (`compaction: true`) |
| Codex    | app-server `thread/compact/start`                       | yes (`compaction: true`) |
| OpenCode | `POST /api/session/{id}/compact`                        | yes (`compaction: true`) |
| Pi       | RPC `{"type":"compact"}`                                | yes (`compaction: true`) |
| ACP      | only an agent-advertised command; none recorded         | no                       |
| Cursor   | none in the Cursor SDK; `compaction_update` is a notice | no                       |

## Claude Code

The published Agent SDK documents `/compact` as a built-in command dispatched by sending
`/compact` in the prompt, and its result as a `system/compact_boundary` message with
`compact_metadata.pre_tokens`, `trigger` and `post_tokens`:
<https://docs.claude.com/en/api/agent-sdk/slash-commands#compact-history-with-compact>.

ace dispatches `/compact` on the open streaming-input session as a synthetic user message
(`packages/adapter-claude/src/session.ts`), so it is Claude's own compaction. The echo of the ask
is dropped (`isCompactCommand`, `packages/adapter-claude/src/compaction.ts`), and the existing
translator turns `system/status{status:"compacting"}`, `system/compact_boundary` and the synthetic
summary turn into one `compaction` item with `tokensBefore`/`tokensAfter` and the summary.

## Codex

The app-server's documented control request is `thread/compact/start`, which returns `{}` and runs
a compaction turn whose items surface as `contextCompaction`; the turn is not steerable. Sources:
ace's provider research `docs/research/providers/codex.md` §7 (Codex protocol docs lines 841-850),
and Codex's open-source app-server protocol. ace sends `{"threadId"}` on the session's existing
app-server connection (`packages/adapter-codex/src/compaction.ts`); the translator already
renders `contextCompaction` items.

## OpenCode

OpenCode's server compacts a session in place with `POST /api/session/{id}/compact` (the v2
client's `session.compact`), answered with a durable `compaction` inbox item and published as
`session.compaction.started|ended|failed` with the summary `text`. The older v1 route was
`POST /session/:id/summarize`. Sources: `docs/research/providers/opencode.md` §7 and §2,
`docs/research/providers/opencode-v2.md`, and `@opencode/client` 2.0.22's generated client
(`/api/session/${id}/compact`). ace calls the SDK's `session.compact` and translates the events
into a `compaction` item (`packages/adapter-opencode/src/session.ts`, `translator.ts`).

## Pi

Pi's RPC commands include `{"type":"compact"}`; its response carries `summary`,
`firstKeptEntryId`, `tokensBefore` and `estimatedTokensAfter`, and the run also emits
`compaction_start` / `compaction_end` (with the same result). Sources: installed
`@earendil-works/pi-coding-agent` 0.85.1 `docs/rpc-commands.md#compact` and `docs/json.md`
("Compaction events"). ace sends the RPC on the session's process and waits up to 30 minutes
because Pi answers when the summary is written; the translator emits one `compaction` item from
`compaction_end` and starts/ends the thread's turn around a manual, idle compaction so the work
card says "Compacting context".

## ACP

The stable ACP protocol has no compaction request. It has `session/update`'s
`available_commands_update`, so an agent that advertises a user-invocable `compact` command could
be asked by sending it as a prompt. No agent ace records advertises one (Cursor's ACP server
included), so ace declares no compaction capability for ACP. If a session's commands later
include one, this can be revisited with a per-session capability.

## Cursor

Cursor's SDK has no compaction request. The ACP schema's `compaction_update` is an unstable
notification from the agent, not a client request (see `docs/research/providers/cursor.md`). ace
declares no compaction capability for Cursor.
