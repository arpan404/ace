use super::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{
    github::{
        CheckRunAnnotationsRequest, CheckRunsRequest, CheckSuiteRunsRequest, CheckSuitesRequest,
        CommitStatusesRequest, EnvironmentStatusRequest, IssueListRequest, IssueThreadRequest,
        PullRequestActivityRequest, PullRequestCheckoutRequest, PullRequestChecksRequest,
        PullRequestCloseRequest, PullRequestCommentRequest, PullRequestDashboardRequest,
        PullRequestDiffRequest, PullRequestFilesRequest, PullRequestListRequest,
        PullRequestMergeRequest, PullRequestReadyStateRequest, PullRequestReopenRequest,
        PullRequestRequest, PullRequestReviewRequest, PullRequestThreadRequest,
        SearchIssuesRequest, SearchPullRequestsRequest, WorkflowDisableRequest,
        WorkflowDispatchRequest, WorkflowEnableRequest, WorkflowListRequest,
        WorkflowRunArtifactsRequest, WorkflowRunCancelRequest, WorkflowRunListRequest,
        WorkflowRunLogRequest, WorkflowRunRequest, WorkflowRunRerunRequest,
    },
    ws::methods,
};
use serde_json::Value;

impl<R: ProcessRunner> WsApiState<R> {
    pub(super) async fn dispatch_github_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::GITHUB_ENVIRONMENT_STATUS => {
                self.github_json::<EnvironmentStatusRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.environment_status(request).await },
                )
                .await
            }
            methods::GITHUB_ISSUES_LIST => {
                self.github_json::<IssueListRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_issues(request).await },
                )
                .await
            }
            methods::GITHUB_ISSUES_THREAD => {
                self.github_json::<IssueThreadRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.issue_thread(request).await },
                )
                .await
            }
            methods::GITHUB_ISSUES_SEARCH => {
                self.github_json::<SearchIssuesRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.search_issues(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUESTS_LIST => {
                self.github_json::<PullRequestListRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_pull_requests(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUESTS_SEARCH => {
                self.github_json::<SearchPullRequestsRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.search_pull_requests(request).await
                    },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_VIEW => {
                self.github_json::<PullRequestRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_THREAD => {
                self.github_json::<PullRequestThreadRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_thread(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_FILES => {
                self.github_json::<PullRequestFilesRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_files(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_DIFF => {
                self.github_json::<PullRequestDiffRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_diff(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_CHECKS => {
                self.github_json::<PullRequestChecksRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_checks(request).await },
                )
                .await
            }
            methods::GITHUB_CHECK_RUNS_LIST => {
                self.github_json::<CheckRunsRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_check_runs(request).await },
                )
                .await
            }
            methods::GITHUB_CHECK_RUNS_ANNOTATIONS => {
                self.github_json::<CheckRunAnnotationsRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.list_check_run_annotations(request).await
                    },
                )
                .await
            }
            methods::GITHUB_CHECK_SUITES_LIST => {
                self.github_json::<CheckSuitesRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_check_suites(request).await },
                )
                .await
            }
            methods::GITHUB_CHECK_SUITES_RUNS => {
                self.github_json::<CheckSuiteRunsRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_check_suite_runs(request).await },
                )
                .await
            }
            methods::GITHUB_COMMIT_STATUSES_LIST => {
                self.github_json::<CommitStatusesRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_commit_statuses(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_ACTIVITY => {
                self.github_json::<PullRequestActivityRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_activity(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_DASHBOARD => {
                self.github_json::<PullRequestDashboardRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_dashboard(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_CHECKOUT => {
                self.github_json::<PullRequestCheckoutRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.checkout_pull_request(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_COMMENT => {
                self.github_json::<PullRequestCommentRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.comment_pull_request(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_REVIEW => {
                self.github_json::<PullRequestReviewRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.review_pull_request(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_READY_STATE => {
                self.github_json::<PullRequestReadyStateRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.set_pull_request_ready_state(request).await
                    },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_CLOSE => {
                self.github_json::<PullRequestCloseRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.close_pull_request(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_REOPEN => {
                self.github_json::<PullRequestReopenRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.reopen_pull_request(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_MERGE => {
                self.github_json::<PullRequestMergeRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.merge_pull_request(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOWS_LIST => {
                self.github_json::<WorkflowListRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_workflows(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOWS_DISPATCH => {
                self.github_json::<WorkflowDispatchRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.dispatch_workflow(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOWS_ENABLE => {
                self.github_json::<WorkflowEnableRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.enable_workflow(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOWS_DISABLE => {
                self.github_json::<WorkflowDisableRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.disable_workflow(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUNS_LIST => {
                self.github_json::<WorkflowRunListRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_workflow_runs(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_VIEW => {
                self.github_json::<WorkflowRunRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow_run(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_LOG => {
                self.github_json::<WorkflowRunLogRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow_run_log(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_ARTIFACTS => {
                self.github_json::<WorkflowRunArtifactsRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow_run_artifacts(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_RERUN => {
                self.github_json::<WorkflowRunRerunRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.rerun_workflow_run(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_CANCEL => {
                self.github_json::<WorkflowRunCancelRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.cancel_workflow_run(request).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::GithubService;
    use ace_git::{CommandOutput, CommandRequest, GitToolError, GithubCliClient};
    use ace_protocol::{
        PROTOCOL_VERSION,
        ws::{WsServerPayload, WsServerResponse},
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

    fn test_state(runner: Arc<FakeRunner>) -> WsApiState<FakeRunner> {
        WsApiState::new(GithubService::new(GithubCliClient::with_runner(runner)))
    }

    async fn dispatch(
        state: &WsApiState<FakeRunner>,
        request: serde_json::Value,
    ) -> WsServerResponse {
        let response = state.dispatch_text(&request.to_string()).await;
        serde_json::from_str(&response).expect("response")
    }

    #[tokio::test]
    async fn dispatches_issue_listing_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"[{"number":1,"title":"Bug","state":"OPEN","url":"https://example.test/issues/1","author":{"login":"octo"},"labels":[{"name":"bug"}],"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","comments":2}]"#,
        )]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-issues-list",
                "method": methods::GITHUB_ISSUES_LIST,
                "payload": {
                    "repo_path": "/repo",
                    "filter": {
                        "limit": 15,
                        "state": "all",
                        "author": "@me",
                        "assignee": null,
                        "mention": null,
                        "milestone": null,
                        "search": "sort:created-desc",
                        "labels": ["bug", "ui"]
                    }
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["number"], 1);
        assert_eq!(body[0]["comments"], 2);
        let args = &runner.requests()[0].args;
        assert_eq!(args[0..2], ["issue", "list"]);
        assert!(args.windows(2).any(|pair| pair == ["--state", "all"]));
        assert!(args.windows(2).any(|pair| pair == ["--author", "@me"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--search", "sort:created-desc"])
        );
        assert!(args.windows(2).any(|pair| pair == ["--label", "bug"]));
        assert!(args.windows(2).any(|pair| pair == ["--label", "ui"]));
    }

    #[tokio::test]
    async fn dispatches_issue_thread_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"{"number":1,"title":"Bug","state":"OPEN","url":"https://example.test/issues/1","body":"body","labels":[],"assignees":[],"author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","comments":[{"body":"comment","author":{"login":"maintainer"},"createdAt":"2026-06-21T00:02:00Z","updatedAt":null,"url":"https://example.test/issues/1#issuecomment-1"}]}"#,
        )]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-issue-thread",
                "method": methods::GITHUB_ISSUES_THREAD,
                "payload": {
                    "repo_path": "/repo",
                    "number": 1
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["comments"][0]["body"], "comment");
        assert_eq!(
            runner.requests()[0].args,
            vec![
                "issue",
                "view",
                "1",
                "--json",
                "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt,comments"
            ]
        );
    }

    #[tokio::test]
    async fn dispatches_pull_request_listing_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"[{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","author":{"login":"octo"},"labels":[],"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","baseRefName":"main","headRefName":"feature/x","isDraft":true,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"CI"}]}]"#,
        )]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-list",
                "method": methods::GITHUB_PULL_REQUESTS_LIST,
                "payload": {
                    "repo_path": "/repo",
                    "filter": {
                        "limit": 20,
                        "state": "open",
                        "author": null,
                        "assignee": null,
                        "base": "main",
                        "head": "feature/x",
                        "search": null,
                        "labels": [],
                        "draft_only": true
                    }
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["number"], 42);
        assert_eq!(body[0]["statusCheckRollup"][0]["name"], "CI");
        let args = &runner.requests()[0].args;
        assert_eq!(args[0..2], ["pr", "list"]);
        assert!(args.windows(2).any(|pair| pair == ["--base", "main"]));
        assert!(args.windows(2).any(|pair| pair == ["--head", "feature/x"]));
        assert!(args.contains(&"--draft".to_string()));
    }

    #[tokio::test]
    async fn dispatches_pull_request_detail_thread_files_and_diff_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","baseRefName":"main","body":"body","author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","isDraft":false,"reviewDecision":"APPROVED","mergeStateStatus":"CLEAN"}"#,
            ),
            ok(
                br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","baseRefName":"main","body":"body","author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","isDraft":false,"reviewDecision":"APPROVED","mergeStateStatus":"CLEAN","comments":[],"reviews":[{"id":"R_1","author":{"login":"maintainer"},"authorAssociation":"MEMBER","body":"looks good","state":"APPROVED","submittedAt":"2026-06-21T00:02:00Z","commit":{"oid":"abc"},"url":"https://example.test/review/1"}],"latestReviews":[]}"#,
            ),
            ok(br#"{"files":[{"path":"src/lib.rs","additions":3,"deletions":1}]}"#),
            ok(br#"{"files":[{"path":"src/lib.rs","additions":3,"deletions":1}]}"#),
            ok("diff --git a/src/lib.rs b/src/lib.rs\n"),
        ]));
        let state = test_state(runner.clone());

        let detail_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-view",
                "method": methods::GITHUB_PULL_REQUEST_VIEW,
                "payload": {
                    "repo_path": "/repo",
                    "selector": "42"
                }
            }),
        )
        .await;
        let thread_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-thread",
                "method": methods::GITHUB_PULL_REQUEST_THREAD,
                "payload": {
                    "repo_path": "/repo",
                    "selector": "42"
                }
            }),
        )
        .await;
        let files_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-files",
                "method": methods::GITHUB_PULL_REQUEST_FILES,
                "payload": {
                    "repo_path": "/repo",
                    "selector": "42"
                }
            }),
        )
        .await;
        let diff_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-diff",
                "method": methods::GITHUB_PULL_REQUEST_DIFF,
                "payload": {
                    "repo_path": "/repo",
                    "selector": "42"
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body: detail } = detail_response.payload else {
            panic!("expected detail result");
        };
        let WsServerPayload::Result { body: thread } = thread_response.payload else {
            panic!("expected thread result");
        };
        let WsServerPayload::Result { body: files } = files_response.payload else {
            panic!("expected files result");
        };
        let WsServerPayload::Result { body: diff } = diff_response.payload else {
            panic!("expected diff result");
        };
        assert_eq!(detail["headRefName"], "feature/x");
        assert_eq!(thread["reviews"][0]["state"], "APPROVED");
        assert_eq!(files[0]["path"], "src/lib.rs");
        assert_eq!(diff["selector"], "42");
        assert!(
            diff["diff"]
                .as_str()
                .expect("diff text")
                .contains("diff --git")
        );
        let requests = runner.requests();
        assert_eq!(requests[0].args[0..3], ["pr", "view", "42"]);
        assert_eq!(requests[1].args[0..3], ["pr", "view", "42"]);
        assert_eq!(
            requests[2].args,
            vec!["pr", "view", "42", "--json", "files"]
        );
        assert_eq!(
            requests[3].args,
            vec!["pr", "view", "42", "--json", "files"]
        );
        assert_eq!(requests[4].args, vec!["pr", "diff", "42", "--patch"]);
    }

    #[tokio::test]
    async fn dispatches_issue_and_pull_request_search_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"[{"assignees":[],"author":{"login":"octo"},"authorAssociation":"MEMBER","body":"body","closedAt":null,"commentsCount":1,"createdAt":"2026-06-21T00:00:00Z","id":"I_1","isLocked":false,"isPullRequest":false,"labels":[{"name":"bug"}],"number":1,"repository":{"nameWithOwner":"ace/app","url":"https://example.test/ace/app"},"state":"open","title":"Bug","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/issues/1"}]"#,
            ),
            ok(
                br#"[{"assignees":[],"author":{"login":"octo"},"authorAssociation":"MEMBER","body":"body","closedAt":null,"commentsCount":1,"createdAt":"2026-06-21T00:00:00Z","id":"PR_1","isDraft":true,"isLocked":false,"isPullRequest":true,"labels":[],"number":2,"repository":{"nameWithOwner":"ace/app","url":"https://example.test/ace/app"},"state":"open","title":"Feature","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/pull/2"}]"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let issue_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-issue-search",
                "method": methods::GITHUB_ISSUES_SEARCH,
                "payload": {
                    "repo_path": "/repo",
                    "query": "render bug",
                    "filter": {
                        "limit": 5,
                        "state": "open",
                        "author": null,
                        "assignee": null,
                        "owner": ["ace"],
                        "repo": ["ace/app"],
                        "labels": ["bug"],
                        "sort": "created",
                        "order": "desc",
                        "include_prs_in_issue_search": true
                    }
                }
            }),
        )
        .await;
        let pr_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-search",
                "method": methods::GITHUB_PULL_REQUESTS_SEARCH,
                "payload": {
                    "repo_path": "/repo",
                    "query": "feature",
                    "filter": {
                        "limit": 5,
                        "state": null,
                        "author": null,
                        "assignee": null,
                        "owner": [],
                        "repo": [],
                        "labels": [],
                        "sort": null,
                        "order": null,
                        "include_prs_in_issue_search": false
                    }
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body: issues } = issue_response.payload else {
            panic!("expected issue search result");
        };
        let WsServerPayload::Result { body: prs } = pr_response.payload else {
            panic!("expected pr search result");
        };
        assert_eq!(issues[0]["repository"]["nameWithOwner"], "ace/app");
        assert_eq!(prs[0]["isDraft"], true);
        let requests = runner.requests();
        assert_eq!(requests[0].args[0..3], ["search", "issues", "render bug"]);
        assert!(requests[0].args.contains(&"--include-prs".to_string()));
        assert!(
            requests[0]
                .args
                .windows(2)
                .any(|pair| pair == ["--owner", "ace"])
        );
        assert_eq!(requests[1].args[0..3], ["search", "prs", "feature"]);
    }

    #[tokio::test]
    async fn dispatches_pull_request_checks_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"[{"bucket":"pass","completedAt":"2026-06-21T00:00:00Z","description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"SUCCESS","workflow":"CI"}]"#,
        )]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-1",
                "method": methods::GITHUB_PULL_REQUEST_CHECKS,
                "payload": {
                    "repo_path": "/repo",
                    "selector": "42",
                    "required_only": true
                }
            }),
        )
        .await;

        assert_eq!(response.request_id, "req-1");
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["summary"]["passed"], 1);
        assert_eq!(
            runner.requests()[0].args,
            vec![
                "pr",
                "checks",
                "42",
                "--required",
                "--json",
                "bucket,completedAt,description,event,link,name,startedAt,state,workflow"
            ]
        );
    }

    #[tokio::test]
    async fn dispatches_check_runs_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"success","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"ok","text":null,"annotations_count":0,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"success"},"pull_requests":[]}]}"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-check-runs",
                "method": methods::GITHUB_CHECK_RUNS_LIST,
                "payload": {
                    "repo_path": "/repo",
                    "git_ref": "abc",
                    "filter": {
                        "limit": 25,
                        "status": "completed",
                        "check_name": "build",
                        "filter": "latest",
                        "app_id": 1
                    }
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["name"], "build");
        assert_eq!(body[0]["conclusion"], "success");
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
    async fn dispatches_check_run_annotations_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"[{"path":"src/lib.rs","start_line":10,"end_line":10,"start_column":null,"end_column":null,"annotation_level":"failure","message":"expected value","title":"clippy","raw_details":"details","blob_href":"https://github.test/blob/src/lib.rs#L10"}]"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-check-annotations",
                "method": methods::GITHUB_CHECK_RUNS_ANNOTATIONS,
                "payload": {
                    "repo_path": "/repo",
                    "check_run_id": 10,
                    "limit": 30
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["path"], "src/lib.rs");
        assert_eq!(body[0]["annotation_level"], "failure");
        assert_eq!(body[0]["message"], "expected value");
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
    async fn dispatches_check_suites_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"total_count":1,"check_suites":[{"id":5,"node_id":"CS_1","head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"success","url":"https://api.github.test/check-suites/5","before":"def","after":"abc","pull_requests":[],"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","latest_check_runs_count":3,"check_runs_url":"https://api.github.test/check-suites/5/check-runs"}]}"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-check-suites",
                "method": methods::GITHUB_CHECK_SUITES_LIST,
                "payload": {
                    "repo_path": "/repo",
                    "git_ref": "abc",
                    "filter": {
                        "limit": 25,
                        "status": null,
                        "check_name": "build",
                        "filter": null,
                        "app_id": 1
                    }
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["id"], 5);
        assert_eq!(body[0]["latest_check_runs_count"], 3);
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
    async fn dispatches_check_suite_runs_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":null,"annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]}]}"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-check-suite-runs",
                "method": methods::GITHUB_CHECK_SUITES_RUNS,
                "payload": {
                    "repo_path": "/repo",
                    "check_suite_id": 5,
                    "filter": {
                        "limit": 25,
                        "status": "completed",
                        "check_name": "build",
                        "filter": "latest",
                        "app_id": null
                    }
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["id"], 10);
        assert_eq!(body[0]["conclusion"], "failure");
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
    async fn dispatches_commit_statuses_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"[{"id":99,"node_id":"ST_1","state":"failure","description":"lint failed","target_url":"https://ci.test/lint","context":"lint","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","url":"https://api.github.test/statuses/99","avatar_url":"https://avatars.githubusercontent.com/u/1"}]"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-commit-statuses",
                "method": methods::GITHUB_COMMIT_STATUSES_LIST,
                "payload": {
                    "repo_path": "/repo",
                    "git_ref": "abc",
                    "limit": 30
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["context"], "lint");
        assert_eq!(body[0]["state"], "failure");
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
    async fn dispatches_workflow_runs_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"[{"attempt":1,"conclusion":null,"createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"in_progress","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#,
        )]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-2",
                "method": methods::GITHUB_WORKFLOW_RUNS_LIST,
                "payload": {
                    "repo_path": "/repo",
                    "filter": {
                        "limit": 10,
                        "branch": "feature/x",
                        "commit": null,
                        "status": "in_progress",
                        "workflow": "CI",
                        "event": null,
                        "user": null,
                        "include_disabled": false
                    }
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["databaseId"], 7);
        let args = &runner.requests()[0].args;
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--branch", "feature/x"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--status", "in_progress"])
        );
        assert!(args.windows(2).any(|pair| pair == ["--workflow", "CI"]));
    }

    #[tokio::test]
    async fn dispatches_pull_request_review_action_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok("reviewed\n")]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-3",
                "method": methods::GITHUB_PULL_REQUEST_REVIEW,
                "payload": {
                    "repo_path": "/repo",
                    "selector": "42",
                    "decision": "Approve",
                    "body": "ship it"
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["action"], "review_pull_request");
        assert_eq!(
            runner.requests()[0].args,
            vec!["pr", "review", "42", "--approve", "--body", "ship it"]
        );
    }

    #[tokio::test]
    async fn dispatches_workflow_actions_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok("queued\n"), ok("rerun\n")]));
        let state = test_state(runner.clone());

        let dispatch_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-4",
                "method": methods::GITHUB_WORKFLOWS_DISPATCH,
                "payload": {
                    "repo_path": "/repo",
                    "workflow": "ci.yml",
                    "ref_name": "feature/x",
                    "inputs": [
                        { "name": "suite", "value": "linux" }
                    ]
                }
            }),
        )
        .await;
        let rerun_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-5",
                "method": methods::GITHUB_WORKFLOW_RUN_RERUN,
                "payload": {
                    "repo_path": "/repo",
                    "run_id": 100,
                    "failed_only": true,
                    "debug": false,
                    "job_id": 200
                }
            }),
        )
        .await;

        assert!(matches!(
            dispatch_response.payload,
            WsServerPayload::Result { .. }
        ));
        assert!(matches!(
            rerun_response.payload,
            WsServerPayload::Result { .. }
        ));
        let requests = runner.requests();
        assert_eq!(
            requests[0].args,
            vec![
                "workflow",
                "run",
                "ci.yml",
                "--ref",
                "feature/x",
                "--raw-field",
                "suite=linux"
            ]
        );
        assert_eq!(
            requests[1].args,
            vec!["run", "rerun", "100", "--failed", "--job", "200"]
        );
    }

    #[tokio::test]
    async fn returns_ws_error_for_unknown_method() {
        let state = test_state(Arc::new(FakeRunner::new(Vec::new())));

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-6",
                "method": "github.unknown",
                "payload": {}
            }),
        )
        .await;

        assert_eq!(response.request_id, "req-6");
        assert_eq!(
            response.payload,
            WsServerPayload::Error {
                code: "unknown_method".to_string(),
                message: "unknown websocket method: github.unknown".to_string()
            }
        );
    }

    #[tokio::test]
    async fn returns_ws_error_for_invalid_payload() {
        let state = test_state(Arc::new(FakeRunner::new(Vec::new())));

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-7",
                "method": methods::GITHUB_WORKFLOW_RUNS_LIST,
                "payload": {
                    "repo_path": "/repo"
                }
            }),
        )
        .await;

        let WsServerPayload::Error { code, .. } = response.payload else {
            panic!("expected error");
        };
        assert_eq!(code, "invalid_payload");
    }
}
