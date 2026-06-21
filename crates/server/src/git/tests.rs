use super::{GitApiError, GitService, routes::router_with_state, service::GitApiState};
use ace_git::{CommandOutput, CommandRequest, GitClient, GitToolError, ProcessRunner};
use ace_protocol::git::{
    GitCheckoutBranchRequest, GitCommitRequest, GitCreateBranchRequest, GitDeleteBranchRequest,
    GitDiffRequest, GitFetchRequest, GitPullRequest, GitPushRequest, GitRenameBranchRequest,
    GitStageRequest, GitStatusRequest, GitUnstageRequest,
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
async fn service_creates_branch_through_git() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .create_branch(GitCreateBranchRequest {
            repo_path: "/repo".to_string(),
            branch: "feature/issue-123".to_string(),
            start_point: Some("main".to_string()),
        })
        .await
        .expect("create branch");

    assert_eq!(result.action, "create_branch");
    assert_eq!(result.branch.as_deref(), Some("feature/issue-123"));
    assert_eq!(
        runner.requests()[0].args,
        vec!["branch", "feature/issue-123", "main"]
    );
}

#[tokio::test]
async fn service_checks_out_branch_through_git() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .checkout_branch(GitCheckoutBranchRequest {
            repo_path: "/repo".to_string(),
            branch: "feature/issue-123".to_string(),
        })
        .await
        .expect("checkout branch");

    assert_eq!(result.action, "checkout_branch");
    assert_eq!(result.branch.as_deref(), Some("feature/issue-123"));
    assert_eq!(
        runner.requests()[0].args,
        vec!["checkout", "feature/issue-123"]
    );
}

#[tokio::test]
async fn service_renames_branch_through_git() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .rename_branch(GitRenameBranchRequest {
            repo_path: "/repo".to_string(),
            old: Some("feature/old".to_string()),
            new: "feature/new".to_string(),
        })
        .await
        .expect("rename branch");

    assert_eq!(result.action, "rename_branch");
    assert_eq!(result.branch.as_deref(), Some("feature/new"));
    assert_eq!(
        runner.requests()[0].args,
        vec!["branch", "-m", "feature/old", "feature/new"]
    );
}

#[tokio::test]
async fn service_deletes_branch_through_git() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .delete_branch(GitDeleteBranchRequest {
            repo_path: "/repo".to_string(),
            branch: "feature/old".to_string(),
            force: true,
        })
        .await
        .expect("delete branch");

    assert_eq!(result.action, "delete_branch");
    assert_eq!(result.branch.as_deref(), Some("feature/old"));
    assert_eq!(
        runner.requests()[0].args,
        vec!["branch", "-D", "feature/old"]
    );
}

#[tokio::test]
async fn service_fetches_with_prune() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .fetch(GitFetchRequest {
            repo_path: "/repo".to_string(),
            prune: true,
        })
        .await
        .expect("fetch");

    assert_eq!(result.action, "fetch");
    assert_eq!(result.branch, None);
    assert_eq!(runner.requests()[0].args, vec!["fetch", "--prune"]);
}

#[tokio::test]
async fn service_pulls_ff_only() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .pull(GitPullRequest {
            repo_path: "/repo".to_string(),
        })
        .await
        .expect("pull");

    assert_eq!(result.action, "pull");
    assert_eq!(result.branch, None);
    assert_eq!(runner.requests()[0].args, vec!["pull", "--ff-only"]);
}

#[tokio::test]
async fn service_pushes_current_branch_with_upstream() {
    let runner = Arc::new(FakeRunner::new(vec![ok("feature/x\n"), ok("")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .push(GitPushRequest {
            repo_path: "/repo".to_string(),
            set_upstream: true,
        })
        .await
        .expect("push");

    assert_eq!(result.action, "push");
    assert_eq!(result.branch, None);
    let requests = runner.requests();
    assert_eq!(requests[0].args, vec!["branch", "--show-current"]);
    assert_eq!(requests[1].args, vec!["push", "-u", "origin", "feature/x"]);
}

#[tokio::test]
async fn service_stages_paths_through_git() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .stage(GitStageRequest {
            repo_path: "/repo".to_string(),
            paths: vec!["src/lib.rs".to_string(), "README.md".to_string()],
            all: false,
        })
        .await
        .expect("stage");

    assert_eq!(result.action, "stage");
    assert_eq!(result.branch, None);
    assert_eq!(
        runner.requests()[0].args,
        vec!["add", "--", "src/lib.rs", "README.md"]
    );
}

#[tokio::test]
async fn service_unstages_all_through_git() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .unstage(GitUnstageRequest {
            repo_path: "/repo".to_string(),
            paths: Vec::new(),
            all: true,
        })
        .await
        .expect("unstage");

    assert_eq!(result.action, "unstage");
    assert_eq!(result.branch, None);
    assert_eq!(
        runner.requests()[0].args,
        vec!["restore", "--staged", "--", "."]
    );
}

#[tokio::test]
async fn service_commits_with_message() {
    let runner = Arc::new(FakeRunner::new(vec![ok("[feature/x abc] message\n")]));
    let service = GitService::new(GitClient::with_runner(runner.clone()));

    let result = service
        .commit(GitCommitRequest {
            repo_path: "/repo".to_string(),
            message: "Implement feature".to_string(),
        })
        .await
        .expect("commit");

    assert_eq!(result.action, "commit");
    assert_eq!(result.branch, None);
    assert_eq!(
        runner.requests()[0].args,
        vec!["commit", "-m", "Implement feature"]
    );
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
async fn route_creates_branch_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/branches/create",
            serde_json::json!({
                "repo_path": "/repo",
                "branch": "feature/issue-123",
                "start_point": "main"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "create_branch");
    assert_eq!(body["branch"], "feature/issue-123");
    assert_eq!(
        runner.requests()[0].args,
        vec!["branch", "feature/issue-123", "main"]
    );
}

#[tokio::test]
async fn route_checks_out_branch_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/branches/checkout",
            serde_json::json!({
                "repo_path": "/repo",
                "branch": "feature/issue-123"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "checkout_branch");
    assert_eq!(body["branch"], "feature/issue-123");
    assert_eq!(
        runner.requests()[0].args,
        vec!["checkout", "feature/issue-123"]
    );
}

#[tokio::test]
async fn route_renames_branch_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/branches/rename",
            serde_json::json!({
                "repo_path": "/repo",
                "old": "feature/old",
                "new": "feature/new"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "rename_branch");
    assert_eq!(body["branch"], "feature/new");
    assert_eq!(
        runner.requests()[0].args,
        vec!["branch", "-m", "feature/old", "feature/new"]
    );
}

#[tokio::test]
async fn route_deletes_branch_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/branches/delete",
            serde_json::json!({
                "repo_path": "/repo",
                "branch": "feature/old",
                "force": false
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "delete_branch");
    assert_eq!(body["branch"], "feature/old");
    assert_eq!(
        runner.requests()[0].args,
        vec!["branch", "-d", "feature/old"]
    );
}

#[tokio::test]
async fn route_fetches_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/fetch",
            serde_json::json!({
                "repo_path": "/repo",
                "prune": true
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "fetch");
    assert!(body["branch"].is_null());
    assert_eq!(runner.requests()[0].args, vec!["fetch", "--prune"]);
}

#[tokio::test]
async fn route_pulls_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/pull",
            serde_json::json!({ "repo_path": "/repo" }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "pull");
    assert!(body["branch"].is_null());
    assert_eq!(runner.requests()[0].args, vec!["pull", "--ff-only"]);
}

#[tokio::test]
async fn route_pushes_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("feature/x\n"), ok("")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/push",
            serde_json::json!({
                "repo_path": "/repo",
                "set_upstream": true
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "push");
    assert!(body["branch"].is_null());
    let requests = runner.requests();
    assert_eq!(requests[0].args, vec!["branch", "--show-current"]);
    assert_eq!(requests[1].args, vec!["push", "-u", "origin", "feature/x"]);
}

#[tokio::test]
async fn route_stages_all_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/stage",
            serde_json::json!({
                "repo_path": "/repo",
                "paths": [],
                "all": true
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "stage");
    assert!(body["branch"].is_null());
    assert_eq!(runner.requests()[0].args, vec!["add", "-A"]);
}

#[tokio::test]
async fn route_unstages_paths_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/unstage",
            serde_json::json!({
                "repo_path": "/repo",
                "paths": ["src/lib.rs"],
                "all": false
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "unstage");
    assert!(body["branch"].is_null());
    assert_eq!(
        runner.requests()[0].args,
        vec!["restore", "--staged", "--", "src/lib.rs"]
    );
}

#[tokio::test]
async fn route_commits_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("[feature/x abc] message\n")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/commit",
            serde_json::json!({
                "repo_path": "/repo",
                "message": "Implement feature"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "commit");
    assert!(body["branch"].is_null());
    assert_eq!(
        runner.requests()[0].args,
        vec!["commit", "-m", "Implement feature"]
    );
}

#[tokio::test]
async fn route_rejects_empty_stage_pathspec_before_running_process() {
    let runner = Arc::new(FakeRunner::new(Vec::new()));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/stage",
            serde_json::json!({
                "repo_path": "/repo",
                "paths": [],
                "all": false
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["message"], "pathspec must not be empty");
    assert!(runner.requests().is_empty());
}

#[tokio::test]
async fn route_rejects_empty_commit_message_before_running_process() {
    let runner = Arc::new(FakeRunner::new(Vec::new()));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/commit",
            serde_json::json!({
                "repo_path": "/repo",
                "message": "  "
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["message"], "commit message must not be empty");
    assert!(runner.requests().is_empty());
}

#[tokio::test]
async fn route_rejects_unsafe_branch_name_before_running_process() {
    let runner = Arc::new(FakeRunner::new(Vec::new()));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/branches/create",
            serde_json::json!({
                "repo_path": "/repo",
                "branch": "bad branch",
                "start_point": null
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["message"], "unsafe branch name `bad branch`");
    assert!(runner.requests().is_empty());
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
