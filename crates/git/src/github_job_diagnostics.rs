use crate::{GithubCliClient, GithubWorkflowJobDetail, ProcessRunner, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn workflow_job_diagnostics(
        &self,
        cwd: &Path,
        request: &WorkflowJobDiagnosticsRequest,
    ) -> Result<GithubWorkflowJobDiagnostics> {
        let job = self.workflow_job(cwd, request.job_id).await?;
        let log = if request.include_log {
            Some(self.workflow_job_log(cwd, request.job_id).await?)
        } else {
            None
        };

        Ok(GithubWorkflowJobDiagnostics { job, log })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowJobDiagnosticsRequest {
    pub job_id: u64,
    pub include_log: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubWorkflowJobDiagnostics {
    pub job: GithubWorkflowJobDetail,
    pub log: Option<String>,
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

    fn job_json() -> &'static [u8] {
        br#"{"id":200,"run_id":100,"run_url":"https://api.github.test/runs/100","run_attempt":2,"node_id":"J_1","head_sha":"abc","url":"https://api.github.test/jobs/200","html_url":"https://github.test/jobs/200","status":"completed","conclusion":"failure","created_at":"2026-06-21T00:00:00Z","started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z","name":"test","workflow_name":"CI","head_branch":"feature/x","labels":["ubuntu-latest"],"runner_id":1,"runner_name":"GitHub Actions 1","runner_group_id":2,"runner_group_name":"Default","steps":[{"name":"cargo test","status":"completed","conclusion":"failure","number":3,"started_at":"2026-06-21T00:01:00Z","completed_at":"2026-06-21T00:02:00Z"}]}"#
    }

    #[tokio::test]
    async fn workflow_job_diagnostics_fetches_job_and_log() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(repo_json()),
            ok(job_json()),
            ok(repo_json()),
            ok("cargo test failed\n"),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diagnostics = github
            .workflow_job_diagnostics(
                Path::new("."),
                &WorkflowJobDiagnosticsRequest {
                    job_id: 200,
                    include_log: true,
                },
            )
            .await
            .expect("diagnostics");

        assert_eq!(diagnostics.job.job.name, "test");
        assert_eq!(diagnostics.job.job.conclusion.as_deref(), Some("failure"));
        assert_eq!(diagnostics.log.as_deref(), Some("cargo test failed"));
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
    async fn workflow_job_diagnostics_can_skip_log() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok(repo_json()), ok(job_json())]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diagnostics = github
            .workflow_job_diagnostics(
                Path::new("."),
                &WorkflowJobDiagnosticsRequest {
                    job_id: 200,
                    include_log: false,
                },
            )
            .await
            .expect("diagnostics");

        assert_eq!(diagnostics.job.job.name, "test");
        assert_eq!(diagnostics.log, None);
        assert_eq!(runner.requests().len(), 2);
    }
}
