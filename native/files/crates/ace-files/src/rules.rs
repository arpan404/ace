// SPDX-License-Identifier: Apache-2.0

//! The ignore files whose edits change what the quick-open index should contain.
//!
//! A watcher reports an edited `.gitignore` as one changed file, but the edit can hide paths that
//! are indexed and reveal paths that were not, and neither shows up as a file the watcher could
//! report. These helpers name the folder a batch must walk again: the folder holding a changed
//! `.gitignore`, the checkout a repository's `info/exclude` governs, or the whole root for the
//! user's global excludes file.

use std::path::Path;

use files_safe::Root;
use files_watch::Change;

/// The folders whose indexed paths this batch's ignore-rule edits make stale.
///
/// Folders are widest first and a folder another one covers is left out, so a batch that edits
/// two nested `.gitignore` files asks for one walk. An empty folder means the whole root.
pub fn changed(root: &Root, changes: &[Change]) -> Vec<String> {
    // Resolved once: finding it reads the user's git configuration, and a batch can name
    // thousands of paths.
    changed_with(
        root,
        changes,
        ignore::gitignore::gitconfig_excludes_path().as_deref(),
    )
}

fn changed_with(root: &Root, changes: &[Change], global: Option<&Path>) -> Vec<String> {
    // `core.excludesFile` (or git's XDG default) is only a rule file for the index when it lives
    // inside this checkout; then a change to it governs the whole root.
    let global = global
        .and_then(|file| std::fs::canonicalize(file).ok())
        .and_then(|file| root.relative(&file));
    let mut folders: Vec<String> = changes
        .iter()
        .filter_map(|change| rule_folder(root, &change.path, global.as_deref()))
        .collect();
    folders.sort_by_key(|folder| depth(folder));
    folders.dedup();
    let mut kept: Vec<String> = Vec::with_capacity(folders.len());
    for folder in folders {
        if kept.iter().any(|outer| covers(outer, &folder)) {
            continue;
        }
        kept.push(folder);
    }
    kept
}

/// The folder one changed path governs, when the path is an ignore rule file.
fn rule_folder(root: &Root, path: &str, global: Option<&str>) -> Option<String> {
    gitignore_folder(path)
        .or_else(|| repository_exclude_folder(path))
        .or_else(|| is_shared_exclude(root, path).then(String::new))
        .or_else(|| (global == Some(path)).then(String::new))
}

/// A folder's own `.gitignore` governs that folder and everything under it.
fn gitignore_folder(path: &str) -> Option<String> {
    if path == ".gitignore" {
        return Some(String::new());
    }
    path.strip_suffix("/.gitignore")
        .filter(|folder| !folder.is_empty())
        .map(str::to_owned)
}

/// `<repository>/.git/info/exclude` governs the repository: the checkout root when the repository
/// top is the root, or the nested folder that holds its own `.git`.
fn repository_exclude_folder(path: &str) -> Option<String> {
    if path == ".git/info/exclude" {
        return Some(String::new());
    }
    path.strip_suffix("/.git/info/exclude")
        .filter(|folder| !folder.is_empty())
        .map(str::to_owned)
}

/// A linked worktree keeps `info/exclude` in the git directory its own `.git` names in
/// `commondir`, which is usually outside the checkout. When it is inside, the file governs the
/// whole root, so any `info/exclude` under a folder that looks like a git directory counts; a
/// file merely named `exclude` under a real `info` folder does not.
fn is_shared_exclude(root: &Root, path: &str) -> bool {
    let Some(git_dir) = path.strip_suffix("/info/exclude") else {
        return false;
    };
    if git_dir.is_empty() || git_dir.ends_with("/.git") {
        return false;
    }
    let Ok(absolute) = root.resolve(git_dir) else {
        return false;
    };
    ["HEAD", "commondir", "config"]
        .iter()
        .any(|marker| absolute.join(marker).exists())
}

/// How many path segments name a folder; the root has none.
fn depth(folder: &str) -> usize {
    folder.split('/').filter(|part| !part.is_empty()).count()
}

/// Whether `outer` is `inner` or one of its ancestors; the empty folder covers everything.
fn covers(outer: &str, inner: &str) -> bool {
    outer.is_empty()
        || inner == outer
        || inner
            .strip_prefix(outer)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;

    fn root(dir: &std::path::Path) -> Root {
        Root::open(dir).expect("a checkout root")
    }

    fn write(path: &std::path::Path, contents: &str) {
        std::fs::write(path, contents).expect("the file");
    }

    fn change(path: &str) -> Change {
        Change {
            path: path.to_owned(),
            kind: files_watch::ChangeKind::Modified,
            directory: false,
        }
    }

    #[test]
    fn a_folder_gitignore_rebuilds_that_folder() {
        let checkout = tempfile::tempdir().expect("a temp dir");
        assert_eq!(
            changed(&root(checkout.path()), &[change("docs/.gitignore")]),
            ["docs"]
        );
        assert_eq!(
            changed(&root(checkout.path()), &[change(".gitignore")]),
            [""]
        );
    }

    #[test]
    fn a_repository_exclude_rebuilds_the_repository_top() {
        let checkout = tempfile::tempdir().expect("a temp dir");
        assert_eq!(
            changed(&root(checkout.path()), &[change(".git/info/exclude")]),
            [""]
        );
        assert_eq!(
            changed(
                &root(checkout.path()),
                &[change("vendor/lib/.git/info/exclude")]
            ),
            ["vendor/lib"]
        );
    }

    #[test]
    fn nested_rule_files_ask_for_one_outer_walk() {
        let checkout = tempfile::tempdir().expect("a temp dir");
        assert_eq!(
            changed(
                &root(checkout.path()),
                &[change("src/gen/.gitignore"), change("src/.gitignore")]
            ),
            ["src"]
        );
        assert_eq!(
            changed(
                &root(checkout.path()),
                &[change("src/.gitignore"), change(".gitignore")]
            ),
            [""]
        );
    }

    #[test]
    fn an_ordinary_file_named_exclude_is_not_a_rule_file() {
        let checkout = tempfile::tempdir().expect("a temp dir");
        std::fs::create_dir_all(checkout.path().join("notes/info")).expect("the folders");
        std::fs::write(checkout.path().join("notes/info/exclude"), "not git\n").expect("the file");
        assert_eq!(
            changed(&root(checkout.path()), &[change("notes/info/exclude")]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_global_excludes_file_inside_the_root_rebuilds_the_whole_root() {
        let checkout = tempfile::tempdir().expect("a temp dir");
        let outside = tempfile::tempdir().expect("a temp dir");
        write(&checkout.path().join("my-ignores"), "*.log\n");
        write(&outside.path().join("my-ignores"), "*.log\n");
        let root = root(checkout.path());
        assert_eq!(
            changed_with(
                &root,
                &[change("my-ignores")],
                Some(&checkout.path().join("my-ignores"))
            ),
            [""],
            "the user's excludes file inside the checkout governs every folder"
        );
        assert_eq!(
            changed_with(
                &root,
                &[change("my-ignores")],
                Some(&outside.path().join("my-ignores"))
            ),
            Vec::<String>::new(),
            "an excludes file outside the checkout never appears in its batches"
        );
    }

    #[test]
    fn a_shared_git_directory_exclude_rebuilds_the_whole_root() {
        let checkout = tempfile::tempdir().expect("a temp dir");
        std::fs::create_dir_all(checkout.path().join(".git/worktrees/wt")).expect("the git dir");
        std::fs::write(checkout.path().join(".git/worktrees/wt/HEAD"), "ref\n").expect("HEAD");
        assert_eq!(
            changed(
                &root(checkout.path()),
                &[change(".git/worktrees/wt/info/exclude")]
            ),
            [""]
        );
    }
}
