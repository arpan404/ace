//! Source-control reads over one status read (`packages/git/src/changed-files.ts`, G3a):
//! `changedFiles`, `sourceControlState`, `sourceControlStatus`, `changeSummary` and
//! `checkoutSummary`. A read: no object, index or checkpoint is written, and only the listed
//! files are diffed or read.
//!
//! Proof: `changed-files-regressions.process`, `repository.process` and `checkout-paths.process`.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::core::decode::{Records, malformed, nul};
use crate::core::error::GitError;
use crate::parse::numstat::numstat_record;
use crate::parse::status::StatusEntry;
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

/// The flat file list and whether it was capped.
pub mod files;
pub mod summary;

use files::{read_changed_files, sections_from_state};

pub use summary::{ChangeSummary, CheckoutSummary, change_summary, checkout_summary};

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

#[cfg(test)]
mod tests;
