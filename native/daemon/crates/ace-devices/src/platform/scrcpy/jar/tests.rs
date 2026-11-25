// SPDX-License-Identifier: Apache-2.0
//! The moved `scrcpy-jar.process.test.ts` cases: the explicit server, the verified copy, one
//! download reused, and the checksum, size and cancellation rules that leave no file behind.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use super::*;

fn unique() -> u64 {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    NEXT.fetch_add(1, Ordering::SeqCst) as u64
}

/// A temporary tools directory, removed when the test ends.
struct Directory(PathBuf);

impl Directory {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "ace-scrcpy-jar-{}-{name}-{}",
            std::process::id(),
            unique()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn entries(&self) -> Vec<String> {
        let mut names = fs::read_dir(&self.0)
            .expect("reads")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        names.sort();
        names
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn release_for(bytes: &[u8]) -> ScrcpyRelease {
    ScrcpyRelease {
        version: "9.9".to_string(),
        bytes: bytes.len() as u64,
        sha256: digest_sha256_hex(bytes),
        url: "https://example.invalid/scrcpy-server-v9.9".to_string(),
    }
}

/// A fetch that answers `body` and counts its calls.
fn fetch_once(
    body: Vec<u8>,
    calls: Arc<AtomicUsize>,
) -> impl FnOnce(&str, u64) -> std::future::Ready<Result<Vec<u8>, Error>> {
    move |_: &str, _: u64| {
        calls.fetch_add(1, Ordering::SeqCst);
        std::future::ready(Ok(body))
    }
}

#[test]
fn an_explicit_server_is_used_only_when_it_is_the_pinned_release() {
    let directory = Directory::new("explicit");
    let bytes = b"pinned scrcpy server bytes";
    let release = release_for(bytes);
    let server = directory.path().join("custom-server");
    fs::write(&server, bytes).expect("writes");
    assert_eq!(
        installed(None, Some(server.to_str().expect("path")), &release).expect("reads"),
        Some(server.clone())
    );
    let other = directory.path().join("other-server");
    fs::write(&other, b"another build").expect("writes");
    let error =
        installed(None, Some(other.to_str().expect("path")), &release).expect_err("refused");
    match error {
        Error::Failed(failure) => {
            assert_eq!(failure.code, Code::ToolMissing);
            assert_eq!(
                failure.message,
                "ACE_SCRCPY_SERVER is not scrcpy-server v9.9"
            );
            assert_eq!(failure.hint, words::tool_hint("scrcpyHint"));
        }
        other => panic!("unexpected error: {other}"),
    }
}

#[test]
fn the_installed_copy_is_the_verified_one_in_the_tools_directory() {
    let directory = Directory::new("installed");
    let release = release_for(b"pinned scrcpy server bytes");
    assert_eq!(
        installed(Some(directory.path()), None, &release).expect("reads"),
        None
    );
    assert_eq!(installed(None, None, &release).expect("reads"), None);
    fs::write(
        directory.path().join(server_name(&release)),
        b"pinned scrcpy server bytes",
    )
    .expect("writes");
    assert_eq!(
        installed(Some(directory.path()), None, &release).expect("reads"),
        Some(directory.path().join(server_name(&release)))
    );
}

#[tokio::test]
async fn a_download_is_verified_then_reused_without_the_network() {
    let directory = Directory::new("reuse");
    let bytes = b"pinned scrcpy server bytes".to_vec();
    let release = release_for(&bytes);
    let calls = Arc::new(AtomicUsize::new(0));
    let path = server_jar(
        Some(directory.path()),
        None,
        "a",
        &release,
        fetch_once(bytes.clone(), calls.clone()),
    )
    .await
    .expect("downloads");
    assert_eq!(path, directory.path().join(server_name(&release)));
    assert_eq!(fs::read(&path).expect("reads"), bytes);
    assert_eq!(directory.entries(), vec![server_name(&release)]);
    let path_again = server_jar(
        Some(directory.path()),
        None,
        "b",
        &release,
        |_: &str, _: u64| std::future::ready(Err(unavailable("should not fetch".to_string()))),
    )
    .await
    .expect("reuses");
    assert_eq!(path_again, path);
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the network was used once");
}

#[tokio::test]
async fn a_download_that_fails_its_checksum_is_refused_and_leaves_nothing_behind() {
    let directory = Directory::new("checksum");
    let release = release_for(b"pinned scrcpy server bytes");
    let error = server_jar(
        Some(directory.path()),
        None,
        "a",
        &release,
        |_: &str, _: u64| std::future::ready(Ok(b"pinned scrcpy server bytez".to_vec())),
    )
    .await
    .expect_err("refused");
    match error {
        Error::Failed(failure) => {
            assert_eq!(failure.code, Code::ToolMissing);
            assert_eq!(
                failure.message,
                "scrcpy-server download failed its checksum"
            );
        }
        other => panic!("unexpected error: {other}"),
    }
    assert_eq!(directory.entries(), Vec::<String>::new());
}

#[tokio::test]
async fn a_cancelled_download_leaves_nothing_behind() {
    let directory = Directory::new("cancelled");
    let release = release_for(b"pinned scrcpy server bytes");
    let stopped = tokio::time::timeout(
        Duration::from_millis(20),
        server_jar(
            Some(directory.path()),
            None,
            "a",
            &release,
            |_: &str, _: u64| std::future::pending(),
        ),
    )
    .await;
    assert!(stopped.is_err(), "the download never finished");
    assert_eq!(directory.entries(), Vec::<String>::new());
}

#[tokio::test]
async fn a_download_over_the_pinned_size_is_refused_before_anything_is_written() {
    let directory = Directory::new("size");
    let release = release_for(b"pinned scrcpy server bytes");
    let error = server_jar(
        Some(directory.path()),
        None,
        "a",
        &release,
        |_: &str, _: u64| std::future::ready(Ok(vec![7; release.bytes as usize + 1])),
    )
    .await
    .expect_err("refused");
    match error {
        Error::Failed(failure) => {
            assert_eq!(failure.message, "scrcpy-server download is too large");
        }
        other => panic!("unexpected error: {other}"),
    }
    assert_eq!(directory.entries(), Vec::<String>::new());
}

#[tokio::test]
async fn no_directory_is_refused_with_todays_text() {
    let release = release_for(b"pinned scrcpy server bytes");
    let error = server_jar(None, None, "a", &release, |_: &str, _: u64| {
        std::future::ready(Ok(Vec::new()))
    })
    .await
    .expect_err("refused");
    match error {
        Error::Failed(failure) => {
            assert_eq!(failure.message, "No directory for the scrcpy server");
        }
        other => panic!("unexpected error: {other}"),
    }
}
