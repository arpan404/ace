use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod methods {
    pub const GIT_REPOSITORY: &str = "git.repository";
    pub const GIT_STATUS: &str = "git.status";
    pub const GIT_DIFF: &str = "git.diff";
    pub const GIT_BRANCHES: &str = "git.branches";
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
    pub const GIT_STASHES: &str = "git.stashes";
    pub const GIT_STASHES_SAVE: &str = "git.stashes.save";
    pub const GIT_STASHES_APPLY: &str = "git.stashes.apply";
    pub const GIT_STASHES_POP: &str = "git.stashes.pop";
    pub const GIT_STASHES_DROP: &str = "git.stashes.drop";
    pub const GIT_WORKTREES: &str = "git.worktrees";
    pub const GIT_WORKFLOW_RUN: &str = "git.workflow.run";

    pub const GITHUB_ENVIRONMENT_STATUS: &str = "github.environment.status";
    pub const GITHUB_ISSUES_LIST: &str = "github.issues.list";
    pub const GITHUB_ISSUES_THREAD: &str = "github.issues.thread";
    pub const GITHUB_ISSUES_SEARCH: &str = "github.issues.search";
    pub const GITHUB_PULL_REQUESTS_LIST: &str = "github.pull_requests.list";
    pub const GITHUB_PULL_REQUESTS_SEARCH: &str = "github.pull_requests.search";
    pub const GITHUB_PULL_REQUEST_CREATE: &str = "github.pull_request.create";
    pub const GITHUB_PULL_REQUEST_VIEW: &str = "github.pull_request.view";
    pub const GITHUB_PULL_REQUEST_THREAD: &str = "github.pull_request.thread";
    pub const GITHUB_PULL_REQUEST_FILES: &str = "github.pull_request.files";
    pub const GITHUB_PULL_REQUEST_DIFF: &str = "github.pull_request.diff";
    pub const GITHUB_PULL_REQUEST_CHECKS: &str = "github.pull_request.checks";
    pub const GITHUB_CHECK_RUNS_LIST: &str = "github.check_runs.list";
    pub const GITHUB_CHECK_RUNS_VIEW: &str = "github.check_runs.view";
    pub const GITHUB_CHECK_RUNS_ANNOTATIONS: &str = "github.check_runs.annotations";
    pub const GITHUB_CHECK_RUNS_REREQUEST: &str = "github.check_runs.rerequest";
    pub const GITHUB_CHECK_SUITES_LIST: &str = "github.check_suites.list";
    pub const GITHUB_CHECK_SUITES_RUNS: &str = "github.check_suites.runs";
    pub const GITHUB_CHECK_SUITES_REREQUEST: &str = "github.check_suites.rerequest";
    pub const GITHUB_COMMIT_STATUSES_LIST: &str = "github.commit_statuses.list";
    pub const GITHUB_PULL_REQUEST_ACTIVITY: &str = "github.pull_request.activity";
    pub const GITHUB_PULL_REQUEST_DASHBOARD: &str = "github.pull_request.dashboard";
    pub const GITHUB_PULL_REQUEST_CHECKOUT: &str = "github.pull_request.checkout";
    pub const GITHUB_PULL_REQUEST_COMMENT: &str = "github.pull_request.comment";
    pub const GITHUB_PULL_REQUEST_REVIEW: &str = "github.pull_request.review";
    pub const GITHUB_PULL_REQUEST_READY_STATE: &str = "github.pull_request.ready_state";
    pub const GITHUB_PULL_REQUEST_CLOSE: &str = "github.pull_request.close";
    pub const GITHUB_PULL_REQUEST_REOPEN: &str = "github.pull_request.reopen";
    pub const GITHUB_PULL_REQUEST_MERGE: &str = "github.pull_request.merge";
    pub const GITHUB_WORKFLOWS_LIST: &str = "github.workflows.list";
    pub const GITHUB_WORKFLOWS_DISPATCH: &str = "github.workflows.dispatch";
    pub const GITHUB_WORKFLOWS_ENABLE: &str = "github.workflows.enable";
    pub const GITHUB_WORKFLOWS_DISABLE: &str = "github.workflows.disable";
    pub const GITHUB_WORKFLOW_RUNS_LIST: &str = "github.workflow_runs.list";
    pub const GITHUB_WORKFLOW_RUN_VIEW: &str = "github.workflow_runs.view";
    pub const GITHUB_WORKFLOW_RUN_LOG: &str = "github.workflow_runs.log";
    pub const GITHUB_WORKFLOW_RUN_ARTIFACTS: &str = "github.workflow_runs.artifacts";
    pub const GITHUB_WORKFLOW_RUN_ARTIFACTS_DOWNLOAD: &str =
        "github.workflow_runs.artifacts.download";
    pub const GITHUB_WORKFLOW_RUN_RERUN: &str = "github.workflow_runs.rerun";
    pub const GITHUB_WORKFLOW_RUN_CANCEL: &str = "github.workflow_runs.cancel";
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
    Error { code: String, message: String },
}
