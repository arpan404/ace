use crate::{GithubCliClient, ProcessRunner, Result, parse_json, validate_branch_name};
use serde::{Deserialize, Serialize};
use std::path::Path;

const ISSUE_THREAD_FIELDS: &str =
    "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt,comments";
const PULL_REQUEST_DETAIL_FIELDS: &str = "number,title,state,url,headRefName,headRefOid,baseRefName,body,author,createdAt,updatedAt,isDraft,reviewDecision,mergeStateStatus";
const PULL_REQUEST_THREAD_FIELDS: &str = "number,title,state,url,headRefName,headRefOid,baseRefName,body,author,createdAt,updatedAt,isDraft,reviewDecision,mergeStateStatus,comments,reviews,latestReviews";
const PULL_REQUEST_COMMITS_FIELDS: &str = "commits";

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn repository(&self, cwd: &Path) -> Result<GithubRepository> {
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "repo",
                    "view",
                    "--json",
                    "nameWithOwner,defaultBranchRef,url,sshUrl",
                ],
                &[0],
            )
            .await?;
        parse_json("github repository", &output.stdout)
    }

    pub async fn list_issues(&self, cwd: &Path, limit: u32) -> Result<Vec<GithubIssue>> {
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "issue",
                    "list",
                    "--limit",
                    &limit.to_string(),
                    "--json",
                    "number,title,state,url,author,labels",
                ],
                &[0],
            )
            .await?;
        parse_json("github issues", &output.stdout)
    }

    pub async fn issue_thread(&self, cwd: &Path, number: u32) -> Result<GithubIssueThread> {
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "issue",
                    "view",
                    &number.to_string(),
                    "--json",
                    ISSUE_THREAD_FIELDS,
                ],
                &[0],
            )
            .await?;
        parse_json("github issue thread", &output.stdout)
    }

    pub async fn pull_request(&self, cwd: &Path, selector: &str) -> Result<GithubPullRequest> {
        let output = self
            .gh_allow_statuses(
                cwd,
                ["pr", "view", selector, "--json", PULL_REQUEST_DETAIL_FIELDS],
                &[0],
            )
            .await?;
        parse_json("github pull request", &output.stdout)
    }

    pub async fn pull_request_thread(
        &self,
        cwd: &Path,
        selector: &str,
    ) -> Result<GithubPullRequestThread> {
        let output = self
            .gh_allow_statuses(
                cwd,
                ["pr", "view", selector, "--json", PULL_REQUEST_THREAD_FIELDS],
                &[0],
            )
            .await?;
        parse_json("github pull request thread", &output.stdout)
    }

    pub async fn pull_request_commits(
        &self,
        cwd: &Path,
        selector: &str,
    ) -> Result<Vec<GithubPullRequestCommit>> {
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "pr",
                    "view",
                    selector,
                    "--json",
                    PULL_REQUEST_COMMITS_FIELDS,
                ],
                &[0],
            )
            .await?;
        let response = parse_json::<GithubPullRequestCommitsResponse>(
            "github pull request commits",
            &output.stdout,
        )?;
        Ok(response.commits)
    }

    pub async fn create_pull_request(
        &self,
        cwd: &Path,
        request: &CreatePullRequest,
    ) -> Result<GithubPullRequest> {
        validate_branch_name(&request.head)?;
        validate_branch_name(&request.base)?;
        let mut args = vec![
            "pr".to_string(),
            "create".to_string(),
            "--title".to_string(),
            request.title.clone(),
            "--body".to_string(),
            request.body.clone(),
            "--head".to_string(),
            request.head.clone(),
            "--base".to_string(),
            request.base.clone(),
        ];
        if request.draft {
            args.push("--draft".to_string());
        }
        let output = self.gh_allow_statuses(cwd, args, &[0]).await?;
        let url = output.stdout_string();
        Ok(GithubPullRequest {
            number: parse_pr_number(&url),
            title: request.title.clone(),
            state: "OPEN".to_string(),
            url,
            head_ref_name: request.head.clone(),
            head_ref_oid: None,
            base_ref_name: request.base.clone(),
            body: Some(request.body.clone()),
            author: None,
            created_at: None,
            updated_at: None,
            is_draft: Some(request.draft),
            review_decision: None,
            merge_state_status: None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubRepository {
    #[serde(rename = "nameWithOwner")]
    pub name_with_owner: String,
    #[serde(rename = "defaultBranchRef")]
    pub default_branch_ref: GithubBranchRef,
    pub url: String,
    #[serde(rename = "sshUrl")]
    pub ssh_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubBranchRef {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubIssue {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub url: String,
    pub author: Option<GithubUser>,
    #[serde(default)]
    pub labels: Vec<GithubLabel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubIssueThread {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub url: String,
    pub body: Option<String>,
    #[serde(default)]
    pub labels: Vec<GithubLabel>,
    #[serde(default)]
    pub assignees: Vec<GithubUser>,
    pub author: Option<GithubUser>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(default)]
    pub comments: Vec<GithubComment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequest {
    pub number: Option<u32>,
    pub title: String,
    pub state: String,
    pub url: String,
    #[serde(rename = "headRefName")]
    pub head_ref_name: String,
    #[serde(rename = "headRefOid")]
    pub head_ref_oid: Option<String>,
    #[serde(rename = "baseRefName")]
    pub base_ref_name: String,
    pub body: Option<String>,
    pub author: Option<GithubUser>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
    #[serde(rename = "isDraft")]
    pub is_draft: Option<bool>,
    #[serde(rename = "reviewDecision")]
    pub review_decision: Option<String>,
    #[serde(rename = "mergeStateStatus")]
    pub merge_state_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestThread {
    #[serde(flatten)]
    pub pull_request: GithubPullRequest,
    #[serde(default)]
    pub comments: Vec<GithubComment>,
    #[serde(default)]
    pub reviews: Vec<GithubPullRequestReview>,
    #[serde(rename = "latestReviews", default)]
    pub latest_reviews: Vec<GithubPullRequestReview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubUser {
    pub login: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubLabel {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubComment {
    pub body: Option<String>,
    pub author: Option<GithubUser>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestReview {
    pub id: Option<String>,
    pub author: Option<GithubUser>,
    #[serde(rename = "authorAssociation")]
    pub author_association: Option<String>,
    pub body: Option<String>,
    pub state: String,
    #[serde(rename = "submittedAt")]
    pub submitted_at: Option<String>,
    #[serde(rename = "commit")]
    pub commit: Option<GithubCommitRef>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCommitRef {
    pub oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct GithubPullRequestCommitsResponse {
    #[serde(default)]
    commits: Vec<GithubPullRequestCommit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestCommit {
    pub oid: String,
    #[serde(rename = "messageHeadline")]
    pub message_headline: String,
    #[serde(rename = "messageBody")]
    pub message_body: Option<String>,
    #[serde(rename = "authoredDate")]
    pub authored_date: Option<String>,
    #[serde(rename = "committedDate")]
    pub committed_date: String,
    #[serde(default)]
    pub authors: Vec<GithubCommitAuthor>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubCommitAuthor {
    pub name: Option<String>,
    pub email: Option<String>,
    pub login: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatePullRequest {
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
}

fn parse_pr_number(url: &str) -> Option<u32> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|value| value.parse().ok())
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
    async fn pull_request_commits_builds_command_and_parses_commits() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok(
            br#"{"commits":[{"oid":"abc","messageHeadline":"Add feature","messageBody":"body","authoredDate":"2026-06-21T00:00:00Z","committedDate":"2026-06-21T00:01:00Z","authors":[{"name":"Octo","email":"octo@example.test","login":"octo"}],"url":"https://github.test/commit/abc"}]}"#,
        )]));
        let github = GithubCliClient::with_runner(runner.clone());

        let commits = github
            .pull_request_commits(Path::new("."), "42")
            .await
            .expect("commits");

        assert_eq!(commits[0].oid, "abc");
        assert_eq!(commits[0].message_headline, "Add feature");
        assert_eq!(commits[0].authors[0].login.as_deref(), Some("octo"));
        assert_eq!(
            runner.requests()[0].args,
            vec!["pr", "view", "42", "--json", "commits"]
        );
    }
}
