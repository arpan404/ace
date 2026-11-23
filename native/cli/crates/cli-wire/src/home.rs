// SPDX-License-Identifier: Apache-2.0
//! Ace home resolution, local daemon endpoint/token reading, and 1 s TCP liveness probe.
//!
//! Ports `packages/service/src/home-path.ts` (`resolveDaemonHome`) and
//! `apps/daemon/src/cli/daemon-endpoint.ts` (`hostConnection`, `tcpProbe`, `reachLocalDaemon`).

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::WireError;
use crate::types::{LocalOrigin, Token};

/// How long a local daemon has to accept a TCP connection before it counts as unknown (`1_000 ms`).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// Resolved ace data directory (`ACE_HOME` when set, otherwise `<HOME>/.ace`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Home(PathBuf);

impl Home {
    /// Wraps an already-resolved ace home path.
    #[must_use]
    pub const fn new(path: PathBuf) -> Self {
        Self(path)
    }

    /// Pure home resolution matching `resolveDaemonHome(home, requested)` in
    /// `packages/service/src/home-path.ts`.
    ///
    /// When `ace_home` is `Some`, uses it directly (resolving relative paths against `cwd`);
    /// otherwise uses `<user_home>/.ace`.
    #[must_use]
    pub fn resolve(user_home: &Path, ace_home: Option<&OsStr>, cwd: &Path) -> Self {
        if let Some(requested) = ace_home {
            let path = Path::new(requested);
            if path.is_absolute() {
                Self(path.to_path_buf())
            } else {
                Self(cwd.join(path))
            }
        } else {
            let base = if user_home.is_absolute() {
                user_home.to_path_buf()
            } else {
                cwd.join(user_home)
            };
            Self(base.join(".ace"))
        }
    }

    /// Resolves the ace home from process environment (`ACE_HOME`, else `HOME`/`USERPROFILE` + `.ace`).
    pub fn from_env() -> Result<Self, WireError> {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        if let Some(ace_home) = env::var_os("ACE_HOME") {
            return Ok(Self::resolve(
                Path::new(""),
                Some(ace_home.as_os_str()),
                &cwd,
            ));
        }
        let user_home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .filter(|v| !v.is_empty())
            .ok_or_else(|| WireError::InvalidTarget {
                detail: "Cannot determine ace home: neither ACE_HOME nor HOME is set".into(),
            })?;
        Ok(Self::resolve(Path::new(&user_home), None, &cwd))
    }

    /// Root directory of this ace home.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Path to `<home>/daemon-endpoint`.
    #[must_use]
    pub fn endpoint_path(&self) -> PathBuf {
        self.0.join("daemon-endpoint")
    }

    /// Path to `<home>/daemon-token`.
    #[must_use]
    pub fn token_path(&self) -> PathBuf {
        self.0.join("daemon-token")
    }
}

/// Validated local daemon endpoint and host bearer token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Local {
    origin: LocalOrigin,
    token: Token,
}

impl Local {
    /// Constructs a [`Local`] from already-validated parts.
    #[must_use]
    pub const fn new(origin: LocalOrigin, token: Token) -> Self {
        Self { origin, token }
    }

    /// Validated loopback HTTP origin (`http://127.0.0.1[:PORT][/]`).
    #[must_use]
    pub const fn origin(&self) -> &LocalOrigin {
        &self.origin
    }

    /// Validated 64-hex host token.
    #[must_use]
    pub const fn token(&self) -> &Token {
        &self.token
    }
}

/// What a TCP probe of the daemon's endpoint learned (`ProbeAnswer` in `daemon-endpoint.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeAnswer {
    /// Something accepted a TCP connection.
    Up,
    /// Connection was actively refused or reset: nothing listens there.
    Down,
    /// No answer in time or an ambiguous network error: a busy machine, not a stopped daemon.
    Unknown,
}

/// Abstraction over a bounded TCP liveness probe so [`reach_local`] is testable without sockets.
pub trait Probe {
    /// Probes `host:port` for at most `timeout`.
    fn probe(&self, host: &str, port: u16, timeout: Duration) -> ProbeAnswer;
}

/// Real blocking TCP probe matching `tcpProbe` in `apps/daemon/src/cli/daemon-endpoint.ts`.
#[derive(Debug, Default, Clone, Copy)]
pub struct TcpProbe;

impl Probe for TcpProbe {
    fn probe(&self, host: &str, port: u16, timeout: Duration) -> ProbeAnswer {
        let addr = if let Ok(ip) = host.parse::<IpAddr>() {
            SocketAddr::new(ip, port)
        } else {
            let Ok(mut addrs) = (host, port).to_socket_addrs() else {
                return ProbeAnswer::Unknown;
            };
            let Some(first) = addrs.next() else {
                return ProbeAnswer::Unknown;
            };
            first
        };
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                drop(stream);
                ProbeAnswer::Up
            }
            Err(err)
                if matches!(
                    err.kind(),
                    ErrorKind::ConnectionRefused | ErrorKind::ConnectionReset
                ) =>
            {
                ProbeAnswer::Down
            }
            Err(_) => ProbeAnswer::Unknown,
        }
    }
}

/// Reads and validates `<home>/daemon-endpoint` and `<home>/daemon-token`.
///
/// Mirrors `hostConnection(home)` in `apps/daemon/src/cli/daemon-endpoint.ts`.
pub fn host_connection(home: &Home) -> Result<Local, WireError> {
    let raw_origin = fs::read_to_string(home.endpoint_path()).map_err(|_| WireError::DaemonDown)?;
    let raw_token = fs::read_to_string(home.token_path()).map_err(|_| WireError::DaemonDown)?;
    parse_host_connection(&raw_origin, &raw_token)
}

/// Pure validation of the `daemon-endpoint` and `daemon-token` file contents.
pub fn parse_host_connection(raw_origin: &str, raw_token: &str) -> Result<Local, WireError> {
    let origin = LocalOrigin::parse(raw_origin)?;
    let token = Token::parse(raw_token)?;
    Ok(Local::new(origin, token))
}

/// Returns this machine's local daemon connection, or [`WireError::DaemonDown`] (exit 4) at once:
/// no endpoint/token file, invalid files left behind, or TCP probe actively refused.
///
/// A slow/unknown probe does **not** report `DaemonDown`; the subsequent connect enforces its own
/// deadline so a busy machine never reads as a stopped daemon.
///
/// Matches `reachLocalDaemon(home, probe)` in `apps/daemon/src/cli/daemon-endpoint.ts`.
pub fn reach_local(home: &Home, probe: &dyn Probe) -> Result<Local, WireError> {
    let local = host_connection(home).map_err(|_| WireError::DaemonDown)?;
    let answer = probe.probe(local.origin().host(), local.origin().port(), PROBE_TIMEOUT);
    if answer == ProbeAnswer::Down {
        return Err(WireError::DaemonDown);
    }
    Ok(local)
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    use super::*;

    struct StubProbe {
        answer: ProbeAnswer,
        calls: AtomicUsize,
    }

    impl StubProbe {
        const fn new(answer: ProbeAnswer) -> Self {
            Self {
                answer,
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl Probe for StubProbe {
        fn probe(&self, _host: &str, _port: u16, timeout: Duration) -> ProbeAnswer {
            assert_eq!(timeout, PROBE_TIMEOUT);
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.answer
        }
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir =
                env::temp_dir().join(format!("ace-cli-wire-{tag}-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn home(&self) -> Home {
            Home::new(self.0.clone())
        }

        fn write_daemon_files(&self, origin: &str, token: &str) {
            fs::write(self.0.join("daemon-endpoint"), origin).unwrap();
            fs::write(self.0.join("daemon-token"), token).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn home_resolution_matches_resolve_daemon_home() {
        let cwd = Path::new("/work/project");
        let user_home = Path::new("/Users/tester");

        assert_eq!(
            Home::resolve(user_home, None, cwd).path(),
            Path::new("/Users/tester/.ace")
        );
        assert_eq!(
            Home::resolve(user_home, Some(OsStr::new("/tmp/custom-ace")), cwd).path(),
            Path::new("/tmp/custom-ace")
        );
        assert_eq!(
            Home::resolve(user_home, Some(OsStr::new("rel-ace")), cwd).path(),
            Path::new("/work/project/rel-ace")
        );
    }

    #[test]
    fn missing_files_read_as_daemon_down_without_probing() {
        let dir = TempDir::new("missing");
        let probe = StubProbe::new(ProbeAnswer::Up);
        let err = reach_local(&dir.home(), &probe).unwrap_err();
        assert_eq!(err, WireError::DaemonDown);
        assert_eq!(err.exit_code(), 4);
        assert_eq!(err.cli_code(), "daemon_down");
        assert_eq!(probe.calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn invalid_endpoint_or_token_reads_as_daemon_down() {
        let dir = TempDir::new("invalid");
        dir.write_daemon_files("https://127.0.0.1:4312/", &"a".repeat(64));
        let probe = StubProbe::new(ProbeAnswer::Up);
        assert_eq!(
            reach_local(&dir.home(), &probe).unwrap_err(),
            WireError::DaemonDown
        );

        dir.write_daemon_files("http://127.0.0.1:4312/", "not-a-hex-token");
        assert_eq!(
            reach_local(&dir.home(), &probe).unwrap_err(),
            WireError::DaemonDown
        );
    }

    #[test]
    fn refused_probe_counts_as_down() {
        let dir = TempDir::new("refused");
        dir.write_daemon_files("http://127.0.0.1:4/", &"a".repeat(64));
        let probe = StubProbe::new(ProbeAnswer::Down);
        let err = reach_local(&dir.home(), &probe).unwrap_err();
        assert_eq!(err, WireError::DaemonDown);
        assert_eq!(probe.calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn unknown_probe_does_not_call_daemon_down() {
        let dir = TempDir::new("unknown");
        dir.write_daemon_files("http://127.0.0.1:4/", &"a".repeat(64));
        let probe = StubProbe::new(ProbeAnswer::Unknown);
        let local = reach_local(&dir.home(), &probe).unwrap();
        assert_eq!(local.origin().as_str(), "http://127.0.0.1:4/");
        assert_eq!(local.origin().port(), 4);
        assert_eq!(local.token().as_str(), "a".repeat(64));
    }

    #[test]
    fn real_tcp_probe_distinguishes_listening_and_closed_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir = TempDir::new("live-tcp");
        dir.write_daemon_files(&format!("http://127.0.0.1:{port}/"), &"b".repeat(64));

        let local = reach_local(&dir.home(), &TcpProbe).unwrap();
        assert_eq!(local.origin().port(), port);

        drop(listener);
        let started = Instant::now();
        let err = reach_local(&dir.home(), &TcpProbe).unwrap_err();
        assert_eq!(err, WireError::DaemonDown);
        assert!(started.elapsed() < Duration::from_millis(1_500));
    }
}
