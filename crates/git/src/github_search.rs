use crate::{GithubCliClient, GithubLabel, GithubUser, ProcessRunner, Result, parse_json};
use serde::{Deserialize, Serialize};
use std::path::Path;

const ISSUE_LIST_FIELDS: &str = "number,title,state,url,author,labels,createdAt,updatedAt,comments";
const PR_LIST_FIELDS: &str = "number,title,state,url,author,labels,createdAt,updatedAt,baseRefName,headRefName,headRefOid,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup";
const SEARCH_ISSUE_FIELDS: &str = "assignees,author,authorAssociation,body,closedAt,commentsCount,createdAt,id,isLocked,isPullRequest,labels,number,repository,state,title,updatedAt,url";
const SEARCH_PR_FIELDS: &str = "assignees,author,authorAssociation,body,closedAt,commentsCount,createdAt,id,isDraft,isLocked,isPullRequest,labels,number,repository,state,title,updatedAt,url";

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn list_issues_filtered(
        &self,
        cwd: &Path,
        filter: &GithubIssueListFilter,
    ) -> Result<Vec<GithubIssueSummary>> {
        let mut args = vec![
            "issue".to_string(),
            "list".to_string(),
            "--limit".to_string(),
            filter.limit.to_string(),
            "--state".to_string(),
            filter.state.clone(),
            "--json".to_string(),
            ISSUE_LIST_FIELDS.to_string(),
        ];
        if let Some(author) = &filter.author {
            args.extend(["--author".to_string(), author.clone()]);
        }
        if let Some(assignee) = &filter.assignee {
            args.extend(["--assignee".to_string(), assignee.clone()]);
        }
        if let Some(mention) = &filter.mention {
            args.extend(["--mention".to_string(), mention.clone()]);
        }
        if let Some(milestone) = &filter.milestone {
            args.extend(["--milestone".to_string(), milestone.clone()]);
        }
        if let Some(search) = &filter.search {
            args.extend(["--search".to_string(), search.clone()]);
        }
        for label in &filter.labels {
            args.extend(["--label".to_string(), label.clone()]);
        }

        let output = self.gh_allow_statuses(cwd, args, &[0]).await?;
        parse_json("github issue list", &output.stdout)
    }

    pub async fn list_pull_requests(
        &self,
        cwd: &Path,
        filter: &GithubPullRequestListFilter,
    ) -> Result<Vec<GithubPullRequestSummary>> {
        let mut args = vec![
            "pr".to_string(),
            "list".to_string(),
            "--limit".to_string(),
            filter.limit.to_string(),
            "--state".to_string(),
            filter.state.clone(),
            "--json".to_string(),
            PR_LIST_FIELDS.to_string(),
        ];
        if let Some(author) = &filter.author {
            args.extend(["--author".to_string(), author.clone()]);
        }
        if let Some(assignee) = &filter.assignee {
            args.extend(["--assignee".to_string(), assignee.clone()]);
        }
        if let Some(base) = &filter.base {
            args.extend(["--base".to_string(), base.clone()]);
        }
        if let Some(head) = &filter.head {
            args.extend(["--head".to_string(), head.clone()]);
        }
        if let Some(search) = &filter.search {
            args.extend(["--search".to_string(), search.clone()]);
        }
        if filter.draft_only {
            args.push("--draft".to_string());
        }
        for label in &filter.labels {
            args.extend(["--label".to_string(), label.clone()]);
        }

        let output = self.gh_allow_statuses(cwd, args, &[0]).await?;
        parse_json("github pull request list", &output.stdout)
    }

    pub async fn search_issues(
        &self,
        cwd: &Path,
        query: &str,
        filter: &GithubSearchFilter,
    ) -> Result<Vec<GithubSearchIssue>> {
        let output = self
            .gh_allow_statuses(
                cwd,
                search_args("issues", query, SEARCH_ISSUE_FIELDS, filter, false),
                &[0],
            )
            .await?;
        parse_json("github issue search", &output.stdout)
    }

    pub async fn search_pull_requests(
        &self,
        cwd: &Path,
        query: &str,
        filter: &GithubSearchFilter,
    ) -> Result<Vec<GithubSearchPullRequest>> {
        let output = self
            .gh_allow_statuses(
                cwd,
                search_args("prs", query, SEARCH_PR_FIELDS, filter, true),
                &[0],
            )
            .await?;
        parse_json("github pull request search", &output.stdout)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubIssueListFilter {
    pub limit: u32,
    pub state: String,
    pub author: Option<String>,
    pub assignee: Option<String>,
    pub mention: Option<String>,
    pub milestone: Option<String>,
    pub search: Option<String>,
    pub labels: Vec<String>,
}

impl Default for GithubIssueListFilter {
    fn default() -> Self {
        Self {
            limit: 30,
            state: "open".to_string(),
            author: None,
            assignee: None,
            mention: None,
            milestone: None,
            search: None,
            labels: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullRequestListFilter {
    pub limit: u32,
    pub state: String,
    pub author: Option<String>,
    pub assignee: Option<String>,
    pub base: Option<String>,
    pub head: Option<String>,
    pub search: Option<String>,
    pub labels: Vec<String>,
    pub draft_only: bool,
}

impl Default for GithubPullRequestListFilter {
    fn default() -> Self {
        Self {
            limit: 30,
            state: "open".to_string(),
            author: None,
            assignee: None,
            base: None,
            head: None,
            search: None,
            labels: Vec::new(),
            draft_only: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubSearchFilter {
    pub limit: u32,
    pub state: Option<String>,
    pub author: Option<String>,
    pub assignee: Option<String>,
    pub owner: Vec<String>,
    pub repo: Vec<String>,
    pub labels: Vec<String>,
    pub sort: Option<String>,
    pub order: Option<String>,
    pub include_prs_in_issue_search: bool,
}

impl Default for GithubSearchFilter {
    fn default() -> Self {
        Self {
            limit: 30,
            state: None,
            author: None,
            assignee: None,
            owner: Vec::new(),
            repo: Vec::new(),
            labels: Vec::new(),
            sort: None,
            order: None,
            include_prs_in_issue_search: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubIssueSummary {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub url: String,
    pub author: Option<GithubUser>,
    #[serde(default)]
    pub labels: Vec<GithubLabel>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub comments: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestSummary {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub url: String,
    pub author: Option<GithubUser>,
    #[serde(default)]
    pub labels: Vec<GithubLabel>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "baseRefName")]
    pub base_ref_name: String,
    #[serde(rename = "headRefName")]
    pub head_ref_name: String,
    #[serde(rename = "headRefOid")]
    pub head_ref_oid: Option<String>,
    #[serde(rename = "isDraft")]
    pub is_draft: bool,
    #[serde(rename = "reviewDecision")]
    pub review_decision: Option<String>,
    #[serde(rename = "mergeStateStatus")]
    pub merge_state_status: Option<String>,
    #[serde(rename = "statusCheckRollup")]
    pub status_check_rollup: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubSearchIssue {
    pub assignees: Vec<GithubUser>,
    pub author: Option<GithubUser>,
    #[serde(rename = "authorAssociation")]
    pub author_association: Option<String>,
    pub body: Option<String>,
    #[serde(rename = "closedAt")]
    pub closed_at: Option<String>,
    #[serde(rename = "commentsCount")]
    pub comments_count: u32,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub id: String,
    #[serde(rename = "isLocked")]
    pub is_locked: bool,
    #[serde(rename = "isPullRequest")]
    pub is_pull_request: bool,
    #[serde(default)]
    pub labels: Vec<GithubLabel>,
    pub number: u32,
    pub repository: GithubSearchRepository,
    pub state: String,
    pub title: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubSearchPullRequest {
    #[serde(flatten)]
    pub item: GithubSearchIssue,
    #[serde(rename = "isDraft")]
    pub is_draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubSearchRepository {
    #[serde(rename = "nameWithOwner")]
    pub name_with_owner: String,
    pub url: String,
}

fn search_args(
    kind: &str,
    query: &str,
    fields: &str,
    filter: &GithubSearchFilter,
    pull_request_search: bool,
) -> Vec<String> {
    let mut args = vec![
        "search".to_string(),
        kind.to_string(),
        query.to_string(),
        "--limit".to_string(),
        filter.limit.to_string(),
        "--json".to_string(),
        fields.to_string(),
    ];
    if let Some(state) = &filter.state {
        args.extend(["--state".to_string(), state.clone()]);
    }
    if let Some(author) = &filter.author {
        args.extend(["--author".to_string(), author.clone()]);
    }
    if let Some(assignee) = &filter.assignee {
        args.extend(["--assignee".to_string(), assignee.clone()]);
    }
    if let Some(sort) = &filter.sort {
        args.extend(["--sort".to_string(), sort.clone()]);
    }
    if let Some(order) = &filter.order {
        args.extend(["--order".to_string(), order.clone()]);
    }
    for owner in &filter.owner {
        args.extend(["--owner".to_string(), owner.clone()]);
    }
    for repo in &filter.repo {
        args.extend(["--repo".to_string(), repo.clone()]);
    }
    for label in &filter.labels {
        args.extend(["--label".to_string(), label.clone()]);
    }
    if filter.include_prs_in_issue_search && !pull_request_search {
        args.push("--include-prs".to_string());
    }
    args
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
    async fn issue_listing_builds_filter_command() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok(
            br#"[{"number":1,"title":"Bug","state":"OPEN","url":"https://example.test/issues/1","author":{"login":"octo"},"labels":[{"name":"bug"}],"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","comments":2}]"#,
        )]));
        let github = GithubCliClient::with_runner(runner.clone());
        let issues = github
            .list_issues_filtered(
                Path::new("."),
                &GithubIssueListFilter {
                    limit: 15,
                    state: "all".to_string(),
                    author: Some("@me".to_string()),
                    labels: vec!["bug".to_string(), "ui".to_string()],
                    search: Some("sort:created-desc".to_string()),
                    ..GithubIssueListFilter::default()
                },
            )
            .await
            .expect("issues");

        assert_eq!(issues[0].number, 1);
        let args = &runner.requests()[0].args;
        assert!(args.windows(2).any(|pair| pair == ["--state", "all"]));
        assert!(args.windows(2).any(|pair| pair == ["--author", "@me"]));
        assert!(args.windows(2).any(|pair| pair == ["--label", "bug"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--search", "sort:created-desc"])
        );
    }

    #[tokio::test]
    async fn pull_request_listing_parses_review_and_check_rollup() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok(
            br#"[{"number":9,"title":"Feature","state":"OPEN","url":"https://example.test/pull/9","author":{"login":"octo"},"labels":[],"createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","baseRefName":"main","headRefName":"feature/x","headRefOid":"abc","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"CI"}]}]"#,
        )]));
        let github = GithubCliClient::with_runner(runner.clone());
        let prs = github
            .list_pull_requests(
                Path::new("."),
                &GithubPullRequestListFilter {
                    head: Some("feature/x".to_string()),
                    draft_only: false,
                    ..GithubPullRequestListFilter::default()
                },
            )
            .await
            .expect("prs");

        assert_eq!(prs[0].head_ref_name, "feature/x");
        assert_eq!(prs[0].head_ref_oid.as_deref(), Some("abc"));
        assert_eq!(prs[0].review_decision.as_deref(), Some("REVIEW_REQUIRED"));
        assert_eq!(
            prs[0].status_check_rollup.as_ref().expect("rollup").len(),
            1
        );
        assert!(
            runner.requests()[0]
                .args
                .windows(2)
                .any(|pair| pair == ["--head", "feature/x"])
        );
    }

    #[tokio::test]
    async fn issue_search_supports_repo_owner_and_include_prs() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok(
            br#"[{"assignees":[],"author":{"login":"octo"},"authorAssociation":"MEMBER","body":"body","closedAt":null,"commentsCount":1,"createdAt":"2026-06-21T00:00:00Z","id":"I_1","isLocked":false,"isPullRequest":false,"labels":[{"name":"bug"}],"number":1,"repository":{"nameWithOwner":"ace/app","url":"https://example.test/ace/app"},"state":"open","title":"Bug","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/issues/1"}]"#,
        )]));
        let github = GithubCliClient::with_runner(runner.clone());
        let results = github
            .search_issues(
                Path::new("."),
                "render bug",
                &GithubSearchFilter {
                    limit: 5,
                    owner: vec!["ace".to_string()],
                    repo: vec!["ace/app".to_string()],
                    labels: vec!["bug".to_string()],
                    include_prs_in_issue_search: true,
                    ..GithubSearchFilter::default()
                },
            )
            .await
            .expect("search");

        assert_eq!(results[0].repository.name_with_owner, "ace/app");
        let args = &runner.requests()[0].args;
        assert_eq!(args[0..3], ["search", "issues", "render bug"]);
        assert!(args.contains(&"--include-prs".to_string()));
        assert!(args.windows(2).any(|pair| pair == ["--owner", "ace"]));
        assert!(args.windows(2).any(|pair| pair == ["--repo", "ace/app"]));
    }

    #[tokio::test]
    async fn pull_request_search_parses_draft_state() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok(
            br#"[{"assignees":[],"author":{"login":"octo"},"authorAssociation":"MEMBER","body":"body","closedAt":null,"commentsCount":1,"createdAt":"2026-06-21T00:00:00Z","id":"PR_1","isDraft":true,"isLocked":false,"isPullRequest":true,"labels":[],"number":2,"repository":{"nameWithOwner":"ace/app","url":"https://example.test/ace/app"},"state":"open","title":"Feature","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/pull/2"}]"#,
        )]));
        let github = GithubCliClient::with_runner(runner);
        let results = github
            .search_pull_requests(Path::new("."), "feature", &GithubSearchFilter::default())
            .await
            .expect("prs");

        assert!(results[0].is_draft);
        assert_eq!(results[0].item.number, 2);
    }
}
