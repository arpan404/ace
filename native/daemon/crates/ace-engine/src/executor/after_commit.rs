// SPDX-License-Identifier: Apache-2.0
//! What a synchronous entry defers until its outermost transaction commits (ADR 0223 §4,
//! E5.1 step 3). A token stands for one wake or one not-yet-spawned future; the store's stack
//! releases the tokens on commit and drops them on rollback, exactly once.

use super::Lane;
use futures::future::LocalBoxFuture;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

/// Work a synchronous entry starts: a wake of a parked task, a future to spawn, or a decision
/// whose effects must be visible the instant the commit lands.
pub enum Deferred {
    Wake(String, Lane),
    Spawn(Lane, LocalBoxFuture<'static, ()>),
    /// Run at the commit itself, in place: a promoted actor must be visible to the very next
    /// synchronous lookup, as the TypeScript's eviction at the call was.
    Run(Box<dyn FnOnce()>),
}

/// Where a released deferred goes: the engine wakes a parked task or spawns the future.
pub trait DeferredHost {
    fn wake(&self, thread: &str, lane: Lane);
    fn spawn(&self, lane: Lane, future: LocalBoxFuture<'static, ()>);
    /// Run a deferred decision now, inside the commit's own turn.
    fn run(&self, run: Box<dyn FnOnce()>);
}

/// The after-commit sink the store's shared stack hands released tokens to.
#[derive(Default)]
pub struct AfterCommit {
    entries: RefCell<HashMap<u64, Vec<Deferred>>>,
    host: RefCell<Option<Weak<dyn DeferredHost>>>,
    next: Cell<u64>,
}

impl AfterCommit {
    pub fn new() -> Rc<AfterCommit> {
        Rc::new(AfterCommit::default())
    }

    /// Set once the engine exists, as a weak handle so the sink never keeps it alive.
    pub fn attach(&self, host: Weak<dyn DeferredHost>) {
        *self.host.borrow_mut() = Some(host);
    }

    /// Detaches the host: a later release drops what it finds, never silently keeps it.
    pub fn detach(&self) -> Vec<u64> {
        *self.host.borrow_mut() = None;
        let mut entries = self.entries.borrow_mut();
        let tokens: Vec<u64> = entries.keys().copied().collect();
        entries.clear();
        tokens
    }

    /// Records `deferred` under a fresh token and returns the token.
    pub fn defer(&self, deferred: Deferred) -> u64 {
        let token = self.next.get() + 1;
        self.next.set(token);
        self.entries
            .borrow_mut()
            .entry(token)
            .or_default()
            .push(deferred);
        token
    }

    /// Releases each token's deferreds in token order: wakes and spawns are producer moves only.
    pub fn release(&self, tokens: &[u64]) {
        let host = self.host.borrow().as_ref().and_then(Weak::upgrade);
        let mut entries = self.entries.borrow_mut();
        for token in tokens {
            let Some(deferred) = entries.remove(token) else {
                continue;
            };
            for item in deferred {
                match (host.as_deref(), item) {
                    (Some(host), Deferred::Wake(thread, lane)) => host.wake(&thread, lane),
                    (Some(host), Deferred::Spawn(lane, future)) => host.spawn(lane, future),
                    (Some(host), Deferred::Run(run)) => host.run(run),
                    // Detached: the engine is closing, and the work is dropped.
                    (None, _) => {}
                }
            }
        }
    }

    /// Discards what the tokens stood for: a rolled-back receipt starts nothing.
    pub fn drop_tokens(&self, tokens: &[u64]) {
        let mut entries = self.entries.borrow_mut();
        for token in tokens {
            entries.remove(token);
        }
    }

    pub fn pending(&self) -> usize {
        self.entries.borrow().len()
    }

    #[cfg(test)]
    pub fn host_present(&self) -> bool {
        matches!(self.host.borrow().as_ref(), Some(weak) if weak.strong_count() > 0)
    }
}

#[cfg(test)]
pub(crate) fn spawned(lane: Lane) -> (Deferred, Rc<Cell<bool>>) {
    let seen = Rc::new(Cell::new(false));
    let slot = Rc::clone(&seen);
    (
        Deferred::Spawn(
            lane,
            Box::pin(async move {
                slot.set(true);
            }),
        ),
        seen,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Host {
        woken: RefCell<Vec<(String, Lane)>>,
        spawned: RefCell<Vec<bool>>,
    }

    impl DeferredHost for Host {
        fn wake(&self, thread: &str, lane: Lane) {
            self.woken.borrow_mut().push((thread.to_string(), lane));
        }
        fn spawn(&self, _lane: Lane, future: LocalBoxFuture<'static, ()>) {
            let ran = Rc::new(std::cell::Cell::new(false));
            let slot = Rc::clone(&ran);
            let future: LocalBoxFuture<'static, ()> = Box::pin(async move {
                future.await;
                slot.set(true);
            });
            futures::executor::block_on(future);
            self.spawned.borrow_mut().push(ran.get());
        }
        fn run(&self, run: Box<dyn FnOnce()>) {
            run();
        }
    }

    fn attached() -> (Rc<AfterCommit>, Rc<Host>) {
        let host = Rc::new(Host::default());
        let after = AfterCommit::new();
        let weak: Weak<dyn DeferredHost> = Rc::downgrade(&host) as Weak<dyn DeferredHost>;
        after.attach(weak);
        (after, host)
    }

    #[test]
    fn release_dispatches_each_token_once_in_order_and_drop_discards() {
        let (after, host) = attached();
        let first = after.defer(Deferred::Wake("one".into(), Lane::Control));
        let second = after.defer(Deferred::Wake("two".into(), Lane::Work));
        let dropped = after.defer(Deferred::Wake("three".into(), Lane::Work));
        after.drop_tokens(&[dropped]);
        after.release(&[second, first]);
        assert_eq!(
            *host.woken.borrow(),
            vec![
                ("two".to_string(), Lane::Work),
                ("one".to_string(), Lane::Control)
            ]
        );
        after.release(&[first]);
        assert_eq!(host.woken.borrow().len(), 2, "a token releases once");
        assert_eq!(after.pending(), 0);
    }

    #[test]
    fn a_detached_sink_drops_what_it_holds_and_releases_nothing() {
        let (after, host) = attached();
        let token = after.defer(Deferred::Wake("one".into(), Lane::Work));
        assert_eq!(after.detach(), vec![token]);
        after.release(&[token]);
        assert!(host.woken.borrow().is_empty());
        assert_eq!(after.pending(), 0);
    }

    #[test]
    fn a_released_spawn_actually_runs() {
        let (after, host) = attached();
        let (deferred, ran) = super::super::after_commit::spawned(Lane::Work);
        let token = after.defer(deferred);
        after.release(&[token]);
        assert!(ran.get());
        assert_eq!(*host.spawned.borrow(), vec![true]);
    }
}
