//! Spade's own folders for Python, read and written on the host through directory handles that
//! open every folder and file by name without following a link (ADR 0220). [`put`] writes a file
//! as a new one beside the old, renamed over it. [`Staging`] is a bot's: the scripts and module
//! lists its calls were classed with, by their hashes, which its runs read and no sandboxed run
//! can write.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use cap_fs_ext::DirExt;
use cap_std::fs::{Dir, OpenOptions};

use super::super::walk::open_file_no_follow;

/// The largest file Spade reads back from these folders.
const LARGEST_READ: u64 = 4 * 1024 * 1024;

/// `name` under `at`, made when missing, opened without following a link.
pub fn folder(at: &Dir, name: &str) -> std::io::Result<Dir> {
    match at.create_dir(name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    at.open_dir_nofollow(name)
}

/// The folder at `path`, made when missing: its parent opened as given (Spade's own), the
/// folder itself opened without following a link.
pub fn open(path: &Path) -> std::io::Result<Dir> {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(std::io::Error::other("no folder"));
    };
    std::fs::create_dir_all(parent)?;
    let parent = Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
    folder(&parent, &name.to_string_lossy())
}

/// A file's bytes, at most [`LARGEST_READ`], opened without following a link.
pub fn read(at: &Dir, name: &str) -> std::io::Result<Vec<u8>> {
    let file = open_file_no_follow(at, std::ffi::OsStr::new(name))?;
    let mut bytes = Vec::new();
    file.take(LARGEST_READ + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LARGEST_READ {
        return Err(std::io::Error::other(format!("{name} is too large")));
    }
    Ok(bytes)
}

/// Writes `name` in `at` with `content` when it holds anything else: a new file beside it (never
/// following a link), renamed over it.
pub fn put(at: &Dir, name: &str, content: &[u8]) -> std::io::Result<()> {
    if read(at, name).is_ok_and(|now| now == content) {
        return Ok(());
    }
    let temporary = format!(".{name}.{}", uuid::Uuid::new_v4().simple());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let written = at.open_with(&temporary, &options).and_then(|mut file| {
        file.write_all(content)?;
        file.sync_all()
    });
    let renamed = written.and_then(|()| at.rename(&temporary, at, name));
    if renamed.is_err() {
        let _ = at.remove_file(&temporary);
    }
    renamed
}

/// A bot's staging folder.
#[derive(Debug, Clone)]
pub struct Staging {
    pub root: PathBuf,
}

impl Staging {
    fn scripts(&self) -> std::io::Result<Dir> {
        folder(&open(&self.root)?, "scripts")
    }

    /// Stages `bytes` as `scripts/<hash>.<extension>`, the same bytes whenever named.
    pub fn stage(&self, bytes: &[u8], extension: &str) -> std::io::Result<PathBuf> {
        let name = format!("{}.{extension}", super::super::trust::hash(bytes));
        put(&self.scripts()?, &name, bytes)?;
        Ok(self.root.join("scripts").join(name))
    }

    /// A staged file's bytes, when it still holds the bytes it was staged with.
    pub fn bytes(&self, path: &Path) -> Option<Vec<u8>> {
        let name = path.file_name()?.to_string_lossy().into_owned();
        if path.parent() != Some(self.root.join("scripts").as_path()) {
            return None;
        }
        let hash = name.split('.').next()?.to_owned();
        let bytes = self
            .scripts()
            .and_then(|scripts| read(&scripts, &name))
            .ok()?;
        (super::super::trust::hash(&bytes) == hash).then_some(bytes)
    }

    /// Whether `path` is a staged file still holding the bytes it was staged with.
    pub fn intact(&self, path: &Path) -> bool {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            return false;
        };
        if path.parent() != Some(self.root.join("scripts").as_path()) {
            return false;
        }
        let Some(hash) = name.split('.').next() else {
            return false;
        };
        self.scripts()
            .and_then(|scripts| read(&scripts, &name))
            .is_ok_and(|bytes| super::super::trust::hash(&bytes) == hash)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_written_through_handles_and_never_through_a_link() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let at = open(&root.path().join("control")).unwrap_or_else(|e| panic!("{e}"));
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, "theirs").unwrap_or_default();
        std::os::unix::fs::symlink(&outside, root.path().join("control/run.sh"))
            .unwrap_or_default();
        put(&at, "run.sh", b"two").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            std::fs::read_to_string(&outside).ok().as_deref(),
            Some("theirs")
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("control/run.sh"))
                .ok()
                .as_deref(),
            Some("two")
        );
        // A scripts folder swapped for a link to elsewhere is never staged into.
        let staging = Staging {
            root: root.path().join("bots/b1"),
        };
        let elsewhere = root.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap_or_default();
        std::fs::create_dir_all(&staging.root).unwrap_or_default();
        std::os::unix::fs::symlink(&elsewhere, staging.root.join("scripts")).unwrap_or_default();
        assert!(staging.stage(b"print(1)", "py").is_err());
        assert_eq!(
            std::fs::read_dir(&elsewhere)
                .map(|d| d.count())
                .unwrap_or(0),
            0
        );
    }

    #[test]
    fn a_staged_file_counts_only_while_it_holds_its_bytes() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let staging = Staging {
            root: root.path().join("bots/b1"),
        };
        let staged = staging
            .stage(b"print(1)", "py")
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(staging.intact(&staged));
        std::fs::write(&staged, "print(2)").unwrap_or_default();
        assert!(!staging.intact(&staged));
        assert!(!staging.intact(&root.path().join("x.py")));
    }
}
