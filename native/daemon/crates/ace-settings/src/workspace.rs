// SPDX-License-Identifier: Apache-2.0
//! Workspace containment (`workspace.ts`): a workspace root is pinned to the identity it had
//! when first read, a `.ace/settings.json` may not cross a symlink, and both facts are
//! rechecked before every read and again before a write commits.
//!
//! The filesystem facts are read through [`WorkspaceFs`], so a caller can substitute the
//! edges and a test can watch a path being replaced.

use std::cell::RefCell;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use crate::validation::{SettingsCode, SettingsError};

/// How many workspace roots keep their identity pinned between settings files.
const PINNED_ROOTS: usize = 64;

/// A file's identity, as `stat` reports it (`dev` and `ino`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
}

/// The filesystem facts a guard reads.
pub trait WorkspaceFs {
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf>;
    fn identity(&self, path: &Path) -> std::io::Result<FileIdentity>;
    /// Whether `path` is a symlink; `None` when it does not exist.
    fn is_symlink(&self, path: &Path) -> std::io::Result<Option<bool>>;
}

/// The real filesystem.
pub struct RealWorkspaceFs;

impl WorkspaceFs for RealWorkspaceFs {
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        std::fs::canonicalize(path)
    }

    fn identity(&self, path: &Path) -> std::io::Result<FileIdentity> {
        std::fs::metadata(path).map(|metadata| identity_of(&metadata))
    }

    fn is_symlink(&self, path: &Path) -> std::io::Result<Option<bool>> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => Ok(Some(metadata.file_type().is_symlink())),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(unix)]
fn identity_of(metadata: &std::fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

/// Without device and inode numbers the canonical path alone identifies the root.
#[cfg(not(unix))]
fn identity_of(_metadata: &std::fs::Metadata) -> FileIdentity {
    FileIdentity {
        device: 0,
        inode: 0,
    }
}

fn io_error() -> SettingsError {
    SettingsError::new(SettingsCode::Io, "Cannot read or write settings file")
}

fn containment(message: &str) -> SettingsError {
    SettingsError::new(SettingsCode::Validation, message)
}

/// One workspace root, pinned to the identity it had when it was first read.
pub struct WorkspaceGuard {
    root: PathBuf,
    canonical: PathBuf,
    identity: FileIdentity,
    fs: Arc<dyn WorkspaceFs>,
}

impl WorkspaceGuard {
    /// `workspaceGuard`: canonicalize the root and remember its identity.
    pub fn pin(root: &Path, fs: Arc<dyn WorkspaceFs>) -> Result<Self, SettingsError> {
        let canonical = fs.canonicalize(root).map_err(|_| io_error())?;
        let identity = fs.identity(&canonical).map_err(|_| io_error())?;
        Ok(Self {
            root: root.to_path_buf(),
            canonical,
            identity,
            fs,
        })
    }

    /// The check `workspaceGuard` returns: same root, and settings stay inside it.
    pub fn check(&self) -> Result<(), SettingsError> {
        let current = self.fs.identity(&self.root).map_err(|_| io_error())?;
        let canonical = self.fs.canonicalize(&self.root).map_err(|_| io_error())?;
        if canonical != self.canonical || current != self.identity {
            return Err(containment("Workspace root changed during settings access"));
        }
        let ace = self.canonical.join(".ace");
        for path in [ace.clone(), ace.join("settings.json")] {
            let Some(symlink) = self.fs.is_symlink(&path).map_err(|_| io_error())? else {
                break;
            };
            if symlink {
                return Err(containment(
                    "Workspace settings cannot use symlink components",
                ));
            }
            let actual = self.fs.canonicalize(&path).map_err(|_| io_error())?;
            if !actual.starts_with(&self.canonical) {
                return Err(containment(
                    "Workspace settings must stay within the workspace",
                ));
            }
        }
        Ok(())
    }
}

/// The workspace a `<root>/.ace/settings.json` path belongs to, if it has that shape.
pub fn aliased_root(path: &Path) -> Option<PathBuf> {
    if path.file_name()? != "settings.json" {
        return None;
    }
    let ace = path.parent()?;
    if ace.file_name()? != ".ace" {
        return None;
    }
    ace.parent().map(Path::to_path_buf)
}

/// The absolute form of `path`, with `.` and `..` resolved lexically and no symlink followed.
fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Pins each workspace root to the identity it had when first read, least recently used
/// first out. A settings file keeps the pin it was opened with for as long as it is cached.
///
/// A non-workspace settings file (the global one, when ace's data folder is a workspace's
/// `.ace`) borrows that workspace's pin through [`Self::for_file`] and the aliases it names
/// are never dropped, so a reopened alias is still checked against the identity first seen.
pub struct WorkspaceGuards {
    fs: Arc<dyn WorkspaceFs>,
    entries: RefCell<Vec<(PathBuf, Rc<WorkspaceGuard>)>>,
    kept: Vec<PathBuf>,
}

impl WorkspaceGuards {
    pub fn new(fs: Arc<dyn WorkspaceFs>, aliases: &[PathBuf]) -> Self {
        let kept = aliases
            .iter()
            .filter_map(|path| aliased_root(&absolute(path)))
            .collect();
        Self {
            fs,
            entries: RefCell::new(Vec::new()),
            kept,
        }
    }

    /// The pinned guard for the workspace a settings path lives in, when it has one.
    pub fn for_file(&self, path: &Path) -> Option<Rc<WorkspaceGuard>> {
        let root = aliased_root(&absolute(path))?;
        self.entries
            .borrow()
            .iter()
            .find(|(seen, _)| *seen == root)
            .map(|(_, guard)| guard.clone())
    }

    /// The pinned guard for `root`, pinning it afresh after it was dropped.
    pub fn get(&self, root: &Path) -> Result<Rc<WorkspaceGuard>, SettingsError> {
        let path = absolute(root);
        let mut entries = self.entries.borrow_mut();
        if let Some(index) = entries.iter().position(|(seen, _)| *seen == path) {
            let (seen, guard) = entries.remove(index);
            let guard = guard.clone();
            entries.push((seen, guard.clone()));
            return Ok(guard);
        }
        if entries.len() >= PINNED_ROOTS
            && let Some(index) = entries
                .iter()
                .position(|(seen, _)| !self.kept.contains(seen))
        {
            entries.remove(index);
        }
        let guard = Rc::new(WorkspaceGuard::pin(&path, self.fs.clone())?);
        entries.push((path, guard.clone()));
        Ok(guard)
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/settings/src/containment.test.ts`'s guard cases: a root replaced by a
    //! symlink or a new directory is no longer the root that was pinned, a `.ace` or settings
    //! file that is a symlink is refused, and the least recently read root is dropped while
    //! the aliases keep theirs.

    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SERIAL: AtomicUsize = AtomicUsize::new(0);

    /// A fresh scratch directory, unique per test.
    fn scratch(name: &str) -> PathBuf {
        let unique = SERIAL.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ace-settings-workspace-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap_or_else(|error| panic!("{error}"));
        path
    }

    fn fs_port() -> Arc<dyn WorkspaceFs> {
        Arc::new(RealWorkspaceFs)
    }

    #[test]
    fn a_replaced_root_no_longer_matches_the_pinned_identity() {
        let root = scratch("moved");
        let guard = WorkspaceGuard::pin(&root, fs_port()).unwrap_or_else(|error| panic!("{error}"));
        guard.check().unwrap_or_else(|error| panic!("{error}"));

        let old = root.with_extension("old");
        let _ = fs::remove_dir_all(&old);
        fs::rename(&root, &old).unwrap_or_else(|error| panic!("{error}"));
        fs::create_dir_all(&root).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            guard.check().map_err(|error| error.message),
            Err("Workspace root changed during settings access".into())
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&old);
    }

    #[test]
    fn a_symlinked_ace_folder_or_settings_file_is_refused() {
        let root = scratch("symlink");
        let outside = scratch("outside");
        fs::create_dir_all(outside.join(".ace")).unwrap_or_else(|error| panic!("{error}"));
        fs::write(outside.join(".ace").join("settings.json"), "{}")
            .unwrap_or_else(|error| panic!("{error}"));

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join(".ace"))
            .unwrap_or_else(|error| panic!("{error}"));
        let guard = WorkspaceGuard::pin(&root, fs_port()).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            guard.check().map_err(|error| error.message),
            Err("Workspace settings cannot use symlink components".into())
        );

        let _ = fs::remove_file(root.join(".ace"));
        fs::create_dir_all(root.join(".ace")).unwrap_or_else(|error| panic!("{error}"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            outside.join(".ace").join("settings.json"),
            root.join(".ace").join("settings.json"),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            guard.check().map_err(|error| error.message),
            Err("Workspace settings cannot use symlink components".into())
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn an_unpinned_alias_has_no_guard_and_a_pinned_one_survives_the_lru() {
        let base = scratch("lru");
        let aliased = base.join("workspace");
        fs::create_dir_all(aliased.join(".ace")).unwrap_or_else(|error| panic!("{error}"));
        let settings = aliased.join(".ace").join("settings.json");
        let guards = WorkspaceGuards::new(fs_port(), std::slice::from_ref(&settings));
        assert!(guards.for_file(&settings).is_none());
        let pinned = guards
            .get(&aliased)
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(Rc::ptr_eq(
            &pinned,
            &guards
                .for_file(&settings)
                .unwrap_or_else(|| panic!("pinned"))
        ));
        for index in 0..PINNED_ROOTS {
            let other = base.join(format!("other-{index}"));
            fs::create_dir_all(&other).unwrap_or_else(|error| panic!("{error}"));
            guards.get(&other).unwrap_or_else(|error| panic!("{error}"));
        }
        // The aliased workspace was the least recently used, but its alias keeps it.
        assert!(guards.for_file(&settings).is_some());
        let _ = fs::remove_dir_all(&base);
    }
}
