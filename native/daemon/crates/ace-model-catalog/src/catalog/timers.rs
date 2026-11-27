// SPDX-License-Identifier: Apache-2.0
//! Timer ports can block or panic during arm and cancel. Only this worker calls them.

use std::collections::{BTreeMap, BTreeSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};

use crate::catalog::commands::{Command, Reporter};
use crate::catalog::{Cancel, Deadlines};

const LIMIT: usize = 256;

type Expire = Box<dyn Fn() + Send + Sync>;
enum TimerCommand {
    Arm {
        key: u64,
        after_ms: f64,
        expire: Expire,
        retired: Arc<AtomicBool>,
    },
    Retire(u64),
}

pub(crate) struct Timer {
    key: u64,
    retired: Arc<AtomicBool>,
}

impl Timer {
    pub(crate) fn fired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }
}

pub(crate) struct Timers {
    sender: mpsc::SyncSender<TimerCommand>,
    pending: BTreeSet<u64>,
    next: u64,
    stopped: Arc<AtomicBool>,
}

impl Timers {
    pub(crate) fn new(port: Arc<dyn Deadlines>, reporter: Reporter) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(LIMIT * 2);
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        std::thread::Builder::new()
            .name("ace-model-catalog-timers".to_owned())
            .spawn(move || run(receiver, port.as_ref(), &stop, &reporter))?;
        Ok(Self {
            sender,
            pending: BTreeSet::new(),
            next: 0,
            stopped,
        })
    }

    pub(crate) fn arm(&mut self, after_ms: f64, expire: Expire) -> Option<Timer> {
        if self.pending.len() >= LIMIT {
            return None;
        }
        self.next += 1;
        let key = self.next;
        let retired = Arc::new(AtomicBool::new(false));
        self.sender
            .try_send(TimerCommand::Arm {
                key,
                after_ms,
                expire,
                retired: retired.clone(),
            })
            .ok()?;
        self.pending.insert(key);
        Some(Timer { key, retired })
    }

    pub(crate) fn cancel(&mut self, timer: Timer) {
        timer.retired.store(true, Ordering::Release);
        // Each admitted timer can contribute at most one Arm and one Retire.
        let _ = self.sender.try_send(TimerCommand::Retire(timer.key));
    }

    pub(crate) fn retired(&mut self, key: u64) {
        self.pending.remove(&key);
    }
}

impl Drop for Timers {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

fn run(
    receiver: mpsc::Receiver<TimerCommand>,
    port: &dyn Deadlines,
    stopped: &AtomicBool,
    reporter: &Reporter,
) {
    let mut armed = BTreeMap::<u64, Cancel>::new();
    for command in receiver {
        if stopped.load(Ordering::Acquire) {
            break;
        }
        match command {
            TimerCommand::Arm {
                key,
                after_ms,
                expire,
                retired,
            } => {
                if retired.load(Ordering::Acquire) {
                    continue;
                }
                let expire: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                    if !retired.swap(true, Ordering::AcqRel) {
                        expire();
                    }
                });
                let callback = expire.clone();
                match catch_unwind(AssertUnwindSafe(|| {
                    port.arm(after_ms, Box::new(move || callback()))
                })) {
                    Ok(cancel) => {
                        armed.insert(key, cancel);
                    }
                    Err(_) => expire(),
                }
            }
            TimerCommand::Retire(key) => {
                if let Some(cancel) = armed.remove(&key) {
                    let _ = catch_unwind(AssertUnwindSafe(cancel));
                }
                reporter.report(Command::TimerRetired { key });
            }
        }
    }
    for cancel in armed.into_values() {
        let _ = catch_unwind(AssertUnwindSafe(cancel));
    }
}
