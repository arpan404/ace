use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRepositoryRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitStatusRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitDiffRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitChangedFilesRequest {
    pub repo_path: String,
    pub staged: bool,
    pub include_untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitBranchesRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRemotesRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCreateBranchRequest {
    pub repo_path: String,
    pub branch: String,
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCheckoutBranchRequest {
    pub repo_path: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRenameBranchRequest {
    pub repo_path: String,
    pub old: Option<String>,
    pub new: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitDeleteBranchRequest {
    pub repo_path: String,
    pub branch: String,
    pub force: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitFetchRequest {
    pub repo_path: String,
    pub prune: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitPullRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitPushRequest {
    pub repo_path: String,
    pub set_upstream: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitStageRequest {
    pub repo_path: String,
    pub paths: Vec<String>,
    pub all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitUnstageRequest {
    pub repo_path: String,
    pub paths: Vec<String>,
    pub all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCommitRequest {
    pub repo_path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCommitsRequest {
    pub repo_path: String,
    pub limit: u32,
    pub rev: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCommitsCompareRequest {
    pub repo_path: String,
    pub base: String,
    pub head: String,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitStashesRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitStashSaveRequest {
    pub repo_path: String,
    pub message: Option<String>,
    pub include_untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitStashApplyRequest {
    pub repo_path: String,
    pub selector: Option<String>,
    pub index: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitStashPopRequest {
    pub repo_path: String,
    pub selector: Option<String>,
    pub index: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitStashDropRequest {
    pub repo_path: String,
    pub selector: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWorktreesRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWorktreeCreateRequest {
    pub repo_path: String,
    pub preferred_branch: String,
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWorktreeRemoveRequest {
    pub repo_path: String,
    pub path: String,
    pub force: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWorkflowRequest {
    pub repo_path: String,
    pub action: GitWorkflowAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GitWorkflowAction {
    Commit {
        message: String,
    },
    Push {
        set_upstream: bool,
        default_branch_policy: DefaultBranchPolicy,
    },
    CreatePr {
        request: CreatePullRequest,
        default_branch_policy: DefaultBranchPolicy,
    },
    CommitPush {
        message: String,
        set_upstream: bool,
        default_branch_policy: DefaultBranchPolicy,
    },
    CommitPushPr {
        message: String,
        set_upstream: bool,
        request: CreatePullRequest,
        default_branch_policy: DefaultBranchPolicy,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DefaultBranchPolicy {
    Deny,
    Allow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatePullRequest {
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
}
