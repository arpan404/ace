use super::{GithubApiError, GithubService, routes::router_with_state, service::GithubApiState};
use ace_git::{CommandOutput, CommandRequest, GitToolError, GithubCliClient, ProcessRunner};
use ace_protocol::github::{
    EnvironmentStatusRequest, IssueListFilter, IssueListRequest, IssueThreadRequest,
    PullRequestActivityRequest, PullRequestChecksRequest, PullRequestDashboardRequest,
    PullRequestDiffRequest, PullRequestFilesRequest, PullRequestListFilter, PullRequestMergeMethod,
    PullRequestMergeRequest, PullRequestRequest, PullRequestReviewDecision,
    PullRequestReviewRequest, PullRequestThreadRequest, WorkflowRunArtifactsRequest,
    WorkflowRunListFilter, WorkflowRunListRequest, WorkflowRunLogRequest, WorkflowRunRerunRequest,
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
async fn service_returns_issue_thread_details() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"number":77,"title":"Bug","state":"OPEN","url":"https://example.test/issues/77","body":"body","labels":[{"name":"bug"}],"assignees":[{"login":"octo"}],"author":{"login":"hubot"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","comments":[{"body":"comment","author":{"login":"maintainer"},"createdAt":"2026-06-21T00:02:00Z","updatedAt":null,"url":"https://example.test/issues/77#issuecomment-1"}]}"#,
    )]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let thread = service
        .issue_thread(IssueThreadRequest {
            repo_path: "/repo".to_string(),
            number: 77,
        })
        .await
        .expect("issue thread");

    assert_eq!(thread.number, 77);
    assert_eq!(thread.labels[0].name, "bug");
    assert_eq!(thread.assignees[0].login, "octo");
    assert_eq!(
        thread.comments[0].author.as_ref().unwrap().login,
        "maintainer"
    );
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "issue",
            "view",
            "77",
            "--json",
            "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt,comments"
        ]
    );
}

#[tokio::test]
async fn service_returns_pull_request_details() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","baseRefName":"main","body":"body","author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED"}"#,
    )]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let pull_request = service
        .pull_request(PullRequestRequest {
            repo_path: "/repo".to_string(),
            selector: "42".to_string(),
        })
        .await
        .expect("pull request");

    assert_eq!(pull_request.number, Some(42));
    assert_eq!(pull_request.author.as_ref().unwrap().login, "octo");
    assert_eq!(
        pull_request.review_decision.as_deref(),
        Some("REVIEW_REQUIRED")
    );
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "pr",
            "view",
            "42",
            "--json",
            "number,title,state,url,headRefName,baseRefName,body,author,createdAt,updatedAt,isDraft,reviewDecision,mergeStateStatus"
        ]
    );
}

#[tokio::test]
async fn service_returns_pull_request_thread() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","baseRefName":"main","body":"body","author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED","comments":[{"body":"please update docs","author":{"login":"maintainer"},"createdAt":"2026-06-21T00:02:00Z","updatedAt":null,"url":"https://example.test/pull/42#issuecomment-1"}],"reviews":[{"id":"PRR_1","author":{"login":"reviewer"},"authorAssociation":"MEMBER","body":"needs tests","state":"CHANGES_REQUESTED","submittedAt":"2026-06-21T00:03:00Z","commit":{"oid":"abc"},"url":"https://example.test/pull/42#pullrequestreview-1"}],"latestReviews":[{"id":"PRR_2","author":{"login":"reviewer"},"authorAssociation":"MEMBER","body":"approved","state":"APPROVED","submittedAt":"2026-06-21T00:04:00Z","commit":{"oid":"def"},"url":"https://example.test/pull/42#pullrequestreview-2"}]}"#,
    )]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let thread = service
        .pull_request_thread(PullRequestThreadRequest {
            repo_path: "/repo".to_string(),
            selector: "42".to_string(),
        })
        .await
        .expect("pull request thread");

    assert_eq!(thread.pull_request.number, Some(42));
    assert_eq!(
        thread.comments[0].body.as_deref(),
        Some("please update docs")
    );
    assert_eq!(thread.reviews[0].state, "CHANGES_REQUESTED");
    assert_eq!(thread.latest_reviews[0].state, "APPROVED");
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "pr",
            "view",
            "42",
            "--json",
            "number,title,state,url,headRefName,baseRefName,body,author,createdAt,updatedAt,isDraft,reviewDecision,mergeStateStatus,comments,reviews,latestReviews"
        ]
    );
}

#[tokio::test]
async fn service_returns_pull_request_files() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"files":[{"path":"src/lib.rs","additions":12,"deletions":3}]}"#,
    )]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let files = service
        .pull_request_files(PullRequestFilesRequest {
            repo_path: "/repo".to_string(),
            selector: "42".to_string(),
        })
        .await
        .expect("files");

    assert_eq!(files[0].path, "src/lib.rs");
    assert_eq!(files[0].additions, 12);
    assert_eq!(
        runner.requests()[0].args,
        vec!["pr", "view", "42", "--json", "files"]
    );
}

#[tokio::test]
async fn service_returns_pull_request_diff() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(br#"{"files":[{"path":"src/lib.rs","additions":1,"deletions":0}]}"#),
        ok("diff --git a/src/lib.rs b/src/lib.rs\n+pub fn run() {}\n"),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let diff = service
        .pull_request_diff(PullRequestDiffRequest {
            repo_path: "/repo".to_string(),
            selector: "42".to_string(),
        })
        .await
        .expect("diff");

    assert_eq!(diff.selector, "42");
    assert_eq!(diff.files[0].path, "src/lib.rs");
    assert!(diff.diff.contains("diff --git"));
    assert_eq!(
        runner.requests()[1].args,
        vec!["pr", "diff", "42", "--patch"]
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
async fn service_returns_workflow_run_log_with_job_filter() {
    let runner = Arc::new(FakeRunner::new(vec![ok("job log\n")]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let response = service
        .workflow_run_log(WorkflowRunLogRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
            attempt: Some(2),
            job_id: Some(200),
            failed_only: false,
        })
        .await
        .expect("log");

    assert_eq!(response.log, "job log");
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "run",
            "view",
            "100",
            "--attempt",
            "2",
            "--job",
            "200",
            "--log"
        ]
    );
}

#[tokio::test]
async fn service_failed_log_forces_failed_only_flag() {
    let runner = Arc::new(FakeRunner::new(vec![ok("failed log\n")]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let response = service
        .workflow_run_failed_log(WorkflowRunLogRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
            attempt: None,
            job_id: None,
            failed_only: false,
        })
        .await
        .expect("log");

    assert_eq!(response.log, "failed log");
    assert_eq!(
        runner.requests()[0].args,
        vec!["run", "view", "100", "--log-failed"]
    );
}

#[tokio::test]
async fn service_returns_workflow_run_artifacts() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"total_count":1,"artifacts":[{"id":11,"name":"linux-build","size_in_bytes":2048,"url":"https://api.github.test/artifacts/11","archive_download_url":"https://api.github.test/artifacts/11/zip","expired":false,"created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","expires_at":"2026-09-19T00:00:00Z","workflow_run":{"id":100,"repository_id":7,"head_repository_id":8,"head_branch":"feature/x","head_sha":"abc"}}]}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let artifacts = service
        .workflow_run_artifacts(WorkflowRunArtifactsRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
        })
        .await
        .expect("artifacts");

    assert_eq!(artifacts[0].id, 11);
    assert_eq!(artifacts[0].name, "linux-build");
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/actions/runs/100/artifacts"]
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
async fn route_returns_issue_thread_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"number":77,"title":"Bug","state":"OPEN","url":"https://example.test/issues/77","body":"body","labels":[{"name":"bug"}],"assignees":[{"login":"octo"}],"author":{"login":"hubot"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","comments":[{"body":"comment","author":{"login":"maintainer"},"createdAt":"2026-06-21T00:02:00Z","updatedAt":null,"url":"https://example.test/issues/77#issuecomment-1"}]}"#,
    )]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/issues/thread",
            serde_json::json!({
                "repo_path": "/repo",
                "number": 77
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["number"], 77);
    assert_eq!(body["comments"][0]["author"]["login"], "maintainer");
    assert_eq!(
        body["comments"][0]["url"],
        "https://example.test/issues/77#issuecomment-1"
    );
}

#[tokio::test]
async fn route_returns_pull_request_detail_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","baseRefName":"main","body":"body","author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED"}"#,
    )]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/pulls/view",
            serde_json::json!({
                "repo_path": "/repo",
                "selector": "42"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["number"], 42);
    assert_eq!(body["author"]["login"], "octo");
    assert_eq!(body["reviewDecision"], "REVIEW_REQUIRED");
}

#[tokio::test]
async fn route_returns_pull_request_thread_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","baseRefName":"main","body":"body","author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED","comments":[{"body":"please update docs","author":{"login":"maintainer"},"createdAt":"2026-06-21T00:02:00Z","updatedAt":null,"url":"https://example.test/pull/42#issuecomment-1"}],"reviews":[{"id":"PRR_1","author":{"login":"reviewer"},"authorAssociation":"MEMBER","body":"needs tests","state":"CHANGES_REQUESTED","submittedAt":"2026-06-21T00:03:00Z","commit":{"oid":"abc"},"url":"https://example.test/pull/42#pullrequestreview-1"}],"latestReviews":[{"id":"PRR_2","author":{"login":"reviewer"},"authorAssociation":"MEMBER","body":"approved","state":"APPROVED","submittedAt":"2026-06-21T00:04:00Z","commit":{"oid":"def"},"url":"https://example.test/pull/42#pullrequestreview-2"}]}"#,
    )]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/pulls/thread",
            serde_json::json!({
                "repo_path": "/repo",
                "selector": "42"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["number"], 42);
    assert_eq!(body["comments"][0]["author"]["login"], "maintainer");
    assert_eq!(body["reviews"][0]["state"], "CHANGES_REQUESTED");
    assert_eq!(body["latestReviews"][0]["state"], "APPROVED");
}

#[tokio::test]
async fn route_returns_pull_request_files_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"files":[{"path":"src/lib.rs","additions":12,"deletions":3}]}"#,
    )]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/pulls/files",
            serde_json::json!({
                "repo_path": "/repo",
                "selector": "42"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body[0]["path"], "src/lib.rs");
    assert_eq!(body[0]["additions"], 12);
}

#[tokio::test]
async fn route_returns_pull_request_diff_json() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(br#"{"files":[{"path":"src/lib.rs","additions":1,"deletions":0}]}"#),
        ok("diff --git a/src/lib.rs b/src/lib.rs\n+pub fn run() {}\n"),
    ]));
    let app = test_router(runner);

    let response = app
        .oneshot(json_request(
            "/pulls/diff",
            serde_json::json!({
                "repo_path": "/repo",
                "selector": "42"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["selector"], "42");
    assert_eq!(body["files"][0]["path"], "src/lib.rs");
    assert!(
        body["diff"]
            .as_str()
            .expect("diff string")
            .contains("diff --git")
    );
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
async fn route_returns_workflow_run_log_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("job log\n")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/workflow-runs/log",
            serde_json::json!({
                "repo_path": "/repo",
                "run_id": 100,
                "attempt": 2,
                "job_id": 200,
                "failed_only": false
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["log"], "job log");
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "run",
            "view",
            "100",
            "--attempt",
            "2",
            "--job",
            "200",
            "--log"
        ]
    );
}

#[tokio::test]
async fn route_returns_workflow_run_failed_log_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("failed log\n")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/workflow-runs/failed-log",
            serde_json::json!({
                "repo_path": "/repo",
                "run_id": 100
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["log"], "failed log");
    assert_eq!(
        runner.requests()[0].args,
        vec!["run", "view", "100", "--log-failed"]
    );
}

#[tokio::test]
async fn route_returns_workflow_run_artifacts_json() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"total_count":1,"artifacts":[{"id":11,"name":"linux-build","size_in_bytes":2048,"url":"https://api.github.test/artifacts/11","archive_download_url":"https://api.github.test/artifacts/11/zip","expired":false,"created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","expires_at":"2026-09-19T00:00:00Z","workflow_run":{"id":100,"repository_id":7,"head_repository_id":8,"head_branch":"feature/x","head_sha":"abc"}}]}"#,
        ),
    ]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/workflow-runs/artifacts",
            serde_json::json!({
                "repo_path": "/repo",
                "run_id": 100
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body[0]["id"], 11);
    assert_eq!(body[0]["name"], "linux-build");
    assert_eq!(body[0]["workflow_run"]["head_branch"], "feature/x");
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/actions/runs/100/artifacts"]
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
