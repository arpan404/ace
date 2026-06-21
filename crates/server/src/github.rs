use ace_git::{
    GithubCliClient, GithubIssueListFilter, GithubPullRequestListFilter, GithubSearchFilter,
    ProcessRunner, PullRequestCheckout, PullRequestClose, PullRequestComment, PullRequestMerge,
    PullRequestReadyState, PullRequestReopen, PullRequestReview, TokioProcessRunner,
    WorkflowRunCancel, WorkflowRunListFilter, WorkflowRunRerun,
};
use ace_protocol::github::{
    IssueListFilter, IssueListRequest, PullRequestActivityRequest, PullRequestCheckoutRequest,
    PullRequestChecksRequest, PullRequestCloseRequest, PullRequestCommentRequest,
    PullRequestListFilter, PullRequestListRequest, PullRequestMergeRequest,
    PullRequestReadyStateRequest, PullRequestReopenRequest, PullRequestReviewRequest, SearchFilter,
    SearchIssuesRequest, SearchPullRequestsRequest, WorkflowRunCancelRequest,
    WorkflowRunListRequest, WorkflowRunLogRequest, WorkflowRunRequest, WorkflowRunRerunRequest,
};
use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::post};
use serde::Serialize;
use std::{path::PathBuf, sync::Arc};
use thiserror::Error;

pub struct GithubApiState<R: ProcessRunner = TokioProcessRunner> {
    service: Arc<GithubService<R>>,
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
        request: WorkflowRunLogRequest,
    ) -> Result<WorkflowRunLogResponse, GithubApiError> {
        let log = self
            .github
            .workflow_run_failed_log(&repo_path(&request.repo_path)?, request.run_id)
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

#[derive(Debug, Error)]
pub enum GithubApiError {
    #[error("repo_path must not be empty")]
    EmptyRepoPath,
    #[error("{0}")]
    Tooling(#[from] ace_git::GitToolError),
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    message: String,
}

impl IntoResponse for GithubApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self {
            Self::EmptyRepoPath => StatusCode::BAD_REQUEST,
            Self::Tooling(ace_git::GitToolError::GithubUnauthenticated) => StatusCode::UNAUTHORIZED,
            Self::Tooling(ace_git::GitToolError::NotGithubRepository) => StatusCode::BAD_REQUEST,
            Self::Tooling(ace_git::GitToolError::MissingBinary(_)) => StatusCode::FAILED_DEPENDENCY,
            Self::Tooling(_) => StatusCode::BAD_GATEWAY,
        };
        (
            status,
            Json(ErrorResponse {
                message: self.to_string(),
            }),
        )
            .into_response()
    }
}

pub fn router() -> Router {
    router_with_state(GithubApiState::production())
}

pub fn router_with_state<R>(state: GithubApiState<R>) -> Router
where
    R: ProcessRunner + 'static,
{
    Router::new()
        .route("/issues/list", post(list_issues::<R>))
        .route("/pulls/list", post(list_pull_requests::<R>))
        .route("/issues/search", post(search_issues::<R>))
        .route("/pulls/search", post(search_pull_requests::<R>))
        .route("/pulls/checks", post(pull_request_checks::<R>))
        .route("/pulls/activity", post(pull_request_activity::<R>))
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

async fn list_issues<R>(
    State(state): State<GithubApiState<R>>,
    Json(request): Json<IssueListRequest>,
) -> Result<Json<Vec<ace_git::GithubIssueSummary>>, GithubApiError>
where
    R: ProcessRunner,
{
    state.service.list_issues(request).await.map(Json)
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
) -> Result<Json<WorkflowRunLogResponse>, GithubApiError>
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

fn repo_path(raw: &str) -> Result<PathBuf, GithubApiError> {
    if raw.trim().is_empty() {
        Err(GithubApiError::EmptyRepoPath)
    } else {
        Ok(PathBuf::from(raw))
    }
}

fn issue_list_filter(filter: IssueListFilter) -> GithubIssueListFilter {
    GithubIssueListFilter {
        limit: filter.limit,
        state: filter.state,
        author: filter.author,
        assignee: filter.assignee,
        mention: filter.mention,
        milestone: filter.milestone,
        search: filter.search,
        labels: filter.labels,
    }
}

fn pull_request_list_filter(filter: PullRequestListFilter) -> GithubPullRequestListFilter {
    GithubPullRequestListFilter {
        limit: filter.limit,
        state: filter.state,
        author: filter.author,
        assignee: filter.assignee,
        base: filter.base,
        head: filter.head,
        search: filter.search,
        labels: filter.labels,
        draft_only: filter.draft_only,
    }
}

fn search_filter(filter: SearchFilter) -> GithubSearchFilter {
    GithubSearchFilter {
        limit: filter.limit,
        state: filter.state,
        author: filter.author,
        assignee: filter.assignee,
        owner: filter.owner,
        repo: filter.repo,
        labels: filter.labels,
        sort: filter.sort,
        order: filter.order,
        include_prs_in_issue_search: filter.include_prs_in_issue_search,
    }
}

fn workflow_run_list_filter(
    filter: ace_protocol::github::WorkflowRunListFilter,
) -> WorkflowRunListFilter {
    WorkflowRunListFilter {
        limit: filter.limit,
        branch: filter.branch,
        commit: filter.commit,
        status: filter.status,
        workflow: filter.workflow,
        event: filter.event,
        user: filter.user,
        include_disabled: filter.include_disabled,
    }
}

fn pull_request_review_decision(
    decision: ace_protocol::github::PullRequestReviewDecision,
) -> ace_git::PullRequestReviewDecision {
    match decision {
        ace_protocol::github::PullRequestReviewDecision::Approve => {
            ace_git::PullRequestReviewDecision::Approve
        }
        ace_protocol::github::PullRequestReviewDecision::Comment => {
            ace_git::PullRequestReviewDecision::Comment
        }
        ace_protocol::github::PullRequestReviewDecision::RequestChanges => {
            ace_git::PullRequestReviewDecision::RequestChanges
        }
    }
}

fn pull_request_merge_method(
    method: ace_protocol::github::PullRequestMergeMethod,
) -> ace_git::PullRequestMergeMethod {
    match method {
        ace_protocol::github::PullRequestMergeMethod::Merge => {
            ace_git::PullRequestMergeMethod::Merge
        }
        ace_protocol::github::PullRequestMergeMethod::Squash => {
            ace_git::PullRequestMergeMethod::Squash
        }
        ace_protocol::github::PullRequestMergeMethod::Rebase => {
            ace_git::PullRequestMergeMethod::Rebase
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_git::{CommandOutput, CommandRequest, GitToolError};
    use ace_protocol::github::{
        IssueListFilter, IssueListRequest, PullRequestActivityRequest, PullRequestChecksRequest,
        PullRequestMergeMethod, PullRequestMergeRequest, PullRequestReviewDecision,
        PullRequestReviewRequest, WorkflowRunListFilter, WorkflowRunListRequest,
        WorkflowRunRerunRequest,
    };
    use async_trait::async_trait;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    #[derive(Debug)]
    struct FakeRunner {
        outputs: Mutex<VecDeque<CommandOutput>>,
        requests: Mutex<Vec<CommandRequest>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<CommandOutput>) -> Self {
            Self {
                outputs: Mutex::new(VecDeque::from(outputs)),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<CommandRequest> {
            self.requests.lock().expect("lock requests").clone()
        }
    }

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(&self, request: CommandRequest) -> ace_git::Result<CommandOutput> {
            self.requests.lock().expect("lock requests").push(request);
            self.outputs
                .lock()
                .expect("lock outputs")
                .pop_front()
                .ok_or_else(|| GitToolError::Parse {
                    context: "fake runner",
                    message: "no fake output queued".to_string(),
                })
        }
    }

    fn ok(stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status: 0,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    fn pending(stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status: 8,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    #[tokio::test]
    async fn service_lists_issues_through_github_cli() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"[{"number":1,"title":"Bug","state":"OPEN","url":"https://example.test/issues/1","author":{"login":"octo"},"labels":[],"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","comments":0}]"#,
        )]));
        let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

        let issues = service
            .list_issues(IssueListRequest {
                repo_path: "/repo".to_string(),
                filter: IssueListFilter {
                    limit: 10,
                    labels: vec!["bug".to_string()],
                    ..IssueListFilter::default()
                },
            })
            .await
            .expect("issues");

        assert_eq!(issues[0].number, 1);
        let request = &runner.requests()[0];
        assert_eq!(request.cwd.as_deref(), Some(std::path::Path::new("/repo")));
        assert!(
            request
                .args
                .windows(2)
                .any(|pair| pair == ["--label", "bug"])
        );
    }

    #[tokio::test]
    async fn service_returns_pending_pull_request_checks() {
        let runner = Arc::new(FakeRunner::new(vec![pending(
            br#"[{"bucket":"pending","completedAt":null,"description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"PENDING","workflow":"CI"}]"#,
        )]));
        let service = GithubService::new(GithubCliClient::with_runner(runner));

        let checks = service
            .pull_request_checks(PullRequestChecksRequest {
                repo_path: "/repo".to_string(),
                selector: Some("42".to_string()),
                required_only: false,
            })
            .await
            .expect("checks");

        assert_eq!(checks.summary.pending, 1);
        assert_eq!(checks.checks[0].name, "CI");
    }

    #[tokio::test]
    async fn service_returns_pull_request_activity() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","baseRefName":"main","body":"body"}"#,
            ),
            ok(
                br#"[{"bucket":"pass","completedAt":"2026-06-21T00:00:00Z","description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"SUCCESS","workflow":"CI"}]"#,
            ),
            ok(
                br#"[{"attempt":1,"conclusion":"success","createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"completed","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#,
            ),
        ]));
        let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

        let activity = service
            .pull_request_activity(PullRequestActivityRequest {
                repo_path: "/repo".to_string(),
                selector: "42".to_string(),
                required_checks_only: false,
                workflow_run_limit: 5,
            })
            .await
            .expect("activity");

        assert_eq!(activity.pull_request.number, Some(42));
        assert_eq!(activity.checks.summary.passed, 1);
        assert_eq!(activity.workflow_runs[0].database_id, 7);
        assert!(
            runner.requests()[2]
                .args
                .windows(2)
                .any(|pair| pair == ["--branch", "feature/x"])
        );
    }

    #[tokio::test]
    async fn service_lists_workflow_runs_with_filters() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"[{"attempt":1,"conclusion":null,"createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"in_progress","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#,
        )]));
        let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

        let runs = service
            .list_workflow_runs(WorkflowRunListRequest {
                repo_path: "/repo".to_string(),
                filter: WorkflowRunListFilter {
                    branch: Some("feature/x".to_string()),
                    status: Some("in_progress".to_string()),
                    ..WorkflowRunListFilter::default()
                },
            })
            .await
            .expect("runs");

        assert_eq!(runs[0].database_id, 7);
        let args = &runner.requests()[0].args;
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--branch", "feature/x"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--status", "in_progress"])
        );
    }

    #[tokio::test]
    async fn service_rejects_empty_repo_path_before_running_process() {
        let runner = Arc::new(FakeRunner::new(Vec::new()));
        let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

        let error = service
            .list_issues(IssueListRequest {
                repo_path: "  ".to_string(),
                filter: IssueListFilter::default(),
            })
            .await
            .expect_err("empty repo path");

        assert!(matches!(error, GithubApiError::EmptyRepoPath));
        assert!(runner.requests().is_empty());
    }

    #[tokio::test]
    async fn service_reviews_pull_request_through_github_cli() {
        let runner = Arc::new(FakeRunner::new(vec![ok("reviewed\n")]));
        let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

        let result = service
            .review_pull_request(PullRequestReviewRequest {
                repo_path: "/repo".to_string(),
                selector: "42".to_string(),
                decision: PullRequestReviewDecision::Approve,
                body: Some("ship it".to_string()),
            })
            .await
            .expect("review");

        assert_eq!(result.action, "review_pull_request");
        assert_eq!(
            runner.requests()[0].args,
            vec!["pr", "review", "42", "--approve", "--body", "ship it"]
        );
    }

    #[tokio::test]
    async fn service_merges_pull_request_through_github_cli() {
        let runner = Arc::new(FakeRunner::new(vec![ok("merged\n")]));
        let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

        service
            .merge_pull_request(PullRequestMergeRequest {
                repo_path: "/repo".to_string(),
                selector: "42".to_string(),
                method: PullRequestMergeMethod::Rebase,
                auto: false,
                admin: true,
                delete_branch: true,
                disable_auto: false,
                subject: None,
                body: None,
                author_email: None,
                match_head_commit: Some("abc123".to_string()),
            })
            .await
            .expect("merge");

        assert_eq!(
            runner.requests()[0].args,
            vec![
                "pr",
                "merge",
                "42",
                "--rebase",
                "--admin",
                "--delete-branch",
                "--match-head-commit",
                "abc123"
            ]
        );
    }

    #[tokio::test]
    async fn service_reruns_workflow_run_through_github_cli() {
        let runner = Arc::new(FakeRunner::new(vec![ok("rerun\n")]));
        let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

        service
            .rerun_workflow_run(WorkflowRunRerunRequest {
                repo_path: "/repo".to_string(),
                run_id: 100,
                failed_only: true,
                debug: false,
                job_id: Some(200),
            })
            .await
            .expect("rerun");

        assert_eq!(
            runner.requests()[0].args,
            vec!["run", "rerun", "100", "--failed", "--job", "200"]
        );
    }
}
