use crate::{GitToolError, GithubCliClient, GithubUser, ProcessRunner, Result, parse_json};
use serde::{Deserialize, Serialize};
use std::path::Path;

const REVIEW_THREADS_QUERY: &str = r#"
query PullRequestReviewThreads(
  $owner: String!,
  $name: String!,
  $number: Int!,
  $threadLimit: Int!,
  $commentLimit: Int!
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      reviewThreads(first: $threadLimit) {
        totalCount
        nodes {
          id
          isCollapsed
          isOutdated
          isResolved
          path
          line
          startLine
          diffSide
          startDiffSide
          subjectType
          viewerCanReply
          viewerCanResolve
          viewerCanUnresolve
          resolvedBy {
            login
          }
          comments(first: $commentLimit) {
            totalCount
            nodes {
              id
              databaseId
              author {
                login
              }
              body
              createdAt
              updatedAt
              url
              path
              line
              originalLine
              diffHunk
              pullRequestReview {
                id
                state
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn pull_request_review_threads(
        &self,
        cwd: &Path,
        number: u32,
        thread_limit: u32,
        comment_limit: u32,
    ) -> Result<GithubPullRequestReviewThreads> {
        let repository = self.repository(cwd).await?;
        let (owner, name) =
            repository
                .name_with_owner
                .split_once('/')
                .ok_or_else(|| GitToolError::Parse {
                    context: "github repository",
                    message: format!("invalid nameWithOwner `{}`", repository.name_with_owner),
                })?;
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "api".to_string(),
                    "graphql".to_string(),
                    "-f".to_string(),
                    format!("query={REVIEW_THREADS_QUERY}"),
                    "-F".to_string(),
                    format!("owner={owner}"),
                    "-F".to_string(),
                    format!("name={name}"),
                    "-F".to_string(),
                    format!("number={number}"),
                    "-F".to_string(),
                    format!("threadLimit={thread_limit}"),
                    "-F".to_string(),
                    format!("commentLimit={comment_limit}"),
                ],
                &[0],
            )
            .await?;
        let response = parse_json::<GithubReviewThreadsGraphqlResponse>(
            "github pull request review threads",
            &output.stdout,
        )?;
        let pull_request =
            response
                .data
                .repository
                .pull_request
                .ok_or_else(|| GitToolError::Parse {
                    context: "github pull request review threads",
                    message: format!("pull request #{number} was not returned"),
                })?;
        Ok(GithubPullRequestReviewThreads {
            number: pull_request.number,
            total_count: pull_request.review_threads.total_count,
            threads: pull_request.review_threads.nodes,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestReviewThreads {
    pub number: u32,
    pub total_count: u32,
    pub threads: Vec<GithubPullRequestReviewThread>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestReviewThread {
    pub id: String,
    #[serde(rename = "isCollapsed")]
    pub is_collapsed: bool,
    #[serde(rename = "isOutdated")]
    pub is_outdated: bool,
    #[serde(rename = "isResolved")]
    pub is_resolved: bool,
    pub path: String,
    pub line: Option<u32>,
    #[serde(rename = "startLine")]
    pub start_line: Option<u32>,
    #[serde(rename = "diffSide")]
    pub diff_side: String,
    #[serde(rename = "startDiffSide")]
    pub start_diff_side: Option<String>,
    #[serde(rename = "subjectType")]
    pub subject_type: String,
    #[serde(rename = "viewerCanReply")]
    pub viewer_can_reply: bool,
    #[serde(rename = "viewerCanResolve")]
    pub viewer_can_resolve: bool,
    #[serde(rename = "viewerCanUnresolve")]
    pub viewer_can_unresolve: bool,
    #[serde(rename = "resolvedBy")]
    pub resolved_by: Option<GithubUser>,
    #[serde(deserialize_with = "deserialize_comment_connection")]
    pub comments: GithubPullRequestReviewThreadComments,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestReviewThreadComments {
    pub total_count: u32,
    pub nodes: Vec<GithubPullRequestReviewThreadComment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestReviewThreadComment {
    pub id: String,
    #[serde(rename = "databaseId")]
    pub database_id: Option<u64>,
    pub author: Option<GithubUser>,
    pub body: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
    pub url: Option<String>,
    pub path: Option<String>,
    pub line: Option<u32>,
    #[serde(rename = "originalLine")]
    pub original_line: Option<u32>,
    #[serde(rename = "diffHunk")]
    pub diff_hunk: Option<String>,
    #[serde(rename = "pullRequestReview")]
    pub pull_request_review: Option<GithubPullRequestReviewThreadReview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestReviewThreadReview {
    pub id: String,
    pub state: String,
    pub author: Option<GithubUser>,
}

#[derive(Debug, Deserialize)]
struct GithubReviewThreadsGraphqlResponse {
    data: GithubReviewThreadsData,
}

#[derive(Debug, Deserialize)]
struct GithubReviewThreadsData {
    repository: GithubReviewThreadsRepository,
}

#[derive(Debug, Deserialize)]
struct GithubReviewThreadsRepository {
    #[serde(rename = "pullRequest")]
    pull_request: Option<GithubReviewThreadsPullRequest>,
}

#[derive(Debug, Deserialize)]
struct GithubReviewThreadsPullRequest {
    number: u32,
    #[serde(rename = "reviewThreads")]
    review_threads: GithubReviewThreadConnection,
}

#[derive(Debug, Deserialize)]
struct GithubReviewThreadConnection {
    #[serde(rename = "totalCount")]
    total_count: u32,
    nodes: Vec<GithubPullRequestReviewThread>,
}

#[derive(Debug, Deserialize)]
struct GithubReviewThreadCommentConnection {
    #[serde(rename = "totalCount")]
    total_count: u32,
    nodes: Vec<GithubPullRequestReviewThreadComment>,
}

fn deserialize_comment_connection<'de, D>(
    deserializer: D,
) -> std::result::Result<GithubPullRequestReviewThreadComments, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let connection = GithubReviewThreadCommentConnection::deserialize(deserializer)?;
    Ok(GithubPullRequestReviewThreadComments {
        total_count: connection.total_count,
        nodes: connection.nodes,
    })
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
    async fn pull_request_review_threads_resolves_repo_and_parses_thread_state() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"{"data":{"repository":{"pullRequest":{"number":42,"reviewThreads":{"totalCount":1,"nodes":[{"id":"PRRT_1","isCollapsed":false,"isOutdated":false,"isResolved":true,"path":"src/lib.rs","line":12,"startLine":10,"diffSide":"RIGHT","startDiffSide":"RIGHT","subjectType":"LINE","viewerCanReply":true,"viewerCanResolve":false,"viewerCanUnresolve":true,"resolvedBy":{"login":"maintainer"},"comments":{"totalCount":1,"nodes":[{"id":"PRRC_1","databaseId":10,"author":{"login":"reviewer"},"body":"Please cover this branch","createdAt":"2026-06-21T00:00:00Z","updatedAt":"2026-06-21T00:01:00Z","url":"https://github.test/pull/42#discussion_r10","path":"src/lib.rs","line":12,"originalLine":12,"diffHunk":"@@ -1 +1 @@","pullRequestReview":{"id":"PRR_1","state":"CHANGES_REQUESTED","author":{"login":"reviewer"}}}]}}]}}}}}"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let threads = github
            .pull_request_review_threads(Path::new("."), 42, 20, 50)
            .await
            .expect("review threads");

        assert_eq!(threads.number, 42);
        assert_eq!(threads.total_count, 1);
        assert!(threads.threads[0].is_resolved);
        assert_eq!(
            threads.threads[0].resolved_by.as_ref().unwrap().login,
            "maintainer"
        );
        assert_eq!(threads.threads[0].comments.total_count, 1);
        assert_eq!(threads.threads[0].comments.nodes[0].database_id, Some(10));
        assert_eq!(
            threads.threads[0].comments.nodes[0]
                .pull_request_review
                .as_ref()
                .unwrap()
                .state,
            "CHANGES_REQUESTED"
        );

        let request = &runner.requests()[1];
        assert_eq!(request.args[0], "api");
        assert_eq!(request.args[1], "graphql");
        assert!(request.args.iter().any(|arg| arg == "owner=ace"));
        assert!(request.args.iter().any(|arg| arg == "name=app"));
        assert!(request.args.iter().any(|arg| arg == "number=42"));
        assert!(request.args.iter().any(|arg| arg == "threadLimit=20"));
        assert!(request.args.iter().any(|arg| arg == "commentLimit=50"));
    }
}
