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
//! A new name is only reported at once when its origin is known: it was created moments ago, or
//! it is an entry (same inode) that just left another open folder, so both halves of the move are
//! in hand. Anything else may have been renamed in from a folder no one has open, and its old path
//! is only known to the OS watch: reporting the new name alone would leave the old one in every
//! index until the OS watch caught up. Such a name is held until the OS watch names it, which
//! brings the old path in the same window, or for at most [`HOLD`], after which it is reported
//! anyway. Names that went away are reported at once.
//!
//! A folder with more names than a batch may carry is not kept name by name; when its stamp moves
//! and no event about it arrived since the last check, it is rescanned. The cost is one open and
//! one stat per open folder per check, a listing only for a folder that changed, and memory for
//! the names of the open folders. A change inside a file leaves its folder's stamp alone, so the
//! net covers what a tree shows: names appearing, going away, and changing between file and folder.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant, SystemTime};

use files_safe::{Identity, Root};

use crate::batch::{Batch, Change, ChangeKind};
use crate::exclude::Excluder;
use crate::translate::Notice;

/// How often every open folder is checked.
pub(crate) const INTERVAL: Duration = Duration::from_secs(1);

/// How long a new name of unknown origin waits for the OS watch to name it.
pub(crate) const HOLD: Duration = Duration::from_secs(5);

/// How recently an entry must have been born to count as new rather than moved in.
const FRESH: Duration = Duration::from_secs(2);

/// How soon after its birth an entry's status may last have changed for it to count as untouched:
/// creating and writing a file is one quick run of calls, and a later move changes the status time.
const UNTOUCHED: Duration = Duration::from_millis(50);

/// The time a check runs at: the monotonic clock for holds, the wall clock for birth times.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Moment {
    pub(crate) instant: Instant,
    pub(crate) wall: SystemTime,
}

/// One name in a folder: whether it is a folder, and its inode where the platform says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Entry {
    directory: bool,
    ino: Option<u64>,
}

/// A new name of unknown origin, waiting for the OS watch to name it.
#[derive(Debug)]
struct Held {
    notice: Notice,
    ino: Option<u64>,
    until: Instant,
}

/// What one folder's listing said, before new names are judged.
#[derive(Debug, Default)]
struct Diff {
    deleted: Vec<(Notice, Option<u64>)>,
    created: Vec<(Notice, Option<u64>, Option<SystemTime>)>,
}

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
    known: Option<BTreeMap<String, Entry>>,
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
    /// New names waiting for the OS watch, by path.
    held: BTreeMap<String, Held>,
    /// Inodes that left an open folder lately, and when: a new name with one of them was moved
    /// within the open folders.
    vanished: Vec<(u64, Instant)>,
    /// The most names a folder may have and still be compared name by name.
    limit: usize,
}

impl Net {
    /// A net over the root alone, read now.
    pub(crate) fn new(root: &Root, excluder: &Excluder, limit: usize) -> Net {
        let mut net = Net {
            folders: BTreeMap::new(),
            held: BTreeMap::new(),
            vanished: Vec::new(),
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
    /// have news the OS watch is describing, and a name held for it is now the OS watch's to report.
    pub(crate) fn noticed(&mut self, path: &str) {
        self.held.remove(path);
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
                            let ino = known.get(name).and_then(|entry| entry.ino);
                            known.insert(
                                name.to_owned(),
                                Entry {
                                    directory: change.directory,
                                    ino,
                                },
                            );
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
    pub(crate) fn check(&mut self, root: &Root, excluder: &Excluder, at: Moment) -> Found {
        let folders: Vec<String> = self.folders.keys().cloned().collect();
        self.check_folders(root, excluder, &folders, at)
    }

    /// Checks the named open folders now, because the kernel said they changed. They are judged
    /// together, so an entry moved from one to another is seen leaving and arriving.
    pub(crate) fn check_folders(
        &mut self,
        root: &Root,
        excluder: &Excluder,
        folders: &[String],
        at: Moment,
    ) -> Found {
        let mut found = Found::default();
        let mut diff = Diff::default();
        for folder in folders {
            if let Some(held) = self.folders.get_mut(folder) {
                check_one(
                    root, excluder, self.limit, folder, held, &mut diff, &mut found,
                );
            }
        }
        self.vanished
            .retain(|(_, when)| at.instant.saturating_duration_since(*when) < HOLD);
        for (notice, ino) in diff.deleted {
            if let Some(ino) = ino {
                self.vanished.push((ino, at.instant));
            }
            self.held.remove(&notice.change.path);
            found.notices.push(notice);
        }
        // A held name whose inode just left an open folder was moved within them: both halves
        // are in hand now.
        let moved: Vec<String> = self
            .held
            .iter()
            .filter(|(_, held)| held.ino.is_some_and(|ino| self.left(ino)))
            .map(|(path, _)| path.clone())
            .collect();
        for path in moved {
            if let Some(held) = self.held.remove(&path) {
                found.notices.push(held.notice);
            }
        }
        for (notice, ino, born) in diff.created {
            let fresh = born
                .is_some_and(|born| at.wall.duration_since(born).unwrap_or(Duration::ZERO) < FRESH);
            if fresh || ino.is_some_and(|ino| self.left(ino)) {
                self.held.remove(&notice.change.path);
                found.notices.push(notice);
            } else {
                let path = notice.change.path.clone();
                let until = at.instant + HOLD;
                self.held.insert(path, Held { notice, ino, until });
            }
        }
        found
    }

    /// Whether an entry with this inode left an open folder lately.
    fn left(&self, ino: u64) -> bool {
        self.vanished.iter().any(|(gone, _)| *gone == ino)
    }

    /// When the next held name is due, if any is held.
    pub(crate) fn next_due(&self) -> Option<Instant> {
        self.held.values().map(|held| held.until).min()
    }

    /// The held names the OS watch has not named in time: reported now, so a change the OS
    /// watch never reports still reaches the caller.
    pub(crate) fn release_due(&mut self, now: Instant) -> Vec<Notice> {
        let due: Vec<String> = self
            .held
            .iter()
            .filter(|(_, held)| held.until <= now)
            .map(|(path, _)| path.clone())
            .collect();
        due.into_iter()
            .filter_map(|path| self.held.remove(&path))
            .map(|held| held.notice)
            .collect()
    }
}

fn check_one(
    root: &Root,
    excluder: &Excluder,
    limit: usize,
    folder: &str,
    held: &mut Folder,
    diff: &mut Diff,
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
    match (&mut held.known, &names) {
        // The caller learns these through the batch, which is what updates `known`.
        (Some(known), Some(now)) => {
            compare(root, folder, known, now, diff);
            // A name learned from a batch carries no inode yet; the listing has it.
            for (name, entry) in known.iter_mut() {
                if entry.ino.is_none()
                    && let Some(listed) = now.get(name)
                {
                    entry.ino = listed.ino;
                }
            }
        }
        // Too large to compare, now or before: only listing it again can tell, unless events about
        // it are arriving and describing it.
        _ if !active => {
            found.rescans.push(folder.to_owned());
            held.known = names;
        }
        _ => held.known = names,
    }
}

/// The names that differ between what the caller knows `folder` holds and what it holds now.
fn compare(
    root: &Root,
    folder: &str,
    known: &BTreeMap<String, Entry>,
    now: &BTreeMap<String, Entry>,
    diff: &mut Diff,
) {
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
    let born = |name: &str| {
        let dir = root.open_dir(folder).ok()?;
        new_since(&dir.symlink_metadata(name).ok()?)
    };
    for (name, entry) in known {
        match now.get(name) {
            None => diff.deleted.push((
                notice(name, ChangeKind::Deleted, entry.directory),
                entry.ino,
            )),
            // A file replaced by a folder, or the other way round: the old one went away.
            Some(present) if present.directory != entry.directory => {
                diff.deleted.push((
                    notice(name, ChangeKind::Deleted, entry.directory),
                    entry.ino,
                ));
                diff.created.push((
                    notice(name, ChangeKind::Created, present.directory),
                    present.ino,
                    born(name),
                ));
            }
            Some(_) => {}
        }
    }
    for (name, entry) in now {
        if !known.contains_key(name) {
            diff.created.push((
                notice(name, ChangeKind::Created, entry.directory),
                entry.ino,
                born(name),
            ));
        }
    }
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
) -> Option<(Stamp, Option<BTreeMap<String, Entry>>)> {
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
        names.insert(
            name,
            Entry {
                directory,
                ino: ino(&entry),
            },
        );
        if names.len() > limit {
            return Some((stamp, None));
        }
    }
    Some((stamp, Some(names)))
}

/// When an entry was born, if nothing has happened to it since: a move into the folder changes its
/// status time, so an entry whose status changed well after its birth may have come from anywhere.
#[cfg(unix)]
fn new_since(metadata: &cap_std::fs::Metadata) -> Option<SystemTime> {
    use cap_std::fs::MetadataExt;
    let born: SystemTime = metadata.created().ok()?.into_std();
    let seconds = u64::try_from(metadata.ctime()).ok()?;
    let nanos = u32::try_from(metadata.ctime_nsec()).ok()?;
    let changed = SystemTime::UNIX_EPOCH + Duration::new(seconds, nanos);
    (changed.duration_since(born).unwrap_or(Duration::ZERO) < UNTOUCHED).then_some(born)
}

/// Windows' metadata has no status time to tell a new entry from a moved one, so every new name
/// waits for its own backend, which reports moves promptly.
#[cfg(not(unix))]
fn new_since(_metadata: &cap_std::fs::Metadata) -> Option<SystemTime> {
    None
}

/// A listed entry's inode, without another call to the file system.
#[cfg(unix)]
fn ino(entry: &cap_std::fs::DirEntry) -> Option<u64> {
    use std::os::unix::fs::DirEntryExt;
    Some(entry.ino())
}

/// Windows lists no inode; its own backend reports moves promptly, so nothing is held for long.
#[cfg(not(unix))]
fn ino(_entry: &cap_std::fs::DirEntry) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::time::{Duration, Instant, SystemTime};

    use super::{HOLD, Moment, Net};
    use crate::batch::{Batch, Change, ChangeKind};
    use crate::exclude::Excluder;
    use crate::translate::Notice;
    use files_safe::Root;

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
        described.sort_by_key(|(path, kind, _)| (path.clone(), format!("{kind:?}")));
        described
    }

    /// What the worker hands the sink for the notices a check found.
    fn as_batch(notices: &[Notice]) -> Batch {
        Batch::Changes(notices.iter().map(|notice| notice.change.clone()).collect())
    }

    /// Now, with the wall clock where the test wants it: far ahead makes every entry old, as if it
    /// had been moved in rather than created.
    fn at(ahead: Duration) -> Moment {
        Moment {
            instant: Instant::now(),
            wall: SystemTime::now() + ahead,
        }
    }

    const NOW: Duration = Duration::ZERO;
    const LATER: Duration = Duration::from_secs(3_600);

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

        fn check(&self, net: &mut Net, ahead: Duration) -> Vec<(String, ChangeKind, bool)> {
            described(&net.check(&self.root, &self.excluder, at(ahead)).notices)
        }

        fn path(&self, rel: &str) -> std::path::PathBuf {
            self.dir.path().join(rel)
        }
    }

    fn change(path: &str, kind: ChangeKind, directory: bool) -> (String, ChangeKind, bool) {
        (path.to_owned(), kind, directory)
    }

    #[test]
    fn a_change_in_an_open_folder_is_found_without_any_event() {
        let tree = Tree::new(|root| {
            std::fs::create_dir(root.join("src")).unwrap();
            std::fs::write(root.join("src/kept.txt"), b"x").unwrap();
            std::fs::write(root.join("src/doomed.txt"), b"x").unwrap();
            std::fs::write(root.join("src/swap"), b"x").unwrap();
        });
        let mut net = tree.net(100, &["src"]);
        assert!(tree.check(&mut net, NOW).is_empty());

        std::fs::remove_file(tree.path("src/doomed.txt")).unwrap();
        std::fs::remove_file(tree.path("src/swap")).unwrap();
        std::fs::create_dir(tree.path("src/swap")).unwrap();
        std::fs::write(tree.path("src/fresh.txt"), b"x").unwrap();
        std::fs::write(tree.path("top.txt"), b"x").unwrap();
        std::fs::create_dir(tree.path("node_modules")).unwrap();
        let found = net.check(&tree.root, &tree.excluder, at(NOW)).notices;
        assert_eq!(
            described(&found),
            vec![
                change("src/doomed.txt", ChangeKind::Deleted, false),
                change("src/fresh.txt", ChangeKind::Created, false),
                change("src/swap", ChangeKind::Created, true),
                change("src/swap", ChangeKind::Deleted, false),
                change("top.txt", ChangeKind::Created, false),
            ],
            "new entries are reported at once and excluded names never"
        );

        // Once the batch is delivered the caller knows, and a later change reports only itself.
        net.delivered(&as_batch(&found));
        std::fs::write(tree.path("src/later.txt"), b"x").unwrap();
        assert_eq!(
            tree.check(&mut net, NOW),
            vec![change("src/later.txt", ChangeKind::Created, false)]
        );
    }

    #[test]
    fn a_name_moved_in_from_a_folder_no_one_has_open_waits_for_the_os_watch() {
        // Its old path is only known to the OS watch; reporting the new name alone would leave the
        // old one in every index.
        let tree = Tree::new(|root| {
            std::fs::create_dir_all(root.join("docs/old")).unwrap();
            std::fs::write(root.join("docs/old/kept.md"), b"x").unwrap();
        });
        let mut net = tree.net(100, &[]);
        std::fs::rename(tree.path("docs/old"), tree.path("trash")).unwrap();
        assert!(
            tree.check(&mut net, LATER).is_empty(),
            "held for the OS watch"
        );
        assert!(net.next_due().is_some());

        net.noticed("trash");
        assert!(
            net.next_due().is_none(),
            "the OS watch reports it, with its old path"
        );
        assert!(net.release_due(Instant::now() + HOLD).is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn a_folder_moved_in_moments_after_it_was_made_still_waits_for_the_os_watch() {
        // Born a moment ago, so its birth time alone looks new; the move changed its status
        // time, which is what tells it from a folder created where it is.
        let tree = Tree::new(|_| {});
        let mut net = tree.net(100, &[]);
        std::fs::create_dir_all(tree.path("docs/old")).unwrap();
        std::fs::write(tree.path("docs/old/kept.md"), b"x").unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::rename(tree.path("docs/old"), tree.path("trash")).unwrap();
        let found = tree.check(&mut net, NOW);
        assert!(
            found.iter().all(|(path, _, _)| path != "trash"),
            "the moved folder waits for the OS watch, which brings its old path: {found:?}"
        );
        assert!(net.next_due().is_some());
    }

    #[test]
    fn a_held_name_the_os_watch_never_reports_is_reported_after_the_hold() {
        let tree = Tree::new(|root| std::fs::create_dir(root.join("elsewhere")).unwrap());
        std::fs::write(tree.path("elsewhere/a.txt"), b"x").unwrap();
        let mut net = tree.net(100, &[]);
        std::fs::rename(tree.path("elsewhere/a.txt"), tree.path("a.txt")).unwrap();
        assert!(tree.check(&mut net, LATER).is_empty());
        assert!(net.release_due(Instant::now()).is_empty(), "not due yet");
        assert_eq!(
            described(&net.release_due(Instant::now() + HOLD)),
            vec![change("a.txt", ChangeKind::Created, false)]
        );
    }

    #[test]
    fn a_rename_between_open_folders_is_reported_at_once() {
        let tree = Tree::new(|root| {
            std::fs::create_dir(root.join("src")).unwrap();
            std::fs::write(root.join("src/a.txt"), b"x").unwrap();
            std::fs::write(root.join("b.txt"), b"x").unwrap();
        });
        let mut net = tree.net(100, &["src"]);
        std::fs::rename(tree.path("src/a.txt"), tree.path("moved.txt")).unwrap();
        std::fs::rename(tree.path("b.txt"), tree.path("renamed.txt")).unwrap();
        assert_eq!(
            tree.check(&mut net, LATER),
            vec![
                change("b.txt", ChangeKind::Deleted, false),
                change("moved.txt", ChangeKind::Created, false),
                change("renamed.txt", ChangeKind::Created, false),
                change("src/a.txt", ChangeKind::Deleted, false),
            ],
            "both halves of each move are in open folders"
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
        assert!(tree.check(&mut net, NOW).is_empty());
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
            tree.check(&mut net, NOW).is_empty(),
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
            net.check(&tree.root, &tree.excluder, at(NOW))
                .rescans
                .is_empty(),
            "events about the folder are arriving, so they describe it"
        );

        std::fs::write(tree.path("big/unnoticed"), b"x").unwrap();
        assert_eq!(
            net.check(&tree.root, &tree.excluder, at(NOW)).rescans,
            vec!["big".to_owned()]
        );
    }
}
