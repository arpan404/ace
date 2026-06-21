use super::{
    error::GithubApiError,
    mapping::{
        check_run_list_filter, issue_list_filter, pull_request_list_filter,
        pull_request_merge_method, pull_request_review_decision, search_filter,
        workflow_list_filter, workflow_run_list_filter,
    },
};
use ace_git::{
    CreatePullRequest, GithubCliClient, ProcessRunner, PullRequestCheckout, PullRequestClose,
    PullRequestComment, PullRequestMerge, PullRequestReadyState, PullRequestReopen,
    PullRequestReview, TokioProcessRunner, WorkflowDispatch, WorkflowDispatchInput,
    WorkflowRunApprove, WorkflowRunCancel, WorkflowRunRerun, WorkflowStateChange,
};
use ace_protocol::github::{
    CheckRunAnnotationsRequest, CheckRunRequest, CheckRunRerequestRequest, CheckRunsRequest,
    CheckSuiteRequest, CheckSuiteRerequestRequest, CheckSuiteRunsRequest, CheckSuitesRequest,
    CommitCheckRollupRequest, CommitStatusesRequest, EnvironmentStatusRequest, IssueListRequest,
    IssueThreadRequest, PullRequestActivityRequest, PullRequestCheckoutRequest,
    PullRequestChecksRequest, PullRequestCloseRequest, PullRequestCommentRequest,
    PullRequestCommitsRequest, PullRequestCreateRequest, PullRequestDashboardRequest,
    PullRequestDiffRequest, PullRequestFilesRequest, PullRequestListRequest,
    PullRequestMergeRequest, PullRequestMergeStatusRequest, PullRequestReadyStateRequest,
    PullRequestReopenRequest, PullRequestRequest, PullRequestReviewRequest,
    PullRequestThreadRequest, SearchIssuesRequest, SearchPullRequestsRequest,
    WorkflowDisableRequest, WorkflowDispatchRequest, WorkflowEnableRequest, WorkflowJobLogRequest,
    WorkflowJobRequest, WorkflowListRequest, WorkflowRunApproveRequest,
    WorkflowRunArtifactDownloadRequest, WorkflowRunArtifactsRequest, WorkflowRunCancelRequest,
    WorkflowRunJobsRequest, WorkflowRunListRequest, WorkflowRunLogRequest,
    WorkflowRunPendingDeploymentsRequest, WorkflowRunRequest, WorkflowRunRerunRequest,
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

    pub async fn create_pull_request(
        &self,
        request: PullRequestCreateRequest,
    ) -> Result<ace_git::GithubPullRequest, GithubApiError> {
        self.github
            .create_pull_request(
                &repo_path(&request.repo_path)?,
                &CreatePullRequest {
                    title: request.title,
                    body: request.body,
                    head: request.head,
                    base: request.base,
                    draft: request.draft,
                },
            )
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

    pub async fn pull_request_commits(
        &self,
        request: PullRequestCommitsRequest,
    ) -> Result<Vec<ace_git::GithubPullRequestCommit>, GithubApiError> {
        self.github
            .pull_request_commits(&repo_path(&request.repo_path)?, &request.selector)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn pull_request_merge_status(
        &self,
        request: PullRequestMergeStatusRequest,
    ) -> Result<ace_git::GithubPullRequestMergeStatus, GithubApiError> {
        self.github
            .pull_request_merge_status(&repo_path(&request.repo_path)?, &request.selector)
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

    pub async fn list_check_runs(
        &self,
        request: CheckRunsRequest,
    ) -> Result<Vec<ace_git::GithubCheckRun>, GithubApiError> {
        self.github
            .list_check_runs(
                &repo_path(&request.repo_path)?,
                &request.git_ref,
                &check_run_list_filter(request.filter),
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn check_run(
        &self,
        request: CheckRunRequest,
    ) -> Result<ace_git::GithubCheckRun, GithubApiError> {
        self.github
            .check_run(&repo_path(&request.repo_path)?, request.check_run_id)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn list_check_suites(
        &self,
        request: CheckSuitesRequest,
    ) -> Result<Vec<ace_git::GithubCheckSuite>, GithubApiError> {
        self.github
            .list_check_suites(
                &repo_path(&request.repo_path)?,
                &request.git_ref,
                &check_run_list_filter(request.filter),
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn check_suite(
        &self,
        request: CheckSuiteRequest,
    ) -> Result<ace_git::GithubCheckSuite, GithubApiError> {
        self.github
            .check_suite(&repo_path(&request.repo_path)?, request.check_suite_id)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn list_check_suite_runs(
        &self,
        request: CheckSuiteRunsRequest,
    ) -> Result<Vec<ace_git::GithubCheckRun>, GithubApiError> {
        self.github
            .list_check_suite_runs(
                &repo_path(&request.repo_path)?,
                request.check_suite_id,
                &check_run_list_filter(request.filter),
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn list_commit_statuses(
        &self,
        request: CommitStatusesRequest,
    ) -> Result<Vec<ace_git::GithubCommitStatus>, GithubApiError> {
        self.github
            .list_commit_statuses(
                &repo_path(&request.repo_path)?,
                &request.git_ref,
                request.limit,
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn commit_check_rollup(
        &self,
        request: CommitCheckRollupRequest,
    ) -> Result<ace_git::GithubCommitCheckRollup, GithubApiError> {
        self.github
            .commit_check_rollup(
                &repo_path(&request.repo_path)?,
                &request.git_ref,
                &ace_git::CommitCheckRollupRequest {
                    check_run_limit: request.check_run_limit,
                    status_limit: request.status_limit,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn list_check_run_annotations(
        &self,
        request: CheckRunAnnotationsRequest,
    ) -> Result<Vec<ace_git::GithubCheckRunAnnotation>, GithubApiError> {
        self.github
            .list_check_run_annotations(
                &repo_path(&request.repo_path)?,
                request.check_run_id,
                request.limit,
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn rerequest_check_run(
        &self,
        request: CheckRunRerequestRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .rerequest_check_run(&repo_path(&request.repo_path)?, request.check_run_id)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn rerequest_check_suite(
        &self,
        request: CheckSuiteRerequestRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .rerequest_check_suite(&repo_path(&request.repo_path)?, request.check_suite_id)
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

    pub async fn list_workflows(
        &self,
        request: WorkflowListRequest,
    ) -> Result<Vec<ace_git::GithubWorkflow>, GithubApiError> {
        self.github
            .list_workflows(
                &repo_path(&request.repo_path)?,
                &workflow_list_filter(request.filter),
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn dispatch_workflow(
        &self,
        request: WorkflowDispatchRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .dispatch_workflow(
                &repo_path(&request.repo_path)?,
                &WorkflowDispatch {
                    workflow: request.workflow,
                    ref_name: request.ref_name,
                    inputs: request
                        .inputs
                        .into_iter()
                        .map(|input| WorkflowDispatchInput {
                            name: input.name,
                            value: input.value,
                        })
                        .collect(),
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn enable_workflow(
        &self,
        request: WorkflowEnableRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .enable_workflow(
                &repo_path(&request.repo_path)?,
                &WorkflowStateChange {
                    workflow: request.workflow,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn disable_workflow(
        &self,
        request: WorkflowDisableRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .disable_workflow(
                &repo_path(&request.repo_path)?,
                &WorkflowStateChange {
                    workflow: request.workflow,
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

    pub async fn list_workflow_run_jobs(
        &self,
        request: WorkflowRunJobsRequest,
    ) -> Result<Vec<ace_git::GithubWorkflowJob>, GithubApiError> {
        self.github
            .list_workflow_run_jobs(
                &repo_path(&request.repo_path)?,
                request.run_id,
                request.attempt,
                request.limit,
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

    pub async fn workflow_job(
        &self,
        request: WorkflowJobRequest,
    ) -> Result<ace_git::GithubWorkflowJobDetail, GithubApiError> {
        self.github
            .workflow_job(&repo_path(&request.repo_path)?, request.job_id)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn workflow_job_log(
        &self,
        request: WorkflowJobLogRequest,
    ) -> Result<WorkflowRunLogResponse, GithubApiError> {
        let log = self
            .github
            .workflow_job_log(&repo_path(&request.repo_path)?, request.job_id)
            .await?;
        Ok(WorkflowRunLogResponse { log })
    }

    pub async fn workflow_run_artifacts(
        &self,
        request: WorkflowRunArtifactsRequest,
    ) -> Result<Vec<ace_git::GithubWorkflowArtifact>, GithubApiError> {
        self.github
            .workflow_run_artifacts(&repo_path(&request.repo_path)?, request.run_id)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn workflow_run_pending_deployments(
        &self,
        request: WorkflowRunPendingDeploymentsRequest,
    ) -> Result<Vec<ace_git::GithubWorkflowPendingDeployment>, GithubApiError> {
        self.github
            .workflow_run_pending_deployments(&repo_path(&request.repo_path)?, request.run_id)
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn download_workflow_artifacts(
        &self,
        request: WorkflowRunArtifactDownloadRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .download_workflow_artifacts(
                &repo_path(&request.repo_path)?,
                &ace_git::WorkflowArtifactDownload {
                    run_id: request.run_id,
                    names: request.names,
                    patterns: request.patterns,
                    output_dir: request.output_dir,
                },
            )
            .await
            .map_err(GithubApiError::from)
    }

    pub async fn approve_workflow_run(
        &self,
        request: WorkflowRunApproveRequest,
    ) -> Result<ace_git::GithubActionResult, GithubApiError> {
        self.github
            .approve_workflow_run(
                &repo_path(&request.repo_path)?,
                &WorkflowRunApprove {
                    run_id: request.run_id,
                },
            )
            .await
            .map_err(GithubApiError::from)
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
