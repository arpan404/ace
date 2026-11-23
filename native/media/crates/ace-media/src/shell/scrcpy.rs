// SPDX-License-Identifier: Apache-2.0
//! Scrcpy's video socket, read by ace-media itself (D1). One coordinating thread per source:
//! it dials the adb-forwarded port, waits for the one dummy byte the server sends on its
//! first socket, greets the daemon (which connects control), then reads the 64-byte device
//! name and the codec id once the daemon says control is connected, and streams units until
//! the socket ends. Every step of the handshake is bounded by the one deadline the open
//! carried; an end the daemon didn't ask for fails the source, so the daemon restarts the
//! handshake under the same source.
//!
//! A coordinator that panics fails its source on its way out, and one that stops turning
//! its loop for [`STALL_AFTER_MS`](super::watch::STALL_AFTER_MS) (a call that never
//! returns) is retired and its source failed, as a picture encoder's is.
use super::pictures::Encoded;
use super::scrcpy_reader::{Coordinator, run};
use super::watch::{Owed, Pulse};
use crate::encode::worker::Output;
use std::collections::HashMap;
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::mpsc;

/// A closed reader still running this long after its close is stuck.
pub const STUCK_AFTER_MS: u64 = 2_000;
/// What the daemon maps a missed deadline to: the server never greeted in time.
pub(crate) const NOT_STARTED: &str = "scrcpy-not-started";
/// What it maps an end or failure to: the server went away mid-handshake or mid-stream.
pub(crate) const CLOSED: &str = "scrcpy-closed";

/// What a scrcpy coordinator tells the engine besides units.
#[derive(Debug)]
pub enum ScrcpyEvent {
    /// The dummy byte arrived: the daemon connects control now.
    Greeted,
    /// The handshake finished: video follows on egress, under this device name.
    Ready { name: String },
}

pub(crate) enum Control {
    /// The daemon connected control: read the name and codec id now.
    Connected,
    /// A restart under the same source (or a reopen): dial this tunnel instead.
    Dial { host: String, port: u32 },
    /// The source closed: every unit read has gone out already, so say so at once.
    Drain,
    /// The source's reader ends.
    Close,
}

/// What a new coordinator dials.
pub(crate) struct Dial {
    pub(crate) source: String,
    pub(crate) token: u64,
    pub(crate) addr: SocketAddr,
    pub(crate) deadline: Duration,
}

/// A dial the daemon asked for: loopback only, never anywhere else.
pub(crate) fn dial_addr(host: &str, port: u32) -> Option<SocketAddr> {
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    let port = u16::try_from(port).ok().filter(|port| *port != 0)?;
    Some(SocketAddr::from(([127, 0, 0, 1], port)))
}

struct Handle {
    source: String,
    pulse: Pulse,
    control: Sender<Control>,
    /// A clone of the thread's socket: shutting it interrupts a blocked read.
    socket: Arc<Mutex<Option<TcpStream>>>,
    thread: JoinHandle<()>,
}

pub struct ScrcpyReaders {
    outputs: mpsc::Sender<Encoded>,
    events: mpsc::Sender<(String, u64, ScrcpyEvent)>,
    threads: HashMap<u64, Handle>,
    closing: Vec<(JoinHandle<()>, u64)>,
}

impl ScrcpyReaders {
    pub fn new(
        outputs: mpsc::Sender<Encoded>,
        events: mpsc::Sender<(String, u64, ScrcpyEvent)>,
    ) -> Self {
        Self {
            outputs,
            events,
            threads: HashMap::new(),
            closing: Vec::new(),
        }
    }

    /// Starts reading `host:port` for `source` under `token`, greeting within `deadline`.
    /// An endpoint that isn't the loopback adb forward fails the source at once.
    pub fn open(
        &mut self,
        source: &str,
        token: u64,
        host: &str,
        port: u32,
        deadline_ms: u64,
        now_ms: u64,
    ) {
        let failed = |reason: &str| (source.to_owned(), token, Output::Failed(reason.into()));
        let Some(addr) = dial_addr(host, port) else {
            let _ = self.outputs.try_send(failed(NOT_STARTED));
            return;
        };
        if !self.spawn(
            source,
            token,
            addr,
            Duration::from_millis(deadline_ms),
            now_ms,
        ) {
            let _ = self.outputs.try_send(failed(NOT_STARTED));
        }
    }

    /// Starts one coordinating thread; false when the thread itself would not spawn.
    fn spawn(
        &mut self,
        source: &str,
        token: u64,
        addr: SocketAddr,
        deadline: Duration,
        now_ms: u64,
    ) -> bool {
        let (control_tx, control) = channel();
        let socket: Arc<Mutex<Option<TcpStream>>> = Arc::default();
        let outputs = self.outputs.clone();
        let events = self.events.clone();
        let name = source.to_owned();
        let (pulse, beat) = Pulse::new(now_ms);
        let owed = Owed {
            outputs: self.outputs.clone(),
            source: source.to_owned(),
            token,
            reason: CLOSED,
        };
        let held = socket.clone();
        let spawned = std::thread::Builder::new()
            .name("ace-media-scrcpy".into())
            .spawn(move || {
                let _owed = owed;
                run(
                    Coordinator::new(
                        Dial {
                            source: name,
                            token,
                            addr,
                            deadline,
                        },
                        control,
                        outputs,
                        events,
                        held,
                    ),
                    beat,
                );
            });
        match spawned {
            Ok(thread) => {
                self.threads.insert(
                    token,
                    Handle {
                        source: source.to_owned(),
                        pulse,
                        control: control_tx,
                        socket,
                        thread,
                    },
                );
                true
            }
            Err(_) => false,
        }
    }

    pub fn has(&self, token: u64) -> bool {
        self.threads.contains_key(&token)
    }

    pub fn control_connected(&mut self, token: u64) {
        if let Some(handle) = self.threads.get(&token) {
            let _ = handle.control.send(Control::Connected);
        }
    }

    /// A restart under the same source, or a reopen: dial this tunnel instead. An endpoint
    /// that isn't the loopback adb forward ends the source at once. A reader that is
    /// already gone (it ended before) starts over under the same token.
    pub fn dial(
        &mut self,
        token: u64,
        source: &str,
        host: &str,
        port: u32,
        deadline_ms: u64,
        now_ms: u64,
    ) {
        if dial_addr(host, port).is_none() {
            if let Some(handle) = self.threads.get(&token) {
                let failed = (handle.source.clone(), token, Output::Failed(CLOSED.into()));
                self.end(token, now_ms);
                let _ = self.outputs.try_send(failed);
            }
            return;
        }
        if self.threads.contains_key(&token) {
            if let Some(handle) = self.threads.get(&token) {
                let _ = handle.control.send(Control::Dial {
                    host: host.to_owned(),
                    port,
                });
            }
            self.interrupt(token);
            return;
        }
        let Some(addr) = dial_addr(host, port) else {
            return;
        };
        // The open's deadline still bounds a redial: a fresh handshake, not forever.
        if !self.spawn(
            source,
            token,
            addr,
            Duration::from_millis(deadline_ms),
            now_ms,
        ) {
            let _ = self.outputs.try_send((
                source.to_owned(),
                token,
                Output::Failed(NOT_STARTED.into()),
            ));
        }
    }

    /// The source closed: every unit read has gone out already, so the reader says so at once.
    pub fn drain(&mut self, token: u64) {
        if let Some(handle) = self.threads.get(&token) {
            let _ = handle.control.send(Control::Drain);
        }
        self.interrupt(token);
    }

    pub fn close(&mut self, token: u64, now_ms: u64) {
        if let Some(handle) = self.threads.get(&token) {
            let _ = handle.control.send(Control::Close);
        }
        self.interrupt(token);
        if let Some(handle) = self.threads.remove(&token) {
            self.closing.push((handle.thread, now_ms));
        }
    }

    /// A blocked read ends when its socket shuts: the thread then sees its control.
    fn interrupt(&self, token: u64) {
        if let Some(handle) = self.threads.get(&token)
            && let Ok(held) = handle.socket.lock()
            && let Some(socket) = held.as_ref()
        {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }

    /// Ends the thread without its message (an endpoint that was never dialled).
    fn end(&mut self, token: u64, now_ms: u64) {
        if let Some(handle) = self.threads.get(&token) {
            let _ = handle.control.send(Control::Close);
        }
        self.interrupt(token);
        if let Some(handle) = self.threads.remove(&token) {
            self.closing.push((handle.thread, now_ms));
        }
    }

    /// Open readers that stopped turning [`STALL_AFTER_MS`](super::watch::STALL_AFTER_MS) ago,
    /// wedged in a call: each is retired (kept track of as a closed reader, stuck since it last
    /// turned) and its source and token returned once, for the engine to fail. One that has
    /// exited reported its own end.
    pub fn stalled(&mut self, now_ms: u64) -> Vec<(String, u64)> {
        let wedged: Vec<(u64, u64)> = self
            .threads
            .iter_mut()
            .filter(|(_, h)| !h.thread.is_finished())
            .filter_map(|(token, h)| h.pulse.stalled(now_ms).map(|since| (*token, since)))
            .collect();
        let mut failed = Vec::with_capacity(wedged.len());
        for (token, since) in wedged {
            if let Some(handle) = self.threads.get(&token) {
                let _ = handle.control.send(Control::Close);
            }
            self.interrupt(token);
            if let Some(handle) = self.threads.remove(&token) {
                failed.push((handle.source, token));
                self.closing.push((handle.thread, since));
            }
        }
        failed
    }

    /// Closed readers still running [`STUCK_AFTER_MS`] after their close.
    pub fn stuck(&mut self, now_ms: u64) -> usize {
        self.closing.retain(|(thread, _)| !thread.is_finished());
        self.closing
            .iter()
            .filter(|(_, closed)| now_ms.saturating_sub(*closed) >= STUCK_AFTER_MS)
            .count()
    }
}
