// SPDX-License-Identifier: Apache-2.0
//! Holding one Codex thread's writer lock through the CLI that owns it
//! (`holdCodexThread`, `thread-lease.ts:32`). Codex keeps an unsubscribed
//! thread loaded, and its writer lock held, for 30 minutes by default; a
//! short-lived app-server that resumes the thread takes the same lock without
//! a model turn. While it is held, no other Codex process can write the
//! thread. When another process holds it, the lease reports that instead of
//! throwing.

use ace_json::{JsString, Value};
use ace_supervisor::peer::Timeout;

use super::app_server::{AppServer, AppServerConfig, AppServerEffect};

/// Codex unloads a just-closed thread a moment after its last subscriber
/// leaves (`unloadClosedThreads`, `:9`).
pub const UNLOAD_CLOSED_THREADS: [&str; 2] = ["-c", "thread_unload_delay_secs=0"];

/// Attempts before the lease reports the thread busy (`attempts ?? 10`).
pub const DEFAULT_ATTEMPTS: usize = 10;
/// The wait between attempts (`:39`).
const RETRY_MS: f64 = 300.0;
/// The retry deadline's key.
pub const RETRY_TIMER: &str = "lease:retry";
/// The provider's refusal while another process writes the thread
/// (`/already has an active writer/i`, `:23`).
const BUSY: &str = "already has an active writer";

/// Whether a provider refusal is writer contention. The TypeScript matches
/// case-insensitively.
pub fn is_busy(message: &str) -> bool {
    message.to_lowercase().contains(BUSY)
}
/// What a busy thread reports (`:71`).
pub const BUSY_REASON: &str = "Another Codex process has this conversation open";

/// What the shell must do for a lease.
#[derive(Debug, Clone, PartialEq)]
pub enum LeaseEffect {
    /// The short-lived app-server's own effects.
    Server(AppServerEffect),
    /// The thread's writer lock is held; release it when done.
    Held,
    /// Another Codex process has this conversation open.
    NotHeld(String),
    /// The thread was unsubscribed and the server closed.
    Released,
    /// A failure that is not a busy thread: the caller's error.
    Failed(String),
}

/// A lease's progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Opening,
    Resuming,
    Held,
    Releasing,
    Done,
}

/// One thread lease over a short-lived app-server.
pub struct Lease {
    server: AppServer,
    thread: JsString,
    attempts: usize,
    attempt: usize,
    next_id: u64,
    resume: Option<u64>,
    release: Option<u64>,
    state: State,
}

impl Lease {
    /// Opens the short-lived app-server and asks it to resume `thread` (no
    /// model turn, no quota).
    pub fn open(
        config: AppServerConfig,
        thread: JsString,
        attempts: Option<usize>,
    ) -> (Lease, Vec<LeaseEffect>) {
        let (server, effects) = AppServer::new(config);
        let mut lease = Lease {
            server,
            thread,
            attempts: attempts.unwrap_or(DEFAULT_ATTEMPTS).max(1),
            attempt: 0,
            next_id: 1,
            resume: None,
            release: None,
            state: State::Opening,
        };
        let mut out = Vec::new();
        lease.absorb(effects, &mut out);
        (lease, out)
    }

    pub fn held(&self) -> bool {
        self.state == State::Held
    }

    /// One received line.
    pub fn line(&mut self, line: &str) -> Vec<LeaseEffect> {
        let effects = self.server.line(line);
        let mut out = Vec::new();
        self.absorb(effects, &mut out);
        out
    }

    pub fn written(&mut self, ticket: u64) -> Vec<LeaseEffect> {
        let effects = self.server.written(ticket);
        let mut out = Vec::new();
        self.absorb(effects, &mut out);
        out
    }

    pub fn timer(&mut self, key: &str) -> Vec<LeaseEffect> {
        let mut out = Vec::new();
        if key == RETRY_TIMER {
            if matches!(self.state, State::Opening | State::Resuming) {
                self.resume(&mut out);
            }
            return out;
        }
        let effects = self.server.timer(key);
        self.absorb(effects, &mut out);
        out
    }

    /// Unsubscribe, which unloads the thread, then close (`release`, `:54`).
    pub fn release(&mut self) -> Vec<LeaseEffect> {
        let mut out = Vec::new();
        if self.state != State::Held {
            self.close_now(&mut out);
            return out;
        }
        self.state = State::Releasing;
        let id = self.allocate();
        let mut params = ace_json::Map::with_capacity(1);
        params.insert("threadId", Value::from(self.thread.clone()));
        match self.server.request(
            "thread/unsubscribe",
            Some(&Value::Object(params)),
            id,
            Timeout::Default,
        ) {
            Ok(effects) => {
                self.release = Some(id);
                self.absorb(effects, &mut out);
            }
            Err(_) => self.close_now(&mut out),
        }
        out
    }

    /// Dispose the app-server; stopping the process releases the lock even if
    /// unsubscribing failed.
    pub fn close(&mut self) -> Vec<LeaseEffect> {
        let mut out = Vec::new();
        self.close_now(&mut out);
        out
    }

    fn allocate(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn resume(&mut self, out: &mut Vec<LeaseEffect>) {
        if self.attempt >= self.attempts {
            out.push(LeaseEffect::NotHeld(BUSY_REASON.to_owned()));
            self.close_now(out);
            return;
        }
        self.attempt += 1;
        self.state = State::Resuming;
        let id = self.allocate();
        let mut params = ace_json::Map::with_capacity(2);
        params.insert("threadId", Value::from(self.thread.clone()));
        params.insert("excludeTurns", Value::from(true));
        match self.server.request(
            "thread/resume",
            Some(&Value::Object(params)),
            id,
            Timeout::Default,
        ) {
            Ok(effects) => {
                self.resume = Some(id);
                self.absorb(effects, out);
            }
            Err(error) => {
                out.push(LeaseEffect::Failed(error.message().to_owned()));
                self.close_now(out);
            }
        }
    }

    /// A resume or unsubscribe answered.
    fn settled(&mut self, id: u64, result: Result<Value, String>, out: &mut Vec<LeaseEffect>) {
        if Some(id) == self.resume {
            self.resume = None;
            match result {
                Ok(_) => {
                    self.state = State::Held;
                    out.push(LeaseEffect::Held);
                }
                Err(message) if is_busy(&message) => {
                    if self.attempt < self.attempts {
                        out.push(LeaseEffect::Server(AppServerEffect::ArmTimer {
                            key: RETRY_TIMER.to_owned(),
                            ms: RETRY_MS,
                        }));
                        self.state = State::Opening;
                    } else {
                        out.push(LeaseEffect::NotHeld(BUSY_REASON.to_owned()));
                        self.close_now(out);
                    }
                }
                Err(message) => {
                    out.push(LeaseEffect::Failed(message));
                    self.close_now(out);
                }
            }
            return;
        }
        if Some(id) == self.release {
            self.release = None;
            self.close_now(out);
        }
    }

    fn close_now(&mut self, out: &mut Vec<LeaseEffect>) {
        if self.state == State::Done {
            return;
        }
        self.state = State::Done;
        self.resume = None;
        self.release = None;
        let effects = self.server.close("lease closed");
        for effect in effects {
            out.push(LeaseEffect::Server(effect));
        }
        out.push(LeaseEffect::Released);
    }

    fn absorb(&mut self, effects: Vec<AppServerEffect>, out: &mut Vec<LeaseEffect>) {
        for effect in effects {
            match effect {
                AppServerEffect::Ready => self.resume(out),
                // The handshake failed: `openAppServer` throws, so the lease
                // never reaches a resume and the caller sees the failure.
                AppServerEffect::Failed(message) if !self.server.ready() => {
                    out.push(LeaseEffect::Failed(message));
                    self.close_now(out);
                }
                AppServerEffect::Settle { id, result } => {
                    let result = result.map_err(|error| error.message().to_owned());
                    self.settled(id, result, out);
                }
                other => out.push(LeaseEffect::Server(other)),
            }
        }
    }
}

#[cfg(test)]
mod tests;
