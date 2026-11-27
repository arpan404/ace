// SPDX-License-Identifier: Apache-2.0
//! The shell's timers (`setTimer` and `setBatchTimer`), keyed rather than typed: a timer that
//! fires calls back through `timerFired(key)`.

use ace_engine::futures::channel::oneshot;
use ace_engine::ports::Timer;
use napi::bindgen_prelude::{FnArgs, FunctionRef};

use super::JsPorts;

pub(super) struct ArmedTimer {
    pub(super) sender: Option<oneshot::Sender<()>>,
    pub(super) cancel: Option<FunctionRef<(), ()>>,
}

/// A timer that returns the shell's cancel function.
pub(super) type ArmTimer = FunctionRef<FnArgs<(f64, f64)>, Option<FunctionRef<(), ()>>>;

impl JsPorts {
    pub(super) fn arm_with(&self, timer: &ArmTimer, ms: f64) -> Timer {
        let key = self.next_timer.get();
        self.next_timer.set(key + 1);
        let (sender, receiver) = oneshot::channel();
        self.timers.borrow_mut().insert(
            key,
            ArmedTimer {
                sender: Some(sender),
                cancel: None,
            },
        );
        let cancel = self
            .call(
                timer,
                FnArgs {
                    data: (key as f64, ms),
                },
            )
            .ok()
            .flatten();
        if let Some(entry) = self.timers.borrow_mut().get_mut(&key) {
            entry.cancel = cancel;
        }
        Timer {
            key,
            fired: receiver,
        }
    }

    /// Timers still armed, for the probe's close check.
    #[cfg(feature = "engine-probe")]
    pub fn timer_count(&self) -> usize {
        self.timers.borrow().len()
    }

    /// A timer fired: its waiting task becomes runnable (the send is the producer's wake).
    pub fn timer_fired(&self, key: u64) {
        let sender = self
            .timers
            .borrow_mut()
            .get_mut(&key)
            .and_then(|entry| entry.sender.take());
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
    }
}
