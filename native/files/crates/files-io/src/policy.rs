// SPDX-License-Identifier: Apache-2.0

//! The daemon's client policy, applied to the names the disk stores.
//!
//! A client never sees git's store, never picks one of the daemon's transfer temporaries, and
//! never mutates through a link. The names come from `files-safe`'s walk, which reports the
//! spelling the disk stores: a case-insensitive volume answers `.GIT` for `.git`, a normalizing
//! volume folds two spellings into one, and Windows answers an 8.3 alias with the long name, so a
//! check made on the caller's text alone is not a check at all.
//!
//! `trash` and `untrash` are the one exception: the daemon's own delete parks an entry under a
//! generated endpoint, and only that endpoint is exempt. The client's end of a trash or restore
//! is still held to the whole policy.

use cap_std::fs::Dir;
use files_safe::{Parent, Root};

use crate::Error;

/// The name git's store has in every checkout, in any spelling.
const GIT: &str = ".git";

/// What every transfer temporary starts with: upload staging files and the trash's entries.
const TEMPORARY: &str = ".ace-upload-";

/// What a delete parks an entry under, followed by the daemon's own id.
const TRASH: &str = ".ace-upload-trash-";

/// What a case-only move parks an entry under while it travels between two spellings.
const MOVING: &str = ".ace-upload-move-";

/// What a save writes down before its copy takes the target's name.
pub(crate) const JOURNAL: &str = ".ace-upload-journal-";

/// The folder a read-only request may serve, with the stored path that names it.
///
/// One walk proves the names and hands back the handle, so a link swapped in after the check
/// cannot make the folder that answers differ from the folder the policy read.
pub fn authorized_dir(root: &Root, rel: &str) -> Result<(cap_std::fs::Dir, String), Error> {
    let stored = root.open_dir_stored(rel)?;
    refuse(&stored.folders, rel)?;
    Ok((stored.dir, stored.path))
}

/// The folder and stored leaf of a read-only request, after the whole policy.
///
/// The leaf itself is never followed, so `stat` can report a link as a link; what a link leads to
/// is read and held to the policy too, so a link into git's store or the trash is refused exactly
/// like the spelling that names it. The returned handle is the one the answer must be read
/// through: re-walking the path would let the name change between the check and the read.
pub fn authorized_parent(root: &Root, path: &str) -> Result<Parent, Error> {
    let parent = root.open_parent_stored(path)?;
    refuse_components(&parent.folders, &parent.name, path)?;
    if linked(&parent.dir, &parent.name)? {
        authorized_target(root, path)?;
    }
    Ok(parent)
}

/// The folder and stored leaf a read acts on: a final link followed, with the names it leads to
/// held to the policy.
pub fn authorized_target(root: &Root, path: &str) -> Result<Parent, Error> {
    let target = crate::handle::target_parent_stored(root, path)?;
    refuse_components(&target.folders, &target.name, path)?;
    Ok(target)
}

/// Whether the entry at this name is a link, without following it.
fn linked(dir: &Dir, name: &str) -> Result<bool, Error> {
    match dir.symlink_metadata(name) {
        Ok(metadata) => Ok(metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// The folder and stored leaf of a client mutation, after the whole policy: no reserved name in
/// the stored path, no link between the root and the leaf, and no link as the leaf.
pub(crate) fn client_parent(root: &Root, path: &str) -> Result<Parent, Error> {
    let parent = root.open_parent_unlinked(path)?;
    let mut names = parent.folders.clone();
    names.push(parent.name.clone());
    refuse(&names, path)?;
    refuse_link_leaf(&parent.dir, &parent.name, path)?;
    Ok(parent)
}

/// Refuse a path whose stored components are already in hand.
///
/// A read asks this before it serves a byte: the folder chain and leaf come from the same
/// `files-safe` walk whose handle the read then uses, so the check and the bytes name one entry.
pub(crate) fn refuse_components(folders: &[String], leaf: &str, path: &str) -> Result<(), Error> {
    if folders.iter().any(|name| reserved(name)) || reserved(leaf) {
        return Err(Error::Path(files_safe::Error::InvalidPath(path.to_owned())));
    }
    Ok(())
}

/// Refuse one name the daemon reserves: git's store and any transfer temporary.
pub(crate) fn reserved(name: &str) -> bool {
    name.eq_ignore_ascii_case(GIT)
        || name
            .as_bytes()
            .get(..TEMPORARY.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(TEMPORARY.as_bytes()))
}

/// Whether `name` is the generated endpoint a delete parks an entry under.
///
/// The shape is the daemon's alone: one name at the checkout root, the trash prefix, and the
/// catalog's id alphabet. Nothing a person typed ever has it.
pub(crate) fn trash_endpoint(name: &str) -> bool {
    generated(name, TRASH, 128)
}

/// Whether `name` is the generated staging name a case-only move parks its entry under.
pub(crate) fn moving_endpoint(name: &str) -> bool {
    generated(name, MOVING, 160)
}

/// Whether `name` is a save journal: one record at the checkout root.
pub(crate) fn save_journal(name: &str) -> bool {
    generated(name, JOURNAL, 64)
}

/// Whether `name` is one of the private names a save stages its work under.
///
/// A save's own copy is the prefix followed by `<process>-<sequence>`, and the entry it moves
/// aside on Windows is a moving name; a record may name only those two shapes.
pub(crate) fn save_staging(name: &str) -> bool {
    if moving_endpoint(name) {
        return true;
    }
    let Some(id) = name.strip_prefix(TEMPORARY) else {
        return false;
    };
    let Some((pid, sequence)) = id.split_once('-') else {
        return false;
    };
    !pid.is_empty()
        && !sequence.is_empty()
        && pid.bytes().all(|byte| byte.is_ascii_digit())
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
}

/// A name the daemon generates: its own prefix plus an id from the catalog's alphabet.
fn generated(name: &str, prefix: &str, longest: usize) -> bool {
    let Some(id) = name.strip_prefix(prefix) else {
        return false;
    };
    !id.is_empty()
        && id.len() <= longest
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The folder and leaf of one of the daemon's own generated entries, reached only by code it owns.
///
/// No reserved name is refused here, because the whole point is to reach the daemon's staging
/// entries; every other rule still holds: no link between the root and the leaf, and no link as
/// the leaf, so the daemon never moves something a person planted to point elsewhere.
pub(crate) fn internal_parent(root: &Root, path: &str) -> Result<Parent, Error> {
    let parent = root.open_parent_unlinked(path)?;
    refuse(&parent.folders, path)?;
    refuse_link_leaf(&parent.dir, &parent.name, path)?;
    Ok(parent)
}

/// Refuse a mutation whose leaf is a link, which is never a target the client named.
fn refuse_link_leaf(dir: &Dir, name: &str, path: &str) -> Result<(), Error> {
    match dir.symlink_metadata(name) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(Error::Path(files_safe::Error::PathEscape(path.to_owned())))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Refuse when any stored component is one of the daemon's own names.
fn refuse(names: &[String], path: &str) -> Result<(), Error> {
    if names.iter().any(|name| reserved(name)) {
        return Err(Error::Path(files_safe::Error::InvalidPath(path.to_owned())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{reserved, trash_endpoint};

    #[test]
    fn reserves_git_and_the_temporaries_in_every_spelling() {
        for name in [".git", ".GIT", ".Git"] {
            assert!(reserved(name), "{name}");
        }
        for name in [".ace-upload-1", ".ACE-UPLOAD-1", ".ace-upload-trash-9"] {
            assert!(reserved(name), "{name}");
        }
        for name in [".gitignore", "git", ".ace-upload", "notes.md"] {
            assert!(!reserved(name), "{name}");
        }
    }

    #[test]
    fn the_trash_endpoint_is_one_generated_name() {
        assert!(trash_endpoint(".ace-upload-trash-9f0a"));
        assert!(trash_endpoint(".ace-upload-trash-a_b-1"));
        for name in [
            ".ace-upload-trash-",
            ".ace-upload-trash-a/b",
            ".ace-upload-trash-a b",
            ".ACE-UPLOAD-TRASH-1",
            ".ace-upload-1",
            "trash-1",
        ] {
            assert!(!trash_endpoint(name), "{name}");
        }
    }
}
