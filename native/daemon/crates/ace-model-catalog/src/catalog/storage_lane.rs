// SPDX-License-Identifier: Apache-2.0
//! Storage work, run on a lane of its own so a stalled disk never stalls the catalog.
//!
//! Storage is a synchronous port. The actor never calls it: it dispatches a job with the
//! token that owns it and handles the reply as another message. One worker keeps every
//! job in total order, so a row's delete never overtakes the write it replaces. The
//! worker checks the job's ownership flag immediately before writing, which is what makes
//! a deadline win at the durable boundary rather than only in memory.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};

use crate::cache::{CacheEntry, CacheError, SharedStorage};
use crate::catalog::commands::Reporter;

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

pub(crate) struct StorageLane {
    jobs: Option<Sender<Message>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl StorageLane {
    pub(crate) fn new(storage: SharedStorage, reporter: Reporter) -> Self {
        let (jobs, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("ace-model-catalog-storage".to_owned())
            .spawn(move || run(receiver, storage, reporter))
            .ok();
        Self {
            jobs: Some(jobs),
            worker,
        }
    }

    pub(crate) fn dispatch(&self, key: u64, job: Job) {
        if let Some(jobs) = &self.jobs {
            let _ = jobs.send(Message { key, job });
        }
    }

    /// Stops the lane after the jobs it already accepted and joins its worker.
    pub(crate) fn shutdown(&mut self) {
        drop(self.jobs.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run(receiver: Receiver<Message>, storage: SharedStorage, reporter: Reporter) {
    for message in receiver {
        let outcome = execute(&storage, message.job);
        reporter.report(crate::catalog::commands::Command::StorageDone {
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
            let mut storage = storage.clone();
            match crate::catalog::storage::replace(&mut storage, &entry) {
                Ok(()) => Outcome::Done,
                Err(error) => Outcome::Failed(error),
            }
        }
        Job::Remove { instance } => {
            let mut storage = storage.clone();
            remove(&mut storage, &instance)
        }
        Job::Close { removals } => {
            let mut storage = storage.clone();
            let mut not_removed = Vec::new();
            let mut first_error = None;
            for instance in removals {
                if let Outcome::Failed(error) = remove(&mut storage, &instance) {
                    not_removed.push(instance);
                    first_error = first_error.or(Some(error));
                }
            }
            if let Some(error) = first_error {
                return Outcome::CloseFailed { error, not_removed };
            }
            match crate::catalog::storage::close(&mut storage) {
                Ok(()) => Outcome::Done,
                Err(error) => Outcome::Failed(error),
            }
        }
    }
}

fn remove(storage: &mut SharedStorage, instance: &str) -> Outcome {
    match crate::catalog::storage::guarded(storage, |storage| storage.remove(instance)) {
        Ok(()) => Outcome::Done,
        Err(error) => Outcome::Failed(error),
    }
}
