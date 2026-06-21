use super::GitApiError;
use ace_git::{
    CreatePullRequest, DefaultBranchPolicy, GitClient, GitStackedAction, GitWorkflow,
    GithubCliClient, ProcessRunner, TokioProcessRunner, WorktreeConfig, WorktreeManager,
};
use ace_platform::AppPaths;
use ace_protocol::git::{
    GitBranchesRequest, GitChangedFilesRequest, GitCheckoutBranchRequest, GitCommitRequest,
    GitCommitsCompareRequest, GitCommitsRequest, GitCreateBranchRequest, GitDeleteBranchRequest,
    GitDiffRequest, GitFetchRequest, GitPullRequest, GitPushRequest, GitRenameBranchRequest,
    GitRepositoryRequest, GitStageRequest, GitStashApplyRequest, GitStashDropRequest,
    GitStashPopRequest, GitStashSaveRequest, GitStashesRequest, GitStatusRequest,
    GitUnstageRequest, GitWorkflowAction, GitWorkflowRequest, GitWorktreeCreateRequest,
    GitWorktreeRemoveRequest, GitWorktreesRequest,
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
    github: Option<GithubCliClient<R>>,
    worktree_root: Option<PathBuf>,
}

impl<R: ProcessRunner> GitService<R> {
    #[must_use]
    pub fn new(git: GitClient<R>) -> Self {
        Self {
            git,
            github: None,
            worktree_root: default_worktree_root(),
        }
    }

    #[must_use]
    pub fn new_with_github(git: GitClient<R>, github: GithubCliClient<R>) -> Self {
        Self {
            git,
            github: Some(github),
            worktree_root: default_worktree_root(),
        }
    }

    #[must_use]
    pub fn with_worktree_root(mut self, root: PathBuf) -> Self {
        self.worktree_root = Some(root);
        self
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

    pub async fn changed_files(
        &self,
        request: GitChangedFilesRequest,
    ) -> Result<Vec<ace_git::GitChangedFile>, GitApiError> {
        self.git
            .changed_files(
                &repo_path(&request.repo_path)?,
                request.staged,
                request.include_untracked,
            )
            .await
            .map_err(GitApiError::from)
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

    pub async fn stage(&self, request: GitStageRequest) -> Result<GitActionResponse, GitApiError> {
        self.git
            .stage(&repo_path(&request.repo_path)?, &request.paths, request.all)
            .await?;
        Ok(GitActionResponse {
            action: "stage",
            branch: None,
        })
    }

    pub async fn unstage(
        &self,
        request: GitUnstageRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .unstage(&repo_path(&request.repo_path)?, &request.paths, request.all)
            .await?;
        Ok(GitActionResponse {
            action: "unstage",
            branch: None,
        })
    }

    pub async fn commit(
        &self,
        request: GitCommitRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .commit(&repo_path(&request.repo_path)?, &request.message)
            .await?;
        Ok(GitActionResponse {
            action: "commit",
            branch: None,
        })
    }

    pub async fn commits(
        &self,
        request: GitCommitsRequest,
    ) -> Result<Vec<ace_git::GitCommitSummary>, GitApiError> {
        self.git
            .recent_commits(
                &repo_path(&request.repo_path)?,
                request.limit,
                request.rev.as_deref(),
            )
            .await
            .map_err(GitApiError::from)
    }

    pub async fn compare_commits(
        &self,
        request: GitCommitsCompareRequest,
    ) -> Result<ace_git::GitCommitComparison, GitApiError> {
        self.git
            .compare_commits(
                &repo_path(&request.repo_path)?,
                &request.base,
                &request.head,
                request.limit,
            )
            .await
            .map_err(GitApiError::from)
    }

    pub async fn stashes(
        &self,
        request: GitStashesRequest,
    ) -> Result<Vec<ace_git::GitStashEntry>, GitApiError> {
        self.git
            .list_stashes(&repo_path(&request.repo_path)?)
            .await
            .map_err(GitApiError::from)
    }

    pub async fn save_stash(
        &self,
        request: GitStashSaveRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .save_stash(
                &repo_path(&request.repo_path)?,
                request.message.as_deref(),
                request.include_untracked,
            )
            .await?;
        Ok(GitActionResponse {
            action: "stash_save",
            branch: None,
        })
    }

    pub async fn apply_stash(
        &self,
        request: GitStashApplyRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .apply_stash(
                &repo_path(&request.repo_path)?,
                request.selector.as_deref(),
                request.index,
            )
            .await?;
        Ok(GitActionResponse {
            action: "stash_apply",
            branch: None,
        })
    }

    pub async fn pop_stash(
        &self,
        request: GitStashPopRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .pop_stash(
                &repo_path(&request.repo_path)?,
                request.selector.as_deref(),
                request.index,
            )
            .await?;
        Ok(GitActionResponse {
            action: "stash_pop",
            branch: None,
        })
    }

    pub async fn drop_stash(
        &self,
        request: GitStashDropRequest,
    ) -> Result<GitActionResponse, GitApiError> {
        self.git
            .drop_stash(&repo_path(&request.repo_path)?, request.selector.as_deref())
            .await?;
        Ok(GitActionResponse {
            action: "stash_drop",
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

    pub async fn create_worktree(
        &self,
        request: GitWorktreeCreateRequest,
    ) -> Result<ace_git::WorktreeCreateResult, GitApiError> {
        let repo = repo_path(&request.repo_path)?;
        let branch_names = self
            .git
            .list_branches(&repo)
            .await?
            .into_iter()
            .map(|branch| branch.name)
            .collect::<Vec<_>>();
        self.worktree_manager()?
            .create(
                &repo,
                &request.preferred_branch,
                &branch_names,
                request.start_point.as_deref(),
            )
            .await
            .map_err(GitApiError::from)
    }

    pub async fn remove_worktree(
        &self,
        request: GitWorktreeRemoveRequest,
    ) -> Result<ace_git::WorktreeRemoveResult, GitApiError> {
        let repo = repo_path(&request.repo_path)?;
        self.worktree_manager()?
            .remove(&repo, &PathBuf::from(request.path), request.force)
            .await
            .map_err(GitApiError::from)
    }

    pub async fn run_workflow(
        &self,
        request: GitWorkflowRequest,
    ) -> Result<ace_git::GitWorkflowOutcome, GitApiError> {
        let github = self
            .github
            .clone()
            .ok_or(GitApiError::WorkflowUnavailable)?;
        let workflow = GitWorkflow::new(self.git.clone(), github);
        workflow
            .run(
                &repo_path(&request.repo_path)?,
                git_stacked_action(request.action),
            )
            .await
            .map_err(GitApiError::from)
    }

    fn worktree_manager(&self) -> Result<WorktreeManager<R>, GitApiError> {
        let root = self
            .worktree_root
            .clone()
            .ok_or(GitApiError::WorktreeUnavailable)?;
        Ok(WorktreeManager::new(
            self.git.clone(),
            WorktreeConfig { root },
        ))
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

fn default_worktree_root() -> Option<PathBuf> {
    AppPaths::resolve()
        .ok()
        .map(|paths| WorktreeConfig::from_app_paths(&paths).root)
}

fn git_stacked_action(action: GitWorkflowAction) -> GitStackedAction {
    match action {
        GitWorkflowAction::Commit { message } => GitStackedAction::Commit { message },
        GitWorkflowAction::Push {
            set_upstream,
            default_branch_policy,
        } => GitStackedAction::Push {
            set_upstream,
            default_branch_policy: map_default_branch_policy(default_branch_policy),
        },
        GitWorkflowAction::CreatePr {
            request,
            default_branch_policy,
        } => GitStackedAction::CreatePr {
            request: create_pull_request(request),
            default_branch_policy: map_default_branch_policy(default_branch_policy),
        },
        GitWorkflowAction::CommitPush {
            message,
            set_upstream,
            default_branch_policy,
        } => GitStackedAction::CommitPush {
            message,
            set_upstream,
            default_branch_policy: map_default_branch_policy(default_branch_policy),
        },
        GitWorkflowAction::CommitPushPr {
            message,
            set_upstream,
            request,
            default_branch_policy,
        } => GitStackedAction::CommitPushPr {
            message,
            set_upstream,
            request: create_pull_request(request),
            default_branch_policy: map_default_branch_policy(default_branch_policy),
        },
    }
}

fn map_default_branch_policy(
    policy: ace_protocol::git::DefaultBranchPolicy,
) -> DefaultBranchPolicy {
    match policy {
        ace_protocol::git::DefaultBranchPolicy::Deny => DefaultBranchPolicy::Deny,
        ace_protocol::git::DefaultBranchPolicy::Allow => DefaultBranchPolicy::Allow,
    }
}

fn create_pull_request(request: ace_protocol::git::CreatePullRequest) -> CreatePullRequest {
    CreatePullRequest {
        title: request.title,
        body: request.body,
        head: request.head,
        base: request.base,
        draft: request.draft,
    }
}
