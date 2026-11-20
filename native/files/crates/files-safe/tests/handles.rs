// SPDX-License-Identifier: Apache-2.0

//! The handle API: what ace-files opens through, so a rename cannot redirect an operation.

// Tests fail loudly on a broken fixture; the workspace rule against panicking is about library code.
#![allow(clippy::expect_used)]

use std::fs;

use files_safe::Root;
use tempfile::TempDir;

fn checkout() -> (TempDir, Root) {
    let temp = tempfile::tempdir().expect("temp dir");
    let root = Root::open(temp.path()).expect("open root");
    (temp, root)
}

#[test]
fn opens_a_folder_through_a_handle() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a/b")).expect("folders");
    fs::write(root.path().join("a/b/file.txt"), b"x").expect("file");

    let folder = root.open_dir("a/b").expect("open a/b");
    let found = folder
        .metadata("file.txt")
        .expect("stat through the handle");
    assert!(found.is_file());

    let root_handle = root.open_dir("").expect("open the root");
    assert!(root_handle.symlink_metadata("a").is_ok());
}

#[test]
fn opening_a_file_as_a_folder_is_not_a_directory() {
    let (_temp, root) = checkout();
    fs::write(root.path().join("file.txt"), b"x").expect("file");

    assert_eq!(
        root.open_dir("file.txt").expect_err("a file").code(),
        "NOT_DIRECTORY"
    );
    assert_eq!(
        root.open_dir("missing").expect_err("missing").code(),
        "NOT_FOUND"
    );
}

#[cfg(unix)]
#[test]
fn opening_a_folder_through_a_link_stays_inside() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temp dir");
    let checkout = temp.path().join("checkout");
    let outside = temp.path().join("outside");
    fs::create_dir_all(&checkout).expect("folders");
    fs::create_dir_all(&outside).expect("folders");

    let root = Root::open(&checkout).expect("open root");
    let outside = fs::canonicalize(&outside).expect("canonical outside");

    symlink("real", root.path().join("link")).expect("link");
    fs::create_dir_all(root.path().join("real")).expect("folders");
    symlink(&outside, root.path().join("outlink")).expect("outside link");

    assert!(root.open_dir("link").is_ok());
    assert_eq!(
        root.open_dir("outlink").expect_err("escape").code(),
        "PATH_ESCAPE"
    );
}

#[test]
fn open_parent_returns_the_folder_and_the_leaf_name() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a")).expect("folders");

    let (parent, leaf) = root.open_parent("a/new.txt").expect("open parent");
    assert_eq!(leaf, "new.txt");
    parent.create("new.txt").expect("create through the parent");
    assert!(root.path().join("a/new.txt").is_file());

    let (root_folder, leaf) = root
        .open_parent("top.txt")
        .expect("open the root as parent");
    assert_eq!(leaf, "top.txt");
    root_folder.create("top.txt").expect("create in the root");
    assert!(root.path().join("top.txt").is_file());
}

#[test]
fn open_parent_names_the_leaf_the_folder_stores() {
    let (_temp, root) = checkout();
    fs::write(root.path().join("Stored.TXT"), b"x").expect("file");

    let (parent, leaf) = root.open_parent("Stored.TXT").expect("open parent");
    assert_eq!(leaf, "Stored.TXT");
    assert!(parent.symlink_metadata(&leaf).is_ok());
}

#[cfg(unix)]
#[test]
fn open_parent_never_follows_the_leaf() {
    use std::os::unix::fs::symlink;

    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a")).expect("folders");
    symlink("missing.txt", root.path().join("a/dangling")).expect("dangling link");

    let (parent, leaf) = root.open_parent("a/dangling").expect("open parent");
    assert_eq!(leaf, "dangling", "a dangling link is a name, not a target");
    let found = parent
        .symlink_metadata("dangling")
        .expect("the link itself");
    assert!(found.file_type().is_symlink());
    assert!(parent.symlink_metadata("missing.txt").is_err());
}

#[test]
fn open_parent_refuses_the_root() {
    let (_temp, root) = checkout();
    assert_eq!(
        root.open_parent("").expect_err("no parent").code(),
        "INVALID_PATH"
    );
}

#[test]
fn relative_only_returns_the_accepted_form() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a b")).expect("folders");
    fs::write(root.path().join("a b/file.txt"), b"x").expect("file");

    for rel in ["", "a b", "a b/file.txt"] {
        let relative = root.relative(&root.resolve(rel).expect(rel)).expect(rel);
        assert_eq!(relative, rel);
        assert_eq!(Root::check(&relative).expect("check accepts it"), relative);
    }

    assert_eq!(root.relative(&root.path().join("a b/../a b")), None);
}

#[cfg(unix)]
#[test]
fn relative_is_none_for_a_name_the_platform_refuses() {
    let (_temp, root) = checkout();
    let absolute = root.path().join("a b");
    assert_eq!(root.relative(&absolute).as_deref(), Some("a b"));
    // Unchecked segments such as `..` or a NUL never come back as a relative path.
    assert_eq!(root.relative(&root.path().join("a\0b")), None);
}

#[test]
fn returns_the_name_the_folder_stores() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join(".git")).expect("folders");
    fs::write(root.path().join(".git/config"), b"x").expect("file");

    match root.resolve(".GIT/CONFIG") {
        // A case-insensitive volume finds the entry and the answer carries its stored spelling,
        // which is what `.git` policies must see.
        Ok(path) => assert_eq!(path, root.path().join(".git/config")),
        Err(error) => assert_eq!(
            error.code(),
            "NOT_FOUND",
            "a case-sensitive volume has no .GIT"
        ),
    }
}

#[cfg(unix)]
#[test]
fn stored_names_do_not_mix_up_lookalikes() {
    // A trailing space is a legal name on Unix, and the two entries must never be confused for
    // one another.
    let (_temp, root) = checkout();
    fs::write(root.path().join("readme"), b"one").expect("plain");
    fs::write(root.path().join("readme "), b"two").expect("spaced");

    assert_eq!(
        root.resolve("readme").expect("plain"),
        root.path().join("readme")
    );
    assert_eq!(
        root.resolve("readme ").expect("spaced"),
        root.path().join("readme ")
    );
}

#[cfg(unix)]
#[test]
fn a_hard_link_resolves_to_its_own_name() {
    // Both names share one identity, so the answer has to come from the name that was asked for.
    let (_temp, root) = checkout();
    fs::write(root.path().join("first.txt"), b"x").expect("file");
    fs::hard_link(
        root.path().join("first.txt"),
        root.path().join("second.txt"),
    )
    .expect("link");

    assert_eq!(
        root.resolve("first.txt").expect("first"),
        root.path().join("first.txt")
    );
    assert_eq!(
        root.resolve("second.txt").expect("second"),
        root.path().join("second.txt")
    );
}

#[test]
fn open_parent_stored_reports_the_spelling_the_disk_keeps() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("Docs/nested")).expect("folders");

    let parent = root
        .open_parent_stored("Docs/nested/new.txt")
        .expect("open stored parent");
    assert_eq!(parent.name, "new.txt");
    assert_eq!(parent.folders, ["Docs", "nested"]);

    let outcome = root.open_parent_stored("DOCS/NESTED/new.txt");
    if root.path().join("DOCS").exists() {
        let parent = outcome.expect("open the folders under another spelling");
        assert_eq!(
            parent.folders,
            ["Docs", "nested"],
            "a case-insensitive volume answers with the names on disk"
        );
    } else {
        assert!(
            outcome.is_err(),
            "a case-sensitive volume has no DOCS folder to open"
        );
    }
}

#[cfg(unix)]
#[test]
fn open_parent_stored_refuses_a_link_that_leaves_and_keeps_inside_ones() {
    use std::os::unix::fs::symlink;

    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("real")).expect("folders");
    symlink("real", root.path().join("alias")).expect("link");

    let parent = root
        .open_parent_stored("alias/new.txt")
        .expect("an inside link is followed for a read");
    assert_eq!(
        parent.folders,
        ["real"],
        "a policy reads the target's stored name, not the link's"
    );
}

#[cfg(unix)]
#[test]
fn a_mutation_walk_refuses_every_link_on_the_way() {
    use std::os::unix::fs::symlink;

    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("real")).expect("folders");
    symlink("real", root.path().join("alias")).expect("link");

    let parent = root
        .open_parent_unlinked("real/new.txt")
        .expect("a real folder is fine");
    assert_eq!(parent.folders, ["real"]);

    let error = root
        .open_parent_unlinked("alias/new.txt")
        .expect_err("a link on the way is not a mutation target");
    assert_eq!(error.code(), "PATH_ESCAPE");
}

#[test]
fn stored_path_names_what_a_link_leads_into() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join(".git")).expect("git");
    fs::write(root.path().join(".git/config"), b"x").expect("file");
    #[cfg(unix)]
    std::os::unix::fs::symlink(".git/config", root.path().join("config-link")).expect("link");
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(".git/config", root.path().join("config-link"))
        .expect("link");

    assert_eq!(
        root.stored_path("config-link").expect("stored target"),
        [".git", "config"]
    );
}

#[cfg(unix)]
#[test]
fn an_unlinked_folder_walk_refuses_every_link_inside_or_out() {
    let (_temp, root) = checkout();
    let outside = tempfile::tempdir().expect("another temp dir");
    fs::create_dir_all(root.path().join("a/b")).expect("folders");
    fs::write(root.path().join("a/b/file.txt"), b"x").expect("file");
    std::os::unix::fs::symlink("a", root.path().join("inside")).expect("a link inside");
    std::os::unix::fs::symlink(outside.path(), root.path().join("away")).expect("a link out");

    let folder = root.open_dir_unlinked("a/b").expect("open a/b");
    assert!(folder.metadata("file.txt").expect("stat").is_file());
    for through in ["inside/b", "away"] {
        assert_eq!(
            root.open_dir_unlinked(through)
                .map(|_| ())
                .map_err(|error| error.code()),
            Err("PATH_ESCAPE"),
            "{through} goes through a link"
        );
    }
}
