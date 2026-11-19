// SPDX-License-Identifier: Apache-2.0

//! The forms a relative path may take, and the names each platform refuses.

// Tests fail loudly on a broken fixture; the workspace rule against panicking is about library code.
#![allow(clippy::expect_used)]

use files_safe::Root;

fn checkout() -> (tempfile::TempDir, Root) {
    let temp = tempfile::tempdir().expect("temp dir");
    let root = Root::open(temp.path()).expect("open root");
    (temp, root)
}

#[test]
fn rejects_malformed_forms() {
    let (_temp, root) = checkout();
    for rel in ["", "a", "a/b"] {
        assert_eq!(Root::check(rel).expect(rel), rel);
    }
    for rel in ["a/", "a//b", "./a", "a/.", "a\0b", ".", ".."] {
        assert_eq!(
            Root::check(rel).expect_err(rel).code(),
            "INVALID_PATH",
            "{rel}"
        );
    }
    assert_eq!(
        root.resolve("a\0b").expect_err("nul").code(),
        "INVALID_PATH"
    );
}

#[cfg(windows)]
#[test]
fn rejects_windows_only_forms() {
    let (_temp, root) = checkout();
    for rel in [
        r"a\b",
        r"\a",
        "C:",
        "C:/a",
        "c:temp",
        "CON",
        "nul.txt",
        "aux/x",
        "com1",
        "a.",
        "a ",
        "a./b",
        "a:stream",
        "PROGRA~1",
        "CON .txt",
        "com\u{b9}",
    ] {
        assert_eq!(
            root.resolve(rel).expect_err(rel).code(),
            "INVALID_PATH",
            "resolve {rel}"
        );
    }
}

#[cfg(not(windows))]
#[test]
fn keeps_names_windows_would_refuse() {
    let (_temp, root) = checkout();
    for rel in ["con", "aux.txt", "a.", "a b", "a\\b"] {
        assert_eq!(
            root.resolve(rel).expect(rel),
            root.path().join(rel),
            "{rel}"
        );
    }
}

#[cfg(unix)]
#[test]
fn follows_a_link_target_with_a_colon() {
    use std::os::unix::fs::symlink;

    // A colon is an ordinary character in a Unix name, so a target carrying one is a name.
    let (_temp, root) = checkout();
    std::fs::create_dir_all(root.path().join("x:y")).expect("folders");
    symlink("x:y", root.path().join("link")).expect("link");
    assert!(root.open_dir("link").is_ok());
}

#[cfg(windows)]
#[test]
fn refuses_a_windows_style_link_target() {
    use std::os::windows::fs::symlink_dir;

    let temp = tempfile::tempdir().expect("temp dir");
    let root = Root::open(temp.path()).expect("open root");
    std::fs::create_dir_all(root.path().join("real")).expect("folders");

    for target in ["GIT~1", "x:s", "CON", "a.", "a "] {
        if symlink_dir(target, root.path().join("link")).is_err() {
            // Creating links needs developer mode or privilege; nothing to test without it.
            return;
        }
        assert_eq!(
            root.open_dir("link").expect_err(target).code(),
            "PATH_ESCAPE",
            "open_dir through a link to {target}"
        );
        std::fs::remove_file(root.path().join("link")).expect("remove the link");
    }
}
