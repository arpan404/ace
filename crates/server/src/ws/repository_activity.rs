use super::{WsApiState, WsDispatchError};
use ace_git::{GitRepository, GitStatus, GitWorktree, GithubPullRequestDashboard, ProcessRunner};
use ace_protocol::{
    git::{GitRepositoryRequest, GitStatusRequest, GitWorktreesRequest},
    github::{PullRequestDashboardRequest, PullRequestListFilter, RepositoryActivityRequest},
};
use serde::Serialize;

impl<R: ProcessRunner> WsApiState<R> {
    pub(super) async fn repository_activity(
        &self,
        request: RepositoryActivityRequest,
    ) -> Result<RepositoryActivity, WsDispatchError> {
        let repository = self
            .git
            .repository(GitRepositoryRequest {
                repo_path: request.repo_path.clone(),
            })
            .await?;
        let status = self
            .git
            .status(GitStatusRequest {
                repo_path: request.repo_path.clone(),
            })
            .await?;
        let worktrees = if request.include_worktrees {
            self.git
                .worktrees(GitWorktreesRequest {
                    repo_path: request.repo_path.clone(),
                })
                .await?
        } else {
            Vec::new()
        };

        let pull_requests = match status.current_branch.clone() {
            Some(branch) if !branch.is_empty() => {
                self.github
                    .pull_request_dashboard(PullRequestDashboardRequest {
                        repo_path: request.repo_path,
                        filter: PullRequestListFilter {
                            limit: request.pull_request_limit,
                            head: Some(branch),
                            ..PullRequestListFilter::default()
                        },
                        required_checks_only: request.required_checks_only,
                        workflow_run_limit_per_pr: request.workflow_run_limit_per_pr,
                    })
                    .await?
            }
            _ => GithubPullRequestDashboard { items: Vec::new() },
        };

        Ok(RepositoryActivity {
            repository,
            status,
            worktrees,
            pull_requests,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepositoryActivity {
    pub repository: GitRepository,
    pub status: GitStatus,
    pub worktrees: Vec<GitWorktree>,
    pub pull_requests: GithubPullRequestDashboard,
}
