use crate::{GitClient, GitToolError, ProcessRunner, Result};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};

impl<R: ProcessRunner> GitClient<R> {
    pub async fn changed_files(
        &self,
        cwd: &Path,
        staged: bool,
        include_untracked: bool,
    ) -> Result<Vec<GitChangedFile>> {
        let mut name_args = vec![
            "diff".to_string(),
            "--name-status".to_string(),
            "-z".to_string(),
        ];
        let mut stat_args = vec![
            "diff".to_string(),
            "--numstat".to_string(),
            "-z".to_string(),
        ];
        if staged {
            name_args.insert(1, "--cached".to_string());
            stat_args.insert(1, "--cached".to_string());
        }

        let status_output = self.git_success(cwd, name_args).await?;
        let stat_output = self.git_success(cwd, stat_args).await?;
        let mut files = parse_name_status(&status_output.stdout_string())?;
        let stats = parse_numstat(&stat_output.stdout_string())?;
        for file in &mut files {
            if let Some(stat) = stats.get(&file.path) {
                file.additions = stat.additions;
                file.deletions = stat.deletions;
            }
        }

        if include_untracked && !staged {
            let output = self
                .git_success(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
                .await?;
            append_untracked(&mut files, &output.stdout_string());
        }

        Ok(files)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitChangedFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: GitChangedFileStatus,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitChangedFileStatus {
    Added,
    Copied,
    Deleted,
    Modified,
    Renamed,
    TypeChanged,
    Unmerged,
    Unknown,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Numstat {
    additions: Option<u32>,
    deletions: Option<u32>,
}

fn parse_name_status(raw: &str) -> Result<Vec<GitChangedFile>> {
    let mut parts = raw.split('\0').filter(|part| !part.is_empty());
    let mut files = Vec::new();
    while let Some(status_code) = parts.next() {
        let status = changed_status(status_code);
        let (path, original_path) = match status {
            GitChangedFileStatus::Renamed | GitChangedFileStatus::Copied => {
                let original = next_part(&mut parts, status_code, "original path")?;
                let path = next_part(&mut parts, status_code, "path")?;
                (path.to_string(), Some(original.to_string()))
            }
            _ => {
                let path = next_part(&mut parts, status_code, "path")?;
                (path.to_string(), None)
            }
        };
        files.push(GitChangedFile {
            path,
            original_path,
            status,
            additions: None,
            deletions: None,
        });
    }
    Ok(files)
}

fn parse_numstat(raw: &str) -> Result<BTreeMap<String, Numstat>> {
    let mut stats = BTreeMap::new();
    for record in raw.split('\0').filter(|part| !part.is_empty()) {
        let mut fields = record.split('\t');
        let additions = parse_count(fields.next(), record, "additions")?;
        let deletions = parse_count(fields.next(), record, "deletions")?;
        let path = fields
            .next_back()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| GitToolError::Parse {
                context: "git numstat",
                message: format!("missing path in `{record}`"),
            })?;
        stats.insert(
            path.to_string(),
            Numstat {
                additions,
                deletions,
            },
        );
    }
    Ok(stats)
}

fn append_untracked(files: &mut Vec<GitChangedFile>, raw: &str) {
    for path in raw.split('\0').filter(|part| !part.is_empty()) {
        if files.iter().any(|file| file.path == path) {
            continue;
        }
        files.push(GitChangedFile {
            path: path.to_string(),
            original_path: None,
            status: GitChangedFileStatus::Untracked,
            additions: None,
            deletions: None,
        });
    }
}

fn changed_status(raw: &str) -> GitChangedFileStatus {
    match raw.chars().next().unwrap_or(' ') {
        'A' => GitChangedFileStatus::Added,
        'C' => GitChangedFileStatus::Copied,
        'D' => GitChangedFileStatus::Deleted,
        'M' => GitChangedFileStatus::Modified,
        'R' => GitChangedFileStatus::Renamed,
        'T' => GitChangedFileStatus::TypeChanged,
        'U' => GitChangedFileStatus::Unmerged,
        _ => GitChangedFileStatus::Unknown,
    }
}

fn next_part<'a>(
    parts: &mut impl Iterator<Item = &'a str>,
    status_code: &str,
    field: &'static str,
) -> Result<&'a str> {
    parts.next().ok_or_else(|| GitToolError::Parse {
        context: "git name-status",
        message: format!("missing {field} after status `{status_code}`"),
    })
}

fn parse_count(raw: Option<&str>, record: &str, field: &'static str) -> Result<Option<u32>> {
    let raw = raw.ok_or_else(|| GitToolError::Parse {
        context: "git numstat",
        message: format!("missing {field} in `{record}`"),
    })?;
    if raw == "-" {
        return Ok(None);
    }
    raw.parse::<u32>()
        .map(Some)
        .map_err(|error| GitToolError::Parse {
            context: "git numstat",
            message: error.to_string(),
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
    async fn changed_files_lists_worktree_diff_and_untracked_files() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok("M\0src/lib.rs\0R100\0old.rs\0new.rs\0"),
            ok("3\t1\tsrc/lib.rs\0-\t-\tnew.rs\0"),
            ok("notes.txt\0"),
        ]));
        let git = GitClient::with_runner(runner.clone());

        let files = git
            .changed_files(Path::new("/repo"), false, true)
            .await
            .expect("changed files");

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "src/lib.rs");
        assert_eq!(files[0].status, GitChangedFileStatus::Modified);
        assert_eq!(files[0].additions, Some(3));
        assert_eq!(files[0].deletions, Some(1));
        assert_eq!(files[1].path, "new.rs");
        assert_eq!(files[1].original_path.as_deref(), Some("old.rs"));
        assert_eq!(files[1].status, GitChangedFileStatus::Renamed);
        assert_eq!(files[1].additions, None);
        assert_eq!(files[2].path, "notes.txt");
        assert_eq!(files[2].status, GitChangedFileStatus::Untracked);

        let requests = runner.requests();
        assert_eq!(requests[0].args, vec!["diff", "--name-status", "-z"]);
        assert_eq!(requests[1].args, vec!["diff", "--numstat", "-z"]);
        assert_eq!(
            requests[2].args,
            vec!["ls-files", "--others", "--exclude-standard", "-z"]
        );
    }

    #[tokio::test]
    async fn changed_files_lists_staged_diff_without_untracked_scan() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok("A\0src/main.rs\0"),
            ok("10\t0\tsrc/main.rs\0"),
        ]));
        let git = GitClient::with_runner(runner.clone());

        let files = git
            .changed_files(Path::new("/repo"), true, true)
            .await
            .expect("changed files");

        assert_eq!(files[0].status, GitChangedFileStatus::Added);
        assert_eq!(files[0].additions, Some(10));
        assert_eq!(files[0].deletions, Some(0));
        let requests = runner.requests();
        assert_eq!(
            requests[0].args,
            vec!["diff", "--cached", "--name-status", "-z"]
        );
        assert_eq!(
            requests[1].args,
            vec!["diff", "--cached", "--numstat", "-z"]
        );
        assert_eq!(requests.len(), 2);
    }

    #[test]
    fn name_status_parser_rejects_incomplete_records() {
        let error = parse_name_status("R100\0old.rs\0").expect_err("parse error");
        assert!(matches!(error, GitToolError::Parse { .. }));
    }
}
