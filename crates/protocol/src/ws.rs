use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod methods {
    pub const GITHUB_PULL_REQUEST_CHECKS: &str = "github.pull_request.checks";
    pub const GITHUB_CHECK_RUNS_LIST: &str = "github.check_runs.list";
    pub const GITHUB_CHECK_RUNS_ANNOTATIONS: &str = "github.check_runs.annotations";
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
