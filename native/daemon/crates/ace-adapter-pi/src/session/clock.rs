// SPDX-License-Identifier: Apache-2.0
//! The session's clock (`io.now`) and timers (`io.schedule`), injected so a test controls both.

use std::time::Instant;

use futures::future::BoxFuture;

/// `io.now()`: milliseconds since any fixed origin; only differences matter.
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> f64;
}

/// The daemon's clock: a monotonic reading started when it asks for one.
pub struct MonotonicClock {
    origin: Instant,
}

impl MonotonicClock {
    pub fn start() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Clock for MonotonicClock {
    fn now(&self) -> f64 {
        self.origin.elapsed().as_secs_f64() * 1_000.0
    }
}

/// `io.schedule`: the session's timers. `after` fires a callback; `sleep` waits for the stop
/// plan's polls. A test fires `after` by hand and makes `sleep` immediate.
pub trait Timer: Send + Sync + 'static {
    /// Runs `fire` after `ms` unless the returned guard is called first.
    fn after(&self, ms: f64, fire: Box<dyn Fn() + Send + Sync>) -> Box<dyn Fn() + Send + Sync>;
    /// Waits `ms`.
    fn sleep(&self, ms: f64) -> BoxFuture<'static, ()>;
}

/// The daemon's timers: tokio timers on the runtime that spawned the child.
pub struct TokioTimer;

impl Timer for TokioTimer {
    fn after(&self, ms: f64, fire: Box<dyn Fn() + Send + Sync>) -> Box<dyn Fn() + Send + Sync> {
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&cancelled);
        let ms = if ms.is_finite() && ms > 0.0 { ms } else { 0.0 };
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs_f64(ms / 1_000.0)).await;
            if !flag.load(std::sync::atomic::Ordering::SeqCst) {
                fire();
            }
        });
        Box::new(move || {
            cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        })
    }

    fn sleep(&self, ms: f64) -> BoxFuture<'static, ()> {
        let ms = if ms.is_finite() && ms > 0.0 { ms } else { 0.0 };
        Box::pin(tokio::time::sleep(std::time::Duration::from_secs_f64(
            ms / 1_000.0,
        )))
    }
}

/// A test's timer: `after` is recorded and fired on request; `sleep` returns at once. Compiled
/// for the daemon too, so an integration test can drive the session without sleeping.
#[derive(Default)]
pub struct ManualTimer {
    timers: std::sync::Mutex<Vec<Armed>>,
}

/// One armed test timer: its delay and the callback.
type Armed = (f64, Box<dyn Fn() + Send + Sync>);

impl ManualTimer {
    pub fn armed(&self) -> Vec<f64> {
        self.timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(ms, _)| *ms)
            .collect()
    }

    /// Fires every timer armed so far, in order.
    pub fn fire_all(&self) {
        let timers: Vec<_> = {
            let mut timers = self
                .timers
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *timers)
        };
        for (_, fire) in timers {
            fire();
        }
    }
}

impl Timer for ManualTimer {
    fn after(&self, ms: f64, fire: Box<dyn Fn() + Send + Sync>) -> Box<dyn Fn() + Send + Sync> {
        self.timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push((ms, fire));
        Box::new(|| {})
    }

    fn sleep(&self, _ms: f64) -> BoxFuture<'static, ()> {
        // No real waiting, but the other tasks (the exit, the pumps) get their turn.
        Box::pin(tokio::task::yield_now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_monotonic_clock_never_goes_backwards() {
        let clock = MonotonicClock::start();
        let first = clock.now();
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert!(clock.now() > first);
    }

    #[test]
    fn a_manual_timer_fires_only_when_asked() {
        let timer = ManualTimer::default();
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&fired);
        let _guard = timer.after(
            25.0,
            Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)),
        );
        assert_eq!(timer.armed(), vec![25.0]);
        assert!(!fired.load(std::sync::atomic::Ordering::SeqCst));
        timer.fire_all();
        assert!(fired.load(std::sync::atomic::Ordering::SeqCst));
    }
}
