use super::{GitApiError, GitService, routes::router_with_state, service::GitApiState};
use ace_git::{CommandOutput, CommandRequest, GitClient, GitToolError, ProcessRunner};
use ace_protocol::git::{GitDiffRequest, GitStatusRequest};
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

#[tokio::test]
async fn service_returns_status_through_git() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        "## feature/x...origin/feature/x [ahead 2, behind 1]\n M src/lib.rs\nA  README.md\n",
    )]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let status = service
        .status(GitStatusRequest {
            repo_path: "/repo".to_string(),
        })
        .await
        .expect("status");

    assert_eq!(status.current_branch.as_deref(), Some("feature/x"));
    assert!(status.dirty);
    assert_eq!(status.ahead, 2);
    assert_eq!(status.behind, 1);
    assert_eq!(
        runner.requests()[0].args,
        vec!["status", "--porcelain=v1", "-b"]
    );
}

#[tokio::test]
async fn service_returns_diff_text() {
    let runner = Arc::new(FakeRunner::new(vec![ok("diff --git a/a b/a\n+hello\n")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let diff = service
        .diff(GitDiffRequest {
            repo_path: "/repo".to_string(),
        })
        .await
        .expect("diff");

    assert!(diff.diff.contains("diff --git"));
    assert_eq!(runner.requests()[0].args, vec!["diff"]);
}

#[tokio::test]
async fn service_rejects_empty_repo_path_before_running_process() {
    let runner = Arc::new(FakeRunner::new(Vec::new()));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let error = service
        .status(GitStatusRequest {
            repo_path: "  ".to_string(),
        })
        .await
        .expect_err("empty repo path");

    assert!(matches!(error, GitApiError::EmptyRepoPath));
    assert!(runner.requests().is_empty());
}

#[tokio::test]
async fn route_returns_status_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        "## feature/x...origin/feature/x [ahead 2]\n M src/lib.rs\n",
    )]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/status",
            serde_json::json!({ "repo_path": "/repo" }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["current_branch"], "feature/x");
    assert_eq!(body["ahead"], 2);
    assert_eq!(body["entries"][0]["path"], "src/lib.rs");
}

#[tokio::test]
async fn route_returns_branches_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        "main||origin/main\nfeature/x|*|origin/feature/x\n",
    )]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/branches",
            serde_json::json!({ "repo_path": "/repo" }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body[1]["name"], "feature/x");
    assert_eq!(body[1]["current"], true);
    assert_eq!(body[1]["upstream"], "origin/feature/x");
}

#[tokio::test]
async fn route_returns_worktrees_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-wt\nHEAD def\nbranch refs/heads/feature/x\n",
    )]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/worktrees",
            serde_json::json!({ "repo_path": "/repo" }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body[1]["path"], "/repo-wt");
    assert_eq!(body[1]["branch"], "feature/x");
}

#[tokio::test]
async fn route_returns_diff_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("diff --git a/a b/a\n+hello\n")]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/diff",
            serde_json::json!({ "repo_path": "/repo" }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["diff"].as_str().expect("diff").contains("diff --git"));
}

#[tokio::test]
async fn route_returns_bad_request_for_empty_repo_path() {
    let runner = Arc::new(FakeRunner::new(Vec::new()));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/status",
            serde_json::json!({ "repo_path": "  " }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["message"], "repo_path must not be empty");
    assert!(runner.requests().is_empty());
}

fn test_router(runner: Arc<FakeRunner>) -> axum::Router {
    router_with_state(GitApiState::new(GitService::new(GitClient::with_runner(
        runner,
    ))))
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
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body bytes");
    serde_json::from_slice(&bytes).expect("json")
}
