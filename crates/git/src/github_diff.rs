use crate::{GithubCliClient, ProcessRunner, Result, parse_json};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn pull_request_files(
        &self,
        cwd: &Path,
        selector: &str,
    ) -> Result<Vec<GithubPullRequestFile>> {
        let output = self
            .gh_allow_statuses(cwd, ["pr", "view", selector, "--json", "files"], &[0])
            .await?;
        let response =
            parse_json::<PullRequestFilesResponse>("github pull request files", &output.stdout)?;
        Ok(response.files)
    }

    pub async fn pull_request_diff(
        &self,
        cwd: &Path,
        selector: &str,
    ) -> Result<GithubPullRequestDiff> {
        let files = self.pull_request_files(cwd, selector).await?;
        let output = self
            .gh_allow_statuses(cwd, ["pr", "diff", selector, "--patch"], &[0])
            .await?;
        Ok(GithubPullRequestDiff {
            selector: selector.to_string(),
            files,
            diff: output.stdout_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestFile {
    pub path: String,
    #[serde(default)]
    pub additions: u32,
    #[serde(default)]
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPullRequestDiff {
    pub selector: String,
    pub files: Vec<GithubPullRequestFile>,
    pub diff: String,
}

#[derive(Debug, Deserialize)]
struct PullRequestFilesResponse {
    #[serde(default)]
    files: Vec<GithubPullRequestFile>,
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

    fn output(stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status: 0,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    #[tokio::test]
    async fn pull_request_files_parses_file_stats() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![output(
            br#"{"files":[{"path":"src/lib.rs","additions":12,"deletions":3}]}"#,
        )]));
        let github = GithubCliClient::with_runner(runner.clone());

        let files = github
            .pull_request_files(Path::new("."), "42")
            .await
            .expect("files");

        assert_eq!(files[0].path, "src/lib.rs");
        assert_eq!(files[0].additions, 12);
        assert_eq!(
            runner.requests()[0].args,
            vec!["pr", "view", "42", "--json", "files"]
        );
    }

    #[tokio::test]
    async fn pull_request_diff_fetches_files_and_patch() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            output(br#"{"files":[{"path":"src/lib.rs","additions":1,"deletions":0}]}"#),
            output("diff --git a/src/lib.rs b/src/lib.rs\n+pub fn run() {}\n"),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let diff = github
            .pull_request_diff(Path::new("."), "42")
            .await
            .expect("diff");

        assert_eq!(diff.selector, "42");
        assert_eq!(diff.files[0].path, "src/lib.rs");
        assert!(diff.diff.contains("diff --git"));
        assert_eq!(
            runner.requests()[1].args,
            vec!["pr", "diff", "42", "--patch"]
        );
    }
}
