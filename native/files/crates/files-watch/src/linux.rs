// SPDX-License-Identifier: Apache-2.0

//! Linux: one non-recursive inotify watch per folder, so excluded folders never take a watch.
//!
//! inotify's recursive mode would register a watch inside every folder, including the
//! `node_modules` trees the excludes exist to avoid, and the per-user watch budget is small.
//! This backend walks the tree itself, adds a watch per folder it keeps, and adds watches for
//! folders that appear later. A folder moved in is walked as well, and its files reported,
//! because contents can change before the new watches exist. The watches are read by
//! [`inotify::Inotify`], which asks the kernel for changes only, never for opens and reads.

mod inotify;
mod registry;

#[cfg(test)]
pub(crate) use inotify::with_watch_budget;

use std::ffi::OsString;
use std::sync::Arc;

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use files_safe::Root;

use crate::batch::{Change, ChangeKind};
use crate::error::Error;
use crate::exclude::Excluder;
use crate::translate::Notice;
use crate::watch::Events;

/// A set of per-folder inotify watches.
pub(crate) struct Folders {
    watcher: inotify::Inotify,
}

impl Folders {
    /// Watches every folder below the root that the excludes keep.
    pub(crate) fn start(
        root: &Root,
        excluder: &Excluder,
        events: Events,
    ) -> Result<Folders, Error> {
        let mut folders = Folders {
            watcher: inotify::Inotify::start(root.path(), events)?,
        };
        folders.add_tree(root, excluder, "")?;
        Ok(folders)
    }

    pub(crate) fn adopt(
        &mut self,
        root: &Root,
        excluder: &Excluder,
        notices: &mut Vec<Notice>,
    ) -> Result<(), Error> {
        // Whatever is gone loses its watches, whatever the event said about it: a rename or a
        // truncated event cannot always tell a folder from a file.
        for notice in notices.iter() {
            if notice.change.kind == ChangeKind::Deleted {
                self.forget(&notice.change.path);
            }
        }
        let created: Vec<String> = notices
            .iter()
            .filter(|notice| notice.change.kind == ChangeKind::Created && notice.change.directory)
            .map(|notice| notice.change.path.clone())
            .collect();
        for folder in created {
            self.adopt_tree(root, excluder, &folder, notices)?;
        }
        Ok(())
    }

    /// After a queue overflow the kernel may have dropped watches: walk the folder again.
    pub(crate) fn rescan(
        &mut self,
        root: &Root,
        excluder: &Excluder,
        dir: Option<&str>,
    ) -> Result<(), Error> {
        self.add_tree(root, excluder, dir.unwrap_or(""))
    }

    pub(crate) fn stop(self) {
        drop(self.watcher);
    }

    /// Watches `dir` and every folder below it that the excludes keep.
    ///
    /// Each folder is opened from its parent's handle, not walked to from the root again, and only
    /// folders become paths: on a checkout of a million files in sixty thousand folders, opening
    /// each one from the root and naming every file took most of the 18 s the watch needed to
    /// start, all of it competing with whatever the person did first. A folder waiting on the
    /// stack holds its parent's handle, so open handles stay bounded by the tree's depth.
    fn add_tree(&mut self, root: &Root, excluder: &Excluder, dir: &str) -> Result<(), Error> {
        let Ok(top) = root.open_dir(dir) else {
            return self.watcher.watch(dir).map(|_| ());
        };
        let mut stack: Vec<(String, Arc<Dir>, Option<OsString>)> =
            vec![(dir.to_owned(), Arc::new(top), None)];
        while let Some((folder, parent, name)) = stack.pop() {
            let handle = match name {
                // A folder that went away, or became a link, since its parent was listed.
                Some(name) => match parent.open_dir_nofollow(&name) {
                    Ok(handle) => Arc::new(handle),
                    Err(_) => continue,
                },
                None => parent,
            };
            // Every folder is registered, watched or not: after lost events a path the registry
            // still lists may hold a new folder whose old watch the kernel has not dropped yet,
            // and the kernel hands back the existing descriptor for a folder already watched.
            self.watcher.watch(&folder)?;
            let Ok(entries) = handle.entries() else {
                continue;
            };
            for entry in entries.flatten() {
                // A symbolic link is neither a folder to walk into nor one to watch.
                if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    continue;
                }
                let name = entry.file_name();
                let Some(text) = name.to_str() else {
                    continue;
                };
                let path = if folder.is_empty() {
                    text.to_owned()
                } else {
                    format!("{folder}/{text}")
                };
                if excluder.is_excluded(&path) {
                    continue;
                }
                stack.push((path, Arc::clone(&handle), Some(name)));
            }
        }
        Ok(())
    }

    fn adopt_tree(
        &mut self,
        root: &Root,
        excluder: &Excluder,
        dir: &str,
        notices: &mut Vec<Notice>,
    ) -> Result<(), Error> {
        let mut stack = vec![dir.to_owned()];
        while let Some(folder) = stack.pop() {
            if self.watcher.watches(&folder) {
                continue;
            }
            self.add(root, &folder)?;
            for (path, is_dir) in self.children(root, excluder, &folder) {
                if is_dir {
                    stack.push(path);
                } else {
                    notices.push(Notice {
                        change: Change {
                            path,
                            kind: ChangeKind::Created,
                            directory: false,
                        },
                        rename: false,
                        present: Some(false),
                    });
                }
            }
        }
        Ok(())
    }

    /// Adds one non-recursive watch. The inotify budget running out is the one error the
    /// caller has to act on by switching to polling; a folder we may not watch is skipped.
    fn add(&mut self, _root: &Root, rel: &str) -> Result<(), Error> {
        if self.watcher.watches(rel) {
            return Ok(());
        }
        self.watcher.watch(rel).map(|_| ())
    }

    /// Drops the watches at and below a path that went away, or moved somewhere this watch does
    /// not cover; a folder renamed inside the checkout is watched again under its new name.
    fn forget(&mut self, path: &str) {
        self.watcher.forget(path);
    }

    /// The immediate children of `dir`, minus everything the excludes keep out. A symbolic
    /// link is neither a folder to walk into nor a file to report.
    fn children(&self, root: &Root, excluder: &Excluder, dir: &str) -> Vec<(String, bool)> {
        let mut children = Vec::new();
        let Ok(handle) = root.open_dir(dir) else {
            return children;
        };
        let Ok(entries) = handle.entries() else {
            return children;
        };
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let path = if dir.is_empty() {
                name
            } else {
                format!("{dir}/{name}")
            };
            if excluder.is_excluded(&path) {
                continue;
            }
            let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
            children.push((path, is_dir));
        }
        children
    }
}
