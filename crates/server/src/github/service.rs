use super::{
    error::GithubApiError,
    mapping::{
        issue_list_filter, pull_request_list_filter, pull_request_merge_method,
        pull_request_review_decision, search_filter, workflow_run_list_filter,
    },
};
use ace_git::{
    GithubCliClient, ProcessRunner, PullRequestCheckout, PullRequestClose, PullRequestComment,
    PullRequestMerge, PullRequestReadyState, PullRequestReopen, PullRequestReview,
    TokioProcessRunner, WorkflowRunCancel, WorkflowRunRerun,
};
use ace_protocol::github::{
    EnvironmentStatusRequest, IssueListRequest, IssueThreadRequest, PullRequestActivityRequest,
    PullRequestCheckoutRequest, PullRequestChecksRequest, PullRequestCloseRequest,
    PullRequestCommentRequest, PullRequestDashboardRequest, PullRequestDiffRequest,
    PullRequestFilesRequest, PullRequestListRequest, PullRequestMergeRequest,
    PullRequestReadyStateRequest, PullRequestReopenRequest, PullRequestRequest,
    PullRequestReviewRequest, PullRequestThreadRequest, SearchIssuesRequest,
    SearchPullRequestsRequest, WorkflowRunCancelRequest, WorkflowRunListRequest,
    WorkflowRunLogRequest, WorkflowRunRequest, WorkflowRunRerunRequest,
};
use serde::Serialize;
use std::{path::PathBuf, sync::Arc};

pub struct GithubApiState<R: ProcessRunner = TokioProcessRunner> {
    pub(super) service: Arc<GithubService<R>>,
}

impl<R: ProcessRunner> Clone for GithubApiState<R> {
    fn clone(&self) -> Self {
        Self {
            service: Arc::clone(&self.service),
        }
    }
}

impl GithubApiState<TokioProcessRunner> {
    #[must_use]
    pub fn production() -> Self {
        Self {
            service: Arc::new(GithubService::new(GithubCliClient::new())),
        }
    }
}

impl<R: ProcessRunner> GithubApiState<R> {
    #[must_use]
    pub fn new(service: GithubService<R>) -> Self {
        Self {
            service: Arc::new(service),
        }
    }
}

pub struct GithubService<R: ProcessRunner = TokioProcessRunner> {
    github: GithubCliClient<R>,
}

impl<R: ProcessRunner> Clone for GithubService<R> {
    fn clone(&self) -> Self {
        Self {
            github: self.github.clone(),
        }
    }
}

impl<R: ProcessRunner> GithubService<R> {
    #[must_use]
    pub fn new(github: GithubCliClient<R>) -> Self {
        Self { github }
    }

    pub async fn environment_status(
        &self,
        request: EnvironmentStatusRequest,
    ) -> Result<ace_git::GithubEnvironmentStatus, GithubApiError> {
        self.github
            .environment_status(&repo_path(&request.repo_path)?)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn list_issues(
        &self,
        request: IssueListRequest,
    ) -> Result<Vec<ace_git::GithubIssueSummary>, GithubApiError> {
        self.github
            .list_issues_filtered(
                &repo_path(&request.repo_path)?,
                &issue_list_filter(request.filter),
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn issue_thread(
        &self,
        request: IssueThreadRequest,
    ) -> Result<ace_git::GithubIssueThread, GithubApiError> {
        self.github
            .issue_thread(&repo_path(&request.repo_path)?, request.number)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn list_pull_requests(
        &self,
        request: PullRequestListRequest,
    ) -> Result<Vec<ace_git::GithubPullRequestSummary>, GithubApiError> {
        self.github
            .list_pull_requests(
                &repo_path(&request.repo_path)?,
                &pull_request_list_filter(request.filter),
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn pull_request(
        &self,
        request: PullRequestRequest,
    ) -> Result<ace_git::GithubPullRequest, GithubApiError> {
        self.github
            .pull_request(&repo_path(&request.repo_path)?, &request.selector)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn pull_request_thread(
        &self,
        request: PullRequestThreadRequest,
    ) -> Result<ace_git::GithubPullRequestThread, GithubApiError> {
        self.github
            .pull_request_thread(&repo_path(&request.repo_path)?, &request.selector)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn pull_request_files(
        &self,
        request: PullRequestFilesRequest,
    ) -> Result<Vec<ace_git::GithubPullRequestFile>, GithubApiError> {
        self.github
            .pull_request_files(&repo_path(&request.repo_path)?, &request.selector)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn pull_request_diff(
        &self,
        request: PullRequestDiffRequest,
    ) -> Result<ace_git::GithubPullRequestDiff, GithubApiError> {
        self.github
            .pull_request_diff(&repo_path(&request.repo_path)?, &request.selector)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn search_issues(
        &self,
        request: SearchIssuesRequest,
    ) -> Result<Vec<ace_git::GithubSearchIssue>, GithubApiError> {
        self.github
            .search_issues(
                &repo_path(&request.repo_path)?,
                &request.query,
                &search_filter(request.filter),
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn search_pull_requests(
        &self,
        request: SearchPullRequestsRequest,
    ) -> Result<Vec<ace_git::GithubSearchPullRequest>, GithubApiError> {
        self.github
            .search_pull_requests(
                &repo_path(&request.repo_path)?,
                &request.query,
                &search_filter(request.filter),
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn pull_request_checks(
        &self,
        request: PullRequestChecksRequest,
    ) -> Result<ace_git::GithubPrChecks, GithubApiError> {
        self.github
            .pull_request_checks(
                &repo_path(&request.repo_path)?,
                request.selector.as_deref(),
                request.required_only,
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn pull_request_activity(
        &self,
        request: PullRequestActivityRequest,
    ) -> Result<ace_git::GithubPullRequestActivity, GithubApiError> {
        self.github
            .pull_request_activity(
                &repo_path(&request.repo_path)?,
                &ace_git::PullRequestActivityRequest {
                    selector: request.selector,
                    required_checks_only: request.required_checks_only,
                    workflow_run_limit: request.workflow_run_limit,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn pull_request_dashboard(
        &self,
        request: PullRequestDashboardRequest,
    ) -> Result<ace_git::GithubPullRequestDashboard, GithubApiError> {
        self.github
            .pull_request_dashboard(
                &repo_path(&request.repo_path)?,
                &ace_git::PullRequestDashboardRequest {
                    filter: pull_request_list_filter(request.filter),
                    required_checks_only: request.required_checks_only,
                    workflow_run_limit_per_pr: request.workflow_run_limit_per_pr,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn list_workflow_runs(
        &self,
        request: WorkflowRunListRequest,
    ) -> Result<Vec<ace_git::GithubWorkflowRun>, GithubApiError> {
        self.github
            .list_workflow_runs(
                &repo_path(&request.repo_path)?,
                &workflow_run_list_filter(request.filter),
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn workflow_run(
        &self,
        request: WorkflowRunRequest,
    ) -> Result<ace_git::GithubWorkflowRunDetail, GithubApiError> {
        self.github
            .workflow_run(
                &repo_path(&request.repo_path)?,
                request.run_id,
                request.attempt,
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn workflow_run_failed_log(
        &self,
        mut request: WorkflowRunLogRequest,
    ) -> Result<WorkflowRunLogResponse, GithubApiError> {
        request.failed_only = true;
        self.workflow_run_log(request).await
    }

    pub async fn workflow_run_log(
        &self,
        request: WorkflowRunLogRequest,
    ) -> Result<WorkflowRunLogResponse, GithubApiError> {
        let log = self
            .github
            .workflow_run_log(
                &repo_path(&request.repo_path)?,
                request.run_id,
                request.attempt,
                request.job_id,
                request.failed_only,
            )
            .await?;
        Ok(WorkflowRunLogResponse { log })
    }

    pub async fn checkout_pull_request(
        &self,
        request: PullRequestCheckoutRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .checkout_pull_request(
                &repo_path(&request.repo_path)?,
                &PullRequestCheckout {
                    selector: request.selector,
                    branch: request.branch,
                    detach: request.detach,
                    force: request.force,
                    recurse_submodules: request.recurse_submodules,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn comment_pull_request(
        &self,
        request: PullRequestCommentRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .comment_pull_request(
                &repo_path(&request.repo_path)?,
                &PullRequestComment {
                    selector: request.selector,
                    body: request.body,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn review_pull_request(
        &self,
        request: PullRequestReviewRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .review_pull_request(
                &repo_path(&request.repo_path)?,
                &PullRequestReview {
                    selector: request.selector,
                    decision: pull_request_review_decision(request.decision),
                    body: request.body,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn set_pull_request_ready_state(
        &self,
        request: PullRequestReadyStateRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .set_pull_request_ready_state(
                &repo_path(&request.repo_path)?,
                &PullRequestReadyState {
                    selector: request.selector,
                    draft: request.draft,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn close_pull_request(
        &self,
        request: PullRequestCloseRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .close_pull_request(
                &repo_path(&request.repo_path)?,
                &PullRequestClose {
                    selector: request.selector,
                    comment: request.comment,
                    delete_branch: request.delete_branch,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn reopen_pull_request(
        &self,
        request: PullRequestReopenRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .reopen_pull_request(
                &repo_path(&request.repo_path)?,
                &PullRequestReopen {
                    selector: request.selector,
                    comment: request.comment,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn merge_pull_request(
        &self,
        request: PullRequestMergeRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .merge_pull_request(
                &repo_path(&request.repo_path)?,
                &PullRequestMerge {
                    selector: request.selector,
                    method: pull_request_merge_method(request.method),
                    auto: request.auto,
                    admin: request.admin,
                    delete_branch: request.delete_branch,
                    disable_auto: request.disable_auto,
                    subject: request.subject,
                    body: request.body,
                    author_email: request.author_email,
                    match_head_commit: request.match_head_commit,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn rerun_workflow_run(
        &self,
        request: WorkflowRunRerunRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .rerun_workflow_run(
                &repo_path(&request.repo_path)?,
                &WorkflowRunRerun {
                    run_id: request.run_id,
                    failed_only: request.failed_only,
                    debug: request.debug,
                    job_id: request.job_id,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn cancel_workflow_run(
        &self,
        request: WorkflowRunCancelRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .cancel_workflow_run(
                &repo_path(&request.repo_path)?,
                &WorkflowRunCancel {
                    run_id: request.run_id,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkflowRunLogResponse {
    pub log: String,
}

fn repo_path(raw: &str) -> Result<PathBuf, GithubApiError> {
    if raw.trim().is_empty() {
        Err(GithubApiError::EmptyRepoPath)
    } else {
        Ok(PathBuf::from(raw))
    }
}
