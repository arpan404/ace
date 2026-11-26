// SPDX-License-Identifier: Apache-2.0
//! The program test: the real `ace-daemon` binary on a brand-new, empty home.
//!
//! Every run uses a fresh temporary HOME and ACE_HOME (never `~/.ace` or a copy
//! of any real home), an empty stub directory first on PATH so no provider CLI is
//! reachable, and stops the daemon by signal or by `POST /v1/stop`.
//!
//! TypeScript cases ported: `apps/daemon/src/lifecycle.process.test.ts` ("a
//! daemon starts, listens, and stops in order", "a second start on the same home
//! exits lock-held"), `apps/daemon/src/cli-stop.process.test.ts` ("`ace stop`
//! prints the receipt and the process is gone"), `apps/daemon/src/cli-start.process.test.ts`
//! ("`ace start --json` prints the five keys"), `apps/daemon/src/local-files.test.ts`
//! ("the token and host id are kept across loads"), and
//! `apps/daemon/src/daemon-lock.process.test.ts` ("a daemon killed while holding
//! the home's lock leaves it free for the next start").

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// A fresh home pair and a stub PATH, removed when the test ends.
struct Home {
    root: PathBuf,
    home: PathBuf,
    ace_home: PathBuf,
    stub_path: PathBuf,
}

impl Home {
    fn new(name: &str) -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("ace-daemon-bin-{name}-{nonce}"));
        let home = root.join("home");
        let ace_home = root.join("ace-home");
        let stub_path = root.join("bin");
        for directory in [&home, &stub_path] {
            let _ = std::fs::create_dir_all(directory);
        }
        Self {
            root,
            home,
            ace_home,
            stub_path,
        }
    }

    /// Start the binary with this home, no inherited environment and no provider
    /// CLI on PATH. `json` prints `serve --json`'s object.
    fn start(&self, json: bool) -> Daemon {
        self.start_with(json, &[])
    }

    /// The same, with extra environment pairs (and the system PATH after the stub
    /// directory, for OpenSSL).
    fn start_with(&self, json: bool, extra: &[(&str, &str)]) -> Daemon {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ace-daemon"));
        if json {
            command.args(["serve", "--json"]);
        } else {
            command.arg("start");
        }
        command
            .env_clear()
            .env("HOME", &self.home)
            .env("ACE_HOME", &self.ace_home)
            .env("ACE_PORT", "0")
            .env("ACE_LISTEN", "local")
            .env("ACE_LOG_LEVEL", "info")
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.stub_path.display()),
            )
            .current_dir(&self.root);
        for (name, value) in extra {
            command.env(name, value);
        }
        command
            .stdin(Stdio::null())
            .stdout(self.output_file("stdout"))
            .stderr(self.output_file("stderr"));
        let child = command.spawn();
        match child {
            Ok(child) => Daemon {
                child: Some(child),
                output: String::new(),
                root: self.root.clone(),
            },
            Err(error) => panic!("the daemon binary starts: {error}"),
        }
    }

    /// A file the child writes to, so a test reads its output without waiting
    /// for the process to exit.
    fn output_file(&self, name: &str) -> Stdio {
        let path = self.root.join(format!("{name}.log"));
        match std::fs::File::create(&path) {
            Ok(file) => Stdio::from(file),
            Err(error) => panic!("{name} log: {error}"),
        }
    }

    fn endpoint(&self) -> String {
        std::fs::read_to_string(self.ace_home.join("daemon-endpoint")).unwrap_or_default()
    }

    fn token(&self) -> String {
        std::fs::read_to_string(self.ace_home.join("daemon-token")).unwrap_or_default()
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The running child; killed if a test panics before it stops.
struct Daemon {
    child: Option<Child>,
    /// What the child wrote, read so far (a test's diagnostics).
    output: String,
    /// Where its output files live.
    root: PathBuf,
}

impl Daemon {
    /// Wait until the endpoint file names a listening daemon.
    fn ready(&mut self, home: &Home) -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            let endpoint = home.endpoint();
            if endpoint.starts_with("http://127.0.0.1:") {
                return endpoint;
            }
            if let Some(status) = self.exited() {
                panic!(
                    "the daemon exited before ready: {status}\n{}",
                    self.output()
                );
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("the daemon did not write its endpoint");
    }

    fn exited(&mut self) -> Option<ExitStatus> {
        self.child
            .as_mut()
            .and_then(|child| child.try_wait().unwrap_or_default())
    }

    /// Ask the daemon to stop with SIGTERM, as a login service or `ace stop`
    /// does, and wait for its exit.
    fn terminate(&mut self) -> ExitStatus {
        let pid = self.child.as_ref().map(Child::id).unwrap_or(0);
        let killed = Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .or_else(|_| {
                Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .status()
            });
        assert!(killed.is_ok(), "SIGTERM reaches the daemon");
        self.wait(Duration::from_secs(15))
    }

    fn wait(&mut self, timeout: Duration) -> ExitStatus {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(status) = self.exited() {
                self.capture();
                self.child = None;
                return status;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("the daemon did not exit in time");
    }

    /// Read what the child has written so far, without waiting for its exit.
    fn capture(&mut self) {
        let mut text = String::new();
        for name in ["stdout.log", "stderr.log"] {
            text.push_str(&std::fs::read_to_string(self.root.join(name)).unwrap_or_default());
        }
        self.output = text;
    }

    fn output(&mut self) -> String {
        self.capture();
        self.output.clone()
    }

    /// The `serve --json` object the child printed before its first newline.
    fn started(&mut self) -> serde_json::Value {
        let output = self.output();
        let first = output.lines().next().unwrap_or_default().to_owned();
        serde_json::from_str(&first).unwrap_or(serde_json::Value::Null)
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// One HTTP exchange over the daemon's own listener, as the CLI makes it.
fn request(endpoint: &str, method: &str, path: &str, token: &str, body: &str) -> (u16, String) {
    let port = endpoint
        .trim_start_matches("http://127.0.0.1:")
        .trim_end_matches('/')
        .parse::<u16>()
        .unwrap_or(0);
    let mut stream = TcpStream::connect(("127.0.0.1", port));
    let Ok(stream) = &mut stream else {
        panic!("the daemon's listener accepts a connection");
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return (0, String::new());
    }
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = text.split_once("\r\n\r\n").map(|(_, body)| body.to_owned());
    (status, body.unwrap_or_default())
}

fn token_is_64_hex(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `cli-start.process.test.ts`: a fresh home starts, listens, and writes every
/// file the CLI reads; a second start is refused as lock-held; SIGTERM stops it in
/// order and leaves a stopped run marker.
#[test]
fn a_fresh_home_starts_listens_and_stops_in_order() {
    let home = Home::new("lifecycle");
    let mut daemon = home.start(true);
    let endpoint = daemon.ready(&home);

    // Every file a client or the CLI reads, with the same contents.
    let token = home.token();
    assert!(token_is_64_hex(&token), "the token is 64 hex characters");
    let host = std::fs::read_to_string(home.ace_home.join("host-id")).unwrap_or_default();
    assert!(!host.is_empty(), "the host id is written");
    assert!(home.ace_home.join("daemon-lock.sqlite").exists());
    let marker = std::fs::read_to_string(home.ace_home.join("ace-format.json")).unwrap_or_default();
    assert!(marker.contains("\"format\":\"ace-v1\""));
    let run = std::fs::read_to_string(home.ace_home.join("daemon-run.json")).unwrap_or_default();
    assert!(run.contains("\"state\":\"running\""));
    assert!(home.ace_home.join("events.sqlite").exists());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["daemon-token", "daemon-endpoint"] {
            let mode = std::fs::metadata(home.ace_home.join(name))
                .map(|meta| meta.permissions().mode())
                .unwrap_or(0);
            assert_eq!(mode & 0o777, 0o600, "{name} is private");
        }
    }

    let (status, body) = request(&endpoint, "GET", "/v1/status", &token, "");
    assert_eq!(status, 200, "status is answered: {body}");
    assert!(body.contains("\"running\":true"));
    let (unknown, body) = request(&endpoint, "GET", "/v1/nothing", &token, "");
    assert_eq!(unknown, 404);
    assert!(body.contains("Unknown endpoint"));
    let (unauthenticated, _) = request(&endpoint, "GET", "/v1/status", "", "");
    assert_eq!(unauthenticated, 403);

    // A second start on the same home refuses with the CLI's lock-held code (7).
    let mut second = home.start(false);
    let status = second.wait(Duration::from_secs(10));
    assert_eq!(status.code(), Some(7));
    assert!(second.output().contains("Another daemon owns it"));

    // SIGTERM: the endpoint goes, the run marker says stopped, and the exit is clean.
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0), "a signal stops the daemon cleanly");
    assert!(!home.ace_home.join("daemon-endpoint").exists());
    assert!(!home.ace_home.join("daemon-lock").exists());
    let run = std::fs::read_to_string(home.ace_home.join("daemon-run.json")).unwrap_or_default();
    assert!(run.contains("\"state\":\"stopped\""));
    assert!(run.contains("\"signal\":\"SIGTERM\""));
    let log = std::fs::read_to_string(home.ace_home.join("logs/ace.jsonl")).unwrap_or_default();
    assert!(log.contains("\"message\":\"Daemon stopping\""));
    assert!(log.contains("\"message\":\"Daemon listening\""));
}

/// `cli-stop.process.test.ts`: `POST /v1/stop` answers with a receipt, the receipt
/// leaves `pending`, and the process exits 0 with the endpoints retired.
#[test]
fn a_stop_request_is_answered_by_receipt_and_the_process_exits() {
    let home = Home::new("stop");
    let mut daemon = home.start(false);
    let endpoint = daemon.ready(&home);
    let token = home.token();
    let (status, body) = request(&endpoint, "POST", "/v1/stop", &token, "{}");
    assert_eq!(status, 200, "the stop is accepted: {body}");
    assert!(body.contains("\"stopping\":true"));
    assert!(body.contains("\"receiptId\":"));
    let status = daemon.wait(Duration::from_secs(15));
    assert_eq!(status.code(), Some(0));
    let receipt =
        std::fs::read_to_string(home.ace_home.join("daemon-shutdown.json")).unwrap_or_default();
    assert!(receipt.contains("\"state\":\"succeeded\""), "{receipt}");
    assert!(!home.ace_home.join("daemon-endpoint").exists());
    let run = std::fs::read_to_string(home.ace_home.join("daemon-run.json")).unwrap_or_default();
    assert!(run.contains("\"source\":\"stop-request\""));
    let log = std::fs::read_to_string(home.ace_home.join("logs/ace.jsonl")).unwrap_or_default();
    assert!(log.contains("\"source\":\"stop-request\""));
}

/// `daemon-lock.process.test.ts`: a daemon killed while holding the lock leaves it
/// free, and the next start opens the same home.
#[test]
fn a_killed_daemon_leaves_the_lock_free_for_the_next_start() {
    let home = Home::new("kill");
    let mut daemon = home.start(false);
    let _endpoint = daemon.ready(&home);
    if let Some(child) = &mut daemon.child {
        let _ = child.kill();
        let _ = child.wait();
    }
    daemon.child = None;
    // A crashed daemon leaves its endpoint file behind (it is retired only by an
    // orderly stop), so the next start's own write is what readiness waits for.
    let _ = std::fs::remove_file(home.ace_home.join("daemon-endpoint"));
    let mut next = home.start(false);
    let endpoint = next.ready(&home);
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    let status = next.terminate();
    let output = next.output();
    assert_eq!(status.code(), Some(0), "status {status:?}: {output}");
}

/// A fresh home asked for LAN remote access makes its pinned identity with
/// OpenSSL, starts the TLS listener, and publishes the URL and fingerprint the
/// launcher reads (`tls-identity.process.test.ts`, `network.test.ts`).
#[test]
fn a_lan_start_makes_its_identity_and_publishes_the_fingerprint() {
    let home = Home::new("lan");
    let mut daemon = home.start_with(true, &[("ACE_LISTEN", "lan"), ("ACE_REMOTE_PORT", "0")]);
    let _endpoint = daemon.ready(&home);
    let started = daemon.started();
    let remote = started.get("remoteUrl").and_then(serde_json::Value::as_str);
    let fingerprint = started
        .get("fingerprint")
        .and_then(serde_json::Value::as_str);
    let Some(remote) = remote else {
        panic!("a LAN start publishes a remote URL: {started}");
    };
    assert!(remote.starts_with("wss://"), "{remote}");
    assert!(
        fingerprint.is_some_and(|value| value.len() == 64),
        "the pinned fingerprint is published: {started}"
    );
    assert!(home.ace_home.join("tls/cert.pem").exists());
    assert!(home.ace_home.join("tls/key.pem").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(home.ace_home.join("tls/key.pem"))
            .map(|meta| meta.permissions().mode())
            .unwrap_or(0);
        assert_eq!(mode & 0o777, 0o600);
    }
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0), "{}", daemon.output());
}
