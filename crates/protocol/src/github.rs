use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentStatusRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueListRequest {
    pub repo_path: String,
    pub filter: IssueListFilter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueThreadRequest {
    pub repo_path: String,
    pub number: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueListFilter {
    pub limit: u32,
    pub state: String,
    pub author: Option<String>,
    pub assignee: Option<String>,
    pub mention: Option<String>,
    pub milestone: Option<String>,
    pub search: Option<String>,
    pub labels: Vec<String>,
}

impl Default for IssueListFilter {
    fn default() -> Self {
        Self {
            limit: 30,
            state: "open".to_string(),
            author: None,
            assignee: None,
            mention: None,
            milestone: None,
            search: None,
            labels: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestListRequest {
    pub repo_path: String,
    pub filter: PullRequestListFilter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestRequest {
    pub repo_path: String,
    pub selector: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestFilesRequest {
    pub repo_path: String,
    pub selector: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestDiffRequest {
    pub repo_path: String,
    pub selector: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestListFilter {
    pub limit: u32,
    pub state: String,
    pub author: Option<String>,
    pub assignee: Option<String>,
    pub base: Option<String>,
    pub head: Option<String>,
    pub search: Option<String>,
    pub labels: Vec<String>,
    pub draft_only: bool,
}

impl Default for PullRequestListFilter {
    fn default() -> Self {
        Self {
            limit: 30,
            state: "open".to_string(),
            author: None,
            assignee: None,
            base: None,
            head: None,
            search: None,
            labels: Vec::new(),
            draft_only: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchIssuesRequest {
    pub repo_path: String,
    pub query: String,
    pub filter: SearchFilter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchPullRequestsRequest {
    pub repo_path: String,
    pub query: String,
    pub filter: SearchFilter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchFilter {
    pub limit: u32,
    pub state: Option<String>,
    pub author: Option<String>,
    pub assignee: Option<String>,
    pub owner: Vec<String>,
    pub repo: Vec<String>,
    pub labels: Vec<String>,
    pub sort: Option<String>,
    pub order: Option<String>,
    pub include_prs_in_issue_search: bool,
}

impl Default for SearchFilter {
    fn default() -> Self {
        Self {
            limit: 30,
            state: None,
            author: None,
            assignee: None,
            owner: Vec::new(),
            repo: Vec::new(),
            labels: Vec::new(),
            sort: None,
            order: None,
            include_prs_in_issue_search: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestChecksRequest {
    pub repo_path: String,
    pub selector: Option<String>,
    pub required_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestActivityRequest {
    pub repo_path: String,
    pub selector: String,
    pub required_checks_only: bool,
    pub workflow_run_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestDashboardRequest {
    pub repo_path: String,
    pub filter: PullRequestListFilter,
    pub required_checks_only: bool,
    pub workflow_run_limit_per_pr: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunListRequest {
    pub repo_path: String,
    pub filter: WorkflowRunListFilter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunListFilter {
    pub limit: u32,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub status: Option<String>,
    pub workflow: Option<String>,
    pub event: Option<String>,
    pub user: Option<String>,
    pub include_disabled: bool,
}

impl Default for WorkflowRunListFilter {
    fn default() -> Self {
        Self {
            limit: 20,
            branch: None,
            commit: None,
            status: None,
            workflow: None,
            event: None,
            user: None,
            include_disabled: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunRequest {
    pub repo_path: String,
    pub run_id: u64,
    pub attempt: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunLogRequest {
    pub repo_path: String,
    pub run_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestCheckoutRequest {
    pub repo_path: String,
    pub selector: String,
    pub branch: Option<String>,
    pub detach: bool,
    pub force: bool,
    pub recurse_submodules: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestCommentRequest {
    pub repo_path: String,
    pub selector: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestReviewRequest {
    pub repo_path: String,
    pub selector: String,
    pub decision: PullRequestReviewDecision,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PullRequestReviewDecision {
    Approve,
    Comment,
    RequestChanges,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestReadyStateRequest {
    pub repo_path: String,
    pub selector: String,
    pub draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestCloseRequest {
    pub repo_path: String,
    pub selector: String,
    pub comment: Option<String>,
    pub delete_branch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestReopenRequest {
    pub repo_path: String,
    pub selector: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestMergeRequest {
    pub repo_path: String,
    pub selector: String,
    pub method: PullRequestMergeMethod,
    pub auto: bool,
    pub admin: bool,
    pub delete_branch: bool,
    pub disable_auto: bool,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub author_email: Option<String>,
    pub match_head_commit: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PullRequestMergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunRerunRequest {
    pub repo_path: String,
    pub run_id: u64,
    pub failed_only: bool,
    pub debug: bool,
    pub job_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunCancelRequest {
    pub repo_path: String,
    pub run_id: u64,
}
