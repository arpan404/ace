use super::GitApiError;
use ace_git::{GitClient, ProcessRunner, TokioProcessRunner};
use ace_protocol::git::{
    GitBranchesRequest, GitCheckoutBranchRequest, GitCreateBranchRequest, GitDeleteBranchRequest,
    GitDiffRequest, GitFetchRequest, GitPullRequest, GitPushRequest, GitRenameBranchRequest,
    GitRepositoryRequest, GitStatusRequest, GitWorktreesRequest,
};
use serde::Serialize;
use std::{path::PathBuf, sync::Arc};

pub struct GitApiState<R: ProcessRunner = TokioProcessRunner> {
    pub(super) service: Arc<GitService<R>>,
}

impl<R: ProcessRunner> Clone for GitApiState<R> {
    fn clone(&self) -> Self {
        Self {
            service: Arc::clone(&self.service),
        }
    }
}

impl GitApiState<TokioProcessRunner> {
    #[must_use]
    pub fn production() -> Self {
        Self {
            service: Arc::new(GitService::new(GitClient::new())),
        }
    }
}

impl<R: ProcessRunner> GitApiState<R> {
    #[must_use]
    pub fn new(service: GitService<R>) -> Self {
        Self {
            service: Arc::new(service),
        }
    }
}

pub struct GitService<R: ProcessRunner = TokioProcessRunner> {
    git: GitClient<R>,
}

impl<R: ProcessRunner> GitService<R> {
    #[must_use]
    pub fn new(git: GitClient<R>) -> Self {
        Self { git }
    }

    pub async fn repository(
        &self,
        request: GitRepositoryRequest,
    ) -> Result<ace_git::GitRepository, GitApiError> {
        self.git
            .repository(&repo_path(&request.repo_path)?)
            .await
            .map_err(GitApiError::from)
    }

    pub async fn status(
        &self,
        request: GitStatusRequest,
    ) -> Result<ace_git::GitStatus, GitApiError> {
        self.git
            .status(&repo_path(&request.repo_path)?)
            .await
            .map_err(GitApiError::from)
    }

    pub async fn diff(&self, request: GitDiffRequest) -> Result<GitDiffResponse, GitApiError> {
        let diff = self.git.diff(&repo_path(&request.repo_path)?).await?;
        Ok(GitDiffResponse { diff })
    }

    pub async fn branches(
        &self,
        request: GitBranchesRequest,
    ) -> Result<Vec<ace_git::GitBranch>, GitApiError> {
        self.git
            .list_branches(&repo_path(&request.repo_path)?)
            .await
            .map_err(GitApiError::from)
    }

    pub async fn create_branch(
        &self,
        request: GitCreateBranchRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .create_branch(
                &repo_path(&request.repo_path)?,
                &request.branch,
                request.start_point.as_deref(),
            )
            .await?;
        Ok(GitActionResponse {
            action: "create_branch",
            branch: Some(request.branch),
        })
    }

    pub async fn checkout_branch(
        &self,
        request: GitCheckoutBranchRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .checkout_branch(&repo_path(&request.repo_path)?, &request.branch)
            .await?;
        Ok(GitActionResponse {
            action: "checkout_branch",
            branch: Some(request.branch),
        })
    }

    pub async fn rename_branch(
        &self,
        request: GitRenameBranchRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .rename_branch(
                &repo_path(&request.repo_path)?,
                request.old.as_deref(),
                &request.new,
            )
            .await?;
        Ok(GitActionResponse {
            action: "rename_branch",
            branch: Some(request.new),
        })
    }

    pub async fn delete_branch(
        &self,
        request: GitDeleteBranchRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .delete_branch(
                &repo_path(&request.repo_path)?,
                &request.branch,
                request.force,
            )
            .await?;
        Ok(GitActionResponse {
            action: "delete_branch",
            branch: Some(request.branch),
        })
    }

    pub async fn fetch(&self, request: GitFetchRequest) -> Result<GitActionResponse, GitApiError> {
        self.git
            .fetch(&repo_path(&request.repo_path)?, request.prune)
            .await?;
        Ok(GitActionResponse {
            action: "fetch",
            branch: None,
        })
    }

    pub async fn pull(&self, request: GitPullRequest) -> Result<GitActionResponse, GitApiError> {
        self.git
            .pull_ff_only(&repo_path(&request.repo_path)?)
            .await?;
        Ok(GitActionResponse {
            action: "pull",
            branch: None,
        })
    }

    pub async fn push(&self, request: GitPushRequest) -> Result<GitActionResponse, GitApiError> {
        self.git
            .push_current_branch(&repo_path(&request.repo_path)?, request.set_upstream)
            .await?;
        Ok(GitActionResponse {
            action: "push",
            branch: None,
        })
    }

    pub async fn worktrees(
        &self,
        request: GitWorktreesRequest,
    ) -> Result<Vec<ace_git::GitWorktree>, GitApiError> {
        self.git
            .list_worktrees(&repo_path(&request.repo_path)?)
            .await
            .map_err(GitApiError::from)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitDiffResponse {
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitActionResponse {
    pub action: &'static str,
    pub branch: Option<String>,
}

fn repo_path(raw: &str) -> Result<PathBuf, GitApiError> {
    if raw.trim().is_empty() {
        Err(GitApiError::EmptyRepoPath)
    } else {
        Ok(PathBuf::from(raw))
    }
}
