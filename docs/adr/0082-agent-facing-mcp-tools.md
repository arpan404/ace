# 0082: Agent-facing MCP tools: names, families and core mode

Status: accepted. Date: 2026-10-17. Refines ADR 0010 and ADR 0069 (ace tool results);
supersedes the tool surface of ADR 0071 (see ADR 0078).

## Context

ace's MCP server had grown to about 118 tools and 15k tokens of definitions. Most were one
tool per daemon operation, so agents met near-duplicates (`ace_agent_status`,
`ace_agents_status`, `ace_agent_result`, `ace_list_agents`), double-prefixed names
(`mcp__ace__ace_wait`, OpenCode's `ace_ace_wait`), undescribed fields, and one destructive
tool holding five operations (`ace_automation_manage`), so Codex asked even to list. Clients
that load tools upfront saw a dozen core tools and depended on `tools/list_changed`, which only
Pi was known to honour. The always-on instructions framed ace as optional extras.

## Decision

**Names.** Tool names are bare (`context`, `delegate`, `thread_read`). The server is named
`ace`; providers add that namespace. `bareToolName` (`@ace/provider-kit/ace-tool-names`) is the
one convention: the registry, approvals, toolsets, the always-loaded set and transcript
rendering compare bare names, so any spelling reaches one tool.

**Families.** Each tool names its guide topic. The catalogue for agents, threads, knowledge
and automations is 27 tools (ask included), down from 56:

- Core: `context` (merges status and project reads), `guide`, `delegate`, `wait`, plus the
  browser's entry point and `html_render`.
- Agents: `agents_status`, `agent_message`, `agent_cancel`, `machines`, `models`, `ask`.
- Threads: `threads_find`, `thread_read`, `thread_start`, `thread_control`, `thread_merge`,
  `queue_edit`, `question_answer`, `thread_link_pr`, `handoff_read`, `notify`.
- Knowledge: `note_add`, `note_retire`. Automations: `automations_list`, `automation_put`,
  `automation_run`, `automation_remove`.

Tools translate their input into the daemon's agent-control operations, which keep owning
authorization, ownership and durability. Actions of different risk live in different tools,
because MCP annotations are per tool: `thread_merge` and `automation_remove` are the only
destructive ones (and the only ace tools Codex prompts for); `thread_control` takes every other
change to an owned thread as an `action`.

**delegate.** One input shape: `tasks` (1 to 64), with `waitSeconds` and `waitFor` replacing
the old `wait`, `waitMs`, `await` and `timeoutSeconds`. The provider defaults to the caller's,
or to the one provider whose catalogue has the named `model`; an ACP model also resolves its
agent, installation and instance ids, so agents never pass them.

**Core mode per client.** Upfront-loading clients that reload on `tools/list_changed` (OpenCode
2.0.22, Pi) send `X-Ace-Tools: core`. Cursor's SDK 1.0.35 caches tools per connection and never
handles the notification, and ACP leaves it to each agent, so Cursor, ACP and Antigravity list
every tool: a tool a client never lists cannot be called. In core mode `guide` returns its
family's schemas inline. Tools without a family are always listed.

**Instructions and errors.** The always-on text names situations and tools (context first in an
existing project, delegate for parallel work, browser_open then a snapshot after a UI change,
thread_link_pr after opening a PR). Error hints name the agent's own next call and keep the
person only for what only they can do.

**Annotations.** Every tool has a `title`; `openWorldHint` is true only for tools that reach past
this machine. Control results are advertised as a small envelope; each tool still validates its
own data.

## Consequences

- ADR 0071's client-brokered `ace_device_*` tools are gone; `machines` and `delegate` with
  `machine` cover delegation elsewhere. Publishing files back from another machine has no
  replacement yet.
- The browser, screen and in-app simulator toolkits follow the same convention: `browser_*` (11
  tools), `screen_*` (7) and `sim_*` (7, keyed by `simId` so a simulator is never confused with a
  paired machine). Their family defaults by prefix, and transcripts recognise only their own
  bare names, so another server's `browser_click` stays that server's.
- Tests through a real MCP client check the catalogue, merged-tool behaviour, default provider,
  annotations, core-mode inline schemas, and that every tool name in the instructions and the
  agents and threads guides exists in the served catalogue.
