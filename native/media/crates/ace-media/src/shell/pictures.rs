// SPDX-License-Identifier: Apache-2.0
//! The threads that encode JPEG sources (E4), one per source, so decoding and encoding never
//! run on the engine's loop. Pictures are dropped rather than queued when a source's thread is
//! behind (the next one is newer); configuration and keyframe requests are never dropped.
use crate::encode::platform::{Platform, SharedCapabilities};
use crate::encode::worker::{Command, Output, Worker};
use media_chrome::ChromeOptions;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Pictures waiting for a source's thread before newer ones replace them.
const PICTURES_WAITING: usize = 2;
/// How often a thread looks for units its encoder finished on its own threads.
const POLL: Duration = Duration::from_millis(4);

struct Handle {
    commands: Sender<Command>,
    waiting: Arc<AtomicUsize>,
}

pub struct Pictures {
    capabilities: SharedCapabilities,
    chrome: Option<ChromeOptions>,
    outputs: mpsc::Sender<(String, Output)>,
    sources: HashMap<String, Handle>,
    epoch: Instant,
}

impl Pictures {
    pub fn new(
        capabilities: SharedCapabilities,
        chrome: Option<ChromeOptions>,
        outputs: mpsc::Sender<(String, Output)>,
    ) -> Self {
        Self {
            capabilities,
            chrome,
            outputs,
            sources: HashMap::new(),
            epoch: Instant::now(),
        }
    }

    fn handle(&mut self, source: &str) -> Option<&Handle> {
        if !self.sources.contains_key(source) {
            let (commands, received) = channel();
            let waiting = Arc::new(AtomicUsize::new(0));
            let backends = Platform::new(self.capabilities.clone(), self.chrome.clone());
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
                        name,
                        epoch,
                    )
                });
            if spawned.is_err() {
                let _ = self
                    .outputs
                    .try_send((source.to_owned(), Output::Failed("encoder-failed".into())));
                return None;
            }
            self.sources
                .insert(source.to_owned(), Handle { commands, waiting });
        }
        self.sources.get(source)
    }

    pub fn configure(&mut self, source: &str, encodes: Vec<media_wire::control::EncodeSpec>) {
        if encodes.is_empty() {
            return self.close(source);
        }
        if let Some(handle) = self.handle(source) {
            let _ = handle.commands.send(Command::Configure(encodes));
        }
    }

    pub fn picture(&mut self, source: &str, text: Vec<u8>, epoch: u32, age_us: u32) {
        let Some(handle) = self.sources.get(source) else {
            return;
        };
        if handle.waiting.load(Ordering::Acquire) >= PICTURES_WAITING {
            return;
        }
        handle.waiting.fetch_add(1, Ordering::AcqRel);
        let _ = handle.commands.send(Command::Picture {
            text,
            epoch,
            age_us,
        });
    }

    pub fn key(&mut self, source: &str, encode: u32) {
        if let Some(handle) = self.sources.get(source) {
            let _ = handle.commands.send(Command::Key(encode));
        }
    }

    /// Ends a source's thread; its encoders close with it.
    pub fn close(&mut self, source: &str) {
        self.sources.remove(source);
    }
}

fn run(
    mut worker: Worker<Platform>,
    commands: Receiver<Command>,
    waiting: Arc<AtomicUsize>,
    outputs: mpsc::Sender<(String, Output)>,
    source: String,
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
            let failed = matches!(output, Output::Failed(_));
            if outputs.blocking_send((source.clone(), output)).is_err() || failed {
                return;
            }
        }
    }
}
