// SPDX-License-Identifier: Apache-2.0
//! The install's cases: both tarballs downloaded, checked and unpacked into one atomic install;
//! the scrcpy server's checksum and deadline; and every refusal that leaves nothing behind.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};

use super::super::scrcpy::jar::{ScrcpyRelease, digest_sha256_hex};
use super::install::*;
use super::*;

fn tarball(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut decoder = Vec::new();
    {
        let encoder = flate2::write::GzEncoder::new(&mut decoder, flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (path, bytes) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *bytes).expect("tar");
        }
        builder.finish().expect("finish");
    }
    decoder
}

fn hints() -> Hints {
    Hints::load().expect("catalog tool words")
}

fn integrity(bytes: &[u8]) -> String {
    digest_sha512_base64(bytes)
}

/// A local HTTP server that answers each route by request path and counts requests.
fn server(
    routes: Vec<(&'static str, Vec<u8>)>,
) -> (
    String,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    JoinHandle<()>,
) {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("addr");
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let handle = thread::spawn(move || {
        for _ in 0..routes.len() {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            seen.fetch_add(1, Ordering::SeqCst);
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                request.push_str(&line);
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let path = request.split_whitespace().nth(1).unwrap_or("/");
            let body = routes
                .iter()
                .find(|(route, _)| *route == path)
                .map(|(_, body)| body.clone());
            let mut stream = stream;
            let (status, body) = match body {
                Some(body) => ("200 OK", body),
                None => ("404 Not Found", Vec::new()),
            };
            let head = format!(
                "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    (format!("http://{address}"), count, handle)
}

/// A port nothing listens on: a download that reached it would fail.
fn dead_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("addr");
    drop(listener);
    format!("http://{address}")
}

/// A server that accepts and never answers, for a deadline test. It gives up after two
/// seconds when the client never connects, so the test's join cannot hang.
fn hanging_server() -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    listener.set_nonblocking(true).expect("nonblocking");
    let address = listener.local_addr().expect("addr");
    let handle = thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((_stream, _)) => {
                    thread::sleep(std::time::Duration::from_millis(200));
                    return;
                }
                Err(_) => thread::sleep(std::time::Duration::from_millis(10)),
            }
        }
    });
    (format!("http://{address}"), handle)
}

fn request(directory: &Path, artifacts: Artifacts) -> InstallRequest {
    InstallRequest {
        directory: directory.to_string_lossy().into_owned(),
        node: "/bin/node".to_string(),
        serve_sim: true,
        scrcpy: false,
        artifacts: Some(artifacts),
        scrcpy_release: None,
        id: "test".to_string(),
        timeout_ms: None,
        scrcpy_server: None,
    }
}

fn pinned(base: &str, serve_sim: &[u8], ws: &[u8]) -> Artifacts {
    Artifacts {
        serve_sim: Artifact {
            name: "serve-sim".to_string(),
            version: PINNED_SERVE_SIM.to_string(),
            url: format!("{base}/serve-sim.tgz"),
            integrity: integrity(serve_sim),
        },
        ws: Artifact {
            name: "ws".to_string(),
            version: "8.22.0".to_string(),
            url: format!("{base}/ws.tgz"),
            integrity: integrity(ws),
        },
    }
}

fn scratch(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("ace-serve-sim-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("scratch");
    path
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

#[test]
fn the_pinned_tarballs_are_downloaded_checked_and_unpacked_into_one_atomic_install() {
    let root = scratch("install");
    let serve_sim = tarball(&[
        ("package/dist/serve-sim.js", b"script"),
        ("package/package.json", b"{}"),
    ]);
    let ws = tarball(&[("package/index.js", b"ws")]);
    let (base, count, handle) = server(vec![
        ("/serve-sim.tgz", serve_sim.clone()),
        ("/ws.tgz", ws.clone()),
    ]);
    let artifacts = pinned(&base, &serve_sim, &ws);
    let installed = block_on(install(request(&root, artifacts.clone()))).expect("install");
    let command = installed.serve_sim.expect("serve-sim");
    let script = PathBuf::from(&command.args[0]);
    assert!(script.is_file());
    assert!(script.ends_with("dist/serve-sim.js"));
    assert!(script.starts_with(&root));
    let installed_root = install_directory(&root.to_string_lossy(), &artifacts);
    assert!(installed_root.join("node_modules/ws/index.js").is_file());
    handle.join().expect("server");
    assert_eq!(count.load(Ordering::SeqCst), 2);
    // A second install is reused: the server gets no third request.
    let (_idle, idle_count, idle_handle) = server(Vec::new());
    let again = block_on(install(request(&root, artifacts))).expect("reuse");
    assert_eq!(again.serve_sim.expect("serve-sim").args, command.args);
    idle_handle.join().expect("idle server");
    assert_eq!(idle_count.load(Ordering::SeqCst), 0);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_checksum_mismatch_leaves_no_install_behind() {
    let root = scratch("checksum");
    let serve_sim = tarball(&[("package/dist/serve-sim.js", b"script")]);
    let ws = tarball(&[("package/index.js", b"ws")]);
    let (base, _count, handle) = server(vec![
        ("/serve-sim.tgz", serve_sim.clone()),
        ("/ws.tgz", ws.clone()),
    ]);
    let mut artifacts = pinned(&base, &serve_sim, &ws);
    artifacts.serve_sim.integrity = "sha512-AAAA".to_string();
    let error = block_on(install(request(&root, artifacts.clone()))).expect_err("checksum");
    let message = error.to_string();
    assert!(message.contains("failed its checksum"), "{message}");
    assert!(!install_directory(&root.to_string_lossy(), &artifacts).exists());
    handle.join().expect("server");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_scrcpy_server_that_fails_its_checksum_is_never_written_by_the_install() {
    let root = scratch("scrcpy-checksum");
    let bytes = b"server";
    let release = ScrcpyRelease {
        version: "9.9.9".to_string(),
        bytes: bytes.len() as u64,
        sha256: digest_sha256_hex(b"a different server"),
        url: format!("{}/scrcpy", dead_url()),
    };
    let cancel = AtomicBool::new(false);
    let error = install_scrcpy(
        &hints(),
        &request(&root, artifacts()),
        &release,
        bytes,
        &cancel,
    )
    .expect_err("checksum");
    assert!(error.to_string().contains("failed its checksum"), "{error}");
    assert!(
        !root.join("scrcpy-server-v9.9.9").exists(),
        "nothing was published"
    );
    assert_eq!(
        fs::read_dir(&root).expect("reads").count(),
        0,
        "the install wrote no file at all"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_download_over_the_limit_is_refused_before_it_is_read_in_full() {
    let root = scratch("limit");
    let (base, _count, handle) = server(vec![("/scrcpy", b"0123456789".to_vec())]);
    let release = ScrcpyRelease {
        version: "9.9.9".to_string(),
        bytes: 4,
        sha256: digest_sha256_hex(b"0123456789"),
        url: format!("{base}/scrcpy"),
    };
    let mut asked = request(&root, artifacts());
    asked.serve_sim = false;
    asked.scrcpy = true;
    asked.scrcpy_release = Some(release);
    let error = block_on(install(asked)).expect_err("too large");
    assert!(error.to_string().contains("too large"), "{error}");
    handle.join().expect("server");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_verified_scrcpy_server_is_reused_and_a_wrong_explicit_one_is_refused() {
    let root = scratch("scrcpy");
    let bytes = b"server";
    let release = ScrcpyRelease {
        version: "9.9.9".to_string(),
        bytes: bytes.len() as u64,
        sha256: digest_sha256_hex(bytes),
        url: "http://127.0.0.1:1/never".to_string(),
    };
    let path = root.join("scrcpy-server-v9.9.9");
    fs::write(&path, bytes).expect("jar");
    let mut asked = request(&root, artifacts());
    asked.serve_sim = false;
    asked.scrcpy = true;
    asked.scrcpy_release = Some(release.clone());
    let installed = block_on(install(asked)).expect("installed");
    assert_eq!(
        installed.scrcpy.as_deref(),
        Some(path.to_string_lossy().as_ref())
    );

    let explicit = root.join("explicit-server");
    fs::write(&explicit, b"other").expect("explicit");
    let mut refused = request(&root, artifacts());
    refused.serve_sim = false;
    refused.scrcpy = true;
    refused.scrcpy_release = Some(release);
    refused.scrcpy_server = Some(explicit.to_string_lossy().into_owned());
    let error = block_on(install(refused)).expect_err("wrong explicit");
    assert!(
        error.to_string().contains("is not scrcpy-server v9.9.9"),
        "{error}"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_empty_override_counts_as_unset_and_leaves_the_downloaded_copy() {
    let root = scratch("override-empty");
    let bytes = b"server";
    let release = ScrcpyRelease {
        version: "9.9.9".to_string(),
        bytes: bytes.len() as u64,
        sha256: digest_sha256_hex(bytes),
        url: format!("{}/scrcpy", dead_url()),
    };
    fs::write(root.join("scrcpy-server-v9.9.9"), bytes).expect("jar");
    let mut asked = request(&root, artifacts());
    asked.serve_sim = false;
    asked.scrcpy = true;
    asked.scrcpy_release = Some(release);
    asked.scrcpy_server = Some(String::new());
    let installed = block_on(install(asked)).expect("unset");
    assert_eq!(
        installed.scrcpy.as_deref(),
        Some(root.join("scrcpy-server-v9.9.9").to_string_lossy().as_ref())
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_verified_override_is_used_without_any_request() {
    let root = scratch("override");
    let bytes = b"override";
    let path = root.join("custom-server");
    fs::write(&path, bytes).expect("override");
    let release = ScrcpyRelease {
        version: "9.9.9".to_string(),
        bytes: bytes.len() as u64,
        sha256: digest_sha256_hex(bytes),
        url: format!("{}/scrcpy", dead_url()),
    };
    let mut asked = request(&root, artifacts());
    asked.serve_sim = false;
    asked.scrcpy = true;
    asked.scrcpy_release = Some(release);
    asked.scrcpy_server = Some(path.to_string_lossy().into_owned());
    let installed = block_on(install(asked)).expect("override");
    assert_eq!(
        installed.scrcpy.as_deref(),
        Some(path.to_string_lossy().as_ref())
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_wrong_override_is_refused_with_the_shells_message_without_a_request() {
    let root = scratch("override-bad");
    let path = root.join("custom-server");
    fs::write(&path, b"other").expect("override");
    let release = ScrcpyRelease {
        version: "9.9.9".to_string(),
        bytes: 7,
        sha256: digest_sha256_hex(b"override"),
        url: format!("{}/scrcpy", dead_url()),
    };
    let mut asked = request(&root, artifacts());
    asked.serve_sim = false;
    asked.scrcpy = true;
    asked.scrcpy_release = Some(release);
    asked.scrcpy_server = Some(path.to_string_lossy().into_owned());
    let error = block_on(install(asked)).expect_err("wrong override");
    assert!(
        error
            .to_string()
            .contains("ACE_SCRCPY_SERVER is not scrcpy-server v9.9.9"),
        "{error}"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_cancelled_install_does_not_publish_its_unpacked_copy() {
    let root = scratch("cancelled");
    let artifacts = artifacts();
    let asked = request(&root, artifacts.clone());
    let cancel = AtomicBool::new(true);
    let serve_sim = tarball(&[("package/dist/serve-sim.js", b"script")]);
    let ws = tarball(&[("package/index.js", b"ws")]);
    let error = install_serve_sim(&hints(), &asked, &artifacts, serve_sim, ws, &cancel)
        .expect_err("cancelled");
    assert!(error.to_string().contains("took too long"), "{error}");
    assert!(!install_directory(&root.to_string_lossy(), &artifacts).exists());
    assert!(!root.join(".serve-sim-test.partial").exists());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_timed_out_install_publishes_nothing() {
    let root = scratch("timeout");
    let (base, handle) = hanging_server();
    let serve_sim = tarball(&[("package/dist/serve-sim.js", b"script")]);
    let ws = tarball(&[("package/index.js", b"ws")]);
    let artifacts = pinned(&base, &serve_sim, &ws);
    let mut asked = request(&root, artifacts.clone());
    asked.timeout_ms = Some(30);
    let error = block_on(install(asked)).expect_err("timeout");
    assert!(error.to_string().starts_with("timeout:"), "{error}");
    assert!(!install_directory(&root.to_string_lossy(), &artifacts).exists());
    handle.join().expect("server");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_install_uses_the_id_the_shell_named_for_its_staging_directory() {
    let root = scratch("id");
    let artifacts = artifacts();
    let mut asked = request(&root, artifacts.clone());
    asked.id = "from-the-shell".to_string();
    let cancel = AtomicBool::new(true);
    let serve_sim = tarball(&[("package/dist/serve-sim.js", b"script")]);
    let ws = tarball(&[("package/index.js", b"ws")]);
    // Pre-create both names: the run may remove only the staging directory it was given.
    fs::create_dir_all(root.join(".serve-sim-from-the-shell.partial")).expect("staging");
    fs::write(
        root.join(".serve-sim-from-the-shell.partial/sentinel"),
        b"x",
    )
    .expect("sentinel");
    fs::create_dir_all(root.join(".serve-sim-other.partial")).expect("other");
    fs::write(root.join(".serve-sim-other.partial/sentinel"), b"x").expect("other sentinel");
    let _ = install_serve_sim(&hints(), &asked, &artifacts, serve_sim, ws, &cancel);
    assert!(!root.join(".serve-sim-from-the-shell.partial").exists());
    assert!(root.join(".serve-sim-other.partial/sentinel").is_file());
    let _ = fs::remove_dir_all(&root);
}
