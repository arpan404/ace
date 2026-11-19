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
use crate::journal::Journal;
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
        Some(expected) => match existing.as_ref() {
            // The first guard saw a file, so a versioned save always has the metadata the
            // displaced entry is compared with.
            Some(guard) => {
                publish_versioned(root, &dir, &name, path, expected, &mut staged, guard)?
            }
            None => {
                return Err(Error::Conflict {
                    path: path.to_owned(),
                    current: None,
                });
            }
        },
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
    // The version comes from the handle the copy was written through, which followed it to the
    // destination: a name another writer took after the commit never lends its version here.
    let version = match staged.published_version() {
        Ok(version) => Some(version),
        Err(error) => {
            warning = warning.or(Some(SaveWarning::NoVersion(error.to_string())));
            None
        }
    };
    Ok(Saved { version, warning })
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
/// inspecting what left the target. `guard` is the metadata the version was checked against.
fn publish_versioned(
    root: &Root,
    dir: &Dir,
    name: &str,
    path: &str,
    expected: &str,
    staged: &mut Staged,
    guard: &Metadata,
) -> Result<Published, Error> {
    publish_here(root, dir, name, path, expected, staged, guard)
}

#[cfg(unix)]
fn publish_here(
    root: &Root,
    dir: &Dir,
    name: &str,
    path: &str,
    expected: &str,
    staged: &mut Staged,
    guard: &Metadata,
) -> Result<Published, Error> {
    let Some(published) = exchange_publish(root, dir, name, path, expected, staged, guard)? else {
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
    root: &Root,
    dir: &Dir,
    name: &str,
    path: &str,
    expected: &str,
    staged: &mut Staged,
    guard: &Metadata,
) -> Result<Published, Error> {
    guarded_replace(root, dir, name, path, expected, staged, guard)
}

#[cfg(unix)]
fn exchange_publish(
    root: &Root,
    dir: &Dir,
    name: &str,
    path: &str,
    expected: &str,
    staged: &mut Staged,
    guard: &Metadata,
) -> Result<Option<Published>, Error> {
    // Both entries this save can move are written down before the exchange: the copy it wrote and
    // the entry it is about to displace. A crash after the exchange would otherwise leave the
    // caller's version under a private name no listing shows.
    let journal = Journal::begin(
        root,
        path,
        staged.name(),
        staged.identity()?,
        version::identity_of_entry(dir, name, guard)?,
        None,
    )?;
    if crate::hooks::halted(crate::hooks::Step::BeforeSaveSwap, path) {
        // A crash leaves the copy and the journal exactly where they are, so the staging name is
        // not given back to its drop guard.
        let _ = staged.release();
        return Err(Error::Aborted);
    }
    if !handle::exchange(dir, staged.name(), name)? {
        journal.finish();
        return Ok(None);
    }
    let displaced_name = staged.release();
    if crate::hooks::halted(crate::hooks::Step::AfterSaveSwap, path) {
        return Err(Error::Aborted);
    }
    // Our copy holds the target from here on. Every failure below is about the entry that the
    // exchange displaced, never about the save: report it beside the committed outcome and keep
    // that entry where a person can find it.
    let warning = settle_displaced(dir, name, &displaced_name, expected, guard);
    journal.finish();
    Ok(Some(Published::Done(warning)))
}

/// Deals with the entry the exchange put at the staging name: the caller's own version goes, and
/// anything else is kept under a visible name.
#[cfg(unix)]
fn settle_displaced(
    dir: &Dir,
    name: &str,
    displaced_name: &str,
    expected: &str,
    guard: &Metadata,
) -> Option<SaveWarning> {
    let displaced = match dir.symlink_metadata(displaced_name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            // The displaced name was removed by something else in the instant after the exchange.
            // Nothing of the caller's is left there, and the save itself is committed.
            return Some(SaveWarning::NotCleanedUp(format!(
                "{displaced_name} disappeared after the exchange"
            )));
        }
        Err(error) => {
            return Some(SaveWarning::NotCleanedUp(format!(
                "{displaced_name}: {error}"
            )));
        }
    };
    let displaced_version = match version::version_of(None, &displaced) {
        Ok(version) => version,
        Err(error) => {
            return Some(SaveWarning::NotCleanedUp(format!(
                "{displaced_name}: {error}"
            )));
        }
    };
    if displaced.is_file()
        && version::without_change_time(&displaced_version)
            == version::without_change_time(expected)
    {
        // Re-check right before unlinking: a name that changed again is never removed.
        match version::still(dir, displaced_name, guard) {
            Ok(true) => match dir.remove_file(displaced_name) {
                Ok(()) => return None,
                Err(error) if error.kind() == ErrorKind::NotFound => return None,
                Err(error) => {
                    return Some(SaveWarning::NotCleanedUp(format!(
                        "{displaced_name}: {error}"
                    )));
                }
            },
            Ok(false) => {}
            Err(error) => {
                return Some(SaveWarning::NotCleanedUp(format!(
                    "{displaced_name}: {error}"
                )));
            }
        }
    }
    // Something else was at the destination. Never exchange it back: our copy is published and
    // an exchange would carry whatever holds the name now into the cleanup path, where a later
    // unlink could destroy it. The other version is kept, whole, under a visible name beside the
    // target instead, and the save reports that beside its committed outcome.
    Some(preserve(dir, displaced_name, name))
}

/// Puts an entry the save displaced under a visible name beside the target, never replacing a
/// name, and reports where it went. Only a volume that refuses every visible name leaves it under
/// the staging name, which the warning still names.
#[cfg(unix)]
fn preserve(dir: &Dir, displaced: &str, target: &str) -> SaveWarning {
    for _ in 0..4 {
        let kept = handle::recovery_name(target);
        match handle::rename_noclobber(dir, displaced, dir, &kept) {
            Ok(Noclobber::Done) => return SaveWarning::Preserved(kept),
            Ok(Noclobber::Exists) => continue,
            Ok(Noclobber::Unsupported) | Err(_) => break,
        }
    }
    SaveWarning::Preserved(displaced.to_owned())
}

/// Windows publishes a guarded replacement through the entry's own handle: the file the guard
/// verified is moved aside without replacing a name, the copy takes the name without replacing
/// one either, and a step that loses a race puts the old file back. Nothing the destination holds
/// at the wrong moment is ever replaced, and a save refused here has not changed the target.
///
/// The handle is opened with a share mode that excludes writers and is held for the whole
/// publish, so no new write can land between the version check and the commit. The displaced file
/// is never deleted by name: it is deleted through that same handle only while its identity and
/// version still match the guard, and kept at a visible recovery name otherwise.
#[cfg(windows)]
fn guarded_replace(
    root: &Root,
    dir: &Dir,
    name: &str,
    path: &str,
    expected: &str,
    staged: &mut Staged,
    _guard: &Metadata,
) -> Result<Published, Error> {
    let target = match handle::publish_handle(dir, name) {
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
    // The version carries the entry's identity, so this proves both that the guard's entry is
    // still there and that nothing has written to it since the guard ran.
    let current = version::version_of(Some(&target), &metadata)?;
    if version::without_change_time(&current) != version::without_change_time(expected) {
        return Err(Error::Conflict {
            path: name.to_owned(),
            current: Some(current),
        });
    }
    crate::hooks::reached(crate::hooks::Step::GuardedPublish, name, name);
    // Windows refuses to replace a read-only file, so the attribute comes off through the handle
    // the guard just read, and goes back through it if the move aside is refused.
    let readonly = metadata.permissions().readonly();
    if readonly {
        handle::set_readonly(&target, false)?;
    }
    let preserved = handle::moving_name();
    // Both entries this save can move are written down before the first rename: the copy it wrote,
    // the entry it is about to move aside, and the name that entry will hold. A crash between the
    // two renames would otherwise leave the caller's version where no listing shows it.
    let journal = Journal::begin(
        root,
        path,
        staged.name(),
        staged.identity()?,
        version::identity_of_handle(&target, &metadata)?,
        Some(&preserved),
    )?;
    if crate::hooks::halted(crate::hooks::Step::BeforeSaveSwap, path) {
        return Err(Error::Aborted);
    }
    match handle::rename_handle_noclobber(&target, dir, &preserved) {
        Ok(Noclobber::Done) => {}
        refused => {
            if readonly {
                let _ = handle::set_readonly(&target, true);
            }
            journal.finish();
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
    if crate::hooks::halted(crate::hooks::Step::AfterSaveSwap, path) {
        // A crash leaves the copy and the journal exactly where they are.
        let _ = staged.release();
        return Err(Error::Aborted);
    }
    // The old file is whole under `preserved`; the name is free for the copy.
    let published = match handle::rename_noclobber(dir, staged.name(), dir, name) {
        Ok(Noclobber::Done) => {
            staged.release();
            // Delete only the entry this handle still proves is the guarded one. A write that
            // slipped in through a handle opened before this one changed the version, and that
            // entry is another program's work: it stays, under a visible name.
            let guarded = target.metadata().ok().and_then(|now| {
                version::version_of(Some(&target), &now)
                    .ok()
                    .map(|version| {
                        version::without_change_time(&version)
                            == version::without_change_time(expected)
                    })
            });
            if guarded == Some(true) {
                Ok(match handle::delete_by_handle(&target) {
                    Ok(()) => Published::Done(None),
                    Err(error) => Published::Done(Some(SaveWarning::NotCleanedUp(format!(
                        "{preserved}: {error}"
                    )))),
                })
            } else {
                let kept = handle::recovery_name(name);
                let at = match handle::rename_handle_noclobber(&target, dir, &kept) {
                    Ok(Noclobber::Done) => kept,
                    _ => preserved.clone(),
                };
                Ok(Published::Done(Some(SaveWarning::Preserved(at))))
            }
        }
        refused => {
            // A new writer claimed the name. Put the guarded file back, without replacing
            // anything, so the destination is what it was before this save.
            let restored = matches!(
                handle::rename_handle_noclobber(&target, dir, name),
                Ok(Noclobber::Done)
            );
            if readonly {
                let _ = handle::set_readonly(&target, true);
            }
            if !restored {
                // The guarded file cannot go back, so it is kept whole under a name a person can
                // see rather than left where no listing shows it.
                let kept = handle::recovery_name(name);
                let at = match handle::rename_handle_noclobber(&target, dir, &kept) {
                    Ok(Noclobber::Done) => kept,
                    _ => preserved.clone(),
                };
                Err(Error::Preserved {
                    path: name.to_owned(),
                    current: version_at_name(dir, name),
                    at,
                })
            } else {
                match refused {
                    Ok(Noclobber::Unsupported) => Err(Error::Unsupported(format!(
                        "this filesystem cannot put a save at {name} without replacing a name"
                    ))),
                    Ok(_) => Err(Error::Conflict {
                        path: name.to_owned(),
                        current: version_at_name(dir, name),
                    }),
                    Err(error) => Err(error),
                }
            }
        }
    };
    // A displaced entry left under `preserved` keeps its record: the next start is what makes it
    // visible. Every other outcome has no hidden entry left to resolve.
    if !matches!(&published, Err(Error::Preserved { at, .. }) if *at == preserved) {
        journal.finish();
    }
    published
}

/// The version the name holds now, for a failure that reports what is there; a read that fails
/// leaves the version out rather than turning the answer into another error.
#[cfg(windows)]
fn version_at_name(dir: &Dir, name: &str) -> Option<String> {
    let handle = handle::attribute_handle(dir, name).ok()?;
    let metadata = handle.metadata().ok()?;
    version::version_of(Some(&handle), &metadata).ok()
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
    fn a_save_that_displaces_an_outside_write_keeps_that_version_visible() {
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

            // The exchange published our copy, so the save is committed. The outside version the
            // exchange displaced is never swapped back and unlinked: it is kept beside the target
            // under a name a person can see, and the committed outcome names it.
            let saved = result.expect("the save reached its commit point");
            let Some(super::SaveWarning::Preserved(at)) = saved.warning else {
                panic!("a displaced outside save is reported: {saved:?}");
            };
            assert!(!at.starts_with(".ace-upload-"), "the copy is visible: {at}");
            assert_eq!(
                std::fs::read(dir.join(&at)).expect("read the preserved copy"),
                b"outside save\n",
                "the outside save is kept whole"
            );
            assert_eq!(
                std::fs::read(&target).expect("read"),
                b"ours\n",
                "the destination holds the version this save published"
            );
            assert!(
                temporaries(dir).is_empty(),
                "no staging file is left behind"
            );
        });
    }

    #[test]
    fn a_save_reports_the_version_of_the_copy_it_published() {
        with_root(|root, dir| {
            let target = dir.join("doc.md");
            std::fs::write(&target, b"first\n").expect("seed");
            let version = crate::stat_version(root, "doc.md")
                .expect("stat")
                .expect("a version");

            // A program that replaces the name right after the commit must not lend its version
            // to this save: the reply comes from the handle the copy was written through.
            let result = save(root, "doc.md", b"ours\n", Some(&version), &|| {}, &|| {
                let intruder = dir.join(".intruder");
                std::fs::write(&intruder, b"intruder has other bytes\n").expect("intruder");
                std::fs::rename(&intruder, &target).expect("replace the name");
            });

            let saved = result.expect("a committed save is a success");
            let reported = saved.version.expect("the save reports its version");
            let at_name = crate::stat_version(root, "doc.md")
                .expect("stat")
                .expect("a version");
            assert_ne!(
                reported, at_name,
                "the version is the published copy's, not the intruder's"
            );
            let error = crate::write(root, "doc.md", b"later\n", Some(&reported))
                .expect_err("a version no name holds must conflict rather than clobber");
            assert_eq!(error.code(), "CONFLICT");
            assert_eq!(
                std::fs::read(&target).expect("read"),
                b"intruder has other bytes\n",
                "the intruder is never overwritten through a stale reply"
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

    #[cfg(all(windows, feature = "test-hooks"))]
    #[test]
    fn a_guarded_publish_refuses_a_writer_for_its_whole_run() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        use crate::test_hooks::{Step, watch};

        with_root(|root, dir| {
            let target = dir.join("doc.md");
            std::fs::write(&target, b"first\n").expect("seed");
            let version = crate::stat_version(root, "doc.md")
                .expect("stat")
                .expect("a version");
            let refused = Arc::new(AtomicBool::new(false));
            // A writer that tries to open the target while the publish holds it must be refused:
            // nothing may land between the version check and the commit.
            let seen = Arc::clone(&refused);
            let racing = target.clone();
            let _hook = watch(move |step, name, _to| {
                if step != Step::GuardedPublish || name != "doc.md" {
                    return;
                }
                seen.store(
                    std::fs::OpenOptions::new()
                        .write(true)
                        .open(&racing)
                        .is_err(),
                    Ordering::Relaxed,
                );
            });

            save(root, "doc.md", b"ours\n", Some(&version), &|| {}, &|| {})
                .expect("the save publishes");

            assert!(
                refused.load(Ordering::Relaxed),
                "a concurrent writer is refused for the whole guarded publish"
            );
            assert_eq!(std::fs::read(&target).expect("read"), b"ours\n");
        });
    }

    #[test]
    fn a_save_whose_name_is_removed_after_the_commit_keeps_its_version_and_commit() {
        with_root(|root, dir| {
            let target = dir.join("doc.md");
            std::fs::write(&target, b"first\n").expect("seed");
            let version = crate::stat_version(root, "doc.md")
                .expect("stat")
                .expect("a version");

            // The file is gone from the name by the time the version is read, after the commit.
            // The handle this save wrote through still names its copy, so the save keeps both its
            // version and its committed outcome instead of failing.
            let result = save(root, "doc.md", b"ours\n", Some(&version), &|| {}, &|| {
                let _ = std::fs::remove_file(&target);
            });

            let saved = result.expect("a committed save is a success even without its name");
            assert!(
                saved.version.is_some(),
                "the version comes from the copy's own handle"
            );
            assert!(
                !matches!(saved.warning, Some(super::SaveWarning::NoVersion(_))),
                "the save reports no version failure: {saved:?}"
            );
        });
    }
}
