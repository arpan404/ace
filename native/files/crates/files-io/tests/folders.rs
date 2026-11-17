// SPDX-License-Identifier: Apache-2.0

//! The folder version must be the daemon's: a draft saved against one must be accepted by the
//! other. The comparison runs the real TypeScript `observed`, so it needs `bun` on PATH and an
//! installed checkout (`bun install`, which builds the workspace addon); it fails rather than
//! skipping when either is missing, because a skipped parity test proves nothing.

#![cfg(unix)]

mod common;

use std::path::Path;

use common::Fixture;
use std::os::unix::fs::symlink;

const SCRIPT: &str = r#"
const [files, workspace] = await Promise.all([import(process.argv[1]), import(process.argv[2])]);
const safe = await workspace.SafeRoot.create(process.argv[3]);
process.stdout.write(String(await files.observed(safe, process.argv[4])));
"#;

#[test]
fn folder_version_matches_the_typescript_observed() {
    let fixture = Fixture::new();
    populate(&fixture);
    let outside = tempfile::tempdir().expect("outside dir");
    std::fs::write(outside.path().join("secret.txt"), b"outside\n").expect("outside file");
    symlink(
        outside.path().join("secret.txt"),
        fixture.path("folder/escape.txt"),
    )
    .expect("escaping symlink");
    symlink("nowhere.txt", fixture.path("folder/dangling.txt")).expect("dangling symlink");

    let rust = fixture.version("folder");
    let bun = typescript_version(&fixture, "folder");
    assert_eq!(rust, bun, "folder versions must match the daemon's");
}

#[test]
fn folder_version_changes_when_a_file_inside_changes() {
    let fixture = Fixture::new();
    populate(&fixture);
    let before = fixture.version("folder");
    std::fs::write(fixture.path("folder/sub/b.txt"), b"different contents\n").expect("rewrite");
    assert_ne!(before, fixture.version("folder"));
}

/// A tree with the shapes that decide ordering, following and skipping.
#[allow(clippy::expect_used)]
fn populate(fixture: &Fixture) {
    let files = [
        ("folder/a.txt", "a"),
        ("folder/.hidden", "hidden"),
        ("folder/sub/b.txt", "b"),
        ("folder/sub/deeper/c.txt", "c"),
        ("folder/.git/HEAD", "ref: refs/heads/main\n"),
        ("folder/ignored.log", "ignored but listed anyway"),
        ("folder/back\\slash.txt", "the daemon refuses backslashes"),
        ("folder/\u{1F600}.txt", "a name above the BMP"),
        (
            "folder/\u{FFFD}.txt",
            "a name in the BMP that sorts after it in UTF-16",
        ),
        ("folder/Z.txt", "capital"),
        ("folder/z.txt", "lower case"),
        ("folder/.ace-upload-halfway", "an upload in flight"),
        ("folder/sub/.ace-upload-nested", "an upload in a subfolder"),
        ("folder/.ace-upload-folder/part", "an upload folder"),
    ];
    for (path, contents) in files {
        fixture.write(path, contents.as_bytes());
    }
    fixture.write("folder/.gitignore", b"ignored.log\n");
    symlink("a.txt", fixture.path("folder/link.txt")).expect("file symlink");
    symlink("sub", fixture.path("folder/linkdir")).expect("folder symlink");
}

#[allow(clippy::expect_used)]
fn typescript_version(fixture: &Fixture, relative: &str) -> String {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let files = repository.join("packages/files/src/filesystem.ts");
    let workspace = repository.join("packages/workspace/src/index.ts");
    let output = std::process::Command::new("bun")
        .arg("-e")
        .arg(SCRIPT)
        .arg(files)
        .arg(workspace)
        .arg(fixture.dir())
        .arg(relative)
        .output()
        .expect("bun is required to compare folder versions with the daemon");
    assert!(
        output.status.success(),
        "bun could not run the daemon's observed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("the daemon prints UTF-8")
}
