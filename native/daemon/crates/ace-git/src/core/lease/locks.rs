// SPDX-License-Identifier: Apache-2.0
//! Git's own lock files that a killed or crashed Git process left behind
//! (`packages/git/src/git-locks.ts`). Removal needs a lock older than the
//! grace and no live Git process that could have written it.

use std::path::Path;

use crate::core::error::GitError;
use crate::core::lease::Scan;
use crate::core::lease::journal::{metadata_directory, text};
use crate::core::lease::processes::{GitProcess, touches};
use crate::core::paths::{canonical, resolve};

/// A Git lock file younger than this may belong to a command that is just starting.
pub const LOCK_GRACE_MS: i64 = 2_000;
/// How far a lock's recorded mtime and a process's estimated start may each be off.
pub const TIMESTAMP_SLACK_MS: i64 = 5_000;

/// One checkout of a repository: its own metadata directory and, when it has one, its files.
struct Checkout {
    metadata: String,
    path: Option<String>,
    linked: bool,
}

/// The repository's shared metadata directory for `checkout`, canonical; `None` if none.
pub fn git_common_directory(checkout: &str) -> Option<String> {
    let metadata = metadata_directory(checkout).ok().flatten()?;
    let common = canonical(&metadata).ok()?;
    let shared = text(&Path::new(&common).join("commondir")).ok().flatten();
    match shared {
        Some(shared) => canonical(&resolve(&common, shared.trim_end_matches('\n'))).ok(),
        None => Some(common),
    }
}

fn checkouts(common: &str) -> Vec<Checkout> {
    let mut result = vec![Checkout {
        metadata: common.to_owned(),
        path: Path::new(common)
            .file_name()
            .filter(|name| *name == ".git")
            .and_then(|_| Path::new(common).parent())
            .map(|path| path.to_string_lossy().into_owned()),
        linked: false,
    }];
    let names = std::fs::read_dir(Path::new(common).join("worktrees"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .take(1024)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for name in names {
        let metadata = Path::new(common).join("worktrees").join(&name);
        let metadata_text = metadata.to_string_lossy().into_owned();
        let back = text(&metadata.join("gitdir")).ok().flatten();
        let path = back.and_then(|back| {
            let resolved = resolve(&metadata_text, back.trim());
            Path::new(&resolved)
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned())
        });
        result.push(Checkout {
            metadata: metadata_text,
            path,
            linked: true,
        });
    }
    result
}

/// `refs/**/*.lock`, bounded so a huge ref tree can't stall the caller.
fn ref_locks(directory: &Path, found: &mut Vec<String>, depth: usize) {
    if depth > 8 || found.len() > 256 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            ref_locks(&path, found, depth + 1);
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(".lock") {
            found.push(path.to_string_lossy().into_owned());
        }
    }
}

/// A lock file and the checkouts whose Git processes may hold it.
struct Candidate {
    file: String,
    roots: Vec<String>,
}

fn candidates(common: &str, all: &[Checkout]) -> Vec<Candidate> {
    let mut found: Vec<Candidate> = Vec::new();
    for entry in all {
        let Some(path) = entry.path.as_ref() else {
            continue;
        };
        let roots = vec![path.clone()];
        found.push(Candidate {
            file: Path::new(&entry.metadata)
                .join("index.lock")
                .to_string_lossy()
                .into_owned(),
            roots: roots.clone(),
        });
        found.push(Candidate {
            file: Path::new(&entry.metadata)
                .join("HEAD.lock")
                .to_string_lossy()
                .into_owned(),
            roots: roots.clone(),
        });
        // A partial commit's temporary index, named after the Git process that wrote it.
        if let Ok(entries) = std::fs::read_dir(&entry.metadata) {
            for file in entries.filter_map(Result::ok) {
                let name = file.file_name().to_string_lossy().into_owned();
                if let Some(rest) = name.strip_prefix("next-index-")
                    && rest.ends_with(".lock")
                    && rest
                        .trim_end_matches(".lock")
                        .chars()
                        .all(|c| c.is_ascii_digit())
                {
                    found.push(Candidate {
                        file: Path::new(&entry.metadata)
                            .join(&name)
                            .to_string_lossy()
                            .into_owned(),
                        roots: roots.clone(),
                    });
                }
            }
        }
    }
    let everywhere: Vec<String> = std::iter::once(common.to_owned())
        .chain(
            all.iter()
                .filter_map(|entry| entry.path.clone())
                .collect::<Vec<_>>(),
        )
        .collect();
    for name in ["packed-refs.lock", "shallow.lock", "config.lock"] {
        found.push(Candidate {
            file: Path::new(common).join(name).to_string_lossy().into_owned(),
            roots: everywhere.clone(),
        });
    }
    let mut refs = Vec::new();
    ref_locks(&Path::new(common).join("refs"), &mut refs, 0);
    for file in refs {
        found.push(Candidate {
            file,
            roots: everywhere.clone(),
        });
    }
    for entry in all.iter().filter(|entry| entry.linked) {
        // `worktree add` writes "initializing" while it runs; a person's own lock has their reason.
        let file = Path::new(&entry.metadata).join("locked");
        let reason = text(&file).ok().flatten();
        if reason.as_deref().map(str::trim) == Some("initializing") {
            found.push(Candidate {
                file: file.to_string_lossy().into_owned(),
                roots: everywhere.clone(),
            });
        }
    }
    found
}

/// Whether `process` may hold a lock stamped `written`.
fn may_hold(process: &GitProcess, written_ms: i64) -> bool {
    process
        .started_at
        .is_none_or(|started| started <= written_ms + TIMESTAMP_SLACK_MS)
}

/// A plain file's modification time in epoch milliseconds.
fn written_ms(file: &str) -> Option<i64> {
    let info = std::fs::symlink_metadata(file).ok()?;
    if !info.is_file() {
        return None;
    }
    let modified = info.modified().ok()?;
    let since = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(since as i64)
}

/// Removes `file` only if it is a plain file last written before `before` that
/// none of the live Git processes working where it guards could have written.
fn remove_stale(file: &str, before_ms: i64, holders: &[GitProcess]) -> bool {
    let Some(stamp) = written_ms(file) else {
        return false;
    };
    if stamp >= before_ms {
        return false;
    }
    if holders.iter().any(|entry| may_hold(entry, stamp)) {
        return false;
    }
    std::fs::remove_file(file).is_ok()
}

fn stale_before(file: &str, before_ms: i64) -> bool {
    written_ms(file).is_some_and(|stamp| stamp < before_ms)
}

/// Git's own lock files a killed or crashed Git process left behind in the
/// repository that owns `checkout`. `scan` must list processes as they are
/// after `before`; without a listing nothing is removed. Returns the removed paths.
pub async fn clear_leftover_locks(
    checkout: &str,
    scan: &Scan<'_>,
    before_ms: i64,
) -> Result<Vec<String>, GitError> {
    let Some(common) = git_common_directory(checkout) else {
        return Ok(Vec::new());
    };
    let all = checkouts(&common);
    let stale: Vec<Candidate> = candidates(&common, &all)
        .into_iter()
        .filter(|candidate| stale_before(&candidate.file, before_ms))
        .collect();
    if stale.is_empty() {
        return Ok(Vec::new());
    }
    let Some(processes) = scan.get().await else {
        return Ok(Vec::new());
    };
    let mut removed = Vec::new();
    for candidate in stale {
        let working: Vec<GitProcess> = processes
            .iter()
            .filter(|entry| touches(entry, &candidate.roots))
            .cloned()
            .collect();
        if remove_stale(&candidate.file, before_ms, &working) {
            removed.push(candidate.file);
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(name: &str) -> String {
        let path =
            std::env::temp_dir().join(format!("ace-g2b-locks-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(Path::new(&path).join(".git").join("refs").join("heads"))
            .expect("repository");
        // Canonical, as every lease path is (macOS maps /var to /private/var).
        canonical(&path.to_string_lossy()).expect("canonical")
    }

    fn lock(file: &str, written: i64) {
        fs::create_dir_all(Path::new(file).parent().expect("parent")).expect("parent");
        fs::write(file, "").expect("lock");
        let stamp = UNIX_EPOCH + std::time::Duration::from_millis(written as u64);
        let file = fs::File::options()
            .write(true)
            .open(file)
            .expect("open lock");
        file.set_modified(stamp).expect("mtime");
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64
    }

    #[tokio::test]
    async fn a_stale_lock_no_live_git_could_have_written_is_removed() {
        let repo = scratch("stale");
        let lock_file = format!("{repo}/.git/index.lock");
        lock(&lock_file, now_ms() - 60_000);
        let ports = crate::core::lease::TestPorts {
            listing: Some(vec![GitProcess {
                pid: 1,
                cwd: Some(repo.clone()),
                checkout: Some(repo.clone()),
                started_at: Some(now_ms() - 30_000),
                git_group: Some(true),
            }]),
            ..crate::core::lease::TestPorts::default()
        };
        let removed = clear_leftover_locks(&repo, &Scan::new(&ports), now_ms())
            .await
            .expect("sweep");
        assert_eq!(removed, vec![lock_file.clone()]);
        assert!(!Path::new(&lock_file).exists());
        let _ = fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn a_lock_within_the_timestamp_slack_of_a_live_writer_stays() {
        let repo = scratch("slack");
        let lock_file = format!("{repo}/.git/index.lock");
        let stamp = now_ms() - 60_000;
        lock(&lock_file, stamp);
        // The writer started 1.8 s after the stored stamp: a coarse filesystem rounded it.
        let ports = crate::core::lease::TestPorts {
            listing: Some(vec![GitProcess {
                pid: 1,
                cwd: Some(repo.clone()),
                checkout: Some(repo.clone()),
                started_at: Some(stamp + 1_800),
                git_group: Some(true),
            }]),
            ..crate::core::lease::TestPorts::default()
        };
        let removed = clear_leftover_locks(&repo, &Scan::new(&ports), now_ms())
            .await
            .expect("sweep");
        assert!(removed.is_empty());
        assert!(Path::new(&lock_file).exists());
        let _ = fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn without_a_process_listing_nothing_is_removed() {
        let repo = scratch("no-listing");
        let lock_file = format!("{repo}/.git/index.lock");
        lock(&lock_file, now_ms() - 60_000);
        let ports = crate::core::lease::TestPorts {
            listing: None,
            ..crate::core::lease::TestPorts::default()
        };
        let removed = clear_leftover_locks(&repo, &Scan::new(&ports), now_ms())
            .await
            .expect("sweep");
        assert!(removed.is_empty());
        assert!(Path::new(&lock_file).exists());
        let _ = fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn a_fresh_lock_is_left_alone_without_a_process_listing() {
        let repo = scratch("fresh");
        let lock_file = format!("{repo}/.git/index.lock");
        lock(&lock_file, now_ms() - 1_000);
        let ports = crate::core::lease::TestPorts::default();
        // The sweep's grace: a lock written a second ago is far younger.
        let removed = clear_leftover_locks(&repo, &Scan::new(&ports), now_ms() - 60_000)
            .await
            .expect("sweep");
        assert!(removed.is_empty());
        let _ = fs::remove_dir_all(&repo);
    }
}
