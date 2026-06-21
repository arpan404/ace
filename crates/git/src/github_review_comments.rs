use crate::{GithubCliClient, GithubUser, ProcessRunner, Result, parse_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn pull_request_review_comments(
        &self,
        cwd: &Path,
        number: u32,
        limit: u32,
    ) -> Result<Vec<GithubPullRequestReviewComment>> {
        let repository = self.repository(cwd).await?;
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "api".to_string(),
                    format!(
                        "repos/{}/pulls/{number}/comments",
                        repository.name_with_owner
                    ),
                    "-F".to_string(),
                    format!("per_page={limit}"),
                ],
                &[0],
            )
            .await?;
        parse_json("github pull request review comments", &output.stdout)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GithubPullRequestReviewComment {
    pub id: u64,
    #[serde(rename = "node_id")]
    pub node_id: Option<String>,
    pub url: Option<String>,
    #[serde(rename = "html_url")]
    pub html_url: Option<String>,
    #[serde(rename = "pull_request_review_id")]
    pub pull_request_review_id: Option<u64>,
    #[serde(rename = "pull_request_url")]
    pub pull_request_url: Option<String>,
    #[serde(rename = "diff_hunk")]
    pub diff_hunk: Option<String>,
    pub path: String,
    pub position: Option<u32>,
    #[serde(rename = "original_position")]
    pub original_position: Option<u32>,
    pub line: Option<u32>,
    #[serde(rename = "original_line")]
    pub original_line: Option<u32>,
    #[serde(rename = "start_line")]
    pub start_line: Option<u32>,
    #[serde(rename = "original_start_line")]
    pub original_start_line: Option<u32>,
    pub side: Option<String>,
    #[serde(rename = "start_side")]
    pub start_side: Option<String>,
    #[serde(rename = "commit_id")]
    pub commit_id: Option<String>,
    #[serde(rename = "original_commit_id")]
    pub original_commit_id: Option<String>,
    pub user: Option<GithubUser>,
    pub body: String,
    #[serde(rename = "created_at")]
    pub created_at: Option<String>,
    #[serde(rename = "updated_at")]
    pub updated_at: Option<String>,
    #[serde(rename = "in_reply_to_id")]
    pub in_reply_to_id: Option<u64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
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
    async fn pull_request_review_comments_resolves_repo_and_parses_comment_hunks() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"[{"id":10,"node_id":"PRRC_10","url":"https://api.github.test/comments/10","html_url":"https://github.test/pull/42#discussion_r10","pull_request_review_id":5,"pull_request_url":"https://api.github.test/pulls/42","diff_hunk":"@@ -1 +1 @@","path":"src/lib.rs","position":1,"original_position":1,"line":12,"original_line":12,"side":"RIGHT","commit_id":"abc","original_commit_id":"abc","user":{"login":"reviewer"},"body":"Please cover this branch","created_at":"2026-06-21T00:00:00Z","updated_at":"2026-06-21T00:01:00Z","subject_type":"line"}]"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let comments = github
            .pull_request_review_comments(Path::new("."), 42, 30)
            .await
            .expect("review comments");

        assert_eq!(comments[0].id, 10);
        assert_eq!(comments[0].path, "src/lib.rs");
        assert_eq!(comments[0].line, Some(12));
        assert_eq!(
            comments[0].user.as_ref().expect("reviewer").login,
            "reviewer"
        );
        assert_eq!(comments[0].extra["subject_type"], "line");
        assert_eq!(
            runner.requests()[1].args,
            vec![
                "api",
                "repos/ace/app/pulls/42/comments",
                "-F",
                "per_page=30"
            ]
        );
    }
}
