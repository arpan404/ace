use crate::{
    CommitCheckRollupRequest, GithubCliClient, GithubCommitCheckRollup, GithubPrChecks,
    GithubPullRequest, GithubWorkflowRun, ProcessRunner, Result, WorkflowRunListFilter,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn pull_request_ci_status(
        &self,
        cwd: &Path,
        request: &PullRequestCiStatusRequest,
    ) -> Result<GithubPullRequestCiStatus> {
        let pull_request = self.pull_request(cwd, &request.selector).await?;
        let pr_checks = self
            .pull_request_checks(cwd, Some(&request.selector), request.required_checks_only)
            .await?;
        let git_ref = pull_request
            .head_ref_oid
            .as_deref()
            .unwrap_or(&pull_request.head_ref_name);
        let commit_checks = self
            .commit_check_rollup(
                cwd,
                git_ref,
                &CommitCheckRollupRequest {
                    check_run_limit: request.check_run_limit,
                    status_limit: request.status_limit,
                },
            )
            .await?;
        let workflow_runs = self
            .list_workflow_runs(
                cwd,
                &WorkflowRunListFilter {
                    limit: request.workflow_run_limit,
                    branch: Some(pull_request.head_ref_name.clone()),
                    commit: pull_request.head_ref_oid.clone(),
                    ..WorkflowRunListFilter::default()
                },
            )
            .await?;

        Ok(GithubPullRequestCiStatus {
            pull_request,
            pr_checks,
            commit_checks,
            workflow_runs,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestCiStatusRequest {
    pub selector: String,
    pub required_checks_only: bool,
    pub workflow_run_limit: u32,
    pub check_run_limit: u32,
    pub status_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestCiStatus {
    pub pull_request: GithubPullRequest,
    pub pr_checks: GithubPrChecks,
    pub commit_checks: GithubCommitCheckRollup,
    pub workflow_runs: Vec<GithubWorkflowRun>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, CommandRequest, GitToolError};
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

    #[tokio::test]
    async fn pull_request_ci_status_aggregates_pr_checks_commit_checks_and_runs() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","headRefOid":"abc","baseRefName":"main","body":"body"}"#,
            ),
            ok(
                br#"[{"bucket":"fail","completedAt":"2026-06-21T00:01:00Z","description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"FAILURE","workflow":"CI"}]"#,
            ),
            ok(repo_json()),
            ok(
                br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":null,"annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]}]}"#,
            ),
            ok(repo_json()),
            ok(
                br#"[{"id":99,"node_id":"ST_1","state":"failure","description":"failed","target_url":"https://ci.test/status","context":"ci/build","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","url":"https://api.github.test/statuses/99","avatar_url":"https://avatars.githubusercontent.com/u/1"}]"#,
            ),
            ok(
                br#"[{"attempt":1,"conclusion":"failure","createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"completed","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let status = github
            .pull_request_ci_status(
                Path::new("."),
                &PullRequestCiStatusRequest {
                    selector: "42".to_string(),
                    required_checks_only: true,
                    workflow_run_limit: 5,
                    check_run_limit: 25,
                    status_limit: 20,
                },
            )
            .await
            .expect("ci status");

        assert_eq!(status.pull_request.number, Some(42));
        assert_eq!(status.pr_checks.summary.failed, 1);
        assert_eq!(status.commit_checks.git_ref, "abc");
        assert_eq!(status.commit_checks.summary.failed, 2);
        assert_eq!(status.workflow_runs[0].database_id, 7);

        let requests = runner.requests();
        assert_eq!(requests[0].args[0..3], ["pr", "view", "42"]);
        assert_eq!(
            requests[1].args,
            vec![
                "pr",
                "checks",
                "42",
                "--required",
                "--json",
                "bucket,completedAt,description,event,link,name,startedAt,state,workflow"
            ]
        );
        assert_eq!(requests[3].args[1], "repos/ace/app/commits/abc/check-runs");
        assert_eq!(requests[3].args[3], "per_page=25");
        assert_eq!(requests[5].args[1], "repos/ace/app/commits/abc/statuses");
        assert_eq!(requests[5].args[3], "per_page=20");
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
        assert!(
            requests[6]
                .args
                .windows(2)
                .any(|pair| pair == ["--limit", "5"])
        );
    }
}
