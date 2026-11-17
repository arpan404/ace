// SPDX-License-Identifier: Apache-2.0

//! Resolution confined to the root, one segment at a time.
//!
//! The walk starts at the canonical root and looks up one segment at a time. Only segments that
//! were already proven to be plain folders are ever joined into the next lookup, so the kernel is
//! never asked to follow a link or climb a `..` on our behalf: a symbolic link is read and its
//! target spliced back into the walk, which is what makes an escaping link an error instead of a
//! surprise. `..` pops the stack of proven folders and cannot pop past the root, and an absolute
//! link target must land inside the root before anything under it is looked up.
//!
//! The lookups themselves use `std::fs`, because `cap_std::fs::Dir` refuses to read a link whose
//! target is absolute even when it stays inside the root, and checkouts do contain those. The
//! capability handle still gets the last word: the finished path is stat'd through it, which the
//! kernel resolves relative to the root folder, so the result is proven beneath the same handle
//! every I/O crate opens files through.

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::Root;
use crate::error::Error;

/// How many links one resolution may follow. The kernel stops at 40; a longer chain is a loop and
/// not a path we can prove.
const MAX_LINKS: u32 = 40;

/// One step still to walk. `Parent` only ever comes from a link target, never from the caller.
enum Segment {
    Name(OsString),
    Parent,
}

/// Resolves `rel` to an absolute path proven to sit inside `root`.
pub(crate) fn resolve(root: &Root, rel: &str) -> Result<PathBuf, Error> {
    let rel = Root::check(rel)?;
    let mut walk = Walk {
        root,
        rel,
        parts: Vec::new(),
        links: 0,
        missing_leaf: false,
    };
    if !rel.is_empty() {
        let mut pending: VecDeque<Segment> = rel
            .split('/')
            .map(|name| Segment::Name(OsString::from(name)))
            .collect();
        walk.run(&mut pending)?;
    }
    walk.absolute()
}

struct Walk<'a> {
    root: &'a Root,
    rel: &'a str,
    /// Folders from the root down that exist and are not links, plus a missing leaf.
    parts: Vec<OsString>,
    links: u32,
    /// Whether the last part is the tolerated missing leaf rather than something that exists.
    missing_leaf: bool,
}

impl Walk<'_> {
    fn run(&mut self, pending: &mut VecDeque<Segment>) -> Result<(), Error> {
        while let Some(segment) = pending.pop_front() {
            match segment {
                Segment::Parent => {
                    if self.parts.pop().is_none() {
                        return Err(self.escape());
                    }
                }
                Segment::Name(name) => self.step(name, pending)?,
            }
        }
        Ok(())
    }

    fn step(&mut self, name: OsString, pending: &mut VecDeque<Segment>) -> Result<(), Error> {
        let candidate = self.candidate(&name);
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                self.links += 1;
                if self.links > MAX_LINKS {
                    return Err(io::Error::other("too many levels of symbolic links").into());
                }
                let target = std::fs::read_link(&candidate)?;
                self.follow(&target, pending)
            }
            Ok(metadata) => {
                // Only a folder can carry the segments that come after it.
                if !pending.is_empty() && !metadata.is_dir() {
                    return Err(Error::NotDirectory(self.rel.to_owned()));
                }
                self.parts.push(name);
                Ok(())
            }
            // The last segment may be missing: callers resolve a path they are about to create.
            // A gap higher up means the folder chain is not there at all.
            Err(error) if error.kind() == io::ErrorKind::NotFound && pending.is_empty() => {
                self.parts.push(name);
                self.missing_leaf = true;
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Splices a link target into the walk: a relative target continues from the link's folder,
    /// an absolute one must land inside the root before anything under it is looked up.
    fn follow(&mut self, target: &Path, pending: &mut VecDeque<Segment>) -> Result<(), Error> {
        if target.is_absolute() {
            let resolved = match std::fs::canonicalize(target) {
                Ok(resolved) => resolved,
                Err(error) if lexically_inside(target, self.root.path()) => {
                    return Err(error.into());
                }
                Err(_) => return Err(self.escape()),
            };
            let inside = resolved
                .strip_prefix(self.root.path())
                .map_err(|_| self.escape())?;
            self.parts.clear();
            for component in inside.components() {
                match component {
                    Component::Normal(part) => self.parts.push(part.to_os_string()),
                    _ => return Err(self.escape()),
                }
            }
            return Ok(());
        }
        let mut spliced: Vec<Segment> = Vec::new();
        for component in target.components() {
            match component {
                Component::Normal(part) => spliced.push(Segment::Name(part.to_os_string())),
                Component::ParentDir => spliced.push(Segment::Parent),
                Component::CurDir => {}
                // A target that names a root of its own is not a relative path after all.
                Component::RootDir | Component::Prefix(_) => return Err(self.escape()),
            }
        }
        for segment in spliced.into_iter().rev() {
            pending.push_front(segment);
        }
        Ok(())
    }

    /// The absolute path a segment would be looked up under.
    fn candidate(&self, name: &OsStr) -> PathBuf {
        let mut path = self.root.path().to_path_buf();
        for part in &self.parts {
            path.push(part);
        }
        path.push(name);
        path
    }

    /// The absolute result, re-proven inside the root.
    fn absolute(&self) -> Result<PathBuf, Error> {
        let mut path = self.root.path().to_path_buf();
        for part in &self.parts {
            path.push(part);
        }
        if !path.starts_with(self.root.path()) {
            return Err(self.escape());
        }
        self.prove()?;
        Ok(path)
    }

    /// Asks the root's capability handle to resolve what we built. Every part is a plain name by
    /// now, so this cannot follow a link out of the tree: if a segment was swapped for one after
    /// we looked, the handle refuses instead of handing back a path that leads outside.
    fn prove(&self) -> Result<(), Error> {
        let proven = if self.missing_leaf {
            match self.parts.split_last() {
                Some((_, rest)) => rest,
                None => return Ok(()),
            }
        } else {
            &self.parts[..]
        };
        let mut rel = PathBuf::new();
        for part in proven {
            rel.push(part);
        }
        if rel.as_os_str().is_empty() {
            return Ok(());
        }
        match self.root.dir().symlink_metadata(&rel) {
            Ok(_) => Ok(()),
            Err(error) => match std::fs::canonicalize(self.root.path().join(&rel)) {
                Ok(resolved) if !resolved.starts_with(self.root.path()) => Err(self.escape()),
                _ => Err(error.into()),
            },
        }
    }

    fn escape(&self) -> Error {
        Error::PathEscape(self.rel.to_owned())
    }
}

/// Whether `path` is inside `root` once `.` and `..` are folded away textually. For a link target
/// this rules out the spellings that point outside without asking the filesystem, so a dangling
/// link cannot send the walk somewhere else.
fn lexically_inside(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        match (root.to_str(), path.to_str()) {
            (Some(root), Some(path)) => crate::windows::relative(root, path).is_some(),
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        let mut folded = PathBuf::new();
        for component in path.components() {
            match component {
                Component::ParentDir => {
                    folded.pop();
                }
                Component::CurDir => {}
                other => folded.push(other.as_os_str()),
            }
        }
        folded.starts_with(root)
    }
}
