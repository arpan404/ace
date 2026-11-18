// SPDX-License-Identifier: Apache-2.0

//! Linux: one non-recursive inotify watch per folder, so excluded folders never take a watch.
//!
//! inotify's recursive mode would register a watch inside every folder, including the
//! `node_modules` trees the excludes exist to avoid, and the per-user watch budget is small.
//! This backend walks the tree itself, adds a watch per folder it keeps, and adds watches for
//! folders that appear later.

use std::collections::HashSet;
use std::path::PathBuf;

use files_safe::Root;
use notify::{INotifyWatcher, RecursiveMode, Watcher as NotifyWatcher};

use crate::batch::{Change, ChangeKind};
use crate::error::Error;
use crate::exclude::Excluder;
use crate::observed::Flavour;
use crate::watch::Events;

/// A set of per-folder inotify watches.
pub(crate) struct Folders {
    watcher: INotifyWatcher,
    root: Root,
    excluder: Excluder,
    watched: HashSet<String>,
}

impl Folders {
    /// Watches every folder below the root that the excludes keep.
    pub(crate) fn start(
        root: &Root,
        excluder: &Excluder,
        events: Events,
    ) -> Result<Folders, Error> {
        let mut folders = Folders {
            watcher: INotifyWatcher::new(events, notify::Config::default())
                .map_err(|error| Error::Unsupported(error.to_string()))?,
            root: root.clone(),
            excluder: excluder.clone(),
            watched: HashSet::new(),
        };
        folders.add_tree("")?;
        Ok(folders)
    }

    pub(crate) fn flavour(&self) -> Flavour {
        Flavour::native()
    }

    /// Watches folders that just appeared and reports the files already inside them, because
    /// their contents can change before the new watch exists.
    pub(crate) fn adopt(&mut self, changes: &mut Vec<Change>) -> Option<String> {
        for change in changes.iter() {
            if change.kind == ChangeKind::Deleted && change.directory {
                self.forget(&change.path);
            }
        }
        let created: Vec<String> = changes
            .iter()
            .filter(|change| change.kind == ChangeKind::Created && change.directory)
            .map(|change| change.path.clone())
            .collect();
        for folder in created {
            if let Err(error) = self.adopt_tree(&folder, changes) {
                return Some(format!("cannot watch new folder {folder}: {error}"));
            }
        }
        None
    }

    pub(crate) fn stop(self) {
        drop(self.watcher);
    }

    fn add_tree(&mut self, dir: &str) -> Result<(), Error> {
        let mut stack = vec![dir.to_owned()];
        while let Some(folder) = stack.pop() {
            self.add(&folder)?;
            stack.extend(self.subfolders(&folder));
        }
        Ok(())
    }

    fn adopt_tree(&mut self, dir: &str, changes: &mut Vec<Change>) -> Result<(), Error> {
        let mut stack = vec![dir.to_owned()];
        while let Some(folder) = stack.pop() {
            if self.watched.contains(&folder) {
                continue;
            }
            self.add(&folder)?;
            for (path, is_dir) in self.children(&folder) {
                if is_dir {
                    stack.push(path);
                } else {
                    changes.push(Change {
                        path,
                        kind: ChangeKind::Created,
                        directory: false,
                    });
                }
            }
        }
        Ok(())
    }

    /// Adds one non-recursive watch. The inotify budget running out is the one error worth
    /// giving up on native watching for; a folder we may not watch is skipped.
    fn add(&mut self, rel: &str) -> Result<(), Error> {
        if !self.watched.insert(rel.to_owned()) {
            return Ok(());
        }
        let path = self.absolute(rel);
        if let Err(error) = self.watcher.watch(&path, RecursiveMode::NonRecursive) {
            self.watched.remove(rel);
            if matches!(error.kind, notify::ErrorKind::MaxFilesWatch) {
                return Err(Error::Unsupported(format!(
                    "inotify watch limit reached: {error}"
                )));
            }
        }
        Ok(())
    }

    fn forget(&mut self, dir: &str) {
        let prefix = format!("{dir}/");
        self.watched
            .retain(|watched| watched != dir && !watched.starts_with(&prefix));
    }

    fn subfolders(&self, dir: &str) -> Vec<String> {
        self.children(dir)
            .into_iter()
            .filter(|(_, is_dir)| *is_dir)
            .map(|(path, _)| path)
            .collect()
    }

    /// The immediate children of `dir`, minus everything the excludes keep out.
    fn children(&self, dir: &str) -> Vec<(String, bool)> {
        let mut children = Vec::new();
        let Ok(entries) = std::fs::read_dir(self.absolute(dir)) else {
            return children;
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let path = if dir.is_empty() {
                name
            } else {
                format!("{dir}/{name}")
            };
            if self.excluder.is_excluded(&path) {
                continue;
            }
            let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
            children.push((path, is_dir));
        }
        children
    }

    fn absolute(&self, rel: &str) -> PathBuf {
        if rel.is_empty() {
            self.root.path().to_path_buf()
        } else {
            self.root.path().join(rel)
        }
    }
}
