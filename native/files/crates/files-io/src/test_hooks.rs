// SPDX-License-Identifier: Apache-2.0

//! Test-only seams. The crate ships them only behind the `test-hooks` feature, so a release build
//! has no way to install one and no behaviour that depends on a test.
//!
//! A watcher is handed the paths it fires for and decides for itself whether they are its own: a
//! test suite runs in one process, so several tests install watchers at once and each ignores the
//! moves of the others.

use std::sync::{Arc, Mutex, PoisonError};

pub use crate::hooks::Step;

/// What a watcher sees: the step, and the source and destination of the move.
///
/// Shared so the list can be read and released before any watcher runs: a watcher that calls back
/// into this crate must not find its own registry locked.
type Watcher = Arc<dyn Fn(Step, &str, &str) + Send + Sync>;

/// The targets whose atomic exchange a test refused.
type Refusals = Vec<(usize, Vec<String>)>;

/// The moves a test reported as meeting a taken destination.
type Taken = Vec<(usize, Vec<(String, String)>)>;

#[derive(Default)]
struct Installed {
    watchers: Arc<Mutex<Vec<(usize, Watcher)>>>,
    exchange: Arc<Mutex<Refusals>>,
    taken: Arc<Mutex<Taken>>,
}

fn installed() -> &'static Installed {
    static INSTALLED: std::sync::OnceLock<Installed> = std::sync::OnceLock::new();
    INSTALLED.get_or_init(|| Installed {
        watchers: Arc::new(Mutex::new(Vec::new())),
        exchange: Arc::new(Mutex::new(Vec::new())),
        taken: Arc::new(Mutex::new(Vec::new())),
    })
}

fn next() -> usize {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Removes an installed seam when it is dropped, so a finished test leaves nothing behind.
pub struct Guard {
    id: usize,
}

impl Drop for Guard {
    fn drop(&mut self) {
        let hooks = installed();
        let mut watchers = hooks
            .watchers
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        watchers.retain(|(id, _)| *id != self.id);
        let mut exchange = hooks
            .exchange
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        exchange.retain(|(id, _)| *id != self.id);
        let mut taken = hooks.taken.lock().unwrap_or_else(PoisonError::into_inner);
        taken.retain(|(id, _)| *id != self.id);
    }
}

/// Calls `watcher` at every move step, with the source and destination the move names.
pub fn watch(watcher: impl Fn(Step, &str, &str) + Send + Sync + 'static) -> Guard {
    let id = next();
    let hooks = installed();
    let mut watchers = hooks
        .watchers
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    watchers.push((id, Arc::new(watcher)));
    Guard { id }
}

/// Makes the atomic exchange report unavailable for a target named in `names`.
pub fn refuse_exchange(names: &[&str]) -> Guard {
    let id = next();
    let hooks = installed();
    let mut exchange = hooks
        .exchange
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    exchange.push((id, names.iter().map(|name| (*name).to_owned()).collect()));
    Guard { id }
}

/// Makes a no-replace rename of `from` to `to` report the destination as taken, the way a volume
/// that folds both names together does, without moving anything.
pub fn report_taken(from: &str, to: &str) -> Guard {
    let id = next();
    let hooks = installed();
    let mut taken = hooks.taken.lock().unwrap_or_else(PoisonError::into_inner);
    taken.push((id, vec![(from.to_owned(), to.to_owned())]));
    Guard { id }
}

/// Whether a no-replace rename of `from` to `to` was told to report a taken destination.
pub(crate) fn reports_taken(from: &str, to: &str) -> bool {
    let hooks = installed();
    let taken = hooks.taken.lock().unwrap_or_else(PoisonError::into_inner);
    taken
        .iter()
        .any(|(_, pairs)| pairs.iter().any(|(one, other)| one == from && other == to))
}

/// Runs every watcher for one step.
pub(crate) fn reached(step: Step, from: &str, to: &str) {
    let hooks = installed();
    let watchers: Vec<Watcher> = hooks
        .watchers
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .map(|(_, watcher)| Arc::clone(watcher))
        .collect();
    for watcher in watchers {
        watcher(step, from, to);
    }
}

/// Whether an atomic exchange of the entry called `name` is available.
pub(crate) fn may_exchange(name: &str) -> bool {
    let hooks = installed();
    let exchange = hooks
        .exchange
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    !exchange
        .iter()
        .any(|(_, names)| names.iter().any(|refused| refused == name))
}
