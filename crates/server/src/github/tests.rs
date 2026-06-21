use super::{
    GithubApiError, GithubImageFetcher, GithubService, ImageProxyError, ProxiedGithubImage,
    routes::router_with_state, service::GithubApiState,
};
use ace_git::{CommandOutput, CommandRequest, GitToolError, GithubCliClient, ProcessRunner};
use ace_protocol::github::{
    CheckRunAnnotationsRequest, CheckRunListFilter, CheckRunRequest, CheckRunRerequestRequest,
    CheckRunsRequest, CheckSuiteRequest, CheckSuiteRerequestRequest, CheckSuiteRunsRequest,
    CheckSuitesRequest, CommitCheckRollupRequest, CommitStatusesRequest, EnvironmentStatusRequest,
    GithubImageProxyRequest, IssueListFilter, IssueListRequest, IssueThreadRequest,
    PullRequestActivityRequest, PullRequestChecksRequest, PullRequestCommitsRequest,
    PullRequestCreateRequest, PullRequestDashboardRequest, PullRequestDiffRequest,
    PullRequestFilesRequest, PullRequestListFilter, PullRequestMergeMethod,
    PullRequestMergeRequest, PullRequestMergeStatusRequest, PullRequestRequest,
    PullRequestReviewCommentsRequest, PullRequestReviewDecision, PullRequestReviewRequest,
    PullRequestReviewThreadsRequest, PullRequestThreadRequest, PullRequestTimelineRequest,
    WorkflowDisableRequest, WorkflowDispatchInput, WorkflowDispatchRequest, WorkflowEnableRequest,
    WorkflowJobLogRequest, WorkflowJobRequest, WorkflowListFilter, WorkflowListRequest,
    WorkflowRequest, WorkflowRunApprovalsRequest, WorkflowRunApproveRequest,
    WorkflowRunArtifactDownloadRequest, WorkflowRunArtifactsRequest, WorkflowRunForceCancelRequest,
    WorkflowRunJobsRequest, WorkflowRunListFilter, WorkflowRunListRequest, WorkflowRunLogRequest,
    WorkflowRunPendingDeploymentReviewRequest, WorkflowRunPendingDeploymentReviewState,
    WorkflowRunPendingDeploymentsRequest, WorkflowRunRerunRequest,
};
use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use bytes::Bytes;
use reqwest::Url;
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

#[derive(Debug)]
struct FakeImageFetcher {
    outputs: Mutex<VecDeque<Result<ProxiedGithubImage, ImageProxyError>>>,
    requests: Mutex<Vec<(String, Option<String>)>>,
}

impl FakeImageFetcher {
    fn new(outputs: Vec<Result<ProxiedGithubImage, ImageProxyError>>) -> Self {
        Self {
            outputs: Mutex::new(VecDeque::from(outputs)),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> Vec<(String, Option<String>)> {
        self.requests.lock().expect("lock requests").clone()
    }
}

#[async_trait]
impl GithubImageFetcher for FakeImageFetcher {
    async fn fetch(
        &self,
        url: Url,
        authorization: Option<String>,
    ) -> Result<ProxiedGithubImage, ImageProxyError> {
        self.requests
            .lock()
            .expect("lock requests")
            .push((url.to_string(), authorization));
        self.outputs
            .lock()
            .expect("lock outputs")
            .pop_front()
            .unwrap_or(Err(ImageProxyError::FetchFailed))
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

fn image() -> ProxiedGithubImage {
    ProxiedGithubImage {
        content_type: "image/png".to_string(),
        bytes: Bytes::from_static(b"image-bytes"),
    }
}

#[tokio::test]
async fn service_proxies_github_image_as_base64_payload() {
    let runner = Arc::new(FakeRunner::new(vec![ok("ghs_test_token\n")]));
    let fetcher = Arc::new(FakeImageFetcher::new(vec![Ok(image())]));
    let service = GithubService::new_with_image_fetcher(
        GithubCliClient::with_runner(runner.clone()),
        fetcher.clone(),
    );

    let response = service
        .proxy_image(GithubImageProxyRequest {
            repo_path: "/repo".to_string(),
            url: "https://private-user-images.githubusercontent.com/123/example.png".to_string(),
        })
        .await
        .expect("proxy image");

    assert_eq!(response.content_type, "image/png");
    assert_eq!(response.byte_len, 11);
    assert_eq!(response.data_base64, "aW1hZ2UtYnl0ZXM=");
    assert_eq!(runner.requests()[0].args, vec!["auth", "token"]);
    assert_eq!(
        fetcher.requests()[0],
        (
            "https://private-user-images.githubusercontent.com/123/example.png".to_string(),
            Some("Bearer ghs_test_token".to_string())
        )
    );
}

#[tokio::test]
async fn service_rejects_non_github_image_url_without_gh_call() {
    let runner = Arc::new(FakeRunner::new(Vec::new()));
    let fetcher = Arc::new(FakeImageFetcher::new(Vec::new()));
    let service = GithubService::new_with_image_fetcher(
        GithubCliClient::with_runner(runner.clone()),
        fetcher.clone(),
    );

    let error = service
        .proxy_image(GithubImageProxyRequest {
            repo_path: "/repo".to_string(),
            url: "https://example.com/bad.png".to_string(),
        })
        .await
        .expect_err("unsupported url");

    assert!(matches!(
        error,
        GithubApiError::ImageProxy(ImageProxyError::UnsupportedUrl)
    ));
    assert!(runner.requests().is_empty());
    assert!(fetcher.requests().is_empty());
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
        br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","headRefOid":"abc","baseRefName":"main","body":"body","author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED"}"#,
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
    assert_eq!(pull_request.head_ref_oid.as_deref(), Some("abc"));
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "pr",
            "view",
            "42",
            "--json",
            "number,title,state,url,headRefName,headRefOid,baseRefName,body,author,createdAt,updatedAt,isDraft,reviewDecision,mergeStateStatus"
        ]
    );
}

#[tokio::test]
async fn service_creates_pull_request_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        "https://github.com/ace/app/pull/42\n",
    )]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let pull_request = service
        .create_pull_request(PullRequestCreateRequest {
            repo_path: "/repo".to_string(),
            title: "Ship it".to_string(),
            body: "Body".to_string(),
            head: "feature/work".to_string(),
            base: "main".to_string(),
            draft: true,
        })
        .await
        .expect("create pull request");

    assert_eq!(pull_request.number, Some(42));
    assert_eq!(pull_request.title, "Ship it");
    assert_eq!(pull_request.head_ref_name, "feature/work");
    assert_eq!(pull_request.base_ref_name, "main");
    assert_eq!(pull_request.is_draft, Some(true));
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "pr",
            "create",
            "--title",
            "Ship it",
            "--body",
            "Body",
            "--head",
            "feature/work",
            "--base",
            "main",
            "--draft"
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
            "number,title,state,url,headRefName,headRefOid,baseRefName,body,author,createdAt,updatedAt,isDraft,reviewDecision,mergeStateStatus,comments,reviews,latestReviews"
        ]
    );
}

#[tokio::test]
async fn service_returns_pull_request_timeline() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"[{"id":1,"node_id":"T_1","url":"https://api.github.test/timeline/1","html_url":"https://github.test/pull/42#event-1","event":"review_requested","created_at":"2026-06-21T00:00:00Z","actor":{"login":"octo"},"requested_reviewer":{"login":"maintainer"}}]"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let timeline = service
        .pull_request_timeline(PullRequestTimelineRequest {
            repo_path: "/repo".to_string(),
            number: 42,
            limit: 25,
        })
        .await
        .expect("timeline");

    assert_eq!(timeline[0].event.as_deref(), Some("review_requested"));
    assert_eq!(timeline[0].actor.as_ref().expect("actor").login, "octo");
    assert_eq!(
        timeline[0].extra["requested_reviewer"]["login"],
        "maintainer"
    );
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/issues/42/timeline",
            "-H",
            "Accept: application/vnd.github+json",
            "-F",
            "per_page=25"
        ]
    );
}

#[tokio::test]
async fn service_returns_pull_request_review_comments() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"[{"id":10,"node_id":"PRRC_10","url":"https://api.github.test/comments/10","html_url":"https://github.test/pull/42#discussion_r10","pull_request_review_id":5,"pull_request_url":"https://api.github.test/pulls/42","diff_hunk":"@@ -1 +1 @@","path":"src/lib.rs","position":1,"original_position":1,"line":12,"original_line":12,"side":"RIGHT","commit_id":"abc","original_commit_id":"abc","user":{"login":"reviewer"},"body":"Please cover this branch","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","subject_type":"line"}]"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let comments = service
        .pull_request_review_comments(PullRequestReviewCommentsRequest {
            repo_path: "/repo".to_string(),
            number: 42,
            limit: 30,
        })
        .await
        .expect("review comments");

    assert_eq!(comments[0].path, "src/lib.rs");
    assert_eq!(comments[0].line, Some(12));
    assert_eq!(comments[0].extra["subject_type"], "line");
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/pulls/42/comments",
            "-F",
            "per_page=30"
        ]
    );
}

#[tokio::test]
async fn service_returns_pull_request_review_threads() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"data":{"repository":{"pullRequest":{"number":42,"reviewThreads":{"totalCount":1,"nodes":[{"id":"PRRT_1","isCollapsed":false,"isOutdated":false,"isResolved":true,"path":"src/lib.rs","line":12,"startLine":10,"diffSide":"RIGHT","startDiffSide":"RIGHT","subjectType":"LINE","viewerCanReply":true,"viewerCanResolve":false,"viewerCanUnresolve":true,"resolvedBy":{"login":"maintainer"},"comments":{"totalCount":1,"nodes":[{"id":"PRRC_1","databaseId":10,"author":{"login":"reviewer"},"body":"Please cover this branch","createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","url":"https://github.test/pull/42#discussion_r10","path":"src/lib.rs","line":12,"originalLine":12,"diffHunk":"@@ -1 +1 @@","pullRequestReview":{"id":"PRR_1","state":"CHANGES_REQUESTED","author":{"login":"reviewer"}}}]}}]}}}}}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let threads = service
        .pull_request_review_threads(PullRequestReviewThreadsRequest {
            repo_path: "/repo".to_string(),
            number: 42,
            thread_limit: 20,
            comment_limit: 50,
        })
        .await
        .expect("review threads");

    assert_eq!(threads.number, 42);
    assert_eq!(threads.total_count, 1);
    assert!(threads.threads[0].is_resolved);
    assert_eq!(
        threads.threads[0].resolved_by.as_ref().unwrap().login,
        "maintainer"
    );
    assert_eq!(threads.threads[0].comments.nodes[0].database_id, Some(10));
    assert_eq!(runner.requests()[1].args[0], "api");
    assert_eq!(runner.requests()[1].args[1], "graphql");
    assert!(
        runner.requests()[1]
            .args
            .iter()
            .any(|arg| arg == "threadLimit=20")
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
async fn service_returns_pull_request_commits() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"commits":[{"oid":"abc","messageHeadline":"Add feature","messageBody":"body","authoredDate":"2026-06-21T00:00:00Z","committedDate":"2026-06-21T00:01:00Z","authors":[{"name":"Octo","email":"octo@example.test","login":"octo"}],"url":"https://github.test/commit/abc"}]}"#,
    )]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let commits = service
        .pull_request_commits(PullRequestCommitsRequest {
            repo_path: "/repo".to_string(),
            selector: "42".to_string(),
        })
        .await
        .expect("commits");

    assert_eq!(commits[0].oid, "abc");
    assert_eq!(commits[0].message_headline, "Add feature");
    assert_eq!(
        runner.requests()[0].args,
        vec!["pr", "view", "42", "--json", "commits"]
    );
}

#[tokio::test]
async fn service_returns_pull_request_merge_status() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"{"number":42,"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","reviewDecision":"REVIEW_REQUIRED","autoMergeRequest":{"enabledAt":"2026-06-21T00:00:00Z"},"maintainerCanModify":true,"changedFiles":3,"additions":10,"deletions":2,"statusCheckRollup":[{"name":"CI","status":"COMPLETED"}]}"#,
    )]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let status = service
        .pull_request_merge_status(PullRequestMergeStatusRequest {
            repo_path: "/repo".to_string(),
            selector: "42".to_string(),
        })
        .await
        .expect("merge status");

    assert_eq!(status.number, Some(42));
    assert_eq!(status.mergeable.as_deref(), Some("MERGEABLE"));
    assert_eq!(status.changed_files, 3);
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "pr",
            "view",
            "42",
            "--json",
            "number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,maintainerCanModify,changedFiles,additions,deletions,statusCheckRollup"
        ]
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
async fn service_lists_commit_check_runs_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"success","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"ok","text":null,"annotations_count":0,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"success"},"pull_requests":[]}]}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let runs = service
        .list_check_runs(CheckRunsRequest {
            repo_path: "/repo".to_string(),
            git_ref: "abc".to_string(),
            filter: CheckRunListFilter {
                limit: 25,
                status: Some("completed".to_string()),
                check_name: Some("build".to_string()),
                filter: Some("latest".to_string()),
                app_id: Some(1),
            },
        })
        .await
        .expect("check runs");

    assert_eq!(runs[0].name, "build");
    assert_eq!(runs[0].conclusion.as_deref(), Some("success"));
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/commits/abc/check-runs",
            "-F",
            "per_page=25",
            "-f",
            "status=completed",
            "-f",
            "check_name=build",
            "-f",
            "filter=latest",
            "-F",
            "app_id=1"
        ]
    );
}

#[tokio::test]
async fn service_returns_check_run_detail_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":"ci-10","url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":"compile failed","annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let run = service
        .check_run(CheckRunRequest {
            repo_path: "/repo".to_string(),
            check_run_id: 10,
        })
        .await
        .expect("check run");

    assert_eq!(run.name, "build");
    assert_eq!(run.conclusion.as_deref(), Some("failure"));
    assert_eq!(
        run.output.and_then(|output| output.text).as_deref(),
        Some("compile failed")
    );
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/check-runs/10"]
    );
}

#[tokio::test]
async fn service_lists_check_run_annotations_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"[{"path":"src/lib.rs","start_line":10,"end_line":10,"start_column":null,"end_column":null,"annotation_level":"failure","message":"expected value","title":"clippy","raw_details":"details","blob_href":"https://github.test/blob/src/lib.rs#L10"}]"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let annotations = service
        .list_check_run_annotations(CheckRunAnnotationsRequest {
            repo_path: "/repo".to_string(),
            check_run_id: 10,
            limit: 30,
        })
        .await
        .expect("annotations");

    assert_eq!(annotations[0].path, "src/lib.rs");
    assert_eq!(annotations[0].annotation_level, "failure");
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/check-runs/10/annotations",
            "-F",
            "per_page=30"
        ]
    );
}

#[tokio::test]
async fn service_rerequests_check_run_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(""),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let result = service
        .rerequest_check_run(CheckRunRerequestRequest {
            repo_path: "/repo".to_string(),
            check_run_id: 10,
        })
        .await
        .expect("rerequest");

    assert_eq!(result.action, "rerequest_check_run");
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/check-runs/10/rerequest", "-X", "POST"]
    );
}

#[tokio::test]
async fn service_lists_check_suites_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"total_count":1,"check_suites":[{"id":5,"node_id":"CS_1","head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"success","url":"https://api.github.test/check-suites/5","before":"def","after":"abc","pull_requests":[],"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","latest_check_runs_count":3,"check_runs_url":"https://api.github.test/check-suites/5/check-runs"}]}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let suites = service
        .list_check_suites(CheckSuitesRequest {
            repo_path: "/repo".to_string(),
            git_ref: "abc".to_string(),
            filter: CheckRunListFilter {
                limit: 25,
                check_name: Some("build".to_string()),
                app_id: Some(1),
                ..CheckRunListFilter::default()
            },
        })
        .await
        .expect("check suites");

    assert_eq!(suites[0].id, 5);
    assert_eq!(suites[0].latest_check_runs_count, Some(3));
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/commits/abc/check-suites",
            "-F",
            "per_page=25",
            "-f",
            "check_name=build",
            "-F",
            "app_id=1"
        ]
    );
}

#[tokio::test]
async fn service_returns_check_suite_detail_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"id":5,"node_id":"CS_1","head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure","url":"https://api.github.test/check-suites/5","before":"def","after":"abc","pull_requests":[],"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","latest_check_runs_count":3,"check_runs_url":"https://api.github.test/check-suites/5/check-runs"}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let suite = service
        .check_suite(CheckSuiteRequest {
            repo_path: "/repo".to_string(),
            check_suite_id: 5,
        })
        .await
        .expect("check suite");

    assert_eq!(suite.id, 5);
    assert_eq!(suite.conclusion.as_deref(), Some("failure"));
    assert_eq!(suite.latest_check_runs_count, Some(3));
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/check-suites/5"]
    );
}

#[tokio::test]
async fn service_rerequests_check_suite_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(""),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let result = service
        .rerequest_check_suite(CheckSuiteRerequestRequest {
            repo_path: "/repo".to_string(),
            check_suite_id: 5,
        })
        .await
        .expect("rerequest");

    assert_eq!(result.action, "rerequest_check_suite");
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/check-suites/5/rerequest",
            "-X",
            "POST"
        ]
    );
}

#[tokio::test]
async fn service_lists_check_suite_runs_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":null,"annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]}]}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let runs = service
        .list_check_suite_runs(CheckSuiteRunsRequest {
            repo_path: "/repo".to_string(),
            check_suite_id: 5,
            filter: CheckRunListFilter {
                limit: 25,
                status: Some("completed".to_string()),
                check_name: Some("build".to_string()),
                filter: Some("latest".to_string()),
                ..CheckRunListFilter::default()
            },
        })
        .await
        .expect("suite runs");

    assert_eq!(runs[0].id, 10);
    assert_eq!(runs[0].conclusion.as_deref(), Some("failure"));
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/check-suites/5/check-runs",
            "-F",
            "per_page=25",
            "-f",
            "status=completed",
            "-f",
            "check_name=build",
            "-f",
            "filter=latest"
        ]
    );
}

#[tokio::test]
async fn service_lists_commit_statuses_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"[{"id":99,"node_id":"ST_1","state":"failure","description":"lint failed","target_url":"https://ci.test/lint","context":"lint","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","url":"https://api.github.test/statuses/99","avatar_url":"https://avatars.githubusercontent.com/u/1"}]"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let statuses = service
        .list_commit_statuses(CommitStatusesRequest {
            repo_path: "/repo".to_string(),
            git_ref: "abc".to_string(),
            limit: 30,
        })
        .await
        .expect("statuses");

    assert_eq!(statuses[0].context, "lint");
    assert_eq!(statuses[0].state, "failure");
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/commits/abc/statuses",
            "-F",
            "per_page=30"
        ]
    );
}

#[tokio::test]
async fn service_returns_commit_check_rollup() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"success","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"ok","text":null,"annotations_count":0,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"success"},"pull_requests":[]}]}"#,
        ),
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"[{"id":99,"node_id":"ST_1","state":"pending","description":"lint running","target_url":"https://ci.test/lint","context":"lint","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","url":"https://api.github.test/statuses/99","avatar_url":"https://avatars.githubusercontent.com/u/1"}]"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let rollup = service
        .commit_check_rollup(CommitCheckRollupRequest {
            repo_path: "/repo".to_string(),
            git_ref: "abc".to_string(),
            check_run_limit: 25,
            status_limit: 10,
        })
        .await
        .expect("rollup");

    assert_eq!(rollup.git_ref, "abc");
    assert_eq!(rollup.summary.passed, 1);
    assert_eq!(rollup.summary.pending, 1);
    assert_eq!(
        rollup.summary.state,
        ace_git::GithubCommitCheckState::Pending
    );
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/commits/abc/check-runs",
            "-F",
            "per_page=25",
            "-f",
            "filter=latest"
        ]
    );
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
async fn service_lists_workflows_with_disabled() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"[{"id":1,"name":"CI","path":".github/workflows/ci.yml","state":"active"},{"id":2,"name":"Nightly","path":".github/workflows/nightly.yml","state":"disabled_manually"}]"#,
    )]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let workflows = service
        .list_workflows(WorkflowListRequest {
            repo_path: "/repo".to_string(),
            filter: WorkflowListFilter {
                limit: 10,
                include_disabled: true,
            },
        })
        .await
        .expect("workflows");

    assert_eq!(workflows[0].name, "CI");
    assert_eq!(workflows[1].state, "disabled_manually");
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "workflow",
            "list",
            "--limit",
            "10",
            "--json",
            "id,name,path,state",
            "--all"
        ]
    );
}

#[tokio::test]
async fn service_returns_workflow_detail() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"id":1,"node_id":"WF_1","name":"CI","path":".github/workflows/ci.yml","state":"active","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","url":"https://api.github.test/workflows/1","html_url":"https://github.test/actions/workflows/ci.yml","badge_url":"https://github.test/badge.svg"}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let workflow = service
        .workflow(WorkflowRequest {
            repo_path: "/repo".to_string(),
            workflow: "ci.yml".to_string(),
        })
        .await
        .expect("workflow");

    assert_eq!(workflow.id, 1);
    assert_eq!(workflow.node_id.as_deref(), Some("WF_1"));
    assert_eq!(
        workflow.html_url.as_deref(),
        Some("https://github.test/actions/workflows/ci.yml")
    );
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/actions/workflows/ci.yml"]
    );
}

#[tokio::test]
async fn service_dispatches_workflow_with_inputs() {
    let runner = Arc::new(FakeRunner::new(vec![ok("queued\n")]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let result = service
        .dispatch_workflow(WorkflowDispatchRequest {
            repo_path: "/repo".to_string(),
            workflow: "ci.yml".to_string(),
            ref_name: Some("feature/x".to_string()),
            inputs: vec![
                WorkflowDispatchInput {
                    name: "suite".to_string(),
                    value: "linux".to_string(),
                },
                WorkflowDispatchInput {
                    name: "retries".to_string(),
                    value: "2".to_string(),
                },
            ],
        })
        .await
        .expect("dispatch");

    assert_eq!(result.action, "dispatch_workflow");
    assert_eq!(result.stdout, "queued");
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "workflow",
            "run",
            "ci.yml",
            "--ref",
            "feature/x",
            "--raw-field",
            "suite=linux",
            "--raw-field",
            "retries=2"
        ]
    );
}

#[tokio::test]
async fn service_toggles_workflow_state() {
    let runner = Arc::new(FakeRunner::new(vec![ok("enabled\n"), ok("disabled\n")]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let enabled = service
        .enable_workflow(WorkflowEnableRequest {
            repo_path: "/repo".to_string(),
            workflow: "ci.yml".to_string(),
        })
        .await
        .expect("enable");
    let disabled = service
        .disable_workflow(WorkflowDisableRequest {
            repo_path: "/repo".to_string(),
            workflow: "ci.yml".to_string(),
        })
        .await
        .expect("disable");

    assert_eq!(enabled.action, "enable_workflow");
    assert_eq!(enabled.stdout, "enabled");
    assert_eq!(disabled.action, "disable_workflow");
    assert_eq!(disabled.stdout, "disabled");
    let requests = runner.requests();
    assert_eq!(requests[0].args, vec!["workflow", "enable", "ci.yml"]);
    assert_eq!(requests[1].args, vec!["workflow", "disable", "ci.yml"]);
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
async fn service_lists_workflow_run_jobs() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"total_count":1,"jobs":[{"id":200,"name":"test","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z","url":"https://api.github.test/jobs/200","html_url":"https://github.test/jobs/200","steps":[{"name":"cargo test","status":"completed","conclusion":"failure","number":3,"started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z"}]}]}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let jobs = service
        .list_workflow_run_jobs(WorkflowRunJobsRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
            attempt: Some(2),
            limit: 25,
        })
        .await
        .expect("jobs");

    assert_eq!(jobs[0].database_id, 200);
    assert_eq!(jobs[0].steps[0].name, "cargo test");
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/actions/runs/100/attempts/2/jobs",
            "-F",
            "per_page=25"
        ]
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
async fn service_returns_workflow_job_detail() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"{"id":200,"run_id":100,"run_url":"https://api.github.test/runs/100","run_attempt":2,"node_id":"J_1","head_sha":"abc","url":"https://api.github.test/jobs/200","html_url":"https://github.test/jobs/200","status":"completed","conclusion":"failure","created_at":"2026-06-21T00:00:00Z","started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z","name":"test","workflow_name":"CI","head_branch":"feature/x","labels":["ubuntu-latest"],"runner_id":1,"runner_name":"GitHub Actions 1","runner_group_id":2,"runner_group_name":"Default","steps":[{"name":"cargo test","status":"completed","conclusion":"failure","number":3,"started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z"}]}"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let detail = service
        .workflow_job(WorkflowJobRequest {
            repo_path: "/repo".to_string(),
            job_id: 200,
        })
        .await
        .expect("job detail");

    assert_eq!(detail.job.database_id, 200);
    assert_eq!(detail.workflow_name.as_deref(), Some("CI"));
    assert_eq!(detail.runner_name.as_deref(), Some("GitHub Actions 1"));
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/actions/jobs/200"]
    );
}

#[tokio::test]
async fn service_returns_workflow_job_log() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok("cargo test\nfailure\n"),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let response = service
        .workflow_job_log(WorkflowJobLogRequest {
            repo_path: "/repo".to_string(),
            job_id: 200,
        })
        .await
        .expect("job log");

    assert_eq!(response.log, "cargo test\nfailure");
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/actions/jobs/200/logs"]
    );
}

#[tokio::test]
async fn service_approves_workflow_run() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok("approved\n"),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let result = service
        .approve_workflow_run(WorkflowRunApproveRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
        })
        .await
        .expect("approve");

    assert_eq!(result.action, "approve_workflow_run");
    assert_eq!(result.stdout, "approved");
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/actions/runs/100/approve",
            "-X",
            "POST"
        ]
    );
}

#[tokio::test]
async fn service_reviews_workflow_run_pending_deployments() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok("reviewed\n"),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let result = service
        .review_workflow_run_pending_deployments(WorkflowRunPendingDeploymentReviewRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
            environment_ids: vec![9, 10],
            state: WorkflowRunPendingDeploymentReviewState::Approve,
            comment: "Ship it".to_string(),
        })
        .await
        .expect("review pending deployments");

    assert_eq!(result.action, "review_workflow_pending_deployments");
    let requests = runner.requests();
    assert_eq!(
        requests[1].args,
        vec![
            "api",
            "repos/ace/app/actions/runs/100/pending_deployments",
            "-X",
            "POST",
            "--input",
            "-"
        ]
    );
    let stdin = requests[1].stdin.as_deref().expect("stdin body");
    let body: serde_json::Value = serde_json::from_slice(stdin).expect("json body");
    assert_eq!(body["environment_ids"], serde_json::json!([9, 10]));
    assert_eq!(body["state"], "approved");
    assert_eq!(body["comment"], "Ship it");
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
async fn service_returns_workflow_run_pending_deployments() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"[{"environment":{"id":9,"node_id":"ENV_9","name":"production","url":"https://api.github.test/env/9","html_url":"https://github.test/env/production"},"wait_timer":30,"wait_timer_started_at":"2026-06-21T00:00:00Z","current_user_can_approve":true,"reviewers":[{"type":"User","reviewer":{"login":"octo","id":1}}]}]"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let deployments = service
        .workflow_run_pending_deployments(WorkflowRunPendingDeploymentsRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
        })
        .await
        .expect("pending deployments");

    assert_eq!(deployments[0].environment.name, "production");
    assert!(deployments[0].current_user_can_approve);
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/actions/runs/100/pending_deployments"]
    );
}

#[tokio::test]
async fn service_returns_workflow_run_approvals() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok(
            br#"[{"state":"approved","comment":"Ship it","environments":[{"id":9,"node_id":"ENV_9","name":"production","url":"https://api.github.test/env/9","html_url":"https://github.test/env/production"}],"user":{"login":"maintainer","id":1}}]"#,
        ),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let approvals = service
        .workflow_run_approvals(WorkflowRunApprovalsRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
        })
        .await
        .expect("approvals");

    assert_eq!(approvals[0].state, "approved");
    assert_eq!(approvals[0].comment.as_deref(), Some("Ship it"));
    assert_eq!(approvals[0].environments[0].name, "production");
    assert_eq!(approvals[0].user.as_ref().unwrap().login, "maintainer");
    assert_eq!(
        runner.requests()[1].args,
        vec!["api", "repos/ace/app/actions/runs/100/approvals"]
    );
}

#[tokio::test]
async fn service_downloads_workflow_run_artifacts() {
    let runner = Arc::new(FakeRunner::new(vec![ok("downloaded\n")]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let result = service
        .download_workflow_artifacts(WorkflowRunArtifactDownloadRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
            names: vec!["linux-build".to_string()],
            patterns: vec!["logs-*".to_string()],
            output_dir: Some("/tmp/artifacts".to_string()),
        })
        .await
        .expect("download");

    assert_eq!(result.action, "download_workflow_artifacts");
    assert_eq!(result.stdout, "downloaded");
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "run",
            "download",
            "100",
            "--name",
            "linux-build",
            "--pattern",
            "logs-*",
            "--dir",
            "/tmp/artifacts"
        ]
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
async fn service_force_cancels_workflow_run_through_github_cli() {
    let runner = Arc::new(FakeRunner::new(vec![
        ok(
            br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
        ),
        ok("force cancelled\n"),
    ]));
    let service = GithubService::new(GithubCliClient::with_runner(runner.clone()));

    let result = service
        .force_cancel_workflow_run(WorkflowRunForceCancelRequest {
            repo_path: "/repo".to_string(),
            run_id: 100,
        })
        .await
        .expect("force cancel");

    assert_eq!(result.action, "force_cancel_workflow_run");
    assert_eq!(result.stdout, "force cancelled");
    assert_eq!(
        runner.requests()[1].args,
        vec![
            "api",
            "repos/ace/app/actions/runs/100/force-cancel",
            "-X",
            "POST"
        ]
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
async fn route_returns_workflows_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok(
        br#"[{"id":1,"name":"CI","path":".github/workflows/ci.yml","state":"active"},{"id":2,"name":"Nightly","path":".github/workflows/nightly.yml","state":"disabled_manually"}]"#,
    )]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/workflows/list",
            serde_json::json!({
                "repo_path": "/repo",
                "filter": {
                    "limit": 10,
                    "include_disabled": true
                }
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body[0]["name"], "CI");
    assert_eq!(body[1]["state"], "disabled_manually");
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "workflow",
            "list",
            "--limit",
            "10",
            "--json",
            "id,name,path,state",
            "--all"
        ]
    );
}

#[tokio::test]
async fn route_dispatches_workflow_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("queued\n")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/workflows/dispatch",
            serde_json::json!({
                "repo_path": "/repo",
                "workflow": "ci.yml",
                "ref_name": "feature/x",
                "inputs": [
                    { "name": "suite", "value": "linux" },
                    { "name": "retries", "value": "2" }
                ]
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "dispatch_workflow");
    assert_eq!(body["stdout"], "queued");
    assert_eq!(
        runner.requests()[0].args,
        vec![
            "workflow",
            "run",
            "ci.yml",
            "--ref",
            "feature/x",
            "--raw-field",
            "suite=linux",
            "--raw-field",
            "retries=2"
        ]
    );
}

#[tokio::test]
async fn route_enables_workflow_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("enabled\n")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/workflows/enable",
            serde_json::json!({
                "repo_path": "/repo",
                "workflow": "ci.yml"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "enable_workflow");
    assert_eq!(body["stdout"], "enabled");
    assert_eq!(
        runner.requests()[0].args,
        vec!["workflow", "enable", "ci.yml"]
    );
}

#[tokio::test]
async fn route_disables_workflow_json() {
    let runner = Arc::new(FakeRunner::new(vec![ok("disabled\n")]));
    let app = test_router(runner.clone());

    let response = app
        .oneshot(json_request(
            "/workflows/disable",
            serde_json::json!({
                "repo_path": "/repo",
                "workflow": "ci.yml"
            }),
        ))
        .await
        .expect("route response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["action"], "disable_workflow");
    assert_eq!(body["stdout"], "disabled");
    assert_eq!(
        runner.requests()[0].args,
        vec!["workflow", "disable", "ci.yml"]
    );
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
