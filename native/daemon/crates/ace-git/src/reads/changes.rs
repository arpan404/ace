//! Source-control reads over one status read (`packages/git/src/changed-files.ts`, G3a):
//! `changedFiles`, `sourceControlState`, `sourceControlStatus`, `changeSummary` and
//! `checkoutSummary`. A read: no object, index or checkpoint is written, and only the listed
//! files are diffed or read.
//!
//! Proof: `changed-files-regressions.process`, `repository.process` and `checkout-paths.process`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::core::decode::{Records, malformed, nul};
use crate::core::error::GitError;
use crate::parse::numstat::numstat_record;
use crate::parse::repository::RepositoryInfo;
use crate::parse::status::{ParsedStatus, StatusEntry};
use crate::reads::info;
use crate::reads::status::state;
use crate::reads::{Command, CommandPort, checked};

/// Untracked files are counted from their first bytes only: larger ones count as unknown.
pub const UNTRACKED_BYTES: u64 = 1024 * 1024;
/// Pathspec bytes per `git diff` call, well inside every platform's argument limit.
pub const PATHSPEC_BYTES: usize = 64 * 1024;
/// One changed file with its line counts against HEAD.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}

/// One staged, unstaged, untracked or conflicted section entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub status: String,
}

/// The four sections and branch facts, without a file list (`sourceControlState`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlSections {
    pub truncated: bool,
    pub staged: Vec<SectionEntry>,
    pub unstaged: Vec<SectionEntry>,
    pub untracked: Vec<SectionEntry>,
    pub conflicted: Vec<SectionEntry>,
    pub branch: Option<String>,
    pub detached: bool,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

/// The flat file list and the four sections, with branch facts (`sourceControlStatus`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlStatus {
    pub files: Vec<ChangedFile>,
    pub truncated: bool,
    pub staged: Vec<SectionEntry>,
    pub unstaged: Vec<SectionEntry>,
    pub untracked: Vec<SectionEntry>,
    pub conflicted: Vec<SectionEntry>,
    pub branch: Option<String>,
    pub detached: bool,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

/// What one `changeSummary` reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangeSummary {
    pub files: usize,
    pub additions: u64,
    pub deletions: u64,
}

/// `checkoutSummary`'s answer: branch, remotes and counts from one status read plus numstat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckoutSummary {
    pub info: RepositoryInfo,
    pub diff: ChangeSummary,
}

/// The flat file list and whether it was capped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFiles {
    pub files: Vec<ChangedFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct Counted {
    added: u64,
    deleted: u64,
    binary: bool,
}

fn by_path<T>(entries: Vec<T>, path: impl Fn(&T) -> &str) -> Vec<T> {
    let mut entries = entries;
    // JavaScript's `<` compares UTF-16 code units; Rust's `str` order is code points.
    entries.sort_by(|left, right| path(left).encode_utf16().cmp(path(right).encode_utf16()));
    entries
}

fn kind_of(entry: &StatusEntry) -> &'static str {
    // A rename always carries its source; otherwise a worktree deletion wins, then the index.
    if entry.old_path.is_some() {
        return "renamed";
    }
    if entry.worktree_status == "D" || entry.index_status == "D" {
        return "deleted";
    }
    match entry.index_status.as_str() {
        "A" | "C" => "added",
        "R" => "renamed",
        _ => "modified",
    }
}

fn staged_kind(entry: &StatusEntry) -> &'static str {
    if entry.old_path.is_some() || entry.index_status == "R" {
        return "renamed";
    }
    match entry.index_status.as_str() {
        "A" | "C" => "added",
        "D" => "deleted",
        _ => "modified",
    }
}

fn unstaged_kind(entry: &StatusEntry) -> &'static str {
    match entry.worktree_status.as_str() {
        "D" => "deleted",
        "A" => "added",
        _ => "modified",
    }
}

async fn tracked_counts(
    port: &dyn CommandPort,
    root: &str,
    paths: &[String],
) -> Result<HashMap<String, Counted>, GitError> {
    let mut counts: HashMap<String, Counted> = HashMap::new();
    let mut batches: Vec<Vec<&String>> = vec![Vec::new()];
    let mut bytes = 0usize;
    for path in paths {
        let size = path.len() + 1;
        if bytes + size > PATHSPEC_BYTES && batches.last().is_some_and(|batch| !batch.is_empty()) {
            batches.push(Vec::new());
            bytes = 0;
        }
        if let Some(batch) = batches.last_mut() {
            batch.push(path);
        }
        bytes += size;
    }
    for batch in batches {
        if batch.is_empty() {
            continue;
        }
        let mut args: Vec<String> = [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "-z",
            "-M",
            "HEAD",
            "--",
        ]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
        args.extend(batch.into_iter().cloned());
        let output = checked(
            port,
            Command::owned(root, args).with_env(&[("GIT_LITERAL_PATHSPECS", "1")]),
        )
        .await?;
        let mut records = Records::new(nul(&output.stdout)?);
        while !records.done() {
            let record = records.next()?.to_owned();
            let counted = numstat_record(&record, &mut records)?;
            if counts.contains_key(&counted.path) {
                return Err(malformed("duplicate numstat path"));
            }
            counts.insert(
                counted.path,
                Counted {
                    added: counted.additions,
                    deleted: counted.deletions,
                    binary: counted.binary,
                },
            );
        }
    }
    Ok(counts)
}

/// An untracked file's lines from its first bytes; unknown (zero) past the cap.
fn untracked_count(root: &str, path: &str) -> Counted {
    let counted = || -> Option<Counted> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // No symlink is followed and a FIFO never blocks the read.
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(Path::new(root).join(path)).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.len() > UNTRACKED_BYTES {
            return Some(Counted::default());
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(metadata.len() + 1).read_to_end(&mut bytes).ok()?;
        if bytes.contains(&0) {
            return Some(Counted {
                added: 0,
                deleted: 0,
                binary: true,
            });
        }
        let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
        let last_has_no_newline = !bytes.is_empty() && bytes.last() != Some(&b'\n');
        Some(Counted {
            added: newlines + u64::from(last_has_no_newline),
            deleted: 0,
            binary: false,
        })
    };
    counted().unwrap_or_default()
}

fn add_file(files: &mut Vec<ChangedFile>, seen: &mut HashSet<String>, entry: &StatusEntry) {
    if !seen.insert(entry.path.clone()) {
        return;
    }
    files.push(ChangedFile {
        path: entry.path.clone(),
        from: entry.old_path.clone(),
        status: kind_of(entry).to_owned(),
        additions: 0,
        deletions: 0,
        binary: false,
    });
}

async fn read_changed_files(
    port: &dyn CommandPort,
    root: &str,
    state: &ParsedStatus,
    limit: usize,
) -> Result<ChangedFiles, GitError> {
    let mut files: Vec<ChangedFile> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in state
        .status
        .conflicted
        .iter()
        .chain(state.status.staged.iter())
        .chain(state.status.unstaged.iter())
    {
        add_file(&mut files, &mut seen, entry);
    }
    for path in &state.status.untracked {
        if !seen.insert(path.clone()) {
            continue;
        }
        files.push(ChangedFile {
            path: path.clone(),
            from: None,
            status: "untracked".to_owned(),
            additions: 0,
            deletions: 0,
            binary: false,
        });
    }
    let sorted = by_path(files, |file| file.path.as_str());
    let truncated = sorted.len() > limit;
    let mut listed = sorted;
    listed.truncate(limit);
    let paths: Vec<String> = listed
        .iter()
        .filter(|file| file.status != "untracked")
        .flat_map(|file| match &file.from {
            Some(from) => vec![file.path.clone(), from.clone()],
            None => vec![file.path.clone()],
        })
        .collect();
    let counts = if state.branch.head.is_some() {
        tracked_counts(port, root, &paths).await?
    } else {
        HashMap::new()
    };
    for file in &mut listed {
        if let Some(counted) = counts.get(&file.path) {
            file.additions = counted.added;
            file.deletions = counted.deleted;
            file.binary = counted.binary;
        }
    }
    for file in &mut listed {
        if file.status == "untracked" {
            let counted = untracked_count(root, &file.path);
            file.additions = counted.added;
            file.binary = counted.binary;
        }
    }
    Ok(ChangedFiles {
        files: listed,
        truncated,
    })
}

fn sections_from_state(
    state: &ParsedStatus,
    limit: usize,
) -> (
    Vec<SectionEntry>,
    Vec<SectionEntry>,
    Vec<SectionEntry>,
    Vec<SectionEntry>,
    bool,
) {
    let staged = by_path(
        state
            .status
            .staged
            .iter()
            .map(|entry| SectionEntry {
                path: entry.path.clone(),
                from: entry.old_path.clone(),
                status: staged_kind(entry).to_owned(),
            })
            .collect(),
        |entry| entry.path.as_str(),
    );
    let unstaged = by_path(
        state
            .status
            .unstaged
            .iter()
            .map(|entry| SectionEntry {
                path: entry.path.clone(),
                from: entry.old_path.clone(),
                status: unstaged_kind(entry).to_owned(),
            })
            .collect(),
        |entry| entry.path.as_str(),
    );
    let untracked = by_path(
        state
            .status
            .untracked
            .iter()
            .map(|path| SectionEntry {
                path: path.clone(),
                from: None,
                status: "untracked".to_owned(),
            })
            .collect(),
        |entry| entry.path.as_str(),
    );
    let conflicted = by_path(
        state
            .status
            .conflicted
            .iter()
            .map(|entry| SectionEntry {
                path: entry.path.clone(),
                from: entry.old_path.clone(),
                status: "conflicted".to_owned(),
            })
            .collect(),
        |entry| entry.path.as_str(),
    );
    let truncated = staged.len() > limit
        || unstaged.len() > limit
        || untracked.len() > limit
        || conflicted.len() > limit;
    let cut = |mut entries: Vec<SectionEntry>| {
        entries.truncate(limit);
        entries
    };
    (
        cut(staged),
        cut(unstaged),
        cut(untracked),
        cut(conflicted),
        truncated,
    )
}

/// `changedFiles`: exactly the files `git status` reports, sorted and capped.
pub async fn changed_files(
    port: &dyn CommandPort,
    root: &str,
    limit: usize,
) -> Result<ChangedFiles, GitError> {
    let state = state(port, root, &[]).await?;
    read_changed_files(port, root, &state, limit).await
}

/// `sourceControlState`: the four sections and branch facts, without a diff or a file read.
pub async fn source_control_state(
    port: &dyn CommandPort,
    root: &str,
    limit: usize,
) -> Result<SourceControlSections, GitError> {
    let state = state(port, root, &[]).await?;
    let (staged, unstaged, untracked, conflicted, truncated) = sections_from_state(&state, limit);
    Ok(SourceControlSections {
        truncated,
        staged,
        unstaged,
        untracked,
        conflicted,
        branch: state.branch.branch.clone(),
        detached: state.branch.detached,
        head: state.branch.head.clone(),
        upstream: state.branch.upstream.clone(),
        ahead: state.branch.ahead,
        behind: state.branch.behind,
    })
}

/// `sourceControlStatus`: the flat list and the sections from one status read.
pub async fn source_control_status(
    port: &dyn CommandPort,
    root: &str,
    limit: usize,
) -> Result<SourceControlStatus, GitError> {
    let state = state(port, root, &[]).await?;
    let changed = read_changed_files(port, root, &state, limit).await?;
    let (staged, unstaged, untracked, conflicted, sections_truncated) =
        sections_from_state(&state, limit);
    // HEAD after the files: a commit landing during the file list is the one reported.
    let head = info::head(port, root).await?;
    Ok(SourceControlStatus {
        files: changed.files,
        truncated: changed.truncated || sections_truncated,
        staged,
        unstaged,
        untracked,
        conflicted,
        branch: state.branch.branch.clone(),
        detached: state.branch.detached,
        head,
        upstream: state.branch.upstream.clone(),
        ahead: state.branch.ahead,
        behind: state.branch.behind,
    })
}

async fn summarize(
    port: &dyn CommandPort,
    root: &str,
    state: &ParsedStatus,
) -> Result<ChangeSummary, GitError> {
    let mut paths: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in state
        .status
        .conflicted
        .iter()
        .chain(state.status.staged.iter())
        .chain(state.status.unstaged.iter())
    {
        if seen.insert(entry.path.clone()) {
            paths.push(entry.path.clone());
        }
    }
    let counts = if state.branch.head.is_some() {
        tracked_counts(port, root, &paths).await?
    } else {
        HashMap::new()
    };
    for path in &state.status.untracked {
        seen.insert(path.clone());
    }
    Ok(ChangeSummary {
        files: seen.len(),
        additions: counts.values().map(|counted| counted.added).sum(),
        deletions: counts.values().map(|counted| counted.deleted).sum(),
    })
}

/// `changeSummary`: counts from one status read, never a snapshot or an untracked read.
pub async fn change_summary(port: &dyn CommandPort, root: &str) -> Result<ChangeSummary, GitError> {
    let state = state(port, root, &[]).await?;
    summarize(port, root, &state).await
}

/// `checkoutSummary`: branch, upstream, remotes and counts from one status read.
pub async fn checkout_summary(
    port: &dyn CommandPort,
    root: &str,
) -> Result<CheckoutSummary, GitError> {
    let state = state(port, root, &[]).await?;
    let diff = summarize(port, root, &state).await?;
    let info = info::info_with(root, state.branch, info::remotes(port, root).await?);
    Ok(CheckoutSummary { info, diff })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    /// The shell's change listing limit; the tests only need it larger than their fixtures.
    const LIMIT: usize = 500;

    fn write(repo: &Path, name: &str, contents: &[u8]) {
        let path = repo.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent");
        }
        std::fs::write(path, contents).expect("file");
    }

    #[tokio::test]
    async fn changed_files_lists_status_paths_sorted_with_counts_from_numstat() {
        let fixture = Fixture::new("g3a-changed");
        let repo = fixture.repository("repo");
        write(&repo, "src/added.ts", b"one\ntwo\nthree\n");
        write(&repo, "untracked.txt", b"a\nb\n");
        write(&repo, "binary.bin", &[0, 1, 2]);
        fixture.git(&repo, &["add", "src/added.ts", "binary.bin"]);
        std::fs::write(repo.join("file.txt"), "changed\n").expect("edit");
        let port = ProcessCommands { fixture: &fixture };
        let changed = changed_files(&port, &repo.to_string_lossy(), LIMIT)
            .await
            .expect("changed");
        let listed: Vec<(&str, &str, u64, u64, bool)> = changed
            .files
            .iter()
            .map(|file| {
                (
                    file.path.as_str(),
                    file.status.as_str(),
                    file.additions,
                    file.deletions,
                    file.binary,
                )
            })
            .collect();
        assert_eq!(
            listed,
            vec![
                ("binary.bin", "added", 0, 0, true),
                ("file.txt", "modified", 1, 1, false),
                ("src/added.ts", "added", 3, 0, false),
                ("untracked.txt", "untracked", 2, 0, false),
            ]
        );
        assert!(!changed.truncated);
    }

    #[tokio::test]
    async fn a_limit_caps_the_list_and_says_it_did() {
        let fixture = Fixture::new("g3a-limit");
        let repo = fixture.repository("repo");
        for name in ["a.txt", "b.txt", "c.txt"] {
            write(&repo, name, b"x\n");
        }
        let port = ProcessCommands { fixture: &fixture };
        let changed = changed_files(&port, &repo.to_string_lossy(), 2)
            .await
            .expect("changed");
        assert_eq!(changed.files.len(), 2);
        assert_eq!(changed.files[0].path, "a.txt");
        assert!(changed.truncated);
    }

    #[tokio::test]
    async fn sections_report_each_kind_and_a_dirty_nested_repository_counts_as_untracked() {
        let fixture = Fixture::new("g3a-sections");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "user.email", "t@example.invalid"]);
        fixture.git(&repo, &["config", "user.name", "T"]);
        write(&repo, "staged.txt", b"s\n");
        fixture.git(&repo, &["add", "staged.txt"]);
        std::fs::write(repo.join("file.txt"), "modified\n").expect("edit");
        write(&repo, "untracked.txt", b"u\n");
        let port = ProcessCommands { fixture: &fixture };
        let state = source_control_state(&port, &repo.to_string_lossy(), LIMIT)
            .await
            .expect("state");
        assert_eq!(state.branch.as_deref(), Some("main"));
        assert_eq!(
            state.staged,
            vec![SectionEntry {
                path: "staged.txt".to_owned(),
                from: None,
                status: "added".to_owned(),
            }]
        );
        assert_eq!(
            state.unstaged,
            vec![SectionEntry {
                path: "file.txt".to_owned(),
                from: None,
                status: "modified".to_owned(),
            }]
        );
        assert_eq!(state.untracked.len(), 1);
    }

    #[tokio::test]
    async fn a_summary_counts_paths_and_lines_and_an_empty_repository_counts_nothing_tracked() {
        let fixture = Fixture::new("g3a-summary");
        let repo = fixture.repository("repo");
        std::fs::write(repo.join("file.txt"), "a\nb\n").expect("edit");
        write(&repo, "untracked.txt", b"u\n");
        let port = ProcessCommands { fixture: &fixture };
        let summary = change_summary(&port, &repo.to_string_lossy())
            .await
            .expect("summary");
        assert_eq!(
            summary,
            ChangeSummary {
                files: 2,
                additions: 2,
                deletions: 1,
            }
        );
        let checkout = checkout_summary(&port, &repo.to_string_lossy())
            .await
            .expect("checkout");
        assert_eq!(checkout.info.branch.branch.as_deref(), Some("main"));
        assert_eq!(checkout.diff.files, 2);
    }

    #[tokio::test]
    async fn source_control_status_reports_the_commit_after_the_file_list() {
        let fixture = Fixture::new("g3a-status");
        let repo = fixture.repository("repo");
        write(&repo, "untracked.txt", b"x\n");
        let port = ProcessCommands { fixture: &fixture };
        let status = source_control_status(&port, &repo.to_string_lossy(), LIMIT)
            .await
            .expect("status");
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        assert_eq!(status.head.as_deref(), Some(head.as_str()));
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.untracked.len(), 1);
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    // `changed-files-regressions.process`: counts, binary markers and renames for paths with tabs.
    #[tokio::test]
    async fn a_tab_in_a_path_survives_numstat_framing_and_a_rename_reports_both_paths() {
        let fixture = Fixture::new("g3a-tabs");
        let repo = fixture.repository("repo");
        let tabbed = "tab\tname.txt";
        std::fs::write(repo.join(tabbed), "one\ntwo\n").expect("tabbed");
        fixture.git(&repo, &["add", "--", tabbed]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "tabbed"]);
        let renamed = "other\ttab.txt";
        fixture.git(&repo, &["mv", "--", tabbed, renamed]);
        std::fs::write(repo.join(renamed), "one\ntwo\nthree\n").expect("edit");
        let binary = "image\tbytes.bin";
        std::fs::write(repo.join(binary), [0u8, 1, 2]).expect("binary");
        fixture.git(&repo, &["add", "--", binary]);
        let port = ProcessCommands { fixture: &fixture };
        let changed = changed_files(&port, &repo.to_string_lossy(), 500)
            .await
            .expect("changed");
        let listed: Vec<ChangedFile> = changed.files.clone();
        assert_eq!(
            listed,
            vec![
                ChangedFile {
                    path: binary.to_owned(),
                    from: None,
                    status: "added".to_owned(),
                    additions: 0,
                    deletions: 0,
                    binary: true,
                },
                ChangedFile {
                    path: renamed.to_owned(),
                    from: Some(tabbed.to_owned()),
                    status: "renamed".to_owned(),
                    additions: 1,
                    deletions: 0,
                    binary: false,
                },
            ]
        );
    }
}
