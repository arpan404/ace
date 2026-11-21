// SPDX-License-Identifier: Apache-2.0

//! `safeOpen`: a session file is opened only inside its registered home, through no symlink, as
//! a regular file. The walk goes through `files-safe` (native/files): every component is looked
//! up relative to the folder handle above it with no link followed, so a folder swapped for a
//! link after any check cannot redirect the open outside the home.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use files_safe::Root;

use crate::error::{Error, Result, io_at};
use crate::paths::contains;

const ESCAPED: &str = "Session path escaped its registered home";
const LINKED: &str = "Session path contains a symlink";

/// One opened root per home: opening one canonicalizes the home and holds a handle on it, and
/// every walk from it proves first that the home path still names that folder.
static ROOTS: LazyLock<Mutex<HashMap<PathBuf, Root>>> = LazyLock::new(Mutex::default);

fn root(home: &Path) -> Result<Root> {
    let mut roots = ROOTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(root) = roots.get(home) {
        return Ok(root.clone());
    }
    let root = Root::open(home).map_err(|e| refused(e, home))?;
    roots.insert(home.to_owned(), root.clone());
    Ok(root)
}

fn refused(error: files_safe::Error, path: &Path) -> Error {
    match error {
        files_safe::Error::PathEscape(_) => Error::message(LINKED),
        files_safe::Error::PathChanged(_) => Error::message(ESCAPED),
        files_safe::Error::NotDirectory(_) => {
            Error::message("Session directory is not a real directory")
        }
        files_safe::Error::LimitExceeded(_) => Error::message("Session path depth limit exceeded"),
        files_safe::Error::Io(io) => io_at(io, path),
        other => Error::message(other.to_string()),
    }
}

/// `path` below `home` in the `/`-separated relative form.
fn relative(home: &Path, path: &Path) -> Result<String> {
    let rest = path
        .strip_prefix(home)
        .map_err(|_| Error::message(ESCAPED))?;
    let mut parts = Vec::new();
    for part in rest.components() {
        match part {
            Component::Normal(name) => {
                parts.push(name.to_str().ok_or_else(|| Error::message(ESCAPED))?)
            }
            _ => return Err(Error::message(ESCAPED)),
        }
    }
    if parts.len() > 32 {
        return Err(Error::message("Session path depth limit exceeded"));
    }
    if parts.is_empty() {
        return Err(Error::message("Session source is not a regular file"));
    }
    Ok(parts.join("/"))
}

pub fn safe_open(home: &Path, path: &Path) -> Result<File> {
    if !contains(home, path) {
        return Err(Error::message(ESCAPED));
    }
    let rel = relative(home, path)?;
    crate::hooks::at_path("safe-open", &rel);
    let root = root(home)?;
    let parent = root
        .open_parent_unlinked(&rel)
        .map_err(|e| refused(e, path))?;
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        // A FIFO swapped in never blocks the open.
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match parent.dir.open_with(&parent.name, &options) {
        Ok(file) => file.into_std(),
        // ELOOP: the leaf itself is a link.
        #[cfg(unix)]
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(Error::message(LINKED));
        }
        Err(error) => return Err(io_at(error, path)),
    };
    let meta = file.metadata()?;
    if meta.file_type().is_symlink() {
        return Err(Error::message(LINKED));
    }
    if !meta.is_file() {
        return Err(Error::message("Session source is not a regular file"));
    }
    crate::hooks::read(path);
    Ok(file)
}

#[cfg(all(test, unix))]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn a_file_inside_the_home_opens() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("projects/p")).unwrap();
        std::fs::write(home.path().join("projects/p/a.jsonl"), "{}\n").unwrap();
        assert!(safe_open(home.path(), &home.path().join("projects/p/a.jsonl")).is_ok());
    }

    #[test]
    fn a_folder_replaced_by_a_link_out_of_the_home_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("projects/p")).unwrap();
        std::fs::write(home.path().join("projects/p/a.jsonl"), "{}\n").unwrap();
        std::fs::write(outside.path().join("a.jsonl"), "secret\n").unwrap();
        // Opened once, so the home's root is held, then the checked folder is swapped.
        assert!(safe_open(home.path(), &home.path().join("projects/p/a.jsonl")).is_ok());
        std::fs::rename(home.path().join("projects/p"), home.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("projects/p")).unwrap();
        let error = safe_open(home.path(), &home.path().join("projects/p/a.jsonl")).unwrap_err();
        assert_eq!(error.to_string(), LINKED);
    }

    #[test]
    fn a_leaf_link_is_refused_even_inside_the_home() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("p")).unwrap();
        std::fs::write(home.path().join("p/real.jsonl"), "{}\n").unwrap();
        std::os::unix::fs::symlink(
            home.path().join("p/real.jsonl"),
            home.path().join("p/l.jsonl"),
        )
        .unwrap();
        let error = safe_open(home.path(), &home.path().join("p/l.jsonl")).unwrap_err();
        assert_eq!(error.to_string(), LINKED);
    }

    #[test]
    fn a_path_outside_the_home_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let error = safe_open(home.path(), Path::new("/etc/hosts")).unwrap_err();
        assert_eq!(error.to_string(), ESCAPED);
    }
}
