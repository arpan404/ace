# OpenCode v2 and the official client

Researched 2026-10-02. Recommendation: replace ace's live v1 adapter with a
v2-only adapter for the user's installed CLI, using the official
`@opencode/client@2.0.22` Promise client. Retain ace's process owner, raw frame
validation, recovery barriers and tree status rules. Do not embed the new
`@opencode/sdk` host. This is a proposed direction, recorded in
[ADR 0047](../../adr/0047-opencode-v2-local-client.md), not an implemented migration.

## Evidence and naming

The installed CLI reports `opencode v2.0.22`. The corresponding official tag
resolves to `527f0b931d1f9b3ebd34e106c51b31ce5db5b075`. The old research used
v1.18.33 at `51ef4be1d3c122f18fefb510dca8d778571f4f18`.
The [non-prompt probe](opencode-v2-probe.md) records all six installed CLI
versions, launch arguments and HTTP results. No sessions, prompts, inference,
fixture recording or tests were run. Everything about model/tool execution
below is source-confirmed and still needs v2 recordings. [Tag API][tag],
[v1 source][old], [probe](opencode-v2-probe.md).

There are three different uses of "v2". The `@opencode-ai/sdk/v2` entry point
already existed in v1.18.33. It is not a promise of compatibility with CLI
major 2. The old package remains at npm latest 1.18.34. The CLI-major-2
packages are now `@opencode/client` and `@opencode/sdk`, both 2.0.22.
Some old SDK `client.v2.*` methods reach `/api/*`, but they describe the older
experimental API. Select the package by its actual routes and types, not by
its import suffix. [Old package][oldnpm], [new client][clientnpm],
[new host SDK][sdknpm], [old SDK generated API][oldgen].

The binding constraint is [ADR 0002](../../adr/0002-local-cli-providers.md).
The client calls a local HTTP endpoint with a local server password. The
installed CLI owns provider login and makes provider requests. No cloud SDK
or provider API key is required by this integration. ace must not call the
credential or integration-login APIs, read credential storage, or provide an
OpenCode login UI. The user's remedy for missing login remains the CLI's own
`opencode auth login`. [Client `OpenCode.make`][client],
[CLI server connection][connection], [CLI help probe](opencode-v2-probe.md).

The public [server documentation](https://opencode.ai/docs/server/) still
describes `/doc`, legacy routes and mDNS flags, and the public
[SDK documentation](https://opencode.ai/docs/sdk/) still names
`@opencode-ai/sdk`. For CLI 2.0.22, use the inspected tag, shipped package
source and installed-server probe rather than assuming those pages match.

## What changed in the server

The old HTTP API had 188 operations at `/doc`. The installed v2 server has
140 operations at `/openapi.json`. `/doc`, `/global/event`, `/global/health`
and `/session/status` return the web app with HTTP 200. A health probe that
checks only the status code will incorrectly accept these responses.
Use `/api/info` for identity, parse the JSON and version, and check the live
OpenAPI for required operation IDs. OpenAPI `info.version` is still `0.0.1`.
[v1 OpenAPI][oldspec],
[probe](opencode-v2-probe.md), [`createRoutes`][routes], [`ServerGroup`][servergroup].

| v1 adapter operation          | CLI 2.0.22 operation                               | Migration consequence                                                   |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /global/health`          | `GET /api/info`                                    | Returns version, PID, URLs and temporary path, not `healthy`            |
| `GET /global/event`           | `GET /api/event`                                   | Native events across server locations; no legacy wrapper                |
| `POST /session`               | `POST /api/session`                                | `location`, `model`, `permissions`; response `{data:info}`              |
| `GET /session/status`         | `GET /api/session/active`                          | `{data:{id:{type:"running"}}}`; foreground drains owned by this process |
| `GET /session/:id/children`   | `GET /api/session?parentID=:id`                    | Page `{data,cursor}`; verify ownership of each child                    |
| `POST …/prompt_async`         | `POST …/prompt`                                    | Durable inbox admission, not turn completion                            |
| `POST …/abort`                | `POST …/interrupt`                                 | `{interrupted:boolean}` acknowledges interruption, cleanup follows      |
| `GET …/message?before=`       | `GET …/message?cursor=&order=&limit=`              | Projected messages, opaque previous/next cursors; limit 1–200           |
| `POST /permission/:id/reply`  | `POST /api/session/:sid/permission/:id/reply`      | Body `{decision,message?}`; once, always or reject                      |
| `/question` and `question.*`  | Session `/form` routes and `form.*`                | Typed fields and keyed answer object                                    |
| Experimental `…/event?after=` | `/api/experimental/session/:id/log?after=&follow=` | Exclusive aggregate sequence and `log.synced`; retention caveat below   |
| `POST …/fork {messageID?}`    | `POST …/fork {before?}`                            | Explicit fork provenance; separate from child-agent parentage           |
| `/experimental/…/background`  | `POST …/background`                                | Backgrounds active backgroundable tools, including shells               |

These rows come from the installed spec and the pinned groups
[`session`][sessiongroup], [`message`][messagegroup], [`permission`][permissiongroup],
[`event`][eventgroup], [`server`][servergroup] and [`shell`][shellgroup].
Routes and many schemas still carry experimental annotations. That is a reason
to capability-gate them, even though they are the v2 CLI's working API.

## Launch, authentication and storage

`opencode` now normally connects to a managed background service. The CLI
has `service start|restart|status|stop|get|set|unset`, `--standalone`, and
`--server <url>`. A manually launched `serve` remains a separate server.
Its help lists `--hostname`, `--port`, repeated `--cors`, `--service` and
`--stdio`; the old mDNS flags are absent. [Help probe](opencode-v2-probe.md),
[`serve` handler][serve], [`ServerProcess.processEffect`][process].

For ace's default ownership, use the discovered executable with
`serve --stdio --hostname 127.0.0.1 --port 0`. Keep its stdin pipe open.
`--stdio` emits a JSON `{url}` readiness line and exits when stdin closes.
It also removes the lease password variables before tools can inherit them.
Parse readiness through a schema, then authenticate `/api/info` and compare
its version. The normal foreground readiness text is now
`server listening on http://…`, without the old `opencode` prefix.
[CLI `Standalone.command` and `start`][standalone],
[`ServerProcess.processEffect` and `waitForStdinClose`][process],
[foreground probe](opencode-v2-probe.md). The stdio launch behavior is
source-confirmed; it was not used for a model session here.

The CLI now requires a server password and generates one if none is supplied.
Prefer an injected random `OPENCODE_PASSWORD`; the legacy
`OPENCODE_SERVER_PASSWORD` is still accepted, but the new name wins when both
exist. Username is `opencode` in the CLI server configuration; the old
username environment override is not applied there. Without an explicit
password, foreground mode prints its generated password. Never forward that
line into ace raw frames or logs. Basic authentication, `auth_token` query
credentials, pairing tokens and same-origin session cookies exist, but ace
should use headers and its ephemeral local password. These are server access
secrets, not provider login credentials. [`Env.password`][env],
[`ServerProcess`][process], [`ServerAuth`][auth],
[`authorizationLayer`][authorization], [401 probe](opencode-v2-probe.md).

The user-owned data root remains XDG data `opencode`; `opencode debug paths`
reported `~/.local/share/opencode/opencode.db` on this machine. `OPENCODE_DB`
still overrides the file and accepts `:memory:`. Recognized release channels
share `opencode.db`; other channels receive a sanitized suffix. The database
now includes `session_v2`, `session_message`, `session_inbox`,
`session_pending`, `event_sequence`, optional retained `event` rows,
`credential` and project-scoped `permission` rows. The CLI imports legacy
`auth.json` credentials itself. ace must use HTTP for history and never
perform that import or read those tables for login. [`databasePath`][dbpath],
[`schema.up`][dbschema], [`importLegacyCredentials`][credentials],
[`Database.layer`][database], [paths probe](opencode-v2-probe.md).

Restart behavior is materially different. Managed service startup can resume
orphaned execution claims and background notifications, with a bounded
per-turn retry count. Unregistered standalone servers do not run that sweep.
Do not use `serve --service` as a research probe or silently replace the
user's managed service. For production, distinguish ace-owned process death
from loss of connection to an existing server; a shared server may still be
working. [`SessionRestart`][restart], [`ServerProcess.start`][serverprocess].

## Events, sessions, messages and subagents

Native `/api/event` frames have `{id,type,data,created?,location?,metadata?}`;
durable events also have `{durable:{aggregateID,seq,version}}`. The connected
frame is minimal and has no `created` or `location`. The public location is
`{directory}`; internal `workspaceID` is omitted. No `payload.properties`,
legacy `sync` twin or SSE `id:` is used by this transport. Heartbeats are
`: heartbeat` comments every 15 seconds, not `server.heartbeat` JSON every
10 seconds. Count transport activity from bytes/comments, not just yielded
JSON events. [Probe](opencode-v2-probe.md), [`Event` definitions][events],
[`makeEventGroup`][eventgroup], [`EventHandler`][eventhandler],
[`Location.PublicRef`][location].

The public server manifest retains some legacy status type definitions, but
native execution code publishes `session.execution.started|succeeded|failed|interrupted`.
Do not infer the native runtime from the continued existence of a
`SessionStatus` schema. The native event families include:

- `session.created|renamed|moved|deleted|forked`, agent/model selection and permissions;
- `session.inbox.enqueued|delivered|cancelled|delivery.changed` and `session.synthetic`;
- `session.step.started|streamed|ended|failed`, with model and usage at step boundaries;
- `session.text.*`, `session.reasoning.*` and `session.tool.input.*` starts/deltas/ends;
- `session.tool.called|progress|success|failed` and `session.retry.scheduled`;
- compaction, revert, shell and usage events, plus permissions and forms.

Exact fields and durability versions are in
[`SessionEvent.Definitions`][sessionevents],
[`EventManifest.ServerDefinitions`][manifest] and
[`SessionExecution.layer`][execution]. `*.delta` and tool `progress` are
live-only. Completed text/reasoning and tool outcomes have replayable full
values when event retention is enabled. There is no `session.next.*` prefix
in the current native session event definitions. Preserve unknown event types
and fields as bounded raw evidence rather than rejecting a future variant.

`Session.Info` now has `location`, `projectID`, optional `parentID`,
`fork:{sessionID,boundary}`, selected agent/model, `permissions`, cumulative
usage, `outcome:succeeded|failed|interrupted`, and `time.idle`. A fork is stored
with `parent_id:null` and `fork_session_id` set. Despite the route description
calling it a child, it is not a spawned subagent. Use `parentID` for the agent
tree and `fork` for history lineage. [`Session.Info`][session],
[`SessionProjector.projectFork`][projector].

History is no longer `{info,parts}[]` with stable v1 part IDs. Messages use a
`type` discriminator: user, synthetic, system, assistant, shell, skill,
compaction, agent/model/location switches, and idle markers. Assistant
`content` contains text, reasoning and tools. A tool has `id`, `name`,
`state.status:streaming|running|completed|error`; success carries content
blocks rather than the old output string. Associate text/reasoning deltas by
session, `assistantMessageID` and `ordinal`, and tools by message plus tool
`id`. `time.streamed` is the provider response boundary before tool settlement.
An idle marker closes an execution period, including steered prompts; shutdown
does not create that marker. [`SessionMessage`][messages],
[`PublicSessionMessage`][messagegroup], [`SessionEvent.Step`][sessionevents].

The built-in spawning tool is now `subagent`, not `task`. Its input is
`{agent,description,prompt,model?,sessionID?,background?}`. It creates a child
at the parent's location, emits progress `{sessionID:child,status:"running"}`,
and its result metadata keeps that ID/status. Reuse verifies that the child
belongs to the invoking parent. Default maximum depth is still one. Background
mode is built in and delivers a synthetic parent message with metadata
`{source:"subagent",childID,agent,state}`; it can wake the parent after the
parent's execution ends. General/explore agents deny their own `subagent`
action by default. No v1 background-subagent flag is needed by this code.
[`SubagentTool.Input` and `Plugin`][subagent],
[`SubagentJob.make`][subagentjob], [`SubagentCompletion.deliver`][completion],
[`AgentPlugin`][agents]. All scheduling/order details need v2 recordings.

V2 also has a real `shell` tool with `background:true`, `shellID` progress,
`Shell.Info.metadata.sessionID`, `shell.created|exited|deleted` live events,
and synthetic completion delivery. Shell listing/get/output/remove routes
permit recovery and control. A completed spawning tool does not prove its
background shell ended. This reverses the old "OpenCode has no background
shell" finding. Only attach shells with verified owning session metadata;
user-created shells and PTYs are not automatically agent work.
[`ShellTool.Plugin`][shelltool], [`Shell.Info`][shellschema], [`ShellGroup`][shellgroup].

## Permissions and forms

`permission.asked.data` now has `action`, `resources`, optional `save`,
`metadata`, `message`, and `source:{type:"tool",messageID,id}`. Session
permission rules are `{action,resource,effect}`. `once`, `always`, `reject`
remain the decisions, but the reply body key is `decision`. Pending requests
are still memory-only; closing their location rejects them. Reject affects
other pending requests for that session. `always` now persists supplied
`save` patterns by project, and can resolve other requests at that location
that the saved rules allow. Do not describe it as only a session-memory grant.
Defaults remain broadly permissive, with `.env` and external-directory asks;
a missing matching rule defaults to ask. Explicit session rules are evaluated
after the agent's rules, and configured denies are checked before saved grants.
[`Permission.Request`][permissions], [`Permission.layer`][permissioncore],
[`Agent.Info.default`][agentschema],
[`makePermissionGroup`][permissiongroup].

Questions now use forms. `form.created.data.form` includes `id`, `sessionID`,
`title`, metadata and typed fields. The question tool adds
`metadata.kind:"question"` and the owning tool message/id; fields are keyed
`q0`, `q1`, etc. Reply `{answer:{q0:"label",q1:["a","b"]}}`; cancel with
DELETE, optionally with feedback. Forms also support numbers, booleans,
external acknowledgements and conditional fields, so a generic form must not
be silently flattened into a question. Pending forms are memory-only; settled
states are retained for ten minutes, and restart cancels/loses them.
A transient SSE loss does not prove an interaction expired: refetch the
pending set before deciding. [`QuestionTool.Plugin`][question],
[`Form` schema][forms], [`Form.layer`][formcore], [`SessionGroup`][sessiongroup].

Global form ownership can be `"global"` for MCP elicitation. Never attach such
an interaction to every ace thread just because it lacks a session ID.
Attribute it through a verified location and owner policy, or show a
server-scoped notice. The pinned default agent plugin does not create a `plan`
agent, and the v1 `plan_exit` implementation/flag contract is not the v2
question contract. Discover configured agents and preserve unsupported forms;
leave plan-review capability off until a v2 behavior is established.
[`Form.InfoBase`][forms], [`AgentPlugin`][agents].

## What survives from ace's findings

| Existing finding                                  | v2 conclusion and adapter policy                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Parent idle does not mean tree done               | Still binding. Track foreground and background children, shells, interactions, undelivered input and completion wakes        |
| Infer turn boundaries from repeated busy/idle     | Replace with native execution lifecycle and projected idle markers; step end and streamed are not turn end                   |
| Interrupt response proves completion              | Still false. HTTP acknowledges acceptance; retain live descendants/tools until settlement                                    |
| Retry classification from message text            | Prefer structured `session.retry.scheduled.error` with status/type; preserve unknowns and use shared fallback classification |
| Cross-project filtering before recovery buffering | Still required. Filter owned session IDs and verified parent edges; location is now nested and may change                    |
| One stream for all projects                       | Still possible through `/api/event`; global does not mean all events belong to every thread                                  |
| Snapshot recovery after SSE loss                  | Still required; include forms, permissions, inbox, running shells and projected messages                                     |
| Detect gaps using legacy `sync.seq`               | Replace with durable envelope sequence per aggregate; never count ephemeral events as missing durable sequence numbers       |
| 10-second JSON heartbeat, 25-second gap           | Replace with 15-second comments and an activity hook; choose an injected gap policy allowing scheduling slack                |
| Fork loses lineage                                | Fixed through `Session.Info.fork`; do not build a parent-agent edge from it                                                  |
| No background shells                              | Reversed; add shell ownership, terminal events and stop control                                                              |
| `always` is in memory                             | Reversed for saved rules; explain the project-wide persistent grant                                                          |

The v2 columns are source-based conclusions from
[`SessionExecution`][execution], [`SessionEvent`][sessionevents],
[`SessionMessage`][messages], [`SubagentCompletion`][completion],
[`ShellTool`][shelltool], [`Permission`][permissioncore] and
[`EventHandler`][eventhandler]. The ace policy follows ADR 0004's tree rule,
not a vendor tree status.

Project scoping needs more than renaming fields. `/api/session` without
`directory` or `project` lists across projects; `parentID=null` selects roots
and `parentID=<id>` selects children. Cursor pages retain the original query
scope. Location APIs use `location[directory]` or `x-opencode-directory`;
session-addressed operations use the stored session location. An old
`?directory=` is not a universal location selector. ace should set location
explicitly on creation and location reads, validate returned ownership, and
accept a move only for an already-owned session. Buffer unknown children
under bounded limits until a session lookup proves ancestry. Unrelated
projects must neither consume recovery budgets nor postpone settlement.
[`SessionsQuery`][sessiongroup], [`requestRef`][serverlocation],
[`sessionLocationLayer`][sessionlocation], [`Bus.prepareRoutes`][bus].

Recovery sequence recommendation:

1. Mark affected agents disconnected, pause outbound sends, and open the new
   stream before starting bounded reads. Preserve pending interactions as
   uncertain until reconciled, instead of expiring them on mere EOF.
2. Verify `/api/info` identity and version. Fetch owned roots and paginated
   children; use `fork` provenance to exclude independent forks.
3. Fetch projected messages incrementally, foreground active IDs, per-session
   permissions/forms/inbox, and location shell listings filtered by owner.
4. Reconcile buffered durable/full-value events with read watermarks. Avoid
   appending a delta that the snapshot already includes. Apply newer work
   before an idle result and only publish recovered after the barrier.
5. Keep ace's bounded queues, byte budgets and failure policy. If completeness
   cannot be established, keep a disconnected/unresponsive result rather
   than publishing done. Persist only touched-session recovery progress.

This preserves the current adapter's bounded recovery approach while replacing
its routes and watermarks. Current source is pinned at integration/train-1
`8d98459e20c181d93abb269cc12d1df5a28ff75a`:
[`OpenCodeServer.recover`][aceserver],
[`OpenCodeSession.owns/resync`][acesession], [`HistoryReader.read`][acehistory].

The session log exists at `/api/experimental/session/:id/log`, with exclusive
`after`, optional `follow=true` and `log.synced`. Its schemas mark text/tool
terminal events durable and deltas ephemeral. But `Bus.configured` defaults
`persist` to false; `createRoutes` passes `options.events?.persist`, and the
CLI's `ServerProcess` never enables that option. Sequence/projection updates
still happen while payload retention is off. Therefore neither a durable
sequence nor a synced marker proves missing event payloads can be recovered
from the stock CLI. Use snapshots as the baseline. Adopt log replay only after
capability/retention evidence for the actual server; do not enable an embedded
host to obtain it. [`SessionGroup.session.log`][sessiongroup],
[`Bus.configured/commitDurableEvent/log`][bus], [`createRoutes`][routes],
[`ServerProcess.processEffect`][process]. This retention finding is a source
inference, not an exercised populated-log probe.

## SDK adoption scope

| Published package, checked 2026-10-02       | API and conclusion                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@opencode-ai/sdk` 1.18.33 / latest 1.18.34 | Legacy root and `/v2`, Hey-API generation; the inspected `dist` trees are identical. No package version 2.0.22 exists |
| `@opencode-ai/client` latest 0.0.0          | Old namespace; not the current v2 client                                                                              |
| `@opencode/client` latest 2.0.22            | Official generated HTTP client; Promise root, optional Effect/Solid entry points. Adopt Promise root                  |
| `@opencode/sdk` latest 2.0.22               | `OpenCode.create()` embeds the runtime with Effect/Core/Server. Reject for ace's installed-CLI architecture           |

Registry and shipped source: [legacy registry][oldnpm],
[old client registry][oldclientnpm], [client registry][clientnpm],
[host SDK registry][sdknpm], [legacy tarball][oldtar],
[current client tarball][clienttar], [host SDK tarball][sdktar]. Latest tags
are observations from this date, not a compatibility policy.

The old `/v2` client can attach with
`createOpencodeClient({baseUrl,headers,fetch,directory})` and requires no
provider API key. `createOpencodeServer` launches `opencode serve` from PATH
and returns `{url,close}`. `createOpencode` combines the two. However, its
launcher waits for the old `opencode server listening on` text, has no
explicit executable/cwd/env/spawner controls, and the combined helper does
not propagate a server password into client auth headers. Some
`client.v2.*` routes match, but history/event/question routes and schemas do
not. Do not patch that helper into ace for major 2. [Tarball symbols
`dist/v2/{index,server,client}.js` and `Session3`][oldtar],
[`OpencodeClient.V2` generated API][oldgen], [probe](opencode-v2-probe.md).

Use the public Promise root:

```ts
import { OpenCode } from "@opencode/client";

const client = OpenCode.make({
  baseUrl: ownedLoopbackUrl,
  headers: ephemeralTransportHeaders,
  fetch: observedFetch,
});
```

`OpenCode.make` attaches to a matching ace-started or existing local server.
It does not launch a process. Methods include `client.server.info()`,
`client.session.create/get/list/prompt/interrupt`, `client.session.message.list`,
permission/form/inbox groups, `client.shell.*`, and
`client.event.subscribe({signal,onActivity})`, an async iterable.
The exact generated signatures and method-specific returns are authoritative.
Some helpers unwrap `{data}`, while paginated lists keep `{data,cursor}`;
there is no universal old `{data,error,response}` wrapper. Use a fetch
observer before unwrapping to retain HTTP evidence and redact transport auth.
[`OpenCode.make`][client], [`generated.make`][generated],
[`Promise root exports`][clientindex].

Generated types include `V2Event`, `OpenCodeEvent`, `SessionLogItem` and
operation input/output types. The generator consumes the authoritative
`ClientApi` HttpApi contract. The Promise root's published static JavaScript
import graph has no external runtime imports, despite package metadata
including schema/protocol dependencies and optional Effect/Solid peers.
Use only the audited Promise root. Successful JSON and SSE payloads are cast
to generated types, not runtime schema-validated. ace still needs lenient
Zod parsing of known boundary fields plus preservation of unknown raw values.
[`script/build.ts`][clientbuild], [`generated request/json/sse`][generated],
[`package.json` and `dist/promise/*`][clienttar].

The current client multiplexes one upstream stream with a 4,096-event queue
per subscriber. Overflow fails that subscriber and discards its queue;
it is bounded fan-out, not backpressure that slows the provider. Upstream EOF
ends subscribers and exceptions fail them. There is no reconnect, cursor
recovery or snapshot recovery loop. Its generated SSE buffer is capped at
16 MiB; `onActivity` sees transport chunks including comments. Iterator return
and abort release the reader; the final subscriber leaving stops the
connection. ace must preserve smaller configured byte budgets as needed and
supervise EOF, stalls, malformed JSON and overflow itself.
[`SharedEvents.make`][sharedevents], [`generated.sse/maxSseEventBytes`][generated].

The legacy SDK behaves differently: thrown transport errors retry by default
with exponential delay starting at 3 seconds and capped at 30 seconds,
without a default retry-attempt limit. It recognizes `id:`/`retry:` and
forwards Last-Event-ID, but normal EOF exits. It has no bounded frame
accumulation or state recovery. Do not assume the new client inherits this
behavior, or that either can recover a volatile feed.
[`dist/v2/gen/core/serverSentEvents.gen.js:createSseClient`][oldtar].

`@opencode/client/service` offers `Service.discover`, `ensure`, `stop` and
`headers`. Read-only discovery validates the registration and server identity.
`ensure` defaults to launching `opencode serve --service`; it can terminate
and replace a registered incompatible or repeatedly unresponsive service.
That is too much shared lifecycle authority for ace's default adapter.
Keep `@ace/provider-kit` owning the discovered CLI process. Optional existing
server attachment should be explicit, loopback-only, avoid lifecycle changes,
and keep only local transport auth in memory. The new in-process SDK instead
creates an `EmbeddedHost` and calls it through `host.fetch`; that bypasses the
installed CLI and adds Effect to ace. [`Service`][serviceclient],
[`Endpoint/EnsureOptions`][servicetypes], [`PromiseSdk.create`][embedded].

A GET-only interoperability probe using the published 2.0.22 Promise client
confirmed `/api/info` returned the owned child PID/version, session listing
returned `{data,cursor}`, and a 16-second event subscription yielded only
`server.connected` while reporting three activity chunks. Abort ended cleanly.
The old SDK's `global.health()` received HTTP 200 HTML and threw
`Request is not supported by this version of OpenCode Server`.
No model request occurred. See the [probe addendum](opencode-v2-probe.md#sdk-attachment-probe).

## Migration scope and fixture approval list

Recommend v2-only live execution. Dual live support would retain two launch,
message, interaction and recovery contracts, with only v1 model fixtures
currently recorded. Keep the v1 recordings as historical evidence; they do
not certify v2 behavior. Reject v1 with a clear upgrade instruction and reject
unknown majors. Initially verify 2.0.22, then extend the supported range through
capability probes and evidence. This recommendation follows the breaking
contracts above and the owner's requested direction; it does not imply every
2.x patch is compatible.

The current integration adapter explicitly accepts `>=1.18.33,<2`, uses the
old ready text and global SSE wrapper, queues inputs, recursively reads
`/children`, and translates v1 parts and questions. Changing just the version
guard would fail before useful execution. Rework its transport and translator
while preserving public `ProviderAdapter` and pure fact translation.
[Integration capabilities][acecapabilities], [`OpenCodeServer`][aceserver],
[`OpenCodeSession`][acesession], [`OpenCodeTranslator`][acetranslator].

Also inspect shared discovery and model catalog owners. `parseVersion`
currently cannot parse the installed `opencode v2.0.22` prefix. The v2
`auth list` no longer emits the old credential-count format and normally uses
a server connection; discovery must not silently start/replace the managed
service. Its `--standalone` or explicit `--server` mode can isolate that
metadata read. Read only allowlisted non-secret connection evidence, not
`auth export` or credential values. The v2 `models` help has no `--verbose`;
its implementation prints sorted IDs, so the model catalog's old
`models --verbose` parser needs a v2 path through `client.model.list` on the
owned server. Do not duplicate that model normalization in the adapter.
[ace discovery parsers][acediscovery], [CLI auth list][authlist],
[CLI model handler][modelscommand], [`ServerConnection.resolve`][connection],
[help probe](opencode-v2-probe.md).

Recording spends quota. The following is an approval list for the owner,
not authorization to run the recorder now or in the future worker task.
Update the recorder for v2 before any approved capture; save fresh evidence
under `fixtures/opencode/2.0.22/`, with raw CLI/client versions and expectation
checkpoints. Existing scenarios are listed in
[the v1 fixture analysis](../fixtures/opencode.md) and
[the v1 fixture directory][acefixtures].

| Existing scenario     | Requested v2 capture, after approval                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-read`           | Native execution/step/text/tool lifecycle and successful projected history                                                                                                   |
| `approval-edit`       | New action/resources/source request, once reply and edit output                                                                                                              |
| `question`            | Form fields, keyed single/multi answers, dismissal with/without feedback                                                                                                     |
| `subagent`            | Foreground child link, child permission, transcript and parent settlement                                                                                                    |
| `subagent-background` | Parent terminal while child runs, synthetic inbox wake, repeated child continuation                                                                                          |
| `background-shell`    | Replace detached `nohup` scenario with native shell background lifecycle and automatic wake                                                                                  |
| `interrupt`           | Foreground shell interrupt acknowledgement, cleanup, terminal ordering, repeated terminal observations                                                                       |
| `retry-overloaded`    | Structured retry/error and final outcome; prefer controlled fault injection instead of waiting for genuine overload                                                          |
| `plan-review`         | Conditional capture for a configured/discovered v2 plan flow; do not send a prompt expecting built-in v1 `plan_exit`. Otherwise record capability absence with metadata only |

Additional approval candidates: always/reject permissions and persistence,
interrupt during foreground child versus background child/shell,
steer versus queue admission/cancel, resume after interrupted cleanup, and
restart with pending interactions/background completion. Each should use the
minimum turns and a spend/time limit the owner approves. Reconnect, overflow,
foreign-project noise, race ordering and raw unknown-field behavior can be
covered with fake local HTTP/SSE servers without spending provider quota.
These cases follow the source changes above, not assumed model behavior.

The implementation brief is `/tmp/ace-orch/impl-opencode-brief.md`. It covers
specific files, behavior tests, gating and risks. Before a live release, v2
recordings must confirm event order, wake handling and interrupt cascades;
until then label those capabilities unverified. No research result here
claims to have run those turns.

## Source links

All OpenCode source links below are pinned to the inspected tag, rather than
the moving `dev` branch. npm tarballs were downloaded and their JavaScript and
type declarations inspected; README text alone was not used as API evidence.

[serve]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/cli/src/commands/handlers/serve.ts
[process]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/cli/src/server-process.ts
[standalone]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/cli/src/services/standalone.ts
[connection]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/cli/src/services/server-connection.ts
[env]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/cli/src/env.ts
[auth]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/server/src/auth.ts
[authorization]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/server/src/middleware/authorization.ts
[routes]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/server/src/routes.ts
[servergroup]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/protocol/src/groups/server.ts
[sessiongroup]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/protocol/src/groups/session.ts
[messagegroup]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/protocol/src/groups/message.ts
[permissiongroup]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/protocol/src/groups/permission.ts
[eventgroup]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/protocol/src/groups/event.ts
[shellgroup]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/protocol/src/groups/shell.ts
[dbpath]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/cli/src/database-path.ts
[dbschema]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/database/schema.gen.ts
[credentials]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts
[database]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/database/database.ts
[restart]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session/execution/restart.ts
[serverprocess]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/server/src/process.ts
[events]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/event.ts
[eventhandler]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/server/src/handlers/event.ts
[location]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/location.ts
[sessionevents]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/session-event.ts
[manifest]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/event-manifest.ts
[execution]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session/execution.ts
[session]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/session.ts
[projector]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session/projector.ts
[messages]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/session-message.ts
[subagent]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/tool/plugin/subagent.ts
[subagentjob]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session/subagent-job.ts
[completion]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session/subagent-completion.ts
[agents]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/plugin/agent.ts
[shelltool]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/tool/plugin/shell.ts
[shellschema]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/shell.ts
[permissions]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/permission.ts
[permissioncore]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/permission.ts
[agentschema]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/agent.ts
[question]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/tool/plugin/question.ts
[forms]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/form.ts
[formcore]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/form.ts
[serverlocation]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/server/src/location.ts
[sessionlocation]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/server/src/middleware/session-location.ts
[bus]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/bus.ts
[client]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/client/src/promise/client.ts
[generated]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/client/src/promise/generated/client.ts
[clientindex]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/client/src/promise/index.ts
[clientbuild]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/client/script/build.ts
[sharedevents]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/client/src/shared-events.ts
[serviceclient]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/client/src/promise/service.ts
[servicetypes]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/client/src/service.ts
[embedded]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/sdk/src/promise.ts
[authlist]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/cli/src/commands/handlers/auth/list.ts
[modelscommand]: https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/cli/src/commands/handlers/models.ts
[tag]: https://api.github.com/repos/anomalyco/opencode/git/ref/tags/v2.0.22
[old]: https://github.com/anomalyco/opencode/tree/51ef4be1d3c122f18fefb510dca8d778571f4f18
[oldgen]: https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/sdk/js/src/v2/gen/sdk.gen.ts
[oldnpm]: https://registry.npmjs.org/@opencode-ai%2Fsdk
[oldclientnpm]: https://registry.npmjs.org/@opencode-ai%2Fclient
[clientnpm]: https://registry.npmjs.org/@opencode%2Fclient
[sdknpm]: https://registry.npmjs.org/@opencode%2Fsdk
[oldtar]: https://registry.npmjs.org/@opencode-ai/sdk/-/sdk-1.18.34.tgz
[clienttar]: https://registry.npmjs.org/@opencode/client/-/client-2.0.22.tgz
[sdktar]: https://registry.npmjs.org/@opencode/sdk/-/sdk-2.0.22.tgz
[aceserver]: https://github.com/arpan404/ace/blob/8d98459e20c181d93abb269cc12d1df5a28ff75a/packages/adapter-opencode/src/server.ts
[acesession]: https://github.com/arpan404/ace/blob/8d98459e20c181d93abb269cc12d1df5a28ff75a/packages/adapter-opencode/src/session.ts
[acehistory]: https://github.com/arpan404/ace/blob/8d98459e20c181d93abb269cc12d1df5a28ff75a/packages/adapter-opencode/src/history.ts
[acetranslator]: https://github.com/arpan404/ace/blob/8d98459e20c181d93abb269cc12d1df5a28ff75a/packages/adapter-opencode/src/translator.ts
[acecapabilities]: https://github.com/arpan404/ace/blob/8d98459e20c181d93abb269cc12d1df5a28ff75a/packages/adapter-opencode/src/capabilities.ts
[acediscovery]: https://github.com/arpan404/ace/blob/8d98459e20c181d93abb269cc12d1df5a28ff75a/packages/provider-kit/src/discovery/parsers.ts
[acefixtures]: https://github.com/arpan404/ace/tree/8d98459e20c181d93abb269cc12d1df5a28ff75a/fixtures/opencode/1.18.33
[oldspec]: https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/sdk/openapi.json
