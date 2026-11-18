// SPDX-License-Identifier: Apache-2.0

//! The watcher handle, its worker thread, and how a root is watched.
//!
//! The sink runs on the watcher's own thread, so it must never drop the [`Watcher`] from
//! inside itself: the drop would wait for the thread that is running it. Dropping the handle
//! from any other thread stops the OS watch and joins the worker.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use files_safe::Root;
use notify::Event;

use crate::adopt::{self, Adopted};
use crate::backend::{self, Backend, Native, POLL_INTERVAL};
use crate::batch::{Batch, ChangeKind};
use crate::coalesce::Coalescer;
use crate::error::Error;
use crate::exclude::Excluder;
use crate::translate::{self, Notice};

/// How many backend events may wait for the worker before the rest are dropped. A full
/// channel switches the window to a rescan of the root, because events were lost.
const CHANNEL: usize = 65_536;

/// The longest a window may stay open before it closes with what it has.
pub(crate) const DEFAULT_MAX_WAIT: Duration = Duration::from_secs(1);

/// Which backend the watcher is using.
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
    /// The longest a batch may stay open while changes keep arriving. 1 s by default.
    pub max_wait: Duration,
    /// Glob patterns for folders that are never watched or reported.
    pub exclude: Vec<String>,
    /// More changes than this in one window become a rescan instead.
    pub max_batch: usize,
}

impl Default for WatchOptions {
    fn default() -> WatchOptions {
        WatchOptions {
            debounce: Duration::from_millis(75),
            max_wait: DEFAULT_MAX_WAIT,
            exclude: [
                "**/.git/objects/**",
                "**/.git/subtree-cache/**",
                "**/node_modules/*/**",
            ]
            .map(str::to_owned)
            .to_vec(),
            max_batch: 5_000,
        }
    }
}

/// Watches the root and calls its sink with batches until it is dropped.
pub struct Watcher {
    control: SyncSender<Command>,
    stop: Arc<AtomicBool>,
    polling: Arc<AtomicBool>,
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
        let options = WatchOptions {
            max_wait: if options.max_wait.is_zero() {
                DEFAULT_MAX_WAIT
            } else {
                options.max_wait
            },
            ..options
        };
        let (control, commands) = mpsc::sync_channel(CHANNEL);
        let stop = Arc::new(AtomicBool::new(false));
        let overflow = Arc::new(AtomicBool::new(false));
        let polling = Arc::new(AtomicBool::new(false));
        let events = Events {
            sender: control.clone(),
            overflow: Arc::clone(&overflow),
        };
        let backend = match Native::start(&root, &excluder, events.clone()) {
            Ok(native) => Backend::Native(native),
            Err(error) => {
                let watcher = backend::poll(&root, events.clone())?;
                polling.store(true, Ordering::Release);
                sink(Batch::Warning(format!(
                    "native file watching is unavailable ({error}); polling every {} s",
                    POLL_INTERVAL.as_secs()
                )));
                Backend::Polling(watcher)
            }
        };
        let worker = Worker {
            root,
            excluder,
            options,
            sink,
            commands,
            backend,
            events,
            stop: Arc::clone(&stop),
            overflow,
            polling: Arc::clone(&polling),
            warning: None,
        };
        let running = std::thread::spawn(move || worker.run());
        Ok(Watcher {
            control,
            stop,
            polling,
            worker: Some(running),
        })
    }

    /// The backend in use, including a switch to polling after a watch limit was hit.
    pub fn mode(&self) -> Mode {
        if self.polling.load(Ordering::Acquire) {
            Mode::Polling
        } else {
            Mode::Native
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.control.try_send(Command::Stop);
        if let Some(worker) = self.worker.take()
            && std::thread::current().id() != worker.thread().id()
        {
            let _ = worker.join();
        }
    }
}

/// Commands for the worker thread.
enum Command {
    Event(notify::Result<Event>),
    Stop,
}

/// Sends backend events to the worker without ever blocking the OS watcher.
#[derive(Clone)]
pub(crate) struct Events {
    sender: SyncSender<Command>,
    overflow: Arc<AtomicBool>,
}

impl notify::EventHandler for Events {
    fn handle_event(&mut self, event: notify::Result<Event>) {
        // Reads are not changes: inotify reports every open, read and close of a file, and the
        // daemon's own indexing and searching would fill the queue with them.
        if let Ok(event) = &event
            && matches!(event.kind, notify::EventKind::Access(_))
        {
            return;
        }
        match self.sender.try_send(Command::Event(event)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => self.overflow.store(true, Ordering::Release),
            Err(TrySendError::Disconnected(_)) => {}
        }
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
    events: Events,
    stop: Arc<AtomicBool>,
    overflow: Arc<AtomicBool>,
    polling: Arc<AtomicBool>,
    warning: Option<String>,
}

impl Worker {
    fn run(mut self) {
        let mut coalescer = Coalescer::new(
            self.options.debounce,
            self.options.max_wait,
            self.options.max_batch,
        );
        loop {
            if self.stop.load(Ordering::Acquire) {
                break;
            }
            if self.overflow.swap(false, Ordering::AcqRel)
                && let Some(batch) = coalescer.overflow(None, Instant::now())
            {
                self.deliver(batch);
            }
            let received = match coalescer.wait(Instant::now()) {
                Some(remaining) => self.commands.recv_timeout(remaining),
                None => self
                    .commands
                    .recv()
                    .map_err(|_| RecvTimeoutError::Disconnected),
            };
            match received {
                Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(Command::Event(Ok(event))) => {
                    let now = Instant::now();
                    let mut translation = {
                        let look = |path: &str| translate::look(&self.root, path);
                        translate::translate(event, &self.root, &self.excluder, &look)
                    };
                    if let Some(dir) = translation.rescan {
                        if let Some(batch) = coalescer.overflow(dir, now) {
                            self.deliver(batch);
                        }
                        continue;
                    }
                    let batch = self.adopt_folders(&mut translation.notices, now, &mut coalescer);
                    for notice in translation.notices {
                        if let Some(rescan) = coalescer.push(notice, now) {
                            self.deliver(rescan);
                        }
                    }
                    if let Some(batch) = batch {
                        self.deliver(batch);
                    }
                }
                Ok(Command::Event(Err(error))) => {
                    self.warn(format!("file watching degraded: {error}"));
                }
                Err(RecvTimeoutError::Timeout) => {
                    let look = |path: &str| translate::look(&self.root, path);
                    if let Some(batch) = coalescer.settle(Instant::now(), &look) {
                        self.deliver(batch);
                    }
                }
            }
        }
        self.backend.stop();
    }

    /// Reports the files of a folder that just appeared, and adds whatever watches it needs.
    fn adopt_folders(
        &mut self,
        notices: &mut Vec<Notice>,
        now: Instant,
        coalescer: &mut Coalescer,
    ) -> Option<Batch> {
        if let Err(error) = self.backend.adopt(&self.root, &self.excluder, notices) {
            self.switch_to_polling(&error);
            return None;
        }
        let folders: std::collections::BTreeSet<String> = notices
            .iter()
            .filter(|notice| notice.change.kind == ChangeKind::Created && notice.change.directory)
            .map(|notice| notice.change.path.clone())
            .collect();
        let mut batch = None;
        for folder in folders {
            match adopt::list(&self.root, &self.excluder, &folder, self.options.max_batch) {
                Adopted::Files(files) => notices.extend(files),
                Adopted::TooMany => batch = coalescer.overflow(Some(folder), now).or(batch),
                Adopted::Unreadable => {}
            }
        }
        batch
    }

    /// The kernel's watch budget ran out: carry on with the poller rather than lose the tree.
    fn switch_to_polling(&mut self, error: &Error) {
        match backend::poll(&self.root, self.events.clone()) {
            Ok(polling) => {
                let previous = std::mem::replace(&mut self.backend, Backend::Polling(polling));
                previous.stop();
                self.polling.store(true, Ordering::Release);
                self.warn(format!(
                    "native file watching stopped ({error}); polling every {} s",
                    POLL_INTERVAL.as_secs()
                ));
            }
            Err(error) => self.warn(format!("file watching stopped: {error}")),
        }
    }

    fn deliver(&mut self, batch: Batch) {
        if let Batch::Rescan { dir } = &batch
            && let Err(error) = self
                .backend
                .rescan(&self.root, &self.excluder, dir.as_deref())
        {
            self.warn(format!("cannot rebuild watches: {error}"));
        }
        (self.sink)(batch);
    }

    fn warn(&mut self, message: String) {
        if self.warning.as_deref() != Some(message.as_str()) {
            (self.sink)(Batch::Warning(message.clone()));
            self.warning = Some(message);
        }
    }
}
