//! One ingest connection's queue and its pump thread. The pump writes the queue's bytes in
//! order and reports each write. A cut is final: it drops what is queued, refuses later
//! writes, and cancels a write in progress. A cancel, like Windows' `CancelIoEx`, only ends a
//! write already started, so a cut write is cancelled again (`recancel`, from the shell's
//! ticker) until the pump has let go; a write never starts after the cut, since the pump checks
//! the cut under the same lock it takes the next write under.
use super::shell::{Cancel, Link};
use media_ingest::Bytes;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

/// How often an idle connection checks that ace-media still holds it.
pub const LIVENESS: Duration = Duration::from_millis(100);

/// What the pump tells the shell.
pub enum Report {
    Written(u64),
    WriteFailed,
    /// ace-media let go of the connection.
    Closed,
}

enum Item {
    Write(u64, Bytes),
    /// The end frame is written: finish (flush to the reader) and close. Cancelled by a cut, as
    /// a write is.
    Shutdown,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Item>,
    cut: bool,
    /// A write or the final flush is in progress: a cut cancels it.
    in_write: bool,
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    /// The pump has returned and dropped its link.
    done: AtomicBool,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct Connection {
    shared: Arc<Shared>,
    cancel: Arc<dyn Cancel>,
}

impl Connection {
    pub fn start(
        link: Box<dyn Link>,
        cancel: Arc<dyn Cancel>,
        report: impl Fn(Report) + Send + 'static,
    ) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
            done: AtomicBool::new(false),
        });
        let pumped = shared.clone();
        std::thread::spawn(move || {
            pump(&pumped, link, report);
            pumped.done.store(true, Ordering::SeqCst);
        });
        Self { shared, cancel }
    }

    /// Queues one write; dropped once the connection is cut.
    pub fn write(&self, id: u64, bytes: Bytes) {
        let mut state = self.shared.lock();
        if state.cut {
            return;
        }
        state.queue.push_back(Item::Write(id, bytes));
        self.shared.wake.notify_one();
    }

    /// After the queued writes: finish and close cleanly.
    pub fn shutdown(&self) {
        let mut state = self.shared.lock();
        if state.cut {
            return;
        }
        state.queue.push_back(Item::Shutdown);
        self.shared.wake.notify_one();
    }

    /// Ends the connection now. What is queued is dropped at once, later writes are refused,
    /// and a write in progress is cancelled.
    pub fn cut(&self) {
        let mut state = self.shared.lock();
        state.cut = true;
        state.queue.clear();
        let writing = state.in_write;
        drop(state);
        self.shared.wake.notify_all();
        if writing {
            self.cancel.cancel();
        }
    }

    /// The pump has let go: nothing of this connection is left.
    pub fn finished(&self) -> bool {
        self.shared.done.load(Ordering::SeqCst)
    }

    /// Cancels again a cut connection's write still in progress.
    pub fn recancel(&self) {
        let state = self.shared.lock();
        if state.cut && state.in_write {
            drop(state);
            self.cancel.cancel();
        }
    }
}

fn pump(shared: &Shared, mut link: Box<dyn Link>, report: impl Fn(Report)) {
    loop {
        let mut state = shared.lock();
        let item = loop {
            if state.cut {
                return;
            }
            if let Some(item) = state.queue.pop_front() {
                break item;
            }
            let (next, wait) = shared
                .wake
                .wait_timeout(state, LIVENESS)
                .unwrap_or_else(|e| e.into_inner());
            state = next;
            if wait.timed_out() && state.queue.is_empty() && !state.cut {
                drop(state);
                if !link.alive() {
                    report(Report::Closed);
                    return;
                }
                state = shared.lock();
            }
        };
        match item {
            Item::Shutdown => {
                // Cancellable like a write: a reader that stopped taking bytes would hold the
                // flush, its thread and its handle forever.
                state.in_write = true;
                drop(state);
                link.finish();
                shared.lock().in_write = false;
                return;
            }
            Item::Write(id, bytes) => {
                // Marked under the lock the cut takes: a cut from now on cancels this write.
                state.in_write = true;
                drop(state);
                let written = link.write_all(bytes.as_slice());
                drop(bytes);
                let mut state = shared.lock();
                state.in_write = false;
                let cut = state.cut;
                drop(state);
                if cut {
                    return;
                }
                match written {
                    Ok(()) => report(Report::Written(id)),
                    Err(_) => {
                        report(Report::WriteFailed);
                        return;
                    }
                }
            }
        }
    }
}
