use crate::{
    CommitCheckRollupRequest, GithubCheckRun, GithubCheckRunAnnotation, GithubCliClient,
    GithubCommitCheckRollup, ProcessRunner, Result,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn commit_check_diagnostics(
        &self,
        cwd: &Path,
        git_ref: &str,
        request: &CommitCheckDiagnosticsRequest,
    ) -> Result<GithubCommitCheckDiagnostics> {
        let rollup = self
            .commit_check_rollup(
                cwd,
                git_ref,
                &CommitCheckRollupRequest {
                    check_run_limit: request.check_run_limit,
                    status_limit: request.status_limit,
                },
            )
            .await?;

        let mut failed_check_annotations = Vec::new();
        for check_run in rollup
            .check_runs
            .iter()
            .filter(|check_run| check_run_is_failed(check_run))
            .take(request.failed_check_run_limit as usize)
        {
            let annotations = self
                .list_check_run_annotations(cwd, check_run.id, request.annotation_limit)
                .await?;
            failed_check_annotations.push(GithubFailedCheckRunAnnotations {
                check_run: check_run.clone(),
                annotations,
            });
        }

        Ok(GithubCommitCheckDiagnostics {
            rollup,
            failed_check_annotations,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitCheckDiagnosticsRequest {
    pub check_run_limit: u32,
    pub status_limit: u32,
    pub failed_check_run_limit: u32,
    pub annotation_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCommitCheckDiagnostics {
    pub rollup: GithubCommitCheckRollup,
    pub failed_check_annotations: Vec<GithubFailedCheckRunAnnotations>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubFailedCheckRunAnnotations {
    pub check_run: GithubCheckRun,
    pub annotations: Vec<GithubCheckRunAnnotation>,
}

fn check_run_is_failed(check_run: &GithubCheckRun) -> bool {
    matches!(
        check_run.conclusion.as_deref(),
        Some("failure" | "timed_out" | "cancelled" | "action_required")
    )
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
    async fn commit_check_diagnostics_fetches_failed_check_annotations() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(repo_json()),
            ok(
                br#"{"total_count":2,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":null,"annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]},{"id":11,"name":"test","node_id":"CR_2","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/11","html_url":"https://github.test/checks/11","details_url":"https://ci.test/test/11","status":"completed","conclusion":"success","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Test","summary":"ok","text":null,"annotations_count":0,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"success"},"pull_requests":[]}]}"#,
            ),
            ok(repo_json()),
            ok(
                br#"[{"id":99,"node_id":"ST_1","state":"failure","description":"lint failed","target_url":"https://ci.test/lint","context":"lint","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","url":"https://api.github.test/statuses/99","avatar_url":"https://avatars.githubusercontent.com/u/1"}]"#,
            ),
            ok(repo_json()),
            ok(
                br#"[{"path":"src/lib.rs","start_line":10,"end_line":10,"start_column":null,"end_column":null,"annotation_level":"failure","message":"expected value","title":"clippy","raw_details":"details","blob_href":"https://github.test/blob/src/lib.rs#L10"}]"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diagnostics = github
            .commit_check_diagnostics(
                Path::new("."),
                "abc",
                &CommitCheckDiagnosticsRequest {
                    check_run_limit: 25,
                    status_limit: 10,
                    failed_check_run_limit: 2,
                    annotation_limit: 30,
                },
            )
            .await
            .expect("diagnostics");

        assert_eq!(diagnostics.rollup.summary.failed, 2);
        assert_eq!(diagnostics.failed_check_annotations.len(), 1);
        assert_eq!(diagnostics.failed_check_annotations[0].check_run.id, 10);
        assert_eq!(
            diagnostics.failed_check_annotations[0].annotations[0].message,
            "expected value"
        );

        let requests = runner.requests();
        assert_eq!(
            requests[1].args,
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
            requests[5].args,
            vec![
                "api",
                "repos/ace/app/check-runs/10/annotations",
                "-F",
                "per_page=30"
            ]
        );
    }

    #[tokio::test]
    async fn commit_check_diagnostics_respects_failed_check_limit() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(repo_json()),
            ok(
                br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":null,"annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]}]}"#,
            ),
            ok(repo_json()),
            ok(br#"[]"#),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diagnostics = github
            .commit_check_diagnostics(
                Path::new("."),
                "abc",
                &CommitCheckDiagnosticsRequest {
                    check_run_limit: 25,
                    status_limit: 10,
                    failed_check_run_limit: 0,
                    annotation_limit: 30,
                },
            )
            .await
            .expect("diagnostics");

        assert!(diagnostics.failed_check_annotations.is_empty());
        assert_eq!(runner.requests().len(), 4);
    }
}
