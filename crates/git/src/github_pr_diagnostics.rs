use crate::{
    GitToolError, GithubCliClient, GithubPullRequestCiStatus, GithubPullRequestMergeStatus,
    GithubPullRequestReviewThreads, ProcessRunner, PullRequestCiStatusRequest, Result,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn pull_request_diagnostics(
        &self,
        cwd: &Path,
        request: &PullRequestDiagnosticsRequest,
    ) -> Result<GithubPullRequestDiagnostics> {
        let ci_status = self
            .pull_request_ci_status(
                cwd,
                &PullRequestCiStatusRequest {
                    selector: request.selector.clone(),
                    required_checks_only: request.required_checks_only,
                    workflow_run_limit: request.workflow_run_limit,
                    check_run_limit: request.check_run_limit,
                    status_limit: request.status_limit,
                },
            )
            .await?;

        let merge_status = if request.include_merge_status {
            Some(
                self.pull_request_merge_status(cwd, &request.selector)
                    .await?,
            )
        } else {
            None
        };

        let review_threads = if request.include_review_threads {
            let number = ci_status
                .pull_request
                .number
                .ok_or_else(|| GitToolError::Parse {
                    context: "github pull request diagnostics",
                    message: format!(
                        "pull request selector `{}` did not resolve to a number",
                        request.selector
                    ),
                })?;
            Some(
                self.pull_request_review_threads(
                    cwd,
                    number,
                    request.review_thread_limit,
                    request.review_comment_limit,
                )
                .await?,
            )
        } else {
            None
        };

        Ok(GithubPullRequestDiagnostics {
            ci_status,
            merge_status,
            review_threads,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestDiagnosticsRequest {
    pub selector: String,
    pub required_checks_only: bool,
    pub workflow_run_limit: u32,
    pub check_run_limit: u32,
    pub status_limit: u32,
    pub include_merge_status: bool,
    pub include_review_threads: bool,
    pub review_thread_limit: u32,
    pub review_comment_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestDiagnostics {
    pub ci_status: GithubPullRequestCiStatus,
    pub merge_status: Option<GithubPullRequestMergeStatus>,
    pub review_threads: Option<GithubPullRequestReviewThreads>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, CommandRequest};
    use async_trait::async_trait;
    use std::{collections::VecDeque, path::Path, sync::Mutex};

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
    impl crate::ProcessRunner for FakeRunner {
        async fn run(&self, request: CommandRequest) -> crate::Result<CommandOutput> {
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

    fn repo_json() -> &'static [u8] {
        br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#
    }

    fn pr_json() -> &'static [u8] {
        br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","headRefOid":"abc","baseRefName":"main","body":"body"}"#
    }

    fn pr_checks_json() -> &'static [u8] {
        br#"[{"bucket":"fail","completedAt":"2026-06-21T00:01:00Z","description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"FAILURE","workflow":"CI"}]"#
    }

    fn check_runs_json() -> &'static [u8] {
        br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":null,"annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]}]}"#
    }

    fn statuses_json() -> &'static [u8] {
        br#"[{"id":99,"node_id":"ST_1","state":"failure","description":"failed","target_url":"https://ci.test/status","context":"ci/build","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","url":"https://api.github.test/statuses/99","avatar_url":"https://avatars.githubusercontent.com/u/1"}]"#
    }

    fn runs_json() -> &'static [u8] {
        br#"[{"attempt":1,"conclusion":"failure","createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"completed","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#
    }

    fn merge_status_json() -> &'static [u8] {
        br#"{"number":42,"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","reviewDecision":"CHANGES_REQUESTED","autoMergeRequest":null,"maintainerCanModify":true,"changedFiles":2,"additions":10,"deletions":1,"statusCheckRollup":[]}"#
    }

    fn review_threads_json() -> &'static [u8] {
        br#"{"data":{"repository":{"pullRequest":{"number":42,"reviewThreads":{"totalCount":1,"nodes":[{"id":"PRRT_1","isCollapsed":false,"isOutdated":false,"isResolved":false,"path":"src/lib.rs","line":12,"startLine":10,"diffSide":"RIGHT","startDiffSide":"RIGHT","subjectType":"LINE","viewerCanReply":true,"viewerCanResolve":true,"viewerCanUnresolve":false,"resolvedBy":null,"comments":{"totalCount":1,"nodes":[{"id":"PRRC_1","databaseId":10,"author":{"login":"reviewer"},"body":"Please cover this branch","createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","url":"https://github.test/pull/42#discussion_r10","path":"src/lib.rs","line":12,"originalLine":12,"diffHunk":"@@ -1 +1 @@","pullRequestReview":{"id":"PRR_1","state":"CHANGES_REQUESTED","author":{"login":"reviewer"}}}]}}]}}}}}"#
    }

    #[tokio::test]
    async fn pull_request_diagnostics_fetches_ci_merge_and_review_threads() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(pr_json()),
            ok(pr_checks_json()),
            ok(repo_json()),
            ok(check_runs_json()),
            ok(repo_json()),
            ok(statuses_json()),
            ok(runs_json()),
            ok(merge_status_json()),
            ok(repo_json()),
            ok(review_threads_json()),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diagnostics = github
            .pull_request_diagnostics(
                Path::new("."),
                &PullRequestDiagnosticsRequest {
                    selector: "42".to_string(),
                    required_checks_only: true,
                    workflow_run_limit: 5,
                    check_run_limit: 25,
                    status_limit: 20,
                    include_merge_status: true,
                    include_review_threads: true,
                    review_thread_limit: 10,
                    review_comment_limit: 3,
                },
            )
            .await
            .expect("diagnostics");

        assert_eq!(diagnostics.ci_status.pull_request.number, Some(42));
        assert_eq!(diagnostics.ci_status.commit_checks.summary.failed, 2);
        assert_eq!(
            diagnostics
                .merge_status
                .as_ref()
                .and_then(|status| status.merge_state_status.as_deref()),
            Some("BLOCKED")
        );
        assert_eq!(
            diagnostics
                .review_threads
                .as_ref()
                .map(|threads| threads.total_count),
            Some(1)
        );

        let requests = runner.requests();
        assert_eq!(requests[0].args[0..3], ["pr", "view", "42"]);
        assert_eq!(requests[7].args[0..3], ["pr", "view", "42"]);
        assert_eq!(requests[9].args[0..2], ["api", "graphql"]);
        assert!(
            requests[9]
                .args
                .windows(2)
                .any(|pair| pair == ["-F", "number=42"])
        );
    }

    #[tokio::test]
    async fn pull_request_diagnostics_can_skip_expensive_optional_payloads() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(pr_json()),
            ok(pr_checks_json()),
            ok(repo_json()),
            ok(check_runs_json()),
            ok(repo_json()),
            ok(statuses_json()),
            ok(runs_json()),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diagnostics = github
            .pull_request_diagnostics(
                Path::new("."),
                &PullRequestDiagnosticsRequest {
                    selector: "42".to_string(),
                    required_checks_only: false,
                    workflow_run_limit: 5,
                    check_run_limit: 25,
                    status_limit: 20,
                    include_merge_status: false,
                    include_review_threads: false,
                    review_thread_limit: 10,
                    review_comment_limit: 3,
                },
            )
            .await
            .expect("diagnostics");

        assert!(diagnostics.merge_status.is_none());
        assert!(diagnostics.review_threads.is_none());
        assert_eq!(runner.requests().len(), 7);
    }
}
