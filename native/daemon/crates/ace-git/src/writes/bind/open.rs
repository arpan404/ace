// SPDX-License-Identifier: Apache-2.0
//! Directory-relative opens with O_NOFOLLOW for guarded working-tree writes.

use std::path::{Component, Path};

use rustix::fd::AsFd;
use rustix::fs::OFlags;
use sha2::{Digest, Sha256};

use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;

fn head_moved(message: impl Into<String>) -> GitError {
    GitError::new(GitErrorCode::HeadMoved, message.into())
}

#[cfg(unix)]
fn open_nofollow_at(
    root: rustix::fd::BorrowedFd<'_>,
    relative: &str,
    write: bool,
) -> Result<rustix::fd::OwnedFd, GitError> {
    use rustix::fs::{Mode, openat};
    let mut flags = OFlags::CLOEXEC | OFlags::NOFOLLOW;
    if write {
        flags |= OFlags::RDWR;
    } else {
        flags |= OFlags::RDONLY;
    }
    let parts: Vec<_> = Path::new(relative)
        .components()
        .filter(|part| !matches!(part, Component::CurDir))
        .collect();
    if parts.is_empty() {
        return Err(head_moved("Missing path"));
    }
    let mut current = root;
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err(head_moved("Path left the checkout"));
        };
        let last = index + 1 == parts.len();
        if last {
            return openat(current, name, flags, Mode::empty())
                .map_err(|error| GitError::from_io(&error));
        }
        current = openat(
            current,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| GitError::from_io(&error))?
        .as_fd();
    }
    Err(head_moved("Missing path"))
}

#[cfg(not(unix))]
fn open_nofollow_at(
    _root: rustix::fd::BorrowedFd<'_>,
    _relative: &str,
    _write: bool,
) -> Result<rustix::fd::OwnedFd, GitError> {
    Err(GitError::new(
        GitErrorCode::InvalidArgument,
        "Guarded opens require a Unix host",
    ))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Read a regular file and verify its SHA-256 revision.
pub fn verify_worktree_revision(root: &str, path: &str, revision: &str) -> Result<(), GitError> {
    let root = paths::canonical(root).unwrap_or_else(|_| root.to_owned());
    #[cfg(unix)]
    {
        use rustix::fs::{Mode, open};
        let checkout = open(
            &root,
            OFlags::PATH | OFlags::CLOEXEC | OFlags::DIRECTORY,
            Mode::empty(),
        )
        .map_err(|error| GitError::from_io(&error))?;
        let file = open_nofollow_at(checkout.as_fd(), path, false)?;
        let metadata = rustix::fs::fstat(&file).map_err(|error| GitError::from_io(&error))?;
        if !metadata.is_file() {
            return Err(head_moved(format!(
                "{path} changed since it was read; refresh first"
            )));
        }
        let mut file = std::fs::File::from(file);
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut bytes)
            .map_err(|error| GitError::from_io(&error))?;
        if digest(&bytes) != revision {
            return Err(head_moved(format!(
                "{path} changed since it was read; refresh first"
            )));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (root, path, revision);
        Err(GitError::new(
            GitErrorCode::InvalidArgument,
            "Guarded opens require a Unix host",
        ))
    }
}

/// Write `content` after another revision check on the same open path.
pub fn write_worktree_verified(
    root: &str,
    path: &str,
    revision: &str,
    content: &[u8],
) -> Result<(), GitError> {
    verify_worktree_revision(root, path, revision)?;
    let root = paths::canonical(root).unwrap_or_else(|_| root.to_owned());
    #[cfg(unix)]
    {
        use rustix::fs::{Mode, open};
        use std::io::{Seek, SeekFrom, Write};
        let checkout = open(
            &root,
            OFlags::PATH | OFlags::CLOEXEC | OFlags::DIRECTORY,
            Mode::empty(),
        )
        .map_err(|error| GitError::from_io(&error))?;
        let file = open_nofollow_at(checkout.as_fd(), path, true)?;
        verify_worktree_revision(root, path, revision)?;
        let mut file = std::fs::File::from(file);
        file.seek(SeekFrom::Start(0))
            .map_err(|error| GitError::from_io(&error))?;
        file.set_len(0).map_err(|error| GitError::from_io(&error))?;
        file.write_all(content)
            .map_err(|error| GitError::from_io(&error))?;
        file.sync_data().map_err(|error| GitError::from_io(&error))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (root, path, revision, content);
        Err(GitError::new(
            GitErrorCode::InvalidArgument,
            "Guarded opens require a Unix host",
        ))
    }
}