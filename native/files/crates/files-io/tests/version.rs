// SPDX-License-Identifier: Apache-2.0

mod common;

use std::path::Path;

use common::Fixture;

/// The daemon prints versions with JavaScript's number rules, and stored drafts are compared
/// against them, so both timestamps must print exactly as `node` prints them.
#[test]
fn version_matches_javascript_format() {
    if !node_available() {
        eprintln!("node is not on PATH; skipping version_matches_javascript_format");
        return;
    }
    let fixture = Fixture::new();
    fixture.write("fraction.md", b"a draft the editor saves many times\n");
    fixture.write("whole.md", b"a draft saved in a whole second\n");
    fixture.set_modified("fraction.md", 1_731_800_000, 123_456_700);
    fixture.set_modified("whole.md", 1_731_800_000, 0);

    for relative in ["fraction.md", "whole.md"] {
        let javascript = javascript_version(&fixture.path(relative));
        assert_eq!(
            fixture.version(relative),
            javascript,
            "{relative} must print its version exactly as node does"
        );
    }
}

#[test]
fn stat_version_is_none_when_nothing_is_there() {
    let fixture = Fixture::new();
    fixture.write("present/folder/file.txt", b"text\n");
    assert!(
        files_io::stat_version(fixture.root(), "absent.txt")
            .expect("stat a missing file")
            .is_none()
    );
    assert!(
        files_io::stat_version(fixture.root(), "absent/folder/file.txt")
            .expect("stat below a missing folder")
            .is_none()
    );
    assert!(
        files_io::stat_version(fixture.root(), "present/folder")
            .expect("stat a folder")
            .is_some(),
        "the daemon guards folder changes with the same kind of version"
    );
}

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success())
}

#[allow(clippy::expect_used)]
fn javascript_version(path: &Path) -> String {
    let script = "const fs = require('node:fs'); \
                  const stats = fs.lstatSync(process.argv[1]); \
                  process.stdout.write(`${stats.dev}:${stats.ino}:${stats.size}:\
                  ${stats.mtimeMs}:${stats.ctimeMs}`);";
    let output = std::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(path)
        .output()
        .expect("run node");
    assert!(
        output.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("node prints UTF-8")
}
