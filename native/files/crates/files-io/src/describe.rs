// SPDX-License-Identifier: Apache-2.0

//! Everything the daemon needs to know about one path before it changes it: the version a guarded
//! write compares, the size a trash quota counts, the kind a viewer shows and the mode a save must
//! carry over.
//!
//! A link is described as itself (kind and size) but its version is its target's, in or out of the
//! root, because that is the entry a read or a save acts on. A link that leaves the root is
//! `PATH_ESCAPE`, as the daemon's confinement refuses it.
//!
//! Walks a request triggers are bounded twice: the request's cancel flag stops them when the daemon
//! gave up, and a budget stops a tree too large to digest in the time one answer should take.
//! Neither failure is an error: a stopped folder digest falls back to the folder's own version and
//! says `shallow`, so a huge `node_modules` is described rather than refused.

use std::io::ErrorKind;

use cap_fs_ext::DirExt;
use cap_std::fs::{Dir, Metadata};
use files_safe::Root;

use crate::Error;

/// One walk's limits, passed by the caller so a request's cancel flag reaches every entry.
///
/// Time and cancellation are injected, never read globally: `cancel` is whatever the request's
/// owner uses, and a test can stop after any number of entries.
pub struct Walks<'a> {
    cancel: &'a dyn Fn() -> bool,
    max_entries: usize,
}

impl<'a> Walks<'a> {
    /// How many entries a request's walk reads before it reports a shallow answer.
    pub const DEFAULT_ENTRIES: usize = 200_000;

    /// A walk bound to a request's cancel flag, with the default budget.
    pub fn new(cancel: &'a dyn Fn() -> bool) -> Walks<'a> {
        Walks {
            cancel,
            max_entries: Self::DEFAULT_ENTRIES,
        }
    }

    /// The same walk with a smaller or larger budget; tests use small ones.
    pub fn with_budget(cancel: &'a dyn Fn() -> bool, max_entries: usize) -> Walks<'a> {
        Walks {
            cancel,
            max_entries,
        }
    }

    /// A walk nobody cancels, for the version a conflict reports: bounded, but never stopped.
    pub fn unbounded() -> Walks<'static> {
        Walks {
            cancel: &never,
            max_entries: Self::DEFAULT_ENTRIES,
        }
    }

    /// Whether this walk must stop, or `ABORTED` when the request was cancelled.
    ///
    /// `visited` counts entries read so far; the budget check comes after the cancel check, so a
    /// cancelled request always reports the cancellation rather than a shallow answer.
    pub(crate) fn stopped(&self, visited: usize) -> Result<bool, Error> {
        if (self.cancel)() {
            return Err(Error::Aborted);
        }
        Ok(visited > self.max_entries)
    }
}

fn never() -> bool {
    false
}

/// The entry vanished while it was being described.
fn missing() -> Error {
    Error::Io(std::io::Error::from(std::io::ErrorKind::NotFound))
}

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
    /// A folder's own version, before its digest; `None` for a file.
    pub own_version: Option<String>,
    /// True when a walk budget stopped the digest, so `version` is the folder's own version.
    pub shallow: bool,
    /// The entry's own size, before any link is followed.
    pub size: u64,
    pub kind: Kind,
    /// Permission bits, `0o777` at most.
    pub mode: u64,
}

/// The bytes a walk counted and whether it read the whole tree.
#[derive(Debug, Clone, Copy)]
pub struct Measurement {
    pub bytes: u64,
    /// True when a walk budget stopped the count, so `bytes` is a lower bound.
    pub shallow: bool,
}

/// Describe the entry at `path`; the empty path is the checkout itself.
pub fn describe(root: &Root, path: &str, walks: &Walks) -> Result<Description, Error> {
    if path.is_empty() {
        let dir = root.dir();
        let metadata = dir.dir_metadata()?;
        let tree = crate::tree::version(root, path, &dir.try_clone()?, walks)?;
        return Ok(Description {
            version: tree.version,
            own_version: Some(tree.own),
            shallow: tree.shallow,
            size: metadata.len(),
            kind: Kind::Directory,
            mode: permissions(&metadata),
        });
    }
    let (dir, name) = root.open_parent(path)?;
    let own = dir.symlink_metadata(&name)?;
    let mode = permissions(&own);
    let kind = kind_of(own.file_type());
    if kind != Kind::Symlink {
        let versioned =
            crate::version::entry_version(root, &dir, &name, path, walks)?.ok_or_else(missing)?;
        return Ok(Description {
            version: versioned.version,
            own_version: versioned.own,
            shallow: versioned.shallow,
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
    let versioned = crate::version::entry_version(root, &target_dir, &target_name, &inside, walks)?
        .ok_or_else(missing)?;
    Ok(Description {
        version: versioned.version,
        own_version: versioned.own,
        shallow: versioned.shallow,
        size: target.len(),
        kind,
        mode: permissions(&target),
    })
}

/// Describe the entry itself: its own version, never a folder's tree digest.
///
/// This is the cheap guard a queued mutation re-checks before it acts, so a folder's identity and
/// times decide whether it moved, without walking everything below it again.
pub fn describe_entry(root: &Root, path: &str) -> Result<Description, Error> {
    if path.is_empty() {
        let metadata = root.dir().dir_metadata()?;
        return Ok(Description {
            version: root_version(root.dir())?,
            own_version: None,
            shallow: false,
            size: metadata.len(),
            kind: Kind::Directory,
            mode: permissions(&metadata),
        });
    }
    let (dir, name) = root.open_parent(path)?;
    describe_here(&dir, &name)
}

/// The entry's own details, from the folder that holds it: never a tree digest.
fn describe_here(dir: &Dir, name: &str) -> Result<Description, Error> {
    let metadata = dir.symlink_metadata(name)?;
    Ok(Description {
        version: crate::version::version_of_entry(dir, name, &metadata)?,
        own_version: None,
        shallow: false,
        size: metadata.len(),
        kind: kind_of(metadata.file_type()),
        mode: permissions(&metadata),
    })
}

/// The checkout's own version, before any tree digest.
fn root_version(dir: &Dir) -> Result<String, Error> {
    let metadata = dir.dir_metadata()?;
    #[cfg(unix)]
    let handle = None;
    #[cfg(windows)]
    let handle = Some(crate::handle::dir_handle(&dir.try_clone()?)?);
    crate::version::version_of(handle.as_ref(), &metadata)
}

/// Check that `path` may be a mutation target under the daemon's rule: no link on the way and no
/// link as the leaf, because a mutation must never be redirected by one.
///
/// The last segment may be missing (a create); every segment before it must be a real folder. This
/// mirrors what the daemon's own confinement checked before ace-files answered these writes.
pub fn check_mutation(root: &Root, path: &str) -> Result<(), Error> {
    if path.is_empty() {
        return Err(Error::InvalidArgument("the checkout itself".to_owned()));
    }
    let parts: Vec<&str> = path.split('/').collect();
    let mut dir = root.dir().try_clone()?;
    for (index, part) in parts.iter().enumerate() {
        let last = index + 1 == parts.len();
        let metadata = match dir.symlink_metadata(part) {
            Ok(metadata) => metadata,
            Err(error) if last && error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            return Err(Error::Path(files_safe::Error::PathEscape(path.to_owned())));
        }
        if !last {
            if !metadata.is_dir() {
                return Err(Error::Path(files_safe::Error::NotDirectory(
                    path.to_owned(),
                )));
            }
            dir = dir.open_dir_nofollow(part).map_err(Error::Io)?;
        }
    }
    Ok(())
}

/// The version of the entry at `path` without a folder digest, so a conflict reply never walks a
/// tree to name what it found.
pub fn entry_version(root: &Root, path: &str) -> Result<String, Error> {
    let (dir, name) = crate::handle::target_parent(root, path)?;
    Ok(describe_here(&dir, &name)?.version)
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
/// root and counts its target's size; a file counts as itself; anything else counts nothing. A
/// walk that hits its budget reports a lower bound instead of failing, so a huge folder can still
/// be deleted.
pub fn measure(root: &Root, path: &str, walks: &Walks) -> Result<Measurement, Error> {
    if path.is_empty() {
        return measure_folder(root, path, root.dir(), walks);
    }
    let (dir, name) = root.open_parent(path)?;
    let own = dir.symlink_metadata(&name)?;
    if own.is_dir() {
        return measure_folder(root, path, &dir.open_dir(&name)?, walks);
    }
    if own.file_type().is_symlink() {
        return Ok(Measurement {
            bytes: followed_size(root, path)?.unwrap_or(0),
            shallow: false,
        });
    }
    Ok(Measurement {
        bytes: if own.is_file() { own.len() } else { 0 },
        shallow: false,
    })
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

fn measure_folder(
    root: &Root,
    relative: &str,
    dir: &Dir,
    walks: &Walks,
) -> Result<Measurement, Error> {
    let mut bytes = 0;
    let mut visited = 0usize;
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
        visited += 1;
        if walks.stopped(visited)? {
            return Ok(Measurement {
                bytes,
                shallow: true,
            });
        }
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
    Ok(Measurement {
        bytes,
        shallow: false,
    })
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::{Kind, Walks, check_mutation, describe, describe_entry, entry_version, measure};
    use crate::Error;

    fn root(dir: &std::path::Path) -> files_safe::Root {
        files_safe::Root::open(dir).expect("open root")
    }

    fn unbounded() -> Walks<'static> {
        Walks::unbounded()
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

        let description = describe(&root, "notes.md", &unbounded()).expect("describe");

        assert_eq!(description.kind, Kind::File);
        assert_eq!(description.size, 6);
        assert!(!description.shallow);
        assert!(
            description.own_version.is_none(),
            "a file is its own version"
        );
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

        let description = describe(&root, "docs", &unbounded()).expect("describe");
        let plain = describe_entry(&root, "docs").expect("entry");

        assert_eq!(description.kind, Kind::Directory);
        assert!(description.version.starts_with("tree:"), "{description:?}");
        assert_eq!(
            description.own_version.as_deref(),
            Some(plain.version.as_str()),
            "a folder names its own version beside the digest"
        );
        assert!(!description.shallow);
        assert_ne!(
            description.version, plain.version,
            "a digest is not its own version"
        );
        fs::write(temp.path().join("docs/b.md"), b"b").expect("write");
        assert_ne!(
            describe(&root, "docs", &unbounded())
                .expect("describe")
                .version,
            description.version,
            "a changed folder gets a new digest"
        );
    }

    #[test]
    fn a_folder_over_the_walk_budget_is_described_by_its_own_version() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join("huge")).expect("folder");
        for index in 0..25 {
            fs::write(temp.path().join("huge").join(format!("{index}.md")), b"x").expect("write");
        }
        let root = root(temp.path());
        let never = || false;

        let description =
            describe(&root, "huge", &Walks::with_budget(&never, 10)).expect("describe");

        assert!(description.shallow, "{description:?}");
        assert!(
            !description.version.starts_with("tree:"),
            "a stopped walk does not guess a digest: {}",
            description.version
        );
        assert_eq!(
            description.version,
            describe_entry(&root, "huge").expect("entry").version,
            "so a huge folder is never refused"
        );
    }

    #[test]
    fn a_walk_stops_when_the_request_is_cancelled() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join("huge")).expect("folder");
        for index in 0..25 {
            fs::write(temp.path().join("huge").join(format!("{index}.md")), b"x").expect("write");
        }
        let root = root(temp.path());
        let checks = AtomicUsize::new(0);
        let cancel = || checks.fetch_add(1, Ordering::Relaxed) >= 2;

        let error = describe(&root, "huge", &Walks::new(&cancel)).expect_err("cancelled");

        assert_eq!(error.code(), "ABORTED");
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

        assert_eq!(
            measure(&root, "docs", &unbounded()).expect("measure").bytes,
            6
        );
        assert_eq!(
            measure(&root, "docs/a.md", &unbounded())
                .expect("measure")
                .bytes,
            4
        );
        assert_eq!(
            measure(&root, "", &unbounded()).expect("measure").bytes,
            6 + 9 + 7,
            "git's objects and the transfer temporaries move into the trash too"
        );
    }

    #[test]
    fn a_measure_over_the_budget_reports_a_lower_bound_not_an_error() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join("huge")).expect("folder");
        for index in 0..25 {
            fs::write(temp.path().join("huge").join(format!("{index}.md")), b"xy").expect("write");
        }
        let root = root(temp.path());
        let never = || false;

        let measured = measure(&root, "huge", &Walks::with_budget(&never, 10)).expect("measure");

        assert!(measured.shallow);
        assert_eq!(measured.bytes, 20, "ten two-byte files were counted");
    }

    #[test]
    fn a_dangling_link_measures_nothing() {
        let temp = tempfile::tempdir().expect("temp dir");
        #[cfg(unix)]
        std::os::unix::fs::symlink("gone.md", temp.path().join("link.md")).expect("link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file("gone.md", temp.path().join("link.md")).expect("link");
        let root = root(temp.path());

        assert_eq!(
            measure(&root, "link.md", &unbounded())
                .expect("measure")
                .bytes,
            0
        );
    }

    #[test]
    fn describes_a_link_by_its_target_and_its_own_kind() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::write(temp.path().join("real.md"), b"target bytes\n").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink("real.md", temp.path().join("link.md")).expect("link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file("real.md", temp.path().join("link.md")).expect("link");
        let root = root(temp.path());

        let link = describe(&root, "link.md", &unbounded()).expect("describe");

        assert_eq!(link.kind, Kind::Symlink);
        assert_eq!(
            link.version,
            describe(&root, "real.md", &unbounded())
                .expect("describe")
                .version,
            "a link reads as its target"
        );
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

        let error =
            describe(&root, "escape", &unbounded()).expect_err("an escaping link is refused");

        assert_eq!(error.code(), "PATH_ESCAPE");
    }

    #[test]
    fn describes_the_checkout_itself() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::write(temp.path().join("a.md"), b"a").expect("write");
        let root = root(temp.path());

        let description = describe(&root, "", &unbounded()).expect("describe");

        assert_eq!(description.kind, Kind::Directory);
        assert!(description.version.starts_with("tree:"), "{description:?}");
        assert!(description.own_version.is_some());
    }

    #[test]
    fn describes_nothing_as_not_found() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = root(temp.path());

        let error = describe(&root, "missing.md", &unbounded()).expect_err("nothing is there");

        assert_eq!(error.code(), "NOT_FOUND");
    }

    #[test]
    fn describe_refuses_a_path_outside_the_root() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = root(temp.path());

        let error = describe(&root, "../etc/passwd", &unbounded()).expect_err("refused");
        assert!(matches!(error, Error::Path(_)), "{error:?}");
    }

    #[test]
    fn a_mutation_may_create_a_leaf_but_never_follow_a_link() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join("docs")).expect("folder");
        fs::write(temp.path().join("docs/a.md"), b"a").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink("docs", temp.path().join("alias")).expect("link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir("docs", temp.path().join("alias")).expect("link");
        let root = root(temp.path());

        check_mutation(&root, "docs/new.md").expect("a new leaf in a real folder");
        check_mutation(&root, "docs/a.md").expect("an existing file");

        let through = check_mutation(&root, "alias/new.md").expect_err("a link on the way");
        assert_eq!(through.code(), "PATH_ESCAPE");
        let onto = check_mutation(&root, "alias").expect_err("a link as the leaf");
        assert_eq!(onto.code(), "PATH_ESCAPE");
        let missing = check_mutation(&root, "gone/new.md").expect_err("a missing parent");
        assert_eq!(missing.code(), "NOT_FOUND");
        let over = check_mutation(&root, "docs/a.md/below").expect_err("a file on the way");
        assert_eq!(over.code(), "NOT_DIRECTORY");
    }
}
