use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod methods {
    pub const CODEX_RAW_REQUEST: &str = "codex.raw_request";
    pub const CODEX_THREAD_START: &str = "codex.thread.start";
    pub const CODEX_THREAD_RESUME: &str = "codex.thread.resume";
    pub const CODEX_THREAD_FORK: &str = "codex.thread.fork";
    pub const CODEX_SIDE_CHAT_START: &str = "codex.side_chat.start";
    pub const CODEX_THREAD_READ: &str = "codex.thread.read";
    pub const CODEX_THREADS_LIST: &str = "codex.threads.list";
    pub const CODEX_THREADS_LOADED_LIST: &str = "codex.threads.loaded_list";
    pub const CODEX_THREAD_ARCHIVE: &str = "codex.thread.archive";
    pub const CODEX_THREAD_UNARCHIVE: &str = "codex.thread.unarchive";
    pub const CODEX_THREAD_DELETE: &str = "codex.thread.delete";
    pub const CODEX_THREAD_UNSUBSCRIBE: &str = "codex.thread.unsubscribe";
    pub const CODEX_THREAD_SET_NAME: &str = "codex.thread.set_name";
    pub const CODEX_THREAD_UPDATE_METADATA: &str = "codex.thread.update_metadata";
    pub const CODEX_THREAD_COMPACT: &str = "codex.thread.compact";
    pub const CODEX_THREAD_ROLLBACK: &str = "codex.thread.rollback";
    pub const CODEX_THREAD_INJECT_ITEMS: &str = "codex.thread.inject_items";
    pub const CODEX_TURN_START: &str = "codex.turn.start";
    pub const CODEX_TURN_PLAN_START: &str = "codex.turn.plan_start";
    pub const CODEX_TURN_INTERRUPT: &str = "codex.turn.interrupt";
    pub const CODEX_PLAN_CONTINUE_IN_THREAD: &str = "codex.plan.continue_in_thread";
    pub const CODEX_PLAN_FORK_FOR_IMPLEMENTATION: &str = "codex.plan.fork_for_implementation";
    pub const CODEX_PLAN_SIDE_IMPLEMENTATION: &str = "codex.plan.side_implementation";
    pub const CODEX_CONFIG_REQUIREMENTS_READ: &str = "codex.config_requirements.read";
    pub const CODEX_PERMISSION_PROFILES_LIST: &str = "codex.permission_profiles.list";
    pub const CODEX_PERMISSION_CATALOG: &str = "codex.permissions.catalog";
    pub const CODEX_PERMISSION_PRESET_RESOLVE: &str = "codex.permissions.preset.resolve";
    pub const CODEX_THREAD_APPROVE_GUARDIAN_DENIED_ACTION: &str =
        "codex.thread.approve_guardian_denied_action";
    pub const CODEX_GOAL_SET: &str = "codex.goal.set";
    pub const CODEX_GOAL_GET: &str = "codex.goal.get";
    pub const CODEX_GOAL_CLEAR: &str = "codex.goal.clear";
    pub const CODEX_GOAL_PAUSE: &str = "codex.goal.pause";
    pub const CODEX_GOAL_RESUME: &str = "codex.goal.resume";
    pub const CODEX_SUBAGENTS_LIST: &str = "codex.subagents.list";
    pub const CODEX_SUBAGENT_READ: &str = "codex.subagent.read";
    pub const CODEX_SUBAGENT_STEER: &str = "codex.subagent.steer";
    pub const CODEX_SUBAGENT_STOP: &str = "codex.subagent.stop";
    pub const CODEX_SUBAGENT_CLOSE: &str = "codex.subagent.close";
    pub const CODEX_HANDOFF_TO_AGENT: &str = "codex.handoff.to_agent";
    pub const CODEX_STDERR_TAIL: &str = "codex.stderr_tail";
    pub const CODEX_SHUTDOWN: &str = "codex.shutdown";
    pub const CODEX_RESTART: &str = "codex.restart";
    pub const PROVIDER_RUNTIME_EVENTS_SUBSCRIBE: &str = "provider_runtime.events.subscribe";
    pub const PROVIDER_RUNTIME_PROVIDERS_LIST: &str = "provider_runtime.providers.list";
    pub const PROVIDER_RUNTIME_REQUEST: &str = "provider_runtime.request";
    pub const PROVIDER_RUNTIME_SERVER_REQUEST_RESULT: &str =
        "provider_runtime.server_request.result";
    pub const PROVIDER_RUNTIME_SERVER_REQUEST_ERROR: &str = "provider_runtime.server_request.error";

    pub const GIT_REPOSITORY: &str = "git.repository";
    pub const GIT_STATUS: &str = "git.status";
    pub const GIT_DIFF: &str = "git.diff";
    pub const GIT_CHANGED_FILES: &str = "git.changed_files";
    pub const GIT_BRANCHES: &str = "git.branches";
    pub const GIT_REMOTES: &str = "git.remotes";
    pub const GIT_BRANCHES_CREATE: &str = "git.branches.create";
    pub const GIT_BRANCHES_CHECKOUT: &str = "git.branches.checkout";
    pub const GIT_BRANCHES_RENAME: &str = "git.branches.rename";
    pub const GIT_BRANCHES_DELETE: &str = "git.branches.delete";
    pub const GIT_FETCH: &str = "git.fetch";
    pub const GIT_PULL: &str = "git.pull";
    pub const GIT_PUSH: &str = "git.push";
    pub const GIT_STAGE: &str = "git.stage";
    pub const GIT_UNSTAGE: &str = "git.unstage";
    pub const GIT_COMMIT: &str = "git.commit";
    pub const GIT_COMMITS: &str = "git.commits";
    pub const GIT_COMMITS_COMPARE: &str = "git.commits.compare";
    pub const GIT_STASHES: &str = "git.stashes";
    pub const GIT_STASHES_SAVE: &str = "git.stashes.save";
    pub const GIT_STASHES_APPLY: &str = "git.stashes.apply";
    pub const GIT_STASHES_POP: &str = "git.stashes.pop";
    pub const GIT_STASHES_DROP: &str = "git.stashes.drop";
    pub const GIT_WORKTREES: &str = "git.worktrees";
    pub const GIT_WORKTREES_CREATE: &str = "git.worktrees.create";
    pub const GIT_WORKTREES_REMOVE: &str = "git.worktrees.remove";
    pub const GIT_WORKFLOW_RUN: &str = "git.workflow.run";

    pub const PROJECTS_LIST: &str = "projects.list";
    pub const PROJECTS_ADD: &str = "projects.add";
    pub const PROJECTS_UPDATE: &str = "projects.update";
    pub const PROJECTS_DELETE: &str = "projects.delete";
    pub const PROJECTS_SEARCH_ENTRIES: &str = "projects.search_entries";
    pub const PROJECTS_LIST_TREE: &str = "projects.list_tree";
    pub const PROJECTS_RESOLVE_FAVICON: &str = "projects.resolve_favicon";
    pub const PROJECTS_CREATE_ENTRY: &str = "projects.create_entry";
    pub const PROJECTS_DELETE_ENTRY: &str = "projects.delete_entry";
    pub const PROJECTS_READ_FILE: &str = "projects.read_file";
    pub const PROJECTS_RENAME_ENTRY: &str = "projects.rename_entry";
    pub const PROJECTS_WRITE_FILE: &str = "projects.write_file";

    pub const WORKSPACE_APPLY_EDIT: &str = "workspace.apply_edit";
    pub const WORKSPACE_FILE_EVENTS_SUBSCRIBE: &str = "workspace.file_events.subscribe";

    pub const EDITOR_BUFFER_SYNC: &str = "editor.buffer.sync";
    pub const EDITOR_BUFFER_CLOSE: &str = "editor.buffer.close";
    pub const EDITOR_DIAGNOSTICS_SUBSCRIBE: &str = "editor.diagnostics.subscribe";
    pub const EDITOR_COMPLETION: &str = "editor.completion";
    pub const EDITOR_HOVER: &str = "editor.hover";
    pub const EDITOR_DEFINITION: &str = "editor.definition";
    pub const EDITOR_REFERENCES: &str = "editor.references";
    pub const EDITOR_RENAME: &str = "editor.rename";
    pub const EDITOR_FORMATTING: &str = "editor.formatting";
    pub const EDITOR_CODE_ACTIONS: &str = "editor.code_actions";
    pub const EDITOR_DOCUMENT_SYMBOLS: &str = "editor.document_symbols";
    pub const EDITOR_WORKSPACE_SYMBOLS: &str = "editor.workspace_symbols";
    pub const EDITOR_SEMANTIC_TOKENS: &str = "editor.semantic_tokens";
    pub const EDITOR_SIGNATURE_HELP: &str = "editor.signature_help";

    pub const LSP_TOOLS_LIST: &str = "lsp_tools.list";
    pub const LSP_TOOLS_SEARCH: &str = "lsp_tools.search";
    pub const LSP_TOOLS_STATUS: &str = "lsp_tools.status";
    pub const LSP_TOOLS_INSTALL: &str = "lsp_tools.install";
    pub const LSP_TOOLS_UPSERT_CUSTOM: &str = "lsp_tools.upsert_custom";
    pub const LSP_TOOLS_UNINSTALL_CUSTOM: &str = "lsp_tools.uninstall_custom";

    pub const CHECKPOINTS_TURN_DIFF: &str = "checkpoints.get_turn_diff";
    pub const CHECKPOINTS_FULL_THREAD_DIFF: &str = "checkpoints.get_full_thread_diff";
    pub const CHECKPOINTS_REQUEST_REVERT: &str = "checkpoints.request_revert";

    pub const TERMINAL_OPEN: &str = "terminal.open";
    pub const TERMINAL_WRITE: &str = "terminal.write";
    pub const TERMINAL_RESIZE: &str = "terminal.resize";
    pub const TERMINAL_CLEAR: &str = "terminal.clear";
    pub const TERMINAL_RESTART: &str = "terminal.restart";
    pub const TERMINAL_CLOSE: &str = "terminal.close";
    pub const TERMINAL_LIST: &str = "terminal.list";
    pub const TERMINAL_TERMINATE: &str = "terminal.terminate";
    pub const TERMINAL_EVENTS_SUBSCRIBE: &str = "terminal.events.subscribe";

    pub const GITHUB_ENVIRONMENT_STATUS: &str = "github.environment.status";
    pub const GITHUB_REPOSITORY_ACTIVITY: &str = "github.repository_activity";
    pub const GITHUB_IMAGE_PROXY: &str = "github.image.proxy";
    pub const GITHUB_ISSUES_LIST: &str = "github.issues.list";
    pub const GITHUB_ISSUES_THREAD: &str = "github.issues.thread";
    pub const GITHUB_ISSUES_SEARCH: &str = "github.issues.search";
    pub const GITHUB_PULL_REQUESTS_LIST: &str = "github.pull_requests.list";
    pub const GITHUB_PULL_REQUESTS_SEARCH: &str = "github.pull_requests.search";
    pub const GITHUB_PULL_REQUEST_CREATE: &str = "github.pull_request.create";
    pub const GITHUB_PULL_REQUEST_VIEW: &str = "github.pull_request.view";
    pub const GITHUB_PULL_REQUEST_THREAD: &str = "github.pull_request.thread";
    pub const GITHUB_PULL_REQUEST_TIMELINE: &str = "github.pull_request.timeline";
    pub const GITHUB_PULL_REQUEST_REVIEW_COMMENTS: &str = "github.pull_request.review_comments";
    pub const GITHUB_PULL_REQUEST_REVIEW_THREADS: &str = "github.pull_request.review_threads";
    pub const GITHUB_PULL_REQUEST_COMMITS: &str = "github.pull_request.commits";
    pub const GITHUB_PULL_REQUEST_MERGE_STATUS: &str = "github.pull_request.merge_status";
    pub const GITHUB_PULL_REQUEST_FILES: &str = "github.pull_request.files";
    pub const GITHUB_PULL_REQUEST_DIFF: &str = "github.pull_request.diff";
    pub const GITHUB_PULL_REQUEST_CHECKS: &str = "github.pull_request.checks";
    pub const GITHUB_PULL_REQUEST_DIAGNOSTICS: &str = "github.pull_request.diagnostics";
    pub const GITHUB_CHECK_RUNS_LIST: &str = "github.check_runs.list";
    pub const GITHUB_CHECK_RUNS_VIEW: &str = "github.check_runs.view";
    pub const GITHUB_CHECK_RUNS_DIAGNOSTICS: &str = "github.check_runs.diagnostics";
    pub const GITHUB_CHECK_RUNS_ANNOTATIONS: &str = "github.check_runs.annotations";
    pub const GITHUB_CHECK_RUNS_REREQUEST: &str = "github.check_runs.rerequest";
    pub const GITHUB_CHECK_SUITES_LIST: &str = "github.check_suites.list";
    pub const GITHUB_CHECK_SUITES_VIEW: &str = "github.check_suites.view";
    pub const GITHUB_CHECK_SUITES_RUNS: &str = "github.check_suites.runs";
    pub const GITHUB_CHECK_SUITES_REREQUEST: &str = "github.check_suites.rerequest";
    pub const GITHUB_COMMIT_STATUSES_LIST: &str = "github.commit_statuses.list";
    pub const GITHUB_COMMIT_CHECK_ROLLUP: &str = "github.commit_checks.rollup";
    pub const GITHUB_COMMIT_CHECK_DIAGNOSTICS: &str = "github.commit_checks.diagnostics";
    pub const GITHUB_PULL_REQUEST_ACTIVITY: &str = "github.pull_request.activity";
    pub const GITHUB_PULL_REQUEST_CI_STATUS: &str = "github.pull_request.ci_status";
    pub const GITHUB_PULL_REQUEST_DASHBOARD: &str = "github.pull_request.dashboard";
    pub const GITHUB_PULL_REQUEST_CHECKOUT: &str = "github.pull_request.checkout";
    pub const GITHUB_PULL_REQUEST_COMMENT: &str = "github.pull_request.comment";
    pub const GITHUB_PULL_REQUEST_REVIEW: &str = "github.pull_request.review";
    pub const GITHUB_PULL_REQUEST_READY_STATE: &str = "github.pull_request.ready_state";
    pub const GITHUB_PULL_REQUEST_CLOSE: &str = "github.pull_request.close";
    pub const GITHUB_PULL_REQUEST_REOPEN: &str = "github.pull_request.reopen";
    pub const GITHUB_PULL_REQUEST_MERGE: &str = "github.pull_request.merge";
    pub const GITHUB_WORKFLOWS_LIST: &str = "github.workflows.list";
    pub const GITHUB_WORKFLOWS_VIEW: &str = "github.workflows.view";
    pub const GITHUB_WORKFLOWS_DISPATCH: &str = "github.workflows.dispatch";
    pub const GITHUB_WORKFLOWS_ENABLE: &str = "github.workflows.enable";
    pub const GITHUB_WORKFLOWS_DISABLE: &str = "github.workflows.disable";
    pub const GITHUB_WORKFLOW_RUNS_LIST: &str = "github.workflow_runs.list";
    pub const GITHUB_WORKFLOW_RUN_VIEW: &str = "github.workflow_runs.view";
    pub const GITHUB_WORKFLOW_RUN_DIAGNOSTICS: &str = "github.workflow_run.diagnostics";
    pub const GITHUB_WORKFLOW_RUN_JOBS: &str = "github.workflow_runs.jobs";
    pub const GITHUB_WORKFLOW_RUN_LOG: &str = "github.workflow_runs.log";
    pub const GITHUB_WORKFLOW_RUN_PENDING_DEPLOYMENTS: &str =
        "github.workflow_runs.pending_deployments";
    pub const GITHUB_WORKFLOW_RUN_PENDING_DEPLOYMENTS_REVIEW: &str =
        "github.workflow_runs.pending_deployments.review";
    pub const GITHUB_WORKFLOW_RUN_APPROVALS: &str = "github.workflow_runs.approvals";
    pub const GITHUB_WORKFLOW_RUN_ARTIFACTS: &str = "github.workflow_runs.artifacts";
    pub const GITHUB_WORKFLOW_RUN_ARTIFACTS_DOWNLOAD: &str =
        "github.workflow_runs.artifacts.download";
    pub const GITHUB_WORKFLOW_RUN_APPROVE: &str = "github.workflow_runs.approve";
    pub const GITHUB_WORKFLOW_RUN_RERUN: &str = "github.workflow_runs.rerun";
    pub const GITHUB_WORKFLOW_RUN_CANCEL: &str = "github.workflow_runs.cancel";
    pub const GITHUB_WORKFLOW_RUN_FORCE_CANCEL: &str = "github.workflow_runs.force_cancel";
    pub const GITHUB_WORKFLOW_JOBS_VIEW: &str = "github.workflow_jobs.view";
    pub const GITHUB_WORKFLOW_JOBS_LOG: &str = "github.workflow_jobs.log";
    pub const GITHUB_WORKFLOW_JOBS_DIAGNOSTICS: &str = "github.workflow_jobs.diagnostics";
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WsClientRequest {
    pub version: u16,
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WsServerResponse {
    pub version: u16,
    pub request_id: String,
    pub payload: WsServerPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsServerPayload {
    Result { body: Value },
    Event { topic: String, body: Value },
    Error { code: String, message: String },
}
