// SPDX-License-Identifier: Apache-2.0

mod common;

use std::path::Path;

use common::Fixture;

/// The daemon prints versions with JavaScript's number rules, and stored drafts are compared
/// against them, so both timestamps must print exactly as `node` prints them.
///
/// This needs `node` on PATH and fails rather than skipping without it: a skipped parity test
/// proves nothing.
#[test]
fn version_matches_javascript_format() {
    let fixture = Fixture::new();
    fixture.write("fraction.md", b"a draft the editor saves many times\n");
    fixture.write("whole.md", b"a draft saved in a whole second\n");
    fixture.write("halfway.md", b"a draft saved at a halfway millisecond\n");
    fixture.set_modified("fraction.md", 1_731_800_000, 123_456_700);
    fixture.set_modified("whole.md", 1_731_800_000, 0);
    // 1911493843000.78125 ms is exactly halfway between two decimals that both read back as it.
    fixture.set_modified("halfway.md", 1_911_493_843, 781_250);

    for relative in ["fraction.md", "whole.md", "halfway.md"] {
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

#[test]
fn a_pre_1970_mtime_prints_negative_milliseconds() {
    let fixture = Fixture::new();
    fixture.write("old.txt", b"older than the epoch\n");
    filetime::set_file_mtime(
        fixture.path("old.txt"),
        filetime::FileTime::from_unix_time(-315_619_200, 123_456_789),
    )
    .expect("set a 1960 modification time");

    let version = fixture.version("old.txt");
    assert_eq!(
        version,
        javascript_version(&fixture.path("old.txt")),
        "a pre-1970 time must print as node prints it"
    );
    let mtime = version.split(':').nth(3).expect("an mtime field");
    assert!(
        mtime.starts_with('-'),
        "a pre-1970 time stays negative: {mtime}"
    );
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
        .expect("node is required to check version formatting");
    assert!(
        output.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("node prints UTF-8")
}
