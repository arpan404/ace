// SPDX-License-Identifier: Apache-2.0

//! Mutations a file explorer needs: create, rename, trash, restore and remove inside the root.
//!
//! Every mutation is made through the handle of the folder that holds the entry, by the name the
//! disk stores. The leaf is never followed and no link may sit on the way: the daemon's client
//! policy is applied here, in one step with the operation, so a caller cannot skip it and a
//! spelling the volume would reinterpret cannot slip past it.
//!
//! A destructive guard is verified after the entry has been moved, not before: the move is one
//! atomic no-replace rename — or, when both names fold together into one entry, a staged two-step
//! that never replaces a name either — and a tree that does not match the one the client held is
//! moved straight back and reported as `CONFLICT`. A rename that landed and then failed to sync
//! is a success with a warning, never an error: the bytes are where the client wanted them, and
//! the daemon must not roll its own bookkeeping back for a step that already happened.

use std::io::ErrorKind;

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use files_safe::{Parent, Root};

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
    /// The version of the entry the mutation committed, when it was read from that very entry.
    ///
    /// A create reports the digest of the folder it made; a move of a file reports the version of
    /// the entry it moved, proven to be the one it found before the move. A folder's move reports
    /// no digest here: the digest records the new path, so the caller takes it after the queue,
    /// under the folder's own version this reply carries as its identity.
    pub version: Option<String>,
    /// A folder's own version after the move, so a digest taken later is accepted only while the
    /// name still holds the folder that was moved.
    pub identity: Option<String>,
    /// Where a move left the entry under a visible name of its own, when it could not complete
    /// the move and could not put the entry back either.
    pub recovery: Option<String>,
}

impl Committed {
    /// A change that landed and has nothing more to report.
    fn plain(warning: Option<String>) -> Committed {
        Committed {
            warning,
            version: None,
            identity: None,
            recovery: None,
        }
    }
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
    // The folder is made under a private name and published in one no-replace rename, so the
    // version below comes from the folder this create made and never from a name that another
    // program took between the create and the read.
    let mut staged = handle::StagedDir::new(&parent.dir)?;
    match handle::rename_noclobber(&parent.dir, staged.name(), &parent.dir, &parent.name)? {
        Noclobber::Done => {
            crate::hooks::reached(crate::hooks::Step::AfterCreateDir, path, path);
            let version = staged.published_tree(root, &parent.name, path, &Walks::complete())?;
            staged.release();
            Ok(Committed {
                warning: settle(sync, &[&parent.dir]),
                version,
                identity: None,
                recovery: None,
            })
        }
        Noclobber::Exists => Err(Error::Conflict {
            path: path.to_owned(),
            current: version_at(root, &parent.dir, &parent.name, path)?,
        }),
        Noclobber::Unsupported => {
            // A volume without rename-without-replace still creates atomically, so the folder is
            // made directly; the version is the created folder's own digest, read at once.
            match parent.dir.create_dir(&parent.name) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    return Err(Error::Conflict {
                        path: path.to_owned(),
                        current: version_at(root, &parent.dir, &parent.name, path)?,
                    });
                }
                Err(error) => return Err(error.into()),
            }
            let created = parent.dir.open_dir_nofollow(&parent.name)?;
            let tree = tree::version(root, path, &created, &Walks::complete())?;
            Ok(Committed {
                warning: settle(sync, &[&parent.dir]),
                version: Some(tree.version),
                identity: None,
                recovery: None,
            })
        }
    }
}

/// Moves an entry. A taken destination is `CONFLICT`; a move never replaces one.
///
/// A move is one atomic no-replace rename. Where the operating system or filesystem cannot make
/// one, the answer is `UNSUPPORTED` rather than a check followed by a rename that could replace a
/// destination that appeared in between. Two names that fold into one entry on the volume — the
/// same name in another case — are moved through a staging name of their own, each step still
/// without replacing, so a name that appears in between is never overwritten.
///
/// `expected` is the version the caller worked from. When it is set, the entry is verified after
/// the move: a tree whose digest no longer matches is moved back and reported as `CONFLICT` with
/// the version found. A folder's `own` version from before the move is part of that check, since
/// a rename changes the folder's change time and nothing else, and so is the folder's identity:
/// a different folder whose contents match digests the same.
pub fn rename(
    root: &Root,
    from: &str,
    to: &str,
    expected: Option<&str>,
    own: Option<&str>,
) -> Result<Committed, Error> {
    rename_with(root, from, to, expected, own, None, &handle::sync)
}

/// Moves an entry whose case-only rename was journaled, using the staging name the journal knows.
///
/// A case-only move is two renames, so a crash between them leaves the entry under the daemon's
/// private staging name. The daemon writes the name it will use before the move starts, so a
/// later start can find and finish it; a name that does not have the generated shape is refused
/// rather than used.
pub fn rename_journaled(
    root: &Root,
    from: &str,
    to: &str,
    expected: Option<&str>,
    own: Option<&str>,
    staging: &str,
) -> Result<Committed, Error> {
    if !policy::moving_endpoint(staging) {
        return Err(Error::InvalidArgument(format!(
            "{staging} is not a staging name"
        )));
    }
    rename_with(root, from, to, expected, own, Some(staging), &handle::sync)
}

fn rename_with(
    root: &Root,
    from: &str,
    to: &str,
    expected: Option<&str>,
    own: Option<&str>,
    staging: Option<&str>,
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
    let folder = metadata.is_dir();
    // The identity the moved entry must still have: a name another program takes after the move
    // describes that program's entry, never the one this move carried.
    let moved_identity = if folder {
        None
    } else {
        Some(version::identity_of_entry(
            &source.dir,
            &source.name,
            &metadata,
        )?)
    };
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
    match handle::rename_noclobber(&source.dir, &source.name, &destination.dir, to_name)? {
        Noclobber::Done => {}
        Noclobber::Exists => {
            if !version::same_entry(
                &source.dir,
                &source.name,
                &destination.dir,
                &destination.name,
            )? {
                return Err(Error::Conflict {
                    path: to.to_owned(),
                    current: version_at(root, &destination.dir, &destination.name, to)?,
                });
            }
            // One entry under two spellings on a case-insensitive volume: the volume answers the
            // destination name with the source entry itself, so the spelling on disk can only be
            // changed by moving the entry away from both names first.
            match case_only_move(
                &source.dir,
                &source.name,
                &destination.dir,
                to_name,
                staging,
            )? {
                TwoStep::Done => {}
                TwoStep::Taken => {
                    return Err(Error::Conflict {
                        path: to.to_owned(),
                        current: version_at(root, &destination.dir, &destination.name, to)?,
                    });
                }
                TwoStep::Unsupported => {
                    return Err(Error::Unsupported(format!(
                        "this filesystem cannot rename {from} to a name that differs only in case"
                    )));
                }
                TwoStep::Stranded(at) => {
                    return Err(Error::Stranded {
                        path: to.to_owned(),
                        at,
                    });
                }
            }
        }
        Noclobber::Unsupported => {
            return Err(Error::Unsupported(format!(
                "this filesystem cannot move {from} without replacing an existing name"
            )));
        }
    }
    crate::hooks::reached(crate::hooks::Step::AfterMove, from, to);
    if let Some(expected) = expected {
        let checked = moved_state(root, from, to, &destination.dir, to_name, own, folder);
        let held = checked
            .as_ref()
            .is_ok_and(|moved| same_version(expected, own, moved));
        if !held {
            return withdrawn(
                root,
                sync,
                (&destination.dir, to_name),
                &source,
                from,
                to,
                expected,
                checked.ok(),
                to,
            );
        }
    }
    // A file's version is read from the entry the move carried and accepted only while its
    // identity still matches; a folder's digest is taken by the caller after the queue, guarded
    // by the own version this reply carries.
    let (version, identity) = if folder {
        (
            None,
            own_version_at(&destination.dir, to_name).ok().flatten(),
        )
    } else {
        (
            version::moved_version(&destination.dir, to_name, moved_identity)?,
            None,
        )
    };
    Ok(Committed {
        warning: settle(sync, &[&source.dir, &destination.dir]),
        version,
        identity,
        recovery: None,
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
    crate::hooks::reached(crate::hooks::Step::AfterMove, path, endpoint);
    let checked = moved_state(root, path, endpoint, &trash, endpoint, own, folder);
    let held = checked
        .as_ref()
        .is_ok_and(|moved| same_version(expected, own, moved));
    if !held {
        return match withdrawn(
            root,
            sync,
            (&trash, endpoint),
            &source,
            path,
            path,
            expected,
            checked.ok(),
            endpoint,
        ) {
            Err(error) => Err(error),
            // The entry could not be put back at its path, so it is whole under the trash
            // endpoint. That is neither a plain delete nor a plain refusal: the caller is told
            // where it is, and a receipt naming it stays pending until someone resolves it.
            Ok(_) => Err(Error::Stranded {
                path: path.to_owned(),
                at: endpoint.to_owned(),
            }),
        };
    }
    Ok(Committed::plain(settle(sync, &[&source.dir, &trash])))
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
        Noclobber::Done => Ok(Committed::plain(settle(sync, &[&destination.dir, &trash]))),
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
    Ok(Committed::plain(settle(sync, &[&dir])))
}

/// A move that cannot be one rename because both names are the same entry under the volume's
/// folding rules.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TwoStep {
    /// The entry now has the spelling the client asked for.
    Done,
    /// Another entry claimed the destination between the two steps, so the move was put back.
    Taken,
    /// The filesystem cannot move the entry to a staging name.
    Unsupported,
    /// The second step failed and the entry could not be put back. It is whole at this path,
    /// which is the visible recovery name when one could be made and the staging name otherwise.
    Stranded(String),
}

/// Moves an entry to a staging name in its own folder and from there to its new spelling, each
/// step without replacing a name.
///
/// A case-insensitive volume answers the destination with the source entry, so neither a no-replace
/// rename nor a replacing one can change the spelling on disk: moving the entry to a name of its
/// own first makes both names free. A step the volume refuses is undone rather than forced, and an
/// entry that cannot be put back is moved to a visible name a person can find and reported by it.
fn case_only_move(
    from_dir: &Dir,
    from: &str,
    to_dir: &Dir,
    to: &str,
    staging: Option<&str>,
) -> Result<TwoStep, Error> {
    let staging = staging.map_or_else(handle::moving_name, str::to_owned);
    match handle::rename_noclobber(from_dir, from, from_dir, &staging)? {
        Noclobber::Done => {}
        Noclobber::Exists => {
            return Err(Error::Io(std::io::Error::new(
                ErrorKind::AlreadyExists,
                format!("{staging} is taken"),
            )));
        }
        Noclobber::Unsupported => return Ok(TwoStep::Unsupported),
    }
    crate::hooks::reached(crate::hooks::Step::BetweenMoveSteps, from, to);
    match handle::rename_noclobber(from_dir, &staging, to_dir, to) {
        Ok(Noclobber::Done) => Ok(TwoStep::Done),
        refused => {
            // Neither name is where the entry belongs now: put it back exactly where it was, and
            // report where it still is when that is not possible.
            let restored = matches!(
                handle::rename_noclobber(from_dir, &staging, from_dir, from),
                Ok(Noclobber::Done)
            );
            if !restored {
                // The staging name is one the daemon keeps out of every listing, so the entry is
                // moved to a bounded visible name beside its own before it is reported. The
                // outcome names the actual path, visible or not, so nothing is left unfindable.
                let kept = handle::recovery_name(leaf_name(from));
                let at = match handle::rename_noclobber(from_dir, &staging, from_dir, &kept) {
                    Ok(Noclobber::Done) => beside(from, &kept),
                    _ => beside(from, &staging),
                };
                return Ok(TwoStep::Stranded(at));
            }
            match refused {
                Ok(Noclobber::Exists) => Ok(TwoStep::Taken),
                Ok(Noclobber::Unsupported) => Ok(TwoStep::Unsupported),
                Err(error) => Err(error),
                Ok(Noclobber::Done) => Ok(TwoStep::Done),
            }
        }
    }
}

/// The full path of `name` beside the path `path`, which names an entry in that same folder.
fn beside(path: &str, name: &str) -> String {
    match path.rsplit_once('/') {
        Some((folder, _)) => format!("{folder}/{name}"),
        None => name.to_owned(),
    }
}

/// Finishes a move a journal recorded: the entry parked at the daemon's own staging name travels
/// to the client path, without replacing one.
pub fn recover_move(root: &Root, from: &str, to: &str) -> Result<Committed, Error> {
    refuse_root(to)?;
    if !policy::moving_endpoint(leaf_name(from)) {
        return Err(Error::InvalidArgument(format!(
            "{from} is not a staging name"
        )));
    }
    let source = policy::internal_parent(root, from)?;
    let destination = policy::client_parent(root, to)?;
    let to_name = leaf_name(to);
    match handle::rename_noclobber(&source.dir, &source.name, &destination.dir, to_name)? {
        Noclobber::Done => Ok(Committed::plain(settle(
            &handle::sync,
            &[&source.dir, &destination.dir],
        ))),
        Noclobber::Exists => Err(Error::Conflict {
            path: to.to_owned(),
            current: version_at(root, &destination.dir, &destination.name, to)?,
        }),
        Noclobber::Unsupported => Err(Error::Unsupported(format!(
            "this filesystem cannot move {from} out of staging without replacing a name"
        ))),
    }
}

/// What a moved entry is now: the version a guard compares, and for a folder its own version read
/// after the move, so the entry can be proven to be the one the guard was taken from.
struct Moved {
    version: String,
    /// A folder's own version now; a rename changed its change time and nothing else.
    own: Option<String>,
}

/// The version a moved entry has now, read the way the caller's expectation was recorded.
fn moved_state(
    root: &Root,
    recorded: &str,
    location: &str,
    dir: &Dir,
    name: &str,
    own: Option<&str>,
    folder: bool,
) -> Result<Moved, Error> {
    let metadata = dir.symlink_metadata(name)?;
    if !folder || !metadata.is_dir() {
        return Ok(Moved {
            version: version::version_of_entry(dir, name, &metadata)?,
            own: None,
        });
    }
    let handle = dir.open_dir_nofollow(name)?;
    let own = own.ok_or_else(|| {
        Error::InvalidArgument(format!(
            "{recorded} needs the folder's own version; stat it again"
        ))
    })?;
    let tree = tree::version_at(
        root,
        &Place {
            recorded,
            location,
            own,
        },
        &handle,
        &Walks::complete(),
    )?;
    Ok(Moved {
        version: tree.version,
        own: Some(version::own_version(&handle)?),
    })
}

/// Puts a moved entry back after its guard did not hold, and reports what the client should see.
///
/// A verification that could not be read at all is a guard failure too: leaving the entry at a
/// name the client's version does not cover would strand it outside the daemon's bookkeeping. If
/// the original name was taken while the entry was away, the entry is still safely at its new
/// name, so the move is reported as done with a warning rather than as a failure.
#[allow(clippy::too_many_arguments)]
fn withdrawn(
    root: &Root,
    sync: &dyn Fn(&Dir) -> Result<(), Error>,
    moved: (&Dir, &str),
    source: &Parent,
    source_path: &str,
    report_path: &str,
    expected: &str,
    checked: Option<Moved>,
    place: &str,
) -> Result<Committed, Error> {
    match handle::rename_noclobber(moved.0, moved.1, &source.dir, &source.name) {
        Ok(Noclobber::Done) => {
            let after = version_at(root, &source.dir, &source.name, source_path)
                .ok()
                .flatten()
                .or_else(|| checked.map(|moved| moved.version))
                .or_else(|| Some(expected.to_owned()));
            let _ = settle(sync, &[&source.dir, moved.0]);
            Err(Error::Conflict {
                path: report_path.to_owned(),
                current: after,
            })
        }
        _ => Ok(Committed::plain(Some(format!(
            "{report_path} changed while it was being moved and could not be put back; it is at {place}"
        )))),
    }
}

/// Whether a moved entry still carries the version the client expected.
///
/// A file's identity, size and modification time survive a rename; only its change time moves, so
/// the last field is left out. A folder digest was taken with its own pre-move version, so it
/// compares whole, and the folder must also be the same entry: a different folder whose contents
/// match byte for byte — a copy with hard links, say — digests the same as the one the guard was
/// taken from, so its identity and stable times are compared too.
fn same_version(expected: &str, own: Option<&str>, moved: &Moved) -> bool {
    match own {
        Some(own) => {
            moved.version == expected
                && moved.own.as_deref().is_some_and(|now| {
                    version::without_change_time(own) == version::without_change_time(now)
                })
        }
        None => {
            version::without_change_time(&moved.version) == version::without_change_time(expected)
        }
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

/// A folder's own version now, read through a no-follow handle to it; `None` when the name is no
/// longer a folder.
fn own_version_at(dir: &Dir, name: &str) -> Result<Option<String>, Error> {
    match dir.open_dir_nofollow(name) {
        Ok(folder) => Ok(Some(version::own_version(&folder)?)),
        Err(error) if transient_kind(error.kind()) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn transient_kind(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::NotFound | ErrorKind::NotADirectory)
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

    #[cfg(unix)]
    #[test]
    fn a_verification_that_cannot_read_the_moved_tree_puts_it_back() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(temp.path().join("docs/private")).expect("folders");
        fs::write(temp.path().join("docs/private/kept.md"), b"kept").expect("write");
        let root = root(temp.path());
        let description =
            crate::describe(&root, "docs", &walks()).expect("describe before the change");
        let own = description.own_version.clone().expect("own");
        // A folder the walk cannot enter makes the moved tree impossible to verify.
        fs::set_permissions(
            temp.path().join("docs/private"),
            fs::Permissions::from_mode(0o000),
        )
        .expect("lock the folder");

        let result = trash_with(
            &root,
            "docs",
            ".ace-upload-trash-8",
            &description.version,
            Some(&own),
            &|_| Ok(()),
        );

        fs::set_permissions(
            temp.path().join("docs/private"),
            fs::Permissions::from_mode(0o755),
        )
        .expect("unlock the folder");
        let error = result.expect_err("an unprovable tree is a guard failure");
        assert_eq!(error.code(), "CONFLICT");
        assert!(
            temp.path().join("docs/private/kept.md").is_file(),
            "put back"
        );
        assert!(!temp.path().join(".ace-upload-trash-8").exists());
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

        let error = super::rename(&root, "alias", "moved", None, None)
            .expect_err("a link is never a source");
        assert_eq!(error.code(), "PATH_ESCAPE");
    }
}
