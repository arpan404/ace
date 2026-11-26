// SPDX-License-Identifier: Apache-2.0
//! Shared by the program tests: the real `ace-daemon` binary on a brand-new,
//! empty home.
//!
//! Two test binaries include this module, so each sees the other's helpers as
//! unused.

#![allow(dead_code)]
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
pub struct Home {
    root: PathBuf,
    home: PathBuf,
    pub ace_home: PathBuf,
    stub_path: PathBuf,
}

impl Home {
    pub fn new(name: &str) -> Self {
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
    pub fn start(&self, json: bool) -> Daemon {
        self.start_with(json, &[])
    }

    /// The same, with extra environment pairs (and the system PATH after the stub
    /// directory, for OpenSSL).
    pub fn start_with(&self, json: bool, extra: &[(&str, &str)]) -> Daemon {
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

    pub fn endpoint(&self) -> String {
        std::fs::read_to_string(self.ace_home.join("daemon-endpoint")).unwrap_or_default()
    }

    pub fn token(&self) -> String {
        std::fs::read_to_string(self.ace_home.join("daemon-token")).unwrap_or_default()
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The running child; killed if a test panics before it stops.
pub struct Daemon {
    pub child: Option<Child>,
    /// What the child wrote, read so far (a test's diagnostics).
    output: String,
    /// Where its output files live.
    root: PathBuf,
}

impl Daemon {
    /// Wait until the endpoint file names a listening daemon.
    pub fn ready(&mut self, home: &Home) -> String {
        let deadline = Instant::now() + Duration::from_secs(90);
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

    pub fn exited(&mut self) -> Option<ExitStatus> {
        self.child
            .as_mut()
            .and_then(|child| child.try_wait().unwrap_or_default())
    }

    /// Ask the daemon to stop with SIGTERM, as a login service or `ace stop`
    /// does, and wait for its exit.
    pub fn terminate(&mut self) -> ExitStatus {
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

    pub fn wait(&mut self, timeout: Duration) -> ExitStatus {
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

    pub fn output(&mut self) -> String {
        self.capture();
        self.output.clone()
    }

    /// The `serve --json` object the child printed before its first newline.
    pub fn started(&mut self) -> serde_json::Value {
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
pub fn request(endpoint: &str, method: &str, path: &str, token: &str, body: &str) -> (u16, String) {
    request_headers(endpoint, method, path, token, body, &[])
}

/// The same, with extra request headers (an Origin, a JSON content type).
pub fn request_headers(
    endpoint: &str,
    method: &str,
    path: &str,
    token: &str,
    body: &str,
    extra: &[(&str, &str)],
) -> (u16, String) {
    let text = exchange_headers(endpoint, method, path, token, body, extra);
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = text.split_once("\r\n\r\n").map(|(_, body)| body.to_owned());
    (status, body.unwrap_or_default())
}

/// The whole response, headers included, for a CORS or header assertion.
pub fn exchange_headers(
    endpoint: &str,
    method: &str,
    path: &str,
    token: &str,
    body: &str,
    extra: &[(&str, &str)],
) -> String {
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
    let extra: String = extra
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
        body.len()
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return String::new();
    }
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    String::from_utf8_lossy(&response).into_owned()
}

pub fn token_is_64_hex(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
