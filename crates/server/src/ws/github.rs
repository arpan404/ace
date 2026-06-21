use super::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{
    github::{
        CheckRunAnnotationsRequest, CheckRunRequest, CheckRunRerequestRequest, CheckRunsRequest,
        CheckSuiteRequest, CheckSuiteRerequestRequest, CheckSuiteRunsRequest, CheckSuitesRequest,
        CommitCheckRollupRequest, CommitStatusesRequest, EnvironmentStatusRequest,
        IssueListRequest, IssueThreadRequest, PullRequestActivityRequest,
        PullRequestCheckoutRequest, PullRequestChecksRequest, PullRequestCloseRequest,
        PullRequestCommentRequest, PullRequestCommitsRequest, PullRequestCreateRequest,
        PullRequestDashboardRequest, PullRequestDiffRequest, PullRequestFilesRequest,
        PullRequestListRequest, PullRequestMergeRequest, PullRequestMergeStatusRequest,
        PullRequestReadyStateRequest, PullRequestReopenRequest, PullRequestRequest,
        PullRequestReviewCommentsRequest, PullRequestReviewRequest,
        PullRequestReviewThreadsRequest, PullRequestThreadRequest, PullRequestTimelineRequest,
        RepositoryActivityRequest, SearchIssuesRequest, SearchPullRequestsRequest,
        WorkflowDisableRequest, WorkflowDispatchRequest, WorkflowEnableRequest,
        WorkflowJobLogRequest, WorkflowJobRequest, WorkflowListRequest, WorkflowRequest,
        WorkflowRunApprovalsRequest, WorkflowRunApproveRequest, WorkflowRunArtifactDownloadRequest,
        WorkflowRunArtifactsRequest, WorkflowRunCancelRequest, WorkflowRunForceCancelRequest,
        WorkflowRunJobsRequest, WorkflowRunListRequest, WorkflowRunLogRequest,
        WorkflowRunPendingDeploymentReviewRequest, WorkflowRunPendingDeploymentsRequest,
        WorkflowRunRequest, WorkflowRunRerunRequest,
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
            methods::GITHUB_REPOSITORY_ACTIVITY => {
                let request = serde_json::from_value::<RepositoryActivityRequest>(payload)?;
                let response = self.repository_activity(request).await?;
                Ok(serde_json::to_value(response)?)
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
            methods::GITHUB_PULL_REQUEST_CREATE => {
                self.github_json::<PullRequestCreateRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.create_pull_request(request).await },
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
            methods::GITHUB_PULL_REQUEST_TIMELINE => {
                self.github_json::<PullRequestTimelineRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_timeline(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_REVIEW_COMMENTS => {
                self.github_json::<PullRequestReviewCommentsRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.pull_request_review_comments(request).await
                    },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_REVIEW_THREADS => {
                self.github_json::<PullRequestReviewThreadsRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.pull_request_review_threads(request).await
                    },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_COMMITS => {
                self.github_json::<PullRequestCommitsRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_commits(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_MERGE_STATUS => {
                self.github_json::<PullRequestMergeStatusRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.pull_request_merge_status(request).await
                    },
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
            methods::GITHUB_CHECK_RUNS_VIEW => {
                self.github_json::<CheckRunRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.check_run(request).await },
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
            methods::GITHUB_CHECK_RUNS_REREQUEST => {
                self.github_json::<CheckRunRerequestRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.rerequest_check_run(request).await },
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
            methods::GITHUB_CHECK_SUITES_VIEW => {
                self.github_json::<CheckSuiteRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.check_suite(request).await },
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
            methods::GITHUB_CHECK_SUITES_REREQUEST => {
                self.github_json::<CheckSuiteRerequestRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.rerequest_check_suite(request).await },
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
            methods::GITHUB_COMMIT_CHECK_ROLLUP => {
                self.github_json::<CommitCheckRollupRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.commit_check_rollup(request).await },
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
            methods::GITHUB_WORKFLOWS_VIEW => {
                self.github_json::<WorkflowRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow(request).await },
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
            methods::GITHUB_WORKFLOW_RUN_JOBS => {
                self.github_json::<WorkflowRunJobsRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_workflow_run_jobs(request).await },
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
            methods::GITHUB_WORKFLOW_JOBS_VIEW => {
                self.github_json::<WorkflowJobRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow_job(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_JOBS_LOG => {
                self.github_json::<WorkflowJobLogRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow_job_log(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_PENDING_DEPLOYMENTS => {
                self.github_json::<WorkflowRunPendingDeploymentsRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.workflow_run_pending_deployments(request).await
                    },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_PENDING_DEPLOYMENTS_REVIEW => {
                self.github_json::<WorkflowRunPendingDeploymentReviewRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .review_workflow_run_pending_deployments(request)
                            .await
                    },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_APPROVALS => {
                self.github_json::<WorkflowRunApprovalsRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow_run_approvals(request).await },
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
            methods::GITHUB_WORKFLOW_RUN_ARTIFACTS_DOWNLOAD => {
                self.github_json::<WorkflowRunArtifactDownloadRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.download_workflow_artifacts(request).await
                    },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_APPROVE => {
                self.github_json::<WorkflowRunApproveRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.approve_workflow_run(request).await },
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
            methods::GITHUB_WORKFLOW_RUN_FORCE_CANCEL => {
                self.github_json::<WorkflowRunForceCancelRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.force_cancel_workflow_run(request).await
                    },
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
    use crate::{git::GitService, github::GithubService};
    use ace_git::{
        CommandOutput, CommandRequest, GitClient, GitToolError, GithubCliClient, ProcessRunner,
    };
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
        WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
    }

    async fn dispatch(
        state: &WsApiState<FakeRunner>,
        request: serde_json::Value,
    ) -> WsServerResponse {
        let response = state.dispatch_text(&request.to_string()).await;
        serde_json::from_str(&response).expect("response")
    }

    #[tokio::test]
    async fn dispatches_repository_activity_snapshot_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok("/repo\n"),
            ok("true\n"),
            ok("## feature/x...origin/feature/x [ahead 1]\n M src/lib.rs\n"),
            ok("worktree /repo\nHEAD abc\nbranch refs/heads/feature/x\n\n"),
            ok(
                br#"[{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","author":{"login":"octo"},"labels":[],"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","baseRefName":"main","headRefName":"feature/x","headRefOid":"abc","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED","statusCheckRollup":[]}]"#,
            ),
            ok(
                br#"[{"bucket":"pending","completedAt":null,"description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"PENDING","workflow":"CI"}]"#,
            ),
            ok(
                br#"[{"attempt":1,"conclusion":null,"createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"in_progress","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-repo-activity",
                "method": methods::GITHUB_REPOSITORY_ACTIVITY,
                "payload": {
                    "repo_path": "/repo",
                    "pull_request_limit": 5,
                    "required_checks_only": true,
                    "workflow_run_limit_per_pr": 2,
                    "include_worktrees": true
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["repository"]["root"], "/repo");
        assert_eq!(body["status"]["current_branch"], "feature/x");
        assert_eq!(body["status"]["dirty"], true);
        assert_eq!(body["status"]["ahead"], 1);
        assert_eq!(body["worktrees"][0]["branch"], "feature/x");
        assert_eq!(
            body["pull_requests"]["items"][0]["pull_request"]["number"],
            42
        );
        assert_eq!(
            body["pull_requests"]["items"][0]["checks"]["summary"]["pending"],
            1
        );
        assert_eq!(
            body["pull_requests"]["items"][0]["workflow_runs"][0]["databaseId"],
            7
        );

        let requests = runner.requests();
        assert_eq!(requests[0].args, vec!["rev-parse", "--show-toplevel"]);
        assert_eq!(requests[1].args, vec!["rev-parse", "--is-inside-work-tree"]);
        assert_eq!(requests[2].args, vec!["status", "--porcelain=v1", "-b"]);
        assert_eq!(requests[3].args, vec!["worktree", "list", "--porcelain"]);
        assert_eq!(requests[4].args[0..2], ["pr", "list"]);
        assert!(
            requests[4]
                .args
                .windows(2)
                .any(|pair| pair == ["--head", "feature/x"])
        );
        assert!(
            requests[4]
                .args
                .windows(2)
                .any(|pair| pair == ["--limit", "5"])
        );
        assert_eq!(requests[5].args[0..4], ["pr", "checks", "42", "--required"]);
        assert_eq!(requests[6].args[0..2], ["run", "list"]);
        assert!(
            requests[6]
                .args
                .windows(2)
                .any(|pair| pair == ["--branch", "feature/x"])
        );
        assert!(
            requests[6]
                .args
                .windows(2)
                .any(|pair| pair == ["--commit", "abc"])
        );
    }

    #[tokio::test]
    async fn repository_activity_skips_github_calls_without_current_branch() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok("/repo\n"),
            ok("true\n"),
            ok("## HEAD (no branch)\n"),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-detached-activity",
                "method": methods::GITHUB_REPOSITORY_ACTIVITY,
                "payload": {
                    "repo_path": "/repo",
                    "pull_request_limit": 5,
                    "required_checks_only": false,
                    "workflow_run_limit_per_pr": 0,
                    "include_worktrees": false
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["status"]["current_branch"], serde_json::Value::Null);
        assert_eq!(body["worktrees"].as_array().expect("worktrees").len(), 0);
        assert_eq!(
            body["pull_requests"]["items"]
                .as_array()
                .expect("pull request items")
                .len(),
            0
        );
        assert_eq!(runner.requests().len(), 3);
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
    async fn dispatches_pull_request_create_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            "https://github.com/ace/app/pull/42\n",
        )]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-create",
                "method": methods::GITHUB_PULL_REQUEST_CREATE,
                "payload": {
                    "repo_path": "/repo",
                    "title": "Ship it",
                    "body": "Body",
                    "head": "feature/work",
                    "base": "main",
                    "draft": true
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["number"], 42);
        assert_eq!(body["title"], "Ship it");
        assert_eq!(body["headRefName"], "feature/work");
        assert_eq!(body["isDraft"], true);
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
    async fn dispatches_pull_request_detail_thread_files_and_diff_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","baseRefName":"main","body":"body","author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","isDraft":false,"reviewDecision":"APPROVED","mergeStateStatus":"CLEAN"}"#,
            ),
            ok(
                br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","baseRefName":"main","body":"body","author":{"login":"octo"},"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","isDraft":false,"reviewDecision":"APPROVED","mergeStateStatus":"CLEAN","comments":[],"reviews":[{"id":"R_1","author":{"login":"maintainer"},"authorAssociation":"MEMBER","body":"looks good","state":"APPROVED","submittedAt":"2026-06-21T00:02:00Z","commit":{"oid":"abc"},"url":"https://example.test/review/1"}],"latestReviews":[]}"#,
            ),
            ok(
                br#"{"commits":[{"oid":"abc","messageHeadline":"Add feature","messageBody":"body","authoredDate":"2026-06-21T00:00:00Z","committedDate":"2026-06-21T00:01:00Z","authors":[{"name":"Octo","email":"octo@example.test","login":"octo"}],"url":"https://github.test/commit/abc"}]}"#,
            ),
            ok(
                br#"{"number":42,"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","reviewDecision":"REVIEW_REQUIRED","autoMergeRequest":{"enabledAt":"2026-06-21T00:00:00Z"},"maintainerCanModify":true,"changedFiles":3,"additions":10,"deletions":2,"statusCheckRollup":[{"name":"CI","status":"COMPLETED"}]}"#,
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
        let commits_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-commits",
                "method": methods::GITHUB_PULL_REQUEST_COMMITS,
                "payload": {
                    "repo_path": "/repo",
                    "selector": "42"
                }
            }),
        )
        .await;
        let merge_status_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-merge-status",
                "method": methods::GITHUB_PULL_REQUEST_MERGE_STATUS,
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
        let WsServerPayload::Result { body: commits } = commits_response.payload else {
            panic!("expected commits result");
        };
        let WsServerPayload::Result { body: merge_status } = merge_status_response.payload else {
            panic!("expected merge status result");
        };
        let WsServerPayload::Result { body: files } = files_response.payload else {
            panic!("expected files result");
        };
        let WsServerPayload::Result { body: diff } = diff_response.payload else {
            panic!("expected diff result");
        };
        assert_eq!(detail["headRefName"], "feature/x");
        assert_eq!(thread["reviews"][0]["state"], "APPROVED");
        assert_eq!(commits[0]["oid"], "abc");
        assert_eq!(merge_status["mergeable"], "MERGEABLE");
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
            vec!["pr", "view", "42", "--json", "commits"]
        );
        assert_eq!(
            requests[3].args,
            vec![
                "pr",
                "view",
                "42",
                "--json",
                "number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,maintainerCanModify,changedFiles,additions,deletions,statusCheckRollup"
            ]
        );
        assert_eq!(
            requests[4].args,
            vec!["pr", "view", "42", "--json", "files"]
        );
        assert_eq!(
            requests[5].args,
            vec!["pr", "view", "42", "--json", "files"]
        );
        assert_eq!(requests[6].args, vec!["pr", "diff", "42", "--patch"]);
    }

    #[tokio::test]
    async fn dispatches_pull_request_timeline_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"[{"id":1,"node_id":"T_1","url":"https://api.github.test/timeline/1","html_url":"https://github.test/pull/42#event-1","event":"review_requested","created_at":"2026-06-21T00:00:00Z","actor":{"login":"octo"},"requested_reviewer":{"login":"maintainer"}}]"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-timeline",
                "method": methods::GITHUB_PULL_REQUEST_TIMELINE,
                "payload": {
                    "repo_path": "/repo",
                    "number": 42,
                    "limit": 25
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["event"], "review_requested");
        assert_eq!(body[0]["requested_reviewer"]["login"], "maintainer");
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
    async fn dispatches_pull_request_review_comments_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"[{"id":10,"node_id":"PRRC_10","url":"https://api.github.test/comments/10","html_url":"https://github.test/pull/42#discussion_r10","pull_request_review_id":5,"pull_request_url":"https://api.github.test/pulls/42","diff_hunk":"@@ -1 +1 @@","path":"src/lib.rs","position":1,"original_position":1,"line":12,"original_line":12,"side":"RIGHT","commit_id":"abc","original_commit_id":"abc","user":{"login":"reviewer"},"body":"Please cover this branch","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","subject_type":"line"}]"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-review-comments",
                "method": methods::GITHUB_PULL_REQUEST_REVIEW_COMMENTS,
                "payload": {
                    "repo_path": "/repo",
                    "number": 42,
                    "limit": 30
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["path"], "src/lib.rs");
        assert_eq!(body[0]["line"], 12);
        assert_eq!(body[0]["subject_type"], "line");
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
    async fn dispatches_pull_request_review_threads_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"data":{"repository":{"pullRequest":{"number":42,"reviewThreads":{"totalCount":1,"nodes":[{"id":"PRRT_1","isCollapsed":false,"isOutdated":false,"isResolved":true,"path":"src/lib.rs","line":12,"startLine":10,"diffSide":"RIGHT","startDiffSide":"RIGHT","subjectType":"LINE","viewerCanReply":true,"viewerCanResolve":false,"viewerCanUnresolve":true,"resolvedBy":{"login":"maintainer"},"comments":{"totalCount":1,"nodes":[{"id":"PRRC_1","databaseId":10,"author":{"login":"reviewer"},"body":"Please cover this branch","createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","url":"https://github.test/pull/42#discussion_r10","path":"src/lib.rs","line":12,"originalLine":12,"diffHunk":"@@ -1 +1 @@","pullRequestReview":{"id":"PRR_1","state":"CHANGES_REQUESTED","author":{"login":"reviewer"}}}]}}]}}}}}"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pr-review-threads",
                "method": methods::GITHUB_PULL_REQUEST_REVIEW_THREADS,
                "payload": {
                    "repo_path": "/repo",
                    "number": 42,
                    "thread_limit": 20,
                    "comment_limit": 50
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["number"], 42);
        assert_eq!(body["total_count"], 1);
        assert_eq!(body["threads"][0]["isResolved"], true);
        assert_eq!(body["threads"][0]["resolvedBy"]["login"], "maintainer");
        assert_eq!(body["threads"][0]["comments"]["nodes"][0]["databaseId"], 10);
        assert_eq!(runner.requests()[1].args[0], "api");
        assert_eq!(runner.requests()[1].args[1], "graphql");
        assert!(
            runner.requests()[1]
                .args
                .iter()
                .any(|arg| arg == "commentLimit=50")
        );
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
    async fn dispatches_check_run_detail_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":"ci-10","url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":"compile failed","annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]}"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-check-run",
                "method": methods::GITHUB_CHECK_RUNS_VIEW,
                "payload": {
                    "repo_path": "/repo",
                    "check_run_id": 10
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["name"], "build");
        assert_eq!(body["conclusion"], "failure");
        assert_eq!(body["output"]["text"], "compile failed");
        assert_eq!(
            runner.requests()[1].args,
            vec!["api", "repos/ace/app/check-runs/10"]
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
    async fn dispatches_check_run_rerequest_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(""),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-check-rerun",
                "method": methods::GITHUB_CHECK_RUNS_REREQUEST,
                "payload": {
                    "repo_path": "/repo",
                    "check_run_id": 10
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["action"], "rerequest_check_run");
        assert_eq!(
            runner.requests()[1].args,
            vec!["api", "repos/ace/app/check-runs/10/rerequest", "-X", "POST"]
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
    async fn dispatches_check_suite_detail_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"id":5,"node_id":"CS_1","head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure","url":"https://api.github.test/check-suites/5","before":"def","after":"abc","pull_requests":[],"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","latest_check_runs_count":3,"check_runs_url":"https://api.github.test/check-suites/5/check-runs"}"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-check-suite",
                "method": methods::GITHUB_CHECK_SUITES_VIEW,
                "payload": {
                    "repo_path": "/repo",
                    "check_suite_id": 5
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["id"], 5);
        assert_eq!(body["conclusion"], "failure");
        assert_eq!(body["latest_check_runs_count"], 3);
        assert_eq!(
            runner.requests()[1].args,
            vec!["api", "repos/ace/app/check-suites/5"]
        );
    }

    #[tokio::test]
    async fn dispatches_check_suite_rerequest_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(""),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-check-suite-rerun",
                "method": methods::GITHUB_CHECK_SUITES_REREQUEST,
                "payload": {
                    "repo_path": "/repo",
                    "check_suite_id": 5
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["action"], "rerequest_check_suite");
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
    async fn dispatches_commit_check_rollup_over_ws_rpc() {
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
                br#"[{"id":99,"node_id":"ST_1","state":"failure","description":"lint failed","target_url":"https://ci.test/lint","context":"lint","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","url":"https://api.github.test/statuses/99","avatar_url":"https://avatars.githubusercontent.com/u/1"}]"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-commit-rollup",
                "method": methods::GITHUB_COMMIT_CHECK_ROLLUP,
                "payload": {
                    "repo_path": "/repo",
                    "git_ref": "abc",
                    "check_run_limit": 25,
                    "status_limit": 10
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["git_ref"], "abc");
        assert_eq!(body["summary"]["passed"], 1);
        assert_eq!(body["summary"]["failed"], 1);
        assert_eq!(body["summary"]["state"], "failed");
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
        assert_eq!(
            runner.requests()[3].args,
            vec![
                "api",
                "repos/ace/app/commits/abc/statuses",
                "-F",
                "per_page=10"
            ]
        );
    }

    #[tokio::test]
    async fn dispatches_workflow_detail_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"id":1,"node_id":"WF_1","name":"CI","path":".github/workflows/ci.yml","state":"active","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","url":"https://api.github.test/workflows/1","html_url":"https://github.test/actions/workflows/ci.yml","badge_url":"https://github.test/badge.svg"}"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-workflow-view",
                "method": methods::GITHUB_WORKFLOWS_VIEW,
                "payload": {
                    "repo_path": "/repo",
                    "workflow": "ci.yml"
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["id"], 1);
        assert_eq!(body["node_id"], "WF_1");
        assert_eq!(
            body["html_url"],
            "https://github.test/actions/workflows/ci.yml"
        );
        assert_eq!(
            runner.requests()[1].args,
            vec!["api", "repos/ace/app/actions/workflows/ci.yml"]
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
    async fn dispatches_workflow_run_jobs_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"total_count":1,"jobs":[{"id":200,"name":"test","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z","url":"https://api.github.test/jobs/200","html_url":"https://github.test/jobs/200","steps":[{"name":"cargo test","status":"completed","conclusion":"failure","number":3,"started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z"}]}]}"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-workflow-run-jobs",
                "method": methods::GITHUB_WORKFLOW_RUN_JOBS,
                "payload": {
                    "repo_path": "/repo",
                    "run_id": 100,
                    "attempt": 2,
                    "limit": 25
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["databaseId"], 200);
        assert_eq!(body[0]["steps"][0]["name"], "cargo test");
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
    async fn dispatches_workflow_job_detail_and_log_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"id":200,"run_id":100,"run_url":"https://api.github.test/runs/100","run_attempt":2,"node_id":"J_1","head_sha":"abc","url":"https://api.github.test/jobs/200","html_url":"https://github.test/jobs/200","status":"completed","conclusion":"failure","created_at":"2026-06-21T00:00:00Z","started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z","name":"test","workflow_name":"CI","head_branch":"feature/x","labels":["ubuntu-latest"],"runner_id":1,"runner_name":"GitHub Actions 1","runner_group_id":2,"runner_group_name":"Default","steps":[{"name":"cargo test","status":"completed","conclusion":"failure","number":3,"started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z"}]}"#,
            ),
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok("cargo test\nfailure\n"),
        ]));
        let state = test_state(runner.clone());

        let detail_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-workflow-job",
                "method": methods::GITHUB_WORKFLOW_JOBS_VIEW,
                "payload": {
                    "repo_path": "/repo",
                    "job_id": 200
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = detail_response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["databaseId"], 200);
        assert_eq!(body["workflowName"], "CI");
        assert_eq!(body["runnerName"], "GitHub Actions 1");

        let log_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-workflow-job-log",
                "method": methods::GITHUB_WORKFLOW_JOBS_LOG,
                "payload": {
                    "repo_path": "/repo",
                    "job_id": 200
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = log_response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["log"], "cargo test\nfailure");
        let requests = runner.requests();
        assert_eq!(
            requests[1].args,
            vec!["api", "repos/ace/app/actions/jobs/200"]
        );
        assert_eq!(
            requests[3].args,
            vec!["api", "repos/ace/app/actions/jobs/200/logs"]
        );
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
    async fn dispatches_workflow_artifact_download_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok("downloaded\n")]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-artifact-download",
                "method": methods::GITHUB_WORKFLOW_RUN_ARTIFACTS_DOWNLOAD,
                "payload": {
                    "repo_path": "/repo",
                    "run_id": 100,
                    "names": ["linux-build"],
                    "patterns": ["logs-*"],
                    "output_dir": "/tmp/artifacts"
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["action"], "download_workflow_artifacts");
        assert_eq!(body["stdout"], "downloaded");
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
    async fn dispatches_workflow_run_pending_deployments_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"[{"environment":{"id":9,"node_id":"ENV_9","name":"production","url":"https://api.github.test/env/9","html_url":"https://github.test/env/production"},"wait_timer":30,"wait_timer_started_at":"2026-06-21T00:00:00Z","current_user_can_approve":true,"reviewers":[{"type":"User","reviewer":{"login":"octo","id":1}}]}]"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pending-deployments",
                "method": methods::GITHUB_WORKFLOW_RUN_PENDING_DEPLOYMENTS,
                "payload": {
                    "repo_path": "/repo",
                    "run_id": 100
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["environment"]["name"], "production");
        assert_eq!(body[0]["current_user_can_approve"], true);
        assert_eq!(
            runner.requests()[1].args,
            vec!["api", "repos/ace/app/actions/runs/100/pending_deployments"]
        );
    }

    #[tokio::test]
    async fn dispatches_workflow_run_approvals_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"[{"state":"approved","comment":"Ship it","environments":[{"id":9,"node_id":"ENV_9","name":"production","url":"https://api.github.test/env/9","html_url":"https://github.test/env/production"}],"user":{"login":"maintainer","id":1}}]"#,
            ),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-run-approvals",
                "method": methods::GITHUB_WORKFLOW_RUN_APPROVALS,
                "payload": {
                    "repo_path": "/repo",
                    "run_id": 100
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["state"], "approved");
        assert_eq!(body[0]["comment"], "Ship it");
        assert_eq!(body[0]["environments"][0]["name"], "production");
        assert_eq!(body[0]["user"]["login"], "maintainer");
        assert_eq!(
            runner.requests()[1].args,
            vec!["api", "repos/ace/app/actions/runs/100/approvals"]
        );
    }

    #[tokio::test]
    async fn dispatches_workflow_run_approve_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok("approved\n"),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-workflow-approve",
                "method": methods::GITHUB_WORKFLOW_RUN_APPROVE,
                "payload": {
                    "repo_path": "/repo",
                    "run_id": 100
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["action"], "approve_workflow_run");
        assert_eq!(body["stdout"], "approved");
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
    async fn dispatches_workflow_run_force_cancel_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok("force cancelled\n"),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-workflow-force-cancel",
                "method": methods::GITHUB_WORKFLOW_RUN_FORCE_CANCEL,
                "payload": {
                    "repo_path": "/repo",
                    "run_id": 100
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["action"], "force_cancel_workflow_run");
        assert_eq!(body["stdout"], "force cancelled");
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
    async fn dispatches_workflow_pending_deployment_review_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok("reviewed\n"),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-pending-deployment-review",
                "method": methods::GITHUB_WORKFLOW_RUN_PENDING_DEPLOYMENTS_REVIEW,
                "payload": {
                    "repo_path": "/repo",
                    "run_id": 100,
                    "environment_ids": [9, 10],
                    "state": "Reject",
                    "comment": "Needs manual verification"
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["action"], "review_workflow_pending_deployments");
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
        assert_eq!(body["state"], "rejected");
        assert_eq!(body["comment"], "Needs manual verification");
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
