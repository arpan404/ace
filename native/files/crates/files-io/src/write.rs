// SPDX-License-Identifier: Apache-2.0

//! Writes: a complete copy staged beside the target, synced, then published in one step, so a
//! crash leaves either the old bytes or the new ones and never a half-written file.
//!
//! A save that carries the version the caller worked from swaps the copy into place and then
//! inspects the file it displaced. The expected version is deleted; anything else was written by
//! another program and goes back to the name, so an outside save is never lost.

use std::fmt;
use std::io::ErrorKind;

use cap_std::fs::{Dir, Metadata, Permissions};
use files_safe::Root;

use crate::Error;
use crate::describe::Walks;
use crate::handle::{self, Noclobber, Staged};
use crate::version;

/// What a save did.
///
/// A save that passed its commit point is committed even when something after it fails: the
/// bytes are in place. The warning says what could not be done, so a caller reports it without
/// telling the person the save failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saved {
    /// The version the published file has, read through a handle to it. `None` when the file
    /// could not be read afterwards; ask `stat_version` again.
    pub version: Option<String>,
    /// What could not be completed after the file was committed.
    pub warning: Option<SaveWarning>,
}

/// Something that went wrong after a save's commit point.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SaveWarning {
    /// The file is published, but its folder could not be synced, so a crash might lose the
    /// new name.
    NotDurable(String),
    /// The file is published, but its version could not be read from its handle.
    NoVersion(String),
    /// The file is published, but a staging or displaced file could not be removed. Its name is
    /// left beside the target so a later cleanup can retry.
    NotCleanedUp(String),
    /// The file is published, but another program's version of it could not be put back and is
    /// preserved under this name beside the target.
    Preserved(String),
}

impl fmt::Display for SaveWarning {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SaveWarning::NotDurable(message) => write!(formatter, "not durable: {message}"),
            SaveWarning::NoVersion(message) => write!(formatter, "version unavailable: {message}"),
            SaveWarning::NotCleanedUp(message) => {
                write!(formatter, "cleanup incomplete: {message}")
            }
            SaveWarning::Preserved(name) => {
                write!(
                    formatter,
                    "another version of this file is preserved at {name}"
                )
            }
        }
    }
}

/// What publishing a staged copy came to.
#[derive(Clone, PartialEq, Eq)]
enum Published {
    /// The copy is published; anything in the warning happened after the commit point.
    Done(Option<SaveWarning>),
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
) -> Result<Saved, Error> {
    save(root, path, bytes, expected, &|| {}, &|| {})
}

/// Creates a file that must not exist yet and returns its outcome.
pub fn create_file(root: &Root, path: &str, bytes: &[u8]) -> Result<Saved, Error> {
    write(root, path, bytes, None)
}

/// The save itself, with the points just before publishing and just after committing exposed so
/// a test can slip another writer in or break the steps after the commit. Nothing in production
/// passes anything but empty closures.
fn save(
    root: &Root,
    path: &str,
    bytes: &[u8],
    expected: Option<&str>,
    before_publish: &dyn Fn(),
    after_commit: &dyn Fn(),
) -> Result<Saved, Error> {
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
    // Open the folder for syncing before the rename. A folder this process may write but not
    // read cannot be synced, and the save must fail while the old file is still in place.
    let syncable = handle::syncable(&dir)?;
    before_publish();
    let published = match expected {
        None => publish_new(&dir, &name, &mut staged)?,
        Some(expected) => publish_versioned(&dir, &name, expected, &mut staged, existing.as_ref())?,
    };
    let mut warning = match published {
        Published::Conflict => {
            return Err(Error::Conflict {
                path: path.to_owned(),
                current: version_of(root, &dir, &name, path)?,
            });
        }
        Published::Done(warning) => warning,
    };
    after_commit();
    // Past the commit point the save is committed. A failure from here on is reported beside
    // the success, never as a failed save.
    if let Err(error) = syncable.sync() {
        warning = warning.or(Some(SaveWarning::NotDurable(error.to_string())));
    }
    let version = match published_version(&dir, &name) {
        Ok(version) => Some(version),
        Err(error) => {
            warning = warning.or(Some(SaveWarning::NoVersion(error.to_string())));
            None
        }
    };
    Ok(Saved { version, warning })
}

/// The version of the file just published, read once through a handle to it (the metadata alone
/// is enough on Unix).
#[cfg(unix)]
fn published_version(dir: &Dir, name: &str) -> Result<String, Error> {
    let metadata = dir.symlink_metadata(name)?;
    version::version_of(None, &metadata)
}

#[cfg(windows)]
fn published_version(dir: &Dir, name: &str) -> Result<String, Error> {
    let handle = handle::attribute_handle(dir, name)?;
    let metadata = handle.metadata()?;
    version::version_of(Some(&handle), &metadata)
}

/// The version a conflict reports, with a folder's full digest.
fn version_of(root: &Root, dir: &Dir, name: &str, path: &str) -> Result<Option<String>, Error> {
    Ok(
        version::entry_version(root, dir, name, path, &Walks::complete())?
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
        // The rename or hard link is the commit; removing the staging name is cleanup.
        Noclobber::Done => Ok(Published::Done(staged.cleanup())),
        Noclobber::Exists => Ok(Published::Conflict),
        Noclobber::Unsupported => link_into_place(dir, name, staged),
    }
}

/// The no-clobber fallback for a filesystem without rename-without-replace: a hard link cannot
/// take a name that exists, so the new copy either appears whole or not at all.
fn link_into_place(dir: &Dir, name: &str, staged: &mut Staged) -> Result<Published, Error> {
    match dir.hard_link(staged.name(), dir, name) {
        Ok(()) => Ok(Published::Done(staged.cleanup())),
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
    let Some(published) = exchange_publish(dir, name, expected, staged)? else {
        // Without an atomic exchange the only way left to put the copy at the name is a rename
        // that replaces whatever is there by then, including a save another program is writing.
        // The save is refused instead, before the target is touched.
        return Err(Error::Unsupported(format!(
            "this filesystem cannot swap a save into {name} in one step"
        )));
    };
    Ok(published)
}

#[cfg(windows)]
fn publish_here(
    dir: &Dir,
    name: &str,
    expected: &str,
    staged: &mut Staged,
    _existing: Option<&Metadata>,
) -> Result<Published, Error> {
    guarded_replace(dir, name, expected, staged)
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
    // Our copy holds the target from here on. Every failure below is about the file that the
    // exchange displaced, never about the save: report it beside the committed outcome and
    // leave that file beside the target so a later cleanup can retry.
    let displaced = match dir.symlink_metadata(&displaced_name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Some(Published::Conflict)),
        Err(error) => {
            return Ok(Some(Published::Done(Some(SaveWarning::NotCleanedUp(
                format!("{displaced_name}: {error}"),
            )))));
        }
    };
    let displaced_version = match version::version_of(None, &displaced) {
        Ok(version) => version,
        Err(error) => {
            return Ok(Some(Published::Done(Some(SaveWarning::NotCleanedUp(
                format!("{displaced_name}: {error}"),
            )))));
        }
    };
    if displaced.is_file()
        && version::without_change_time(&displaced_version)
            == version::without_change_time(expected)
    {
        // Re-check right before unlinking: a name that changed again is never removed.
        match version::still(dir, &displaced_name, &displaced) {
            Ok(true) => match dir.remove_file(&displaced_name) {
                Ok(()) => return Ok(Some(Published::Done(None))),
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    return Ok(Some(Published::Done(None)));
                }
                Err(error) => {
                    return Ok(Some(Published::Done(Some(SaveWarning::NotCleanedUp(
                        format!("{displaced_name}: {error}"),
                    )))));
                }
            },
            Ok(false) => {}
            Err(error) => {
                return Ok(Some(Published::Done(Some(SaveWarning::NotCleanedUp(
                    format!("{displaced_name}: {error}"),
                )))));
            }
        }
    }
    // Something else was at the destination: put it back in one exchange. When that is no longer
    // possible our copy stays at the name, so the save is committed and the other version is
    // preserved under a name of its own instead of being discarded.
    if handle::exchange(dir, &displaced_name, name).unwrap_or(false) {
        // Our copy is under the staging name again and nobody wants it.
        let _ = dir.remove_file(&displaced_name);
        return Ok(Some(Published::Conflict));
    }
    let kept = handle::recovery_name(name);
    let at = match handle::rename_noclobber(dir, &displaced_name, dir, &kept) {
        Ok(Noclobber::Done) => kept,
        _ => displaced_name,
    };
    Ok(Some(Published::Done(Some(SaveWarning::Preserved(at)))))
}

/// Windows publishes a guarded replacement through the entry's own handle: the file the guard
/// verified is moved aside without replacing a name, the copy takes the name without replacing
/// one either, and a step that loses a race puts the old file back. Nothing the destination holds
/// at the wrong moment is ever replaced, and a save refused here has not changed the target.
#[cfg(windows)]
fn guarded_replace(
    dir: &Dir,
    name: &str,
    expected: &str,
    staged: &mut Staged,
) -> Result<Published, Error> {
    let target = match handle::delete_handle(dir, name) {
        Ok(target) => target,
        Err(Error::Io(error)) if error.kind() == ErrorKind::NotFound => {
            return Ok(Published::Conflict);
        }
        Err(error) => return Err(error),
    };
    let metadata = target.metadata()?;
    if !metadata.is_file() {
        return Err(Error::NotFile(name.to_owned()));
    }
    let current = version::version_of(Some(&target), &metadata)?;
    if version::without_change_time(&current) != version::without_change_time(expected) {
        return Err(Error::Conflict {
            path: name.to_owned(),
            current: Some(current),
        });
    }
    // Windows refuses to replace a read-only file, so the attribute comes off through the handle
    // the guard just read, and goes back through it if the move aside is refused.
    let readonly = metadata.permissions().readonly();
    if readonly {
        handle::set_readonly(&target, false)?;
    }
    let preserved = handle::moving_name();
    match handle::rename_handle_noclobber(&target, dir, &preserved) {
        Ok(Noclobber::Done) => {}
        refused => {
            if readonly {
                handle::set_readonly(&target, true)?;
            }
            return match refused {
                Ok(Noclobber::Unsupported) => Err(Error::Unsupported(format!(
                    "this filesystem cannot move {name} aside to replace it"
                ))),
                Ok(_) => Err(Error::Io(std::io::Error::new(
                    ErrorKind::AlreadyExists,
                    format!("{preserved} is taken"),
                ))),
                Err(error) => Err(error),
            };
        }
    }
    // The old file is whole under `preserved`; the name is free for the copy.
    match handle::rename_noclobber(dir, staged.name(), dir, name) {
        Ok(Noclobber::Done) => {
            staged.release();
            let warning = match dir.remove_file(&preserved) {
                Ok(()) => None,
                Err(error) if error.kind() == ErrorKind::NotFound => None,
                Err(error) => Some(SaveWarning::NotCleanedUp(format!("{preserved}: {error}"))),
            };
            Ok(Published::Done(warning))
        }
        refused => {
            // A new writer claimed the name. Put the guarded file back, without replacing
            // anything, so the destination is what it was before this save.
            let restored = matches!(
                handle::rename_handle_noclobber(&target, dir, name),
                Ok(Noclobber::Done)
            );
            if restored && readonly {
                handle::set_readonly(&target, true)?;
            }
            if !restored {
                return Err(Error::Preserved {
                    path: name.to_owned(),
                    current: published_version(dir, name).ok(),
                    at: preserved,
                });
            }
            match refused {
                Ok(Noclobber::Unsupported) => Err(Error::Unsupported(format!(
                    "this filesystem cannot put a save at {name} without replacing a name"
                ))),
                Ok(_) => Err(Error::Conflict {
                    path: name.to_owned(),
                    current: published_version(dir, name).ok(),
                }),
                Err(error) => Err(error),
            }
        }
    }
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

            let result = save(
                root,
                "doc.md",
                b"ours\n",
                Some(&version),
                &|| {
                    std::fs::write(&target, b"outside save\n").expect("outside save");
                },
                &|| {},
            );

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
            let result = save(
                root,
                "new.md",
                b"ours\n",
                None,
                &|| {
                    std::fs::write(&target, b"appeared first\n").expect("appeared");
                },
                &|| {},
            );

            let error = result.expect_err("the appeared file must win");
            assert_eq!(error.code(), "CONFLICT");
            assert_eq!(std::fs::read(&target).expect("read"), b"appeared first\n");
            assert!(temporaries(dir).is_empty());
        });
    }

    #[test]
    fn a_version_that_cannot_be_read_after_the_commit_keeps_the_save_committed() {
        with_root(|root, dir| {
            let target = dir.join("doc.md");
            std::fs::write(&target, b"first\n").expect("seed");
            let version = crate::stat_version(root, "doc.md")
                .expect("stat")
                .expect("a version");

            // The file is gone by the time the version is read, after the rename published it.
            let result = save(root, "doc.md", b"ours\n", Some(&version), &|| {}, &|| {
                let _ = std::fs::remove_file(&target);
            });

            let saved = result.expect("a committed save is a success even without its version");
            assert!(saved.version.is_none());
            assert!(matches!(
                saved.warning,
                Some(super::SaveWarning::NoVersion(_))
            ));
        });
    }
}
