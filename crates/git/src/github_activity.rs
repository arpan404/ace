use crate::{
    GithubCliClient, GithubPrChecks, GithubPullRequest, GithubWorkflowRun, ProcessRunner, Result,
    WorkflowRunListFilter,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn pull_request_activity(
        &self,
        cwd: &Path,
        request: &PullRequestActivityRequest,
    ) -> Result<GithubPullRequestActivity> {
        let pull_request = self.pull_request(cwd, &request.selector).await?;
        let checks = self
            .pull_request_checks(cwd, Some(&request.selector), request.required_checks_only)
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

        Ok(GithubPullRequestActivity {
            pull_request,
            checks,
            workflow_runs,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestActivityRequest {
    pub selector: String,
    pub required_checks_only: bool,
    pub workflow_run_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestActivity {
    pub pull_request: GithubPullRequest,
    pub checks: GithubPrChecks,
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

    #[tokio::test]
    async fn pull_request_activity_fetches_pr_checks_and_branch_runs() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","headRefName":"feature/x","headRefOid":"abc","baseRefName":"main","body":"body"}"#,
            ),
            ok(
                br#"[{"bucket":"pass","completedAt":"2026-06-21T00:00:00Z","description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"SUCCESS","workflow":"CI"}]"#,
            ),
            ok(
                br#"[{"attempt":1,"conclusion":"success","createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"completed","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let activity = github
            .pull_request_activity(
                Path::new("."),
                &PullRequestActivityRequest {
                    selector: "42".to_string(),
                    required_checks_only: true,
                    workflow_run_limit: 12,
                },
            )
            .await
            .expect("activity");

        assert_eq!(activity.pull_request.head_ref_name, "feature/x");
        assert_eq!(activity.checks.summary.passed, 1);
        assert_eq!(activity.workflow_runs[0].database_id, 7);

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
        assert!(
            requests[2]
                .args
                .windows(2)
                .any(|pair| pair == ["--branch", "feature/x"])
        );
        assert!(
            requests[2]
                .args
                .windows(2)
                .any(|pair| pair == ["--commit", "abc"])
        );
        assert!(
            requests[2]
                .args
                .windows(2)
                .any(|pair| pair == ["--limit", "12"])
        );
    }
}
