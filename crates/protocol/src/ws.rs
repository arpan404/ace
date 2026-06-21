use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod methods {
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
