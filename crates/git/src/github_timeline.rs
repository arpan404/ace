use crate::{GithubCliClient, GithubUser, ProcessRunner, Result, parse_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn pull_request_timeline(
        &self,
        cwd: &Path,
        number: u32,
        limit: u32,
    ) -> Result<Vec<GithubTimelineEvent>> {
        let repository = self.repository(cwd).await?;
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "api".to_string(),
                    format!(
                        "repos/{}/issues/{number}/timeline",
                        repository.name_with_owner
                    ),
                    "-H".to_string(),
                    "Accept: application/vnd.github+json".to_string(),
                    "-F".to_string(),
                    format!("per_page={limit}"),
                ],
                &[0],
            )
            .await?;
        parse_json("github pull request timeline", &output.stdout)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GithubTimelineEvent {
    pub id: Option<u64>,
    #[serde(rename = "node_id")]
    pub node_id: Option<String>,
    pub url: Option<String>,
    #[serde(rename = "html_url")]
    pub html_url: Option<String>,
    pub event: Option<String>,
    #[serde(rename = "created_at")]
    pub created_at: Option<String>,
    #[serde(rename = "updated_at")]
    pub updated_at: Option<String>,
    pub actor: Option<GithubUser>,
    pub author: Option<GithubUser>,
    pub body: Option<String>,
    pub state: Option<String>,
    #[serde(rename = "commit_id")]
    pub commit_id: Option<String>,
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
    async fn pull_request_timeline_resolves_repo_and_preserves_event_fields() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok(
                br#"[{"id":1,"node_id":"T_1","url":"https://api.github.test/timeline/1","html_url":"https://github.test/pull/42#event-1","event":"review_requested","created_at":"2026-06-21T00:00:00Z","actor":{"login":"octo"},"requested_reviewer":{"login":"maintainer"}},{"id":2,"event":"committed","created_at":"2026-06-21T00:01:00Z","author":{"login":"octo"},"commit_id":"abc","message":"Add feature"}]"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let events = github
            .pull_request_timeline(Path::new("."), 42, 25)
            .await
            .expect("timeline");

        assert_eq!(events[0].event.as_deref(), Some("review_requested"));
        assert_eq!(events[0].actor.as_ref().expect("actor").login, "octo");
        assert_eq!(events[0].extra["requested_reviewer"]["login"], "maintainer");
        assert_eq!(events[1].commit_id.as_deref(), Some("abc"));
        assert_eq!(events[1].extra["message"], "Add feature");
        assert_eq!(
            runner.requests()[1].args,
            vec![
                "api",
                "repos/ace/app/issues/42/timeline",
                "-H",
                "Accept: application/vnd.github+json",
                "-F",
                "per_page=25"
            ]
        );
    }
}
