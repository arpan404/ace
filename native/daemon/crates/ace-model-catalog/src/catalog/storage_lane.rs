// SPDX-License-Identifier: Apache-2.0
//! Bounded storage workers with actor-owned ordering per instance.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

use crate::cache::{CacheEntry, CacheError, SharedStorage};
use crate::catalog::CatalogError;
use crate::catalog::commands::{Command, Reporter};

const WORKERS: usize = 4;
// The actor bounds each class of work before constructing jobs.
const QUEUE_LIMIT: usize = 2048;

/// Whether the work a job belongs to was superseded, aborted or timed out.
#[derive(Clone, Default)]
pub(crate) struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// One unit of storage work.
pub(crate) enum Job {
    Replace {
        entry: CacheEntry,
        cancel: Cancel,
    },
    Remove {
        instance: String,
    },
    /// Shutdown: remove every pending row, then close storage only if each removal stuck.
    Close {
        removals: Vec<String>,
    },
}

/// What one job did.
pub(crate) enum Outcome {
    Done,
    Failed(CacheError),
    /// Shutdown could not remove some rows; storage was left open for a later retry.
    CloseFailed {
        error: CacheError,
        not_removed: Vec<String>,
    },
    /// The owning token was settled before the write started.
    Cancelled,
}

struct Message {
    key: u64,
    job: Job,
}

impl Job {
    fn instance(&self) -> Option<&str> {
        match self {
            Job::Replace { entry, .. } => Some(&entry.instance),
            Job::Remove { instance } => Some(instance),
            Job::Close { .. } => None,
        }
    }
}

pub(crate) struct StorageLane {
    queued: VecDeque<Message>,
    running: BTreeMap<u64, Option<String>>,
    jobs: mpsc::SyncSender<Message>,
    workers: Vec<JoinHandle<()>>,
    reporter: Reporter,
}

impl StorageLane {
    pub(crate) fn new(storage: SharedStorage, reporter: Reporter) -> Result<Self, CatalogError> {
        Self::start(storage, reporter, |worker| {
            std::thread::Builder::new()
                .name("ace-model-catalog-storage".to_owned())
                .spawn(worker)
        })
    }

    fn start(
        storage: SharedStorage,
        reporter: Reporter,
        mut launch: impl FnMut(Box<dyn FnOnce() + Send>) -> std::io::Result<JoinHandle<()>>,
    ) -> Result<Self, CatalogError> {
        let (jobs, receiver) = mpsc::sync_channel(WORKERS);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers = Vec::with_capacity(WORKERS);
        for _ in 0..WORKERS {
            let receiver = receiver.clone();
            let storage = storage.clone();
            let reporter = reporter.clone();
            workers.push(
                launch(Box::new(move || run(&receiver, &storage, &reporter)))
                    .map_err(|_| CatalogError::StorageUnavailable)?,
            );
        }
        Ok(Self {
            queued: VecDeque::new(),
            running: BTreeMap::new(),
            jobs,
            workers,
            reporter,
        })
    }

    pub(crate) fn dispatch(&mut self, key: u64, job: Job) {
        if self.queued.len() >= QUEUE_LIMIT {
            self.reporter.report(Command::StorageDone {
                key,
                outcome: Outcome::Failed(CacheError::InstanceLimit),
            });
        } else {
            self.queued.push_back(Message { key, job });
        }
    }

    pub(crate) fn completed(&mut self, key: u64) {
        self.running.remove(&key);
    }

    pub(crate) fn pump(&mut self) {
        while self.running.len() < WORKERS {
            let next = self.queued.iter().position(|message| {
                let instance = message.job.instance();
                !self
                    .running
                    .values()
                    .any(|running| running.as_deref() == instance)
            });
            let Some(message) = next.and_then(|index| self.queued.remove(index)) else {
                break;
            };
            let key = message.key;
            let instance = message.job.instance().map(str::to_owned);
            if let Job::Replace { cancel, .. } = &message.job
                && cancel.cancelled()
            {
                self.reporter.report(Command::StorageDone {
                    key,
                    outcome: Outcome::Cancelled,
                });
            } else if self.jobs.try_send(message).is_ok() {
                self.running.insert(key, instance);
            } else {
                self.reporter.report(Command::StorageDone {
                    key,
                    outcome: Outcome::Failed(CacheError::Malformed),
                });
            }
        }
    }

    pub(crate) fn shutdown(self) {
        drop(self.jobs);
        if self.running.is_empty() {
            for worker in self.workers {
                let _ = worker.join();
            }
        }
    }
}

fn run(receiver: &Mutex<mpsc::Receiver<Message>>, storage: &SharedStorage, reporter: &Reporter) {
    loop {
        let message = receiver
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .recv();
        let Ok(message) = message else { break };
        let outcome = execute(storage, message.job);
        reporter.report(Command::StorageDone {
            key: message.key,
            outcome,
        });
    }
}

fn execute(storage: &SharedStorage, job: Job) -> Outcome {
    match job {
        Job::Replace { entry, cancel } => {
            if cancel.cancelled() {
                return Outcome::Cancelled;
            }
            let result = crate::catalog::storage::replace(storage, &entry, &|| !cancel.cancelled());
            if cancel.cancelled() {
                return Outcome::Cancelled;
            }
            match result {
                Ok(true) => Outcome::Done,
                Ok(false) => Outcome::Cancelled,
                Err(error) => Outcome::Failed(error),
            }
        }
        Job::Remove { instance } => remove(storage, &instance),
        Job::Close { removals } => {
            let mut not_removed = Vec::new();
            let mut first_error = None;
            for instance in removals {
                if let Outcome::Failed(error) = remove(storage, &instance) {
                    not_removed.push(instance);
                    first_error = first_error.or(Some(error));
                }
            }
            if let Some(error) = first_error {
                return Outcome::CloseFailed { error, not_removed };
            }
            match crate::catalog::storage::close(storage) {
                Ok(()) => Outcome::Done,
                Err(error) => Outcome::Failed(error),
            }
        }
    }
}

fn remove(storage: &SharedStorage, instance: &str) -> Outcome {
    match crate::catalog::storage::guarded(storage, |storage| storage.remove(instance)) {
        Ok(()) => Outcome::Done,
        Err(error) => Outcome::Failed(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_storage_worker_start_failure_refuses_the_lane() {
        let (commands, _receiver) = mpsc::sync_channel(1);
        let commands = Arc::new(commands);
        let (completions, _receiver) = mpsc::channel();
        let reporter = Reporter {
            commands: Arc::downgrade(&commands),
            completions,
        };
        let storage = SharedStorage::new(crate::cache::MemoryStorage::new());
        let (done, result) = mpsc::channel();
        std::thread::spawn(move || {
            let can_start = StorageLane::start(storage, reporter, |_| {
                Err(std::io::Error::other("worker refused"))
            });
            let _ = done.send(can_start.err());
        });
        assert_eq!(
            result
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap(),
            Some(CatalogError::StorageUnavailable)
        );
    }
}
