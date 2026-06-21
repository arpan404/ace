use crate::{GitClient, GitToolError, ProcessRunner, Result};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};

impl<R: ProcessRunner> GitClient<R> {
    pub async fn list_remotes(&self, cwd: &Path) -> Result<Vec<GitRemote>> {
        let output = self.git_success(cwd, ["remote", "-v"]).await?;
        let mut remotes = parse_remotes(&output.stdout_string())?;

        for remote in remotes.values_mut() {
            remote.default_branch = self.remote_default_branch(cwd, &remote.name).await?;
        }

        Ok(remotes.into_values().collect())
    }

    async fn remote_default_branch(&self, cwd: &Path, remote: &str) -> Result<Option<String>> {
        let ref_name = format!("refs/remotes/{remote}/HEAD");
        let output = self
            .run_git(cwd, ["symbolic-ref", ref_name.as_str(), "--short"])
            .await?;
        if !output.success() {
            return Ok(None);
        }

        let branch = output.stdout_string();
        let branch = branch
            .strip_prefix(&format!("{remote}/"))
            .unwrap_or(&branch);
        if branch.trim().is_empty() {
            Ok(None)
        } else {
            Ok(Some(branch.to_string()))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitRemote {
    pub name: String,
    pub fetch_url: Option<String>,
    pub push_url: Option<String>,
    pub default_branch: Option<String>,
}

fn parse_remotes(raw: &str) -> Result<BTreeMap<String, GitRemote>> {
    let mut remotes = BTreeMap::new();
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (name, rest) = split_remote_line(line)?;
        let (url, direction) = split_remote_url(rest)?;
        let remote = remotes
            .entry(name.to_string())
            .or_insert_with(|| GitRemote {
                name: name.to_string(),
                fetch_url: None,
                push_url: None,
                default_branch: None,
            });
        match direction {
            "fetch" => remote.fetch_url = Some(url.to_string()),
            "push" => remote.push_url = Some(url.to_string()),
            _ => {}
        }
    }
    Ok(remotes)
}

fn split_remote_line(line: &str) -> Result<(&str, &str)> {
    let mut parts = line.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or_default().trim();
    let rest = parts.next().unwrap_or_default().trim();
    if name.is_empty() || rest.is_empty() {
        return Err(GitToolError::Parse {
            context: "git remote",
            message: format!("invalid remote line `{line}`"),
        });
    }
    Ok((name, rest))
}

fn split_remote_url(raw: &str) -> Result<(&str, &str)> {
    let (url, suffix) = raw.rsplit_once(' ').ok_or_else(|| GitToolError::Parse {
        context: "git remote",
        message: format!("missing remote direction in `{raw}`"),
    })?;
    let direction = suffix
        .strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
        .ok_or_else(|| GitToolError::Parse {
            context: "git remote",
            message: format!("invalid remote direction in `{raw}`"),
        })?;
    Ok((url.trim(), direction))
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

    fn output(status: i32, stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    #[tokio::test]
    async fn list_remotes_parses_fetch_push_urls_and_default_branch() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            output(
                0,
                "origin\tgit@github.com:ace/app.git (fetch)\norigin\tgit@github.com:ace/app.git (push)\nupstream\thttps://github.com/upstream/app.git (fetch)\nupstream\thttps://github.com/upstream/app.git (push)\n",
            ),
            output(0, "origin/main\n"),
            output(1, ""),
        ]));
        let git = GitClient::with_runner(runner.clone());

        let remotes = git
            .list_remotes(Path::new("/repo"))
            .await
            .expect("list remotes");

        assert_eq!(remotes.len(), 2);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(
            remotes[0].fetch_url.as_deref(),
            Some("git@github.com:ace/app.git")
        );
        assert_eq!(remotes[0].push_url, remotes[0].fetch_url);
        assert_eq!(remotes[0].default_branch.as_deref(), Some("main"));
        assert_eq!(remotes[1].name, "upstream");
        assert_eq!(
            remotes[1].fetch_url.as_deref(),
            Some("https://github.com/upstream/app.git")
        );
        assert_eq!(remotes[1].default_branch, None);

        let requests = runner.requests();
        assert_eq!(requests[0].args, vec!["remote", "-v"]);
        assert_eq!(
            requests[1].args,
            vec!["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]
        );
        assert_eq!(
            requests[2].args,
            vec!["symbolic-ref", "refs/remotes/upstream/HEAD", "--short"]
        );
    }

    #[tokio::test]
    async fn list_remotes_skips_default_branch_lookup_when_no_remotes_exist() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![output(0, "")]));
        let git = GitClient::with_runner(runner.clone());

        let remotes = git
            .list_remotes(Path::new("/repo"))
            .await
            .expect("list remotes");

        assert!(remotes.is_empty());
        assert_eq!(runner.requests().len(), 1);
        assert_eq!(runner.requests()[0].args, vec!["remote", "-v"]);
    }
}
