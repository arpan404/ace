# 0086: Agent-facing MCP tools: names, families and core mode

Status: accepted. Date: 2026-10-17. Refines ADR 0010 and ADR 0069 (ace tool results);
supersedes the tool surface of ADR 0071 (see ADR 0078). Its browser tools follow the tab model
of ADR 0083. (Drafted as 0082; renumbered because ADR 0082 is browser annotation.)

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
- The browser, screen and in-app simulator toolkits follow the same convention: `browser_*` (12
  tools), `screen_*` (7) and `sim_*` (7, keyed by `simId` so a simulator is never confused with a
  paired machine). Their family defaults by prefix, and transcripts recognise only their own
  bare names, so another server's `browser_click` stays that server's.
- Tests through a real MCP client check the catalogue, merged-tool behaviour, default provider,
  annotations, core-mode inline schemas, and that every tool name in the instructions and the
  agents and threads guides exists in the served catalogue.

## Browser tabs (ADR 0083)

ADR 0083 gave each thread's browser real tabs with per-tab queues, control leases and SQLite
restore, and gave agents tab tools. The consolidated surface keeps them in two places:

- `browser_tabs {action: list | open | select | close}` mirrors the daemon's `tabs` command.
  `list` (the default) is read-only and reports each tab's `openedBy`, `drivenBy`, label,
  lease while a person holds it, lifecycle and pending dialog, with `current` on the caller's
  tab; private tabs show no address or title. `open` takes `url` and `label`. Closing is not
  destructive: closing a person's shared tab in their own Chrome only releases it, and a tab a
  person holds refuses agents through its lease.
- Every page tool takes `tabId`. Without it a call runs in the caller's current tab, keyed by
  the MCP scope's agent; `browser_open` claims the caller's own tab and returns its `tabId`.
- Main's separate tools fold in: `fill_form` and point clicks into `browser_act`, PDF into
  `browser_screenshot {format: "pdf"}`, downloads into `browser_logs {kind: "downloads"}` and
  `browser_wait_for {downloads: true}`, extension listing into `browser_settings`, closing a tab
  into `browser_tabs`. `browser: "user"` (ADR 0084) and `machine` stay optional on every tool.

## Addendum: `tools_find` and `tools_call` (2026-10-17)

Listing every tool to Cursor, ACP and Antigravity made their first request carry the whole
catalogue (44 tools and about 11k tokens with the browser and computer use on), and a model
choosing among 44 tools picks worse than one choosing among a dozen.

**`tools_find {query, limit?, family?}`** is listed to every client and loads upfront in Claude
Code. It ranks only the tools this session could call (capabilities, groups that are off and
`ask` availability already applied) against the query: stemmed words from each tool's name,
title, description, family and field descriptions, a small synonym table ("Safari" → app,
"tap" → click) and rarer words weighted higher. The ranking is pure and deterministic
(`tool-search.ts`). Each match carries its name, title, purpose, family, effect and full input
schema, so the next call needs no second lookup. In core mode a search also opens the families
it returned, the way reading a guide does.

**Listing per client.** `X-Ace-Tools` now takes three values:

- no header (Claude Code, Codex): every tool, with `tools_find` beside their own tool search.
  `tools_call` would only duplicate a direct call there, so it is not offered.
- `core` (OpenCode, Pi): the core tools plus `tools_find`, growing on `guide`, entry points and
  searches. These clients reload, so a found tool becomes a listed tool with its own
  annotations. `tools_call` is not offered, because it would replace each tool's accurate
  annotations with its own destructive one.
- `static` (Cursor's SDK, ACP over HTTP and the stdio bridge, Antigravity): the core tools,
  `tools_find` and `tools_call`, about a dozen tools, and the list never grows.

**`tools_call {name, arguments}`** runs the named tool through the server's direct call path:
the same registry lookup, capability and group checks, schema validation and error text,
timeouts, cancellation and result, `isError` and hints included. It refuses `tools_find` and
itself. Approvals, transcript rows, evidence and private-input redaction treat it as the tool
it ran (`dispatchedAceCall` in `@ace/provider-kit/ace-tool-names`), so the person approves
"thread_merge", not "tools_call".

**Trade-off: `tools_call` is marked destructive.** MCP annotations are per tool, and this one
can reach `thread_merge` and `automation_remove`. Marking it `destructiveHint: true`,
`readOnlyHint: false` keeps a client that gates destructive tools asking before such a call; the
cost is that it also asks before a dispatched read. ace adds no gate of its own (ADR 0002), so
under-declaring would let a destructive call through unasked. Clients that list tools
individually keep per-tool annotations, which is why `tools_call` is offered only where the
list cannot grow.
