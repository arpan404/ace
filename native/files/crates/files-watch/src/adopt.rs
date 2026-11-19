// SPDX-License-Identifier: Apache-2.0

//! Lists a folder that just appeared, so a folder moved in with files is reported even when
//! the backend only names the folder itself.

use files_safe::Root;

use crate::batch::{Change, ChangeKind};
use crate::exclude::Excluder;
use crate::translate::Notice;

/// What listing a new folder found.
#[derive(Debug)]
pub(crate) enum Adopted {
    /// The files directly inside it.
    Files(Vec<Notice>),
    /// It holds more entries than a batch may carry, so it needs a rescan instead.
    TooMany,
    /// It could not be listed; its own creation event still stands.
    Unreadable,
}

/// Lists the files directly inside a folder that just appeared. Folders and symbolic links
/// are left to their own events, and excluded paths are never reported.
pub(crate) fn list(root: &Root, excluder: &Excluder, folder: &str, limit: usize) -> Adopted {
    let Ok(dir) = root.open_dir(folder) else {
        return Adopted::Unreadable;
    };
    let Ok(entries) = dir.entries() else {
        return Adopted::Unreadable;
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let path = if folder.is_empty() {
            name
        } else {
            format!("{folder}/{name}")
        };
        if excluder.is_excluded(&path) {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        files.push(Notice {
            change: Change {
                path,
                kind: ChangeKind::Created,
                directory: false,
            },
            rename: false,
            present: Some(false),
        });
        if files.len() > limit {
            return Adopted::TooMany;
        }
    }
    Adopted::Files(files)
}

#[cfg(test)]
mod tests {
    use super::{Adopted, list};
    use crate::exclude::Excluder;
    use files_safe::Root;

    fn paths(adopted: Adopted) -> Vec<String> {
        match adopted {
            Adopted::Files(files) => files.into_iter().map(|file| file.change.path).collect(),
            other => panic!("expected files, got {other:?}"),
        }
    }

    #[test]
    fn lists_the_files_directly_inside_a_moved_in_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("moved/nested")).unwrap();
        std::fs::write(dir.path().join("moved/one.txt"), b"1").unwrap();
        std::fs::write(dir.path().join("moved/two.txt"), b"2").unwrap();
        std::fs::write(dir.path().join("moved/nested/three.txt"), b"3").unwrap();
        let root = Root::open(dir.path()).unwrap();
        let excluder = Excluder::new(&[]).unwrap();
        let mut found = paths(list(&root, &excluder, "moved", 100));
        found.sort();
        assert_eq!(found, ["moved/one.txt", "moved/two.txt"]);
    }

    #[test]
    fn skips_excluded_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::write(dir.path().join("node_modules/pkg/index.js"), b"x").unwrap();
        let root = Root::open(dir.path()).unwrap();
        let excluder = Excluder::new(&["**/node_modules/*/**".to_owned()]).unwrap();
        assert!(paths(list(&root, &excluder, "node_modules/pkg", 100)).is_empty());
    }

    #[test]
    fn a_folder_with_too_many_files_needs_a_rescan() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("many")).unwrap();
        for index in 0..5 {
            std::fs::write(dir.path().join(format!("many/{index}")), b"x").unwrap();
        }
        let root = Root::open(dir.path()).unwrap();
        let excluder = Excluder::new(&[]).unwrap();
        assert!(matches!(
            list(&root, &excluder, "many", 2),
            Adopted::TooMany
        ));
    }
}
