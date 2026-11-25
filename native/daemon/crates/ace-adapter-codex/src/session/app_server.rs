// SPDX-License-Identifier: Apache-2.0
//! A short-lived `codex app-server`, initialized and ready for requests
//! (`openAppServer`, `app-server.ts:29`). Usage reads and account sign-in use
//! one; no model turn ever runs on it. The shell spawns the child and owns its
//! clock and timers (E3.0b); this core owns the peer and the handshake.

use ace_json::Value;
use ace_supervisor::peer::{PeerEffect, PeerError, RpcPeer, Timeout};

/// One request's default deadline (`timeoutMs ?? 20_000`).
const DEFAULT_TIMEOUT_MS: f64 = 20_000.0;
/// How long Codex may take to answer `initialize` (`startupTimeoutMs ?? 5_000`).
const DEFAULT_STARTUP_MS: f64 = 5_000.0;

/// What `AppServer::new` needs (`AppServerOptions`).
#[derive(Debug, Clone, PartialEq)]
pub struct AppServerConfig {
    /// The `initialize` params the caller sends.
    pub initialize: Value,
    /// How long one request may wait for Codex.
    pub timeout_ms: Option<f64>,
    /// How long Codex may take to answer `initialize`. A CLI that doesn't
    /// speak it is given up on quickly so callers fall back.
    pub startup_timeout_ms: f64,
}

impl AppServerConfig {
    pub fn new(initialize: Value) -> AppServerConfig {
        AppServerConfig {
            initialize,
            timeout_ms: Some(DEFAULT_TIMEOUT_MS),
            startup_timeout_ms: DEFAULT_STARTUP_MS,
        }
    }
}

/// What the shell must do for one short-lived app-server.
#[derive(Debug, Clone, PartialEq)]
pub enum AppServerEffect {
    /// One line for the child's stdin, then `written(ticket)`.
    Write {
        wire: Vec<u8>,
        ticket: u64,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    /// Settles the caller's promise `id`, once.
    Settle {
        id: u64,
        result: Result<Value, PeerError>,
    },
    /// `initialize` was answered and `initialized` was sent: requests may go.
    Ready,
    /// The handshake failed; the server is closed.
    Failed(String),
    /// The peer is closed: stop the child (`close()`).
    Close,
}

/// One short-lived app-server and its handshake.
pub struct AppServer {
    config: AppServerConfig,
    peer: RpcPeer,
    /// The facade id of `initialize` (always 0).
    initialize_call: u64,
    ready: bool,
}

impl AppServer {
    /// Starts the handshake: `initialize` at once, `initialized` when it is
    /// answered.
    pub fn new(config: AppServerConfig) -> (AppServer, Vec<AppServerEffect>) {
        let peer = RpcPeer::new(ace_supervisor::peer::PeerConfig {
            timeout_ms: config.timeout_ms,
            ..Default::default()
        });
        let mut server = AppServer {
            config,
            peer,
            initialize_call: 0,
            ready: false,
        };
        let params = server.config.initialize.clone();
        let mut out = Vec::new();
        let requested = server.peer.request(
            "initialize",
            Some(&params),
            0,
            Timeout::After(server.config.startup_timeout_ms),
        );
        match requested {
            Ok(effects) => server.apply(effects, &mut out),
            Err(error) => {
                out.push(AppServerEffect::Failed(error.message().to_owned()));
                out.push(AppServerEffect::Close);
            }
        }
        (server, out)
    }

    pub fn ready(&self) -> bool {
        self.ready
    }

    /// One request, with the default deadline unless told otherwise.
    pub fn request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
    ) -> Result<Vec<AppServerEffect>, PeerError> {
        let effects = self.peer.request(method, params, id, timeout)?;
        let mut out = Vec::new();
        self.apply(effects, &mut out);
        Ok(out)
    }

    /// One notification; a write failure is reported through `onError`, which
    /// the shell sees as a `Failed`.
    pub fn notify(
        &mut self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Vec<AppServerEffect>, PeerError> {
        let effects = self.peer.notify(method, params)?;
        let mut out = Vec::new();
        self.apply(effects, &mut out);
        Ok(out)
    }

    /// One received line.
    pub fn line(&mut self, line: &str) -> Vec<AppServerEffect> {
        let effects = self.peer.line(line);
        let mut out = Vec::new();
        self.apply(effects, &mut out);
        out
    }

    pub fn written(&mut self, ticket: u64) -> Vec<AppServerEffect> {
        let effects = self.peer.written(ticket);
        let mut out = Vec::new();
        self.apply(effects, &mut out);
        out
    }

    pub fn timer(&mut self, key: &str) -> Vec<AppServerEffect> {
        let effects = self.peer.timer(key);
        let mut out = Vec::new();
        self.apply(effects, &mut out);
        out
    }

    /// Dispose the peer and stop the child (`close`).
    pub fn close(&mut self, reason: &str) -> Vec<AppServerEffect> {
        let effects = self.peer.close(reason);
        let mut out = Vec::new();
        self.apply(effects, &mut out);
        out.push(AppServerEffect::Close);
        out
    }

    /// A server request nobody handles: `MethodNotFound("unhandled request")`.
    pub fn refuse(&mut self, id: &ace_supervisor::jsonrpc::RpcId) -> Vec<AppServerEffect> {
        let effects = self.peer.answer_not_found(id);
        let mut out = Vec::new();
        self.apply(effects, &mut out);
        out
    }

    fn apply(&mut self, effects: Vec<PeerEffect>, out: &mut Vec<AppServerEffect>) {
        for effect in effects {
            match effect {
                PeerEffect::ServerRequest { id, .. } => {
                    // The peer's default `onRequest` is `unhandled request`.
                    let refused = self.peer.answer_not_found(&id);
                    self.apply(refused, out);
                }
                PeerEffect::Notification { .. } => {}
                PeerEffect::Malformed { .. } => {}
                PeerEffect::Failed { message } => out.push(AppServerEffect::Failed(message)),
                PeerEffect::Settle { id, result } => {
                    if id == self.initialize_call && !self.ready {
                        self.handshake(result, out);
                    } else {
                        out.push(AppServerEffect::Settle { id, result });
                    }
                }
                PeerEffect::Write { wire, ticket } => {
                    out.push(AppServerEffect::Write { wire, ticket })
                }
                PeerEffect::ArmTimer { key, ms } => out.push(AppServerEffect::ArmTimer { key, ms }),
                PeerEffect::CancelTimer { key } => out.push(AppServerEffect::CancelTimer { key }),
                PeerEffect::Frame { .. } => {}
            }
        }
    }

    /// `initialize` answered: send `initialized`, then report readiness. A
    /// failure closes the server (`openAppServer`'s catch).
    fn handshake(&mut self, result: Result<Value, PeerError>, out: &mut Vec<AppServerEffect>) {
        match result {
            Ok(_) => {
                match self.peer.notify("initialized", None) {
                    Ok(effects) => self.apply(effects, out),
                    Err(error) => out.push(AppServerEffect::Failed(error.message().to_owned())),
                }
                self.ready = true;
                out.push(AppServerEffect::Ready);
            }
            Err(error) => {
                out.push(AppServerEffect::Failed(error.message().to_owned()));
                let closed = self.peer.close(error.message());
                self.apply(closed, out);
                out.push(AppServerEffect::Close);
            }
        }
    }
}
