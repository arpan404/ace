use super::{GithubApiError, service::GithubApiState};
use ace_git::{ProcessRunner, TokioProcessRunner};
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
use axum::{Json, Router, extract::State, routing::post};

pub fn router() -> Router {
    router_with_state(GithubApiState::<TokioProcessRunner>::production())
}

pub fn router_with_state<R>(state: GithubApiState<R>) -> Router
where
    R: ProcessRunner + 'static,
{
    Router::new()
        .route("/environment/status", post(environment_status::<R>))
        .route("/issues/list", post(list_issues::<R>))
        .route("/issues/thread", post(issue_thread::<R>))
        .route("/pulls/list", post(list_pull_requests::<R>))
        .route("/pulls/view", post(pull_request::<R>))
        .route("/pulls/thread", post(pull_request_thread::<R>))
        .route("/pulls/files", post(pull_request_files::<R>))
        .route("/pulls/diff", post(pull_request_diff::<R>))
        .route("/issues/search", post(search_issues::<R>))
        .route("/pulls/search", post(search_pull_requests::<R>))
        .route("/pulls/checks", post(pull_request_checks::<R>))
        .route("/pulls/activity", post(pull_request_activity::<R>))
        .route("/pulls/dashboard", post(pull_request_dashboard::<R>))
        .route("/pulls/checkout", post(checkout_pull_request::<R>))
        .route("/pulls/comment", post(comment_pull_request::<R>))
        .route("/pulls/review", post(review_pull_request::<R>))
        .route(
            "/pulls/ready-state",
            post(set_pull_request_ready_state::<R>),
        )
        .route("/pulls/close", post(close_pull_request::<R>))
        .route("/pulls/reopen", post(reopen_pull_request::<R>))
        .route("/pulls/merge", post(merge_pull_request::<R>))
        .route("/workflow-runs/list", post(list_workflow_runs::<R>))
        .route("/workflow-runs/view", post(workflow_run::<R>))
        .route(
            "/workflow-runs/failed-log",
            post(workflow_run_failed_log::<R>),
        )
        .route("/workflow-runs/rerun", post(rerun_workflow_run::<R>))
        .route("/workflow-runs/cancel", post(cancel_workflow_run::<R>))
        .with_state(state)
}

async fn environment_status<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<EnvironmentStatusRequest>,
) -> Result<Json<ace_git::GithubEnvironmentStatus>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.environment_status(request).await.map(Json)
}

async fn list_issues<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<IssueListRequest>,
) -> Result<Json<Vec<ace_git::GithubIssueSummary>>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.list_issues(request).await.map(Json)
}

async fn issue_thread<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<IssueThreadRequest>,
) -> Result<Json<ace_git::GithubIssueThread>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.issue_thread(request).await.map(Json)
}

async fn list_pull_requests<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestListRequest>,
) -> Result<Json<Vec<ace_git::GithubPullRequestSummary>>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.list_pull_requests(request).await.map(Json)
}

async fn pull_request<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestRequest>,
) -> Result<Json<ace_git::GithubPullRequest>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.pull_request(request).await.map(Json)
}

async fn pull_request_thread<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestThreadRequest>,
) -> Result<Json<ace_git::GithubPullRequestThread>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.pull_request_thread(request).await.map(Json)
}

async fn pull_request_files<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestFilesRequest>,
) -> Result<Json<Vec<ace_git::GithubPullRequestFile>>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.pull_request_files(request).await.map(Json)
}

async fn pull_request_diff<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestDiffRequest>,
) -> Result<Json<ace_git::GithubPullRequestDiff>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.pull_request_diff(request).await.map(Json)
}

async fn search_issues<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<SearchIssuesRequest>,
) -> Result<Json<Vec<ace_git::GithubSearchIssue>>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.search_issues(request).await.map(Json)
}

async fn search_pull_requests<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<SearchPullRequestsRequest>,
) -> Result<Json<Vec<ace_git::GithubSearchPullRequest>>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.search_pull_requests(request).await.map(Json)
}

async fn pull_request_checks<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestChecksRequest>,
) -> Result<Json<ace_git::GithubPrChecks>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.pull_request_checks(request).await.map(Json)
}

async fn pull_request_activity<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestActivityRequest>,
) -> Result<Json<ace_git::GithubPullRequestActivity>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.pull_request_activity(request).await.map(Json)
}

async fn pull_request_dashboard<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestDashboardRequest>,
) -> Result<Json<ace_git::GithubPullRequestDashboard>, GithubApiError>
where
    R: ProcessRunner,
{
    state
        .service
        .pull_request_dashboard(request)
        .await
        .map(Json)
}

async fn list_workflow_runs<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<WorkflowRunListRequest>,
) -> Result<Json<Vec<ace_git::GithubWorkflowRun>>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.list_workflow_runs(request).await.map(Json)
}

async fn workflow_run<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<WorkflowRunRequest>,
) -> Result<Json<ace_git::GithubWorkflowRunDetail>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.workflow_run(request).await.map(Json)
}

async fn workflow_run_failed_log<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<WorkflowRunLogRequest>,
) -> Result<Json<super::WorkflowRunLogResponse>, GithubApiError>
where
    R: ProcessRunner,
{
    state
        .service
        .workflow_run_failed_log(request)
        .await
        .map(Json)
}

async fn checkout_pull_request<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestCheckoutRequest>,
) -> Result<Json<ace_git::GithubActionResult>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.checkout_pull_request(request).await.map(Json)
}

async fn comment_pull_request<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestCommentRequest>,
) -> Result<Json<ace_git::GithubActionResult>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.comment_pull_request(request).await.map(Json)
}

async fn review_pull_request<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestReviewRequest>,
) -> Result<Json<ace_git::GithubActionResult>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.review_pull_request(request).await.map(Json)
}

async fn set_pull_request_ready_state<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestReadyStateRequest>,
) -> Result<Json<ace_git::GithubActionResult>, GithubApiError>
where
    R: ProcessRunner,
{
    state
        .service
        .set_pull_request_ready_state(request)
        .await
        .map(Json)
}

async fn close_pull_request<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestCloseRequest>,
) -> Result<Json<ace_git::GithubActionResult>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.close_pull_request(request).await.map(Json)
}

async fn reopen_pull_request<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestReopenRequest>,
) -> Result<Json<ace_git::GithubActionResult>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.reopen_pull_request(request).await.map(Json)
}

async fn merge_pull_request<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<PullRequestMergeRequest>,
) -> Result<Json<ace_git::GithubActionResult>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.merge_pull_request(request).await.map(Json)
}

async fn rerun_workflow_run<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<WorkflowRunRerunRequest>,
) -> Result<Json<ace_git::GithubActionResult>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.rerun_workflow_run(request).await.map(Json)
}

async fn cancel_workflow_run<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<WorkflowRunCancelRequest>,
) -> Result<Json<ace_git::GithubActionResult>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.cancel_workflow_run(request).await.map(Json)
}
