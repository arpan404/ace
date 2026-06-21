use crate::{GithubCliClient, ProcessRunner, Result, parse_json};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn list_check_runs(
        &self,
        cwd: &Path,
        git_ref: &str,
        filter: &CheckRunListFilter,
    ) -> Result<Vec<GithubCheckRun>> {
        let repository = self.repository(cwd).await?;
        let mut args = vec![
            "api".to_string(),
            format!(
                "repos/{}/commits/{git_ref}/check-runs",
                repository.name_with_owner
            ),
            "-F".to_string(),
            format!("per_page={}", filter.limit),
        ];
        if let Some(status) = &filter.status {
            args.extend(["-f".to_string(), format!("status={status}")]);
        }
        if let Some(check_name) = &filter.check_name {
            args.extend(["-f".to_string(), format!("check_name={check_name}")]);
        }
        if let Some(filter_value) = &filter.filter {
            args.extend(["-f".to_string(), format!("filter={filter_value}")]);
        }
        if let Some(app_id) = filter.app_id {
            args.extend(["-F".to_string(), format!("app_id={app_id}")]);
        }

        let output = self.gh_allow_statuses(cwd, args, &[0]).await?;
        let response = parse_json::<GithubCheckRunsResponse>("github check runs", &output.stdout)?;
        Ok(response.check_runs)
    }

    pub async fn list_check_run_annotations(
        &self,
        cwd: &Path,
        check_run_id: u64,
        limit: u32,
    ) -> Result<Vec<GithubCheckRunAnnotation>> {
        let repository = self.repository(cwd).await?;
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "api".to_string(),
                    format!(
                        "repos/{}/check-runs/{check_run_id}/annotations",
                        repository.name_with_owner
                    ),
                    "-F".to_string(),
                    format!("per_page={limit}"),
                ],
                &[0],
            )
            .await?;
        parse_json("github check run annotations", &output.stdout)
    }

    pub async fn list_check_suites(
        &self,
        cwd: &Path,
        git_ref: &str,
        filter: &CheckRunListFilter,
    ) -> Result<Vec<GithubCheckSuite>> {
        let repository = self.repository(cwd).await?;
        let mut args = vec![
            "api".to_string(),
            format!(
                "repos/{}/commits/{git_ref}/check-suites",
                repository.name_with_owner
            ),
            "-F".to_string(),
            format!("per_page={}", filter.limit),
        ];
        if let Some(check_name) = &filter.check_name {
            args.extend(["-f".to_string(), format!("check_name={check_name}")]);
        }
        if let Some(app_id) = filter.app_id {
            args.extend(["-F".to_string(), format!("app_id={app_id}")]);
        }

        let output = self.gh_allow_statuses(cwd, args, &[0]).await?;
        let response =
            parse_json::<GithubCheckSuitesResponse>("github check suites", &output.stdout)?;
        Ok(response.check_suites)
    }

    pub async fn list_check_suite_runs(
        &self,
        cwd: &Path,
        check_suite_id: u64,
        filter: &CheckRunListFilter,
    ) -> Result<Vec<GithubCheckRun>> {
        let repository = self.repository(cwd).await?;
        let mut args = vec![
            "api".to_string(),
            format!(
                "repos/{}/check-suites/{check_suite_id}/check-runs",
                repository.name_with_owner
            ),
            "-F".to_string(),
            format!("per_page={}", filter.limit),
        ];
        if let Some(status) = &filter.status {
            args.extend(["-f".to_string(), format!("status={status}")]);
        }
        if let Some(check_name) = &filter.check_name {
            args.extend(["-f".to_string(), format!("check_name={check_name}")]);
        }
        if let Some(filter_value) = &filter.filter {
            args.extend(["-f".to_string(), format!("filter={filter_value}")]);
        }

        let output = self.gh_allow_statuses(cwd, args, &[0]).await?;
        let response =
            parse_json::<GithubCheckRunsResponse>("github check suite runs", &output.stdout)?;
        Ok(response.check_runs)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRunListFilter {
    pub limit: u32,
    pub status: Option<String>,
    pub check_name: Option<String>,
    pub filter: Option<String>,
    pub app_id: Option<u64>,
}

impl Default for CheckRunListFilter {
    fn default() -> Self {
        Self {
            limit: 50,
            status: None,
            check_name: None,
            filter: None,
            app_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct GithubCheckRunsResponse {
    #[serde(rename = "total_count")]
    pub total_count: u64,
    #[serde(default)]
    pub check_runs: Vec<GithubCheckRun>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct GithubCheckSuitesResponse {
    #[serde(rename = "total_count")]
    pub total_count: u64,
    #[serde(default)]
    pub check_suites: Vec<GithubCheckSuite>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckRun {
    pub id: u64,
    pub name: String,
    #[serde(rename = "node_id")]
    pub node_id: Option<String>,
    #[serde(rename = "head_sha")]
    pub head_sha: String,
    #[serde(rename = "external_id")]
    pub external_id: Option<String>,
    pub url: String,
    #[serde(rename = "html_url")]
    pub html_url: Option<String>,
    #[serde(rename = "details_url")]
    pub details_url: Option<String>,
    pub status: String,
    pub conclusion: Option<String>,
    #[serde(rename = "started_at")]
    pub started_at: Option<String>,
    #[serde(rename = "completed_at")]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub output: Option<GithubCheckRunOutput>,
    #[serde(default)]
    pub app: Option<GithubCheckRunApp>,
    #[serde(rename = "check_suite")]
    pub check_suite: Option<GithubCheckRunSuite>,
    #[serde(default)]
    pub pull_requests: Vec<GithubCheckRunPullRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckRunOutput {
    pub title: Option<String>,
    pub summary: Option<String>,
    pub text: Option<String>,
    #[serde(rename = "annotations_count")]
    pub annotations_count: Option<u64>,
    #[serde(rename = "annotations_url")]
    pub annotations_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckRunApp {
    pub id: u64,
    pub slug: Option<String>,
    pub name: String,
    #[serde(rename = "html_url")]
    pub html_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckRunSuite {
    pub id: u64,
    #[serde(rename = "head_branch")]
    pub head_branch: Option<String>,
    #[serde(rename = "head_sha")]
    pub head_sha: String,
    pub status: Option<String>,
    pub conclusion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckSuite {
    pub id: u64,
    #[serde(rename = "node_id")]
    pub node_id: Option<String>,
    #[serde(rename = "head_branch")]
    pub head_branch: Option<String>,
    #[serde(rename = "head_sha")]
    pub head_sha: String,
    pub status: Option<String>,
    pub conclusion: Option<String>,
    pub url: String,
    #[serde(rename = "before")]
    pub before_sha: Option<String>,
    #[serde(rename = "after")]
    pub after_sha: Option<String>,
    #[serde(rename = "pull_requests", default)]
    pub pull_requests: Vec<GithubCheckRunPullRequest>,
    #[serde(default)]
    pub app: Option<GithubCheckRunApp>,
    #[serde(rename = "created_at")]
    pub created_at: Option<String>,
    #[serde(rename = "updated_at")]
    pub updated_at: Option<String>,
    #[serde(rename = "latest_check_runs_count")]
    pub latest_check_runs_count: Option<u64>,
    #[serde(rename = "check_runs_url")]
    pub check_runs_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckRunPullRequest {
    pub url: String,
    pub id: u64,
    pub number: u64,
    #[serde(rename = "head")]
    pub head_ref: Option<GithubCheckRunPullRequestRef>,
    #[serde(rename = "base")]
    pub base_ref: Option<GithubCheckRunPullRequestRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckRunPullRequestRef {
    #[serde(rename = "ref")]
    pub ref_field: Option<String>,
    pub sha: Option<String>,
    pub repo: Option<GithubCheckRunPullRequestRepo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckRunPullRequestRepo {
    pub id: u64,
    pub url: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCheckRunAnnotation {
    pub path: String,
    #[serde(rename = "start_line")]
    pub start_line: u64,
    #[serde(rename = "end_line")]
    pub end_line: u64,
    #[serde(rename = "start_column")]
    pub start_column: Option<u64>,
    #[serde(rename = "end_column")]
    pub end_column: Option<u64>,
    #[serde(rename = "annotation_level")]
    pub annotation_level: String,
    pub message: String,
    pub title: Option<String>,
    #[serde(rename = "raw_details")]
    pub raw_details: Option<String>,
    #[serde(rename = "blob_href")]
    pub blob_href: Option<String>,
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

    fn ok(stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status: 0,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    #[tokio::test]
    async fn check_run_listing_resolves_repo_and_builds_api_request() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"success","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"ok","text":null,"annotations_count":0,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"success"},"pull_requests":[{"url":"https://api.github.test/pulls/42","id":42,"number":42,"head":{"ref":"feature/x","sha":"abc","repo":{"id":7,"url":"https://api.github.test/repos/ace/app","name":"app"}},"base":{"ref":"main","sha":"def","repo":{"id":7,"url":"https://api.github.test/repos/ace/app","name":"app"}}}]}]}"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let runs = github
            .list_check_runs(
                Path::new("."),
                "abc",
                &CheckRunListFilter {
                    limit: 25,
                    status: Some("completed".to_string()),
                    check_name: Some("build".to_string()),
                    filter: Some("latest".to_string()),
                    app_id: Some(1),
                },
            )
            .await
            .expect("check runs");

        assert_eq!(runs[0].name, "build");
        assert_eq!(runs[0].conclusion.as_deref(), Some("success"));
        assert_eq!(runs[0].pull_requests[0].number, 42);
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
    async fn check_run_annotations_resolve_repo_and_parse_annotations() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"[{"path":"src/lib.rs","start_line":10,"end_line":10,"start_column":null,"end_column":null,"annotation_level":"failure","message":"expected value","title":"clippy","raw_details":"details","blob_href":"https://github.test/blob/src/lib.rs#L10"}]"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let annotations = github
            .list_check_run_annotations(Path::new("."), 10, 30)
            .await
            .expect("annotations");

        assert_eq!(annotations[0].path, "src/lib.rs");
        assert_eq!(annotations[0].annotation_level, "failure");
        assert_eq!(annotations[0].message, "expected value");
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
    async fn check_suite_listing_resolves_repo_and_builds_api_request() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"total_count":1,"check_suites":[{"id":5,"node_id":"CS_1","head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"success","url":"https://api.github.test/check-suites/5","before":"def","after":"abc","pull_requests":[],"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","latest_check_runs_count":3,"check_runs_url":"https://api.github.test/check-suites/5/check-runs"}]}"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let suites = github
            .list_check_suites(
                Path::new("."),
                "abc",
                &CheckRunListFilter {
                    limit: 25,
                    check_name: Some("build".to_string()),
                    app_id: Some(1),
                    ..CheckRunListFilter::default()
                },
            )
            .await
            .expect("check suites");

        assert_eq!(suites[0].id, 5);
        assert_eq!(suites[0].latest_check_runs_count, Some(3));
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
    async fn check_suite_run_listing_resolves_repo_and_builds_api_request() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"total_count":1,"check_runs":[{"id":10,"name":"build","node_id":"CR_1","head_sha":"abc","external_id":null,"url":"https://api.github.test/check-runs/10","html_url":"https://github.test/checks/10","details_url":"https://ci.test/build/10","status":"completed","conclusion":"failure","started_at":"2026-06-21T00:00:00Z","completed_at":"2026-06-21T00:01:00Z","output":{"title":"Build","summary":"failed","text":null,"annotations_count":2,"annotations_url":"https://api.github.test/annotations"},"app":{"id":1,"slug":"github-actions","name":"GitHub Actions","html_url":"https://github.com/apps/github-actions"},"check_suite":{"id":5,"head_branch":"feature/x","head_sha":"abc","status":"completed","conclusion":"failure"},"pull_requests":[]}]}"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let runs = github
            .list_check_suite_runs(
                Path::new("."),
                5,
                &CheckRunListFilter {
                    limit: 25,
                    status: Some("completed".to_string()),
                    check_name: Some("build".to_string()),
                    filter: Some("latest".to_string()),
                    ..CheckRunListFilter::default()
                },
            )
            .await
            .expect("suite runs");

        assert_eq!(runs[0].id, 10);
        assert_eq!(runs[0].conclusion.as_deref(), Some("failure"));
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
}
