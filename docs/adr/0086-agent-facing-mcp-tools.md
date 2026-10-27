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
change to an owned thread as an `action`, and `automation_run` takes run, pause and resume the
same way.

**delegate.** One input shape: `tasks` (1 to 64), with `waitSeconds` and `waitFor` replacing
the old `wait`, `waitMs`, `await` and `timeoutSeconds`. The provider defaults to the caller's,
or to the one provider whose catalogue has the named `model`; an ACP model also resolves its
agent, installation and instance ids, so agents never pass them.

**Core mode per client.** Upfront-loading clients that reload on `tools/list_changed` (OpenCode
2.0.22, Pi) send `X-Ace-Tools: core`. Cursor's SDK 1.0.35 caches tools per connection and never
handles the notification, and ACP leaves it to each agent, so Cursor, ACP and Antigravity list
every tool: a tool a client never lists cannot be called. In core mode `guide` returned its
family's schemas inline (superseded by "Schemas are paid once" below). Tools without a family
are always listed.

**Instructions and errors.** The always-on text names situations and tools (context first in an
existing project, delegate for parallel work, browser_open then a snapshot after a UI change,
thread_link_pr after opening a PR). Error hints name the agent's own next call and keep the
person only for what only they can do.

**Annotations.** Every tool has a `title`; `openWorldHint` is true only for tools that reach past
this machine. Control tools advertise no output schema (the generic envelope told a model
nothing its result does not); each tool still validates its own data. Advertised input and output
schemas drop bounds a model never approaches, ace's internal `x-ace-constraint` notes and closed
objects, and spell string-choice and discriminated unions flat (`advertised-schema.ts`).

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
catalogue (45 tools with the browser and computer use on, 12 of them browser tools since ADR 0083), and a model
choosing among 45 tools picks worse than one choosing among a dozen.

**`tools_find {query, limit?, family?}`** is listed to every client and loads upfront in Claude
Code. Claude's always-loaded set is `context`, `guide`, `delegate`, `wait` and `tools_find`
(2026-10-20): `browser_open` and `html_render` are deferred, since many sessions never use them,
and Claude's guidance line tells it to load them by exact name (`select:mcp__ace__browser_open`)
before calling. Core and static clients keep both in their core list: they have no tool search,
and reaching them through `guide` or `tools_call` would add a step to the most common UI check. It ranks only the tools this session could call (capabilities, groups that are off and
`ask` availability already applied) against the query: stemmed words from each tool's name,
title, description, family and field descriptions, a small synonym table ("Safari" → app,
"tap" → click) and rarer words weighted higher. The ranking is pure and deterministic
(`tool-search.ts`). Each match carries its name, title, purpose, family and effect, plus its
input schema wherever the session's own list would not bring it (see "Schemas are paid once"
below). In core mode a search also opens the families it returned, the way reading a guide does.

**Listing per client.** `X-Ace-Tools` now takes three values:

- no header (Claude Code, Codex on a model with tool search, claude-agent-acp, Antigravity, and
  Cursor since 2026-10-27): every tool, with `tools_find` beside their own tool search.
  `tools_call` would only duplicate a direct call there, so it is not offered.
- `core` (OpenCode, Pi, Gemini CLI over ACP): the core tools plus `tools_find` and `tools_call`,
  growing on `guide`, entry points and searches. These clients reload, so a found tool becomes a
  listed tool with its own annotations. The reload can land a model step late (OpenCode
  debounces it, then lists again), so `tools_call` reaches a found tool until it is listed.
- `static` (other ACP agents over HTTP and the stdio bridge; Cursor's SDK until 2026-10-27): the core
  tools, `tools_find` and `tools_call` (12 tools with the browser and computer use on), and the
  list never grows. Static is the conservative default for an ACP agent not known to reload,
  not a claim that it never refreshes.

**Schemas are paid once (2026-10-20).** A core client's reload delivers every listed tool's
schema, so `guide` and `tools_find` there return names, purposes and how to call them, never
the schemas again (a browser guide read cost 7,945 tokens in core against 2,635 elsewhere).
Static clients cannot reload and keep inline schemas. Codex lists every tool but its code-mode
models see only `exec` and call `tools.mcp__ace__<name>(args)` without a schema; it sends
`X-Ace-Client: codex`, and `guide` and `tools_find` return it the schemas and that call form.
The rule lives in one place (`tool-delivery.ts`). Codex's developer prefix adds a short recipe
(call ace from `exec`, ace's `wait` is `tools.mcp__ace__wait`, filter `ALL_TOOLS` or ask
`tools_find` for a schema) and the bare names this session can call, folded by family and capped
near 300 tokens, so it stops dumping `ALL_TOOLS` before its first ace call.

**Per-ACP-agent listing.** The daemon picks the listing by the reviewed CLI behind an ACP agent
(`acpToolListing`): Gemini CLI (it reloads on `tools/list_changed`) is core, claude-agent-acp (the
Claude Agent SDK defers behind its tool search) lists every tool, and every other agent stays
static. The stdio bridge carries the choice in `ACE_MCP_BRIDGE_TOOLS`. Always-loaded tools also
carry `antigravity/alwaysLoad`.

**Claude without tool search (2026-10-27).** Claude Code defers MCP tools only while its tool
search is on; otherwise it loads every listed tool in full, and ace's whole catalogue (52 tools,
about 17,200 tokens) would ride on every request. Read from Claude Code 2.1.311's bundle and its
MCP docs, the CLI decides per request:

- off when `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is set (only managed settings force it back)
  or in a HIPAA session;
- off when `ENABLE_TOOL_SEARCH` is false-like (`false`, `0`, `no`, `off`) or `auto:100`; on when
  unset, true-like, `auto:0` or unrecognised; `auto` and `auto:N` turn it on only once deferred
  tools reach N% (default 10) of the context window;
- off when `ToolSearch` is denied or left out of the tool set;
- off for models whose name contains `claude-3-opus`, `claude-3-sonnet`, `claude-3-haiku`,
  `claude-3-5-sonnet`, `claude-3-5-haiku` or `claude-3-7-sonnet` (a remotely updatable list),
  and on Vertex for Claude 3 and pre-4.5 models;
- learned at run time on Foundry deployments hosted on Azure and behind a gateway
  (`ANTHROPIC_BASE_URL` not `api.anthropic.com`, or `CLAUDE_CODE_USE_GATEWAY`): a refused
  `defer_loading` makes the CLI resend without tool search and keep it off for the conversation.
  Before 2.1.304 a custom base URL meant off unless `ENABLE_TOOL_SEARCH` said on.

Settings `env` applies over the launch env. Claude Code refreshes its tool list on
`tools/list_changed`, in `-p` and SDK sessions too. So the adapter reads the launch env, the
settings files it loads and the model (`claudeToolSearchFacts`), and `claudeToolListing` gives the
session the core listing whenever tool search is off or only settled at run time; the core list
works under tool search as well. A model switch is checked again and can only narrow the listing:
ace's server is reconnected with the core header and every later MCP replacement keeps it. The
narrowing counts only once Claude Code accepts the new MCP set; a failed reconnect is retried on
the next model switch, turn or MCP replacement until one succeeds. Every replacement, a
caller's or ace's reconnect, runs one at a time and is built when it runs from the latest intended
set, so a reconnect never drops a server a caller has just added. The system prompt cannot
change mid-session, so Claude's guidance line names both ways in: its tool search, or with none,
`tools_call {name, arguments}`, which the core list offers.

claude-agent-acp (0.97.0) runs the same CLI through the Agent SDK, with the person's settings,
its own `env` and, after `providers/set`, a gateway's base URL; it can also drop the built-in
tools (`disableBuiltInTools`), which removes `ToolSearch`. It does not defer in every config, so
the daemon decides its listing with the same rules from its launch env, settings and the
thread's model (`engine_sessions.model`, `acpClaudeToolListing`). ACP fixes a session's MCP
servers when it opens, so a later model switch cannot narrow the list; a session with no model
known at launch starts on core.

**Codex defers only with tool search (2026-10-27).** Read from Codex 0.163.0's source (tag
`rust-v0.163.0`: `core/src/tools/spec_plan.rs`, `core/src/mcp_tool_exposure.rs`,
`models-manager/src/manager.rs`, `model-provider/src/amazon_bedrock/runtime_catalog.rs`,
`rmcp-client/src/logging_client_handler.rs`, `tools/src/json_schema.rs`):

- Codex defers MCP tools only when the turn's model metadata has `supports_search_tool`.
  Otherwise it loads every listed tool in full on every request, as function tools or, on
  code-mode-only models, as declarations in `exec`'s description. A person's `omit_tools_from` or
  `code_mode.direct_only_tool_namespaces` can also force tools direct.
- The metadata comes from Codex's catalog: the longest slug the model name starts with, retried
  after one `provider/` segment, for Codex's own catalog and a `model_catalog_json` file (which
  wins); an exact slug match for a provider's `model_catalog_url`. Every bundled model has search.
  A model outside the catalog (Ollama or LM Studio under `--oss`, a custom provider's own names, a
  dated name under a catalog URL listing only the base slug) gets fallback metadata without it,
  and `amazon-bedrock-runtime` turns it off for every model. A custom catalog's entries set
  `supports_search_tool` themselves and `model/list` does not return it, so ace treats a model
  found there as unknown. `features.code_mode_only_strict_3p_tools` keeps MCP tools deferred
  on code-mode-only turns regardless. The auth mode only filters what `model/list` shows.
- The tool mode is the model's own (the gpt-5.6 and gpt-6 families are code-mode-only), else
  `features.code_mode_only` or `code_mode`, both off by default, so gpt-5.5 runs without `exec`
  and reaches deferred tools through `tool_search`. Both facts are read per turn, so a model
  switch can move a thread between modes. Codex fixes a server's tools when it connects, only
  logs `tools/list_changed`, and `config/mcpServer/reload` re-reads only `config.toml`.
- Server instructions become the tool namespace's description; ace sends Codex none
  (`X-Ace-Instructions: native`). Skills are listed with name, description and path.
- Function calls are never strict. Codex keeps `type`, `description`, `enum`, `items`,
  `minItems`, `properties`, `required`, `additionalProperties`, `anyOf`/`oneOf`/`allOf` and
  `$ref`/`$defs`, turns `const` into `enum`, drops every other keyword (`default`, `format`,
  `pattern`, lengths, `minimum`/`maximum`, `maxItems`, `title`) and strips descriptions from a
  schema over 5,000 bytes. ace's largest tool definition is under 2,600 characters.

So the adapter reads `config/read` and `model/list` before the thread starts
(`codexToolListing`), under one 2.5-second deadline: both are local reads that take
milliseconds, and only a cold catalog goes online under Codex's own 5-second limit. The catalog is
read beside the config on an app-server that has none yet, skipped where the config decides
(Bedrock Runtime, Codex's default model), and kept per app-server keyed by the provider, catalog
file and URL. A fact it cannot read, or that misses the deadline, keeps every tool listed, and a
late catalog read still fills the cache. A session whose model would load every tool connects
with the fixed list and pays about 2,910 tokens per request instead of the catalogue (about
10,050 plus guidance). Codex never asks under ace's read-only access (approval policy `never`)
and refuses a prompted tool there, so on that list `tools_call` is approved like the other ace
tools and refuses destructive targets, and `automation_remove`, the one destructive tool, is
listed by name with Codex's prompt (about 60 tokens; a second, prompted dispatcher would cost
more). Codex's prefix, `guide` and `tools_find` also name the way in without
`exec` (its `tool_search`, then `mcp__ace__<name>`) and, on the fixed list, `tools_call`. A
switch from a catalog model to one without search mid-thread still loads every tool until the
session reopens, since Codex cannot replace a thread's MCP entry.

**Antigravity loads on demand (2026-10-20).** Checked live on the Antigravity CLI (`agy`) 1.4.2:
it loads in full only the MCP tools whose `_meta` carries `"antigravity/alwaysLoad": true`. Every
other tool's definition is written to `~/.gemini/antigravity-cli/mcp/<server>/<tool>.json`; the
agent reads that file, then calls the tool through its generic `call_mcp_tool` (`ServerName`,
`ToolName`, `Arguments`). ace reaches Antigravity through `agy_acp_server`, the same harness, and
the ACP binary reads the same key. So Antigravity lists every tool, like Claude, and no longer
pays about 2,700 tokens of core schemas per request; its per-request ace context fell from about
3,200 to 2,100 tokens. Its guidance line says deferred ace tools are reached with
`call_mcp_tool` (server `ace`) after reading their definition. It shares Claude's always-loaded
set.

**OpenCode 2.1.4 and Pi 1.4.0 (2026-10-27).** Read from the installed OpenCode 2.1.4 binary's
bundled source and Pi 1.4.0's package (`dist/core/agent-session.js`, `dist/extensions/codemode`,
`pi-ai/dist/api`, `docs/mcp.md`, `docs/extensions.md`, CHANGELOG). Both keep the core listing:

- OpenCode sends every direct MCP tool's schema on every request and reloads on
  `tools/list_changed` after a 100 ms debounce. Its Code Mode, on by default per MCP server, puts
  tools behind an `execute` script tool: the catalog shows each tool's full TypeScript signature
  (input and output types) within about 2,000 tokens shared with OpenCode's own tools, the rest
  found by `search()` inside a script, and nested calls reach the transcript only as `execute`
  metadata. That is no cheaper than ace's core list and loses ace's per-tool rows and approvals,
  so ace keeps `codemode: false`. OpenCode rewrites tool schemas per model only for Gemini
  (required trimmed to known properties, tuple items, inlined refs) and Kimi (a type beside an
  untyped enum); ace's advertised schemas pass both unchanged. It shows MCP server instructions
  (without an `execute` line when Code Mode is off) whenever one of the server's tools is allowed,
  and its Plan agent (ace's read-only) denies only edits, so ace's tools stay listed there.
- Pi has had `codemode`, `tool_search` and an extension tool `exposure` since 0.99. Its tool
  search lists no names (a query finds deferred tools), so it is no cheaper than ace's core list
  with `tools_find`. While codemode is active (on by default once any of the person's MCP servers
  connects), Pi hands active `direct` tools to scripts: it appends a script-call note to each
  description, or with `codemode.mode: "only"` hides them behind its scripts. ace's extension now
  registers its tools `model-only` (declared, never script-callable), passes ace's MCP hints as
  Pi `annotations` for permission extensions, and, because the server's `tools/list_changed` can
  land after the call's result, reloads its list before returning a call that may open a family,
  so Pi's next request already declares it. That wait ends after one second or on interrupt;
  the reload keeps going and list_changed applies it when it lands. Pi sends ace's schemas unchanged on every provider
  (Gemini `parametersJsonSchema`, OpenAI strict only for tools that opt in); its Anthropic path
  keeps only a root's `type`, `properties` and `required`, and no ace tool has other root keys.
  `--tools` patterns still filter extension tools.

Per-request ace context is unchanged by these fixes as measured (OpenCode about 2,650, Pi about
2,880 tokens); a Pi session with codemode active no longer pays about 15 tokens of script-call
note per declared ace tool.

**Cursor lists names only (2026-10-27).** The 2026-10-17 reading that Cursor loads MCP tools
upfront was wrong. Read from `@cursor/sdk` 1.0.35 (what ace pins) and 1.1.0 (`dist/esm`,
`McpSdkClient`, the request-context builder and `McpMetaToolOptions`), cursor-agent 2026.10.01,
the recorded SDK fixture `fixtures/cursor-sdk/1.0.35/composer-2.5/nested-task.jsonl` and
Cursor's own transcripts on this machine:

- The local runtime turns Cursor's MCP meta tool on (`mcpMetaToolEnabled ?? true`; no public
  option changes it). The model then sees, per server, `<mcp_meta_tool_server name tools="a, b"
serverUseInstructions>`, with names and the server's instructions but no descriptions or schemas.
  It reads schemas with `GetMcpTools` (a whole server, one `toolName`, a name `pattern`, or the
  catalogue) and calls with `CallMcpTool {server, toolName, arguments}`. Every recorded MCP call
  went through these two. Nothing in the SDK or CLI varies this by model; Cursor's servers build
  the prompt, so a server-side exception for some model can't be ruled out from shipped code.
- Schemas reach the model as JSON text in a `GetMcpTools` result, never as function
  definitions, so no model's function-schema subset applies to ace's schemas.
- Each server's list is fetched once per connection and cached. A `CallMcpTool` for a name that
  list lacks fails with `McpToolNotFoundError`. 1.1.0 notes `tools/list_changed` but nothing acts
  on it; it also keeps a server's valid tools when one is invalid, where 1.0.35 loses the list.

So Cursor gets every tool (`cursorToolListing`): each costs its name, and each is called directly
with its own annotations instead of through `CallMcpTool` wrapping `tools_call`. Its guidance
line names `GetMcpTools` and `CallMcpTool`. Measured per request, Cursor's ace context is about
1,140 tokens (185 of them the 52 names). The old budget of 2,900 counted the static list's 12
schemas (about 1,900 tokens), which Cursor never loaded; its real cost was about 980. ace keeps
its guidance in Cursor's always-applied rule rather than as server instructions: the same text
at the same cost. A group turned on mid-session stays out of Cursor's cached list until the next
session, as for Antigravity.

**Guidance per session.** The shared server text stays the same for everyone and under 315
tokens. What differs goes in the provider's own channel, rendered once per session so its
cached prefix holds: how to reach a tool the list may lack (Claude's tool search by exact name,
`select:mcp__ace__thread_start`; Antigravity's `call_mcp_tool`; core's `guide` or `tools_call`;
static's `tools_call`), and in a
read-only session which ace read tools still work. ACP's text is rendered by the daemon, which
knows the agent's listing, and handed to the adapter.

**`tools/list_changed` reaches only the session whose list changed.** A core session that opens
a family is told; every other session keeps its list and its provider's prompt cache. Listen
streams are tied to the lease of the request that opened them; legacy streams are matched by
lease. Changes that concern every session (a group turned on or off) still reach all.

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
list is incomplete: a core client calls a found tool directly once its list reloads.

## Addendum: a smaller always-on surface (2026-10-27)

Measured with `mcp-agent-budget.process.test.ts` (characters / 4, browser and computer use on),
Claude paid about 2,620 tokens of ace context on every request: guidance and session facts,
the skill listing, five always-loaded schemas and the deferred names. It now pays about 1,540,
and the whole catalogue a client pays when it loads every tool fell from about 17,200 to about
10,050 tokens (68,776 to about 40,000 characters), with browser, computer-use and simulator
descriptions cut by 45% and their detail moved into the guides.

**Claude loads only `context` and `delegate` upfront.** Claude Code and the Claude Agent SDK
search deferred tools themselves and list ace's guides as skills, so three of the five
always-loaded tools duplicated something Claude already has:

- `tools_find` was a second search. Claude cannot call a tool it found that way until it loads
  it with its own tool search, so the ace search added a step without making one unnecessary,
  and its schemas in the result were never usable directly. Claude's own search ranks the same
  names and descriptions; its guidance line now says to load ace tools "by task or exact name".
- `guide` returned the same bodies as the skills Claude lists; Claude's guidance says to use the
  skill wherever ace says `guide <topic>`. Offshift, which is not a skill, loads `guide` by name.
- `wait` serves only a later collection: `delegate {waitSeconds}` waits in the same call.

Each still loads by exact name in one step. Antigravity has neither a search nor skills, so its
own key keeps all five. `anthropic/alwaysLoad` and `antigravity/alwaysLoad` are now separate
sets (`registry.ts`).

**Guide topics are listed once per channel.** The shared guidance names the five families; the
`guide` tool's enum names every guide, and its description no longer repeats them. Skill
descriptions say what each is for and when, in about half the words.

**Compaction rules (`advertised-schema.ts`), for every client.** Each rule only removes keywords,
so the advertised schema stays valid in the strict subsets Gemini and OpenAI models accept, and
the registry keeps validating against the full Zod schema:

- string `pattern`s and every string length, except a pattern marked `keepPattern` because it is
  the field's only list of allowed values (`screen_input` and `screen_measure` key names);
- a `minimum` of 0 or 1, a `maximum` of 1,000 or more;
- `minItems: 1`, and a `maxItems` of 32 or more or at least the size of the item enum;
- a `description` that only restates the field's default or enum values;
- a union of one item or a list of the same item, advertised as the list (the bare item still
  decodes as a bare item).

`type` stays beside every `enum`: Gemini's schema subset (Antigravity, Gemini CLI, and OpenCode or
Pi on Gemini models) refuses an enum without one, and no client tells ace which model it runs, so
the saving is not worth a per-client branch. A call that breaks a dropped bound gets an
`invalid_arguments` issue naming it (`array <= 64 in length`, `a string matching /^…$/`), so one
retry fixes it.

**`models` returns one compact roster.** The default call lists every provider's current models
in one result (about 1,500 characters on a realistic install, down from 5,400 for the first of
five pages): models sharing efforts and serving accounts are one set, each account is listed
once with only its unusual fields, and superseded releases are counted in `omitted`. When the
accounts serving one model offer different efforts or default efforts, each group of accounts
gets its own set naming them, so every advertised effort is one `delegate` accepts on that
account. A model is superseded only when every account that serves it says so, so an account's
newest release stays listed even when another account has a newer one. Large catalogues show
the newest current release of up to eight lines across all accounts, in catalogue order, plus
every favourite, default and the caller's model on top of those eight; a pinned older release
never takes its line's place or one of the eight. A provider states one `default` only
when every account agrees, judged on the whole catalogue even for a query, else each account
states its own. A set names a serving account by its label only when `delegate` would resolve
that label to the same account, else by its id. `query` searches every account and every
release; `delegate` still takes any catalogue model. The roster reads every page of every
account (`agents.models`), so a second account's models are never cut off by paging.

**Budgets.** `mcp-agent-budget.process.test.ts` holds each provider's per-request cost and
`mcp-catalogue-budget.process.test.ts` the whole catalogue, any single tool and a Claude session
without tool search, each at the measured cost rounded up to the next 50 tokens.

**ACP agents re-read (2026-10-27).** Read from the installed agy 1.4.8 binary and its changelog,
the registry's agy_acp_server 1.4.3 (its Python sources and bundled harness), Gemini CLI 0.43.0's
bundle and Qwen Code 0.0.14's package, without starting a session:

- Antigravity's on-demand loading is unchanged: `antigravity/alwaysLoad` (added in agy 1.3.3)
  marks a tool eager, every other tool's definition goes to `<server>/<tool>.json` and is called
  through `call_mcp_tool`, and the harness handles `tools/list_changed`. Two flags the backend
  serves gate it, `supports_deferred_tool_loading` per model and `enable_lazy_load` in its MCP
  tool config; which models carry the first is not in the binary, so a model without it may load
  every listed tool in full. A client can force a server eager with
  `_meta.antigravity.forceAllToolsEager` on the server entry or
  `_meta.antigravity.eagerMcpServers`; ace sets neither.
- Antigravity never shows MCP server instructions to its model: it writes them to
  `instructions.md` beside the tool definitions (seen in the files agy wrote), and its prompt only
  says the file may exist. ace's shared guidance therefore now travels in Antigravity's
  system-prompt text with the rest of its session guidance.
- Gemini CLI loads every MCP tool upfront with its raw input schema, has no tool search, reloads
  on `tools/list_changed` even without the capability, and adds server instructions to its
  project context. With folder trust on (the default) it starts no MCP server, ace's included, in
  a folder not in `trustedFolders.json`, unless `GEMINI_CLI_TRUST_WORKSPACE=true` or `--skip-trust`
  is given; ace passes neither.
- Qwen Code 0.0.14 neither reloads nor reads server instructions.

So whether an ACP agent shows server instructions is a per-agent rule
(`acpShowsServerInstructions`): Gemini CLI and claude-agent-acp do; Antigravity, Qwen Code and
every agent not reviewed get the guidance in their own channel (system-prompt text where offered,
else the first prompt). Antigravity's model now receives the shared guidance it lacked, about 235
tokens; its per-request budget is unchanged because the test already counted that text.
