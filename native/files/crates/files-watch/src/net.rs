// SPDX-License-Identifier: Apache-2.0

//! The safety net under the OS watch: the folders a person has open, checked about once a second.
//!
//! An OS watch can be late or silent. fseventsd is one process serving every client on a Mac, and
//! when it is saturated it hands events over minutes late with no lost-events flag, so a change
//! in a folder someone is looking at would not show. The net does not depend on the OS watch. For
//! each open folder, and the root, it keeps a stamp (identity and modification time) and the names
//! the caller has been told the folder holds: what it held when it was opened, updated by every
//! batch delivered since. A folder whose stamp moved is listed again, and each name that differs
//! from what the caller knows becomes a change, so a change no event reported is reported, and one
//! an event already reported is not reported twice by the net. A batch that rescans a folder makes
//! the net read it afresh, because the caller reads it afresh too.
//!
//! A folder with more names than a batch may carry is not kept name by name; when its stamp moves
//! and no event about it arrived since the last check, it is rescanned. The cost is one open and
//! one stat per open folder per check, a listing only for a folder that changed, and memory for
//! the names of the open folders. A change inside a file leaves its folder's stamp alone, so the
//! net covers what a tree shows: names appearing, going away, and changing between file and folder.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime};

use files_safe::{Identity, Root};

use crate::batch::{Batch, Change, ChangeKind};
use crate::exclude::Excluder;
use crate::translate::Notice;

/// How often every open folder is checked.
pub(crate) const INTERVAL: Duration = Duration::from_secs(1);

/// The most folders a caller may name, as the daemon's folder watch allows; the root is extra.
pub(crate) const MAX_FOLDERS: usize = 512;

/// What a folder looked like when it was last read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    identity: Option<Identity>,
    modified: Option<SystemTime>,
}

/// One open folder.
#[derive(Debug, Default)]
struct Folder {
    /// `None` until the folder could be read.
    stamp: Option<Stamp>,
    /// The names the caller knows it holds, and whether each is a folder; `None` when there are
    /// too many to keep.
    known: Option<BTreeMap<String, bool>>,
    /// A batch rescanned this folder: read it afresh, reporting nothing.
    stale: bool,
    /// An event named this folder or something in it since the last check.
    active: bool,
}

/// What a check found.
#[derive(Debug, Default)]
pub(crate) struct Found {
    /// Names that differ from what the caller was told.
    pub(crate) notices: Vec<Notice>,
    /// Folders too large to compare name by name that changed while no event named them.
    pub(crate) rescans: Vec<String>,
}

/// The open folders and what each looked like.
pub(crate) struct Net {
    folders: BTreeMap<String, Folder>,
    /// The most names a folder may have and still be compared name by name.
    limit: usize,
}

impl Net {
    /// A net over the root alone, read now.
    pub(crate) fn new(root: &Root, excluder: &Excluder, limit: usize) -> Net {
        let mut net = Net {
            folders: BTreeMap::new(),
            limit,
        };
        net.focus(root, excluder, Vec::new());
        net
    }

    /// Replaces the open folders. The root is always one of them; a folder already open keeps
    /// what it knew, and a new one is read now, which is what the caller just listed.
    pub(crate) fn focus(&mut self, root: &Root, excluder: &Excluder, folders: Vec<String>) {
        let mut wanted: BTreeSet<String> = folders
            .into_iter()
            .filter(|folder| Root::check(folder).is_ok() && !excluder.is_excluded(folder))
            .take(MAX_FOLDERS)
            .collect();
        wanted.insert(String::new());
        self.folders.retain(|folder, _| wanted.contains(folder));
        for folder in wanted {
            if !self.folders.contains_key(&folder) {
                let mut held = Folder::default();
                if let Some((stamp, names)) = read(root, excluder, &folder, self.limit) {
                    held.stamp = Some(stamp);
                    held.known = names;
                }
                self.folders.insert(folder, held);
            }
        }
    }

    /// The open folders, the root first.
    pub(crate) fn folders(&self) -> impl Iterator<Item = &str> {
        self.folders.keys().map(String::as_str)
    }

    /// An event named `path`: the folder holding it, and the path itself if it is an open folder,
    /// have news the OS watch is describing.
    pub(crate) fn noticed(&mut self, path: &str) {
        let folder = path.rsplit_once('/').map_or("", |(folder, _)| folder);
        for open in [folder, path] {
            if let Some(held) = self.folders.get_mut(open) {
                held.active = true;
            }
        }
    }

    /// What a delivered batch told the caller.
    pub(crate) fn delivered(&mut self, batch: &Batch) {
        match batch {
            Batch::Changes(changes) => {
                for change in changes {
                    let (folder, name) = match change.path.rsplit_once('/') {
                        Some((folder, name)) => (folder, name),
                        None => ("", change.path.as_str()),
                    };
                    let Some(known) = self
                        .folders
                        .get_mut(folder)
                        .and_then(|held| held.known.as_mut())
                    else {
                        continue;
                    };
                    match change.kind {
                        ChangeKind::Deleted => {
                            known.remove(name);
                        }
                        ChangeKind::Created | ChangeKind::Modified => {
                            known.insert(name.to_owned(), change.directory);
                        }
                    }
                }
            }
            Batch::Rescan { dir } => {
                let dir = dir.as_deref().unwrap_or("");
                let prefix = format!("{dir}/");
                for (folder, held) in &mut self.folders {
                    if dir.is_empty() || folder == dir || folder.starts_with(&prefix) {
                        held.stale = true;
                    }
                }
            }
            Batch::Warning(_) => {}
        }
    }

    /// Checks every open folder's stamp, and lists again the ones that moved.
    pub(crate) fn check(&mut self, root: &Root, excluder: &Excluder) -> Found {
        let mut found = Found::default();
        for (folder, held) in &mut self.folders {
            check_one(root, excluder, self.limit, folder, held, &mut found);
        }
        found
    }

    /// Checks one open folder now, because the kernel said it changed.
    pub(crate) fn check_folder(&mut self, root: &Root, excluder: &Excluder, folder: &str) -> Found {
        let mut found = Found::default();
        if let Some(held) = self.folders.get_mut(folder) {
            check_one(root, excluder, self.limit, folder, held, &mut found);
        }
        found
    }
}

fn check_one(
    root: &Root,
    excluder: &Excluder,
    limit: usize,
    folder: &str,
    held: &mut Folder,
    found: &mut Found,
) {
    let active = std::mem::take(&mut held.active);
    let stale = std::mem::take(&mut held.stale);
    let Some(stamp) = stamp(root, folder) else {
        // Gone or unreadable: the folder holding it reports that. Start afresh if it comes back.
        held.stamp = None;
        held.known = None;
        return;
    };
    if held.stamp == Some(stamp) && !stale {
        return;
    }
    let Some((stamp, names)) = read(root, excluder, folder, limit) else {
        return;
    };
    let read_before = held.stamp.is_some();
    held.stamp = Some(stamp);
    if stale || !read_before {
        held.known = names;
        return;
    }
    match (&held.known, &names) {
        // The caller learns these through the batch, which is what updates `known`.
        (Some(known), Some(now)) => found.notices.extend(diff(folder, known, now)),
        // Too large to compare, now or before: only listing it again can tell, unless events about
        // it are arriving and describing it.
        _ if !active => {
            found.rescans.push(folder.to_owned());
            held.known = names;
        }
        _ => held.known = names,
    }
}

/// The changes from what the caller knows `folder` holds to what it holds now.
fn diff(folder: &str, known: &BTreeMap<String, bool>, now: &BTreeMap<String, bool>) -> Vec<Notice> {
    let path = |name: &str| {
        if folder.is_empty() {
            name.to_owned()
        } else {
            format!("{folder}/{name}")
        }
    };
    let notice = |name: &str, kind: ChangeKind, directory: bool| Notice {
        change: Change {
            path: path(name),
            kind,
            directory,
        },
        rename: false,
        present: (kind != ChangeKind::Deleted).then_some(directory),
    };
    let mut notices = Vec::new();
    for (name, directory) in known {
        match now.get(name) {
            None => notices.push(notice(name, ChangeKind::Deleted, *directory)),
            // A file replaced by a folder, or the other way round: the old one went away.
            Some(present) if present != directory => {
                notices.push(notice(name, ChangeKind::Deleted, *directory));
                notices.push(notice(name, ChangeKind::Created, *present));
            }
            Some(_) => {}
        }
    }
    for (name, directory) in now {
        if !known.contains_key(name) {
            notices.push(notice(name, ChangeKind::Created, *directory));
        }
    }
    notices
}

/// A folder's stamp, from one open and one stat.
fn stamp(root: &Root, folder: &str) -> Option<Stamp> {
    stamp_of(root, &root.open_dir(folder).ok()?)
}

fn stamp_of(root: &Root, dir: &cap_std::fs::Dir) -> Option<Stamp> {
    let metadata = dir.dir_metadata().ok()?;
    Some(Stamp {
        identity: root.folder_identity(dir),
        modified: metadata.modified().ok().map(|time| time.into_std()),
    })
}

/// A folder's stamp and the names it holds, or `None` for the names when there are more than
/// `limit`. The stamp is read first, so a change made during the listing moves the next stamp.
fn read(
    root: &Root,
    excluder: &Excluder,
    folder: &str,
    limit: usize,
) -> Option<(Stamp, Option<BTreeMap<String, bool>>)> {
    let dir = root.open_dir(folder).ok()?;
    let stamp = stamp_of(root, &dir)?;
    let mut names = BTreeMap::new();
    for entry in dir.entries().ok()?.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let path = if folder.is_empty() {
            name.clone()
        } else {
            format!("{folder}/{name}")
        };
        if excluder.is_excluded(&path) {
            continue;
        }
        // A symbolic link is a name, never a folder to look into.
        let directory = entry.file_type().is_ok_and(|kind| kind.is_dir());
        names.insert(name, directory);
        if names.len() > limit {
            return Some((stamp, None));
        }
    }
    Some((stamp, Some(names)))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::collections::BTreeMap;

    use super::{Net, diff};
    use crate::batch::{Batch, Change, ChangeKind};
    use crate::exclude::Excluder;
    use crate::translate::Notice;
    use files_safe::Root;

    fn listing(names: &[(&str, bool)]) -> BTreeMap<String, bool> {
        names
            .iter()
            .map(|(name, directory)| ((*name).to_owned(), *directory))
            .collect()
    }

    fn described(notices: &[Notice]) -> Vec<(String, ChangeKind, bool)> {
        let mut described: Vec<(String, ChangeKind, bool)> = notices
            .iter()
            .map(|notice| {
                (
                    notice.change.path.clone(),
                    notice.change.kind,
                    notice.change.directory,
                )
            })
            .collect();
        described.sort_by(|left, right| left.0.cmp(&right.0));
        described
    }

    /// What the worker hands the sink for the notices a check found.
    fn as_batch(notices: &[Notice]) -> Batch {
        Batch::Changes(notices.iter().map(|notice| notice.change.clone()).collect())
    }

    struct Tree {
        dir: tempfile::TempDir,
        root: Root,
        excluder: Excluder,
    }

    impl Tree {
        fn new(prepare: impl FnOnce(&std::path::Path)) -> Tree {
            let dir = tempfile::tempdir().unwrap();
            prepare(dir.path());
            let root = Root::open(dir.path()).unwrap();
            Tree {
                dir,
                root,
                excluder: Excluder::new(&["**/node_modules".to_owned()]).unwrap(),
            }
        }

        fn net(&self, limit: usize, folders: &[&str]) -> Net {
            let mut net = Net::new(&self.root, &self.excluder, limit);
            net.focus(
                &self.root,
                &self.excluder,
                folders.iter().map(|folder| (*folder).to_owned()).collect(),
            );
            net
        }

        fn path(&self, rel: &str) -> std::path::PathBuf {
            self.dir.path().join(rel)
        }
    }

    #[test]
    fn names_that_differ_from_what_the_caller_knows_are_changes() {
        let known = listing(&[("a.txt", false), ("gone.txt", false), ("swap", false)]);
        let now = listing(&[("a.txt", false), ("new", true), ("swap", true)]);
        assert_eq!(
            described(&diff("src", &known, &now)),
            vec![
                ("src/gone.txt".to_owned(), ChangeKind::Deleted, false),
                ("src/new".to_owned(), ChangeKind::Created, true),
                ("src/swap".to_owned(), ChangeKind::Deleted, false),
                ("src/swap".to_owned(), ChangeKind::Created, true),
            ]
        );
    }

    #[test]
    fn a_change_in_an_open_folder_is_found_without_any_event() {
        let tree = Tree::new(|root| {
            std::fs::create_dir(root.join("src")).unwrap();
            std::fs::write(root.join("src/kept.txt"), b"x").unwrap();
            std::fs::write(root.join("src/doomed.txt"), b"x").unwrap();
        });
        let mut net = tree.net(100, &["src"]);
        assert!(net.check(&tree.root, &tree.excluder).notices.is_empty());

        std::fs::remove_file(tree.path("src/doomed.txt")).unwrap();
        std::fs::write(tree.path("src/fresh.txt"), b"x").unwrap();
        std::fs::write(tree.path("top.txt"), b"x").unwrap();
        std::fs::create_dir(tree.path("node_modules")).unwrap();
        let found = net.check(&tree.root, &tree.excluder).notices;
        assert_eq!(
            described(&found),
            vec![
                ("src/doomed.txt".to_owned(), ChangeKind::Deleted, false),
                ("src/fresh.txt".to_owned(), ChangeKind::Created, false),
                ("top.txt".to_owned(), ChangeKind::Created, false),
            ],
            "excluded names are never news"
        );

        // Once the batch is delivered the caller knows, and a later change reports only itself.
        net.delivered(&as_batch(&found));
        std::fs::write(tree.path("src/later.txt"), b"x").unwrap();
        assert_eq!(
            described(&net.check(&tree.root, &tree.excluder).notices),
            vec![("src/later.txt".to_owned(), ChangeKind::Created, false)]
        );
    }

    #[test]
    fn a_change_an_event_already_delivered_is_not_reported_again() {
        let tree = Tree::new(|_| {});
        let mut net = tree.net(100, &[]);
        std::fs::write(tree.path("a.txt"), b"x").unwrap();
        net.delivered(&Batch::Changes(vec![Change {
            path: "a.txt".to_owned(),
            kind: ChangeKind::Created,
            directory: false,
        }]));
        assert!(net.check(&tree.root, &tree.excluder).notices.is_empty());
    }

    #[test]
    fn a_rescanned_folder_is_read_afresh_without_reporting() {
        let tree = Tree::new(|root| std::fs::create_dir(root.join("src")).unwrap());
        let mut net = tree.net(100, &["src"]);
        std::fs::write(tree.path("src/a.txt"), b"x").unwrap();
        net.delivered(&Batch::Rescan {
            dir: Some("src".to_owned()),
        });
        assert!(
            net.check(&tree.root, &tree.excluder).notices.is_empty(),
            "the caller lists the folder again for the rescan"
        );
    }

    #[test]
    fn a_large_open_folder_that_changed_unnoticed_is_rescanned() {
        let tree = Tree::new(|root| {
            std::fs::create_dir(root.join("big")).unwrap();
            for index in 0..5 {
                std::fs::write(root.join(format!("big/{index}")), b"x").unwrap();
            }
        });
        let mut net = tree.net(3, &["big"]);

        std::fs::write(tree.path("big/noticed"), b"x").unwrap();
        net.noticed("big/noticed");
        assert!(
            net.check(&tree.root, &tree.excluder).rescans.is_empty(),
            "events about the folder are arriving, so they describe it"
        );

        std::fs::write(tree.path("big/unnoticed"), b"x").unwrap();
        assert_eq!(
            net.check(&tree.root, &tree.excluder).rescans,
            vec!["big".to_owned()]
        );
    }
}
