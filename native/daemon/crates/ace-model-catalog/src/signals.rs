// SPDX-License-Identifier: Apache-2.0
//! Small concurrency pieces the catalog's state machine needs: an abort signal, a
//! one-way gate for per-instance write ordering, and the discovery admission limiter.

use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Default)]
struct Waiters {
    open: bool,
    next: u64,
    wakers: BTreeMap<u64, Waker>,
}

/// A one-way gate: closed until opened, and then every waiter resolves.
#[derive(Debug, Clone, Default)]
pub struct Gate(Arc<Mutex<Waiters>>);

impl Gate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&self) {
        let wakers = {
            let mut state = lock(&self.0);
            state.open = true;
            std::mem::take(&mut state.wakers)
        };
        for waker in wakers.into_values() {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| waker.wake()));
        }
    }

    pub fn wait(&self) -> GateWait {
        GateWait {
            gate: self.clone(),
            token: None,
        }
    }

    pub fn same(&self, other: &Gate) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

pub struct GateWait {
    gate: Gate,
    token: Option<u64>,
}

impl Future for GateWait {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        let waker = context.waker().clone();
        let previous = {
            let mut state = lock(&this.gate.0);
            if state.open {
                return Poll::Ready(());
            }
            let token = *this.token.get_or_insert_with(|| {
                state.next += 1;
                state.next
            });
            state.wakers.insert(token, waker)
        };
        drop(previous);
        Poll::Pending
    }
}

impl Drop for GateWait {
    fn drop(&mut self) {
        if let Some(token) = self.token {
            let waker = lock(&self.gate.0).wakers.remove(&token);
            drop(waker);
        }
    }
}

/// An abort signal shared by a flight and the discovery reading it.
#[derive(Debug, Clone, Default)]
pub struct Signal(Gate);

impl Signal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn abort(&self) {
        self.0.open();
    }

    pub fn is_aborted(&self) -> bool {
        lock(&self.0.0).open
    }

    pub fn same(&self, other: &Signal) -> bool {
        self.0.same(&other.0)
    }

    pub fn wait(&self) -> SignalWait {
        self.0.wait()
    }
}

pub type SignalWait = GateWait;

struct LimiterState {
    active: usize,
    waiters: VecDeque<Gate>,
}

/// At most `max` discoveries at once; the rest wait their turn.
#[derive(Clone)]
pub struct Limiter {
    state: Arc<Mutex<LimiterState>>,
    max: usize,
}

pub struct Permit {
    limiter: Limiter,
}

/// A queued acquisition. Dropped while waiting, it leaves the queue, so an aborted
/// flight never keeps a slot it will not use.
struct PendingAcquire {
    limiter: Limiter,
    gate: Option<Gate>,
}

fn release(state: &mut LimiterState) -> Option<Gate> {
    let next = state.waiters.pop_front();
    if next.is_none() {
        state.active -= 1;
    }
    next
}

impl Drop for PendingAcquire {
    fn drop(&mut self) {
        let Some(gate) = self.gate.take() else {
            return;
        };
        let next = {
            let mut state = lock(&self.limiter.state);
            if let Some(index) = state.waiters.iter().position(|waiter| waiter.same(&gate)) {
                state.waiters.remove(index);
                return;
            }
            // The slot was handed over before this acquisition was dropped.
            release(&mut state)
        };
        if let Some(next) = next {
            next.open();
        }
    }
}

impl Limiter {
    pub fn new(max: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(LimiterState {
                active: 0,
                waiters: VecDeque::new(),
            })),
            max,
        }
    }

    pub async fn acquire(&self) -> Permit {
        let mut pending = PendingAcquire {
            limiter: self.clone(),
            gate: None,
        };
        let gate = {
            let mut state = lock(&self.state);
            if state.active < self.max {
                state.active += 1;
                None
            } else {
                let gate = Gate::new();
                state.waiters.push_back(gate.clone());
                Some(gate)
            }
        };
        if let Some(gate) = gate {
            pending.gate = Some(gate.clone());
            gate.wait().await;
            // The slot is ours; dropping `pending` must not release it.
            pending.gate = None;
        }
        Permit {
            limiter: self.clone(),
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let next = release(&mut lock(&self.limiter.state));
        if let Some(next) = next {
            next.open();
        }
    }
}

#[cfg(test)]
mod tests {
    //! Behaviour the catalog's flights and write queue rest on: a signal wakes waiters,
    //! a gate resolves every waiter once, and the limiter hands a finished slot on.

    use super::*;

    #[test]
    fn an_abort_resolves_every_waiter() {
        let signal = Signal::new();
        assert!(!signal.is_aborted());
        let wait = signal.wait();
        assert!(futures::executor::block_on(async {
            futures::future::select(
                Box::pin(wait),
                Box::pin(async {
                    signal.abort();
                    futures::future::pending::<()>().await
                }),
            )
            .await;
            signal.is_aborted()
        }));
    }

    #[test]
    fn a_gate_resolves_its_waiters_when_opened() {
        let gate = Gate::new();
        let waiting = gate.wait();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
        });
        let opened_gate = gate.clone();
        let opener = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            opened_gate.open();
        });
        futures::executor::block_on(waiting);
        let _ = handle.join();
        let _ = opener.join();
    }

    #[test]
    fn a_dropped_waiter_and_an_old_waker_are_never_called() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::task::Wake;

        #[derive(Default)]
        struct Count(AtomicUsize);
        impl Wake for Count {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }

        let gate = Gate::new();
        let abandoned = Arc::new(Count::default());
        let obsolete = Arc::new(Count::default());
        let live = Arc::new(Count::default());
        let poll = |waiting: &mut GateWait, count: &Arc<Count>| {
            let waker = Waker::from(count.clone());
            assert!(
                Pin::new(waiting)
                    .poll(&mut Context::from_waker(&waker))
                    .is_pending()
            );
        };
        let mut dropped = gate.wait();
        poll(&mut dropped, &abandoned);
        drop(dropped);
        let mut waiting = gate.wait();
        poll(&mut waiting, &obsolete);
        poll(&mut waiting, &live);

        gate.open();
        assert_eq!(abandoned.0.load(Ordering::Relaxed), 0);
        assert_eq!(obsolete.0.load(Ordering::Relaxed), 0);
        assert_eq!(live.0.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn the_limiter_admits_one_discovery_at_a_time() {
        let waker = futures::task::noop_waker();
        let mut context = std::task::Context::from_waker(&waker);
        futures::executor::block_on(async {
            let limiter = Limiter::new(1);
            let first = limiter.acquire().await;
            let mut second = Box::pin(limiter.acquire());
            assert!(second.as_mut().poll(&mut context).is_pending());
            drop(first);
            second.await;
        });
    }
}
