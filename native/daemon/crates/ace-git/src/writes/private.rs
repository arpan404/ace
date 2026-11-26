// SPDX-License-Identifier: Apache-2.0
//! ace's own entries in a checkout (`ace-private.ts`, G4a): `.ace-upload-*` names are ace's
//! files service, never the person's changes, and every add here excludes them. The local
//! `info/exclude` entry keeps them out of the person's own `git add -A`, stashes and checkpoints.
//!
//! Proof: `source-control-ops.process` and `client-actions.process`'s private-entry cases.

use std::path::Path;

use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::reads::{Command, CommandPort, checked};

/// The exclude pattern ace keeps in the repository's local `info/exclude`, never committed.
pub const ACE_PRIVATE_PATTERN: &str = ".ace-upload-*";

/// Name ace's private entries in the repository's local exclude. Idempotent.
pub async fn exclude_ace_private(
    port: &dyn CommandPort,
    root: &str,
    is_windows: bool,
) -> Result<(), GitError> {
    let common = checked(
        port,
        Command::new(
            root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ),
    )
    .await?;
    let exclude = checked(
        port,
        Command::new(
            root,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "info/exclude",
            ],
        ),
    )
    .await?;
    if common.truncated || exclude.truncated || common.exit_code != 0 || exclude.exit_code != 0 {
        return Ok(());
    }
    let Some(common_dir) = single_git_path(&common.stdout, is_windows) else {
        return Ok(());
    };
    let Some(exclude_path) = single_git_path(&exclude.stdout, is_windows) else {
        return Ok(());
    };
    if common_dir.is_empty() || exclude_path.is_empty() {
        return Ok(());
    }
    let path = if Path::new(&exclude_path).is_absolute() {
        exclude_path
    } else {
        paths::resolve(root, &exclude_path)
    };
    let Some(git_dir) = paths::canonical(&common_dir).ok() else {
        return Ok(());
    };
    if !plain_inside(&git_dir, &path) {
        return Ok(());
    }
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.split('\n').any(|line| line == ACE_PRIVATE_PATTERN) {
        return Ok(());
    }
    let separator = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|error| GitError::from_io(&error))?;
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| GitError::from_io(&error))?;
    file.write_all(
        format!("{separator}# ace: uploads and Recently deleted\n{ACE_PRIVATE_PATTERN}\n")
            .as_bytes(),
    )
    .map_err(|error| GitError::from_io(&error))?;
    Ok(())
}

/// One `rev-parse` path: strict UTF-8, exactly one platform terminator stripped.
fn single_git_path(bytes: &[u8], is_windows: bool) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let stripped = if is_windows && text.ends_with("\r\n") {
        &text[..text.len() - 2]
    } else if text.ends_with('\n') {
        &text[..text.len() - 1]
    } else {
        text
    };
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_owned())
    }
}

fn absent(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}

/// `folder` and `file` are no symlinks (or absent), and `folder` resolves inside `git_dir`.
fn plain_inside(git_dir: &str, file: &str) -> bool {
    let Some(folder) = Path::new(file).parent() else {
        return false;
    };
    for path in [folder, Path::new(file)] {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.is_symlink() {
                    return false;
                }
                let is_folder = path == folder;
                if (is_folder && !metadata.is_dir()) || (!is_folder && !metadata.is_file()) {
                    return false;
                }
            }
            Err(error) if absent(&error) => {}
            Err(_) => return false,
        }
    }
    let Some(parent) = folder.parent() else {
        return false;
    };
    let Ok(real_parent) = paths::canonical(&parent.to_string_lossy()) else {
        return false;
    };
    let joined = paths::resolve(&real_parent, &folder.to_string_lossy());
    paths::within(git_dir, &joined) && paths::normalise(Path::new(&joined)) != git_dir
}

/// The error a failed exclude write would surface as; callers never fail a commit on it.
pub fn exclude_error(message: &str) -> GitError {
    GitError::new(GitErrorCode::FilesystemError, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    #[tokio::test]
    async fn the_local_exclude_gains_the_pattern_once_and_never_committed_it() {
        let fixture = Fixture::new("g4a-exclude");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        exclude_ace_private(&port, &root, false)
            .await
            .expect("exclude");
        exclude_ace_private(&port, &root, false)
            .await
            .expect("again");
        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).expect("written");
        assert_eq!(
            exclude
                .lines()
                .filter(|line| *line == ACE_PRIVATE_PATTERN)
                .count(),
            1
        );
        assert!(exclude.contains("# ace: uploads and Recently deleted"));
        // It is the repository's own state, not a tracked file.
        let status = crate::reads::status::state(&port, &root, &[])
            .await
            .expect("status");
        assert!(status.status.untracked.is_empty());
    }
}
