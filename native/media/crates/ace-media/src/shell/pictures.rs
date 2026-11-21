// SPDX-License-Identifier: Apache-2.0
//! The threads that encode JPEG sources (E4), one per encoder, so decoding and encoding never
//! run on the engine's loop. Each thread belongs to one encoder token: its commands and its
//! outputs carry the token, so a source reopened under the same id never mixes with an earlier
//! encoder. Pictures are dropped rather than queued when a thread is behind (the next one is
//! newer); configuration, keyframe requests and drains are never dropped.
//!
//! A thread can't be stopped from outside safely, and a codec can hang inside a call (a flush
//! that never returns). So a closed thread is kept track of until it exits: one still running
//! [`STUCK_AFTER_MS`] after its close is stuck, and counts against the engine's limits until it
//! does exit. Enough of them and the engine ends the process, which the supervisor restarts.
use crate::encode::platform::{Platform, SharedCapabilities};
use crate::encode::worker::{Backends, Command, Output, Worker};
use media_chrome::ChromeOptions;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Pictures waiting for a thread before newer ones replace them.
const PICTURES_WAITING: usize = 2;
/// How often a thread looks for units its encoder finished on its own threads.
const POLL: Duration = Duration::from_millis(4);
/// A closed thread still running this long after its close is stuck.
pub const STUCK_AFTER_MS: u64 = 2_000;

/// What a thread reports: its source, its encoder token, and the output.
pub type Encoded = (String, u64, Output);

/// Makes the codecs for one encoder thread.
pub type BackendFactory = Arc<dyn Fn() -> Box<dyn Backends> + Send + Sync>;

struct Handle {
    commands: Sender<Command>,
    waiting: Arc<AtomicUsize>,
    thread: JoinHandle<()>,
}

/// A closed thread that hasn't exited yet, and when it was closed.
struct Closing {
    thread: JoinHandle<()>,
    closed_ms: u64,
}

pub struct Pictures {
    backends: BackendFactory,
    outputs: mpsc::Sender<Encoded>,
    threads: HashMap<u64, Handle>,
    closing: Vec<Closing>,
    epoch: Instant,
}

impl Pictures {
    pub fn new(
        capabilities: SharedCapabilities,
        chrome: Option<ChromeOptions>,
        outputs: mpsc::Sender<Encoded>,
    ) -> Self {
        let backends: BackendFactory = Arc::new(move || {
            Box::new(Platform::new(capabilities.clone(), chrome.clone())) as Box<dyn Backends>
        });
        Self::with_backends(backends, outputs)
    }

    pub fn with_backends(backends: BackendFactory, outputs: mpsc::Sender<Encoded>) -> Self {
        Self {
            backends,
            outputs,
            threads: HashMap::new(),
            closing: Vec::new(),
            epoch: Instant::now(),
        }
    }

    fn spawn(&mut self, source: &str, token: u64) -> Option<&Handle> {
        if !self.threads.contains_key(&token) {
            let (commands, received) = channel();
            let waiting = Arc::new(AtomicUsize::new(0));
            let backends = (self.backends)();
            let outputs = self.outputs.clone();
            let name = source.to_owned();
            let counter = waiting.clone();
            let epoch = self.epoch;
            let spawned = std::thread::Builder::new()
                .name("ace-media-pictures".into())
                .spawn(move || {
                    run(
                        Worker::new(backends),
                        received,
                        counter,
                        outputs,
                        (name, token),
                        epoch,
                    )
                });
            let Ok(thread) = spawned else {
                let failed = Output::Failed("encoder-failed".into());
                let _ = self.outputs.try_send((source.to_owned(), token, failed));
                return None;
            };
            self.threads.insert(
                token,
                Handle {
                    commands,
                    waiting,
                    thread,
                },
            );
        }
        self.threads.get(&token)
    }

    /// The probe's findings changed: every encoder thread looks again between its commands,
    /// and moves what a newly found hardware path improves onto it.
    pub fn capabilities_changed(&mut self) {
        for handle in self.threads.values() {
            let _ = handle.commands.send(Command::Capabilities);
        }
    }

    /// The encoder's encodes; an empty list stops it, as a close does.
    pub fn configure(
        &mut self,
        source: &str,
        token: u64,
        encodes: Vec<media_wire::control::EncodeSpec>,
        now_ms: u64,
    ) {
        if encodes.is_empty() {
            return self.close(token, now_ms);
        }
        if let Some(handle) = self.spawn(source, token) {
            let _ = handle.commands.send(Command::Configure(encodes));
        }
    }

    pub fn picture(&mut self, token: u64, jpeg: Vec<u8>, epoch: u32, age_us: u32) {
        let Some(handle) = self.threads.get(&token) else {
            return;
        };
        if handle.waiting.load(Ordering::Acquire) >= PICTURES_WAITING {
            return;
        }
        handle.waiting.fetch_add(1, Ordering::AcqRel);
        let _ = handle.commands.send(Command::Picture {
            jpeg,
            epoch,
            age_us,
        });
    }

    pub fn key(&mut self, token: u64, encode: u32) {
        if let Some(handle) = self.threads.get(&token) {
            let _ = handle.commands.send(Command::Key(encode));
        }
    }

    /// The source closed: the thread hands over what its encoders still hold, then says so.
    pub fn drain(&mut self, source: &str, token: u64) {
        match self.threads.get(&token) {
            Some(handle) => {
                let _ = handle.commands.send(Command::Drain);
            }
            // No thread, so nothing pending.
            None => {
                let _ = self
                    .outputs
                    .try_send((source.to_owned(), token, Output::Drained));
            }
        }
    }

    /// Ends an encoder's thread; its encoders close with it once it gets there.
    pub fn close(&mut self, token: u64, now_ms: u64) {
        if let Some(handle) = self.threads.remove(&token) {
            drop(handle.commands);
            self.closing.push(Closing {
                thread: handle.thread,
                closed_ms: now_ms,
            });
        }
    }

    /// Closed threads still running [`STUCK_AFTER_MS`] after their close. Threads that have
    /// exited are forgotten.
    pub fn stuck(&mut self, now_ms: u64) -> usize {
        self.closing.retain(|c| !c.thread.is_finished());
        self.closing
            .iter()
            .filter(|c| now_ms.saturating_sub(c.closed_ms) >= STUCK_AFTER_MS)
            .count()
    }
}

fn run(
    mut worker: Worker<Box<dyn Backends>>,
    commands: Receiver<Command>,
    waiting: Arc<AtomicUsize>,
    outputs: mpsc::Sender<Encoded>,
    (source, token): (String, u64),
    epoch: Instant,
) {
    let mut out = Vec::new();
    loop {
        let now = || epoch.elapsed().as_micros() as u64;
        match commands.recv_timeout(POLL) {
            Ok(command) => {
                if matches!(command, Command::Picture { .. }) {
                    waiting.fetch_sub(1, Ordering::AcqRel);
                }
                worker.command(command, now(), &mut out);
            }
            Err(RecvTimeoutError::Timeout) => worker.poll(now(), &mut out),
            Err(RecvTimeoutError::Disconnected) => return,
        }
        for output in out.drain(..) {
            let last = matches!(output, Output::Failed(_) | Output::Drained);
            if outputs
                .blocking_send((source.clone(), token, output))
                .is_err()
                || last
            {
                return;
            }
        }
    }
}

#[cfg(test)]
#[path = "pictures_tests.rs"]
mod tests;
