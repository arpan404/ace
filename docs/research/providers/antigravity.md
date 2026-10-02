# Google Antigravity provider research (for the ace adapter)

Researched 2026-10-01/02. Antigravity is not installed on the research machine. The ACP server itself was not run, and no session was started or authenticated.

Primary sources:

- **Official docs:** antigravity.google/docs, about 90 pages mirrored to text, and the Terms of Service.
- **ACP registry:** the official entry `agentclientprotocol/registry/antigravity-acp/agent.json` (version 1.2.1, commit `3ee7f11880`, 2026-09-23).
- **Google's ACP server binary:** `agy-acp-server-1.2.1-darwin-arm64.zip` from `dl.google.com`. It is a PyInstaller bundle, and its Python source (Apache-2.0 headers, `google3/cloud/developer_experience/antigravity_extensions/acp_server/*.py`) is embedded as plain text. I read it with `strings`. Citations below look like **[bin: `server.py` `AgyAdapter.prompt`]**.
- **Official repos:** `google-antigravity/antigravity-sdk-python` (Apache-2.0, v0.1.20) and `google-antigravity/antigravity-cli` (changelog and examples only, no source).
- **ACP spec:** agentclientprotocol.com.
- **Gemini CLI:** local `gemini --help`, v0.43.0.

Confidence tags used below:

- **[confirmed]**: read in an official doc, the official registry, or Google's shipped source.
- **[inferred]**: reasoned from that material.
- **[unknown]**: needs a live run.

## TL;DR

**Recommended surface:**

- **Primary:** Google's official `agy_acp_server`, driven over ACP (JSON-RPC over stdio) and installed from the ACP registry. Default it to API-key auth.
- **Secondary, autonomous/batch runs only:** `agy` headless `stream-json`. Unlike ACP, it exposes subagent conversation IDs, but it cannot do interactive approvals.
- **Do not build on** the on-disk conversation DBs, beyond best-effort import.

Key facts:

1. **The ACP server is an official product, separate from the `agy` CLI. [confirmed]** The registry entry (Google LLC, `license: proprietary`, `license_url: https://antigravity.google/terms`) downloads a zip with `agy_acp_server.par` (Python/PyInstaller) and `localharness_external` (the Go agent harness). Only Linux gets extra args (`--uid=`). The official docs install it in Zed through "Install from Registry" and in JetBrains through "Agents" (docs `ide/extensions/zed`, `ide/extensions/jetbrains`). The `agy` CLI has no ACP subcommand (docs `cli/reference`).
2. **The ACP server is a thin adapter over the public Python SDK, which talks to the Go harness over a local WebSocket using `localharness.proto`. [confirmed]** Sources: [bin: `main.py` `_configure_localharness_path`]; SDK `connections/local/local_connection.py:761-818`. The harness protocol has real agent-tree data: `parent_trajectory_id`, `depth`, `TrajectoryStateUpdate.State{RUNNING, FULLY_IDLE, CANCELLED, WAITING_FOR_TASKS}`, and per-trajectory `UsageUpdate` (SDK `proto/localharness.proto` messages `StepUpdate`, `TrajectoryStateUpdate`, `UsageUpdate`). **The ACP layer drops all of it.**
3. **Over ACP, subagents are opaque. [confirmed]** A subagent shows up as an ordinary `tool_call` for the `start_subagent` builtin, with ACP kind `other`. There is no child session ID, no child transcript and no parent link ([bin: `tool_filter.py` docstring], [bin: `tools.py` `infer_tool_kind`]). `server.py` never reads `trajectory_id` or `depth` from steps. Over ACP, the browser subagent is **Gemini Enterprise only** and is rebuilt locally from `npx chrome-devtools-mcp@latest` ([bin: `browser_subagent.py` module docstring]).
4. **ACP updates emitted [confirmed]:** `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk` (replay only), `tool_call`, `tool_call_update` (with `diff` content for edits), and `available_commands_update` (`/plan` plus logout). Session config is exposed as `configOptions` (`model`, `mode`) together with the legacy `models`/`modes` fields. **It emits no `plan`, `usage_update` or `session_info_update`** ([bin: `server.py` schema usage]).
5. **Turn-end is not agent-done. [confirmed]**
   - `run_command` tool calls that are still running at `end_turn` stay open across turns and close later ([bin: `server.py` `prompt`, `persisted_open_tool_calls`]).
   - Errors and quota exhaustion arrive as **plain `agent_message_chunk` text**, then `stopReason: end_turn`, not as JSON-RPC errors. `QUOTA_EXHAUSTED` maps to `refusal` only when the SDK reports it as a stop reason ([bin: `server.py` `prompt`, `_to_acp_stop_reason`; `quota_errors.py`]).
6. **Human-in-the-loop uses only `session/request_permission`. [confirmed]**
   - Clarifying questions (`ask_question`) reuse it, with a synthetic `toolCallId` of `interaction_<8 hex>` and the answer choices as options ([bin: `server.py` `_ask_user_handler`]).
   - "Allow Always" on shell commands carries `_meta["agy.security.warning"]`.
   - The modes are `default`, `auto_edit` and `yolo`.
7. **Licensing risk is HIGH for OAuth. [confirmed text, inferred application]** The Antigravity ToS says: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement" (https://antigravity.google/terms). Zed and JetBrains are documented first-party integrations; ace is not. Default ace to `gemini-api-key` or `agent-platform` auth, and get the Google-account (`oauth-personal`) path reviewed before shipping it.
8. **Gemini CLI is not a substitute. [confirmed]** Google moved Gemini CLI to Antigravity CLI on 2026-05-19, and Gemini CLI "will stop serving requests for Google AI Pro and Ultra, as well as those using it free of charge" from 2026-06-18 (Google Developers Blog). Antigravity CLI is Go and "shares the same agent harness as Antigravity 2.0". Gemini CLI (`--acp`) is a different agent. Use it only as a separate "Gemini" provider for API-key and enterprise users.

## 1. Integration surfaces

| Surface                                                                                         | What it gives                                                                                                                                                                                                                                                                                                                                                                                                                     | Verdict                                                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `agy_acp_server` (ACP stdio), from the registry                                                 | Interactive sessions, permissions, questions, modes, models, `session/list`/`load`/`resume`, client fs, MCP passthrough, image/audio prompts. Subagents are opaque, there are no plan or usage updates, and errors arrive as text.                                                                                                                                                                                                | **Primary**                                                                                 |
| `agy -p` / `agy --input-format stream-json --output-format stream-json`                         | NDJSON `init` / `step_update` / `result` events. Steps carry `tool_info{name,parameters,output,error}` and `subagent_info.subagents[]{type_name, role, conversation_id, log_uri, workspace_uris}`, plus per-step `usage` and terminal `status`. **No interactive approvals:** `control_request`/`control_response` input ends the session with exit code 2, and tools that need approval are "soft-denied" (docs `cli/headless`). | **Secondary:** autonomous runs with pre-granted `permissions.allow`                         |
| Python SDK `google-antigravity` + bundled `localharness` (Apache-2.0, PyPI wheels per platform) | The full harness event model: trajectory tree, `WAITING_FOR_TASKS`, per-agent usage, `PolicyDecisionRequest`, hooks (SDK `localharness.proto`). Only API key or Vertex auth. Consumer Google-account OAuth is added by the ACP server's own proxy (`ccpa_connection`), not by the SDK (docs `sdk/overview`; [bin: module list]).                                                                                                  | **Watch.** It would need a Python sidecar. This is the only surface with a real agent tree. |
| Remote Control (`agy --remote-control`, `agy remote-control start`)                             | Google-hosted dashboard at antigravity.google.com that mirrors approvals and questions across devices (docs `remote-control`). There is no documented API.                                                                                                                                                                                                                                                                        | Not an integration surface. It overlaps with ace's own multi-device goal.                   |
| On-disk conversations                                                                           | ACP: `<GEMINI_HOME>/antigravity-acp/conversations/<uuid>.db` (+ `.meta`). CLI: `~/.gemini/antigravity-cli/conversations`. Desktop: `~/.gemini/antigravity/`.                                                                                                                                                                                                                                                                      | Import only. The format is private protobuf (§8).                                           |
| Gemini API "Antigravity agent" (Interactions API, `antigravity-preview-09-2026`)                | A cloud-hosted agent in a Google sandbox, not the user's workspace (ai.google.dev/gemini-api/docs/antigravity-agent).                                                                                                                                                                                                                                                                                                             | Out of scope for local threads                                                              |
| MCP                                                                                             | The agent consumes MCP servers. It is not itself an MCP server.                                                                                                                                                                                                                                                                                                                                                                   | N/A as a data surface                                                                       |

## 2. Launch, auth, process model

- **Binary and version gating [confirmed]:**
  - The registry lists `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`, `linux-aarch64` (`args: ["--uid="]`), `windows-x86_64` and `windows-aarch64`.
  - Version history: added 2026-08-20, 1.1.1 on 2026-09-03, 1.2.1 on 2026-09-23 (registry commits).
  - The darwin-arm64 zip is 112 MB; it unpacks to a 277 MB `.par` and a 121 MB harness.
  - Verify `initialize.agentInfo.name == "antigravity-acp"` and read `agentInfo.version` ([bin: `server.py` `initialize`]).
  - The only flags are `--debug` and `--notices` ([bin: `main.py`]).
- **Harness discovery [confirmed]:** the server sets `ANTIGRAVITY_HARNESS_PATH` from a sibling `localharness_external` file unless the variable is already set ([bin: `main.py` `_configure_localharness_path`]).
- **PyInstaller [confirmed / inferred]:** the binary contains `_MEIPASS` markers. One-file PyInstaller bundles unpack to `TMPDIR` on every launch, so ace should give each launch its own temp dir and clean it up. [inferred]
- **Profile root [confirmed]:** everything lives under `$GEMINI_HOME` (default `~/.gemini`).
  - `antigravity-acp/` holds `settings.json`, `acp_token.json`, `acp_business_token.json`, `trusted_workspaces.json`, `conversations/` and `brain/`.
  - `config/` holds the cross-surface `hooks.json` and `skills`.
  - Skills are also read from `antigravity-cli/skills/` ([bin: `paths.py`]).
  - The module docstring says `GEMINI_HOME` exists so "an embedding IDE [can] isolate this server's configuration and state".
- **Auth methods [confirmed]:**
  - `initialize` advertises `oauth-personal`, `oauth-business`, `gemini-api-key` and `agent-platform` (the last accepts the alias `vertex-ai`). A gated `gateway` method appears only if the client sends `clientCapabilities.auth._meta.gateway` _and_ `AGY_ACP_ENABLE_GATEWAY_AUTH` is set ([bin: `server.py` `initialize`]).
  - The selection is persisted as `settings.json` `{"auth":{"type":…},"gcp":{"project","location"}}` (docs `ide/extensions/zed`).
  - Environment-based selection was removed: "AGY_ACP_ENABLE_OAUTH and a bare GEMINI_API_KEY no longer select an auth method" ([bin: `server.py` string]).
  - The OAuth flow prints `Open the following link to authenticate the ACP server: {url}` and opens `$BROWSER` ([bin: `oauth/credential_manager.py`]).
  - On macOS, credentials go to the Keychain, or to a file when `AGY_ACP_FORCE_FILE_STORAGE` is set ([bin: `oauth/credential_store.py`, `macos_keychain.py`]).
  - `logout` is advertised (`agentCapabilities.auth.logout`).
- **Workspace trust [confirmed]:** decisions are stored in `trusted_workspaces.json`. `AGY_ACP_DISABLE_WORKSPACE_TRUST=1` disables the check ([bin: `workspace_trust.py`]). [unknown] how an untrusted workspace is surfaced to the client.
- **Process model [confirmed / inferred]:**
  - One server process can hold many sessions (`AgyAdapter._sessions`). Each `session/new` builds its own SDK `Agent`, and entering that agent's async context starts a harness ([bin: `server.py` `new_session`]). [inferred] That means one harness process per session.
  - Client disconnect tears down every session (`on_disconnect`→`cleanup`).
  - Recommendation: run **one ACP process per ace provider instance**, and consider one per thread for crash isolation. Measure startup cost first. [unknown]
- **Account requirement [confirmed]:** any Antigravity plan works, including free, as does Gemini Enterprise (docs `ide/extensions/zed`).

## 3. Event stream

**ACP methods implemented [confirmed]:**

- `initialize`, `authenticate`, `logout`
- `session/new`, `session/load` (replays history), `session/resume` (no replay), `session/list` (title is just `Session <id[:8]>`)
- `session/prompt`, `session/cancel`
- `session/set_mode`, `session/set_model` (superseded), `session/set_config_option`

There is **no `session/close`, `session/fork` or `session/delete`**. [bin: `server.py` method list]

Capabilities advertised: `loadSession`, `sessionCapabilities.{list,resume}`, `promptCapabilities.{image,audio,embeddedContext}`, `mcpCapabilities.{http,sse}`.

**Streaming granularity [confirmed]:**

- Text and thought deltas come from the SDK's `content_delta` and `thinking_delta` fields. Only model→user steps are streamed ([bin: `_stream_live_step`]).
- Each tool call gets `tool_call(status:"in_progress")` with `kind`, `title`, `locations`, `rawInput` and `content`, then one terminal `tool_call_update` with `rawOutput`.
- `run_command` output arrives only at completion, as structured `{commandLine, workingDir, exitCode?, combinedOutput…}`. There is no incremental terminal output.
- A non-zero exit code still reports `completed`.
- `generate_image` returns `{imageName, imagePath, prompt, aspectRatio}`. `search_web` returns a summary as both `rawOutput` and content.
- Internal MCP schema reads are hidden.

**Diffs [confirmed]:** `extract_tool_content` builds ACP `FileEditToolCallContent` (`type:"diff"`) from both PascalCase and snake_case args (`TargetFile`/`file_path`, `TargetContent`/`ReplacementContent`, `ReplacementChunks`…) ([bin: `tools.py`]).

**Client fs [confirmed]:** if the client advertises `fs.readTextFile`/`writeTextFile`, the server registers `client_view_file`, `client_create_file` and `client_edit_file`, so edits go through `fs/write_text_file` (tool sets in [bin: `tools.py`]). ace can then gate and record writes itself.

**Artifacts [confirmed docs; ACP behaviour inferred]:**

- Desktop and CLI artifacts are implementation plans, task lists, walkthroughs, diffs, screenshots and browser recordings (docs `artifacts`, `cli/artifacts`, `ide/browser-recordings`).
- Over ACP, the harness writes them under `<GEMINI_HOME>/antigravity-acp/brain/<session id>/`, and the path matches Cortex `artifacts/path.go` ([bin: `paths.py` `app_data_dir`; `server.py` `_HARNESS_ARTIFACT_DIR_NAME = "brain"`]).
- There is **no ACP event for artifact creation or review.** [inferred] They show up only as file-write tool calls into `brain/`, so ace would have to watch that directory.

**Proto heritage [confirmed]:** the server imports `third_party/gemini_coder/proto/trajectory_pb2` and `exa.cortex_pb` ("Cortex" was Codeium/Windsurf's engine name) and refers to `third_party/jetski/cortex` ([bin: `session_store.py`, `server.py`]).

## 4. Subagents

- **Product model [confirmed docs]:**
  - The parent calls `invoke_subagent` with workspace `inherit`, `branch` (a git worktree) or `share`. Subagents get a fresh context.
  - Lifecycle: Running → Idle (it can be woken by a message) → Killed. Nesting is limited to 10 levels.
  - Agents message each other by conversation ID. Permission requests "bubble up".
  - Built-in subagents are `research`, `browser` and `self`. `/boost` and `/teamwork-preview` are multi-tier orchestrators.
  - Sources: docs `subagents`, `cli/commands/agents`.
- **Over ACP [confirmed]:**
  - The tool name is `start_subagent` (not `invoke_subagent`), with kind `other`.
  - There is no child ID, model or stream, and there is no extension method for child sessions ([bin: `server.py` has no `ext_method`/`ext_notification`; tool filter lists `start_subagent`]).
  - Whether a subagent's own step updates leak into the parent stream is **[unknown]**. The SDK queues `StepUpdate`s from all trajectories without filtering (SDK `event_processor.py:609-650`), and `_stream_live_step` does not check `trajectory_id`.
  - The SDK does **ignore subagent `TrajectoryStateUpdate`s** (`event_processor.py:704-715`), so the ACP turn ends when the _main_ trajectory goes `FULLY_IDLE`.
- **Browser subagent over ACP [confirmed]:**
  - It exists only on Gemini Enterprise with admin `browser_enabled`.
  - Tools are namespaced `chrome_devtools/<tool>`.
  - `evaluate_script` may require review under the admin JS policy.
  - It needs Node/`npx` on PATH ([bin: `browser_subagent.py`]).
- **Parent linkage alternatives:**
  - Headless `subagent_info.subagents[].conversation_id`/`log_uri` [confirmed docs `cli/headless`].
  - SDK `Step.parent_trajectory_id`/`depth` [confirmed SDK `types.py:1142-1170`].

## 5. Status and liveness

- **End of turn [confirmed]:** the `session/prompt` response carries `stopReason`:
  - `end_turn` is the default and also covers errors.
  - `cancelled`.
  - `max_tokens` (input/output/total limits).
  - `max_turn_requests` (model-call or tool-call limits).
  - `refusal` (`QUOTA_EXHAUSTED`).

  Source: [bin: `_to_acp_stop_reason`].

- **Errors [confirmed]:**
  - SDK execution, connection and validation errors are sent as an `agent_message_chunk`. The text is one of: a browser-specific message, an MCP-load message, `"Usage Limit Reached\n\nYou have reached your current quota for this period. …"`, or `"Agent execution error: …"`.
  - The turn then ends normally, and any open tool calls are closed as `failed` ([bin: `prompt`, `quota_errors.py`]).
  - A dead harness websocket triggers one automatic agent rebuild and retry. A second failure sends a "connection lost" message.
  - Auth problems raise ACP `auth_required`.
- **Background work [confirmed]:**
  - Exec tool calls still open at a clean turn end are moved to `persisted_open_tool_calls` and closed by a later `tool_call_update`, which can arrive during a later turn.
  - `manage_task(Action="kill", TaskId="task-<n>")` closes them as failed ([bin: `_stream_live_step`]).
  - [unknown] whether updates are pushed _between_ turns while no prompt is active. The step pump runs only inside `prompt()`, so they are probably not.
- **There is no heartbeat, progress ping or `session_info_update`. [confirmed]** ace must supervise the process and run its own inactivity timers.
- **CLI-only signals [confirmed docs]:** headless `status` values are `SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING`. Since CLI 1.2.13, rate limits honour the server's retry delay and stop when the delay is over 30 s or the cap is daily or billing (`antigravity-cli/CHANGELOG.md`).

## 6. Human-in-the-loop

- **Tool approvals [confirmed]:**
  - `session/request_permission` offers `allow_once`, `reject_once` and possibly `allow_always`.
  - "Allow Always" is cached per session in memory:
    - Shell commands are keyed on the exact `CommandLine` string.
    - File-write tools are _never_ cached; "Allow Always" is downgraded to allow-once.
    - Other tools are cached by name.
  - Shell and web tools add `_meta["agy.security.warning"] = {severity, risk:"prompt_injection", title, message}`.
  - Gemini Enterprise admin policy can force review or denial for terminal commands and outside-workspace file access ([bin: `_permission_handler`, `_allow_always_signature`]).
- **Mode semantics [confirmed]:** `default` prompts, `auto_edit` auto-approves edit tools, and `yolo` approves everything except admin-forced reviews (`config_options.py` `AVAILABLE_SESSION_MODES`). These match Gemini CLI's `--approval-mode default|auto_edit|yolo`, but ACP has no `plan` mode (`gemini --help`).
- **Questions [confirmed]:**
  - `ask_question` arrives as `tool_call(status:"pending", toolCallId:"interaction_xxxxxxxx", title=<question>)` followed by `request_permission`.
  - Each choice is an option. Choices with IDs `deny`, `dont_trust` or `block` get `kind: reject_once`; all others get `allow_once`.
  - Multi-select is unsupported (TODO b/524989454).
  - The selected `optionId` is the answer ([bin: `_ask_user_handler`]).
- **Plan review [inferred / unknown]:** `/plan` "generates an implementation plan artifact and awaits user approval". [unknown] how that approval reaches an ACP client: as a question, as a permission on a file write, or as a text turn. The CLI has `artifactReviewPolicy` (`asks-for-review|agent-decides|always-proceed`) and line comments (docs `cli/reference`, `cli/artifacts`). The ACP server has no equivalent setting.
- **Subagent approvals:** in the CLI they bubble up to the main UI (docs `subagents`). Over ACP they presumably arrive as ordinary `request_permission` calls on the parent session, with no subagent attribution. [inferred]

## 7. Control

- **Cancel [confirmed]:** `session/cancel` calls `agent.conversation.cancel()`. The pending prompt then returns `stopReason:"cancelled"` after a text chunk. ace should also answer any outstanding permission request with `cancelled`.
- **Steer:** there is no mid-turn input; `prompt` is serial per session. To steer, cancel, wait for the prompt to resolve, then re-prompt. [confirmed; the CLI's "send immediately" queue mode is CLI-only (CHANGELOG 1.2.14)]
- **Resume and load [confirmed]:**
  - `session/load` replays history as `user_message_chunk`, `agent_*_chunk` and `tool_call` updates.
  - `session/resume` restores without replaying.
  - Both read the `.db` and strip Gemini thought signatures first, to avoid HTTP 400 ([bin: `session_store.py`]).
  - `session/list` filters by `cwd` from `.meta`.
- **Modes and models [confirmed]:** use `session/set_config_option` with `configId` `model` or `mode`. The model list depends on the account. One example list is `gemini-3.8-flash-high`, `gemini-3.1-pro-high` and `claude-sonnet-4-6` (docs `cli/headless`, from `agy models`). Unavailable models are replaced automatically, with a notice ([bin: `_maybe_replace_unavailable_model`]).
- **Tool filtering [confirmed]:** `_meta.agy` on `session/new` can carry an allowlist and/or denylist of builtin tool names. It is persisted in `.meta` ([bin: `tool_filter.py`]).

## 8. History

- **ACP store [confirmed]:**
  - `conversations/<uuid>.db` is SQLite with table `steps(idx, step_payload)`, where `step_payload` is a serialized `trajectory_pb2.Step` (a oneof over `view_file`, `file_change`, `run_command`, `code_search`, `search_web`, `generate_image`, `mcp_tool`, `planner_response`, `error_message`…).
  - `<uuid>.meta` is JSON holding `cwd`, `mode_id`, `tool_filter` and similar fields.
  - Sources: [bin: `session_store.py` `load_session_steps`, `_extract_tool_output`].
  - The `.proto` is **not published** (only `localharness.proto` is). Decoding needs either reverse-engineered field numbers or a replay through `session/load`.
  - Recommended import path: **`session/load` into a scratch connection**, which turns the history into ACP events.
- **CLI store [confirmed docs]:** `~/.gemini/antigravity-cli/conversations` (SQLite since a CLI changelog entry about the "SQLite conversation store"), plus `cache/last_conversations.json` and `cache/projects.json` (docs `cli/commands/resume`, changelog). Hooks receive a `transcriptPath` pointing to a `transcript.jsonl` (docs `hooks`). [unknown] the exact path and schema.
- **Desktop store [confirmed docs]:** `~/.gemini/antigravity/` holds artifacts and knowledge items (docs `agent-settings`).

## 9. Extras

- **Images and audio [confirmed]:** prompt capabilities include `image` and `audio`. Document MIME types are retagged to `text/plain` because Vertex and BAIC accept only `text/*` and `application/pdf` ([bin: `server.py` `_retag_unsupported_document_mime`]).
- **MCP [confirmed]:** client-supplied `mcpServers` (http/sse/stdio). MCP calls carry `_meta.mcp` and `is_mcp_tool_call: true`. Global config lives at `~/.gemini/config/mcp_config.json` and workspace config at `.agents/mcp_config.json`, both using the `serverUrl` key (docs `cli/gcli-migration`).
- **Rules, skills and agents [confirmed docs]:**
  - Rules: `GEMINI.md`/`AGENTS.md`, plus `~/.gemini/GEMINI.md`.
  - Skills: `.agents/skills/`.
  - Agents: `.agents/agents/<name>.md` and `~/.gemini/config/agents/`.
  - Hooks: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and `Stop`, configured in `hooks.json` (docs `hooks`). The ACP server wires external hooks ([bin: `hooks.py`]).
- **Usage and quotas:** ACP sends no token usage [confirmed]. The CLI has `/usage` (alias `/quota`) and `/credits` (docs `cli/reference`), and headless reports per-step `usage` [confirmed]. Consumer quota is "per-user" via the Code Assist backend (`ccpa`) ([bin: `quota_errors.py`]).
- **Telemetry [confirmed]:** the server sends interaction telemetry for Gemini Enterprise (BAIC) ([bin: `telemetry.py`]). The ToS says "interaction data" is recorded.

## 10. Gaps, risks, adapter notes

- **ToS:** see TL;DR 7. API-key auth runs under Gemini API terms and is the conservative default. Get an explicit opinion before enabling `oauth-personal`.
- **Maturity:** ACP 1.x was first published 2026-08-20 and has had three releases in five weeks.
  - The CLI has its own versioning (1.2.14) and moves faster.
  - Internal bug IDs are all over the source, and behaviour like tool-call reconciliation (pairing a permission frame with its execution by tool name in FIFO order) is heuristic.
  - Pin the version and re-run the probes on every bump.
- **Lossy subagents:** if ace needs an agent tree, the paths are:
  - (a) ask Google for an ACP extension that exposes `trajectory_id`/`parent_trajectory_id`, or
  - (b) a Python-SDK sidecar adapter (API-key auth only), or
  - (c) headless CLI for autonomous runs.
- **Error-as-text:** status classification needs string matching on known prefixes ("Usage Limit Reached", "Agent execution error:"). Keep the raw text.
- **Footprint:** a 112 MB download, about 400 MB unpacked, and a PyInstaller temp unpack on every launch.
- **Shared state:** if ace uses the default `~/.gemini`, Antigravity CLI, Desktop and the user's Gemini CLI configs share `config/` and `skills`. Using an ace-owned `GEMINI_HOME` isolates credentials but hides the user's MCP servers and hooks.

## Mapping to ace canonical model

| ace concept                  | Antigravity (ACP) source                                                                                                             | Notes / confidence                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root agent                   | ACP `sessionId` (UUIDv4)                                                                                                             | confirmed                                                                                                                                                                  |
| Subagent (child agent)       | `tool_call` titled `start_subagent` (kind `other`)                                                                                   | Model it as a **placeholder child** with `parentId` = root and status from the tool call. There is no child transcript. If `rawOutput` contains IDs, parse them. [unknown] |
| `starting`                   | spawn → `initialize` → (`authenticate`) → `session/new`/`load`                                                                       | confirmed                                                                                                                                                                  |
| `working{activity}`          | prompt in flight. Activity: thinking (`agent_thought_chunk`), responding (`agent_message_chunk`), tool (open `tool_call` of kind X)  | confirmed                                                                                                                                                                  |
| `blocked{human}`             | outstanding `session/request_permission`. A `toolCallId` starting with `interaction_` means a question; anything else is an approval | confirmed                                                                                                                                                                  |
| `blocked{background_task}`   | `execute` tool calls left `in_progress` after `PromptResponse`                                                                       | confirmed                                                                                                                                                                  |
| `blocked{subagents}`         | an open `start_subagent` call                                                                                                        | weak. The harness's `WAITING_FOR_TASKS` is not exposed [confirmed absent]                                                                                                  |
| `blocked{rate_limit}`        | text "Usage Limit Reached…" or `stopReason: refusal`                                                                                 | text-matched [confirmed strings]                                                                                                                                           |
| `blocked{network}`           | "connection lost" message after the rebuild retry                                                                                    | text-matched                                                                                                                                                               |
| `idle`                       | `end_turn`, no open exec or subagent calls, no pending permissions                                                                   | derived                                                                                                                                                                    |
| `interrupted`                | `stopReason: cancelled`                                                                                                              | confirmed                                                                                                                                                                  |
| `failed`                     | process exit, `auth_required`, "Agent execution error:" text, `failed` tool updates                                                  | derived                                                                                                                                                                    |
| `unresponsive`               | ace timer: prompt in flight with no update for N seconds                                                                             | ace-side only                                                                                                                                                              |
| Thread status                | aggregate of the root plus placeholder children and background tasks                                                                 | ace-side                                                                                                                                                                   |
| Tool: shell                  | `run_command`, `shell` (kind `execute`). `rawInput.CommandLine`/`Cwd`; `rawOutput` holds exit code and combined output               | confirmed                                                                                                                                                                  |
| Tool: file.read              | `view_file`, `read_file`, `client_view_file` (kind `read`)                                                                           | confirmed                                                                                                                                                                  |
| Tool: file.write             | `create_file`, `write_to_file`, `write_file`, `client_create_file` (kind `edit`, diff content)                                       | confirmed                                                                                                                                                                  |
| Tool: file.edit              | `edit_file`, `replace_file_content`, `multi_replace_file_content`, `client_edit_file`                                                | confirmed                                                                                                                                                                  |
| Tool: file.delete / move     | no dedicated tool. Deletes and moves happen through `run_command`                                                                    | inferred                                                                                                                                                                   |
| Tool: search                 | `grep_search`, `search_directory`, `find_by_name`, `find_file`, `list_dir`, `list_directory`                                         | confirmed                                                                                                                                                                  |
| Tool: web.search / web.fetch | `search_web` / `read_url_content` (kind `fetch`)                                                                                     | confirmed                                                                                                                                                                  |
| Tool: mcp                    | `call_mcp_tool`, or any call with `_meta.is_mcp_tool_call`. The server and tool come from `_meta.mcp`                                | confirmed                                                                                                                                                                  |
| Tool: agent.spawn            | `start_subagent`                                                                                                                     | confirmed                                                                                                                                                                  |
| Tool: agent.message          | not observed over ACP. Inter-agent messaging is internal to the harness                                                              | unknown                                                                                                                                                                    |
| Tool: plan/todo              | none (no ACP `plan` updates). Plan artifacts are files in `brain/`                                                                   | confirmed absent                                                                                                                                                           |
| Tool: browser                | `chrome_devtools/*` MCP tools (Enterprise only)                                                                                      | confirmed                                                                                                                                                                  |
| Tool: image                  | `generate_image` (`rawOutput.imagePath`)                                                                                             | confirmed                                                                                                                                                                  |
| Tool: ask_user               | `ask_question` → `interaction_*` permission request                                                                                  | confirmed                                                                                                                                                                  |
| Tool: custom                 | `manage_task`, `schedule`, skill lookup, `finish` and anything else                                                                  | keep the raw name and input                                                                                                                                                |
| Interaction: approval        | `request_permission` options `allow_once`/`allow_always`/`reject_once`. Show `_meta["agy.security.warning"]`                         | confirmed                                                                                                                                                                  |
| Interaction: question        | single-select only; answer = `optionId`                                                                                              | confirmed                                                                                                                                                                  |
| Interaction: plan review     | unknown mechanism                                                                                                                    | needs live run                                                                                                                                                             |
| Raw retention                | `title`, `rawInput`, `rawOutput`, `_meta` on every tool update                                                                       | confirmed                                                                                                                                                                  |

## Open questions / needs live verification

1. What `start_subagent`'s `rawInput`/`rawOutput` contain (IDs, roles), whether a subagent's steps leak into the parent stream, and whether a turn returns while subagents are still running.
2. How `/plan` approval and artifact review show up over ACP.
3. Whether any `session/update` is emitted between prompts (background command completion).
4. How the workspace-trust prompt appears to the client.
5. Startup latency, memory per session, and harness-process count per session; temp-dir growth.
6. Whether `session/request_permission` fires for subagent tool calls, and with what titles.
7. Google's position on ACP clients other than Zed and JetBrains using `oauth-personal` under the ToS clause.
8. CLI transcript (`transcript.jsonl`) location and schema, for import.

## Sources

- ACP registry entry: https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json (commits `a3d294f480` 2026-08-20, `81bf71b55e` 2026-09-03, `3ee7f11880` 2026-09-23).
- ACP server binary: https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip. To reproduce: `unzip`, then `strings -n 6 agy_acp_server.par`. The embedded files start with `google3/cloud/developer_experience/antigravity_extensions/acp_server/<file>.py` (`server.py`, `paths.py`, `session_store.py`, `tools.py`, `tool_filter.py`, `config_options.py`, `browser_subagent.py`, `quota_errors.py`, `main.py`, `workspace_trust.py`, `hooks.py`).
- Python SDK: https://github.com/google-antigravity/antigravity-sdk-python
  - `google/antigravity/proto/localharness.proto`
  - `connections/local/local_connection.py:761-818`
  - `connections/local/event_processor.py:609-740`
  - `types.py:1004-1170`, `types.py:1774-1782`
  - `pyproject.toml` (Apache-2.0, 0.1.20)
  - PyPI: https://pypi.org/project/google-antigravity/
- Antigravity CLI repo: https://github.com/google-antigravity/antigravity-cli (`README.md`, `CHANGELOG.md` 1.2.12–1.2.14).
- Antigravity docs (all under https://antigravity.google/docs/):
  - `ide/extensions/`, `ide/extensions/zed/`, `ide/extensions/jetbrains/`
  - `cli/overview/`, `cli/install/`, `cli/headless/`, `cli/reference/`, `cli/modes/`, `cli/conversations/`, `cli/artifacts/`, `cli/commands/agents/`, `cli/gcli-migration/`
  - `subagents/`, `remote-control/`, `artifacts/`, `hooks/`, `agent-settings/`, `sdk/overview/`, `sdk/subagents/`, `changelog/`
- Terms: https://antigravity.google/terms
- Gemini CLI transition: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Managed agent API: https://ai.google.dev/gemini-api/docs/antigravity-agent
- ACP spec: https://agentclientprotocol.com/protocol/schema
- Gemini CLI 0.43.0: local `gemini --help` (`--acp`, `--approval-mode default|auto_edit|yolo|plan`).
- Pointer only, not an authority: t3code's `apps/server/src/provider/acp/Antigravity*.ts` and `antigravityRelease.ts` directed this research to the registry entry, `GEMINI_HOME` and the `interaction_` and `start_subagent` conventions. Every fact above was re-checked against the primary sources.
