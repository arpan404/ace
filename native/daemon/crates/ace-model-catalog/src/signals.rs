// SPDX-License-Identifier: Apache-2.0
//! Small concurrency pieces the catalog's state machine needs: an abort signal, a
//! one-way gate for per-instance write ordering, and the discovery admission limiter.

use std::collections::VecDeque;
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
struct SignalState {
    aborted: bool,
    wakers: Vec<Waker>,
}

/// An abort signal shared by a flight and the discovery reading it.
#[derive(Debug, Clone, Default)]
pub struct Signal(Arc<Mutex<SignalState>>);

impl Signal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn abort(&self) {
        let wakers = {
            let mut state = lock(&self.0);
            if state.aborted {
                return;
            }
            state.aborted = true;
            std::mem::take(&mut state.wakers)
        };
        for waker in wakers {
            waker.wake();
        }
    }

    pub fn is_aborted(&self) -> bool {
        lock(&self.0).aborted
    }

    /// Resolves once [`Signal::abort`] is called.
    pub fn wait(&self) -> SignalWait {
        SignalWait(self.clone())
    }
}

pub struct SignalWait(Signal);

impl Future for SignalWait {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let mut state = lock(&self.0.0);
        if state.aborted {
            return Poll::Ready(());
        }
        if !state
            .wakers
            .iter()
            .any(|waker| waker.will_wake(context.waker()))
        {
            state.wakers.push(context.waker().clone());
        }
        Poll::Pending
    }
}

#[derive(Debug, Default)]
struct GateState {
    open: bool,
    wakers: Vec<Waker>,
}

/// A one-way gate: closed until opened, and then every waiter resolves.
#[derive(Debug, Clone, Default)]
pub struct Gate(Arc<Mutex<GateState>>);

impl Gate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&self) {
        let wakers = {
            let mut state = lock(&self.0);
            if state.open {
                return;
            }
            state.open = true;
            std::mem::take(&mut state.wakers)
        };
        for waker in wakers {
            waker.wake();
        }
    }

    pub fn wait(&self) -> GateWait {
        GateWait(self.clone())
    }

    /// Whether both names are the same gate.
    pub fn same(&self, other: &Gate) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

pub struct GateWait(Gate);

impl Future for GateWait {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let mut state = lock(&self.0.0);
        if state.open {
            return Poll::Ready(());
        }
        if !state
            .wakers
            .iter()
            .any(|waker| waker.will_wake(context.waker()))
        {
            state.wakers.push(context.waker().clone());
        }
        Poll::Pending
    }
}

struct LimiterState {
    active: usize,
    waiters: VecDeque<futures::channel::oneshot::Sender<()>>,
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
        let receiver = {
            let mut state = lock(&self.state);
            if state.active < self.max {
                state.active += 1;
                None
            } else {
                let (sender, receiver) = futures::channel::oneshot::channel();
                state.waiters.push_back(sender);
                Some(receiver)
            }
        };
        if let Some(receiver) = receiver {
            let _ = receiver.await;
        }
        Permit {
            limiter: self.clone(),
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let next = {
            let mut state = lock(&self.limiter.state);
            state.waiters.pop_front()
        };
        if let Some(next) = next {
            let _ = next.send(());
        } else {
            lock(&self.limiter.state).active -= 1;
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
