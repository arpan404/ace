// SPDX-License-Identifier: Apache-2.0
//! A hand-driven clock for the relay's tests, shared by the NK modules.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};

use super::admission::{Cancel, NkClock};

struct Timer {
    id: u64,
    at: i64,
    run: Box<dyn FnOnce() + Send>,
}

pub(crate) struct ManualClock {
    now: Arc<Mutex<i64>>,
    timers: Arc<Mutex<Vec<Timer>>>,
    next: Arc<Mutex<u64>>,
}

impl ManualClock {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            now: Arc::new(Mutex::new(1_000_000)),
            timers: Arc::new(Mutex::new(Vec::new())),
            next: Arc::new(Mutex::new(0)),
        })
    }

    pub(crate) fn advance(&self, milliseconds: i64) {
        {
            let mut now = self.now.lock().unwrap();
            *now += milliseconds;
        }
        let now = *self.now.lock().unwrap();
        let due: Vec<Timer> = {
            let mut timers = self.timers.lock().unwrap();
            let (due, later) = timers.drain(..).partition(|timer| timer.at <= now);
            timers.extend(later);
            due
        };
        for timer in due {
            (timer.run)();
        }
    }

    pub(crate) fn pending(&self) -> usize {
        self.timers.lock().unwrap().len()
    }
}

impl NkClock for ManualClock {
    fn now(&self) -> i64 {
        *self.now.lock().unwrap()
    }

    fn schedule(&self, milliseconds: i64, run: Box<dyn FnOnce() + Send>) -> Cancel {
        let id = {
            let mut next = self.next.lock().unwrap();
            *next += 1;
            *next
        };
        let at = self.now() + milliseconds;
        self.timers.lock().unwrap().push(Timer { id, at, run });
        let timers = Arc::clone(&self.timers);
        Box::new(move || {
            timers.lock().unwrap().retain(|timer| timer.id != id);
        })
    }
}
