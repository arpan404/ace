use crate::{
    GithubCliClient, GithubPrChecks, GithubPullRequestListFilter, GithubPullRequestSummary,
    GithubWorkflowRun, ProcessRunner, Result, WorkflowRunListFilter,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn pull_request_dashboard(
        &self,
        cwd: &Path,
        request: &PullRequestDashboardRequest,
    ) -> Result<GithubPullRequestDashboard> {
        let pull_requests = self.list_pull_requests(cwd, &request.filter).await?;
        let mut items = Vec::with_capacity(pull_requests.len());
        for pull_request in pull_requests {
            let selector = pull_request.number.to_string();
            let checks = self
                .pull_request_checks(cwd, Some(&selector), request.required_checks_only)
                .await?;
            let workflow_runs = if request.workflow_run_limit_per_pr == 0 {
                Vec::new()
            } else {
                self.list_workflow_runs(
                    cwd,
                    &WorkflowRunListFilter {
                        limit: request.workflow_run_limit_per_pr,
                        branch: Some(pull_request.head_ref_name.clone()),
                        commit: pull_request.head_ref_oid.clone(),
                        ..WorkflowRunListFilter::default()
                    },
                )
                .await?
            };

            items.push(GithubPullRequestDashboardItem {
                pull_request,
                checks,
                workflow_runs,
            });
        }

        Ok(GithubPullRequestDashboard { items })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestDashboardRequest {
    pub filter: GithubPullRequestListFilter,
    pub required_checks_only: bool,
    pub workflow_run_limit_per_pr: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestDashboard {
    pub items: Vec<GithubPullRequestDashboardItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestDashboardItem {
    pub pull_request: GithubPullRequestSummary,
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
    async fn dashboard_lists_prs_and_enriches_each_with_checks_and_runs() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
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
        let github = GithubCliClient::with_runner(runner.clone());

        let dashboard = github
            .pull_request_dashboard(
                Path::new("."),
                &PullRequestDashboardRequest {
                    filter: GithubPullRequestListFilter {
                        limit: 10,
                        ..GithubPullRequestListFilter::default()
                    },
                    required_checks_only: true,
                    workflow_run_limit_per_pr: 3,
                },
            )
            .await
            .expect("dashboard");

        assert_eq!(dashboard.items.len(), 1);
        assert_eq!(dashboard.items[0].pull_request.number, 42);
        assert_eq!(dashboard.items[0].checks.summary.pending, 1);
        assert_eq!(dashboard.items[0].workflow_runs[0].database_id, 7);

        let requests = runner.requests();
        assert_eq!(requests[0].args[0..2], ["pr", "list"]);
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
                .any(|pair| pair == ["--limit", "3"])
        );
    }

    #[tokio::test]
    async fn dashboard_can_skip_workflow_runs() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"[{"number":42,"title":"Feature","state":"OPEN","url":"https://example.test/pull/42","author":{"login":"octo"},"labels":[],"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","baseRefName":"main","headRefName":"feature/x","isDraft":false,"reviewDecision":null,"mergeStateStatus":null,"statusCheckRollup":[]}]"#,
            ),
            ok(
                br#"[{"bucket":"pass","completedAt":"2026-06-21T00:00:00Z","description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"SUCCESS","workflow":"CI"}]"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let dashboard = github
            .pull_request_dashboard(
                Path::new("."),
                &PullRequestDashboardRequest {
                    filter: GithubPullRequestListFilter::default(),
                    required_checks_only: false,
                    workflow_run_limit_per_pr: 0,
                },
            )
            .await
            .expect("dashboard");

        assert!(dashboard.items[0].workflow_runs.is_empty());
        assert_eq!(runner.requests().len(), 2);
    }
}
