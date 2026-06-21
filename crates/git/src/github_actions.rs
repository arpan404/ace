use crate::{GithubCliClient, ProcessRunner, Result, parse_json};
use serde::{Deserialize, Serialize};
use std::path::Path;

const PR_CHECK_FIELDS: &str =
    "bucket,completedAt,description,event,link,name,startedAt,state,workflow";
const RUN_FIELDS: &str = "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName";
const RUN_DETAIL_FIELDS: &str = "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName";

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn pull_request_checks(
        &self,
        cwd: &Path,
        selector: Option<&str>,
        required_only: bool,
    ) -> Result<GithubPrChecks> {
        let mut args = vec!["pr".to_string(), "checks".to_string()];
        if let Some(selector) = selector {
            args.push(selector.to_string());
        }
        if required_only {
            args.push("--required".to_string());
        }
        args.extend(["--json".to_string(), PR_CHECK_FIELDS.to_string()]);

        let output = self.gh_allow_statuses(cwd, args, &[0, 8]).await?;
        let checks =
            parse_json::<Vec<GithubPrCheck>>("github pull request checks", &output.stdout)?;
        Ok(GithubPrChecks {
            summary: GithubCheckSummary::from_checks(&checks),
            checks,
        })
    }

    pub async fn list_workflow_runs(
        &self,
        cwd: &Path,
        filter: &WorkflowRunListFilter,
    ) -> Result<Vec<GithubWorkflowRun>> {
        let mut args = vec![
            "run".to_string(),
            "list".to_string(),
            "--limit".to_string(),
            filter.limit.to_string(),
            "--json".to_string(),
            RUN_FIELDS.to_string(),
        ];
        if filter.include_disabled {
            args.push("--all".to_string());
        }
        if let Some(branch) = &filter.branch {
            args.extend(["--branch".to_string(), branch.clone()]);
        }
        if let Some(commit) = &filter.commit {
            args.extend(["--commit".to_string(), commit.clone()]);
        }
        if let Some(status) = &filter.status {
            args.extend(["--status".to_string(), status.clone()]);
        }
        if let Some(workflow) = &filter.workflow {
            args.extend(["--workflow".to_string(), workflow.clone()]);
        }
        if let Some(event) = &filter.event {
            args.extend(["--event".to_string(), event.clone()]);
        }
        if let Some(user) = &filter.user {
            args.extend(["--user".to_string(), user.clone()]);
        }

        let output = self.gh_allow_statuses(cwd, args, &[0]).await?;
        parse_json("github workflow runs", &output.stdout)
    }

    pub async fn workflow_run(
        &self,
        cwd: &Path,
        run_id: u64,
        attempt: Option<u32>,
    ) -> Result<GithubWorkflowRunDetail> {
        let mut args = vec![
            "run".to_string(),
            "view".to_string(),
            run_id.to_string(),
            "--json".to_string(),
            RUN_DETAIL_FIELDS.to_string(),
        ];
        if let Some(attempt) = attempt {
            args.extend(["--attempt".to_string(), attempt.to_string()]);
        }
        let output = self.gh_allow_statuses(cwd, args, &[0]).await?;
        parse_json("github workflow run", &output.stdout)
    }

    pub async fn workflow_run_failed_log(&self, cwd: &Path, run_id: u64) -> Result<String> {
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "run".to_string(),
                    "view".to_string(),
                    run_id.to_string(),
                    "--log-failed".to_string(),
                ],
                &[0],
            )
            .await?;
        Ok(output.stdout_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPrChecks {
    pub checks: Vec<GithubPrCheck>,
    pub summary: GithubCheckSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPrCheck {
    pub bucket: String,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<String>,
    pub description: Option<String>,
    pub event: Option<String>,
    pub link: Option<String>,
    pub name: String,
    #[serde(rename = "startedAt")]
    pub started_at: Option<String>,
    pub state: String,
    pub workflow: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GithubCheckSummary {
    pub passed: usize,
    pub failed: usize,
    pub pending: usize,
    pub skipped: usize,
    pub cancelled: usize,
    pub total: usize,
}

impl GithubCheckSummary {
    #[must_use]
    pub fn from_checks(checks: &[GithubPrCheck]) -> Self {
        let mut summary = Self {
            total: checks.len(),
            ..Self::default()
        };
        for check in checks {
            match check.bucket.as_str() {
                "pass" => summary.passed += 1,
                "fail" => summary.failed += 1,
                "pending" => summary.pending += 1,
                "skipping" => summary.skipped += 1,
                "cancel" => summary.cancelled += 1,
                _ => {}
            }
        }
        summary
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunListFilter {
    pub limit: u32,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub status: Option<String>,
    pub workflow: Option<String>,
    pub event: Option<String>,
    pub user: Option<String>,
    pub include_disabled: bool,
}

impl Default for WorkflowRunListFilter {
    fn default() -> Self {
        Self {
            limit: 20,
            branch: None,
            commit: None,
            status: None,
            workflow: None,
            event: None,
            user: None,
            include_disabled: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubWorkflowRun {
    pub attempt: u32,
    pub conclusion: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "databaseId")]
    pub database_id: u64,
    #[serde(rename = "displayTitle")]
    pub display_title: String,
    pub event: String,
    #[serde(rename = "headBranch")]
    pub head_branch: Option<String>,
    #[serde(rename = "headSha")]
    pub head_sha: String,
    pub name: Option<String>,
    pub number: u64,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub status: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub url: String,
    #[serde(rename = "workflowDatabaseId")]
    pub workflow_database_id: Option<u64>,
    #[serde(rename = "workflowName")]
    pub workflow_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubWorkflowRunDetail {
    #[serde(flatten)]
    pub run: GithubWorkflowRun,
    #[serde(default)]
    pub jobs: Vec<GithubWorkflowJob>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubWorkflowJob {
    #[serde(rename = "databaseId")]
    pub database_id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: Option<String>,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub steps: Vec<GithubWorkflowStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubWorkflowStep {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub number: Option<u32>,
    #[serde(rename = "startedAt")]
    pub started_at: Option<String>,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, CommandRequest, GitToolError, ProcessRunner};
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
    impl ProcessRunner for FakeRunner {
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

    fn output(status: i32, stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    #[tokio::test]
    async fn pull_request_checks_accepts_pending_exit_status() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![output(
            8,
            br#"[
              {"bucket":"pass","completedAt":"2026-06-21T00:00:00Z","description":null,"event":"push","link":"https://example.test/1","name":"fmt","startedAt":"2026-06-21T00:00:00Z","state":"SUCCESS","workflow":"CI"},
              {"bucket":"pending","completedAt":null,"description":null,"event":"push","link":"https://example.test/2","name":"test","startedAt":"2026-06-21T00:00:00Z","state":"PENDING","workflow":"CI"}
            ]"#,
        )]));
        let github = GithubCliClient::with_runner(runner.clone());
        let checks = github
            .pull_request_checks(Path::new("."), Some("12"), true)
            .await
            .expect("checks");

        assert_eq!(checks.summary.total, 2);
        assert_eq!(checks.summary.passed, 1);
        assert_eq!(checks.summary.pending, 1);
        let requests = runner.requests();
        assert_eq!(
            requests[0].args,
            vec![
                "pr",
                "checks",
                "12",
                "--required",
                "--json",
                PR_CHECK_FIELDS
            ]
        );
    }

    #[tokio::test]
    async fn workflow_run_list_builds_filtered_command_and_parses_runs() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![output(
            0,
            br#"[
              {"attempt":1,"conclusion":"success","createdAt":"2026-06-21T00:00:00Z","databaseId":100,"displayTitle":"Update","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":7,"startedAt":"2026-06-21T00:01:00Z","status":"completed","updatedAt":"2026-06-21T00:02:00Z","url":"https://example.test/runs/100","workflowDatabaseId":5,"workflowName":"CI"}
            ]"#,
        )]));
        let github = GithubCliClient::with_runner(runner.clone());
        let runs = github
            .list_workflow_runs(
                Path::new("."),
                &WorkflowRunListFilter {
                    limit: 10,
                    branch: Some("feature/x".to_string()),
                    status: Some("completed".to_string()),
                    workflow: Some("CI".to_string()),
                    include_disabled: true,
                    ..WorkflowRunListFilter::default()
                },
            )
            .await
            .expect("runs");

        assert_eq!(runs[0].database_id, 100);
        assert_eq!(runs[0].workflow_name.as_deref(), Some("CI"));
        let args = &runner.requests()[0].args;
        assert!(args.contains(&"--all".to_string()));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--branch", "feature/x"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--status", "completed"])
        );
        assert!(args.windows(2).any(|pair| pair == ["--workflow", "CI"]));
    }

    #[tokio::test]
    async fn workflow_run_detail_parses_jobs_and_steps() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![output(
            0,
            br#"{
              "attempt":2,
              "conclusion":"failure",
              "createdAt":"2026-06-21T00:00:00Z",
              "databaseId":100,
              "displayTitle":"Update",
              "event":"pull_request",
              "headBranch":"feature/x",
              "headSha":"abc",
              "jobs":[{"databaseId":200,"name":"test","status":"completed","conclusion":"failure","startedAt":"2026-06-21T00:01:00Z","completedAt":"2026-06-21T00:02:00Z","url":"https://example.test/jobs/200","steps":[{"name":"cargo test","status":"completed","conclusion":"failure","number":3,"startedAt":"2026-06-21T00:01:00Z","completedAt":"2026-06-21T00:02:00Z"}]}],
              "name":"CI",
              "number":7,
              "startedAt":"2026-06-21T00:01:00Z",
              "status":"completed",
              "updatedAt":"2026-06-21T00:02:00Z",
              "url":"https://example.test/runs/100",
              "workflowDatabaseId":5,
              "workflowName":"CI"
            }"#,
        )]));
        let github = GithubCliClient::with_runner(runner);
        let detail = github
            .workflow_run(Path::new("."), 100, Some(2))
            .await
            .expect("detail");

        assert_eq!(detail.run.database_id, 100);
        assert_eq!(detail.jobs[0].steps[0].name, "cargo test");
        assert_eq!(
            detail.jobs[0].steps[0].conclusion.as_deref(),
            Some("failure")
        );
    }

    #[tokio::test]
    async fn workflow_failed_log_returns_text() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![output(0, "job\tstep\tfailure\n")]));
        let github = GithubCliClient::with_runner(runner);
        let log = github
            .workflow_run_failed_log(Path::new("."), 100)
            .await
            .expect("log");
        assert_eq!(log, "job\tstep\tfailure");
    }
}
