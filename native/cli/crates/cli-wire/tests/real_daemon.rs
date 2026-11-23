// SPDX-License-Identifier: Apache-2.0
//! Real-daemon integration test, ignored by default.
//!
//! Spawns an isolated ace daemon on an EMPTY temporary `ACE_HOME` with `HOME` pointed at a
//! separate empty temporary directory and a minimal `PATH` (`<bun-dir>:/usr/bin:/bin`).
//! Never touches `~/.ace` and never copies it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use cli_wire::{
    ConnectConfig, Connection, Home, HttpMethod, TcpProbe, WireError, http_request_local,
    reach_local,
};
use serde::Serialize;

struct IsolatedDaemon {
    child: Child,
    root: PathBuf,
}

impl Drop for IsolatedDaemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Serialize)]
struct CapabilitiesOp {
    op: &'static str,
}

fn find_bun() -> PathBuf {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join("bun");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let fallback = PathBuf::from(home).join(".bun/bin/bun");
        if fallback.is_file() {
            return fallback;
        }
    }
    PathBuf::from("bun")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .expect("cli-wire crate must live at native/cli/crates/cli-wire")
        .to_path_buf()
}

fn resolve_daemon_launch(repo: &Path) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    if let (Ok(runtime), Ok(entry)) = (
        std::env::var("ACE_TEST_DAEMON_RUNTIME"),
        std::env::var("ACE_TEST_DAEMON_ENTRY"),
    ) {
        return Ok((
            PathBuf::from(runtime),
            PathBuf::from(entry),
            repo.to_path_buf(),
        ));
    }
    if repo.join("node_modules").is_dir() {
        return Ok((
            find_bun(),
            repo.join("apps/daemon/src/cli.ts"),
            repo.to_path_buf(),
        ));
    }
    let bundled_runtime =
        PathBuf::from("/Applications/ace.app/Contents/Resources/runtime/bin/node");
    let bundled_entry = PathBuf::from("/Applications/ace.app/Contents/Resources/daemon/ace.mjs");
    if bundled_runtime.is_file() && bundled_entry.is_file() {
        return Ok((bundled_runtime, bundled_entry, repo.to_path_buf()));
    }
    Err("No runnable daemon found: run `bun install` in the repo or set ACE_TEST_DAEMON_RUNTIME + ACE_TEST_DAEMON_ENTRY".into())
}

#[test]
#[ignore = "spawns a real ace daemon on an empty temporary ACE_HOME"]
fn talks_to_real_daemon_on_empty_isolated_home() -> Result<(), String> {
    let root =
        std::env::temp_dir().join(format!("ace-cli-wire-real-daemon-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let ace_home_dir = root.join("ace-home");
    let fake_home_dir = root.join("home");
    fs::create_dir_all(&ace_home_dir).unwrap();
    fs::create_dir_all(&fake_home_dir).unwrap();

    let repo = repo_root();
    let (runtime, daemon_entry, cwd) = resolve_daemon_launch(&repo)?;
    let runtime_dir = runtime
        .parent()
        .unwrap_or_else(|| Path::new("/usr/local/bin"));
    let minimal_path = format!("{}:/usr/bin:/bin", runtime_dir.display());

    let child = Command::new(&runtime)
        .arg(&daemon_entry)
        .arg("start")
        .current_dir(&cwd)
        .env_clear()
        .env("PATH", &minimal_path)
        .env("HOME", &fake_home_dir)
        .env("ACE_HOME", &ace_home_dir)
        .env("ACE_PORT", "0")
        .env("ACE_LOG_LEVEL", "error")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn isolated ace daemon");

    let mut guard = IsolatedDaemon { child, root };
    let home = Home::new(ace_home_dir);

    // Wait up to 15 s for the daemon to write daemon-endpoint & daemon-token and accept TCP.
    let deadline = Instant::now() + Duration::from_secs(15);
    let local = loop {
        if let Some(status) = guard.child.try_wait().unwrap() {
            let mut stderr = String::new();
            if let Some(mut err) = guard.child.stderr.take() {
                let _ = std::io::Read::read_to_string(&mut err, &mut stderr);
            }
            return Err(format!("isolated daemon exited early ({status}): {stderr}"));
        }
        match reach_local(&home, &TcpProbe) {
            Ok(local) => break local,
            Err(WireError::DaemonDown) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(err) => return Err(format!("reach_local failed unexpectedly: {err}")),
        }
    };

    // 1) Blocking HTTP/1.1 GET /v1/status
    let status = http_request_local(
        &local,
        HttpMethod::Get,
        "/v1/status",
        None,
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(status.status(), 200);
    let parsed: serde_json::Value = status.decode().unwrap();
    assert_eq!(parsed["running"], true);

    // 2) Blocking WebSocket handshake + ping + cli.request capabilities
    let mut conn = Connection::open_local(&local, &ConnectConfig::default()).unwrap();
    assert!(!conn.welcome().host_id.as_str().is_empty());
    assert_eq!(conn.welcome().protocol_version, 1);

    conn.ping().unwrap();
    let reply = conn
        .cli_request(&CapabilitiesOp { op: "capabilities" })
        .unwrap();
    assert!(reply.as_str().starts_with('{'));
    conn.close();

    // Drop terminates the isolated child daemon and deletes temp dirs.
    drop(guard);
    Ok(())
}
