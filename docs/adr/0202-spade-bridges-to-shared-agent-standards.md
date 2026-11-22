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

## Amendment 2: each outside caller stays inside its own grant

Accepted 2026-11-20, after a security review of amendment 1 as built. Each point closes a way for
one of the person's outside agents to reach past its own calls:

1. **A Stop reaches only the call it names.** A2A `CancelTask` and MCP cancellation used to stop
   the callee's whole conversation, which could serve another grant's call, another bot's or the
   person's words in the same turn. Now `contract::stop_reach` decides: the turn and the jobs it
   started stop only when that turn serves the named call alone. Otherwise the call ends alone
   (`ContractEnded` with the new ending `stopped`), and the turn carries on for the others. The
   decision is made and stored under the record lock, so nothing joins the turn between the look
   and the stop. Calls between bots follow the same rule.
2. **A call's record outlives the inbox's cleanup.** The 30-day inbox cleanup no longer takes
   outside rows. Each call's outcome is recorded once (`outside_outcomes`), and an outside call is
   forgotten only 30 days after it ended, never while it is open. GetTask, CancelTask and a
   retried key keep finding the original call and its first outcome. A retry never delivers
   again, whatever tool it names now.
3. **Reading a call costs the call, not history.** A read starts at the call's delivery seq, or
   at its stored outcome once it ended. Whether its callee waits comes from the conversation's
   cached activity, never from its events. A request that waits on a call holds a slot: 8 per
   grant and 32 in all. A wait beyond the cap is refused before anything is delivered.
   `returnImmediately` and GetTask never wait.
4. **A stamp can't be replayed or moved.** ace's stamp on a forwarded request
   (`ace-spade-outside/1`) signs the method, Spade's route, the protocol headers Spade acts on
   (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `A2A-Version`), the body and a nonce. Spade
   takes each nonce once while the stamp's time verifies, and refuses a stamp signed before it
   started, since the nonces it saw before then are gone.
5. **MCP request ids keep their type.** `7` and `"7"` are two requests. An id still in flight is
   refused (`-32600`) before anything is delivered.
6. **The card key can rotate.** The daemon reads `a2a-card-key.pem` again whenever the file
   changes, and has `reload` and an atomic `rotate`. The JWK set answers an ETag and
   `max-age=300, must-revalidate`. The card's ETag changes with its key. Both answer 304 to a
   matching `If-None-Match`, so a verifier sees a new key within minutes.

Tests: `outside_contracts_guards.rs` in `spade-server`, one per point, each shown to fail with its
fix turned off. `stop_reach` cases in spade-core. `card-key.test.ts`, `outside-proof.test.ts` (a
vector shared with Spade's) and `spade-contracts.test.ts` in the daemon.

## Amendment 3: inbound, as built

Accepted 2026-11-20, with phases 3 and 4 (sections 4 and 5). The MCP Apps facts were read from
the [spec file](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
at 2026-01-26; the A2A facts are amendment 1's (1.0.1).

How sections 4 and 5 were built, where they say more than the text above:

1. **An app's page is a panel of the bot that called its tool.** Spade's MCP sessions declare the
   `io.modelcontextprotocol/ui` extension. When a connected app's tool that links a `ui://` page
   returns for a bot, Spade reads the page once, keeps it by sha256 beside packages' panel pages
   (named under `bot_panels:<bot>:apps`, so the hourly collection keeps it), and stores a
   `panel_updated` for panel `app.<connector>.<hash of connector and address>` holding the app's
   facts, the call's arguments and its result. It lists with the bot's panels. A plugin server's
   page isn't shown yet.
2. **No network, by policy, not by trust.** A page declaring `connectDomains` or `frameDomains` is
   not kept or drawn; the bot and the panel read the section's words. Every page drawn gets a
   package panel's frame and `default-src 'none'`: declared `resourceDomains`, `baseUriDomains`
   and permissions are listed as withheld and never granted.
3. **The page's JSON-RPC rides the panel channel.** MCP Apps' transport posts objects, so the
   outer document writes each as text and holds it to the panel bound (16 KiB of UTF-8) before
   relaying it, answering the page with an error when it is over; it relays `tools/call`,
   `ui/message` and `ui/open-link` only while the person is pressing or typing in the page. The
   host reads the text with the protocol's schemas and takes only the methods of section 4's
   table. `tools/call` is answered at once ("Sent to the bot…"): the request goes to the bot,
   which decides through the gate, and the page gets the tool's result when the bot runs it. A
   tool only pages may call is out of the bot's tools, so the bot is told it can't call it.
   `ui/update-model-context` is stored without waking the bot. `resources/read` from the page is
   refused.
4. **The host confirm line is the link's.** `ui/open-link` waits on amendment 1 of ADR 0200's
   line under the page ("Linear asks to open linear.app (…)"), opening only on a real press after
   600 ms. Spade refuses `confirmed` on an app's panel: an app's page has no action that carries
   the person's standing.
5. **Outside agents are added at `/v1/a2a-agents`** and in Settings › Spade › Apps. The card is
   read over https, or plain http to the machine's loopback for an agent the person runs locally.
   A signature counts only with a key set at a `jku` on the card's own origin; anything else reads
   "Not signed" with why. An agent whose card requires a security scheme is refused with the
   schemes' names: sign-in to agents isn't built yet.
6. **A skill call is a tool call that may become a job.** It sends `SendMessage` with
   `returnImmediately` and the call's key as `messageId`, follows the task with `GetTask` (200 ms
   growing to 5 s), and past the foreground limit goes on as the bot's background job, as every
   long call does. Stop drops the call, and a guard sends `CancelTask` until the agent answers
   (five tries).
7. **Not yet:** a question card for `TASK_STATE_INPUT_REQUIRED` and a Reconnect card for
   `TASK_STATE_AUTH_REQUIRED` (the bot reads the agent's words, untrusted, and asks the person
   itself); streaming status; per-bot access to an agent (only the main bot has them); the person
   lowering a skill to `network`; keeping file parts in the workspace; pages that need the
   network; the spec annexes and conformance cases.

Tests: `spade_core::app_page`'s tables; `app_pages.rs` (a page shows as its panel, kept by hash; a
network page is refused; a page's tool call reaches the bot as untrusted and taints the turn) and
`a2a_agents.rs` (a signed card verifies, a tampered or unsigned one reads "Not signed", a call asks
the person and sends nothing before, its result is untrusted, Stop sends `CancelTask`) in
`spade-server`; the card check against a card signed by the daemon's own signer; `@ace/html`'s
`mcp-app.test.ts`, the web's `use-mcp-app-host.test.tsx` and `spade-outside-agents.test.tsx`; and
the real-Electron `mcp-app-isolation.process.test.ts`.

## Amendment 4: inbound, after its security review

Accepted 2026-11-21, after a security review of amendment 3 as built. Each point replaces what
amendment 3 says where they differ.

1. **A remote agent reaches only the public internet.** An outside agent is remote unless the
   person adds it as local (`local: true`, "On my own machine or network"). A remote agent's card,
   key sets and endpoint, whatever its card names, are held to the connectors' sign-in rules
   (`spade_connect::oauth::Net`): https, every address the name resolves to public and not this
   machine's own or on its links, and the request connects only to the addresses checked, with no
   proxy and no redirect, so a second DNS answer can't swap them. The endpoint is checked when the
   agent is added and again on every call. Only a local agent may reach local or private
   addresses, or plain http on loopback. Agents kept before this have no `local` and read remote.
2. **Answers are bounded as they arrive.** A card, key set or task answer is counted while it
   streams and dropped at 256 KiB, before it is parsed.
3. **Stop leaves nothing it knows of running, and says so only when it is so.** A message still
   being sent at Stop is left to finish (the client's 20 s timeout bounds it), so a task it opens
   is cancelled too. A call holds its task until an answer shows it ended (completed, failed,
   rejected or canceled); a call that ends otherwise (given up, the task lost, or waiting on input
   or a sign-in Spade won't give) cancels it as well. A cancel counts only when `CancelTask` or a
   later `GetTask` answers that the task ended; one the agent never confirms is listed on the
   agent (`unconfirmed_stops`) as possibly still running, never as stopped.
4. **An MCP app's page sends text only.** The page bridge gives the page a stand-in `parent` (a
   message port: a window would be a fresh realm with unguarded constructors) whose `postMessage`
   writes each message as JSON text and holds it to the panel bound before it leaves; a request
   over it is answered in the page. The outer document takes strings only, refuses one over the
   bound on its length before reading it, and parses only then, before the activation check, as a
   package panel's does. An object posted to it is dropped without being stringified.
5. **Every A2A result is untrusted.** Errors and refusals carry the agent's words too, so every
   way out of a skill call is marked untrusted, and the engine keeps a tool's `untrusted_output`
   on each stored result (foreground or job), so the mark survives the tool leaving the bot's
   list.
6. **Each signature has its own keys.** Every signature (at most four) is checked only against
   the key set at its own `jku`, which must be on the card's origin; one signature's keys never
   vouch for another.

Tests: `a2a::client`'s (a remote agent's requests never reach local or private addresses, a
request connects to the checked address, an endless answer is cut off at 256 KiB),
`a2a::card`'s and `a2a::task`'s tables, and `a2a_agents.rs` (an agent on this machine is reached
only once added as local; a signature is checked only against its own key set; Stop during the
send cancels the task it opens; an unconfirmed cancel is listed; a call that ends before its task
cancels it; a refusal is kept untrusted); the real-Electron `mcp-app-isolation.process.test.ts`
(an object posted past the page bridge never crosses); and `spade-outside-agents.test.tsx`.

## Amendment 5: connected apps read freely, and the reviewer judges what they don't declare

Accepted 2026-11-21, on the owner's word after connecting Notion to a bot on the auto-review and
getting three approval cards in a row for "see what you can see in my notion" (list shared,
favorite and recent pages, each "It doesn't say what it does, so you decide each time"). Most
apps' MCP servers send no annotations, so under §2 every one of their tools was unresolved, and
the auto-reviewer never saw any of them. Revised the same day after two rounds of security review
(points 1 to 3, 5, 8 to 12). This amendment replaces §2's last row and
ADR 0171's "a tool that declares nothing asks the person once" for those tools. Every rule lives
in `spade-core` (`effect::named`, `effect::shape`, `effect::app_tool`, `effect::route`) and reads
only what the call carries, plus the pins Spade keeps in its own store, so a Spade in ace's
cloud applies them the same way; nothing depends on a local secret.

1. **A connected app's ordinary reads run.** For a tool of an app the person connected (a
   connector's, under the bot's Apps switch, which still refuses everything while off), with no
   trusted declaration, Spade reads its own name and description (`effect::named`). The name is
   folded to its compatibility form (NFKC), case-folded and split at camelCase, digits and
   separators. It reads only when it has a read verb (`list`, `get`, `search`, `fetch`, `query`,
   `read`, `retrieve`, `describe`, `find`, `lookup`, `show`, `view`, `count`, `inspect`,
   `browse`, `preview`) and no word for a change anywhere: as a whole word, inside a longer word
   (`searchandupdate`, `getOrCreate`, `querysync`), or in the other languages Spade lists cheaply
   (Spanish, French, German, Portuguese, Italian: `actualizar`, `supprimer`, `erstellen`…). A
   word that only looks like one (`shared`, `updated`) doesn't count; `edit` inside a word
   (`search_andedit`) does. Names joining two steps
   (`and`, `or`, `then`, `y`, `et`, `und`) never read. A name with any letter outside ASCII (a
   look-alike letter from another script, a fullwidth form, an accent) never reads. A description
   with a word for a change keeps a name from reading; a description never makes one read.
   Such a read runs with no card and no reviewer while nothing untrusted is in view, the
   optional second model review included, which looks only at what the gate resolved as more
   than a read. With untrusted content in view, it goes to the reviewer first, in both modes,
   told only its name vouches for it; it never goes to the person for that.
2. **What a call reaches outranks its name** (`effect::shape`). A tool whose input (any property
   of its schema, nested ones included, or any key of the arguments sent) names a destination
   (`url`, `uri`, `host`, `endpoint`, `webhook`, `callback`, `to`, `recipient`, `email`, `cc`,
   `bcc`, `phone`), or whose name holds any of the same words (`fetch_url`, `set_host`,
   `add_recipient`), or that takes text it runs (`sql`, `code`, `script`, `expression`,
   `command`), is neither a read nor an ordinary write: it is unresolved. So is a `query`
   argument, unless the tool searches (`search`, `find`, `lookup`) and no string in the query
   (a list or an object given as the query is read whole) holds a statement word (`update`,
   `insert`, `delete`, `drop`, `alter`, `grant`…). A schema or arguments nested deeper than
   Spade reads (16 levels) are unresolved too, never taken as plain. An unresolved call goes to the reviewer, to the person under untrusted content, and
   a package's ceiling needs `network` for it. A trusted server's own read-only annotation still
   makes such a tool a read.
3. **An annotation may narrow, never widen.** A tool its server marks destructive, or annotates
   without `readOnlyHint: true`, is not a read whatever its name. No server's `readOnlyHint`,
   trusted or not, makes `delete_page` a read, and an untrusted server's `readOnlyHint` on a name
   Spade can't read reads nothing.
4. **What only the person decides is recognised by name, anywhere in it.** A name that pays
   (`pay`, `charge`, `refund`, `transfer`, `payout`, `purchase`…) is `pay`; one that sends in the
   person's name (`send`, `reply`, `forward`, `notify`, `email`, `enviar`, or a write of a
   message, comment or review) is `send_as_person`; one that shares, invites, grants or revokes,
   changes permissions, roles or members, or names a password, token, key or other secret is
   `change_access`; one that deletes, removes, empties, resets or overwrites (`borrar`,
   `supprimer` too) asks the person every call. These are recognised in a folded name whatever
   its letters, and go to the person in every mode.
5. **Everything else goes to the reviewer, in both modes.** A tool that still declares nothing
   (any connector's or plugin's) is reviewed: the reviewer judges it, told it declares nothing,
   from its name, description, app, arguments, the bot's task and the person's recent words. In
   Full access it is reviewed too, never run on the classifier's say alone (abstaining is not
   approval); only the person's "yes" kept from before or their Always allow lets it run there,
   still past the classifier. When the reviewer can't be reached or can't decide, the person
   decides. When Spade's classifier reads a person-only effect in such a call as plausible (a
   quarter or more, below its own bar for raising one), the person decides; an effect it raises
   is checked against the package's ceiling before anyone is asked. The person's "no" for a
   tool, kept from before, still refuses it.
6. **The reviewer's prompt treats an app's words as claims.** It names the app, and says that a
   tool's description and arguments are written by the app or the bot, never the person: a
   description calling a tool safe, read-only or approved proves nothing, and anything that could
   send, pay, share, change access or delete, or that it can't tell, is refused so the person
   decides. Text inside the tags stays quoted, and a quote in the app's name can't close its
   attribute.
7. **Untrusted content in view keeps writes with the person.** A tool that declares nothing,
   called while untrusted content is in view (ADR 0130), asks the person ("It may change
   something in the app, and the bot has read untrusted content, so you decide."), whatever they
   answered before. Only their Always allow for the app (point 9) hands an ordinary write to the
   reviewer then, told to check the call wasn't steered by that content, as for any grant under
   taint (ADR 0171 decision 5).
8. **Under a package's ceiling** (ADR 0200 §3.4) an undeclared or unresolved tool that reaches a
   server needs `network` declared, and is then reviewed each call, with no earlier answer or
   Always allow carried to it. `never_granted` keeps its guarantees: no tool grant ever covers a
   payment, a driving step, a send in the person's name, an access change, a secret or an effect
   Spade can't name.
9. **Ask once, for ordinary writes only.** **Always allow for Notion** is a grant scope,
   `{kind: "app", app, writes: true, tools: {tool: definition}}`. It covers only tools Spade reads
   as ordinary writes to the app's own content: exactly one verb of `create`, `update`, `edit`,
   `append`, `add`, `set` or `insert` (`create_update_page` isn't one), no other change inside
   any word, plain arguments (point 2), no delete, nothing in the name that publishes, shares,
   sends, pays, deletes, names access, a credential, a webhook, a URL, an email, a message or a
   comment, deploys, syncs, imports, uploads or drives, and no description that says it sends,
   emails, notifies, publishes, shares, invites, pays, charges, deletes or posts. A request
   offers it only while what the request says the call does (its gate effect, raised by what the
   classifier read) is still only a write: a write the classifier raised to a send is shown as a
   send and never offered it. Each tool it names
   is pinned to the definition the person was shown (`tool_key` on the request), and it covers a
   call only while that tool's definition is the same: a tool added or changed since isn't
   covered until the person sees it. A tool Spade can't place is never covered and never offered
   it. The grant is made through `POST /v1/agents/{id}/grants`, which takes only the person's
   stamp (ADR 0171 amendment 7's loosen rule). Spade refuses one that names a tool that isn't an
   ordinary write of that app now, or whose definition changed since it was shown. A bot can't
   make one and a package can't ask for one. The bot's Permissions › Apps row says "Its changes
   run without asking" and offers Ask again, which revokes every one of them.
10. **Definitions are pinned per connection.** The first time any of a connection's tools is
    used, Spade pins a digest of every tool it lists then (its own name, description and input
    schema), in its settings. A tool whose definition differs from the pinned one, or one listed
    only later (a write renamed to look like a read), loses its read and any Always allow until
    a call of it is approved by the reviewer or the person (never by the rules alone, nor an
    answer kept from before); then its new definition is pinned. A pin records what the server
    _claims_ its tool is. It can't prove what the server does with a call: that is what the name,
    argument and taint rules, the reviewer and the person are for.
11. **A call is sent only as it was approved.** Every connected app's call the gate lets run,
    or the person allows, is bound to the tool's definition digest and the connection's session
    generation at that moment, and the send (`spade_connect::pinned`) checks both on the sending
    session right before it goes: a session replaced since (a relist, a renewed sign-in), or a
    tool listed with another definition, refuses it as not run. A renewal the call makes itself
    to send is checked for the definition again before its one send. A request records the
    definition it showed, an allowed call whose tool changed meanwhile doesn't run on that
    answer, a verdict stored before a restart holds only for the definition it was given on, and
    a retry after the person reconnects the app is sent only while the tool is unchanged.
12. **Kept answers need the whole definition.** An answer kept for a tool that declares nothing
    is kept under its whole definition (name, description, input). One kept by an older build,
    whose identity left the description out, still says no but never yes: a description that
    changed could make the old yes cover something else.
13. **The cards say what the gate decided.** A request carries the gate's effect (`effect`), raised
    by what the classifier read. Every connected app's request, one alone too, shows on a card
    headed by it; requests one app's tools make together show as one card per gate kind ("Quill wants to make
    3 changes in Notion", "send 2 things in your name with Notion", "use Notion 2 times, in ways
    it doesn't declare"), never headed by the tools' names; requests of another kind start their
    own card. Each call shows its words, every recipient and address it names (to, cc, bcc and
    later ones, nested ones included, each once; else the page it acts on) and the gate's reason,
    with its full arguments behind Details before anything is allowed. A lookup's wording ("list your shared Notion pages") is used only for a call the
    gate read as a read; otherwise a lookup-named tool reads "use Notion to list…", so
    `list_and_delete` never reads as a read.

Existing installs get this at once: it reads tools as they are listed, so bots that already have
apps connected stop asking about their reads; each connection's tools are pinned on its first
use after the update, and answers kept from before still hold.

Tests (each fix revert-checked: undone, its test fails): `effect::named`'s tables (reads; folded, camelCase, embedded and non-English change
words; non-ASCII names; ordinary writes; recognised payments, sends, access changes and
deletes); `effect::shape`'s (destinations nested or only in the arguments, code, a search query
versus `UPDATE`); `effect::app_tests` (an undeclared list or search runs, reviewed under
untrusted content; `create_page` is reviewed; sends, payments, shares and secrets reach the
person; `delete_page` claiming read-only asks; `fetch_url` to an attacker's host is unresolved
and needs `network` under a package; `query` with `UPDATE` is unresolved; a renamed tool loses
its read; only ordinary plain writes are grantable; Full access reviews an unresolved tool with
the classifier on or off); `classify`'s plausible person-only table; the reviewer prompt test;
`effect::app_tests`' kept-answer and asked-effect tables; `spade-connect/tests/pinned.rs` (a
call is sent only on the session and definition it was approved for, a relist after approval
refuses it); `spade-server/tests/app_reads.rs` against a fake app (with the model review on, a
clean read still runs with no card) (three reads at once run; three writes
offer the app's Always allow; the grant needs the stamp, names each tool as shown and refuses
anything else; a send still asks; `fetch_url`, `query` with `UPDATE` and `publish_page` are
reviewed and never offered it; a tool added or redescribed after first use is reviewed once,
then pinned; Full access with the reviewer down asks the person; an allowed call whose tool
changed meanwhile doesn't run); and ace's `spade-app-requests.test.tsx` and
`app-request-words.test.ts` (one card per gate kind; nested recipients and full arguments shown;
`list_and_delete` never read as a read; the grant names the tools shown).
