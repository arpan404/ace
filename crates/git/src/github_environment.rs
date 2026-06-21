use crate::{GitToolError, GithubCliClient, GithubRepository, ProcessRunner, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn auth_token(&self, cwd: &Path) -> Result<String> {
        let output = self.gh_allow_statuses(cwd, ["auth", "token"], &[0]).await?;
        Ok(output.stdout_string())
    }

    pub async fn environment_status(&self, cwd: &Path) -> Result<GithubEnvironmentStatus> {
        let version = match self.gh_allow_statuses(cwd, ["--version"], &[0]).await {
            Ok(output) => output
                .stdout_string()
                .lines()
                .next()
                .map(ToString::to_string),
            Err(GitToolError::MissingBinary(_)) => {
                return Ok(GithubEnvironmentStatus {
                    gh_available: false,
                    gh_version: None,
                    authenticated: false,
                    auth_message: Some("GitHub CLI is not installed".to_string()),
                    repository: None,
                });
            }
            Err(error) => return Err(error),
        };

        let auth = self
            .gh_allow_statuses(cwd, ["auth", "status"], &[0, 1])
            .await?;
        let authenticated = auth.success();
        let auth_message = auth_status_message(&auth.stdout_string(), &auth.stderr_string());
        let repository = if authenticated {
            match self.repository(cwd).await {
                Ok(repository) => Some(repository),
                Err(GitToolError::NotGithubRepository) => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };

        Ok(GithubEnvironmentStatus {
            gh_available: true,
            gh_version: version,
            authenticated,
            auth_message,
            repository,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubEnvironmentStatus {
    pub gh_available: bool,
    pub gh_version: Option<String>,
    pub authenticated: bool,
    pub auth_message: Option<String>,
    pub repository: Option<GithubRepository>,
}

fn auth_status_message(stdout: &str, stderr: &str) -> Option<String> {
    let message = if stderr.is_empty() { stdout } else { stderr };
    let message = message.trim();
    if message.is_empty() {
        None
    } else {
        Some(message.lines().next().unwrap_or(message).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, CommandRequest};
    use async_trait::async_trait;
    use std::{collections::VecDeque, path::Path, sync::Mutex};

    #[derive(Debug)]
    struct FakeRunner {
        outputs: Mutex<VecDeque<crate::Result<CommandOutput>>>,
        requests: Mutex<Vec<CommandRequest>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<crate::Result<CommandOutput>>) -> Self {
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
                .expect("fake output")
        }
    }

    fn ok(stdout: impl AsRef<[u8]>) -> crate::Result<CommandOutput> {
        Ok(CommandOutput {
            status: 0,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        })
    }

    fn exit_one(stderr: impl AsRef<[u8]>) -> crate::Result<CommandOutput> {
        Ok(CommandOutput {
            status: 1,
            stdout: Vec::new(),
            stderr: stderr.as_ref().to_vec(),
        })
    }

    #[tokio::test]
    async fn environment_status_reports_missing_gh_without_error() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![Err(GitToolError::MissingBinary(
            "gh".to_string(),
        ))]));
        let github = GithubCliClient::with_runner(runner.clone());

        let status = github
            .environment_status(Path::new("."))
            .await
            .expect("status");

        assert!(!status.gh_available);
        assert!(!status.authenticated);
        assert_eq!(runner.requests()[0].args, vec!["--version"]);
    }

    #[tokio::test]
    async fn environment_status_reports_unauthenticated_gh() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok("gh version 2.83.0 (2026-06-01)\n"),
            exit_one("You are not logged into any GitHub hosts\n"),
        ]));
        let github = GithubCliClient::with_runner(runner);

        let status = github
            .environment_status(Path::new("."))
            .await
            .expect("status");

        assert!(status.gh_available);
        assert_eq!(
            status.gh_version.as_deref(),
            Some("gh version 2.83.0 (2026-06-01)")
        );
        assert!(!status.authenticated);
        assert!(status.repository.is_none());
        assert_eq!(
            status.auth_message.as_deref(),
            Some("You are not logged into any GitHub hosts")
        );
    }

    #[tokio::test]
    async fn environment_status_includes_repository_when_authenticated() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok("gh version 2.83.0 (2026-06-01)\n"),
            ok("Logged in to github.com account ace\n"),
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
        ]));
        let github = GithubCliClient::with_runner(runner);

        let status = github
            .environment_status(Path::new("."))
            .await
            .expect("status");

        assert!(status.gh_available);
        assert!(status.authenticated);
        assert_eq!(status.repository.expect("repo").name_with_owner, "ace/app");
    }
}
