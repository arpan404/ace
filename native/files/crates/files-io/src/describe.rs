// SPDX-License-Identifier: Apache-2.0

//! Everything the daemon needs to know about one path before it changes it: the version a guarded
//! write compares, the size a trash quota counts, the kind a viewer shows and the mode a save must
//! carry over.
//!
//! A link is described as itself (kind and size) but its version is its target's, in or out of the
//! root, because that is the entry a read or a save acts on. A link that leaves the root is
//! `PATH_ESCAPE`, as the daemon's confinement refuses it.

use std::io::ErrorKind;

use cap_fs_ext::DirExt;
use cap_std::fs::{Dir, Metadata};
use files_safe::Root;

use crate::Error;

/// What a path is, without following a final link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Directory,
    Symlink,
    Other,
}

/// One path's details.
#[derive(Debug, Clone)]
pub struct Description {
    /// The daemon's version string: identity and times, or a folder's tree digest.
    pub version: String,
    /// The entry's own size, before any link is followed.
    pub size: u64,
    pub kind: Kind,
    /// Permission bits, `0o777` at most.
    pub mode: u64,
}

/// Describe the entry at `path`.
pub fn describe(root: &Root, path: &str) -> Result<Description, Error> {
    let (dir, name) = root.open_parent(path)?;
    let own = dir.symlink_metadata(&name)?;
    let mode = permissions(&own);
    let kind = kind_of(own.file_type());
    if kind != Kind::Symlink {
        return Ok(Description {
            version: crate::version::entry_version(root, &dir, &name, path)?.unwrap_or_default(),
            size: own.len(),
            kind,
            mode,
        });
    }
    // A link the daemon can read is versioned by its target, which is what a read or save touches.
    let resolved = root.resolve(path)?;
    let inside = root
        .relative(&resolved)
        .ok_or_else(|| files_safe::Error::PathEscape(path.to_owned()))?;
    let (target_dir, target_name) = crate::handle::target_parent(root, &inside)?;
    let target = target_dir.symlink_metadata(&target_name)?;
    Ok(Description {
        version: crate::version::entry_version(root, &target_dir, &target_name, &inside)?
            .unwrap_or_default(),
        size: target.len(),
        kind,
        mode: permissions(&target),
    })
}

/// The version of the entry at `path` without a folder digest, so a walk can stamp every entry
/// with the change marker the daemon stores in an archive preview.
pub fn entry_version(root: &Root, path: &str) -> Result<String, Error> {
    let (dir, name) = crate::handle::target_parent(root, path)?;
    let metadata = dir.symlink_metadata(&name)?;
    crate::version::version_of_entry(&dir, &name, &metadata)
}

/// What kind of entry a file type names.
pub(crate) fn kind_of(file_type: cap_std::fs::FileType) -> Kind {
    if file_type.is_symlink() {
        Kind::Symlink
    } else if file_type.is_dir() {
        Kind::Directory
    } else if file_type.is_file() {
        Kind::File
    } else {
        Kind::Other
    }
}

/// Permission bits, without the file type or the setuid, setgid and sticky bits.
fn permissions(metadata: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        u64::from(metadata.mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        u64::from(metadata.permissions().readonly())
    }
}

/// The bytes of the files below `path`, which is what a delete reserves in the trash.
///
/// Everything a move would carry counts, git's object store and the daemon's transfer temporaries
/// included: the trash holds the whole entry. A link is followed only where it stays inside the
/// root and counts its target's size; a file counts as itself; anything else counts nothing.
pub fn measure(root: &Root, path: &str) -> Result<u64, Error> {
    if path.is_empty() {
        return measure_folder(root, path, root.dir(), 0);
    }
    let (dir, name) = root.open_parent(path)?;
    let own = dir.symlink_metadata(&name)?;
    if own.is_dir() {
        return measure_folder(root, path, &dir.open_dir(&name)?, 0);
    }
    if own.file_type().is_symlink() {
        return Ok(followed_size(root, path)?.unwrap_or(0));
    }
    Ok(if own.is_file() { own.len() } else { 0 })
}

/// The size of a link's target, or `None` when the link leaves the root or is dangling.
fn followed_size(root: &Root, path: &str) -> Result<Option<u64>, Error> {
    let resolved = match root.resolve(path) {
        Ok(resolved) => resolved,
        Err(error) if transient(error.code()) => return Ok(None),
        Err(error) => return Err(Error::Path(error)),
    };
    let Some(inside) = root.relative(&resolved) else {
        return Ok(None);
    };
    let (dir, name) = crate::handle::target_parent(root, &inside)?;
    match dir.symlink_metadata(&name) {
        Ok(metadata) if metadata.is_file() => Ok(Some(metadata.len())),
        Ok(_) => Ok(None),
        Err(error) if transient_kind(error.kind()) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// One folder of the walk: its entries' names and where in them the walk is.
struct Folder {
    relative: String,
    dir: Dir,
    names: Vec<String>,
    next: usize,
}

fn measure_folder(root: &Root, relative: &str, dir: &Dir, mut bytes: u64) -> Result<u64, Error> {
    let mut stack = vec![Folder {
        relative: relative.to_owned(),
        dir: dir.try_clone()?,
        names: names(dir)?,
        next: 0,
    }];
    while let Some(index) = stack.len().checked_sub(1) {
        let Some(name) = stack[index].names.get(stack[index].next).cloned() else {
            stack.pop();
            continue;
        };
        stack[index].next += 1;
        let base = stack[index].relative.clone();
        let path = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        let folder = &stack[index].dir;
        let metadata = match folder.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(error) if transient_kind(error.kind()) => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            bytes += followed_size(root, &path)?.unwrap_or(0);
        } else if metadata.is_file() {
            bytes += metadata.len();
        } else if metadata.is_dir() {
            match folder.open_dir_nofollow(&name) {
                Ok(child) => stack.push(Folder {
                    relative: path,
                    names: names(&child)?,
                    dir: child,
                    next: 0,
                }),
                Err(error) if transient_kind(error.kind()) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(bytes)
}

/// The names in one folder.
fn names(dir: &Dir) -> Result<Vec<String>, Error> {
    let mut names = Vec::new();
    for entry in dir.entries()? {
        let entry = entry?;
        if let Ok(name) = entry.file_name().into_string() {
            names.push(name);
        }
    }
    Ok(names)
}

fn transient(code: &str) -> bool {
    matches!(
        code,
        "NOT_FOUND" | "PATH_ESCAPE" | "PATH_CHANGED" | "NOT_DIRECTORY"
    )
}

fn transient_kind(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::NotFound | ErrorKind::NotADirectory)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{Kind, describe, entry_version, measure};
    use crate::Error;

    fn root(dir: &std::path::Path) -> files_safe::Root {
        files_safe::Root::open(dir).expect("open root")
    }

    #[test]
    fn describes_a_file_with_its_size_and_mode() {
        let temp = tempfile::tempdir().expect("temp dir");
        let file = temp.path().join("notes.md");
        fs::write(&file, b"hello\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).expect("mode");
        }
        let root = root(temp.path());

        let description = describe(&root, "notes.md").expect("describe");

        assert_eq!(description.kind, Kind::File);
        assert_eq!(description.size, 6);
        assert_eq!(
            description.version,
            entry_version(&root, "notes.md").expect("version")
        );
        #[cfg(unix)]
        assert_eq!(description.mode, 0o640);
    }

    #[test]
    fn describes_a_folder_with_the_tree_digest_the_daemon_stores() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join("docs")).expect("folder");
        fs::write(temp.path().join("docs/a.md"), b"a").expect("write");
        let root = root(temp.path());

        let description = describe(&root, "docs").expect("describe");
        let plain = entry_version(&root, "docs").expect("version");

        assert_eq!(description.kind, Kind::Directory);
        assert!(description.version.starts_with("tree:"), "{description:?}");
        assert_ne!(
            description.version, plain,
            "a folder digest is not its own version"
        );
        fs::write(temp.path().join("docs/b.md"), b"b").expect("write");
        assert_ne!(
            describe(&root, "docs").expect("describe").version,
            description.version,
            "a changed folder gets a new digest"
        );
    }

    #[test]
    fn a_link_is_described_as_itself_and_versioned_by_its_target() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::write(temp.path().join("real.md"), b"target bytes\n").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink("real.md", temp.path().join("link.md")).expect("link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file("real.md", temp.path().join("link.md")).expect("link");
        let root = root(temp.path());

        let link = describe(&root, "link.md").expect("describe");
        let target = describe(&root, "real.md").expect("describe");

        assert_eq!(link.kind, Kind::Symlink);
        assert_eq!(link.version, target.version, "a link reads as its target");
        assert_eq!(link.size, target.size);
    }

    #[test]
    fn a_link_that_leaves_the_root_is_refused() {
        let temp = tempfile::tempdir().expect("temp dir");
        let outside = tempfile::tempdir().expect("outside dir");
        fs::write(outside.path().join("secret"), b"secret").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path().join("secret"), temp.path().join("escape"))
            .expect("link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(
            outside.path().join("secret"),
            temp.path().join("escape"),
        )
        .expect("link");
        let root = root(temp.path());

        let error = describe(&root, "escape").expect_err("an escaping link is refused");

        assert_eq!(error.code(), "PATH_ESCAPE");
    }

    #[test]
    fn describes_nothing_as_not_found() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = root(temp.path());

        let error = describe(&root, "missing.md").expect_err("nothing is there");

        assert_eq!(error.code(), "NOT_FOUND");
    }

    #[test]
    fn measures_every_file_a_delete_would_carry() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(temp.path().join("docs/nested")).expect("folders");
        fs::create_dir_all(temp.path().join(".git/objects")).expect("git");
        fs::write(temp.path().join("docs/a.md"), b"aaaa").expect("write");
        fs::write(temp.path().join("docs/nested/b.md"), b"bb").expect("write");
        fs::write(temp.path().join(".git/objects/blob"), b"git bytes").expect("write");
        fs::write(temp.path().join(".ace-upload-1"), b"private").expect("write");
        let root = root(temp.path());

        assert_eq!(measure(&root, "docs").expect("measure"), 6);
        assert_eq!(measure(&root, "docs/a.md").expect("measure"), 4);
        assert_eq!(
            measure(&root, "").expect("measure"),
            6 + 9 + 7,
            "git's objects and the transfer temporaries move into the trash too"
        );
    }

    #[test]
    fn a_dangling_link_measures_nothing() {
        let temp = tempfile::tempdir().expect("temp dir");
        #[cfg(unix)]
        std::os::unix::fs::symlink("gone.md", temp.path().join("link.md")).expect("link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file("gone.md", temp.path().join("link.md")).expect("link");
        let root = root(temp.path());

        assert_eq!(measure(&root, "link.md").expect("measure"), 0);
    }

    #[test]
    fn describe_refuses_a_path_outside_the_root() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = root(temp.path());

        let error = describe(&root, "../etc/passwd").expect_err("refused");
        assert!(matches!(error, Error::Path(_)), "{error:?}");
    }
}
