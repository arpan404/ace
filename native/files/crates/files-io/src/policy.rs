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

/// Refuse a path whose resolved names are the daemon's own.
///
/// Reads and listings call this before serving anything, so a link into `.git` or into the trash
/// is refused exactly like the spelling that names them.
pub fn refuse_reserved(root: &Root, path: &str) -> Result<(), Error> {
    refuse(&root.stored_path(path)?, path)
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
    let Some(id) = name.strip_prefix(TRASH) else {
        return false;
    };
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
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
