// SPDX-License-Identifier: Apache-2.0

//! Turns one backend event into notices about paths inside the root.

use std::path::Path;

use files_safe::Root;
use notify::Event;
use notify::event::{EventKind, ModifyKind, RemoveKind, RenameMode};

use crate::batch::{Change, ChangeKind};
use crate::exclude::Excluder;

/// One event about one path, with what the backend and the filesystem said about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Notice {
    pub(crate) change: Change,
    /// The backend described this as a rename.
    pub(crate) rename: bool,
    /// Whether the path existed when the event was translated, and if so whether it is a
    /// directory. A symbolic link is not a directory.
    pub(crate) present: Option<bool>,
}

/// What one backend event means for the tree.
#[derive(Debug, Default)]
pub(crate) struct Translation {
    pub(crate) notices: Vec<Notice>,
    /// `Some` when the backend lost events: the innermost `Some` is the folder it named,
    /// `None` when it named none (inotify's queue overflow, or FSEvents without a path).
    pub(crate) rescan: Option<Option<String>>,
}

/// What the filesystem said about a path when an event was translated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Presence {
    /// The path is there, and whether it is a directory; a symbolic link is never one.
    Here(bool),
    /// The path is not there.
    Gone,
    /// The path could not be looked up: files-safe found the folder changed under the lookup,
    /// so the events are all this crate knows about it.
    Unknown,
}

/// What is at `path`, asked through the root's handle.
///
/// The leaf is opened through the root's handle without following it, so a link is reported
/// as the link itself and never as the tree it points at.
pub(crate) fn look(root: &Root, path: &str) -> Presence {
    let (folder, name) = match root.open_parent(path) {
        Ok(found) => found,
        Err(files_safe::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Presence::Gone;
        }
        Err(_) => return Presence::Unknown,
    };
    match folder.symlink_metadata(&name) {
        Ok(metadata) => {
            // `open_parent` hands back the spelling the folder stores. On a volume that ignores
            // case, a case-only rename finds the entry under its new spelling, so the spelling
            // that was asked for is gone even though the entry lives on. Reporting it present
            // would keep the old name in the index next to the new one.
            if name != leaf(path) {
                return Presence::Gone;
            }
            Presence::Here(metadata.is_dir())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Presence::Gone,
        Err(_) => Presence::Unknown,
    }
}

/// The last segment of a relative path.
fn leaf(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, leaf)| leaf)
}

/// The `Notice` form of a presence: only a path seen on disk says anything.
fn noticed(present: Presence) -> Option<bool> {
    match present {
        Presence::Here(directory) => Some(directory),
        Presence::Gone | Presence::Unknown => None,
    }
}

/// Translates one backend event, asking `look` what is on disk.
pub(crate) fn translate(
    event: Event,
    root: &Root,
    excluder: &Excluder,
    look: &dyn Fn(&str) -> Presence,
) -> Translation {
    let mut translation = Translation {
        notices: Vec::new(),
        rescan: None,
    };
    if event.need_rescan() {
        let folder = event
            .paths
            .first()
            .and_then(|path| inside(root, excluder, path));
        translation.rescan = Some(folder);
        return translation;
    }
    if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = event.kind
        && let [from, to] = event.paths.as_slice()
    {
        push(
            &mut translation,
            root,
            excluder,
            look,
            from,
            ChangeKind::Deleted,
            true,
        );
        push(
            &mut translation,
            root,
            excluder,
            look,
            to,
            ChangeKind::Created,
            true,
        );
        return translation;
    }
    for absolute in &event.paths {
        let Some(path) = inside(root, excluder, absolute) else {
            continue;
        };
        let present = look(&path);
        if let Some((kind, rename)) = classify(&event.kind, present) {
            let directory = match kind {
                ChangeKind::Deleted => matches!(event.kind, EventKind::Remove(RemoveKind::Folder)),
                _ => present == Presence::Here(true),
            };
            translation.notices.push(Notice {
                change: Change {
                    path,
                    kind,
                    directory,
                },
                rename,
                present: noticed(present),
            });
        }
    }
    translation
}

fn classify(kind: &EventKind, present: Presence) -> Option<(ChangeKind, bool)> {
    let change = match kind {
        EventKind::Create(_) => (ChangeKind::Created, false),
        EventKind::Remove(_) => (ChangeKind::Deleted, false),
        EventKind::Modify(ModifyKind::Name(RenameMode::Any)) => {
            if present == Presence::Gone {
                (ChangeKind::Deleted, true)
            } else {
                (ChangeKind::Created, true)
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => (ChangeKind::Deleted, true),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => (ChangeKind::Created, true),
        EventKind::Modify(ModifyKind::Name(_)) => (ChangeKind::Modified, true),
        EventKind::Modify(_) | EventKind::Any => (ChangeKind::Modified, false),
        EventKind::Access(_) | EventKind::Other => return None,
    };
    Some(change)
}

/// The relative form of `absolute` if it is inside the root and not excluded.
fn inside(root: &Root, excluder: &Excluder, absolute: &Path) -> Option<String> {
    let path = root.relative(absolute)?;
    if path.is_empty() || excluder.is_excluded(&path) {
        return None;
    }
    Some(path)
}

fn push(
    translation: &mut Translation,
    root: &Root,
    excluder: &Excluder,
    look: &dyn Fn(&str) -> Presence,
    absolute: &Path,
    kind: ChangeKind,
    rename: bool,
) {
    let Some(path) = inside(root, excluder, absolute) else {
        return;
    };
    let present = look(&path);
    let directory = match kind {
        ChangeKind::Deleted => false,
        _ => present == Presence::Here(true),
    };
    translation.notices.push(Notice {
        change: Change {
            path,
            kind,
            directory,
        },
        rename,
        present: noticed(present),
    });
}

#[cfg(test)]
mod tests {
    use super::{Presence, translate};
    use crate::batch::{Change, ChangeKind};
    use crate::exclude::Excluder;
    use files_safe::Root;
    use notify::Event;
    use notify::event::{AccessKind, EventKind, ModifyKind, RemoveKind, RenameMode};
    use std::collections::HashMap;
    use std::path::PathBuf;

    struct Fixture {
        _dir: tempfile::TempDir,
        root: Root,
    }

    impl Fixture {
        fn new() -> Fixture {
            let dir = tempfile::tempdir().unwrap();
            let root = Root::open(dir.path()).unwrap();
            Fixture { _dir: dir, root }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.path().join(rel)
        }

        fn translate(
            &self,
            event: Event,
            exclude: &[&str],
            present: &[(&str, bool)],
        ) -> (Vec<Change>, bool) {
            let patterns: Vec<String> = exclude
                .iter()
                .map(|pattern| (*pattern).to_owned())
                .collect();
            let excluder = Excluder::new(&patterns).unwrap();
            let table: HashMap<String, bool> = present
                .iter()
                .map(|(rel, is_dir)| ((*rel).to_owned(), *is_dir))
                .collect();
            let look = move |path: &str| match table.get(path) {
                Some(directory) => Presence::Here(*directory),
                None => Presence::Gone,
            };
            let translation = translate(event, &self.root, &excluder, &look);
            let changes = translation
                .notices
                .into_iter()
                .map(|notice| notice.change)
                .collect();
            (changes, translation.rescan.is_some())
        }
    }

    fn event(kind: EventKind, path: PathBuf) -> Event {
        Event::new(kind).add_path(path)
    }

    #[test]
    fn a_created_file_is_a_creation() {
        let fixture = Fixture::new();
        let (changes, _) = fixture.translate(
            event(
                EventKind::Create(notify::event::CreateKind::File),
                fixture.path("src/new.rs"),
            ),
            &[],
            &[("src/new.rs", false)],
        );
        assert_eq!(
            changes,
            vec![Change {
                path: "src/new.rs".to_owned(),
                kind: ChangeKind::Created,
                directory: false,
            }]
        );
    }

    #[test]
    fn a_removed_folder_is_a_deletion_of_a_directory() {
        let fixture = Fixture::new();
        let (changes, _) = fixture.translate(
            event(EventKind::Remove(RemoveKind::Folder), fixture.path("old")),
            &[],
            &[],
        );
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, ChangeKind::Deleted);
        assert!(changes[0].directory);
    }

    #[test]
    fn a_symbolic_link_is_never_a_directory() {
        let fixture = Fixture::new();
        let (changes, _) = fixture.translate(
            event(
                EventKind::Create(notify::event::CreateKind::Any),
                fixture.path("link"),
            ),
            &[],
            &[],
        );
        assert_eq!(changes.len(), 1);
        assert!(!changes[0].directory, "a link is not the tree it points at");
    }

    #[test]
    fn rename_any_is_a_creation_when_the_path_exists() {
        let fixture = Fixture::new();
        let (changes, _) = fixture.translate(
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                fixture.path("new.txt"),
            ),
            &[],
            &[("new.txt", false)],
        );
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, ChangeKind::Created);
    }

    #[test]
    fn rename_any_is_a_deletion_when_the_path_is_gone() {
        let fixture = Fixture::new();
        let (changes, _) = fixture.translate(
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                fixture.path("old.txt"),
            ),
            &[],
            &[],
        );
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, ChangeKind::Deleted);
    }

    #[test]
    fn rename_both_is_a_deletion_plus_a_creation() {
        let fixture = Fixture::new();
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(fixture.path("old.txt"))
            .add_path(fixture.path("new.txt"));
        let (changes, _) = fixture.translate(event, &[], &[("new.txt", false)]);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "old.txt");
        assert_eq!(changes[0].kind, ChangeKind::Deleted);
        assert_eq!(changes[1].path, "new.txt");
        assert_eq!(changes[1].kind, ChangeKind::Created);
    }

    #[test]
    fn paths_outside_the_root_are_dropped() {
        let fixture = Fixture::new();
        let (changes, _) = fixture.translate(
            event(
                EventKind::Create(notify::event::CreateKind::File),
                PathBuf::from("/elsewhere/target.txt"),
            ),
            &[],
            &[],
        );
        assert!(changes.is_empty());
    }

    #[test]
    fn events_about_the_root_itself_are_dropped() {
        let fixture = Fixture::new();
        let path = fixture.root.path().to_path_buf();
        let (changes, _) = fixture.translate(
            event(
                EventKind::Modify(ModifyKind::Metadata(notify::event::MetadataKind::Any)),
                path,
            ),
            &[],
            &[],
        );
        assert!(changes.is_empty());
    }

    #[test]
    fn excluded_paths_are_dropped() {
        let fixture = Fixture::new();
        let (changes, _) = fixture.translate(
            event(
                EventKind::Create(notify::event::CreateKind::File),
                fixture.path("node_modules/react/index.js"),
            ),
            &["**/node_modules/*/**"],
            &[("node_modules/react/index.js", false)],
        );
        assert!(changes.is_empty());
    }

    #[test]
    fn a_rescan_flag_names_its_folder() {
        let fixture = Fixture::new();
        let mut event = Event::new(EventKind::Other).add_path(fixture.path("src/generated"));
        event = event.set_flag(notify::event::Flag::Rescan);
        let (changes, rescan) = fixture.translate(event, &[], &[("src/generated", true)]);
        assert!(changes.is_empty());
        assert!(rescan);
    }

    #[test]
    fn an_excluded_folder_is_never_the_folder_a_rescan_names() {
        let fixture = Fixture::new();
        let outside = Excluder::new(&["**/node_modules/*/**".to_owned()]).unwrap();
        let mut event = Event::new(EventKind::Other).add_path(fixture.path("node_modules/pkg"));
        event = event.set_flag(notify::event::Flag::Rescan);
        assert_eq!(
            translate(event, &fixture.root, &outside, &|_| Presence::Gone).rescan,
            Some(Some("node_modules/pkg".to_owned())),
            "a package folder is listed, so it can be rescanned"
        );
        let inside = Excluder::new(&["**/node_modules".to_owned()]).unwrap();
        let mut event = Event::new(EventKind::Other).add_path(fixture.path("node_modules/pkg"));
        event = event.set_flag(notify::event::Flag::Rescan);
        assert_eq!(
            translate(event, &fixture.root, &inside, &|_| Presence::Gone).rescan,
            Some(None),
            "an excluded folder's overflow names the root instead"
        );
    }

    #[test]
    fn access_events_are_ignored() {
        let fixture = Fixture::new();
        let (changes, _) = fixture.translate(
            event(
                EventKind::Access(AccessKind::Read),
                fixture.path("README.md"),
            ),
            &[],
            &[("README.md", false)],
        );
        assert!(changes.is_empty());
    }
}
