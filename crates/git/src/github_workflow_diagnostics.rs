use crate::{
    GithubCliClient, GithubWorkflowArtifact, GithubWorkflowJob, GithubWorkflowRunDetail,
    ProcessRunner, Result,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn workflow_run_diagnostics(
        &self,
        cwd: &Path,
        request: &WorkflowRunDiagnosticsRequest,
    ) -> Result<GithubWorkflowRunDiagnostics> {
        let run = self
            .workflow_run(cwd, request.run_id, request.attempt)
            .await?;
        let jobs = self
            .list_workflow_run_jobs(cwd, request.run_id, request.attempt, request.job_limit)
            .await?;
        let failed_log = if request.include_failed_log {
            Some(
                self.workflow_run_log(cwd, request.run_id, request.attempt, None, true)
                    .await?,
            )
        } else {
            None
        };
        let artifacts = if request.include_artifacts {
            self.workflow_run_artifacts(cwd, request.run_id).await?
        } else {
            Vec::new()
        };

        Ok(GithubWorkflowRunDiagnostics {
            run,
            jobs,
            failed_log,
            artifacts,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunDiagnosticsRequest {
    pub run_id: u64,
    pub attempt: Option<u32>,
    pub job_limit: u32,
    pub include_failed_log: bool,
    pub include_artifacts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubWorkflowRunDiagnostics {
    pub run: GithubWorkflowRunDetail,
    pub jobs: Vec<GithubWorkflowJob>,
    pub failed_log: Option<String>,
    pub artifacts: Vec<GithubWorkflowArtifact>,
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
    async fn workflow_run_diagnostics_fetches_detail_jobs_log_and_artifacts() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"attempt":2,"conclusion":"failure","createdAt":"2026-06-21T00:00:00Z","databaseId":100,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","jobs":[],"name":"CI","number":7,"startedAt":"2026-06-21T00:01:00Z","status":"completed","updatedAt":"2026-06-21T00:02:00Z","url":"https://example.test/runs/100","workflowDatabaseId":5,"workflowName":"CI"}"#,
            ),
            ok(repo_json()),
            ok(
                br#"{"total_count":1,"jobs":[{"id":200,"name":"test","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z","url":"https://api.github.test/jobs/200","html_url":"https://github.test/jobs/200","steps":[{"name":"cargo test","status":"completed","conclusion":"failure","number":3,"started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z"}]}]}"#,
            ),
            ok("test\tcargo test\tfailed\n"),
            ok(repo_json()),
            ok(
                br#"{"total_count":1,"artifacts":[{"id":9,"name":"logs","size_in_bytes":123,"url":"https://api.github.test/artifacts/9","archive_download_url":"https://api.github.test/artifacts/9/zip","expired":false,"created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","expires_at":"2026-09-21T00:00:00Z","workflow_run":{"id":100,"repository_id":1,"head_repository_id":1,"head_branch":"feature/x","head_sha":"abc"}}]}"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diagnostics = github
            .workflow_run_diagnostics(
                Path::new("."),
                &WorkflowRunDiagnosticsRequest {
                    run_id: 100,
                    attempt: Some(2),
                    job_limit: 25,
                    include_failed_log: true,
                    include_artifacts: true,
                },
            )
            .await
            .expect("diagnostics");

        assert_eq!(diagnostics.run.run.database_id, 100);
        assert_eq!(diagnostics.jobs[0].database_id, 200);
        assert_eq!(
            diagnostics.failed_log.as_deref(),
            Some("test\tcargo test\tfailed")
        );
        assert_eq!(diagnostics.artifacts[0].name, "logs");

        let requests = runner.requests();
        assert_eq!(requests[0].args[0..4], ["run", "view", "100", "--json"]);
        assert!(
            requests[0]
                .args
                .windows(2)
                .any(|pair| pair == ["--attempt", "2"])
        );
        assert_eq!(
            requests[2].args,
            vec![
                "api",
                "repos/ace/app/actions/runs/100/attempts/2/jobs",
                "-F",
                "per_page=25"
            ]
        );
        assert_eq!(
            requests[3].args,
            vec!["run", "view", "100", "--attempt", "2", "--log-failed"]
        );
        assert_eq!(
            requests[5].args,
            vec!["api", "repos/ace/app/actions/runs/100/artifacts"]
        );
    }

    #[tokio::test]
    async fn workflow_run_diagnostics_can_skip_expensive_optional_payloads() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"attempt":1,"conclusion":null,"createdAt":"2026-06-21T00:00:00Z","databaseId":100,"displayTitle":"Run","event":"push","headBranch":"main","headSha":"abc","jobs":[],"name":"CI","number":7,"startedAt":"2026-06-21T00:01:00Z","status":"in_progress","updatedAt":"2026-06-21T00:02:00Z","url":"https://example.test/runs/100","workflowDatabaseId":5,"workflowName":"CI"}"#,
            ),
            ok(repo_json()),
            ok(br#"{"total_count":0,"jobs":[]}"#),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diagnostics = github
            .workflow_run_diagnostics(
                Path::new("."),
                &WorkflowRunDiagnosticsRequest {
                    run_id: 100,
                    attempt: None,
                    job_limit: 10,
                    include_failed_log: false,
                    include_artifacts: false,
                },
            )
            .await
            .expect("diagnostics");

        assert!(diagnostics.failed_log.is_none());
        assert!(diagnostics.artifacts.is_empty());
        assert_eq!(runner.requests().len(), 3);
    }
}
