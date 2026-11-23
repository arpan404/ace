# The ace MCP server: observable behaviour and invariants

The contract of `@ace/mcp-server`: the MCP endpoint agents call (tool listing, calls, budgets,
leases, guidance) and the injection helpers adapters use to hand it to provider CLIs. Written
against `ace/daemon-rust-rewrite` at 42386d3751.
[ADR 0225](../adr/0225-device-screen-automation-and-mcp-control-planes-stay-typescript.md) decides
what moves to Rust; [porting-guide.md](porting-guide.md) says how. Product contract:
[ADR 0010](../adr/0010-ace-mcp-server.md), [0078](../adr/0078-multi-device-mcp.md),
[0086](../adr/0086-agent-facing-mcp-tools.md), [0122](../adr/0122-outside-mcp-clients.md), and
`docs/research/providers/ace-mcp-injection.md`; `packages/mcp-server/README.md` describes naming
and annotations in prose.

## 1. What it is and where its work runs

- **A hub in the daemon process**: 8,947 source lines in 66 modules. The transport is the
  official SDK (`@modelcontextprotocol/server` 2.2.0 and `/node` 2.1.0, loaded on the first
  request, `http.ts:385`) on a `node:http` listener bound to 127.0.0.1 (`http.ts:274`). The
  daemon's own listener and the outside endpoint (ADR 0122) hand requests to the same handler
  (`handleHttp`, `serve`, `http.ts:301`–`:303`).
- **The tools are everyone else's.** `ToolRegistry` (`registry.ts:207`) holds Zod-described tools
  that toolkits register: browser, screen, devices, agent-control, html, images, suits, market,
  knowledge, guides, notifications, measurement (`apps/daemon/src/services/mcp.ts`). Every
  handler is JavaScript, and nearly every one reads or writes the event store.
- **Per call the daemon also records the call** (`observeCall`,
  `apps/daemon/src/tool-result-mcp.ts:199`: one store transaction when it starts, one when it
  ends) **and appends a change digest** (`withChanges`, `changes.ts:40`, from
  `SessionAwareness.changes`, `awareness.ts:118`, which reads the session's facts from the store).

## 2. Public surface

`package.json` exports `.`, `./errors` and `./market-verbs`. Callers outside the package use
these 114 names; adapters (`packages/adapter-*`) use the injection and listing helpers, toolkits
use `ToolRegistry`, `Toolkit`, `PublicToolError` and the model-image helpers, and the daemon wires
the server (`apps/daemon/src/mcp.ts` alone imports 18):

| Export                            | Defined at                      | Callers outside (prod / test) | Example callers                                                                                                                     |
| --------------------------------- | ------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AceMcpConnection`                | `src/injection.ts:35`           | 7 / 1                         | `apps/daemon/src/evals/world.ts:6`, `packages/adapter-claude/src/ace-listing.ts:1`, `packages/adapter-cursor/src/session.ts:12`     |
| `AceMcpConnectionSchema`          | `src/injection.ts:19`           | 3 / 2                         | `packages/adapter-opencode/src/server-pool.ts:6`, `packages/adapter-pi/src/extension.ts:4`, `packages/adapter-pi/src/session.ts:7`  |
| `AgentControlPort`                | `src/control-tool.ts:15`        | 1 / 0                         | `apps/daemon/src/agent-control/tools.ts:12`                                                                                         |
| `AskInput`                        | `src/knowledge-tools.ts:60`     | 1 / 0                         | `apps/daemon/src/asks.ts:9`                                                                                                         |
| `AskResult`                       | `src/knowledge-tools.ts:77`     | 1 / 0                         | `apps/daemon/src/asks.ts:9`                                                                                                         |
| `Authenticator`                   | `src/credentials.ts:21`         | 1 / 0                         | `apps/daemon/src/external-mcp/principals.ts:1`                                                                                      |
| `AwarenessPort`                   | `src/awareness.ts:7`            | 2 / 1                         | `apps/daemon/src/mcp-awareness.ts:4`, `apps/daemon/src/mcp.ts:5`                                                                    |
| `CallAct`                         | `src/registry.ts:76`            | 1 / 0                         | `apps/daemon/src/spade/computers.ts:15`                                                                                             |
| `CallActor`                       | `src/registry.ts:85`            | 1 / 0                         | `apps/daemon/src/mcp.ts:5`                                                                                                          |
| `CallAdmission`                   | `src/registry.ts:114`           | 2 / 0                         | `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/org-access/mcp-operations.ts:2`                                                        |
| `CallObserver`                    | `src/registry.ts:91`            | 4 / 0                         | `apps/daemon/src/measurement-mcp.ts:13`, `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/tool-result-mcp.ts:12`                        |
| `CallSignal`                      | `src/registry.ts:115`           | 1 / 0                         | `apps/daemon/src/external-mcp/tools.ts:12`                                                                                          |
| `ClaudeToolSearchFacts`           | `src/claude-tool-search.ts:9`   | 2 / 0                         | `packages/adapter-claude/src/ace-listing.ts:1`, `packages/adapter-claude/src/tool-search-facts.ts:5`                                |
| `CredentialRegistry`              | `src/credentials.ts:32`         | 6 / 30                        | `apps/daemon/src/mcp.ts:5`, `packages/screen/bench/computer-actions.ts:11`, `packages/screen/bench/search.ts:6`                     |
| `ErrorId`                         | `src/public-error.ts:123`       | 1 / 0                         | `apps/daemon/src/tool-failure-log.ts:2`                                                                                             |
| `HtmlLayoutPort`                  | `src/html-tools.ts:25`          | 2 / 0                         | `apps/daemon/src/html-preview.ts:6`, `apps/daemon/src/html-publication.ts:2`                                                        |
| `HtmlPreviewPort`                 | `src/html-tools.ts:40`          | 1 / 0                         | `apps/daemon/src/html-preview.ts:6`                                                                                                 |
| `HtmlPreviewResult`               | `src/html-tools.ts:33`          | 1 / 0                         | `apps/daemon/src/html-preview.ts:6`                                                                                                 |
| `HtmlPublicationPort`             | `src/html-tools.ts:16`          | 1 / 0                         | `apps/daemon/src/html-publication.ts:2`                                                                                             |
| `ImagePublicationPort`            | `src/image-tools.ts:7`          | 1 / 0                         | `apps/daemon/src/image-publication.ts:4`                                                                                            |
| `KnowledgePort`                   | `src/knowledge-tools.ts:85`     | 2 / 0                         | `apps/daemon/src/knowledge.ts:9`, `apps/daemon/src/mcp.ts:5`                                                                        |
| `KnowledgeResult`                 | `src/knowledge-tools.ts:52`     | 1 / 0                         | `apps/daemon/src/knowledge.ts:9`                                                                                                    |
| `KnowledgeTopic`                  | `src/knowledge-tools.ts:7`      | 1 / 0                         | `apps/daemon/src/knowledge.ts:9`                                                                                                    |
| `ModelImage`                      | `src/model-image.ts:6`          | 1 / 0                         | `packages/devices/src/sim-tools.ts:4`                                                                                               |
| `ModelImageRuntime`               | `src/model-image-runtime.ts:3`  | 6 / 0                         | `packages/screen/src/host.ts:2`, `packages/screen/src/options.ts:2`, `packages/screen/src/model-capture.ts:1`                       |
| `Principal`                       | `src/credentials.ts:5`          | 3 / 0                         | `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/spade/grant-auth.ts:1`, `apps/daemon/src/external-mcp/principals.ts:1`                 |
| `PublicToolCode`                  | `src/public-error.ts:6`         | 5 / 1                         | `apps/daemon/src/agent-control/failure.ts:1`, `apps/daemon/src/transfers/agent.ts:10`, `apps/daemon/src/machines/directory.ts:1`    |
| `PublicToolError`                 | `src/public-error.ts:539`       | 14 / 1                        | `apps/daemon/src/image-publication.ts:4`, `apps/daemon/src/agent-control/run-roles.ts:1`, `apps/daemon/src/machines/directory.ts:1` |
| `ResourceFetch`                   | `src/http.ts:44`                | 2 / 0                         | `apps/daemon/src/external-mcp/oauth/surface.ts:7`, `apps/daemon/src/external-mcp/server.ts:4`                                       |
| `Scheduler`                       | `src/registry.ts:161`           | 2 / 0                         | `apps/daemon/src/external-mcp/outside.ts:2`, `apps/daemon/src/external-mcp/principals.ts:1`                                         |
| `SessionFacts`                    | `src/brief.ts:16`               | 1 / 0                         | `apps/daemon/src/mcp-awareness.ts:4`                                                                                                |
| `SessionGuidance`                 | `src/session-guidance.ts:14`    | 2 / 1                         | `apps/daemon/src/evals/world.ts:6`, `packages/adapter-pi/src/extension-mcp.ts:2`                                                    |
| `SessionRoles`                    | `src/roles.ts:10`               | 1 / 0                         | `apps/daemon/src/mcp-awareness.ts:4`                                                                                                |
| `StatusReader`                    | `src/status.ts:17`              | 1 / 0                         | `apps/daemon/src/mcp.ts:5`                                                                                                          |
| `SuitPort`                        | `src/suit-port.ts:8`            | 1 / 0                         | `apps/daemon/src/suits/port.ts:1`                                                                                                   |
| `SuitPreviews`                    | `src/suit-previews.ts:47`       | 1 / 1                         | `apps/daemon/src/services/mcp.ts:11`                                                                                                |
| `ToolContext`                     | `src/registry.ts:49`            | 4 / 0                         | `packages/browser/src/mcp.ts:12`, `packages/screen/src/mcp.ts:4`, `packages/screen/src/computer/toolkit.ts:6`                       |
| `ToolFailureReporter`             | `src/registry.ts:101`           | 2 / 0                         | `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/tool-failure-log.ts:2`                                                                 |
| `ToolListing`                     | `src/toolsets.ts:19`            | 2 / 1                         | `packages/adapter-claude/src/ace-listing.ts:1`, `packages/adapter-codex/src/tool-search.ts:1`                                       |
| `ToolRegistry`                    | `src/registry.ts:207`           | 12 / 39                       | `apps/daemon/bench/tool-list.ts:6`, `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/machines/target-browser.ts:3`                      |
| `Toolkit`                         | `src/toolkits.ts:4`             | 13 / 0                        | `apps/daemon/src/browser-help-tool.ts:5`, `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/machines/target-screen.ts:2`                 |
| `aceInstructions`                 | `src/status.ts:85`              | 0 / 3                         | tests only                                                                                                                          |
| `aceToolAction`                   | `src/actions.ts:35`             | 2 / 0                         | `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/engine/ace-approvals.ts:1`                                                             |
| `aceToolDispatch`                 | `src/index.ts:26`               | 2 / 0                         | `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/external-mcp/server.ts:4`                                                              |
| `aceToolSearch`                   | `src/index.ts:26`               | 2 / 0                         | `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/external-mcp/server.ts:4`                                                              |
| `aceWaitTargets`                  | `src/waits.ts:15`               | 1 / 0                         | `apps/daemon/src/engine/ace-waits.ts:1`                                                                                             |
| `acpClaudeToolListing`            | `src/claude-tool-search.ts:98`  | 1 / 0                         | `apps/daemon/src/acp-engine.ts:14`                                                                                                  |
| `acpInjection`                    | `src/injection.ts:144`          | 2 / 3                         | `apps/daemon/src/acp-engine.ts:14`, `apps/daemon/src/services/mcp-session.ts:1`                                                     |
| `acpShowsServerInstructions`      | `src/toolsets.ts:135`           | 1 / 0                         | `apps/daemon/src/acp-engine.ts:14`                                                                                                  |
| `acpStdioInjection`               | `src/injection.ts:216`          | 2 / 3                         | `apps/daemon/src/acp-engine.ts:14`, `apps/daemon/src/services/mcp-session.ts:1`                                                     |
| `acpToolListing`                  | `src/toolsets.ts:104`           | 1 / 0                         | `apps/daemon/src/acp-engine.ts:14`                                                                                                  |
| `agentControlToolCatalog`         | `src/agent-control.ts:15`       | 1 / 0                         | `tools/protocol-docs/src/catalog.ts:43`                                                                                             |
| `agentControlToolkit`             | `src/agent-control.ts:27`       | 1 / 3                         | `apps/daemon/src/services/mcp.ts:11`                                                                                                |
| `appendAcpMcp`                    | `src/injection.ts:241`          | 1 / 0                         | `packages/adapter-acp/src/session.ts:4`                                                                                             |
| `bareToolName`                    | `src/index.ts:26`               | 2 / 4                         | `apps/daemon/src/org-access/mcp-operations.ts:2`, `apps/daemon/src/external-mcp/scopes.ts:6`                                        |
| `builtinToolCatalog`              | `src/catalog.ts:69`             | 1 / 0                         | `tools/protocol-docs/src/catalog.ts:43`                                                                                             |
| `changesKey`                      | `src/changes.ts:21`             | 0 / 1                         | tests only                                                                                                                          |
| `claudeAceServer`                 | `src/injection.ts:95`           | 1 / 1                         | `packages/adapter-claude/src/ace-listing.ts:1`                                                                                      |
| `claudeInjection`                 | `src/injection.ts:85`           | 3 / 2                         | `apps/daemon/src/evals/world.ts:6`, `apps/daemon/src/services/claude.ts:7`, `packages/adapter-claude/src/session.ts:2`              |
| `claudeToolListing`               | `src/claude-tool-search.ts:77`  | 1 / 0                         | `packages/adapter-claude/src/session.ts:2`                                                                                          |
| `claudeToolListingAfter`          | `src/claude-tool-search.ts:86`  | 1 / 0                         | `packages/adapter-claude/src/ace-listing.ts:1`                                                                                      |
| `codexClientHeader`               | `src/toolsets.ts:30`            | 0 / 2                         | tests only                                                                                                                          |
| `codexDiscoveryApi`               | `src/discovery-apis.ts:15`      | 1 / 0                         | `packages/adapter-codex/src/mcp-controls.ts:2`                                                                                      |
| `codexInjection`                  | `src/injection.ts:48`           | 2 / 4                         | `apps/daemon/src/evals/world.ts:6`, `packages/adapter-codex/src/session.ts:12`                                                      |
| `contextToolCatalog`              | `src/context-tool.ts:17`        | 1 / 0                         | `tools/protocol-docs/src/catalog.ts:43`                                                                                             |
| `coreTools`                       | `src/toolsets.ts:144`           | 0 / 1                         | tests only                                                                                                                          |
| `coreToolsHeader`                 | `src/toolsets.ts:20`            | 1 / 4                         | `packages/adapter-pi/src/extension-mcp.ts:2`                                                                                        |
| `cursorClientHeader`              | `src/toolsets.ts:32`            | 0 / 2                         | tests only                                                                                                                          |
| `cursorSdkInjection`              | `src/injection.ts:183`          | 1 / 2                         | `packages/adapter-cursor/src/agent-options.ts:2`                                                                                    |
| `developerInstructions`           | `src/session-guidance.ts:106`   | 6 / 8                         | `apps/daemon/bench/tool-list.ts:6`, `apps/daemon/src/services/cursor-mcp.ts:2`, `packages/adapter-cursor/src/tool-guidance.ts:4`    |
| `geminiUntrustedGuidance`         | `src/session-guidance.ts:133`   | 1 / 0                         | `apps/daemon/src/acp-engine.ts:14`                                                                                                  |
| `guideToolkit`                    | `src/guide-tools.ts:44`         | 1 / 3                         | `apps/daemon/src/services/mcp.ts:11`                                                                                                |
| `guideTopics`                     | `src/status.ts:4`               | 0 / 3                         | tests only                                                                                                                          |
| `handoffToolCatalog`              | `src/catalog.ts:38`             | 2 / 0                         | `apps/daemon/src/services/handoff-tools.ts:1`, `tools/protocol-docs/src/catalog.ts:43`                                              |
| `hostSet`                         | `src/advertised-schema.ts:69`   | 2 / 0                         | `packages/browser/src/mcp-schemas.ts:2`, `packages/screen/src/computer/schemas.ts:2`                                                |
| `htmlPreviewToolkit`              | `src/html-tools.ts:142`         | 1 / 0                         | `apps/daemon/src/html-preview.ts:6`                                                                                                 |
| `htmlToolCatalog`                 | `src/html-tools.ts:72`          | 1 / 0                         | `tools/protocol-docs/src/catalog.ts:43`                                                                                             |
| `htmlToolkit`                     | `src/html-tools.ts:121`         | 1 / 0                         | `apps/daemon/src/html-publication.ts:2`                                                                                             |
| `imageToolCatalog`                | `src/image-tools.ts:22`         | 1 / 0                         | `tools/protocol-docs/src/catalog.ts:43`                                                                                             |
| `imageToolkit`                    | `src/image-tools.ts:39`         | 1 / 0                         | `apps/daemon/src/image-publication.ts:4`                                                                                            |
| `keepPattern`                     | `src/advertised-schema.ts:63`   | 1 / 0                         | `packages/screen/src/tool-schemas.ts:13`                                                                                            |
| `knowledgeToolCatalog`            | `src/knowledge-tools.ts:96`     | 1 / 0                         | `tools/protocol-docs/src/catalog.ts:43`                                                                                             |
| `knowledgeToolkit`                | `src/knowledge-tools.ts:138`    | 1 / 0                         | `apps/daemon/src/services/mcp.ts:11`                                                                                                |
| `marketToolkit`                   | `src/market-tools.ts:148`       | 1 / 0                         | `apps/daemon/src/services/mcp.ts:11`                                                                                                |
| `maxRequestBodyBytes`             | `src/result-budgets.ts:21`      | 1 / 0                         | `apps/daemon/src/mcp.ts:5`                                                                                                          |
| `maxToolTimeoutMs`                | `src/timeouts.ts:2`             | 1 / 0                         | `packages/adapter-pi/src/extension-mcp.ts:2`                                                                                        |
| `metaToolCatalog`                 | `src/meta-tools.ts:102`         | 1 / 0                         | `tools/protocol-docs/src/catalog.ts:43`                                                                                             |
| `modelImage`                      | `src/model-image.ts:18`         | 2 / 0                         | `packages/screen/src/model-capture.ts:1`, `packages/devices/src/sim-tools.ts:4`                                                     |
| `modelImageGeometry`              | `src/image-geometry.ts:3`       | 2 / 0                         | `packages/browser/src/model-screenshot.ts:1`, `packages/browser/src/responsive-capture.ts:1`                                        |
| `modelImageRuntime`               | `src/model-image-runtime.ts:22` | 2 / 0                         | `apps/daemon/src/services/screen.ts:1`, `packages/devices/src/platform.ts:24`                                                       |
| `nodeListener`                    | `src/http.ts:338`               | 1 / 0                         | `apps/daemon/src/external-mcp/server.ts:4`                                                                                          |
| `nodeScheduler`                   | `src/registry.ts:164`           | 10 / 14                       | `apps/daemon/bench/tool-list.ts:6`, `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/machines/target-browser.ts:3`                      |
| `openCodeInjection`               | `src/injection.ts:110`          | 1 / 1                         | `packages/adapter-opencode/src/mcp-registration.ts:2`                                                                               |
| `openedToolset`                   | `src/toolsets.ts:171`           | 1 / 0                         | `packages/adapter-pi/src/extension-mcp.ts:2`                                                                                        |
| `parseToolArguments`              | `src/tool-failure.ts:10`        | 1 / 0                         | `packages/devices/src/sim-tools.ts:4`                                                                                               |
| `privateMcpConfig`                | `src/private-config.ts:17`      | 2 / 7                         | `packages/adapter-claude/src/sdk-process.ts:1`, `packages/adapter-pi/src/session.ts:7`                                              |
| `readOnlyAceTools`                | `src/read-only-tools.ts:26`     | 1 / 0                         | `packages/adapter-opencode/src/permission-policy.ts:2`                                                                              |
| `readPrivateMcpConfig`            | `src/private-config.ts:49`      | 1 / 5                         | `packages/adapter-pi/src/extension.ts:4`                                                                                            |
| `redactMcpCredential`             | `src/injection.ts:212`          | 2 / 0                         | `packages/adapter-claude/src/session.ts:2`, `packages/adapter-codex/src/session.ts:12`                                              |
| `registerBuiltins`                | `src/builtins.ts:9`             | 1 / 0                         | `apps/daemon/src/mcp.ts:5`                                                                                                          |
| `startMcpServer`                  | `src/http.ts:95`                | 2 / 8                         | `apps/daemon/src/mcp.ts:5`, `apps/daemon/src/external-mcp/server.ts:4`                                                              |
| `staticToolsHeader`               | `src/toolsets.ts:21`            | 0 / 3                         | tests only                                                                                                                          |
| `suitToolkit`                     | `src/suit-tools.ts:66`          | 1 / 0                         | `apps/daemon/src/services/mcp.ts:11`                                                                                                |
| `toolFailure`                     | `src/tool-failure.ts:86`        | 1 / 1                         | `packages/devices/src/sim-tools.ts:4`                                                                                               |
| `usualToolListing`                | `src/session-guidance.ts:46`    | 1 / 0                         | `apps/daemon/src/services/mcp-session.ts:1`                                                                                         |
| `withinJsonBudget`                | `src/json-budget.ts:2`          | 2 / 0                         | `apps/daemon/src/agent-control/conversation-tools.ts:1`, `apps/daemon/src/agent-control/catalog.ts:12`                              |
| `/errors PublicToolCode`          | `src/public-error.ts:6`         | 2 / 1                         | `packages/browser/src/action-error.ts:1`, `packages/browser/src/agent-errors.ts:1`                                                  |
| `/errors PublicToolError`         | `src/public-error.ts:539`       | 12 / 2                        | `apps/daemon/src/browser-help-tool.ts:1`, `apps/daemon/src/browser-help.ts:10`, `apps/daemon/src/spade/computers.ts:1`              |
| `/market-verbs MarketVerb`        | `src/market-verbs.ts:94`        | 1 / 0                         | `apps/daemon/src/cli/market/actions.ts:1`                                                                                           |
| `/market-verbs MarketVerbInput`   | `src/market-verbs.ts:98`        | 1 / 0                         | `apps/daemon/src/cli/market/actions.ts:1`                                                                                           |
| `/market-verbs MarketVerbProblem` | `src/market-verbs.ts:101`       | 1 / 0                         | `apps/daemon/src/cli/market/actions.ts:1`                                                                                           |
| `/market-verbs acceptCheck`       | `src/market-verbs.ts:306`       | 1 / 0                         | `apps/daemon/src/cli/market/publish.ts:3`                                                                                           |
| `/market-verbs describeListing`   | `src/market-verbs.ts:285`       | 1 / 0                         | `apps/daemon/src/cli/run/market-flows.ts:2`                                                                                         |
| `/market-verbs marketOperation`   | `src/market-verbs.ts:138`       | 1 / 0                         | `apps/daemon/src/cli/market/actions.ts:1`                                                                                           |

ADR 0223 already owns two of these on the Rust side: adapters' sessions redact the bearer from
their captures (`redactMcpCredential`, `injection.ts:212`) and build their provider's injection;
those ports follow ADR 0223 E3, not this one.

## 3. Behaviour that is contract

### Leases and authentication

- A lease is issued after the canonical agent exists (`CredentialRegistry.issue`,
  `credentials.ts:54`): a 256-bit hex bearer (refused otherwise), stored by digest, at most 1,024
  live, optionally expiring (at most 24 h). `end()` or aborting the lifetime revokes it; daemon
  close revokes all. The authenticator is asked on every request, so a revocation applies to the
  next one. Bearers are never stored or printed, and captures redact them.
- A tool call outside the principal's scope on the outside endpoint gets 403
  `insufficient_scope` before it runs (`scope-challenge.ts`); a missing or bad bearer gets 401 with
  a `www-authenticate` challenge (`http.ts:148`–`:153`).
- Only `/mcp` on a localhost Host and Origin is served on the internal endpoint
  (`http.ts:205`–`:216`); the endpoint is never registered with remote-access or relay routers.

### Listing

- `tools/list` shows a principal the tools whose capability its scope holds and whose group is
  on (`list`, `registry.ts:433`; availability from the daemon's `StatusReader`, `http.ts:100`–`:109`):
  a group that is off or not running is hidden, `ask` is hidden when no person can answer.
- Descriptors are built once per tool from Zod (`z.toJSONSchema`, `registry.ts:338`), with every
  annotation stated (`readOnlyHint` from the risk class; `destructiveHint` only for tools that
  delete or overwrite work, today `thread_merge` and `automation_remove`; `idempotentHint` for
  reads and tools with a `requestId`; `openWorldHint` for tools that reach past the machine) and
  `_meta` keys (`ace/timeoutMs`, `ace/riskClass`, `anthropic/alwaysLoad`,
  `antigravity/alwaysLoad`).
- Listing modes per client (`toolsets.ts`): core tools by header (`X-Ace-Tools`), `tools_find` and
  `tools_call` meta tools (`meta-tools.ts`), Claude's tool search (`claude-tool-search.ts`), opened
  families added on use, `list_changed` notifications on change, bounded per lease and 512 in all
  (`http.ts:91`–`:94`).
- Names are bare snake case; `bareToolName` strips any provider namespace (`mcp__ace__`, `ace_`),
  and calls, approvals and toolsets resolve by bare name.

### Calls (`ToolRegistry.call`, `registry.ts:460`)

- Order of refusals, each a fixed public failure: lease ended (`session_ended`); tool not offered
  (`tool_unavailable`); the host's admission (`host_policy_refused`); more than 1,024 calls in all
  or 256 per thread (`calls_limit`); already aborted (`cancelled`). A slot is taken before
  anything is awaited, so concurrent calls see each other.
- One deadline from the call's start covers the host hook, the tool and the observation of its
  result (`registry.ts:497`–`:524`); a tool's timeout is at most 660 s (`maxToolTimeoutMs`,
  `timeouts.ts:2`). Past it the reply goes (`tool_timeout`) and the slot is freed only when the
  backend settles: an uncooperative backend keeps its slot.
- Input: at most 64 KiB of JSON unless the tool declares more (`withinJsonBudget`,
  `json-budget.ts:2`, before any parse); then the Zod parse, whose issues become the model-facing
  `invalid_arguments` text (`parseToolArguments`, `tool-failure.ts:10`; `argument-issues.ts`).
- Output: structured results at most 256 KiB, rich content (images) 12 MiB, model images 1 MiB
  (`result-budgets.ts`); the output schema is checked and a mismatch is `invalid_data`; the text
  content is `JSON.stringify` of the checked value.
- Failures: a `PublicToolError` (`public-error.ts:539`) carries a fixed code, message and next
  step, written for the model (`PublicToolCode`, `:6`, about 80 codes); any other error is logged
  privately and the agent gets only its record id (`ErrorId`). These strings are contract.
- Long calls send a progress beat every 30 s to a client that asked for progress
  (`progress-heartbeat.ts`), because Claude Code aborts a call silent for 300 s.
- Request bodies are capped at `maxRequestBodyBytes` (about 8 × a message plus margins,
  `result-budgets.ts:21`); headers 8 KiB, request timeout 30 s, headers timeout 10 s, 2,048
  concurrent requests (`http.ts:194`, `:255`).

### Permissions

ace never gates a provider-native permission: annotations tell the provider what a tool does and
its own permission mode decides. ace hides only groups that are off. Person-only actions are the
tools' own (`ask` needs a person; Stop and settle by people stay with people), not approvals.

### Guidance and awareness

- The server instructions and each session's brief, groups, roles line and tool list are fixed
  per session on first read, so providers' cached prefixes hold (`SessionAwareness.guidance`,
  `awareness.ts:80`); later changes reach the agent as a digest appended to tool results.
- Injection per provider (`injection.ts`): Codex, Claude, OpenCode, ACP, Cursor SDK; the stdio
  bridge (`runStdioBridge`, `stdio-bridge.ts`) for clients that only speak stdio, with its own
  32 MiB queue cap.

## 4. Measured (2026-11-23, M4 Max, load average 50 to 140)

- Package bench (`bench/dispatch.ts`, Bun): credential lookup 0.29 µs; validated registry
  dispatch 2.38 µs; prepared schema lookup 0.02 µs; a full HTTP round trip through the SDK to a
  registry with one tool 171 to 224 µs. Stdio bridge 20.5 µs per request. Bearer redaction
  0.03 µs on an ordinary delta, 8.4 µs on a 256 KiB frame.
- A real daemon on an empty temporary home (no provider started), its 50 tools: `tools/list`
  53 KB, p50 0.57 to 1.36 ms; core listing 11 KB, p50 0.17 to 0.30 ms; `tools/call context`
  p50 0.65 to 1.03 ms; a call refused for bad arguments p50 0.65 to 1.36 ms.
- A CPU profile of 7,500 such requests (`bun --cpu-prof-md`) puts about 55% of the time in the
  daemon's own store work around each call (recording the call, 23 to 25%; the change digest's
  session facts, 12%; status for availability, 6%), about 8% in Zod, and 10 to 15% in the SDK and
  HTTP (SSE writing 5%, request conversion 1.5%, JSON-RPC checks 2%).
- Calls arrive at the rate models make them: seconds apart per agent.

## 5. The tests that guard this, and which carry over

Classes as in [docs/devices/behaviour.md](../devices/behaviour.md) §5. No file is live; the daemon's
`evals/` harness is a scripted model over the real endpoint, and spends no quota.

### (a): 36 files in `packages/mcp-server/src/`

`acp-listing.process`, `action-metadata.process`, `actionable-errors`, `admission.process`, `advertised-schema`, `agent-errors`, `brief`, `call-budget.process`, `claude-tool-search`, `content`, `discovery-apis.process`, `discovery-fifo.process`, `discovery`, `html-tools`, `http-boundaries.process`, `http.process`, `injection`, `legacy-lifetime.process`, `lifetime.process`, `list-changed.process`, `market-tools`, `model-image-failures.process`, `model-image.process`, `notification-streams.process`, `private-config.process`, `progress-heartbeat.process`, `roles`, `session-brief.process`, `session-guidance`, `sim-on-demand.process`, `status`, `stdio-bridge.process`, `stdio-results.process`, `suit-tools`, `thread-read-view`, `tool-guidance.process`.

`brief`, `legacy-lifetime.process` and `model-image-failures.process` import one limit constant each (`maxNotesChars`, `legacySessionsPerLease`, `maxModelImageBytes`) to size their inputs; they test through the public API.

### (b): 2 files

| File             | Internal it reaches                                            |
| ---------------- | -------------------------------------------------------------- |
| `codex-guidance` | `codex-guidance.ts` `compactToolNames`                         |
| `tool-search`    | `tool-search.ts` `rankTools` (the ranking behind `tools_find`) |

### In the daemon (`apps/daemon/src/`)

| Test files                                                                                                                                                                                                                                                                                                                                                                                                      | Class | What it guards                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.process`, `mcp-tools.process`, `mcp-tools-find.process`, `mcp-guidance.process`, `mcp-awareness.process`, `mcp-roles.process`, `mcp-status-groups.process`, `mcp-agent-budget.process`, `mcp-catalogue-budget.process`, `mcp-codex-discovery.process`, `mcp-discovery.process`, `mcp-controls.server.process`, `mcp-upgrade`, `claude-mcp-privacy.process`, `opencode-mcp.process`, `provider-mcp.process` | a     | the daemon's endpoint through a started daemon or the scripted model: listings and their token budgets, guidance, awareness, roles, groups, discovery, controls, upgrades, privacy of the bearer, provider wiring |
| `provider-mcp-lease.process`, `browser-mcp.process`, `browser-pi-mcp.process`, `browser-provider-mcp.process`                                                                                                                                                                                                                                                                                                   | b     | `services/provider-mcp.ts`: how a provider session gets its lease and the browser's MCP                                                                                                                           |
| `external-mcp/*` (15 files) and `external-mcp/oauth/*` (6)                                                                                                                                                                                                                                                                                                                                                      | —     | the outside endpoint (ADR 0122: OAuth, grants, scopes, tokens, reach); built on `startMcpServer`'s `loopback`/`serve` and staying TypeScript with it                                                              |

Counts: 52 (a) files, 6 (b), 0 (c), 21 not part of this move.
