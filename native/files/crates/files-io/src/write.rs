// SPDX-License-Identifier: Apache-2.0

//! Writes: a complete copy staged beside the target, synced, then published in one step, so a
//! crash leaves either the old bytes or the new ones and never a half-written file.
//!
//! A save that carries the version the caller worked from swaps the copy into place and then
//! inspects the file it displaced. The expected version is deleted; anything else was written by
//! another program and goes back to the name, so an outside save is never lost.

use std::io::ErrorKind;

use cap_std::fs::{Dir, Metadata, Permissions};
use files_safe::Root;

use crate::Error;
use crate::describe::Walks;
use crate::handle::{self, Noclobber, Staged};
use crate::version;

/// What publishing a staged copy came to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Published {
    Done,
    Conflict,
}

/// Replaces a file's contents, refusing when the version the caller worked from is no longer
/// current.
///
/// `expected` is a version from `stat_version` or an earlier `read`; `None` means the file must
/// not exist yet. Returns the version the saved file now has.
///
/// The save writes a complete copy beside the file and publishes it in one step, carrying the
/// original's permission bits. Ownership, extended attributes, ACLs and other hard links to the
/// old file are not carried over, which is also what the daemon's temp-and-rename save does. A
/// file that did not exist yet keeps the private mode of the staging copy.
pub fn write(
    root: &Root,
    path: &str,
    bytes: &[u8],
    expected: Option<&str>,
) -> Result<String, Error> {
    save(root, path, bytes, expected, &|| {})
}

/// Creates a file that must not exist yet and returns its version.
pub fn create_file(root: &Root, path: &str, bytes: &[u8]) -> Result<String, Error> {
    write(root, path, bytes, None)
}

/// The save itself, with the point just before publishing exposed so a test can slip another
/// writer in there. Nothing in production passes anything but an empty closure.
fn save(
    root: &Root,
    path: &str,
    bytes: &[u8],
    expected: Option<&str>,
    before_publish: &dyn Fn(),
) -> Result<String, Error> {
    // The daemon's client policy is part of the save, not a step before it: no reserved name, no
    // link on the way, and no link as the target, so bytes never land where the client did not
    // name.
    let parent = crate::policy::client_parent(root, path)?;
    let (dir, name) = (parent.dir, parent.name);
    let existing = guard(root, &dir, &name, path, expected)?;
    let permissions = existing.as_ref().map(copied_permissions);
    let mut staged = Staged::new(&dir, bytes, permissions)?;
    // The copy is complete and synced; check once more so a save that lost a race never lands on
    // top of another writer's work.
    let _ = guard(root, &dir, &name, path, expected)?;
    before_publish();
    let published = match expected {
        None => publish_new(&dir, &name, &mut staged)?,
        Some(expected) => publish_versioned(&dir, &name, expected, &mut staged, existing.as_ref())?,
    };
    if published == Published::Conflict {
        return Err(Error::Conflict {
            path: path.to_owned(),
            current: version_of(root, &dir, &name, path)?,
        });
    }
    handle::sync(&dir)?;
    let metadata = dir.symlink_metadata(&name)?;
    version::version_of_entry(&dir, &name, &metadata)
}

/// The version a conflict reports, without walking a folder for a digest.
fn version_of(root: &Root, dir: &Dir, name: &str, path: &str) -> Result<Option<String>, Error> {
    Ok(
        version::entry_version(root, dir, name, path, &Walks::unbounded())?
            .map(|found| found.version),
    )
}

/// Checks the destination against the caller's expectation and returns its metadata, if any.
fn guard(
    root: &Root,
    dir: &Dir,
    name: &str,
    path: &str,
    expected: Option<&str>,
) -> Result<Option<Metadata>, Error> {
    let found = match dir.symlink_metadata(name) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    match (expected, found) {
        (Some(expected), Some(metadata)) => {
            let current = version_of(root, dir, name, path)?.unwrap_or_default();
            if current != expected {
                return Err(Error::Conflict {
                    path: path.to_owned(),
                    current: Some(current),
                });
            }
            if metadata.is_dir() {
                return Err(Error::NotFile(path.to_owned()));
            }
            Ok(Some(metadata))
        }
        (Some(_), None) => Err(Error::Conflict {
            path: path.to_owned(),
            current: None,
        }),
        (None, Some(metadata)) => Err(Error::Conflict {
            path: path.to_owned(),
            current: Some(version::version_of_entry(dir, name, &metadata)?),
        }),
        (None, None) => Ok(None),
    }
}

/// Publishes a create: the name must not have been taken, and the complete copy must win the
/// name in one step.
fn publish_new(dir: &Dir, name: &str, staged: &mut Staged) -> Result<Published, Error> {
    staged.close();
    match handle::rename_noclobber(dir, staged.name(), dir, name)? {
        Noclobber::Done => {
            staged.release();
            Ok(Published::Done)
        }
        Noclobber::Exists => Ok(Published::Conflict),
        Noclobber::Unsupported => link_into_place(dir, name, staged),
    }
}

/// The no-clobber fallback for a filesystem without rename-without-replace: a hard link cannot
/// take a name that exists, so the new copy either appears whole or not at all.
fn link_into_place(dir: &Dir, name: &str, staged: &mut Staged) -> Result<Published, Error> {
    match dir.hard_link(staged.name(), dir, name) {
        Ok(()) => {
            let _ = dir.remove_file(staged.name());
            staged.release();
            Ok(Published::Done)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(Published::Conflict),
        Err(error) => Err(error.into()),
    }
}

/// Publishes a replacement of a known version, swapping the copy and the target in one step and
/// inspecting what left the target.
fn publish_versioned(
    dir: &Dir,
    name: &str,
    expected: &str,
    staged: &mut Staged,
    existing: Option<&Metadata>,
) -> Result<Published, Error> {
    staged.close();
    publish_here(dir, name, expected, staged, existing)
}

#[cfg(unix)]
fn publish_here(
    dir: &Dir,
    name: &str,
    expected: &str,
    staged: &mut Staged,
    _existing: Option<&Metadata>,
) -> Result<Published, Error> {
    if let Some(published) = exchange_publish(dir, name, expected, staged)? {
        return Ok(published);
    }
    // No atomic exchange here: publish the way the daemon does without one.
    handle::replace(dir, staged.name(), name)?;
    staged.release();
    Ok(Published::Done)
}

#[cfg(windows)]
fn publish_here(
    dir: &Dir,
    name: &str,
    _expected: &str,
    staged: &mut Staged,
    existing: Option<&Metadata>,
) -> Result<Published, Error> {
    replace_windows(dir, name, staged, existing)
}

#[cfg(unix)]
fn exchange_publish(
    dir: &Dir,
    name: &str,
    expected: &str,
    staged: &mut Staged,
) -> Result<Option<Published>, Error> {
    if !handle::exchange(dir, staged.name(), name)? {
        return Ok(None);
    }
    let displaced_name = staged.release();
    let displaced = match dir.symlink_metadata(&displaced_name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Some(Published::Conflict)),
        Err(error) => return Err(error.into()),
    };
    let displaced_version = version::version_of(None, &displaced)?;
    if displaced.is_file()
        && version::without_change_time(&displaced_version)
            == version::without_change_time(expected)
    {
        // Re-check right before unlinking: a name that changed again is never removed.
        if version::still(dir, &displaced_name, &displaced)? {
            dir.remove_file(&displaced_name)?;
            return Ok(Some(Published::Done));
        }
    }
    // Something else was at the destination: put it back, and if that is no longer possible keep
    // it beside the target so no program's bytes are discarded.
    let restored = handle::exchange(dir, &displaced_name, name).unwrap_or(false);
    if restored {
        // Our copy is under the staging name again and nobody wants it.
        let _ = dir.remove_file(&displaced_name);
        return Ok(Some(Published::Conflict));
    }
    let kept = kept_copy_name(name);
    let _ = dir.rename(&displaced_name, dir, &kept);
    Ok(Some(Published::Conflict))
}

/// `notes.md` keeps an outside save as `notes.conflict-<unique>.md`, next to it.
#[cfg(unix)]
fn kept_copy_name(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => {
            format!("{stem}.conflict-{}.{extension}", handle::unique_suffix())
        }
        _ => format!("{name}.conflict-{}", handle::unique_suffix()),
    }
}

/// Windows refuses to replace a read-only file, so the attribute comes off long enough to
/// publish the copy, which already carries it. There is no exchange, so this is the daemon's
/// plain-rename fallback.
#[cfg(windows)]
fn replace_windows(
    dir: &Dir,
    name: &str,
    staged: &mut Staged,
    existing: Option<&Metadata>,
) -> Result<Published, Error> {
    let readonly = existing.is_some_and(|metadata| metadata.permissions().readonly());
    if readonly {
        set_readonly(dir, name, false)?;
    }
    if let Err(error) = handle::replace(dir, staged.name(), name) {
        if readonly {
            let _ = set_readonly(dir, name, true);
        }
        return Err(error);
    }
    staged.release();
    Ok(Published::Done)
}

#[cfg(windows)]
fn set_readonly(dir: &Dir, name: &str, readonly: bool) -> Result<(), Error> {
    let mut permissions = dir.metadata(name)?.permissions();
    permissions.set_readonly(readonly);
    dir.set_permissions(name, permissions)?;
    Ok(())
}

/// The original's permission bits. The setuid, setgid and sticky bits are deliberately dropped:
/// a save must never hand a file more privilege than the caller asked for.
#[cfg(unix)]
fn copied_permissions(metadata: &Metadata) -> Permissions {
    use cap_std::fs::PermissionsExt;

    Permissions::from_mode(metadata.permissions().mode() & 0o777)
}

#[cfg(windows)]
fn copied_permissions(metadata: &Metadata) -> Permissions {
    metadata.permissions()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::save;

    /// Runs `body` against a fresh root and returns its directory so files can be inspected.
    fn with_root(body: impl FnOnce(&files_safe::Root, &Path)) {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = files_safe::Root::open(dir.path()).expect("open root");
        body(&root, dir.path());
    }

    fn temporaries(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .expect("list")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.starts_with(".ace-upload-"))
            .collect()
    }

    #[test]
    fn a_write_that_loses_the_race_keeps_the_outside_save() {
        with_root(|root, dir| {
            let target = dir.join("doc.md");
            std::fs::write(&target, b"first\n").expect("seed");
            let version = crate::stat_version(root, "doc.md")
                .expect("stat")
                .expect("a version");

            let result = save(root, "doc.md", b"ours\n", Some(&version), &|| {
                std::fs::write(&target, b"outside save\n").expect("outside save");
            });

            let error = result.expect_err("a changed file must conflict");
            assert_eq!(error.code(), "CONFLICT");
            assert_eq!(
                std::fs::read(&target).expect("read"),
                b"outside save\n",
                "the outside save must still be at the destination"
            );
            assert!(
                temporaries(dir).is_empty(),
                "a refused save leaves no staging file behind"
            );
        });
    }

    #[test]
    fn create_never_overwrites_a_file_that_appears() {
        with_root(|root, dir| {
            let target = dir.join("new.md");
            let result = save(root, "new.md", b"ours\n", None, &|| {
                std::fs::write(&target, b"appeared first\n").expect("appeared");
            });

            let error = result.expect_err("the appeared file must win");
            assert_eq!(error.code(), "CONFLICT");
            assert_eq!(std::fs::read(&target).expect("read"), b"appeared first\n");
            assert!(temporaries(dir).is_empty());
        });
    }
}
