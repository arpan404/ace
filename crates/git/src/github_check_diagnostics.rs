use crate::{GithubCheckRun, GithubCheckRunAnnotation, GithubCliClient, ProcessRunner, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn check_run_diagnostics(
        &self,
        cwd: &Path,
        request: &CheckRunDiagnosticsRequest,
    ) -> Result<GithubCheckRunDiagnostics> {
        let check_run = self.check_run(cwd, request.check_run_id).await?;
        let annotations = self
            .list_check_run_annotations(cwd, request.check_run_id, request.annotation_limit)
            .await?;
        Ok(GithubCheckRunDiagnostics {
            check_run,
            annotations,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckRunDiagnosticsRequest {
    pub check_run_id: u64,
    pub annotation_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckRunDiagnostics {
    pub check_run: GithubCheckRun,
    pub annotations: Vec<GithubCheckRunAnnotation>,
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
    async fn check_run_diagnostics_fetches_run_and_annotations() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(repo_json()),
            ok(
                br#"{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":"ci-10","url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":"compile failed","annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]}"#,
            ),
            ok(repo_json()),
            ok(
                br#"[{"path":"src/lib.rs","start_line":10,"end_line":10,"start_column":null,"end_column":null,"annotation_level":"failure","message":"expected value","title":"clippy","raw_details":"details","blob_href":"https://github.test/blob/src/lib.rs#L10"}]"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diagnostics = github
            .check_run_diagnostics(
                Path::new("."),
                &CheckRunDiagnosticsRequest {
                    check_run_id: 10,
                    annotation_limit: 30,
                },
            )
            .await
            .expect("diagnostics");

        assert_eq!(diagnostics.check_run.name, "build");
        assert_eq!(diagnostics.check_run.conclusion.as_deref(), Some("failure"));
        assert_eq!(diagnostics.annotations[0].path, "src/lib.rs");
        assert_eq!(diagnostics.annotations[0].message, "expected value");
        let requests = runner.requests();
        assert_eq!(requests[1].args, vec!["api", "repos/ace/app/check-runs/10"]);
        assert_eq!(
            requests[3].args,
            vec![
                "api",
                "repos/ace/app/check-runs/10/annotations",
                "-F",
                "per_page=30"
            ]
        );
    }
}
