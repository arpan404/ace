# Backend API

## Is the backend complete?

Complete enough for the current local desktop/runtime path: health/status, WebSocket RPC, Git, GitHub, projects/files, workspace edits/file events, editor/LSP, terminal sessions, checkpoints, Codex bridge, and provider runtime are wired.

Not complete as a hosted/mobile backend: no auth, TLS, multi-user isolation, or public HTTP API for every feature. The canonical API is the local WebSocket RPC.

## Run it

```bash
cargo run -p ace-backend -- --port 3773
# LAN testing only:
cargo run -p ace-backend -- --lan --port 3773
```

Default bind: `127.0.0.1:3773`. Env vars: `ACE_PORT`, `ACE_LAN`.

## Health/status

```bash
curl http://127.0.0.1:3773/health
curl http://127.0.0.1:3773/api/status
```

`/api/status` returns:

```json
{ "ok": true, "protocol_version": 1 }
```

## WebSocket RPC

Endpoint: `ws://127.0.0.1:3773/ws` or `/api/ws`.

Request envelope:

```json
{
  "version": 1,
  "request_id": "unique-id",
  "method": "git.status",
  "payload": { "repo_path": "/path/to/repo" }
}
```

Success:

```json
{
  "version": 1,
  "request_id": "unique-id",
  "payload": { "type": "result", "body": {} }
}
```

Error:

```json
{
  "version": 1,
  "request_id": "unique-id",
  "payload": { "type": "error", "code": "invalid_payload", "message": "..." }
}
```

Server-pushed events use an empty `request_id`:

```json
{
  "version": 1,
  "request_id": "",
  "payload": { "type": "event", "topic": "terminal.event", "body": {} }
}
```

Tiny JS client:

```js
const ws = new WebSocket("ws://127.0.0.1:3773/ws");
let id = 0;

ws.onmessage = (e) => console.log(JSON.parse(e.data));

function call(method, payload = {}) {
  ws.send(JSON.stringify({
    version: 1,
    request_id: String(++id),
    method,
    payload,
  }));
}

ws.onopen = () => call("git.status", { repo_path: "/path/to/repo" });
```

CLI test with `websocat`:

```bash
printf '%s\n' '{"version":1,"request_id":"1","method":"git.status","payload":{"repo_path":"/path/to/repo"}}' \
  | websocat ws://127.0.0.1:3773/ws
```

## Common tasks

### Git status/diff/commit

```json
{ "version": 1, "request_id": "git-1", "method": "git.status", "payload": { "repo_path": "/repo" } }
```

```json
{ "version": 1, "request_id": "git-2", "method": "git.diff", "payload": { "repo_path": "/repo" } }
```

```json
{
  "version": 1,
  "request_id": "git-3",
  "method": "git.commit",
  "payload": { "repo_path": "/repo", "message": "ship it" }
}
```

### Create branch / push / PR workflow

```json
{
  "version": 1,
  "request_id": "branch-1",
  "method": "git.branches.create",
  "payload": { "repo_path": "/repo", "branch": "feature/x", "start_point": "main" }
}
```

```json
{
  "version": 1,
  "request_id": "workflow-1",
  "method": "git.workflow.run",
  "payload": {
    "repo_path": "/repo",
    "action": {
      "type": "commit_push_pr",
      "message": "ship it",
      "set_upstream": true,
      "default_branch_policy": "Deny",
      "request": { "title": "Ship it", "body": "Body", "head": "feature/x", "base": "main", "draft": false }
    }
  }
}
```

### GitHub issues and pull requests

Requires GitHub CLI auth in that repo (`gh auth login`).

```json
{
  "version": 1,
  "request_id": "issues-1",
  "method": "github.issues.list",
  "payload": { "repo_path": "/repo", "filter": { "limit": 20, "state": "open", "labels": ["bug"] } }
}
```

```json
{
  "version": 1,
  "request_id": "pr-1",
  "method": "github.pull_request.view",
  "payload": { "repo_path": "/repo", "selector": "42" }
}
```

```json
{
  "version": 1,
  "request_id": "pr-2",
  "method": "github.pull_request.comment",
  "payload": { "repo_path": "/repo", "selector": "42", "body": "Looks good." }
}
```

### Projects and files

```json
{ "version": 1, "request_id": "projects-1", "method": "projects.list", "payload": {} }
```

```json
{
  "version": 1,
  "request_id": "projects-2",
  "method": "projects.add",
  "payload": { "workspace_root": "/repo", "title": "Repo", "default_model_selection": null }
}
```

```json
{
  "version": 1,
  "request_id": "file-1",
  "method": "projects.read_file",
  "payload": { "cwd": "/repo", "relative_path": "README.md" }
}
```

```json
{
  "version": 1,
  "request_id": "file-2",
  "method": "projects.write_file",
  "payload": { "cwd": "/repo", "relative_path": "notes.txt", "contents": "hello\n", "expected_version": null, "overwrite": true }
}
```

### Terminal

Subscribe first if you want output events.

```json
{ "version": 1, "request_id": "term-sub", "method": "terminal.events.subscribe", "payload": { "thread_id": "t1" } }
```

```json
{
  "version": 1,
  "request_id": "term-open",
  "method": "terminal.open",
  "payload": { "thread_id": "t1", "terminal_id": "default", "cwd": "/repo", "cols": 120, "rows": 30 }
}
```

```json
{
  "version": 1,
  "request_id": "term-write",
  "method": "terminal.write",
  "payload": { "thread_id": "t1", "terminal_id": "default", "data": "cargo test\n" }
}
```

### Editor/LSP

```json
{
  "version": 1,
  "request_id": "diag-sub",
  "method": "editor.diagnostics.subscribe",
  "payload": { "workspace_root": "/repo" }
}
```

```json
{
  "version": 1,
  "request_id": "hover-1",
  "method": "editor.hover",
  "payload": { "workspace_root": "/repo", "relative_path": "src/main.rs", "position": { "line": 10, "character": 4 } }
}
```

### Workspace edits/file events

```json
{
  "version": 1,
  "request_id": "fs-sub",
  "method": "workspace.file_events.subscribe",
  "payload": { "workspace_root": "/repo" }
}
```

```json
{
  "version": 1,
  "request_id": "edit-1",
  "method": "workspace.apply_edit",
  "payload": { "workspace_root": "/repo", "edit": { "changes": [] } }
}
```

Use the exact `WorkspaceEdit` shape from `crates/protocol/src/workspace.rs` / `ace_workspace`.

### Codex/provider runtime

Use typed methods when Ace exposes them, or `codex.raw_request` for a native Codex app-server call.

```json
{
  "version": 1,
  "request_id": "codex-raw-1",
  "method": "codex.raw_request",
  "payload": { "method": "thread/list", "params": {} }
}
```

```json
{ "version": 1, "request_id": "providers-1", "method": "provider_runtime.providers.list", "payload": {} }
```

```json
{
  "version": 1,
  "request_id": "provider-events",
  "method": "provider_runtime.events.subscribe",
  "payload": { "provider": "codex", "from_sequence_exclusive": null, "limit": 100 }
}
```

## All WebSocket methods

Payload/response structs live in `crates/protocol/src/*.rs`; dispatch lives in `crates/server/src/ws/*.rs`.

### Codex

`codex.raw_request`, `codex.thread.start`, `codex.thread.resume`, `codex.thread.fork`, `codex.side_chat.start`, `codex.thread.read`, `codex.threads.list`, `codex.threads.loaded_list`, `codex.thread.archive`, `codex.thread.unarchive`, `codex.thread.delete`, `codex.thread.unsubscribe`, `codex.thread.set_name`, `codex.thread.update_metadata`, `codex.thread.compact`, `codex.thread.rollback`, `codex.thread.inject_items`, `codex.turn.start`, `codex.turn.steer`, `codex.turn.plan_start`, `codex.turn.interrupt`, `codex.plan.continue_in_thread`, `codex.plan.fork_for_implementation`, `codex.plan.side_implementation`, `codex.config_requirements.read`, `codex.compatibility.inventory`, `codex.permission_profiles.list`, `codex.permissions.catalog`, `codex.permissions.preset.resolve`, `codex.thread.approve_guardian_denied_action`, `codex.goal.set`, `codex.goal.get`, `codex.goal.clear`, `codex.goal.pause`, `codex.goal.resume`, `codex.subagents.list`, `codex.subagent.read`, `codex.subagent.steer`, `codex.subagent.stop`, `codex.subagent.close`, `codex.handoff.to_agent`, `codex.handoff.to_location`, `codex.review.start`, `codex.thread.shell_command`, `codex.command.exec`, `codex.command.write_stdin`, `codex.command.resize`, `codex.command.terminate`, `codex.process.list`, `codex.process.clean`, `codex.process.spawn`, `codex.process.write_stdin`, `codex.process.resize_pty`, `codex.process.kill`, `codex.thread.background_terminals.list`, `codex.thread.background_terminals.clean`, `codex.thread.background_terminals.terminate`, `codex.mcp.status`, `codex.mcp.resource_read`, `codex.mcp.oauth_login`, `codex.mcp.tool_call`, `codex.fs.read_file`, `codex.fs.write_file`, `codex.fs.read_directory`, `codex.fs.create_directory`, `codex.fs.copy`, `codex.fs.remove`, `codex.fs.metadata`, `codex.fs.watch`, `codex.fs.unwatch`, `codex.skills.list`, `codex.skills.read`, `codex.skills.install`, `codex.skills.config_write`, `codex.skills.extra_roots_set`, `codex.plugins.installed`, `codex.plugins.list`, `codex.plugins.read`, `codex.plugins.install`, `codex.plugins.uninstall`, `codex.plugin_share.checkout`, `codex.plugin_share.delete`, `codex.plugin_share.list`, `codex.plugin_share.save`, `codex.plugin_share.update_targets`, `codex.apps.list`, `codex.apps.config_write`, `codex.remote.connection_list`, `codex.remote.handoff`, `codex.account.login_start`, `codex.account.login_cancel`, `codex.account.logout`, `codex.account.read`, `codex.account.rate_limit_reset_credit.consume`, `codex.account.rate_limits_read`, `codex.account.usage_read`, `codex.account.send_add_credits_nudge_email`, `codex.windows_sandbox.readiness`, `codex.windows_sandbox.setup_start`, `codex.config.read`, `codex.config.value_write`, `codex.config.batch_write`, `codex.config.mcp_server_reload`, `codex.collaboration_mode.list`, `codex.environment.add`, `codex.memory.reset`, `codex.experimental_feature.list`, `codex.experimental_feature.enablement_set`, `codex.external_agent_config.detect`, `codex.external_agent_config.import`, `codex.feedback.upload`, `codex.fuzzy_file_search`, `codex.fuzzy_file_search.session_start`, `codex.fuzzy_file_search.session_stop`, `codex.fuzzy_file_search.session_update`, `codex.hooks.list`, `codex.remote_control.client.list`, `codex.remote_control.client.revoke`, `codex.remote_control.disable`, `codex.remote_control.enable`, `codex.remote_control.pairing.start`, `codex.remote_control.pairing.status`, `codex.remote_control.status.read`, `codex.thread.decrement_elicitation`, `codex.thread.increment_elicitation`, `codex.thread.memory_mode.set`, `codex.thread.realtime.append_audio`, `codex.thread.realtime.append_speech`, `codex.thread.realtime.append_text`, `codex.thread.realtime.list_voices`, `codex.thread.realtime.start`, `codex.thread.realtime.stop`, `codex.thread.search`, `codex.thread.settings.update`, `codex.thread.turns.items.list`, `codex.thread.turns.list`, `codex.marketplace.add`, `codex.marketplace.remove`, `codex.marketplace.upgrade`, `codex.model.list`, `codex.model_provider.capabilities_read`, `codex.stderr_tail`, `codex.shutdown`, `codex.restart`.

### Provider runtime

`provider_runtime.events.subscribe`, `provider_runtime.events.recent`, `provider_runtime.providers.list`, `provider_runtime.contract`, `provider_runtime.adapter.validate`, `provider_runtime.operations.list`, `provider_runtime.features.list`, `provider_runtime.status.list`, `provider_runtime.state.get`, `provider_runtime.models.list`, `provider_runtime.model_provider.capabilities.read`, `provider_runtime.slash_commands.list`, `provider_runtime.lifecycle`, `provider_runtime.request.resolve`, `provider_runtime.request.resolve_batch`, `provider_runtime.request`, `provider_runtime.server_requests.list`, `provider_runtime.server_request.result`, `provider_runtime.server_request.error`, `provider_runtime.host_tools.list`, `provider_runtime.host_tool.invoke_server_request`.

### Git

`git.repository`, `git.status`, `git.diff`, `git.changed_files`, `git.branches`, `git.remotes`, `git.branches.create`, `git.branches.checkout`, `git.branches.rename`, `git.branches.delete`, `git.fetch`, `git.pull`, `git.push`, `git.stage`, `git.unstage`, `git.commit`, `git.commits`, `git.commits.compare`, `git.stashes`, `git.stashes.save`, `git.stashes.apply`, `git.stashes.pop`, `git.stashes.drop`, `git.worktrees`, `git.worktrees.create`, `git.worktrees.remove`, `git.workflow.run`.

### Projects/workspace/editor/LSP/checkpoints/terminal

`projects.list`, `projects.add`, `projects.update`, `projects.delete`, `projects.search_entries`, `projects.list_tree`, `projects.resolve_favicon`, `projects.create_entry`, `projects.delete_entry`, `projects.read_file`, `projects.rename_entry`, `projects.write_file`.

`workspace.apply_edit`, `workspace.file_events.subscribe`.

`editor.buffer.sync`, `editor.buffer.close`, `editor.diagnostics.subscribe`, `editor.completion`, `editor.hover`, `editor.definition`, `editor.references`, `editor.rename`, `editor.formatting`, `editor.code_actions`, `editor.document_symbols`, `editor.workspace_symbols`, `editor.semantic_tokens`, `editor.signature_help`.

`lsp_tools.list`, `lsp_tools.search`, `lsp_tools.status`, `lsp_tools.install`, `lsp_tools.upsert_custom`, `lsp_tools.uninstall_custom`.

`checkpoints.get_turn_diff`, `checkpoints.get_full_thread_diff`, `checkpoints.request_revert`.

`terminal.open`, `terminal.write`, `terminal.resize`, `terminal.clear`, `terminal.restart`, `terminal.close`, `terminal.list`, `terminal.terminate`, `terminal.events.subscribe`.

### GitHub

`github.environment.status`, `github.repository_activity`, `github.image.proxy`, `github.issues.list`, `github.issues.thread`, `github.issues.search`, `github.pull_requests.list`, `github.pull_requests.search`, `github.pull_request.create`, `github.pull_request.view`, `github.pull_request.thread`, `github.pull_request.timeline`, `github.pull_request.review_comments`, `github.pull_request.review_threads`, `github.pull_request.commits`, `github.pull_request.merge_status`, `github.pull_request.files`, `github.pull_request.diff`, `github.pull_request.checks`, `github.pull_request.diagnostics`, `github.check_runs.list`, `github.check_runs.view`, `github.check_runs.diagnostics`, `github.check_runs.annotations`, `github.check_runs.rerequest`, `github.check_suites.list`, `github.check_suites.view`, `github.check_suites.runs`, `github.check_suites.rerequest`, `github.commit_statuses.list`, `github.commit_checks.rollup`, `github.commit_checks.diagnostics`, `github.pull_request.activity`, `github.pull_request.ci_status`, `github.pull_request.dashboard`, `github.pull_request.checkout`, `github.pull_request.comment`, `github.pull_request.review`, `github.pull_request.ready_state`, `github.pull_request.close`, `github.pull_request.reopen`, `github.pull_request.merge`, `github.workflows.list`, `github.workflows.view`, `github.workflows.dispatch`, `github.workflows.enable`, `github.workflows.disable`, `github.workflow_runs.list`, `github.workflow_runs.view`, `github.workflow_run.diagnostics`, `github.workflow_runs.jobs`, `github.workflow_runs.log`, `github.workflow_runs.pending_deployments`, `github.workflow_runs.pending_deployments.review`, `github.workflow_runs.approvals`, `github.workflow_runs.artifacts`, `github.workflow_runs.artifacts.download`, `github.workflow_runs.approve`, `github.workflow_runs.rerun`, `github.workflow_runs.cancel`, `github.workflow_runs.force_cancel`, `github.workflow_jobs.view`, `github.workflow_jobs.log`, `github.workflow_jobs.diagnostics`.

## HTTP POST endpoints

These are legacy/convenience subsets. Prefer WebSocket for new clients.

Git:

`POST /api/git/repository`, `/api/git/status`, `/api/git/diff`, `/api/git/branches`, `/api/git/branches/create`, `/api/git/branches/checkout`, `/api/git/branches/rename`, `/api/git/branches/delete`, `/api/git/fetch`, `/api/git/pull`, `/api/git/push`, `/api/git/stage`, `/api/git/unstage`, `/api/git/commit`, `/api/git/stashes`, `/api/git/stashes/save`, `/api/git/stashes/apply`, `/api/git/stashes/pop`, `/api/git/stashes/drop`, `/api/git/worktrees`.

GitHub:

`POST /api/github/environment/status`, `/api/github/issues/list`, `/api/github/issues/thread`, `/api/github/issues/search`, `/api/github/pulls/list`, `/api/github/pulls/search`, `/api/github/pulls/view`, `/api/github/pulls/thread`, `/api/github/pulls/files`, `/api/github/pulls/diff`, `/api/github/pulls/checks`, `/api/github/pulls/activity`, `/api/github/pulls/dashboard`, `/api/github/pulls/checkout`, `/api/github/pulls/comment`, `/api/github/pulls/review`, `/api/github/pulls/ready-state`, `/api/github/pulls/close`, `/api/github/pulls/reopen`, `/api/github/pulls/merge`, `/api/github/workflows/list`, `/api/github/workflows/dispatch`, `/api/github/workflows/enable`, `/api/github/workflows/disable`, `/api/github/workflow-runs/list`, `/api/github/workflow-runs/view`, `/api/github/workflow-runs/log`, `/api/github/workflow-runs/failed-log`, `/api/github/workflow-runs/artifacts`, `/api/github/workflow-runs/rerun`, `/api/github/workflow-runs/cancel`.

Example:

```bash
curl -X POST http://127.0.0.1:3773/api/git/status \
  -H 'content-type: application/json' \
  -d '{"repo_path":"/path/to/repo"}'
```
