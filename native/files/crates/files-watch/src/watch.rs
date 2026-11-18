// SPDX-License-Identifier: Apache-2.0

//! The watcher handle, its worker thread, and how a root is watched.
//!
//! The sink runs on the watcher's own thread, so it must never drop the [`Watcher`] from
//! inside itself: the drop would wait for the thread that is running it. Dropping the handle
//! from any other thread stops the OS watch and joins the worker.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use files_safe::Root;
use notify::Event;
#[cfg(windows)]
use notify::event::{EventKind, Flag};

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
        let failure = Arc::new(Mutex::new(None));
        let events = Events {
            sender: control.clone(),
            overflow: Arc::clone(&overflow),
            failure: Arc::clone(&failure),
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
            failure,
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
    /// The operating-system watch stopped for good. The worker falls back to polling and asks
    /// for a root rescan, so the tree is still tracked and the client hears what it missed.
    #[cfg_attr(not(windows), allow(dead_code))]
    Failed(String),
    Stop,
}

/// Sends backend events to the worker without ever blocking the OS watcher.
#[derive(Clone)]
pub(crate) struct Events {
    sender: SyncSender<Command>,
    overflow: Arc<AtomicBool>,
    /// The last fatal backend failure, kept apart from the bounded queue: a full queue is
    /// exactly when the failure is most likely, and it must not be dropped with an event.
    #[cfg_attr(not(windows), allow(dead_code))]
    failure: Arc<Mutex<Option<String>>>,
}

impl notify::EventHandler for Events {
    fn handle_event(&mut self, event: notify::Result<Event>) {
        self.offer(event);
    }
}

impl Events {
    /// Hands one event to the worker without ever blocking the OS watcher.
    #[cfg(windows)]
    pub(crate) fn send(&self, event: Event) {
        self.offer(Ok(event));
    }

    /// The backend lost events: the worker sends a rescan of the whole root.
    #[cfg(windows)]
    pub(crate) fn lost_events(&self) {
        self.offer(Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)));
    }

    /// The OS watch stopped for good, with the reason the worker reports as a warning.
    #[cfg(windows)]
    pub(crate) fn failed(&self, message: &str) {
        *self.failure.lock().unwrap_or_else(PoisonError::into_inner) = Some(message.to_owned());
        // The command wakes a worker blocked on an empty queue; the slot covers a full one.
        self.enqueue(Command::Failed(message.to_owned()));
    }

    fn offer(&self, event: notify::Result<Event>) {
        // Reads are not changes: inotify reports every open, read and close of a file, and the
        // daemon's own indexing and searching would fill the queue with them.
        if let Ok(event) = &event
            && matches!(event.kind, notify::EventKind::Access(_))
        {
            return;
        }
        self.enqueue(Command::Event(event));
    }

    fn enqueue(&self, command: Command) {
        match self.sender.try_send(command) {
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
    failure: Arc<Mutex<Option<String>>>,
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
            let failed = self
                .failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some(message) = failed {
                self.backend_failed(message);
                continue;
            }
            if self.overflow.swap(false, Ordering::AcqRel) {
                coalescer.overflow(None, Instant::now());
            }
            let now = Instant::now();
            let wait = coalescer.wait(now);
            // A queued event is always ready, so receiving first would let a burst that never
            // stops hold `recv_timeout(0)` open forever and the window would never close. The
            // deadline is checked before the queue is touched.
            if wait == Some(Duration::ZERO) {
                let look = |path: &str| translate::look(&self.root, path);
                if let Some(batch) = coalescer.settle(now, &look) {
                    self.deliver(batch);
                }
                continue;
            }
            let received = match wait {
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
                    // A pending rescan covers everything until it is sent, so a lookup would
                    // only be discarded with the change. Skipping it also lets a large backlog
                    // drain quickly, so the rescan is sent soon after the burst ends.
                    let mut translation = if coalescer.is_rescanning() {
                        translate::translate(event, &self.root, &self.excluder, &|_| {
                            translate::Presence::Unknown
                        })
                    } else {
                        let look = |path: &str| translate::look(&self.root, path);
                        translate::translate(event, &self.root, &self.excluder, &look)
                    };
                    if let Some(dir) = translation.rescan {
                        coalescer.overflow(dir, now);
                        continue;
                    }
                    self.adopt_folders(&mut translation.notices, now, &mut coalescer);
                    for notice in translation.notices {
                        coalescer.push(notice, now);
                    }
                }
                Ok(Command::Event(Err(error))) => {
                    self.warn(format!("file watching degraded: {error}"));
                }
                Ok(Command::Failed(message)) => self.backend_failed(message),
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
    ) {
        if let Err(error) = self.backend.adopt(&self.root, &self.excluder, notices) {
            self.switch_to_polling(&error);
            return;
        }
        let folders: std::collections::BTreeSet<String> = notices
            .iter()
            .filter(|notice| notice.change.kind == ChangeKind::Created && notice.change.directory)
            .map(|notice| notice.change.path.clone())
            .collect();
        for folder in folders {
            match adopt::list(&self.root, &self.excluder, &folder, self.options.max_batch) {
                Adopted::Files(files) => notices.extend(files),
                Adopted::TooMany => coalescer.overflow(Some(folder), now),
                Adopted::Unreadable => {}
            }
        }
    }

    /// The native watch is gone. Poll from here on, and walk the tree once so the client learns
    /// what changed while nothing was watching.
    fn backend_failed(&mut self, message: String) {
        self.switch_to_polling(&Error::Unsupported(message));
        self.deliver(Batch::Rescan { dir: None });
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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::{Duration, Instant};

    use files_safe::Root;

    use super::{Batch, Command, Mode, WatchOptions, Watcher};

    #[test]
    fn a_failed_backend_switches_to_polling_and_asks_for_a_rescan() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"x").unwrap();
        let root = Root::open(dir.path()).unwrap();
        let batches = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&batches);
        let watcher = Watcher::start(
            root,
            WatchOptions::default(),
            Box::new(move |batch| {
                recorded
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(batch);
            }),
        )
        .unwrap();

        watcher
            .control
            .try_send(Command::Failed("the watch stopped".to_owned()))
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let seen = batches
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if watcher.mode() == Mode::Polling
                && seen
                    .iter()
                    .any(|batch| matches!(batch, Batch::Rescan { dir: None }))
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "a failed watch must poll and rescan, got mode {:?} and {seen:?}",
                watcher.mode()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
