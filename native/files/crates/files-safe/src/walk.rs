// SPDX-License-Identifier: Apache-2.0

//! The confined walk: every lookup starts at the root's handle and steps down one entry at a time.
//!
//! No path string ever reaches the filesystem. Each segment is looked up through the handle of the
//! folder that holds it (`symlink_metadata`), folders are entered with `open_dir_nofollow`, and a
//! link is read with `read_link_contents` and its target spliced back into the walk. Because the
//! walk itself resolves the target, an escaping link is decided textually, without touching what
//! it points at: `..` pops the stack of names and cannot pop past the root, a relative target
//! continues from the link's folder, and an absolute target must spell the root (either its
//! canonical path or the path it was opened with) or the walk stops with `PATH_ESCAPE`. Segments a
//! target introduces are held to the same name rules as the request, so a target cannot smuggle in
//! a spelling Windows would reinterpret.
//!
//! The walk holds one open folder handle at a time and remembers only names, so a deep path or a
//! hundred concurrent resolves cannot run out of descriptors. `..` re-opens the parents it needs.

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path, PathBuf};

use cap_fs_ext::DirExt;
use cap_std::fs::{Dir, Metadata};

use crate::Root;
use crate::error::Error;
use crate::names;

/// How many links one walk may follow. The kernel stops at 40; a longer chain is a loop and not a
/// path we can prove.
const MAX_LINKS: u32 = 40;

/// How many segments one walk may visit, request and link targets together.
const MAX_DEPTH: u32 = 256;

/// One step still to walk. `Parent` only ever comes from a link target, never from the caller.
enum Segment {
    Name(OsString),
    Parent,
}

/// What the walk does with the last name it reaches.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Last {
    /// Stop on it: the caller resolves a path, or opens the entry itself.
    Entry,
    /// Step into it: the caller wants the folder that name is.
    Folder,
}

/// Whether the walk may follow a symbolic link it meets.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Links {
    /// Follow a link whose target stays inside the root.
    Follow,
    /// Refuse any link: a mutation must never be redirected by one.
    Refuse,
}

/// A folder a read-only caller serves from, with the names the disk stores for the path that
/// reached it.
#[derive(Debug)]
pub struct Stored {
    /// The handle of the folder itself.
    pub dir: Dir,
    /// The stored relative path of the folder, `/` separated; empty for the root.
    pub path: String,
    /// The stored names of the folders from the root down to `dir`, `dir`'s own name last.
    pub folders: Vec<String>,
}

/// The folder a caller acts in, with the names the disk stores for the path that reached it.
#[derive(Debug)]
pub struct Parent {
    /// The handle of the folder that holds the leaf.
    pub dir: Dir,
    /// The leaf's stored name, or the caller's spelling when nothing is there yet.
    pub name: String,
    /// The stored names of the folders from the root down to `dir`.
    pub folders: Vec<String>,
}

/// Resolves `rel` to an absolute path inside the root. The path is for read-only walkers; opening
/// anything must go through [`crate::Root::open_dir`] or [`crate::Root::open_parent`], because a
/// path can be rewritten between the walk and the open.
pub(crate) fn resolve(root: &Root, rel: &str) -> Result<PathBuf, Error> {
    let rel = Root::check(rel)?;
    let mut walk = Walk::start(root, rel, Last::Entry, Links::Follow)?;
    let leaf = walk.run(request_segments(rel))?;
    walk.absolute(leaf.as_deref())
}

/// Opens the folder `rel` names, with nothing followed after the walk.
pub(crate) fn open_dir(root: &Root, rel: &str) -> Result<Dir, Error> {
    let rel = Root::check(rel)?;
    let mut walk = Walk::start(root, rel, Last::Entry, Links::Follow)?;
    match walk.run(request_segments(rel))? {
        Some(leaf) => walk.current().open_dir_nofollow(&leaf).map_err(Into::into),
        None => walk.handle(),
    }
}

/// Opens the folder that holds `rel` and returns it with the leaf name.
pub(crate) fn open_parent(root: &Root, rel: &str) -> Result<(Dir, String), Error> {
    let rel = Root::check(rel)?;
    let (parent, leaf) = split(rel)?;
    let mut walk = Walk::start(root, rel, Last::Folder, Links::Follow)?;
    walk.run(request_segments(parent))?;
    Ok((walk.handle()?, walk.stored_leaf(leaf)?))
}

/// Opens the folder `rel` names and reports the stored names of every segment that reached it.
///
/// A read-only request uses this so the names it authorizes and the handle it serves from are one
/// walk: a link swapped in after the check cannot make the folder that answers differ from the
/// one the policy read.
pub(crate) fn open_dir_stored(root: &Root, rel: &str) -> Result<Stored, Error> {
    let rel = Root::check(rel)?;
    if rel.is_empty() {
        root.still_ours()?;
        return Ok(Stored {
            dir: root.dir().try_clone()?,
            path: String::new(),
            folders: Vec::new(),
        });
    }
    let mut walk = Walk::start(root, rel, Last::Entry, Links::Follow)?;
    let leaf = walk.run(request_segments(rel))?;
    walk.stored_dir(leaf.as_deref())
}

/// Opens the folder that holds `rel` and reports the stored names on the way to it.
pub(crate) fn open_parent_stored(root: &Root, rel: &str) -> Result<Parent, Error> {
    let rel = Root::check(rel)?;
    let (parent, leaf) = split(rel)?;
    let mut walk = Walk::start(root, rel, Last::Folder, Links::Follow)?;
    walk.run(request_segments(parent))?;
    walk.parent(leaf)
}

/// Opens the folder that holds `rel`, refusing any link on the way, and reports the stored names.
///
/// Mutations use this so the policy they apply reads the spelling the disk stores: a
/// case-insensitive volume answers `.GIT` for `.git`, and a Windows 8.3 alias answers with the
/// long name, so neither can slip past a check made on the caller's text.
pub(crate) fn open_parent_unlinked(root: &Root, rel: &str) -> Result<Parent, Error> {
    let rel = Root::check(rel)?;
    let (parent, leaf) = split(rel)?;
    let mut walk = Walk::start(root, rel, Last::Folder, Links::Refuse)?;
    walk.run(request_segments(parent))?;
    walk.parent(leaf)
}

/// The stored names of every component of `rel`, after following every link.
pub(crate) fn stored_path(root: &Root, rel: &str) -> Result<Vec<String>, Error> {
    let rel = Root::check(rel)?;
    let mut walk = Walk::start(root, rel, Last::Entry, Links::Follow)?;
    let leaf = walk.run(request_segments(rel))?;
    walk.stored_components(leaf.as_deref())
}

/// Opens the folder that holds `rel`'s last name, without resolving the spelling the disk stores
/// for any name on the way.
///
/// A caller that only asks whether one name is there needs no stored spellings, and a watcher asks
/// about thousands of names inside the same folders: a walk that resolved them would list a folder
/// for every path. Links are still followed the way [`crate::Root::open_dir`] follows them, and
/// the names on the way are used as given, which is exactly how the kernel resolves them.
pub(crate) fn open_folder_unstored(root: &Root, rel: &str) -> Result<Dir, Error> {
    let rel = Root::check(rel)?;
    let mut walk = Walk::start(root, rel, Last::Folder, Links::Follow)?;
    walk.store_names = false;
    walk.run(request_segments(rel))?;
    walk.handle()
}

/// Opens the folder `rel` names, refusing a link at any step, without resolving stored spellings.
///
/// A walker that does not follow links never lists a path through one, so a link found on the
/// way now was swapped in after the walk: it is `PATH_ESCAPE`, wherever it points, never a
/// redirection to another folder, inside the checkout or out of it.
pub(crate) fn open_folder_unlinked(root: &Root, rel: &str) -> Result<Dir, Error> {
    let rel = Root::check(rel)?;
    let mut walk = Walk::start(root, rel, Last::Folder, Links::Refuse)?;
    walk.store_names = false;
    walk.run(request_segments(rel))?;
    walk.handle()
}

/// The parent half of a non-empty relative path and its leaf.
pub(crate) fn split(rel: &str) -> Result<(&str, &str), Error> {
    match rel.rsplit_once('/') {
        Some(split) => Ok(split),
        // A name at the top of the checkout has the root itself as its folder.
        None if !rel.is_empty() => Ok(("", rel)),
        None => Err(Error::InvalidPath(rel.to_owned())),
    }
}

/// The `/`-separated form as segments. The input is already checked, so no segment is empty.
fn request_segments(rel: &str) -> VecDeque<Segment> {
    rel.split('/')
        .filter(|name| !name.is_empty())
        .map(|name| Segment::Name(OsString::from(name)))
        .collect()
}

struct Walk<'a> {
    root: &'a Root,
    /// The path being walked, for error messages.
    rel: &'a str,
    /// The folder the next segment is looked up in.
    current: Dir,
    /// The names of the folders above it, from the root down.
    names: Vec<OsString>,
    /// Whether each name on the way is resolved to the spelling the disk stores. A walk that ends
    /// in a folder a caller only reads one name from does not need it, and resolving it lists
    /// folders that a burst would otherwise read once per path.
    store_names: bool,
    /// What to do with the last name.
    last: Last,
    /// Whether a link on the way may be followed.
    follows: Links,
    /// Segments visited so far, and links followed so far.
    depth: u32,
    links: u32,
}

impl<'a> Walk<'a> {
    /// Starts at the root, after proving the root path still names the folder we hold.
    fn start(root: &'a Root, rel: &'a str, last: Last, follows: Links) -> Result<Walk<'a>, Error> {
        root.still_ours()?;
        Ok(Walk {
            root,
            rel,
            current: root.dir().try_clone()?,
            names: Vec::new(),
            store_names: true,
            last,
            follows,
            depth: 0,
            links: 0,
        })
    }

    /// Walks `pending`. The result is the entry the walk stopped on, or `None` when it ended
    /// inside a folder (`rel` was empty, or a link pointed at `.`).
    fn run(&mut self, mut pending: VecDeque<Segment>) -> Result<Option<OsString>, Error> {
        let mut leaf = None;
        while let Some(segment) = pending.pop_front() {
            self.depth += 1;
            if self.depth > MAX_DEPTH {
                return Err(Error::LimitExceeded(self.rel.to_owned()));
            }
            match segment {
                Segment::Parent => self.climb()?,
                Segment::Name(name) => leaf = self.step(name, &mut pending)?,
            }
        }
        Ok(leaf)
    }

    /// Looks one name up in the current folder.
    fn step(
        &mut self,
        name: OsString,
        pending: &mut VecDeque<Segment>,
    ) -> Result<Option<OsString>, Error> {
        let metadata = match self.current.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            // The last segment may be missing: callers resolve a path they are about to create.
            // A gap higher up means the folder chain is not there at all.
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    && pending.is_empty()
                    && self.last == Last::Entry =>
            {
                return Ok(Some(name));
            }
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            if self.follows == Links::Refuse {
                return Err(self.escape());
            }
            self.links += 1;
            if self.links > MAX_LINKS {
                return Err(Error::LinkLoop(self.rel.to_owned()));
            }
            let target = self.current.read_link_contents(&name)?;
            self.follow(&target, pending)?;
            return Ok(None);
        }
        if pending.is_empty() && self.last == Last::Entry {
            return Ok(Some(self.listed(&name, &metadata)?));
        }
        // Only a folder can carry the segments that come after it.
        if !metadata.is_dir() {
            return Err(Error::NotDirectory(self.rel.to_owned()));
        }
        let next = self.current.open_dir_nofollow(&name)?;
        let held = if self.store_names {
            match names::from_handle(&next) {
                Some(stored) => stored,
                None => self.listed(&name, &metadata)?,
            }
        } else {
            // The name that reached the folder is the one that re-opens it; nothing is listed.
            name
        };
        self.current = next;
        self.names.push(held);
        Ok(None)
    }

    /// Steps out of the current folder. The walk keeps no handle per level, so the parents the
    /// target names are opened again from the root.
    fn climb(&mut self) -> Result<(), Error> {
        if self.names.pop().is_none() {
            return Err(self.escape());
        }
        let mut dir = self.root.dir().try_clone()?;
        for name in &self.names {
            dir = dir.open_dir_nofollow(name)?;
        }
        self.current = dir;
        Ok(())
    }

    /// Splices a link target into the walk. Nothing outside the root is ever looked at: an
    /// absolute target is accepted only when it spells the root, and the rest of it is walked
    /// from the root again.
    fn follow(&mut self, target: &Path, pending: &mut VecDeque<Segment>) -> Result<(), Error> {
        if target.is_absolute() {
            let Some(rest) = self.inside_root(target) else {
                return Err(self.escape());
            };
            for segment in self.target_segments(&rest)?.into_iter().rev() {
                pending.push_front(segment);
            }
            self.current = self.root.dir().try_clone()?;
            self.names.clear();
            return Ok(());
        }
        for segment in self.target_segments(target)?.into_iter().rev() {
            pending.push_front(segment);
        }
        Ok(())
    }

    /// The part of an absolute `target` below the root, when it is below the root at all. The
    /// target is compared as text against the canonical root and against the path the root was
    /// opened with, since the two can differ (`/var` and `/private/var` on macOS).
    fn inside_root(&self, target: &Path) -> Option<PathBuf> {
        let rest = target
            .strip_prefix(self.root.path())
            .or_else(|_| target.strip_prefix(self.root.opened()))
            .ok()
            .map(Path::to_path_buf);
        if rest.is_some() {
            return rest;
        }
        #[cfg(windows)]
        {
            crate::windows::relative(self.root.path().to_str()?, target.to_str()?)
                .map(PathBuf::from)
        }
        #[cfg(not(windows))]
        None
    }

    /// A relative link target as segments. `..` is kept and applied to the stack of names the walk
    /// already proved, which is what keeps it inside the root.
    fn target_segments(&self, target: &Path) -> Result<Vec<Segment>, Error> {
        let mut segments = Vec::new();
        for component in target.components() {
            match component {
                Component::Normal(part) => {
                    // A target is not a request, but it names entries, so it is held to the same
                    // rules: a part Windows would read differently, or one that is not text at
                    // all, leaves nothing we can prove.
                    let name = part.to_str().filter(|name| crate::check::segment(name));
                    match name {
                        Some(name) => segments.push(Segment::Name(OsString::from(name))),
                        None => return Err(self.escape()),
                    }
                }
                Component::ParentDir => segments.push(Segment::Parent),
                Component::CurDir => {}
                // A target that names a root of its own is not a relative path after all.
                Component::RootDir | Component::Prefix(_) => return Err(self.escape()),
            }
        }
        Ok(segments)
    }

    /// The stored name of a leaf that is not part of the walk, without following it: a dangling
    /// link is a name to create over or delete, not something to resolve.
    fn stored_leaf(&self, leaf: &str) -> Result<String, Error> {
        let requested = OsStr::new(leaf);
        let name = match self.current.symlink_metadata(requested) {
            Ok(metadata) => self.listed(requested, &metadata)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => requested.to_os_string(),
            Err(error) => return Err(error.into()),
        };
        Ok(name.into_string().unwrap_or_else(|_| leaf.to_owned()))
    }

    /// The parent handle and stored leaf of a walk that stopped in the parent folder.
    fn parent(&self, leaf: &str) -> Result<Parent, Error> {
        Ok(Parent {
            dir: self.handle()?,
            name: self.stored_leaf(leaf)?,
            folders: self.stored_names()?,
        })
    }

    /// The folder the walk stopped on, with the stored names that reached it.
    ///
    /// The handle is opened without following, because the walk already followed any link on the
    /// way; a name that is not a folder there is `NOT_DIRECTORY`, never something to guess at.
    fn stored_dir(&self, leaf: Option<&OsStr>) -> Result<Stored, Error> {
        let mut folders = self.stored_names()?;
        let Some(name) = leaf else {
            return Ok(Stored {
                dir: self.handle()?,
                path: folders.join("/"),
                folders,
            });
        };
        let metadata = self.current.symlink_metadata(name)?;
        if !metadata.is_dir() {
            return Err(Error::NotDirectory(self.rel.to_owned()));
        }
        let dir = self.current.open_dir_nofollow(name)?;
        folders.push(name.to_str().ok_or_else(|| self.changed())?.to_owned());
        Ok(Stored {
            dir,
            path: folders.join("/"),
            folders,
        })
    }

    /// Every stored name from the root to the entry the walk stopped on.
    fn stored_components(&self, leaf: Option<&OsStr>) -> Result<Vec<String>, Error> {
        let mut names = self.stored_names()?;
        if let Some(leaf) = leaf {
            names.push(leaf.to_str().ok_or_else(|| self.changed())?.to_owned());
        }
        Ok(names)
    }

    /// The folders above the current one, as exact strings.
    ///
    /// A name that is not UTF-8 cannot have been requested as a UTF-8 path, so a stored name that
    /// fails to convert means the folder changed under the walk rather than something to guess.
    fn stored_names(&self) -> Result<Vec<String>, Error> {
        let mut names = Vec::with_capacity(self.names.len());
        for name in &self.names {
            names.push(name.to_str().ok_or_else(|| self.changed())?.to_owned());
        }
        Ok(names)
    }

    fn changed(&self) -> Error {
        Error::PathChanged(self.rel.to_owned())
    }

    /// The name the current folder stores for an entry it holds.
    fn listed(&self, name: &OsStr, metadata: &Metadata) -> Result<OsString, Error> {
        names::listed(
            self.root.cache(),
            self.current(),
            &self.folder_path(),
            name,
            metadata,
        )
    }

    /// The folders above `current`, as the cache spells them.
    fn folder_path(&self) -> String {
        let mut path = String::new();
        for name in &self.names {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(&name.to_string_lossy());
        }
        path
    }

    /// The absolute result, re-proven against the canonical root.
    fn absolute(&self, leaf: Option<&OsStr>) -> Result<PathBuf, Error> {
        let mut path = self.root.path().to_path_buf();
        for name in &self.names {
            path.push(name);
        }
        if let Some(leaf) = leaf {
            path.push(leaf);
        }
        if path.starts_with(self.root.path()) {
            Ok(path)
        } else {
            Err(self.escape())
        }
    }

    fn current(&self) -> &Dir {
        &self.current
    }

    fn handle(&self) -> Result<Dir, Error> {
        Ok(self.current.try_clone()?)
    }

    fn escape(&self) -> Error {
        Error::PathEscape(self.rel.to_owned())
    }
}
