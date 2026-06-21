use super::GitApiError;
use ace_git::{GitClient, ProcessRunner, TokioProcessRunner};
use ace_protocol::git::{
    GitBranchesRequest, GitDiffRequest, GitRepositoryRequest, GitStatusRequest, GitWorktreesRequest,
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

fn repo_path(raw: &str) -> Result<PathBuf, GitApiError> {
    if raw.trim().is_empty() {
        Err(GitApiError::EmptyRepoPath)
    } else {
        Ok(PathBuf::from(raw))
    }
}
