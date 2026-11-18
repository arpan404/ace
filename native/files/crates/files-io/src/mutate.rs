// SPDX-License-Identifier: Apache-2.0

//! Mutations a file explorer needs: create, rename, trash, restore and remove inside the root.
//!
//! Every mutation is made through the handle of the folder that holds the entry, by the name the
//! disk stores. The leaf is never followed and no link may sit on the way: the daemon's client
//! policy is applied here, in one step with the operation, so a caller cannot skip it and a
//! spelling the volume would reinterpret cannot slip past it.
//!
//! A destructive guard is verified after the entry has been moved, not before: the move is one
//! atomic no-replace rename, and a tree whose digest does not match the one the client held is
//! moved straight back and reported as `CONFLICT`. A rename that landed and then failed to sync
//! is a success with a warning, never an error: the bytes are where the client wanted them, and
//! the daemon must not roll its own bookkeeping back for a step that already happened.

use std::io::ErrorKind;

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use files_safe::Root;

use crate::Error;
use crate::describe::Walks;
use crate::handle::{self, Noclobber};
use crate::policy;
use crate::tree::{self, Place};
use crate::version;

/// What a mutation committed, and what went wrong after it did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    /// A sentence for the log when the change landed but a later durability step did not.
    pub warning: Option<String>,
}

/// Creates a folder. The parent must exist, and nothing may be there already.
pub fn create_dir(root: &Root, path: &str) -> Result<Committed, Error> {
    create_dir_with(root, path, &handle::sync)
}

fn create_dir_with(
    root: &Root,
    path: &str,
    sync: &dyn Fn(&Dir) -> Result<(), Error>,
) -> Result<Committed, Error> {
    refuse_root(path)?;
    let parent = policy::client_parent(root, path)?;
    match parent.dir.create_dir(&parent.name) {
        Ok(()) => Ok(Committed {
            warning: settle(sync, &[&parent.dir]),
        }),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Err(Error::Conflict {
            path: path.to_owned(),
            current: version_at(root, &parent.dir, &parent.name, path)?,
        }),
        Err(error) => Err(error.into()),
    }
}

/// Moves an entry. A taken destination is `CONFLICT` unless `overwrite` is set.
///
/// A no-replace move is one atomic rename. Where the operating system or filesystem cannot make
/// one, the answer is `UNSUPPORTED` rather than a check followed by a rename that could replace a
/// destination that appeared in between.
///
/// `expected` is the version the caller worked from. When it is set, the entry is verified after
/// the move: a tree whose digest no longer matches is moved back and reported as `CONFLICT` with
/// the version found. A folder's `own` version from before the move is part of that check, since
/// a rename changes the folder's change time and nothing else.
pub fn rename(
    root: &Root,
    from: &str,
    to: &str,
    overwrite: bool,
    expected: Option<&str>,
    own: Option<&str>,
) -> Result<Committed, Error> {
    rename_with(root, from, to, overwrite, expected, own, &handle::sync)
}

fn rename_with(
    root: &Root,
    from: &str,
    to: &str,
    overwrite: bool,
    expected: Option<&str>,
    own: Option<&str>,
    sync: &dyn Fn(&Dir) -> Result<(), Error>,
) -> Result<Committed, Error> {
    refuse_root(from)?;
    refuse_root(to)?;
    if to == from
        || to
            .strip_prefix(from)
            .is_some_and(|rest| rest.starts_with('/'))
    {
        return Err(Error::InvalidArgument(format!("{to} is inside {from}")));
    }
    let source = policy::client_parent(root, from)?;
    let destination = policy::client_parent(root, to)?;
    // The destination's spelling is the caller's, not the one a case-insensitive volume answers
    // for an existing entry: a case-only rename asks for exactly that new spelling.
    let to_name = leaf_name(to);
    let metadata = source.dir.symlink_metadata(&source.name)?;
    if metadata.is_dir()
        && let Some(expected) = expected
    {
        if !expected.starts_with("tree:") {
            return Err(Error::InvalidArgument(format!(
                "{from} was described without its tree digest; stat it again"
            )));
        }
        if own.is_none() {
            return Err(Error::InvalidArgument(format!(
                "{from} needs the folder's own version; stat it again"
            )));
        }
    }
    if overwrite {
        source.dir.rename(&source.name, &destination.dir, to_name)?;
        return Ok(Committed {
            warning: settle(sync, &[&source.dir, &destination.dir]),
        });
    }
    match handle::rename_noclobber(&source.dir, &source.name, &destination.dir, to_name)? {
        Noclobber::Done => {}
        Noclobber::Exists => {
            if version::same_entry(
                &source.dir,
                &source.name,
                &destination.dir,
                &destination.name,
            )? {
                // One entry under two spellings on a case-insensitive volume: rename it so the
                // spelling on disk changes.
                source.dir.rename(&source.name, &destination.dir, to_name)?;
                return Ok(Committed {
                    warning: settle(sync, &[&source.dir, &destination.dir]),
                });
            }
            return Err(Error::Conflict {
                path: to.to_owned(),
                current: version_at(root, &destination.dir, &destination.name, to)?,
            });
        }
        Noclobber::Unsupported => {
            return Err(Error::Unsupported(format!(
                "this filesystem cannot move {from} without replacing an existing name"
            )));
        }
    }
    if let Some(expected) = expected {
        let moved = moved_version(
            root,
            from,
            to,
            &destination.dir,
            to_name,
            own,
            metadata.is_dir(),
        )?;
        if !same_version(expected, own, &moved) {
            return match handle::rename_noclobber(
                &destination.dir,
                to_name,
                &source.dir,
                &source.name,
            ) {
                Ok(Noclobber::Done) => {
                    let after = version_at(root, &source.dir, &source.name, from)?
                        .unwrap_or_else(|| moved.clone());
                    let _ = settle(sync, &[&source.dir, &destination.dir]);
                    Err(Error::Conflict {
                        path: to.to_owned(),
                        current: Some(after),
                    })
                }
                _ => Ok(Committed {
                    warning: Some(format!(
                        "{to} changed while it was being moved and could not be put back; it is at its new name with version {moved}"
                    )),
                }),
            };
        }
    }
    Ok(Committed {
        warning: settle(sync, &[&source.dir, &destination.dir]),
    })
}

/// Parks a client's entry at a generated trash endpoint at the checkout root, in one atomic
/// no-replace rename, and verifies the moved tree against the digest the client held.
///
/// The endpoint is the only reserved name a client mutation may produce, and it is produced by
/// the daemon, never typed: an endpoint that does not have the generated shape is refused.
pub fn trash(
    root: &Root,
    path: &str,
    endpoint: &str,
    expected: &str,
    own: Option<&str>,
) -> Result<Committed, Error> {
    trash_with(root, path, endpoint, expected, own, &handle::sync)
}

fn trash_with(
    root: &Root,
    path: &str,
    endpoint: &str,
    expected: &str,
    own: Option<&str>,
    sync: &dyn Fn(&Dir) -> Result<(), Error>,
) -> Result<Committed, Error> {
    refuse_root(path)?;
    if !policy::trash_endpoint(endpoint) {
        return Err(Error::InvalidArgument(format!(
            "{endpoint} is not a trash endpoint"
        )));
    }
    let source = policy::client_parent(root, path)?;
    let metadata = source.dir.symlink_metadata(&source.name)?;
    let folder = metadata.is_dir();
    if folder && !expected.starts_with("tree:") {
        return Err(Error::InvalidArgument(format!(
            "{path} was described without its tree digest; stat it again"
        )));
    }
    if folder && own.is_none() {
        return Err(Error::InvalidArgument(format!(
            "{path} needs the folder's own version; stat it again"
        )));
    }
    let trash = root.dir().try_clone()?;
    match trash.symlink_metadata(endpoint) {
        Ok(_) => return Err(taken(endpoint)),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    match handle::rename_noclobber(&source.dir, &source.name, &trash, endpoint)? {
        Noclobber::Done => {}
        Noclobber::Exists => return Err(taken(endpoint)),
        Noclobber::Unsupported => {
            return Err(Error::Unsupported(format!(
                "this filesystem cannot move {path} into the trash without replacing a name"
            )));
        }
    }
    let moved = moved_version(root, path, endpoint, &trash, endpoint, own, folder)?;
    if !same_version(expected, own, &moved) {
        return match handle::rename_noclobber(&trash, endpoint, &source.dir, &source.name) {
            Ok(Noclobber::Done) => {
                let after = version_at(root, &source.dir, &source.name, path)?
                    .unwrap_or_else(|| moved.clone());
                let _ = settle(sync, &[&source.dir, &trash]);
                Err(Error::Conflict {
                    path: path.to_owned(),
                    current: Some(after),
                })
            }
            // The original name was taken while the entry was away. It is still safely in the
            // trash, so the delete is reported as done rather than rolled back.
            _ => Ok(Committed {
                warning: Some(format!(
                    "{path} changed while it was being deleted and could not be put back; it is in {endpoint} with version {moved}"
                )),
            }),
        };
    }
    Ok(Committed {
        warning: settle(sync, &[&source.dir, &trash]),
    })
}

/// Moves a trashed entry back to a client path, in one atomic no-replace rename.
///
/// The trashed entry is the daemon's own and the destination is the client's, so only the
/// destination is held to the client policy. A destination that appeared is `CONFLICT` with its
/// version, and the trashed entry stays where it is for another try.
pub fn untrash(root: &Root, endpoint: &str, path: &str) -> Result<Committed, Error> {
    untrash_with(root, endpoint, path, &handle::sync)
}

fn untrash_with(
    root: &Root,
    endpoint: &str,
    path: &str,
    sync: &dyn Fn(&Dir) -> Result<(), Error>,
) -> Result<Committed, Error> {
    refuse_root(path)?;
    if !policy::trash_endpoint(endpoint) {
        return Err(Error::InvalidArgument(format!(
            "{endpoint} is not a trash endpoint"
        )));
    }
    let trash = root.dir().try_clone()?;
    match trash.symlink_metadata(endpoint) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            // A delete never parks a link, so an endpoint that is one was planted by something
            // else; moving it to a client path would install a link the client never named.
            return Err(Error::InvalidArgument(format!(
                "{endpoint} is not a trashed entry"
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(Error::Io(std::io::Error::from(ErrorKind::NotFound)));
        }
        Err(error) => return Err(error.into()),
    }
    let destination = policy::client_parent(root, path)?;
    let to_name = leaf_name(path);
    match handle::rename_noclobber(&trash, endpoint, &destination.dir, to_name)? {
        Noclobber::Done => Ok(Committed {
            warning: settle(sync, &[&destination.dir, &trash]),
        }),
        Noclobber::Exists => Err(Error::Conflict {
            path: path.to_owned(),
            current: version_at(root, &destination.dir, &destination.name, path)?,
        }),
        Noclobber::Unsupported => Err(Error::Unsupported(format!(
            "this filesystem cannot move {endpoint} out of the trash without replacing a name"
        ))),
    }
}

/// Deletes a file, or a folder with everything inside it.
///
/// This is the daemon's own cleanup of an expired or cancelled entry, never a client delete: a
/// client's delete goes to [`trash`], which keeps the entry restorable. It reaches its own
/// generated trash endpoint without the client's name policy and is held to that policy on every
/// other path, so the op cannot be used to delete git's store or a transfer temporary.
pub fn remove(root: &Root, path: &str) -> Result<Committed, Error> {
    remove_with(root, path, &handle::sync)
}

fn remove_with(
    root: &Root,
    path: &str,
    sync: &dyn Fn(&Dir) -> Result<(), Error>,
) -> Result<Committed, Error> {
    refuse_root(path)?;
    let (dir, name) = if policy::trash_endpoint(path) {
        root.open_parent(path)?
    } else {
        let parent = policy::client_parent(root, path)?;
        (parent.dir, parent.name)
    };
    let metadata = dir.symlink_metadata(&name)?;
    if metadata.is_dir() {
        dir.remove_dir_all(&name)?;
    } else {
        dir.remove_file(&name)?;
    }
    Ok(Committed {
        warning: settle(sync, &[&dir]),
    })
}

/// The version a moved entry has now, read the way the caller's expectation was recorded.
fn moved_version(
    root: &Root,
    recorded: &str,
    location: &str,
    dir: &Dir,
    name: &str,
    own: Option<&str>,
    folder: bool,
) -> Result<String, Error> {
    let metadata = dir.symlink_metadata(name)?;
    if !folder || !metadata.is_dir() {
        return version::version_of_entry(dir, name, &metadata);
    }
    let handle = dir.open_dir_nofollow(name)?;
    let own = own.ok_or_else(|| {
        Error::InvalidArgument(format!(
            "{recorded} needs the folder's own version; stat it again"
        ))
    })?;
    Ok(tree::version_at(
        root,
        &Place {
            recorded,
            location,
            own,
        },
        &handle,
        &Walks::unbounded(),
    )?
    .version)
}

/// Whether a moved entry still carries the version the client expected.
///
/// A file's identity, size and modification time survive a rename; only its change time moves, so
/// the last field is left out. A folder digest was taken with its own pre-move version, so it
/// compares whole.
fn same_version(expected: &str, own: Option<&str>, current: &str) -> bool {
    if own.is_some() {
        current == expected
    } else {
        version::without_change_time(current) == version::without_change_time(expected)
    }
}

/// The version a conflict reports for an entry, from the folder that holds it.
///
/// A folder reports its full digest: a conflict is what the client guards its next attempt with,
/// and a shallow own version would not be accepted as a guard.
fn version_at(root: &Root, dir: &Dir, name: &str, path: &str) -> Result<Option<String>, Error> {
    Ok(
        crate::version::entry_version(root, dir, name, path, &Walks::complete())?
            .map(|found| found.version),
    )
}

/// A generated trash endpoint that someone else already occupies.
fn taken(endpoint: &str) -> Error {
    Error::InvalidArgument(format!("the trash endpoint {endpoint} is taken"))
}

/// Runs the folder syncs that make a committed rename durable, and reports the first failure.
///
/// A sync error after the rename has already landed is not a failed operation: the entry is
/// where the client asked for it. Reporting an error there would make a caller undo bookkeeping
/// for a change that happened, so the failure becomes a warning.
fn settle(sync: &dyn Fn(&Dir) -> Result<(), Error>, dirs: &[&Dir]) -> Option<String> {
    for dir in dirs {
        if let Err(error) = sync(dir) {
            return Some(format!(
                "the change landed but could not be synced: {error}"
            ));
        }
    }
    None
}

/// The last segment of a checked relative path.
fn leaf_name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

/// The root itself is never created, renamed, trashed or removed.
fn refuse_root(path: &str) -> Result<(), Error> {
    if path.is_empty() {
        Err(Error::InvalidArgument(path.to_owned()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::trash_with;
    use crate::Error;

    fn root(dir: &std::path::Path) -> files_safe::Root {
        files_safe::Root::open(dir).expect("open root")
    }

    fn walks() -> crate::describe::Walks<'static> {
        crate::describe::Walks::unbounded()
    }

    #[test]
    fn a_rename_that_landed_is_a_success_even_when_the_sync_fails() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::write(temp.path().join("gone.md"), b"kept\n").expect("write");
        let root = root(temp.path());
        let version = crate::stat_version(&root, "gone.md")
            .expect("stat")
            .expect("a version");

        let result = trash_with(
            &root,
            "gone.md",
            ".ace-upload-trash-1",
            &version,
            None,
            &|_| Err(Error::Io(std::io::Error::other("disk went away"))),
        );

        let committed = result.expect("a landed rename is a success");
        assert!(committed.warning.is_some(), "{committed:?}");
        assert!(!temp.path().join("gone.md").exists());
        assert!(temp.path().join(".ace-upload-trash-1").is_file());
    }

    #[test]
    fn a_folder_that_changed_is_put_back_and_reported_with_its_current_digest() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join("docs")).expect("folder");
        fs::write(temp.path().join("docs/a.md"), b"a").expect("write");
        let root = root(temp.path());
        let before = crate::describe(&root, "docs", &walks()).expect("describe");
        let own = before.own_version.clone().expect("own");
        // The client's expectation is one state, the tree on disk is another.
        fs::write(temp.path().join("docs/b.md"), b"b").expect("write");

        let result = trash_with(
            &root,
            "docs",
            ".ace-upload-trash-2",
            &before.version,
            Some(&own),
            &|_| Ok(()),
        );

        let error = result.expect_err("a changed folder must conflict");
        assert_eq!(error.code(), "CONFLICT");
        let Error::Conflict { current, .. } = &error else {
            panic!("{error:?}");
        };
        assert!(
            current
                .as_deref()
                .is_some_and(|version| version.starts_with("tree:")),
            "the conflict carries the digest found: {current:?}"
        );
        assert!(
            temp.path().join("docs/b.md").is_file(),
            "the folder is back"
        );
        assert!(!temp.path().join(".ace-upload-trash-2").exists());
    }

    #[test]
    fn a_shallow_own_version_is_not_a_guard_for_a_folder() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join("docs")).expect("folder");
        let root = root(temp.path());
        let shallow = crate::describe_entry(&root, "docs").expect("entry");

        let result = trash_with(
            &root,
            "docs",
            ".ace-upload-trash-3",
            &shallow.version,
            None,
            &|_| Ok(()),
        );

        let error = result.expect_err("an own version is not a tree guard");
        assert_eq!(error.code(), "INVALID_ARGUMENT");
        assert!(temp.path().join("docs").is_dir(), "nothing moved");
    }

    #[test]
    fn the_policy_holds_in_one_step_with_the_mutation() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join(".git")).expect("git");
        fs::write(temp.path().join(".git/config"), b"[core]\n").expect("write");
        // On a case-insensitive volume this is the same folder as `.git`; on a case-sensitive one
        // it is a second folder, and both spellings must reach the policy.
        let _ = fs::create_dir(temp.path().join(".GIT"));
        let root = root(temp.path());

        for path in [".git/mine", ".GIT/mine"] {
            let error = super::create_dir(&root, path).expect_err("git's store is reserved");
            assert_eq!(error.code(), "INVALID_PATH", "{path}");
            assert!(!temp.path().join(path).exists());
        }
    }

    #[test]
    fn the_internal_remove_reaches_the_trash_and_nothing_reserved() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join(".git")).expect("git");
        fs::write(temp.path().join(".git/config"), b"[core]\n").expect("write");
        fs::create_dir(temp.path().join(".ace-upload-trash-5")).expect("trash");
        fs::write(temp.path().join(".ace-upload-trash-5/kept"), b"kept").expect("write");
        let root = root(temp.path());

        let error = super::remove(&root, ".git/config").expect_err("git's store is not a target");
        assert_eq!(error.code(), "INVALID_PATH");
        assert!(temp.path().join(".git/config").is_file());

        super::remove(&root, ".ace-upload-trash-5").expect("the daemon clears its own trash");
        assert!(!temp.path().join(".ace-upload-trash-5").exists());
    }

    #[test]
    fn a_trash_endpoint_that_is_not_generated_is_refused() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::write(temp.path().join("a.md"), b"a").expect("write");
        let root = root(temp.path());
        let version = crate::stat_version(&root, "a.md")
            .expect("stat")
            .expect("a version");

        for endpoint in [
            ".git/trash",
            ".ace-upload-trash-a b",
            "trash-1",
            ".ace-upload-1",
        ] {
            let error = super::trash(&root, "a.md", endpoint, &version, None)
                .expect_err("only a generated endpoint is a trash name");
            assert_eq!(error.code(), "INVALID_ARGUMENT", "{endpoint}");
        }
        assert!(temp.path().join("a.md").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_restore_refuses_a_planted_link_at_the_trash_endpoint() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::write(temp.path().join("target.md"), b"target").expect("write");
        std::os::unix::fs::symlink("target.md", temp.path().join(".ace-upload-trash-6"))
            .expect("link");
        let root = root(temp.path());

        let error = super::untrash(&root, ".ace-upload-trash-6", "back.md")
            .expect_err("a link is not a trashed entry");

        assert_eq!(error.code(), "INVALID_ARGUMENT");
        assert!(!temp.path().join("back.md").exists());
        assert!(temp.path().join(".ace-upload-trash-6").is_symlink());
    }

    #[test]
    fn a_restore_never_replaces_a_destination_that_appeared() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::write(temp.path().join(".ace-upload-trash-4"), b"trashed\n").expect("trash");
        fs::write(temp.path().join("back.md"), b"squatter\n").expect("squatter");
        let root = root(temp.path());

        let error =
            super::untrash(&root, ".ace-upload-trash-4", "back.md").expect_err("a taken name");
        assert_eq!(error.code(), "CONFLICT");
        assert_eq!(
            fs::read(temp.path().join("back.md")).expect("read"),
            b"squatter\n"
        );
        assert!(temp.path().join(".ace-upload-trash-4").is_file());
    }

    #[test]
    fn a_mutation_never_crosses_a_link() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir(temp.path().join("docs")).expect("folder");
        #[cfg(unix)]
        std::os::unix::fs::symlink("docs", temp.path().join("alias")).expect("link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir("docs", temp.path().join("alias")).expect("link");
        let root = root(temp.path());

        let error = super::rename(&root, "alias", "moved", false, None, None)
            .expect_err("a link is never a source");
        assert_eq!(error.code(), "PATH_ESCAPE");
    }
}
