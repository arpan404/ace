// SPDX-License-Identifier: Apache-2.0

mod common;

use common::Fixture;
use files_io::{ReadRange, read};

fn range() -> ReadRange {
    ReadRange {
        offset: 0,
        length: 64,
        max_size: None,
    }
}

#[test]
fn operations_refuse_paths_outside_root() {
    let fixture = Fixture::new();
    let malformed = [
        "../outside.txt",
        "/etc/passwd",
        "a/../b",
        "trailing/",
        "bad\0name",
    ];

    for path in malformed {
        assert_eq!(
            read(fixture.root(), path, range())
                .expect_err("read")
                .code(),
            "INVALID_PATH",
            "read({path})"
        );
        assert_eq!(
            files_io::stat_version(fixture.root(), path)
                .expect_err("stat")
                .code(),
            "INVALID_PATH",
            "stat_version({path})"
        );
        assert_eq!(
            files_io::create_file(fixture.root(), path, b"x")
                .expect_err("create")
                .code(),
            "INVALID_PATH",
            "create_file({path})"
        );
    }

    let outside = tempfile::tempdir().expect("outside dir");
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, b"not yours\n").expect("outside file");

    let empty = files_io::remove(fixture.root(), "").expect_err("the root is not removable");
    assert_eq!(empty.code(), "INVALID_ARGUMENT");
    let no_source =
        files_io::rename(fixture.root(), "", "moved", None, None).expect_err("no source");
    assert_eq!(no_source.code(), "INVALID_ARGUMENT");
    assert!(fixture.dir().exists());
}

#[cfg(unix)]
#[test]
fn a_symlink_that_leaves_the_root_is_refused() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().expect("outside dir");
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, b"not yours\n").expect("outside file");
    std::os::unix::fs::symlink(&secret, fixture.path("escape.txt")).expect("symlink");

    assert_eq!(
        read(fixture.root(), "escape.txt", range())
            .expect_err("read")
            .code(),
        "PATH_ESCAPE"
    );
    assert_eq!(
        files_io::stat_version(fixture.root(), "escape.txt")
            .expect_err("stat")
            .code(),
        "PATH_ESCAPE"
    );
    assert_eq!(
        files_io::write(fixture.root(), "escape.txt", b"replaced\n", None)
            .expect_err("write")
            .code(),
        "PATH_ESCAPE"
    );
    assert_eq!(
        std::fs::read(&secret).expect("read outside"),
        b"not yours\n"
    );
}
