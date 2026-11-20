// SPDX-License-Identifier: Apache-2.0

//! The watcher handle, its worker thread, and how a root is watched.
//!
//! The sink runs on the watcher's own thread, so it must never drop the [`Watcher`] from
//! inside itself: the drop would wait for the thread that is running it. Dropping the handle
//! from any other thread stops the OS watch and joins the worker.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use files_safe::{Readings, Root};
use notify::Event;
#[cfg(windows)]
use notify::event::{EventKind, Flag};

use crate::adopt::{self, Adopted};
use crate::backend::{self, Backend, Native, POLL_INTERVAL};

/// How long to wait before the first retry of a polling watcher that could not start.
const POLL_RETRY_START: Duration = Duration::from_millis(250);

/// The longest pause between polling retries.
const POLL_RETRY_MAX: Duration = Duration::from_secs(5);
use crate::batch::{Batch, ChangeKind};
use crate::coalesce::Coalescer;
use crate::error::Error;
use crate::exclude::Excluder;
use crate::net::{self, Net};
use crate::pairs::Pairs;
use crate::translate::{self, Notice};
use crate::wake::Wake;

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
    /// The latest focus set, waiting for the worker; kept apart from the queue so a full queue
    /// cannot lose it.
    focus: Arc<Mutex<Option<Vec<String>>>>,
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
        let focus = Arc::new(Mutex::new(None));
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
        // Read before `start` returns, so a name that appears afterwards is news to the net too.
        let net = Net::new(
            &root,
            &excluder,
            options.max_batch,
            std::time::SystemTime::now(),
        );
        let mut wake = Wake::start(events.clone());
        if let Some(wake) = &mut wake {
            wake.follow(&root, net.folders());
        }
        let worker = Worker {
            net,
            wake,
            poked: BTreeSet::new(),
            pairs: Pairs::default(),
            poke_due: None,
            last_poke: None,
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
            focus: Arc::clone(&focus),
            warning: None,
            readings: Readings::new(),
        };
        let running = std::thread::Builder::new()
            .name("files-watch".to_owned())
            .spawn(move || worker.run())
            .map_err(|error| {
                Error::Unsupported(format!("cannot start the watch thread: {error}"))
            })?;
        Ok(Watcher {
            control,
            stop,
            polling,
            focus,
            worker: Some(running),
        })
    }

    /// Names the folders a person has open, replacing the last set. The watcher checks each of
    /// them, and the root, about once a second, and reports a name that appeared or went away
    /// there even when the OS watch never said so. At most 512 folders are kept.
    pub fn focus(&self, folders: Vec<String>) {
        *self.focus.lock().unwrap_or_else(PoisonError::into_inner) = Some(folders);
        // The command wakes a worker blocked on an empty queue. A full queue drops it, which loses
        // nothing: the worker is busy, and takes the set from the slot on its next turn.
        let _ = self.control.try_send(Command::Focus);
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
    /// A new set of folders for the safety net is waiting in the focus slot.
    Focus,
    /// The kernel said an open folder changed; `rearm` when its handle went with it.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Poke {
        folder: String,
        rearm: bool,
    },
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
    #[cfg(any(windows, target_os = "macos"))]
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

    /// An open folder changed. A full queue drops the word: the net's timer checks it anyway.
    #[cfg(target_os = "macos")]
    pub(crate) fn poke(&self, folder: String, rearm: bool) {
        let _ = self.sender.try_send(Command::Poke { folder, rearm });
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
    /// The latest focus set from [`Watcher::focus`], not yet applied.
    focus: Arc<Mutex<Option<Vec<String>>>>,
    warning: Option<String>,
    /// The folders and stored names this window has already read. Cleared when a batch is
    /// delivered, so the next window judges folders as they are then.
    readings: Readings,
    /// The open folders, checked without the OS watch's help.
    net: Net,
    /// Handles on the open folders the kernel reports changes on, where the platform has them.
    wake: Option<Wake>,
    /// Open folders the kernel said changed, waiting for their check.
    poked: BTreeSet<String>,
    /// FSEvents rename halves waiting for their partners.
    pairs: Pairs,
    /// When the poked folders are checked: at once after a quiet spell, then at most every
    /// [`POKE_GAP`], so a burst in an open folder does not list it for every file.
    poke_due: Option<Instant>,
    last_poke: Option<Instant>,
}

/// The FSEvents id of a rename record's event, which `flags.rs` puts in the tracker. Other backends
/// use the tracker for their own rename cookies and pair renames themselves.
#[cfg(target_os = "macos")]
fn rename_id(event: &Event) -> Option<u64> {
    event.attrs.tracker().and_then(|id| u64::try_from(id).ok())
}

#[cfg(not(target_os = "macos"))]
fn rename_id(_event: &Event) -> Option<u64> {
    None
}

/// The time a check of the net runs at; the wall clock dates new entries by their birth time.
fn moment(instant: Instant) -> net::Moment {
    net::Moment {
        instant,
        wall: std::time::SystemTime::now(),
    }
}

/// The shortest time between two checks the kernel's word starts.
const POKE_GAP: Duration = Duration::from_millis(50);

impl Worker {
    fn run(mut self) {
        let mut coalescer = Coalescer::new(
            self.options.debounce,
            self.options.max_wait,
            self.options.max_batch,
        );
        let mut next_check = Instant::now() + net::INTERVAL;
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
            self.take_focus();
            let now = Instant::now();
            if now >= next_check {
                self.check_net(&mut coalescer, now);
                next_check = now + net::INTERVAL;
            }
            if self.poke_due.is_some_and(|due| now >= due) {
                self.check_poked(&mut coalescer, now);
            }
            if self.pairs.next_due().is_some_and(|due| now >= due) {
                let released = self.pairs.release_due(now);
                self.report(released, &mut coalescer, now);
            }
            // A moved-in name the OS watch has not named in time: its old path is somewhere only the
            // OS watch knows, so the root is walked again, which drops the old path too.
            if self.net.next_due().is_some_and(|due| now >= due)
                && !self.net.release_due(now).is_empty()
            {
                coalescer.overflow(None, now);
            }
            let wait = coalescer.wait(now);
            // A queued event is always ready, so receiving first would let a burst that never
            // stops hold `recv_timeout(0)` open forever and the window would never close. The
            // deadline is checked before the queue is touched.
            if wait == Some(Duration::ZERO) {
                self.settle(&mut coalescer, now);
                continue;
            }
            let until_check = [self.poke_due, self.net.next_due(), self.pairs.next_due()]
                .into_iter()
                .flatten()
                .fold(next_check, Instant::min)
                .saturating_duration_since(now);
            let received = self
                .commands
                .recv_timeout(wait.map_or(until_check, |wait| wait.min(until_check)));
            match received {
                Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(Command::Event(Ok(event))) => {
                    let now = Instant::now();
                    let rename = rename_id(&event);
                    // A pending rescan covers everything until it is sent, so a lookup would
                    // only be discarded with the change. Skipping it also lets a large backlog
                    // drain quickly, so the rescan is sent soon after the burst ends.
                    let translation = if coalescer.is_rescanning() {
                        translate::translate(
                            event,
                            &self.root,
                            &self.excluder,
                            &mut translate::Absent,
                        )
                    } else {
                        let mut disk = translate::Disk::new(&self.root, &mut self.readings);
                        translate::translate(event, &self.root, &self.excluder, &mut disk)
                    };
                    if let Some(dir) = translation.rescan {
                        coalescer.overflow(dir, now);
                        continue;
                    }
                    let notices = match rename {
                        Some(id) => self.pairs.take(id, translation.notices, now),
                        None => translation.notices,
                    };
                    self.report(notices, &mut coalescer, now);
                }
                Ok(Command::Focus) => self.take_focus(),
                Ok(Command::Poke { folder, rearm }) => {
                    if rearm && let Some(wake) = &mut self.wake {
                        wake.rearm(&self.root, &folder);
                    }
                    self.poked.insert(folder);
                    if self.poke_due.is_none() {
                        let now = Instant::now();
                        self.poke_due = Some(
                            self.last_poke
                                .map_or(now, |last| (last + POKE_GAP).max(now)),
                        );
                    }
                }
                Ok(Command::Event(Err(error))) => {
                    self.warn(format!("file watching degraded: {error}"));
                    // An OS watch that reports an error, such as inotify failing a read, may have
                    // lost the events it was reading: the root is walked again. The poller's
                    // errors are about single paths its next pass reads again, so they lose
                    // nothing.
                    if matches!(self.backend, Backend::Native(_)) {
                        coalescer.overflow(None, Instant::now());
                    }
                }
                Ok(Command::Failed(message)) => self.backend_failed(message),
                Err(RecvTimeoutError::Timeout) => {
                    // The wait may have ended for the net's check rather than the window.
                    let now = Instant::now();
                    if coalescer.wait(now) == Some(Duration::ZERO) {
                        self.settle(&mut coalescer, now);
                    }
                }
            }
        }
        self.backend.stop();
    }

    /// Applies the latest focus set, if one is waiting.
    fn take_focus(&mut self) {
        let folders = self
            .focus
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(folders) = folders {
            self.net.focus(
                &self.root,
                &self.excluder,
                folders,
                std::time::SystemTime::now(),
            );
            if let Some(wake) = &mut self.wake {
                wake.follow(&self.root, self.net.folders());
            }
        }
    }

    /// Adds what the OS watch reported to the window, with the files of folders that appeared.
    fn report(&mut self, mut notices: Vec<Notice>, coalescer: &mut Coalescer, now: Instant) {
        if notices.is_empty() {
            return;
        }
        self.adopt_folders(&mut notices, now, coalescer);
        for notice in notices {
            self.net.noticed(&notice.change.path);
            coalescer.push(notice, now);
        }
    }

    /// Checks the open folders, and adds what the OS watch did not report to the window.
    fn check_net(&mut self, coalescer: &mut Coalescer, now: Instant) {
        let found = self.net.check(&self.root, &self.excluder, moment(now));
        self.absorb(found, coalescer, now);
    }

    /// Checks the folders the kernel said changed.
    fn check_poked(&mut self, coalescer: &mut Coalescer, now: Instant) {
        self.poke_due = None;
        self.last_poke = Some(now);
        let poked: Vec<String> = std::mem::take(&mut self.poked).into_iter().collect();
        let found = self
            .net
            .check_folders(&self.root, &self.excluder, &poked, moment(now));
        self.absorb(found, coalescer, now);
    }

    /// Adds what a check of the net found to the window.
    fn absorb(&mut self, found: net::Found, coalescer: &mut Coalescer, now: Instant) {
        for folder in found.rescans {
            coalescer.overflow(Some(folder).filter(|folder| !folder.is_empty()), now);
        }
        if found.notices.is_empty() {
            return;
        }
        let mut notices = found.notices;
        self.adopt_folders(&mut notices, now, coalescer);
        for notice in notices {
            coalescer.push_found(notice, now);
        }
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
    ///
    /// A fatal failure reaches the worker twice: once in the failure slot, which survives a full
    /// event queue, and once as the command that wakes it. Whichever comes first does the work;
    /// the backend check makes the other a no-op, so one failure starts one poller and one
    /// rescan.
    fn backend_failed(&mut self, message: String) {
        if matches!(self.backend, Backend::Polling(_)) {
            return;
        }
        self.switch_to_polling(&Error::Unsupported(message));
        if matches!(self.backend, Backend::Polling(_)) {
            // The poller is watching before the walk is asked for, so changes that happen while
            // the walk runs are reported too.
            self.deliver(Batch::Rescan { dir: None });
        }
    }

    /// The kernel's watch budget ran out, or the native watch died: carry on with the poller
    /// rather than lose the tree. A poller that cannot start is retried with a backoff, because
    /// a root that is briefly unreadable should not end the watch for good.
    fn switch_to_polling(&mut self, error: &Error) {
        let mut backoff = POLL_RETRY_START;
        loop {
            match backend::poll(&self.root, self.events.clone()) {
                Ok(polling) => {
                    let previous = std::mem::replace(&mut self.backend, Backend::Polling(polling));
                    previous.stop();
                    self.polling.store(true, Ordering::Release);
                    self.warn(format!(
                        "native file watching stopped ({error}); polling every {} s",
                        POLL_INTERVAL.as_secs()
                    ));
                    return;
                }
                Err(failure) => {
                    self.warn(format!("file watching stopped: {failure}"));
                    if !self.pause(backoff) {
                        return;
                    }
                    backoff = backoff.saturating_mul(2).min(POLL_RETRY_MAX);
                }
            }
        }
    }

    /// Sleeps for `wait`, checking for a stop every hundred milliseconds. False when the watcher
    /// must stop instead.
    fn pause(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        loop {
            if self.stop.load(Ordering::Acquire) {
                return false;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return true;
            }
            std::thread::sleep(left.min(Duration::from_millis(100)));
        }
    }

    /// Closes the coalescer's window and delivers what it holds.
    ///
    /// The readings belong to the window that just closed: folders read while it filled may have
    /// changed since, and the next window starts from what the tree holds then. They are dropped
    /// whether or not this window produced a batch, so a window whose news cancelled out leaves
    /// nothing behind for the next one to trust.
    fn settle(&mut self, coalescer: &mut Coalescer, now: Instant) {
        let batch = {
            let mut disk = translate::Disk::new(&self.root, &mut self.readings);
            coalescer.settle(now, &mut disk)
        };
        self.readings.clear();
        if let Some(batch) = batch {
            self.deliver(batch);
        }
    }

    fn deliver(&mut self, batch: Batch) {
        self.net.delivered(
            &self.root,
            &self.excluder,
            &batch,
            std::time::SystemTime::now(),
        );
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
    fn an_error_from_the_os_watch_rescans_the_root() {
        let dir = tempfile::tempdir().unwrap();
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
        assert_eq!(watcher.mode(), Mode::Native);

        watcher
            .control
            .try_send(Command::Event(Err(notify::Error::io(
                std::io::Error::other("read failed"),
            ))))
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let seen = batches
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if seen
                .iter()
                .any(|batch| matches!(batch, Batch::Rescan { dir: None }))
            {
                assert!(
                    seen.iter().any(|batch| matches!(batch, Batch::Warning(_))),
                    "the error is reported too, saw {seen:?}"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "an OS watch error may have lost events and must rescan the root, saw {seen:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(watcher.mode(), Mode::Native, "the OS watch keeps running");
    }

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
                break;
            }
            assert!(
                Instant::now() < deadline,
                "a failed watch must poll and rescan, got mode {:?} and {seen:?}",
                watcher.mode()
            );
            std::thread::sleep(Duration::from_millis(20));
        }

        // The slot and the command are two copies of one failure, and a repeated command is a
        // duplicate: each must leave the single poller and its one rescan alone.
        watcher
            .control
            .try_send(Command::Failed("the watch stopped".to_owned()))
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let seen = batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let rescans = seen
            .iter()
            .filter(|batch| matches!(batch, Batch::Rescan { dir: None }))
            .count();
        assert_eq!(
            rescans, 1,
            "one fatal error starts one poller and one rescan, saw {seen:?}"
        );
    }

    #[test]
    fn a_focus_sent_while_the_queue_is_full_still_takes_effect() {
        // A folder opened during a burst must still be watched by the safety net. The net is
        // what rescans an open folder too large to compare name by name when its stamp moves, so
        // that rescan is the sign the folder is in focus.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("big")).unwrap();
        for index in 0..5 {
            std::fs::write(dir.path().join(format!("big/{index}")), b"x").unwrap();
        }
        let root = Root::open(dir.path()).unwrap();
        let batches = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&batches);
        let gate = Arc::new(Mutex::new(()));
        let held = gate.lock().unwrap();
        let sink_gate = Arc::clone(&gate);
        let (entered, blocked) = std::sync::mpsc::channel();
        let entered = Mutex::new(entered);
        let watcher = Watcher::start(
            root,
            WatchOptions {
                max_batch: 3,
                ..WatchOptions::default()
            },
            Box::new(move |batch| {
                if matches!(batch, Batch::Warning(_)) {
                    let _ = entered
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .send(());
                    drop(sink_gate.lock().unwrap_or_else(PoisonError::into_inner));
                }
                recorded
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(batch);
            }),
        )
        .unwrap();

        // Hold the worker inside the sink, then fill its queue.
        watcher
            .control
            .try_send(Command::Event(Err(notify::Error::io(
                std::io::Error::other("read failed"),
            ))))
            .unwrap();
        blocked.recv_timeout(Duration::from_secs(10)).unwrap();
        while watcher
            .control
            .try_send(Command::Poke {
                folder: String::new(),
                rearm: false,
            })
            .is_ok()
        {}
        watcher.focus(vec!["big".to_owned()]);
        drop(held);

        // The worker may take the focus a moment after the queue drains: keep adding names until
        // one of them is found by the net.
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut round = 0;
        loop {
            std::fs::write(dir.path().join(format!("big/new{round}")), b"x").unwrap();
            round += 1;
            let until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < until {
                let seen = batches
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone();
                if seen
                    .iter()
                    .any(|batch| matches!(batch, Batch::Rescan { dir: Some(dir) } if dir == "big"))
                {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let seen = batches
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            assert!(
                Instant::now() < deadline,
                "the folder focused while the queue was full is never checked, saw {seen:?}"
            );
        }
    }

    /// A watcher whose sink blocks on its first warning until the returned guard is dropped, with
    /// its queue filled behind it, so every OS event from then on is lost and becomes an overflow.
    /// Returns the watcher, what it delivered, and the guard.
    #[cfg(target_os = "linux")]
    fn stalled(
        root: &std::path::Path,
        options: WatchOptions,
    ) -> (
        Watcher,
        Arc<Mutex<Vec<Batch>>>,
        std::sync::MutexGuard<'static, ()>,
    ) {
        static GATE: Mutex<()> = Mutex::new(());
        let held = GATE.lock().unwrap_or_else(PoisonError::into_inner);
        let batches = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&batches);
        let (entered, blocked) = std::sync::mpsc::channel();
        let entered = Mutex::new(Some(entered));
        let watcher = Watcher::start(
            Root::open(root).unwrap(),
            options,
            Box::new(move |batch| {
                if matches!(batch, Batch::Warning(_))
                    && let Some(entered) = entered
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .take()
                {
                    let _ = entered.send(());
                    drop(GATE.lock().unwrap_or_else(PoisonError::into_inner));
                }
                recorded
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(batch);
            }),
        )
        .unwrap();
        // An OS watch error makes the worker warn, which holds it in the sink, and rescan the root.
        watcher
            .control
            .try_send(Command::Event(Err(notify::Error::io(
                std::io::Error::other("read failed"),
            ))))
            .unwrap();
        blocked.recv_timeout(Duration::from_secs(10)).unwrap();
        while watcher
            .control
            .try_send(Command::Poke {
                folder: String::new(),
                rearm: false,
            })
            .is_ok()
        {}
        (watcher, batches, held)
    }

    #[cfg(target_os = "linux")]
    fn wait_until(batches: &Mutex<Vec<Batch>>, what: &str, wanted: impl Fn(&[Batch]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let seen = batches
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if wanted(&seen) {
                return;
            }
            assert!(Instant::now() < deadline, "{what}, saw {seen:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn a_folder_recreated_while_events_were_lost_is_watched_after_the_rescan() {
        // The overflow lost the deletion and the creation of `src/cache`. The kernel dropped the
        // old folder's watch, and the rescan that follows must watch the new folder rather than
        // trust that the path still has one.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/cache")).unwrap();
        let (watcher, batches, held) = stalled(dir.path(), WatchOptions::default());
        std::fs::remove_dir(dir.path().join("src/cache")).unwrap();
        std::fs::create_dir(dir.path().join("src/cache")).unwrap();
        // Let the reader see the kernel drop the old watch before the worker runs again.
        std::thread::sleep(Duration::from_millis(300));
        drop(held);
        wait_until(&batches, "the lost events must rescan the root", |seen| {
            seen.iter()
                .any(|batch| matches!(batch, Batch::Rescan { dir: None }))
        });
        std::fs::write(dir.path().join("src/cache/new.txt"), b"x").unwrap();
        wait_until(
            &batches,
            "a file in the recreated folder must be reported",
            |seen| {
                seen.iter().any(|batch| {
                    matches!(batch, Batch::Changes(changes)
                        if changes.iter().any(|change| change.path == "src/cache/new.txt"))
                })
            },
        );
        assert_eq!(watcher.mode(), Mode::Native);
    }
}
