use super::{GithubApiError, GithubService, routes::router_with_state, service::GithubApiState};
use ace_git::{CommandOutput, CommandRequest, GitToolError, GithubCliClient, ProcessRunner};
use ace_protocol::github::{
    EnvironmentStatusRequest, IssueListFilter, IssueListRequest, PullRequestActivityRequest,
    PullRequestChecksRequest, PullRequestDashboardRequest, PullRequestListFilter,
    PullRequestMergeMethod, PullRequestMergeRequest, PullRequestReviewDecision,
    PullRequestReviewRequest, WorkflowRunListFilter, WorkflowRunListRequest,
    WorkflowRunRerunRequest,
};
use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

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

fn exit_one(stderr: impl AsRef<[u8]>) -> CommandOutput {
    CommandOutput {
        status: 1,
        stdout: Vec::new(),
        stderr: stderr.as_ref().to_vec(),
    }
}

#[tokio::test]
async fn service_returns_environment_status() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok("gh version 2.83.0 (2026-06-01)\n"),
        exit_one("You are not logged into any GitHub hosts\n"),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let status = service
        .environment_status(EnvironmentStatusRequest {
            repo_path: "/repo".to_string(),
        })
        .await
        .expect("environment status");

    assert!(status.gh_available);
    assert!(!status.authenticated);
    assert_eq!(runner.requests()[0].args, vec!["--version"]);
    assert_eq!(runner.requests()[1].args, vec!["auth", "status"]);
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
async fn service_returns_pull_request_dashboard() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"[{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","author":{"login":"octo"},"labels":[],"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","baseRefName":"main","headRefName":"feature/x","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED","statusCheckRollup":[]}]"#,
        ),
        ok(
            br#"[{"bucket":"pending","completedAt":null,"description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"PENDING","workflow":"CI"}]"#,
        ),
        ok(
            br#"[{"attempt":1,"conclusion":null,"createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"in_progress","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let dashboard = service
        .pull_request_dashboard(PullRequestDashboardRequest {
            repo_path: "/repo".to_string(),
            filter: PullRequestListFilter {
                limit: 10,
                ..PullRequestListFilter::default()
            },
            required_checks_only: true,
            workflow_run_limit_per_pr: 3,
        })
        .await
        .expect("dashboard");

    assert_eq!(dashboard.items[0].pull_request.number, 42);
    assert_eq!(dashboard.items[0].checks.summary.pending, 1);
    assert_eq!(dashboard.items[0].workflow_runs[0].database_id, 7);
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

#[tokio::test]
async fn route_returns_pull_request_activity_json() {
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
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/pulls/activity",
            serde_json::json!({
                "repo_path": "/repo",
                "selector": "42",
                "required_checks_only": false,
                "workflow_run_limit": 5
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["pull_request"]["number"], 42);
    assert_eq!(body["checks"]["summary"]["passed"], 1);
    assert_eq!(body["workflow_runs"][0]["databaseId"], 7);
}

#[tokio::test]
async fn route_returns_pull_request_dashboard_json() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"[{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","author":{"login":"octo"},"labels":[],"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","baseRefName":"main","headRefName":"feature/x","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED","statusCheckRollup":[]}]"#,
        ),
        ok(
            br#"[{"bucket":"pending","completedAt":null,"description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"PENDING","workflow":"CI"}]"#,
        ),
        ok(
            br#"[{"attempt":1,"conclusion":null,"createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"in_progress","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#,
        ),
    ]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/pulls/dashboard",
            serde_json::json!({
                "repo_path": "/repo",
                "filter": {
                    "limit": 10,
                    "state": "open",
                    "author": null,
                    "assignee": null,
                    "base": null,
                    "head": null,
                    "search": null,
                    "labels": [],
                    "draft_only": false
                },
                "required_checks_only": true,
                "workflow_run_limit_per_pr": 3
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["items"][0]["pull_request"]["number"], 42);
    assert_eq!(body["items"][0]["checks"]["summary"]["pending"], 1);
    assert_eq!(body["items"][0]["workflow_runs"][0]["databaseId"], 7);
}

#[tokio::test]
async fn route_returns_environment_status_json() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok("gh version 2.83.0 (2026-06-01)\n"),
        exit_one("You are not logged into any GitHub hosts\n"),
    ]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/environment/status",
            serde_json::json!({ "repo_path": "/repo" }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["gh_available"], true);
    assert_eq!(body["authenticated"], false);
    assert_eq!(body["repository"], serde_json::Value::Null);
}

#[tokio::test]
async fn route_runs_workflow_action_and_returns_action_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("rerun queued\n")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/workflow-runs/rerun",
            serde_json::json!({
                "repo_path": "/repo",
                "run_id": 100,
                "failed_only": true,
                "debug": true,
                "job_id": 200
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "rerun_workflow_run");
    assert_eq!(body["stdout"], "rerun queued");
    assert_eq!(
        runner.requests()[0].args,
        vec!["run", "rerun", "100", "--failed", "--debug", "--job", "200"]
    );
}

#[tokio::test]
async fn route_returns_bad_request_for_empty_repo_path() {
    let runner = Arc::new(FakeRunner::new(Vec::new()));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/issues/list",
            serde_json::json!({
                "repo_path": "  ",
                "filter": {
                    "limit": 30,
                    "state": "open",
                    "author": null,
                    "assignee": null,
                    "mention": null,
                    "milestone": null,
                    "search": null,
                    "labels": []
                }
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["message"], "repo_path must not be empty");
    assert!(runner.requests().is_empty());
}

fn test_router(runner: Arc<FakeRunner>) -> axum::Router {
    router_with_state(GithubApiState::new(GithubService::new(
        GithubCliClient::with_runner(runner),
    )))
}

fn json_request(path: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("request")
}

async fn response_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("response body");
    serde_json::from_slice(&bytes).expect("json body")
}
