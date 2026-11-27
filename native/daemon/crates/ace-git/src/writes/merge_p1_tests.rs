// SPDX-License-Identifier: Apache-2.0
//! Failing-first tests for P1-2 (openat no-follow parent walk, worktree byte validation before
//! checkout/removal, exact stage entry + locked index CAS without rereading worktree, newline
//! filenames) and P2 (`take_side` CRLF, smudge filter, and symlink checkout semantics).

use std::path::Path;

use sha2::{Digest, Sha256};

use super::*;
use crate::core::credentials::test_support::Fixture;
use crate::reads::test_support::ProcessCommands;
use crate::writes::bind::test_support::InterceptingCommands;

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn conflicting_file(fixture: &Fixture, repo: &Path, rel: &str) -> (String, String) {
    let target = repo.join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).expect("parent");
    }
    std::fs::write(&target, "base line\n").expect("base");
    fixture.git(repo, &["add", "--", rel]);
    fixture.git(repo, &["commit", "--quiet", "-m", "base"]);
    fixture.git(repo, &["checkout", "--quiet", "-b", "other"]);
    std::fs::write(&target, "theirs line\n").expect("theirs");
    fixture.git(repo, &["add", "--", rel]);
    fixture.git(repo, &["commit", "--quiet", "-m", "theirs"]);
    let other = String::from_utf8_lossy(&fixture.git(repo, &["rev-parse", "HEAD"]))
        .trim_end()
        .to_owned();
    fixture.git(repo, &["checkout", "--quiet", "main"]);
    std::fs::write(&target, "ours line\n").expect("ours");
    fixture.git(repo, &["add", "--", rel]);
    fixture.git(repo, &["commit", "--quiet", "-m", "ours"]);
    let head = String::from_utf8_lossy(&fixture.git(repo, &["rev-parse", "HEAD"]))
        .trim_end()
        .to_owned();
    (head, other)
}

#[cfg(unix)]
#[tokio::test]
async fn parent_replacement_with_symlink_refuses_resolution_and_take_side() {
    use std::os::unix::fs::symlink;

    // Case 1: write_resolution with parent replaced right before index update.
    let fixture = Fixture::new("g4-p1-2-parent-res");
    let repo = fixture.repository("repo");
    let outside = fixture.root.join("outside");
    std::fs::create_dir_all(&outside).expect("outside");
    let (head, other) = conflicting_file(&fixture, &repo, "sub/file.txt");
    let plain = ProcessCommands { fixture: &fixture };
    let root = repo.to_string_lossy().into_owned();
    start_merge(&plain, &root, &other, &head, "merge")
        .await
        .expect("start");
    let original = std::fs::read(repo.join("sub/file.txt")).expect("read");
    let revision = sha256_hex(&original);
    // Put identical bytes at outside/file.txt so only the symlink check distinguishes them!
    std::fs::write(outside.join("file.txt"), &original).expect("outside seed");
    let port = InterceptingCommands::before_any(
        ProcessCommands { fixture: &fixture },
        &["hash-object", "update-index", "add"],
        {
            let repo = repo.clone();
            let outside = outside.clone();
            move || {
                std::fs::remove_dir_all(repo.join("sub")).expect("rm sub");
                symlink(&outside, repo.join("sub")).expect("symlink");
            }
        },
    );
    let err = write_resolution(&port, &root, "sub/file.txt", "resolved\n", &revision)
        .await
        .expect_err("parent symlink must be refused");
    assert_eq!(err.code, GitErrorCode::HeadMoved);
    assert!(port.fired());
    assert_eq!(
        std::fs::read(outside.join("file.txt")).expect("outside untouched"),
        original
    );

    // Case 2: take_side with parent replaced right before checkout/update-index.
    let fixture2 = Fixture::new("g4-p1-2-parent-take");
    let repo2 = fixture2.repository("repo");
    let outside2 = fixture2.root.join("outside");
    std::fs::create_dir_all(&outside2).expect("outside");
    let (head2, other2) = conflicting_file(&fixture2, &repo2, "sub/file.txt");
    let plain2 = ProcessCommands { fixture: &fixture2 };
    let root2 = repo2.to_string_lossy().into_owned();
    start_merge(&plain2, &root2, &other2, &head2, "merge")
        .await
        .expect("start");
    let orig2 = std::fs::read(repo2.join("sub/file.txt")).expect("read");
    std::fs::write(outside2.join("file.txt"), &orig2).expect("outside seed");
    let port2 = InterceptingCommands::before_any(
        ProcessCommands { fixture: &fixture2 },
        &["checkout", "checkout-index", "update-index"],
        {
            let repo = repo2.clone();
            let outside = outside2.clone();
            move || {
                std::fs::remove_dir_all(repo.join("sub")).expect("rm sub");
                symlink(&outside, repo.join("sub")).expect("symlink");
            }
        },
    );
    let err2 = take_side(&port2, &root2, "sub/file.txt", "theirs")
        .await
        .expect_err("take_side parent symlink must be refused");
    assert_eq!(err2.code, GitErrorCode::HeadMoved);
    assert!(port2.fired());
    assert_eq!(
        std::fs::read(outside2.join("file.txt")).expect("outside untouched"),
        orig2
    );
}

#[tokio::test]
async fn same_stage_mode_or_oid_change_is_refused_without_erasing_concurrent_index_update() {
    let fixture = Fixture::new("g4-p1-2-same-stage");
    let repo = fixture.repository("repo");
    let (head, other) = conflicting_file(&fixture, &repo, "file.txt");
    let plain = ProcessCommands { fixture: &fixture };
    let root = repo.to_string_lossy().into_owned();
    start_merge(&plain, &root, &other, &head, "merge")
        .await
        .expect("start");
    let revision = sha256_hex(&std::fs::read(repo.join("file.txt")).expect("read"));
    let alt_oid = String::from_utf8_lossy(
        &fixture
            .command(&repo, &[])
            .args(["hash-object", "-w", "--stdin"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                if let Some(mut stdin) = child.stdin.take() {
                    stdin.write_all(b"concurrent stage 3 blob\n")?;
                }
                child.wait_with_output()
            })
            .expect("hash-object")
            .stdout,
    )
    .trim()
    .to_owned();
    std::fs::write(repo.join("concurrent.txt"), "kept\n").expect("concurrent");

    // Mutate stage 3's mode (100644 -> 100755) and oid while keeping stages [1, 2, 3],
    // AND stage another file `concurrent.txt` right before the index write!
    let port = InterceptingCommands::before_any(
        ProcessCommands { fixture: &fixture },
        &["update-index", "add"],
        {
            let repo = repo.clone();
            let alt_oid = alt_oid.clone();
            move || {
                let mut child = std::process::Command::new("git")
                    .current_dir(&repo)
                    .args(["update-index", "-z", "--index-info"])
                    .stdin(std::process::Stdio::piped())
                    .spawn()
                    .expect("update-index");
                {
                    use std::io::Write;
                    let stdin = child.stdin.as_mut().expect("stdin");
                    stdin
                        .write_all(format!("100755 {alt_oid} 3\tfile.txt\0").as_bytes())
                        .expect("write");
                }
                assert!(child.wait().expect("wait").success());
                assert!(
                    std::process::Command::new("git")
                        .current_dir(&repo)
                        .args(["add", "concurrent.txt"])
                        .status()
                        .expect("add")
                        .success()
                );
            }
        },
    );
    let err = write_resolution(&port, &root, "file.txt", "resolved\n", &revision)
        .await
        .expect_err("same-stage mode/oid change must be refused");
    assert_eq!(err.code, GitErrorCode::HeadMoved);
    assert!(port.fired());
    // Concurrent updates MUST remain intact (no two-command rollback erasing them!).
    let entries = crate::writes::bind::index_entries(&plain, &root, "file.txt")
        .await
        .expect("entries");
    assert!(
        entries
            .iter()
            .any(|e| e.stage == 3 && e.mode == "100755" && e.oid == alt_oid),
        "concurrent stage 3 change was lost: {entries:?}"
    );
    let concurrent = crate::writes::bind::index_entries(&plain, &root, "concurrent.txt")
        .await
        .expect("concurrent");
    assert_eq!(concurrent.len(), 1);
}

#[tokio::test]
async fn save_right_before_take_side_checkout_preserves_save_and_conflict() {
    let fixture = Fixture::new("g4-p1-2-save-before-checkout");
    let repo = fixture.repository("repo");
    let (head, other) = conflicting_file(&fixture, &repo, "file.txt");
    let plain = ProcessCommands { fixture: &fixture };
    let root = repo.to_string_lossy().into_owned();
    start_merge(&plain, &root, &other, &head, "merge")
        .await
        .expect("start");
    let port = InterceptingCommands::before_any(
        ProcessCommands { fixture: &fixture },
        &["checkout", "checkout-index"],
        {
            let repo = repo.clone();
            move || {
                std::fs::write(repo.join("file.txt"), "saved before checkout\n").expect("save");
            }
        },
    );
    let err = take_side(&port, &root, "file.txt", "theirs")
        .await
        .expect_err("save before checkout must be refused");
    assert_eq!(err.code, GitErrorCode::HeadMoved);
    assert!(port.fired());
    assert_eq!(
        std::fs::read_to_string(repo.join("file.txt")).expect("read"),
        "saved before checkout\n"
    );
    let status = crate::reads::status::status(&plain, &root, &[])
        .await
        .expect("status");
    assert_eq!(status.conflicted.len(), 1);
}

#[tokio::test]
async fn save_right_before_take_side_removal_preserves_save_and_conflict() {
    let fixture = Fixture::new("g4-p1-2-save-before-rm");
    let repo = fixture.repository("repo");
    std::fs::write(repo.join("file.txt"), "base\n").expect("base");
    fixture.git(&repo, &["add", "file.txt"]);
    fixture.git(&repo, &["commit", "--quiet", "-m", "base"]);
    fixture.git(&repo, &["checkout", "--quiet", "-b", "other"]);
    fixture.git(&repo, &["rm", "--quiet", "file.txt"]);
    fixture.git(&repo, &["commit", "--quiet", "-m", "delete"]);
    let other = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
        .trim_end()
        .to_owned();
    fixture.git(&repo, &["checkout", "--quiet", "main"]);
    std::fs::write(repo.join("file.txt"), "ours modified\n").expect("ours");
    fixture.git(&repo, &["commit", "--quiet", "-am", "ours"]);
    let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
        .trim_end()
        .to_owned();

    let plain = ProcessCommands { fixture: &fixture };
    let root = repo.to_string_lossy().into_owned();
    start_merge(&plain, &root, &other, &head, "merge")
        .await
        .expect("start");
    let port = InterceptingCommands::before_any(
        ProcessCommands { fixture: &fixture },
        &["rm", "update-index"],
        {
            let repo = repo.clone();
            move || {
                std::fs::write(repo.join("file.txt"), "saved before removal\n").expect("save");
            }
        },
    );
    let err = take_side(&port, &root, "file.txt", "theirs")
        .await
        .expect_err("save before removal must be refused");
    assert_eq!(err.code, GitErrorCode::HeadMoved);
    assert!(port.fired());
    assert_eq!(
        std::fs::read_to_string(repo.join("file.txt")).expect("kept"),
        "saved before removal\n"
    );
    let status = crate::reads::status::status(&plain, &root, &[])
        .await
        .expect("status");
    assert_eq!(status.conflicted.len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn newline_filename_resolves_and_takes_side_without_breaking_framing() {
    let rel = "line1\nline2.txt";

    // write_resolution on newline filename
    let fixture = Fixture::new("g4-p1-2-newline-res");
    let repo = fixture.repository("repo");
    let (head, other) = conflicting_file(&fixture, &repo, rel);
    let port = ProcessCommands { fixture: &fixture };
    let root = repo.to_string_lossy().into_owned();
    start_merge(&port, &root, &other, &head, "merge")
        .await
        .expect("start");
    let revision = sha256_hex(&std::fs::read(repo.join(rel)).expect("read"));
    assert!(
        write_resolution(&port, &root, rel, "resolved newline\n", &revision)
            .await
            .expect("resolve newline")
    );
    let entries = crate::writes::bind::index_entries(&port, &root, rel)
        .await
        .expect("entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].stage, 0);

    // take_side on newline filename
    let fixture2 = Fixture::new("g4-p1-2-newline-take");
    let repo2 = fixture2.repository("repo");
    let (head2, other2) = conflicting_file(&fixture2, &repo2, rel);
    let port2 = ProcessCommands { fixture: &fixture2 };
    let root2 = repo2.to_string_lossy().into_owned();
    start_merge(&port2, &root2, &other2, &head2, "merge")
        .await
        .expect("start");
    take_side(&port2, &root2, rel, "theirs")
        .await
        .expect("take newline");
    assert_eq!(
        std::fs::read_to_string(repo2.join(rel)).expect("read"),
        "theirs line\n"
    );
    let entries2 = crate::writes::bind::index_entries(&port2, &root2, rel)
        .await
        .expect("entries");
    assert_eq!(entries2.len(), 1);
    assert_eq!(entries2[0].stage, 0);
}

#[tokio::test]
async fn take_side_preserves_crlf_smudge_and_symlink_checkout_semantics() {
    // 1. CRLF checkout semantics
    let fixture = Fixture::new("g4-p2-take-crlf");
    let repo = fixture.repository("repo");
    std::fs::write(repo.join(".gitattributes"), "*.crlf text eol=crlf\n").expect("attrs");
    std::fs::write(repo.join("doc.crlf"), "base\r\n").expect("base");
    fixture.git(&repo, &["add", ".gitattributes", "doc.crlf"]);
    fixture.git(&repo, &["commit", "--quiet", "-m", "base"]);
    fixture.git(&repo, &["checkout", "--quiet", "-b", "other"]);
    std::fs::write(repo.join("doc.crlf"), "theirs crlf\r\n").expect("theirs");
    fixture.git(&repo, &["add", "doc.crlf"]);
    fixture.git(&repo, &["commit", "--quiet", "-m", "theirs"]);
    let other = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
        .trim_end()
        .to_owned();
    fixture.git(&repo, &["checkout", "--quiet", "main"]);
    std::fs::write(repo.join("doc.crlf"), "ours crlf\r\n").expect("ours");
    fixture.git(&repo, &["add", "doc.crlf"]);
    fixture.git(&repo, &["commit", "--quiet", "-m", "ours"]);
    let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
        .trim_end()
        .to_owned();
    let port = ProcessCommands { fixture: &fixture };
    let root = repo.to_string_lossy().into_owned();
    start_merge(&port, &root, &other, &head, "merge")
        .await
        .expect("start");
    take_side(&port, &root, "doc.crlf", "theirs")
        .await
        .expect("take crlf");
    assert_eq!(
        std::fs::read(repo.join("doc.crlf")).expect("bytes"),
        b"theirs crlf\r\n"
    );
    let status = crate::reads::status::status(&port, &root, &[])
        .await
        .expect("status");
    assert!(status.conflicted.is_empty());
    assert!(status.unstaged.is_empty());

    // 2. Smudge / clean filter checkout semantics
    #[cfg(unix)]
    {
        let fixture = Fixture::new("g4-p2-take-smudge");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "filter.demo.clean", "sed s/SMUDGED:/CLEAN:/g"]);
        fixture.git(&repo, &["config", "filter.demo.smudge", "sed s/CLEAN:/SMUDGED:/g"]);
        std::fs::write(repo.join(".gitattributes"), "*.flt filter=demo\n").expect("attrs");
        std::fs::write(repo.join("item.flt"), "SMUDGED:base\n").expect("base");
        fixture.git(&repo, &["add", ".gitattributes", "item.flt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "base"]);
        fixture.git(&repo, &["checkout", "--quiet", "-b", "other"]);
        std::fs::write(repo.join("item.flt"), "SMUDGED:theirs\n").expect("theirs");
        fixture.git(&repo, &["add", "item.flt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "theirs"]);
        let other = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join("item.flt"), "SMUDGED:ours\n").expect("ours");
        fixture.git(&repo, &["add", "item.flt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "ours"]);
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        start_merge(&port, &root, &other, &head, "merge")
            .await
            .expect("start");
        take_side(&port, &root, "item.flt", "theirs")
            .await
            .expect("take smudge");
        assert_eq!(
            std::fs::read_to_string(repo.join("item.flt")).expect("smudged"),
            "SMUDGED:theirs\n"
        );
        let staged_blob =
            String::from_utf8_lossy(&fixture.git(&repo, &["show", ":0:item.flt"])).into_owned();
        assert_eq!(staged_blob, "CLEAN:theirs\n");
        let status = crate::reads::status::status(&port, &root, &[])
            .await
            .expect("status");
        assert!(status.conflicted.is_empty());
        assert!(status.unstaged.is_empty());
    }

    // 3. Symlink checkout semantics (including dangling symlink)
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new("g4-p2-take-symlink");
        let repo = fixture.repository("repo");
        symlink("target/base", repo.join("link.sym")).expect("base sym");
        fixture.git(&repo, &["add", "link.sym"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "base"]);
        fixture.git(&repo, &["checkout", "--quiet", "-b", "other"]);
        std::fs::remove_file(repo.join("link.sym")).expect("rm");
        symlink("dangling/theirs", repo.join("link.sym")).expect("theirs sym");
        fixture.git(&repo, &["add", "link.sym"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "theirs"]);
        let other = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        std::fs::remove_file(repo.join("link.sym")).expect("rm");
        symlink("dangling/ours", repo.join("link.sym")).expect("ours sym");
        fixture.git(&repo, &["add", "link.sym"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "ours"]);
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        start_merge(&port, &root, &other, &head, "merge")
            .await
            .expect("start");
        take_side(&port, &root, "link.sym", "theirs")
            .await
            .expect("take symlink");
        assert!(
            std::fs::symlink_metadata(repo.join("link.sym"))
                .expect("lstat")
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_link(repo.join("link.sym")).expect("readlink"),
            Path::new("dangling/theirs")
        );
        let entries = crate::writes::bind::index_entries(&port, &root, "link.sym")
            .await
            .expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].mode, "120000");
        assert_eq!(entries[0].stage, 0);
    }
}
