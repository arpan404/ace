// SPDX-License-Identifier: Apache-2.0

//! Root confinement: every path ace-files touches must stay inside one checkout root.
//!
//! Paths cross the wire as relative strings in exactly one form: `/`-separated, no leading or
//! trailing `/`, no empty, `.` or `..` segments, no NUL, plus the names Windows refuses.
//! [`Root::check`] enforces that form and [`Root::resolve`] turns one into an absolute path that
//! is proven to sit inside the root, following symbolic links only while they stay inside.
//!
//! Reading and writing goes through handles, never through a path: [`Root::open_dir`] opens a
//! folder and [`Root::open_parent`] opens the folder that holds a leaf, so a rename cannot
//! redirect an operation between the check and the open. [`Root::resolve`] is left for read-only
//! walkers, which must walk with `follow_links(false)` and compare each opened file's identity
//! with the entry they walked before they trust a byte of it.

mod at;
mod case;
mod check;
mod error;
mod identity;
mod look;
mod names;
mod walk;
#[cfg(any(windows, test))]
mod windows;

pub use crate::error::Error;
pub use crate::identity::Identity;
pub use crate::look::{Found, Readings};
pub use crate::walk::{Parent, Stored};

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A checkout root: its canonical path plus a capability handle that reaches inside it.
///
/// The handle is opened once. Every lookup goes through it, so the kernel resolves each name
/// relative to that folder and cannot leave the tree even if a path is rewritten underneath.
#[derive(Clone)]
pub struct Root {
    path: PathBuf,
    opened: PathBuf,
    dir: Arc<cap_std::fs::Dir>,
    /// What names the root folder, read once from the handle when the root opened. Only Unix
    /// proves the root against it; Windows asks the handle each time.
    #[cfg_attr(not(unix), allow(dead_code))]
    identity: Option<Identity>,
    cache: Arc<Mutex<names::Cache>>,
}

impl Root {
    /// Opens `path` as a root. The path is canonicalized, so the root reports the real folder
    /// (symlinks resolved) and later comparisons are exact.
    ///
    /// Fails with `NOT_DIRECTORY` when the path exists but is not a folder, and `NOT_FOUND` when
    /// it does not exist.
    pub fn open(path: &Path) -> Result<Root, Error> {
        let opened = path.to_path_buf();
        let path = std::fs::canonicalize(&opened)?;
        if !path.is_dir() {
            return Err(Error::NotDirectory(path.display().to_string()));
        }
        let dir = cap_std::fs::Dir::open_ambient_dir(&path, cap_std::ambient_authority())?;
        let identity = dir
            .dir_metadata()
            .ok()
            .and_then(|metadata| Identity::of(&metadata));
        Ok(Root {
            path,
            opened,
            dir: Arc::new(dir),
            identity,
            cache: Arc::new(Mutex::new(names::Cache::default())),
        })
    }

    /// What names the folder behind `dir` on its volume, kept by a caller that holds the handle and
    /// has to prove it again later. `None` where the platform cannot tell one folder from another.
    pub fn folder_identity(&self, dir: &cap_std::fs::Dir) -> Option<Identity> {
        dir.dir_metadata()
            .ok()
            .and_then(|metadata| Identity::of(&metadata))
    }

    /// Whether `rel` names the folder with `identity` right now, asked with one lookup rather than
    /// a walk.
    ///
    /// A handle stays with the folder it was opened on, but the name it was opened under can lead
    /// somewhere else a moment later: the folder can be renamed away and another one, or a link out
    /// of the root, put in its place. The name is resolved once and its identity compared with what
    /// the handle said when it was opened, so a replaced folder does not match. This is a check,
    /// never an authorization: a caller told `false` opens the folder again through
    /// [`Root::open_dir`], which walks it step by step and follows no link out of the root. Nothing
    /// is kept on a platform without an identity, so `None` is always `false`.
    pub fn still_names(&self, rel: &str, identity: Option<Identity>) -> bool {
        let (Some(identity), Ok(rel)) = (identity, Root::check(rel)) else {
            return false;
        };
        if rel.is_empty() {
            return self.still_ours().is_ok();
        }
        identity::named(&self.path, &self.dir, rel) == Some(identity)
    }

    /// Whether `rel`, resolved from the root right now, is `file`, an open file whose metadata is
    /// `opened`.
    ///
    /// This is the proof a read-only walker takes after it opened a file it walked and before it
    /// reads a byte: no link is followed anywhere on the way and nothing outside the root is ever
    /// reached, so a folder above the file that was moved out of the checkout, or replaced by a
    /// link, does not lead back to the open file, and neither does a root path that now names
    /// another folder. A walker that does not follow links never yields a path through one, so
    /// refusing every link refuses nothing it walked. Linux and macOS answer in one call
    /// (`openat2` beneath the root with no links, `fstatat` with `AT_SYMLINK_NOFOLLOW_ANY`); other
    /// platforms walk the folder from the root as [`Root::open_dir_unlinked`] does.
    pub fn is_at(
        &self,
        rel: &str,
        file: &cap_std::fs::File,
        opened: &cap_std::fs::Metadata,
    ) -> bool {
        at::is_at(self, rel, file, opened)
    }

    /// The root folder's identity, read when the root opened.
    #[cfg(unix)]
    pub(crate) fn identity(&self) -> Option<Identity> {
        self.identity
    }

    /// Folder listings remembered for this root, so resolving many entries of one folder lists it
    /// once.
    pub(crate) fn cache(&self) -> &Mutex<names::Cache> {
        &self.cache
    }

    /// The canonical absolute path of the root folder.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The path the root was opened with, before canonicalizing. It can differ from
    /// [`Root::path`] when a folder on the way is a link (`/var` and `/private/var` on macOS), and
    /// both spellings count as inside the root.
    pub(crate) fn opened(&self) -> &Path {
        &self.opened
    }

    /// A capability handle on the root folder, for opening files and folders inside it.
    pub fn dir(&self) -> &cap_std::fs::Dir {
        &self.dir
    }

    /// Validates the relative form without touching the filesystem: `/`-separated, at most 4096
    /// bytes and 255 per segment, no leading or trailing `/`, no empty, `.` or `..` segments, no
    /// NUL. The empty string is the root itself.
    ///
    /// On Windows a segment also may not contain `\`, `:` or `~`, end in a dot or a space, name a
    /// device such as `CON` or `NUL`, or hold a character Windows cannot store; those spellings
    /// mean something else there than they do on Unix, so they are refused rather than guessed at.
    pub fn check(rel: &str) -> Result<&str, Error> {
        check::check(rel)
    }

    /// The absolute path for `rel`, with every symbolic link resolved.
    ///
    /// A link that leaves the root is `PATH_ESCAPE`, as is any segment that would climb out. A
    /// path whose last segment does not exist yet resolves under its parent, which is what callers
    /// that are about to create a file need; a missing segment anywhere higher up is `NOT_FOUND`.
    ///
    /// This path is for read-only walkers: a lister, the path index, a content search. Such a
    /// walker must run with `follow_links(false)` and, before reading a file it opened by this
    /// path, compare that file's identity with the identity of the entry it walked, since a name
    /// can be replaced by a link between the two. Opening, creating or deleting must go through
    /// [`Root::open_dir`] or [`Root::open_parent`]: a path can be rewritten between this walk and
    /// the open, a handle cannot.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, Error> {
        walk::resolve(self, rel)
    }

    /// Opens the folder `rel` names and returns a handle to it.
    ///
    /// Nothing is followed after the walk, so the handle is the folder that was walked into even
    /// if the path changed in between. Fails with `NOT_DIRECTORY` when the last segment is not a
    /// folder and `PATH_ESCAPE` when a link leads out of the root.
    pub fn open_dir(&self, rel: &str) -> Result<cap_std::fs::Dir, Error> {
        walk::open_dir(self, rel)
    }

    /// Opens the folder `rel` names for a walker that lists the disk itself and follows no link:
    /// a link at any step is `PATH_ESCAPE`, wherever it points.
    ///
    /// Such a walker never lists a path through a link, so a link found on the way now was swapped
    /// in after the walk and must not redirect the open, not even to another folder inside the
    /// root. The walker's names are already the spellings the disk stores, so none is looked up
    /// again; that lookup lists every folder on the way where the platform cannot name an open
    /// handle (Linux), which a content search opening thousands of folders cannot afford.
    pub fn open_dir_unlinked(&self, rel: &str) -> Result<cap_std::fs::Dir, Error> {
        walk::open_folder_unlinked(self, rel)
    }

    /// Opens the folder that holds the last segment of `rel` and returns it with that segment's
    /// name, so a read, a create, a rename or a delete can be made relative to the folder itself.
    ///
    /// Every operation then names only the leaf and goes through the returned handle, which is how
    /// a rename elsewhere cannot redirect it: readers open with no link following, and mutations
    /// create with `O_EXCL` and no link following. The leaf itself is never followed here, so a
    /// link that points nowhere, or points out of the root, comes back as a name in its folder,
    /// which is what deleting or replacing it needs. The name is the one the folder stores, so the
    /// operation lands on the entry a case-insensitive volume would match.
    pub fn open_parent(&self, rel: &str) -> Result<(cap_std::fs::Dir, String), Error> {
        walk::open_parent(self, rel)
    }

    /// Opens the folder `rel` names with the stored spelling of every folder on the way.
    ///
    /// A read-only request that authorizes names and then serves bytes uses this: the names the
    /// policy reads and the handle the answer comes from are one walk, so a link swapped in
    /// after the check cannot make the folder that answers differ from the one that was read.
    pub fn open_dir_stored(&self, rel: &str) -> Result<Stored, Error> {
        walk::open_dir_stored(self, rel)
    }

    /// [`Root::open_parent`], with the stored spelling of every folder on the way.
    ///
    /// The caller's spelling can differ from the one on disk even on a plain checkout: a
    /// case-insensitive volume answers `.GIT` for `.git`, a normalizing volume folds two Unicode
    /// spellings together, and Windows answers an 8.3 alias with the long name. A policy that
    /// reads [`Parent::folders`] therefore sees what the disk stores, and cannot be bypassed by
    /// picking another spelling of the same entry.
    pub fn open_parent_stored(&self, rel: &str) -> Result<Parent, Error> {
        walk::open_parent_stored(self, rel)
    }

    /// [`Root::open_parent_stored`], refusing any link between the root and the leaf.
    ///
    /// This is the walk a mutation uses: operations act through the returned handle and name, so
    /// no link can redirect one, and the stored names let the caller apply its policy to the entry
    /// the disk will actually change.
    pub fn open_parent_unlinked(&self, rel: &str) -> Result<Parent, Error> {
        walk::open_parent_unlinked(self, rel)
    }

    /// The stored names of every component of `rel`, with every link followed.
    ///
    /// Read-only callers use this to hold a path to a name policy before serving it. The result
    /// names the entry the disk would read: a link that leads into a protected folder reports the
    /// protected folder's name, never the link's spelling.
    pub fn stored_path(&self, rel: &str) -> Result<Vec<String>, Error> {
        walk::stored_path(self, rel)
    }

    /// The relative form of `absolute`, the inverse of [`Root::resolve`]; `None` outside the root.
    ///
    /// The root itself maps to the empty string. Only paths in the accepted form are returned, so
    /// the result always passes [`Root::check`]: a path carrying `.` or `..`, or a name the
    /// platform refuses, is `None`. Name-based policies should run on `relative(resolve(x))`, which
    /// carries the names the disk stores rather than the spelling the caller used.
    pub fn relative(&self, absolute: &Path) -> Option<String> {
        if let Ok(rest) = absolute.strip_prefix(&self.path) {
            return encode(rest);
        }
        #[cfg(windows)]
        return encode(Path::new(&windows::relative(
            self.path.to_str()?,
            absolute.to_str()?,
        )?));
        #[cfg(not(windows))]
        None
    }

    /// Proves the folder behind the handle is still the folder the root path names, so a root
    /// that was moved away and replaced by a link cannot lend its name to another tree.
    pub(crate) fn still_ours(&self) -> Result<(), Error> {
        let changed = || Error::PathChanged(self.path.display().to_string());
        let handle = self.dir.try_clone()?.into_std_file();
        match identity::same_file(handle, &self.path) {
            Ok(true) => Ok(()),
            _ => Err(changed()),
        }
    }
}

/// Turns a path inside the root into the `/`-separated form, or `None` if it is not one.
fn encode(rest: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in rest.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?),
            _ => return None,
        }
    }
    let joined = parts.join("/");
    Root::check(&joined).ok()?;
    Some(joined)
}
