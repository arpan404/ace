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
