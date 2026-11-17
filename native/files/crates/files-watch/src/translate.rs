// SPDX-License-Identifier: Apache-2.0

//! Turns one backend event into changes inside the root.

use std::path::Path;

use files_safe::Root;
use notify::Event;
use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};

use crate::batch::{Change, ChangeKind};
use crate::exclude::Excluder;

/// What one backend event means for the tree.
#[derive(Debug, Default)]
pub(crate) struct Translation {
    /// Changes for paths inside the root and outside the excludes.
    pub(crate) changes: Vec<Change>,
    /// The backend dropped events: the tree must be listed again.
    pub(crate) rescan: bool,
}

/// Answers whether an absolute path exists, and whether it is a directory.
pub(crate) fn look(path: &Path) -> Option<bool> {
    std::fs::metadata(path).ok().map(|meta| meta.is_dir())
}

/// Translates one backend event, asking `look` about paths whose kind is ambiguous.
pub(crate) fn translate(
    event: Event,
    root: &Root,
    excluder: &Excluder,
    look: &dyn Fn(&Path) -> Option<bool>,
) -> Translation {
    let mut translation = Translation {
        changes: Vec::new(),
        rescan: event.need_rescan(),
    };
    if translation.rescan {
        return translation;
    }
    if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = event.kind {
        if let [from, to] = event.paths.as_slice() {
            push(
                &mut translation,
                root,
                excluder,
                from,
                ChangeKind::Deleted,
                false,
            );
            push(
                &mut translation,
                root,
                excluder,
                to,
                ChangeKind::Created,
                is_dir(look, to),
            );
            return translation;
        }
    }
    for path in &event.paths {
        if let Some((kind, directory)) = classify(&event.kind, path, look) {
            push(&mut translation, root, excluder, path, kind, directory);
        }
    }
    translation
}

fn classify(
    kind: &EventKind,
    path: &Path,
    look: &dyn Fn(&Path) -> Option<bool>,
) -> Option<(ChangeKind, bool)> {
    let change = match kind {
        EventKind::Create(create) => (
            ChangeKind::Created,
            match create {
                CreateKind::File => false,
                CreateKind::Folder => true,
                _ => is_dir(look, path),
            },
        ),
        EventKind::Remove(remove) => (
            ChangeKind::Deleted,
            match remove {
                RemoveKind::File => false,
                RemoveKind::Folder => true,
                _ => is_dir(look, path),
            },
        ),
        EventKind::Modify(ModifyKind::Name(mode)) => match mode {
            RenameMode::Any => match look(path) {
                Some(directory) => (ChangeKind::Created, directory),
                None => (ChangeKind::Deleted, false),
            },
            RenameMode::From => (ChangeKind::Deleted, false),
            RenameMode::To => (ChangeKind::Created, is_dir(look, path)),
            _ => (ChangeKind::Modified, is_dir(look, path)),
        },
        EventKind::Modify(_) | EventKind::Any => (ChangeKind::Modified, is_dir(look, path)),
        EventKind::Access(_) | EventKind::Other => return None,
    };
    Some(change)
}

fn is_dir(look: &dyn Fn(&Path) -> Option<bool>, path: &Path) -> bool {
    matches!(look(path), Some(true))
}

fn push(
    translation: &mut Translation,
    root: &Root,
    excluder: &Excluder,
    absolute: &Path,
    kind: ChangeKind,
    directory: bool,
) {
    let Some(path) = root.relative(absolute) else {
        return;
    };
    if path.is_empty() || excluder.is_excluded(&path) {
        return;
    }
    translation.changes.push(Change {
        path,
        kind,
        directory,
    });
}

#[cfg(test)]
mod tests {
    use super::translate;
    use crate::batch::{Change, ChangeKind};
    use crate::exclude::Excluder;
    use files_safe::Root;
    use notify::Event;
    use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

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

        fn translate(&self, event: Event, exclude: &[&str], look: &[(&str, bool)]) -> Vec<Change> {
            let patterns: Vec<String> = exclude
                .iter()
                .map(|pattern| (*pattern).to_owned())
                .collect();
            let excluder = Excluder::new(&patterns).unwrap();
            let table: HashMap<PathBuf, bool> = look
                .iter()
                .map(|(rel, is_dir)| (self.path(rel), *is_dir))
                .collect();
            let look = move |path: &Path| table.get(path).copied();
            translate(event, &self.root, &excluder, &look).changes
        }
    }

    fn event(kind: EventKind, path: PathBuf) -> Event {
        Event::new(kind).add_path(path)
    }

    #[test]
    fn a_created_file_is_a_creation() {
        let fixture = Fixture::new();
        let changes = fixture.translate(
            event(
                EventKind::Create(CreateKind::File),
                fixture.path("src/new.rs"),
            ),
            &[],
            &[],
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
        let changes = fixture.translate(
            event(EventKind::Remove(RemoveKind::Folder), fixture.path("old")),
            &[],
            &[],
        );
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, ChangeKind::Deleted);
        assert!(changes[0].directory);
    }

    #[test]
    fn rename_any_is_a_creation_when_the_path_exists() {
        let fixture = Fixture::new();
        let changes = fixture.translate(
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
        let changes = fixture.translate(
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
        let changes = fixture.translate(event, &[], &[("new.txt", false)]);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "old.txt");
        assert_eq!(changes[0].kind, ChangeKind::Deleted);
        assert_eq!(changes[1].path, "new.txt");
        assert_eq!(changes[1].kind, ChangeKind::Created);
    }

    #[test]
    fn paths_outside_the_root_are_dropped() {
        let fixture = Fixture::new();
        let changes = fixture.translate(
            event(
                EventKind::Create(CreateKind::File),
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
        let changes = fixture.translate(
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
        let changes = fixture.translate(
            event(
                EventKind::Create(CreateKind::File),
                fixture.path("node_modules/react/index.js"),
            ),
            &["**/node_modules/*/**"],
            &[("node_modules/react/index.js", false)],
        );
        assert!(changes.is_empty());
    }

    #[test]
    fn a_rescan_flag_is_an_overflow_signal() {
        let fixture = Fixture::new();
        let mut event = Event::new(EventKind::Other);
        event = event.set_flag(notify::event::Flag::Rescan);
        let patterns: Vec<String> = Vec::new();
        let excluder = Excluder::new(&patterns).unwrap();
        let translation = translate(event, &fixture.root, &excluder, &|_| None);
        assert!(translation.rescan);
        assert!(translation.changes.is_empty());
    }

    #[test]
    fn access_events_are_ignored() {
        let fixture = Fixture::new();
        let changes = fixture.translate(
            event(
                EventKind::Access(notify::event::AccessKind::Read),
                fixture.path("README.md"),
            ),
            &[],
            &[("README.md", false)],
        );
        assert!(changes.is_empty());
    }
}
