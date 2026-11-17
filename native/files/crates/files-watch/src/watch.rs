// SPDX-License-Identifier: Apache-2.0

//! The watcher handle, its worker thread and the polling fallback.

use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use files_safe::Root;
use notify::{Event, RecursiveMode, Watcher as NotifyWatcher};

use crate::backend::{Backend, Native};
use crate::batch::Batch;
use crate::coalesce::Coalescer;
use crate::error::Error;
use crate::exclude::Excluder;
use crate::translate;

/// How often the polling fallback scans the tree.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Which backend the watcher ended up using.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The operating system reports changes as they happen.
    Native,
    /// The tree is scanned every two seconds, because native watching was unavailable.
    Polling,
}

/// What to watch and how to batch it.
#[derive(Clone, Debug)]
pub struct WatchOptions {
    /// Quiet period that closes a batch. 75 ms is what the daemon passes.
    pub debounce: Duration,
    /// Glob patterns for folders that are never watched or reported.
    pub exclude: Vec<String>,
    /// A window holding more paths than this becomes a rescan instead.
    pub max_batch: usize,
}

/// Watches the root and calls its sink with batches until it is dropped.
pub struct Watcher {
    mode: Mode,
    control: Sender<Command>,
    worker: Option<JoinHandle<()>>,
}

impl Watcher {
    /// Starts watching. Falls back to polling when the OS backend cannot watch the root,
    /// reporting the reason once as a [`Batch::Warning`].
    pub fn start(
        root: Root,
        options: WatchOptions,
        sink: Box<dyn Fn(Batch) + Send + Sync>,
    ) -> Result<Watcher, Error> {
        if options.max_batch == 0 {
            return Err(Error::InvalidArgument(
                "max_batch must be at least 1".to_owned(),
            ));
        }
        let excluder = Excluder::new(&options.exclude)?;
        let (control, commands) = mpsc::channel();
        let events = Events(control.clone());
        let (backend, mode) = match Native::start(&root, &excluder, events.clone()) {
            Ok(native) => (Backend::Native(native), Mode::Native),
            Err(error) => {
                let mut polling = notify::PollWatcher::new(
                    events,
                    notify::Config::default().with_poll_interval(POLL_INTERVAL),
                )
                .map_err(no_backend)?;
                polling
                    .watch(root.path(), RecursiveMode::Recursive)
                    .map_err(no_backend)?;
                sink(Batch::Warning(format!(
                    "native file watching is unavailable ({error}); polling every {} s",
                    POLL_INTERVAL.as_secs()
                )));
                (Backend::Polling(polling), Mode::Polling)
            }
        };
        let worker = Worker {
            root,
            excluder,
            options,
            sink,
            commands,
            backend,
        };
        let running = std::thread::spawn(move || worker.run());
        Ok(Watcher {
            mode,
            control,
            worker: Some(running),
        })
    }

    /// The backend in use.
    pub fn mode(&self) -> Mode {
        self.mode
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.control.send(Command::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub(crate) fn no_backend(error: notify::Error) -> Error {
    Error::Unsupported(error.to_string())
}

/// Commands for the worker thread.
enum Command {
    Event(notify::Result<Event>),
    Stop,
}

/// Sends backend events to the worker.
#[derive(Clone)]
pub(crate) struct Events(Sender<Command>);

impl notify::EventHandler for Events {
    fn handle_event(&mut self, event: notify::Result<Event>) {
        let _ = self.0.send(Command::Event(event));
    }
}

/// Owns the backend and turns its events into batches.
struct Worker {
    root: Root,
    excluder: Excluder,
    options: WatchOptions,
    sink: Box<dyn Fn(Batch) + Send + Sync>,
    commands: Receiver<Command>,
    backend: Backend,
}

impl Worker {
    fn run(mut self) {
        let mut coalescer = Coalescer::new(
            self.options.debounce,
            self.options.max_batch,
            self.backend.flavour(),
        );
        let mut warning: Option<String> = None;
        loop {
            let received = match coalescer.wait(Instant::now()) {
                Some(remaining) => self.commands.recv_timeout(remaining),
                None => self
                    .commands
                    .recv()
                    .map_err(|_| RecvTimeoutError::Disconnected),
            };
            match received {
                Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => {
                    self.backend.stop();
                    return;
                }
                Ok(Command::Event(Ok(event))) => {
                    let now = Instant::now();
                    let mut translation =
                        translate::translate(event, &self.root, &self.excluder, &look);
                    if translation.rescan {
                        coalescer.overflow(now);
                        continue;
                    }
                    if let Some(message) = self.backend.adopt(&mut translation.changes)
                        && warning.as_deref() != Some(message.as_str())
                    {
                        (self.sink)(Batch::Warning(message.clone()));
                        warning = Some(message);
                    }
                    for change in translation.changes {
                        if let Some(batch) = coalescer.push(change, now) {
                            (self.sink)(batch);
                        }
                    }
                }
                Ok(Command::Event(Err(error))) => {
                    let message = format!("file watching degraded: {error}");
                    if warning.as_deref() != Some(message.as_str()) {
                        (self.sink)(Batch::Warning(message.clone()));
                        warning = Some(message);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(batch) = coalescer.settle() {
                        (self.sink)(batch);
                    }
                }
            }
        }
    }
}

fn look(path: &Path) -> Option<bool> {
    translate::look(path)
}
