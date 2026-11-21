# 0202: Spade bridges to the shared agent standards

Status: accepted. Date: 2026-11-20. Decided by: the founder (2026-11-20), taking every
recommendation below. Builds on [ADR 0200](0200-spade-is-an-agent-operating-system.md),
[ADR 0201](0201-spade-agent-format-is-an-open-standard.md) (the open format),
[ADR 0103](0103-skill-library.md) and [ADR 0151](0151-spade-skills-and-plugins.md) (skills),
[ADR 0131](0131-spade-connectors.md) (apps as MCP servers),
[ADR 0171](0171-spade-decides-on-effects.md) (effects),
[ADR 0077](0077-interactive-visualizations.md) (sandboxed pages) and
[ADR 0122](0122-outside-mcp-clients.md) (outside MCP clients and their grants).

## Context

Three shared standards hold most of the supply a new agent runtime could use:

- **Skills** as folders with a `SKILL.md`: YAML front matter (`name` and `description` required;
  `license`, `compatibility`, `metadata` and an experimental `allowed-tools` optional), a Markdown
  body, and optional `scripts/`, `references/` and `assets/` loaded only when needed
  ([Agent Skills specification](https://agentskills.io/specification),
  [repository](https://github.com/agentskills/agentskills)).
- **MCP** for tools, at spec version 2026-07-28
  ([specification](https://modelcontextprotocol.io/specification/2026-07-28),
  [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
  [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)).
  The spec says clients "MUST consider tool annotations to be untrusted unless they come from
  trusted servers", and that a human SHOULD be able to deny any call. Extensions are opt-in and
  negotiated. One of them, **MCP Apps** (`io.modelcontextprotocol/ui`, stable 2026-01-26), lets
  a tool point at an HTML resource under `ui://` (`_meta.ui.resourceUri`, MIME type
  `text/html;profile=mcp-app`) that the host draws in a sandboxed frame. With no `ui.csp` the host
  MUST use `default-src 'none'` and `connect-src 'none'`; with one it MUST NOT allow undeclared
  domains. A tool's `_meta.ui.visibility` says whether the model, the app or both may call it. The
  page may send `tools/call`, `resources/read`, `ui/message`, `ui/open-link`,
  `ui/update-model-context` and `ui/request-display-mode`
  ([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp),
  [spec file](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)).
- **A2A** for calls between agents, at version 1.0 (March 2026), hosted by the Linux Foundation
  ([specification](https://a2a-protocol.org/latest/specification/),
  [what's new in 1.0](https://a2a-protocol.org/latest/whats-new-v1/),
  [repository](https://github.com/a2aproject/A2A)). An agent publishes an **Agent Card** naming its
  skills, its endpoints and its security schemes; a card MAY carry JWS signatures (RFC 7515) and
  clients SHOULD verify them. Work is a **Task** that moves through states, with
  `TASK_STATE_INPUT_REQUIRED` and `TASK_STATE_AUTH_REQUIRED` as interrupted states, carries
  **Messages** made of **Parts** (text, file, structured data), and ends with **Artifacts**.
  Version 1.0 renamed the 0.3 state strings (`input-required` became
  `TASK_STATE_INPUT_REQUIRED`).

Spade already speaks two of these. Its skills are `SKILL.md` folders (0103, 0151). Its apps are
MCP servers over streamable HTTP, and ADR 0171 reads their tools' effects from annotations. What
is missing is the exact mapping, what is refused, and how trust crosses: an import must never let
outside words lower Spade's gate, and an export must carry Spade's effects and signatures so
other runtimes can use them.

## Options considered

- **No bridges; packages only.** Keeps one model. Leaves Spade with no supply. Rejected.
- **Bridges that trust the other side's declarations.** Easy imports: an MCP server's
  `readOnlyHint` or a remote card's skill list would decide a call. That is the hole the MCP spec
  itself warns about. Rejected.
- **Bridges where the other side's words are shown, Spade's gate decides, and Spade's own
  declarations travel out as signed extensions.** Chosen.

## Decision

One rule runs through every bridge: **outside declarations can make Spade ask, never make it
skip asking.** An imported effect, hint or capability is shown on the review and may raise a
call's effect; only Spade's own reading or a signed source Spade already trusts can lower it.

### 1. Skills

**Import.** Any folder whose `SKILL.md` meets the Agent Skills specification imports as a
`spade-skill`, from a file, a git address or the market.

| `SKILL.md` field         | In Spade                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | The skill's name. The spec's rules are checked (1–64 characters, lower-case letters, digits and single hyphens, not at the ends, the folder's name)                                                                  |
| `description`            | The index line the model sees (at most 1,024 characters)                                                                                                                                                             |
| `license`                | Shown on the review and the entry page                                                                                                                                                                               |
| `compatibility`          | Shown. Never a reason to refuse                                                                                                                                                                                      |
| `metadata`               | Kept. Keys under `spade.` are read as Spade's own (below); others are kept and unused                                                                                                                                |
| `allowed-tools`          | Shown as "It asks to run Bash and Read without asking. Spade still decides each call." It grants nothing: no tool is pre-approved, the gate reads every call as for any skill. The field is experimental in the spec |
| `scripts/`               | Run only through `shell` in the bot's sandbox, under the gate, as skill scripts are today (0151 point 5). Scanned as runnable: held for a maintainer before listing (0174 §8)                                        |
| `references/`, `assets/` | Read with the skill's other files when loaded (0151 point 5). Scanned as instructional or inert data                                                                                                                 |

Other front matter fields are kept and listed as "Not used by this Spade". A folder that fails
the spec's name or description rules is refused with the rule. Everything the market's scanner
does today still runs.

**Export.** A Spade skill exports as a folder that passes the spec's validator. Spade-only facts
go under `metadata` with `spade.` keys (`spade.version`, `spade.source`); nothing else is added.
`ace bot check` and `ace market check spade-skill` check a skill against the spec as well as
Spade's rules. A package's bundled skills export one folder each.

### 2. MCP tools into Spade

Spade already connects MCP servers as the person's apps and as plugin servers. The effect of an
imported tool is read like this, in order. The first row that applies wins:

| Source of the reading                                                                                                     | Effect                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| An effect for the tool in a signed source Spade trusts: the shipped catalogue entry, or a plugin's signed execution entry | That effect, per tool or for the whole server (0171 decision 3)                                          |
| The server is one Spade trusts (a catalogue entry marked `trusted_annotations`) and the tool says `readOnlyHint: true`    | `read`                                                                                                   |
| The server is one Spade trusts and the tool says `destructiveHint: true`                                                  | `network`, always asked (0131's destructive rule)                                                        |
| The server is one Spade trusts, any other annotation                                                                      | `network`                                                                                                |
| Any other server, whatever its annotations say                                                                            | Unresolved: asks the person every call, and the ceiling refuses it unless the package declares `network` |

- An untrusted server's `readOnlyHint` is shown on the call ("It says it only reads") and does not
  lower the effect. This follows the MCP spec's "untrusted unless they come from trusted servers".
- `openWorldHint: true` marks the tool's output as outside text, which taints the turn. All app
  output is already untrusted, so this changes only what the call shows.
- A server may declare Spade effects in `_meta["dev.acehq.spade/effect"]` on a tool. Spade
  believes it only when the same declaration is in a signed source above. Otherwise it is shown
  and unused.
- **MCP elicitation** (a server asking for input in the middle of a call) becomes an `ask_user`
  card from the bot, labelled with the app's name. Its answer is the person's only when the person
  gave it on that card. A form that asks for a password, a token or a card number is refused and
  the call fails with "It asked for a secret in chat".
- **MCP sampling** requests from a server are refused. A server never borrows the person's model.
- MCP authorization (OAuth 2.1, protected resource metadata, resource indicators, client ID
  metadata documents) stays connectors.md's: tokens in the OS keychain, never in a package.

### 3. Contracts out to MCP

The person's other agents can call a packaged bot's contracts as MCP tools.

- Spade's MCP server (`spade-mcp`) lists, per bot whose calls are on, one tool per contract:
  `name` is `<bot slug>__<contract>`, `description` the contract's `summary`, `inputSchema` and
  `outputSchema` the contract's schemas, and annotations computed from the contract's `effects`:
  `readOnlyHint: true` only when they are empty, `openWorldHint: true` when they include
  `network`, `destructiveHint` never set.
- It is reachable only by clients that hold an ace grant for this machine (ADR 0122) with a new
  scope, `spade-contracts`, which the person approves in the app. Nobody else, and no anonymous
  client.
- A call runs as a contract call `from_agent`, with the caller named as the outside client on its
  frame. The callee's ceiling, its contract's held effects and its gate apply as for a bot's call.
  `tools/call` waits for `contract_return` and answers `structuredContent` with the output.
- A contract call that waits on the person answers with MCP's `input_required` result as the tool
  page defines it, naming the bot and what it waits on; it never answers for the person.

### 4. MCP Apps into Spade

An app or plugin tool that links a `ui://` resource can show its page in Spade, as a panel.

| MCP Apps                                            | In Spade                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui://` resource, `text/html;profile=mcp-app`       | Read once with `resources/read`, kept by content hash, shown as a panel of that app beside the bot's conversation, under ADR 0077's isolation and ADR 0200 §5.2's bounds                              |
| No `ui.csp`, or one with no `connectDomains`        | Drawn. `resourceDomains` are refused: a page's images and fonts must be inline or `data:`                                                                                                             |
| `ui.csp.connectDomains` or `frameDomains` not empty | Not drawn in v1. The tool's text answer shows, with "This app's page needs the network. Spade doesn't open those yet." The MCP Apps spec asks servers to keep a text fallback                         |
| `tools/call` from the page                          | Only for tools whose `visibility` includes `app`. It reaches the bot as a `panel_action` with `by: page`: untrusted input, tainting the turn, through the gate (0200 amendment 1). Never the person's |
| `ui/message`                                        | The page's message, in the bot's conversation as untrusted input from that app, never as the person's words                                                                                           |
| `ui/update-model-context`                           | Untrusted context for the bot's next turn, labelled with the app's name, tainting it                                                                                                                  |
| `ui/open-link`                                      | ace shows the host first, as a card's `open` does. https only                                                                                                                                         |
| `ui/request-display-mode`                           | Honoured within panel bounds (inline or beside the chat); full screen is refused                                                                                                                      |
| Camera, microphone, location, clipboard permissions | Refused                                                                                                                                                                                               |
| Visibility `app` only                               | Kept out of the bot's tool index, as the spec asks                                                                                                                                                    |

Spade's own panels do not export as MCP Apps in this ADR. A card is data, and the MCP form for it
is the contract's `structuredContent`.

### 5. A2A: calling outside agents

The person may connect an A2A agent the way they connect an app.

- **Adding one.** Settings › Apps › Add an agent, with the agent's address. Spade fetches its Agent
  Card from the address the spec gives, over https only, with redirects refused. It verifies any
  JWS signature on the card and says whether it did ("Signed by its publisher's key" or "Not
  signed"). Sign-in uses the security scheme the card declares, through connectors.md's OAuth
  path, with tokens in the keychain. API-key schemes take the key into the keychain like an
  endpoint key (ADR 0119). Schemes Spade can't do are refused with their name.
- **What a bot sees.** Each skill on the card becomes a tool in the `apps` module,
  `<agent id>__<skill id>`, deferred and found with `tool_search`. A skill whose input and output
  modes include `application/json` takes and gives a JSON data part. Any other skill takes text.
- **Its effect.** A call to an outside agent sends the person's data to another party, signed in as
  the person. It is read as `send_as_person`: it goes to the person every call, as ADR 0163
  amendment 1 holds for sends. The person may set one of that agent's skills to `network` in its
  app page ("Calls to this agent only read"), recorded as their grant; Spade never sets it from
  the card. A packaged bot must declare `network` with the agent's host, and `send_as_person` for
  any skill left at that effect.
- **Mapping.**

| A2A                             | In Spade                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Send a message, new task        | A background job of the calling bot, like `contract_call`: it answers at once with a call id                                                                 |
| Message id                      | The call's idempotency key, so a restart sends it again with the same id and never twice as new                                                              |
| `TASK_STATE_WORKING`, submitted | The caller reads `working`                                                                                                                                   |
| `TASK_STATE_INPUT_REQUIRED`     | A question card from the calling bot, quoting the agent's words as untrusted text; the person answers or not                                                 |
| `TASK_STATE_AUTH_REQUIRED`      | A Reconnect card for that agent                                                                                                                              |
| Completed, with artifacts       | One `<agent_result>`, always untrusted, data parts checked as JSON and capped at 256 KiB, files kept in the workspace by hash and never opened by themselves |
| Failed, rejected, canceled      | The job fails with the agent's reason, quoted                                                                                                                |
| Stop on the caller              | The spec's cancel operation for that task, sent until it is answered                                                                                         |
| Streaming updates               | Folded into the job's status line; only the final result enters the conversation                                                                             |
| Push notifications to a webhook | Refused in v1: Spade has no address outside the machine. Spade polls the task instead, with backoff                                                          |
| A file part by URI              | Not fetched by itself. The bot may fetch it with `web_fetch`, under the gate                                                                                 |

### 6. A2A: the person's own agents calling Spade

- Spade serves an A2A endpoint for the person's own clients only, on the same listener and grant
  as section 3 (an ace grant with `spade-contracts`). Calls from other people's agents stay out,
  as ADR 0200 decided.
- **The Agent Card** at the spec's well-known address on that listener lists one skill per
  contract of each bot whose calls are on: `id` the contract name, `description` its summary,
  JSON in and out. It declares the grant's bearer scheme only.
- **Spade's facts travel as an A2A extension**, `https://spec.acehq.dev/a2a/spade/1`, on each
  skill: the package `{source, name, version, hash}`, the contract's held effects, and the signed
  version manifest. A receiver that knows ace's market keys can verify who published the package
  and what it may do. One that doesn't still gets a working card.
- **The card is signed** with JWS by the machine's credential key (ADR 0190), so a client can tell
  it came from that machine.
- Tasks map back the same way as section 5: a call is a contract call; the callee waiting on the
  person is `TASK_STATE_INPUT_REQUIRED` with a message saying the person is deciding, never the
  person's answer; `contract_return` completes the task with one data artifact.

### 7. What is refused, in one list

- An outside declaration lowering an effect: annotations from an untrusted server, a card's
  claims, `allowed-tools`.
- MCP sampling from a server. Elicitation that asks for a secret.
- MCP Apps pages that need network, outside resources, or device permissions; full-screen mode.
- A2A push webhooks, inbound calls from anyone but the person's own grant holders, and file URIs
  fetched without the bot asking.
- Skill folders that fail the spec's name or description rules.

### 8. Phases

1. **First slice: skills both ways and the MCP effect table.** `SKILL.md` checks in the market and
   `ace bot check`; import from a file or git address; export that passes the spec's validator;
   the trust table of section 2 with `trusted_annotations` in `spade/config/connectors.json`;
   elicitation as a card; sampling refused.
2. **Contracts out.** Contracts as MCP tools on `spade-mcp` behind the `spade-contracts` grant
   scope, and the same contracts on the A2A endpoint with the signed card and the Spade extension.
3. **MCP Apps in.** `ui://` pages as panels, network-free pages only.
4. **A2A agents in.** Adding an outside agent, its skills as tools, the task mapping, polling.

Each bridge is written into the spec as an annex (`spade/spec/bridges/`), with its own cases in
the conformance suite (ADR 0201).

## Decided

The founder took each recommendation on 2026-11-20.

1. **Calls to outside A2A agents read as sends.** The person can lower one skill to `network`.
   Data leaving for another party, signed in as the person, is what `send_as_person` means.
2. **MCP Apps pages with network wait.** Opening them would need their own egress through the
   bot's proxy and a decision of its own.
3. **Contracts are offered to the person's own agents only**, through ace grants, in MCP and A2A
   both. Other people's agents stay out until calls across people have their own decision.
4. **`allowed-tools` never pre-approves.** It is shown. The gate decides.

## Consequences

- Spade can use the skills and MCP servers that already exist, and its contracts become callable
  from any MCP or A2A client the person runs.
- A server that is honest about being read-only but isn't in Spade's catalogue still asks the
  person. That costs some friction on purpose.
- The catalogue grows a trust flag that ace must review per server.
- Spade's effects and signatures reach other runtimes as a documented extension, which is how the
  format's safety spreads.
- A2A and MCP Apps change. Each mapping names the spec version it was written for, and an update
  to a newer version is a change to this ADR's tables with its cases.

## Tests

- Skills: a table of `SKILL.md` front matter cases (valid, a bad name, a long description,
  `allowed-tools`, unknown fields) is accepted or refused by the same rule in the market and in
  Spade; an exported skill passes the spec's rules; `allowed-tools: Bash` leaves a `shell` call
  asking as before.
- MCP: an untrusted server's tool with `readOnlyHint: true` still asks the person and is refused
  by a package that doesn't declare `network`; the same tool from a `trusted_annotations` entry
  runs as a read; a declaration in `_meta` alone changes nothing; elicitation for a password fails
  the call; sampling is refused.
- Contracts out, through a real local `spade-mcp` and a test MCP client: a client without the
  `spade-contracts` scope is refused; a call returns `structuredContent` that fits the schema; a
  callee that waits on the person answers `input_required` and nothing runs for the person.
- MCP Apps, in the real-Electron isolation test: a page with `connectDomains` isn't drawn; a page's
  `tools/call` for a model-only tool is refused; one for an app tool reaches the bot as a page's
  untrusted action; `ui/message` never counts as the person's words.
- A2A, against a local test agent: a card with a bad signature reads "Not signed"; a restart
  during a task doesn't send a second new task; `TASK_STATE_INPUT_REQUIRED` becomes a card and
  the caller reads `waiting`; Stop sends a cancel; the result is untrusted; Spade's own card
  carries the extension and verifies with the machine key.

## Amendment 1: contracts out, as built

Accepted 2026-11-20, with phase 2 (sections 3 and 6). The A2A facts above were not read
first-hand when this ADR was written; they were checked against the primary sources before
building:

- **A2A's current version is 1.0.1** (released 2026-05-28; 1.0.0 was 2026-03-12), from the
  [specification](https://a2a-protocol.org/latest/specification/) and `specification/a2a.proto`
  at tag `v1.0.1` in the [repository](https://github.com/a2aproject/A2A). Versions are named
  `Major.Minor` (`1.0`) in requests and cards; a request with no `A2A-Version` is 0.3.
- **Transports:** three core protocol bindings, `JSONRPC` (JSON-RPC 2.0 over HTTP, PascalCase
  methods such as `SendMessage`, SSE for streaming), `GRPC` and `HTTP+JSON`, each declared in the
  card's `supportedInterfaces` with its URL and version. Spade serves `JSONRPC` at 1.0 only.
- **The Agent Card's well-known path is `/.well-known/agent-card.json`.** Signatures are JWS
  objects in `signatures` (`protected`, `signature`, optional `header`) over the card's RFC 8785
  form with defaults and `signatures` left out; the protected header carries `alg`, `typ: JOSE`
  and `kid`, and may carry `jku`.

How sections 3 and 6 were built, where they say more than the text above:

1. **One listener, two resources.** ace's outside listener (ADR 0122) serves `<base>/spade/mcp`
   and `<base>/spade/a2a`, each with its own protected-resource metadata naming the
   `spade-contracts` scope, and the card at `<base>/.well-known/agent-card.json` (on ace's relay
   that is `/m/<host>/.well-known/agent-card.json`, under the machine's prefix like every other
   path there). A sign-in may name either resource; its code and tokens are bound to the base,
   as ADR 0122's are. The daemon decides who gets through (a live grant issued for that base,
   holding `spade-contracts`, never Spade's own grant) and passes the request to Spade stamped
   with the grant (`ace:outside:<grant>`, the client's name) and signed with ace's local token.
   Spade refuses anything unstamped, so its own bearer can't speak for a client.
2. **A call is a contract call** (`engine/contracts_outside.rs`): its id is a hash of the grant
   and the caller's key, kept in the inbox under the grant, so the same key never runs twice and
   one grant can't read or stop another's calls. The callee reads
   `<contract_call from="<client>" id="outside:<grant>" outside="mcp|a2a" …>`, "one of the
   person's own agents outside Spade, not the person's words"; the call's held effects, the
   callee's ceiling and gate, the output check and the taint rule are those of every call.
3. **MCP.** `spade-mcp` gained a server side (`serve`): stateless at 2026-07-28 (`server/discover`,
   `resultType`, the version header matching `_meta`) and for clients that `initialize` at
   2025-11-25, 2025-06-18 or 2025-03-26. A tool's annotations follow section 3; `openWorldHint` is
   always set, since MCP's default for it is `true`. A caller's own idempotency key goes in
   `_meta["dev.acehq.spade/key"]` (a fresh one otherwise); untrusted output says so in
   `_meta["dev.acehq.spade/untrusted"]`. Stop is a modern client's closed stream, or a legacy
   client's `notifications/cancelled`.
4. **MCP `input_required` is not used.** In 2026-07-28 it asks the _client_ for input (an
   elicitation the client answers). A callee waiting on the person is waiting for the person in
   ace, and section 3 says the call never answers for them, so the call stays open until it ends.
   The A2A side reports the wait as `TASK_STATE_INPUT_REQUIRED` with a message saying the person
   is deciding in ace.
5. **A2A skills are named `<bot slug>__<contract>`**, as MCP tools are, not by the contract's name
   alone: two bots may publish the same name. `AgentSkill` has no extension field, so Spade's
   facts travel in the card's one `capabilities.extensions` entry,
   `https://spec.acehq.dev/a2a/spade/1` (`required: true`), as `params.skills.<skill id>`:
   `{bot, package {source, name, version, hash}, effects, input, output}`. A message names its
   skill in `metadata["https://spec.acehq.dev/a2a/spade/1"].skill` and gives its input as its
   first data part; its `messageId` is the call's key. An artifact says whether its output is
   untrusted in the same extension's metadata. Streaming, push notifications, `ListTasks` and the
   extended card answer the spec's errors for them.
6. **The card's key.** ADR 0190's machine credential is a secret shared with ace's backend, not
   a signing key, so the card is signed (ES256) with a P-256 key the daemon makes for this alone
   (`a2a-card-key.pem` in its data directory). `kid` is its RFC 7638 thumbprint and `jku` points
   at `<base>/spade/jwks.json`, which is public.
7. **Not yet:** the signed version manifest isn't on the card, because an installed bot keeps
   its package's hash but not the market's signed manifest (a receiver can fetch it by name and
   version and compare the hash); the spec annex in `spade/spec/bridges/` and its conformance
   cases are still to write.

Tests: `outside_contracts.rs` in `spade-server` (Spade's own MCP client and an A2A client through
a stand-in for the daemon), `serve` in `spade-mcp`, and `spade-contracts.test.ts` and
`card-signature.test.ts` in the daemon.
