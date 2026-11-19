// SPDX-License-Identifier: Apache-2.0

//! A read-only request authorizes a name once and then answers through that same handle, so a
//! name replaced by a link between the check and the read cannot make the answer come from a
//! folder nobody checked.
#![allow(clippy::expect_used)]

use std::fs;

use files_list::{ListOptions, Lister};

fn options() -> ListOptions {
    ListOptions {
        limit: 100,
        cursor: None,
        hide: vec![".git".to_owned()],
    }
}

fn root(dir: &std::path::Path) -> files_safe::Root {
    files_safe::Root::open(dir).expect("open root")
}

#[cfg(unix)]
#[test]
fn a_listing_answers_from_the_folder_the_policy_checked() {
    let temp = tempfile::tempdir().expect("temp dir");
    fs::create_dir(temp.path().join("docs")).expect("folder");
    fs::write(temp.path().join("docs/kept.md"), b"kept").expect("write");
    fs::create_dir(temp.path().join(".git")).expect("git");
    fs::write(temp.path().join(".git/config"), b"[core]").expect("write");
    let root = root(temp.path());
    let lister = Lister::new(root.clone());

    let (handle, stored) = files_io::authorized_dir(&root, "docs").expect("authorized");
    // The folder the policy read is moved away and a link into git's store takes its name.
    fs::rename(temp.path().join("docs"), temp.path().join("moved")).expect("move");
    std::os::unix::fs::symlink(".git", temp.path().join("docs")).expect("link");

    let page = lister
        .list_in(&stored, &handle, &options())
        .expect("the folder that was checked answers");

    let names: Vec<&str> = page
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(names, ["kept.md"], "git's store never reaches the page");
}

#[cfg(unix)]
#[test]
fn a_folder_that_leads_into_gits_store_is_refused() {
    let temp = tempfile::tempdir().expect("temp dir");
    fs::create_dir(temp.path().join(".git")).expect("git");
    fs::write(temp.path().join(".git/config"), b"[core]").expect("write");
    std::os::unix::fs::symlink(".git", temp.path().join("alias")).expect("link");
    let root = root(temp.path());

    for path in [".git", "alias"] {
        let error = files_io::authorized_dir(&root, path)
            .expect_err("a folder inside git's store is refused");
        assert_eq!(error.code(), "INVALID_PATH", "{path}");
    }
}

#[cfg(unix)]
#[test]
fn a_stat_and_a_description_refuse_the_same_names_a_listing_does() {
    let temp = tempfile::tempdir().expect("temp dir");
    fs::create_dir(temp.path().join(".git")).expect("git");
    fs::write(temp.path().join(".git/config"), b"[core]").expect("write");
    fs::write(temp.path().join("notes.md"), b"notes").expect("write");
    std::os::unix::fs::symlink(".git/config", temp.path().join("config-link")).expect("link");
    let root = root(temp.path());
    let lister = Lister::new(root.clone());

    {
        let path = ".git/config";
        let parent = files_io::authorized_parent(&root, path)
            .expect_err("a leaf inside git's store is refused");
        assert_eq!(parent.code(), "INVALID_PATH", "{path}");

        let described = files_io::describe(&root, path, &files_io::Walks::unbounded())
            .expect_err("a description of git's store is refused");
        assert_eq!(described.code(), "INVALID_PATH", "{path}");

        let measured = files_io::measure(&root, path, &files_io::Walks::unbounded())
            .expect_err("measuring git's store is refused");
        assert_eq!(measured.code(), "INVALID_PATH", "{path}");
    }

    // A link is described and measured through its target, which the policy reads too.
    let described = files_io::describe(&root, "config-link", &files_io::Walks::unbounded())
        .expect_err("a link into git's store is refused");
    assert_eq!(described.code(), "INVALID_PATH");

    let measured = files_io::measure(&root, "config-link", &files_io::Walks::unbounded())
        .expect_err("measuring a link into git's store is refused");
    assert_eq!(measured.code(), "INVALID_PATH");

    // An ordinary leaf is described through the handle the policy read.
    let parent = files_io::authorized_parent(&root, "notes.md").expect("authorized");
    let entry = lister
        .stat_in("notes.md", &parent.dir, &parent.name)
        .expect("stat");
    assert_eq!(entry.name, "notes.md");
    assert_eq!(entry.size, 5);
}
