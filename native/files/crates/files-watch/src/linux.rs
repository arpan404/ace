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

use std::collections::BTreeSet;

use files_safe::Root;

use crate::batch::{Change, ChangeKind};
use crate::error::Error;
use crate::exclude::Excluder;
use crate::translate::Notice;
use crate::watch::Events;

/// A set of per-folder inotify watches.
pub(crate) struct Folders {
    watcher: inotify::Inotify,
    watched: BTreeSet<String>,
}

impl Folders {
    /// Watches every folder below the root that the excludes keep.
    pub(crate) fn start(
        root: &Root,
        excluder: &Excluder,
        events: Events,
    ) -> Result<Folders, Error> {
        let mut folders = Folders {
            watcher: inotify::Inotify::start(events)?,
            watched: BTreeSet::new(),
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

    fn add_tree(&mut self, root: &Root, excluder: &Excluder, dir: &str) -> Result<(), Error> {
        let mut stack = vec![dir.to_owned()];
        while let Some(folder) = stack.pop() {
            self.add(root, &folder)?;
            stack.extend(self.subfolders(root, excluder, &folder));
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
            if self.watched.contains(&folder) {
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
    fn add(&mut self, root: &Root, rel: &str) -> Result<(), Error> {
        if !self.watched.insert(rel.to_owned()) {
            return Ok(());
        }
        let path = if rel.is_empty() {
            root.path().to_path_buf()
        } else {
            root.path().join(rel)
        };
        match self.watcher.watch(&path) {
            Ok(true) => Ok(()),
            Ok(false) => {
                self.watched.remove(rel);
                Ok(())
            }
            Err(error) => {
                self.watched.remove(rel);
                Err(error)
            }
        }
    }

    /// Drops the watches at and below a path. The range scan keeps this proportional to the
    /// folders that go away, not to the whole tree.
    fn forget(&mut self, path: &str) {
        self.watched.remove(path);
        let prefix = format!("{path}/");
        let gone: Vec<String> = self
            .watched
            .range(prefix.clone()..)
            .take_while(|watched| watched.starts_with(&prefix))
            .cloned()
            .collect();
        for watched in gone {
            self.watched.remove(&watched);
        }
    }

    fn subfolders(&self, root: &Root, excluder: &Excluder, dir: &str) -> Vec<String> {
        self.children(root, excluder, dir)
            .into_iter()
            .filter(|(_, is_dir)| *is_dir)
            .map(|(path, _)| path)
            .collect()
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
