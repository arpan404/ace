use crate::{GitClient, GitToolError, ProcessRunner, Result};
use serde::Serialize;
use std::path::Path;

const MAX_COMMIT_LIMIT: u32 = 500;
const COMMIT_FORMAT: &str = "%H%x00%h%x00%P%x00%D%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x1e";

impl<R: ProcessRunner> GitClient<R> {
    pub async fn recent_commits(
        &self,
        cwd: &Path,
        limit: u32,
        rev: Option<&str>,
    ) -> Result<Vec<GitCommitSummary>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let mut args = vec![
            "log".to_string(),
            format!("--max-count={}", limit.min(MAX_COMMIT_LIMIT)),
            "--date-order".to_string(),
            format!("--format={COMMIT_FORMAT}"),
        ];
        if let Some(rev) = rev.map(normalized_rev).transpose()?.flatten() {
            args.push(rev.to_string());
        }

        let output = self.git_success(cwd, args).await?;
        parse_commits(&output.stdout_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitCommitSummary {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub committed_at: String,
    pub subject: String,
}

fn normalized_rev(rev: &str) -> Result<Option<&str>> {
    let rev = rev.trim();
    if rev.is_empty() {
        return Ok(None);
    }
    if rev.starts_with('-') || rev.contains('\0') {
        return Err(GitToolError::Parse {
            context: "git log revision",
            message: format!("unsafe revision `{rev}`"),
        });
    }
    Ok(Some(rev))
}

fn parse_commits(raw: &str) -> Result<Vec<GitCommitSummary>> {
    raw.split('\x1e')
        .filter(|record| !record.trim().is_empty())
        .map(parse_commit)
        .collect()
}

fn parse_commit(record: &str) -> Result<GitCommitSummary> {
    let record = record.trim_matches('\n');
    let mut fields = record.split('\0');
    let oid = required_field(&mut fields, "oid", record)?;
    let short_oid = required_field(&mut fields, "short oid", record)?;
    let parents = required_field(&mut fields, "parents", record)?
        .split_whitespace()
        .map(ToString::to_string)
        .collect();
    let refs = required_field(&mut fields, "refs", record)?
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect();
    let author_name = required_field(&mut fields, "author name", record)?;
    let author_email = required_field(&mut fields, "author email", record)?;
    let authored_at = required_field(&mut fields, "authored at", record)?;
    let committed_at = required_field(&mut fields, "committed at", record)?;
    let subject = required_field(&mut fields, "subject", record)?;

    Ok(GitCommitSummary {
        oid: oid.to_string(),
        short_oid: short_oid.to_string(),
        parents,
        refs,
        author_name: author_name.to_string(),
        author_email: author_email.to_string(),
        authored_at: authored_at.to_string(),
        committed_at: committed_at.to_string(),
        subject: subject.to_string(),
    })
}

fn required_field<'a>(
    fields: &mut impl Iterator<Item = &'a str>,
    field: &'static str,
    record: &str,
) -> Result<&'a str> {
    fields.next().ok_or_else(|| GitToolError::Parse {
        context: "git log",
        message: format!("missing {field} in commit record `{record}`"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, CommandRequest};
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
    async fn recent_commits_builds_bounded_log_command_and_parses_records() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok(
            "abcdef123456\0abcdef1\0parent1 parent2\0HEAD -> feature/x, origin/feature/x\0Octo\0octo@example.test\x002026-06-21T00:00:00+00:00\x002026-06-21T00:01:00+00:00\0Ship feature\x1e",
        )]));
        let git = GitClient::with_runner(runner.clone());

        let commits = git
            .recent_commits(Path::new("/repo"), 900, Some("feature/x"))
            .await
            .expect("commits");

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].oid, "abcdef123456");
        assert_eq!(commits[0].short_oid, "abcdef1");
        assert_eq!(commits[0].parents, vec!["parent1", "parent2"]);
        assert_eq!(
            commits[0].refs,
            vec!["HEAD -> feature/x", "origin/feature/x"]
        );
        assert_eq!(commits[0].subject, "Ship feature");

        let requests = runner.requests();
        assert_eq!(requests[0].program, "git");
        assert_eq!(requests[0].cwd.as_deref(), Some(Path::new("/repo")));
        assert_eq!(requests[0].args[0], "log");
        assert_eq!(requests[0].args[1], "--max-count=500");
        assert_eq!(requests[0].args[2], "--date-order");
        assert!(requests[0].args[3].starts_with("--format=%H"));
        assert_eq!(requests[0].args[4], "feature/x");
    }

    #[tokio::test]
    async fn recent_commits_skips_process_for_zero_limit() {
        let runner = std::sync::Arc::new(FakeRunner::new(Vec::new()));
        let git = GitClient::with_runner(runner.clone());

        let commits = git
            .recent_commits(Path::new("/repo"), 0, Some("HEAD"))
            .await
            .expect("commits");

        assert!(commits.is_empty());
        assert!(runner.requests().is_empty());
    }

    #[tokio::test]
    async fn recent_commits_rejects_option_like_revision() {
        let runner = std::sync::Arc::new(FakeRunner::new(Vec::new()));
        let git = GitClient::with_runner(runner.clone());

        let error = git
            .recent_commits(Path::new("/repo"), 10, Some("--all"))
            .await
            .expect_err("unsafe rev");

        assert!(matches!(error, GitToolError::Parse { .. }));
        assert!(runner.requests().is_empty());
    }
}
