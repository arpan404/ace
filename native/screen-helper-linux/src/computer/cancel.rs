//! Requests in flight and which of them the client cancelled. Used from the stdin thread
//! (cancel is answered at once, outside the serial worker) and from the worker. Also the
//! person's Stop, which ends a batch of actions the same way.
use crate::computer::error::{CuResult, cancelled};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The person's Stop. It ends the batch that is acting, or the next one when it was pressed
/// between calls, and is then used up: a later, unrelated request starts clean.
#[derive(Clone, Default)]
pub struct StopSignal {
    pressed: Arc<AtomicBool>,
    acting: Arc<AtomicBool>,
}

impl StopSignal {
    pub fn press(&self) {
        self.pressed.store(true, Ordering::Release);
    }

    pub fn pressed(&self) -> bool {
        self.pressed.load(Ordering::Acquire)
    }

    /// Marks a batch of actions as running; long waits inside it stop on Stop.
    pub fn set_acting(&self, acting: bool) {
        self.acting.store(acting, Ordering::Release);
    }

    /// Takes the press: true when Stop was pressed since it was last taken.
    pub fn take(&self) -> bool {
        self.pressed.swap(false, Ordering::AcqRel)
    }

    fn stops_now(&self) -> bool {
        self.acting.load(Ordering::Acquire) && self.pressed()
    }
}

#[derive(Clone, Default)]
pub struct Cancellations {
    flags: Arc<Mutex<HashMap<String, bool>>>,
    pub stop: StopSignal,
}

impl Cancellations {
    fn with<R>(&self, f: impl FnOnce(&mut HashMap<String, bool>) -> R) -> R {
        let mut flags = match self.flags.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut flags)
    }

    pub fn register(&self, id: &str) {
        self.with(|flags| flags.insert(id.to_owned(), false));
    }

    pub fn finish(&self, id: &str) {
        self.with(|flags| flags.remove(id));
    }

    /// Marks a queued or running request cancelled. False when no such request is in flight.
    pub fn cancel(&self, id: &str) -> bool {
        self.with(|flags| match flags.get_mut(id) {
            Some(flag) => {
                *flag = true;
                true
            }
            None => false,
        })
    }

    pub fn is_cancelled(&self, id: &str) -> bool {
        self.with(|flags| flags.get(id).copied().unwrap_or(false))
    }

    /// The check long-running work calls between steps and inside waits.
    pub fn checkpoint(&self, id: &str) -> Checkpoint {
        Checkpoint {
            cancellations: self.clone(),
            id: id.to_owned(),
        }
    }
}

#[derive(Clone)]
pub struct Checkpoint {
    cancellations: Cancellations,
    id: String,
}

impl Checkpoint {
    pub fn check(&self) -> CuResult<()> {
        if self.cancellations.is_cancelled(&self.id) {
            Err(cancelled())
        } else if self.cancellations.stop.stops_now() {
            Err(crate::computer::guard::stopped_by_person())
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Cancellations;

    #[test]
    fn only_requests_in_flight_can_be_cancelled() {
        let cancellations = Cancellations::default();
        assert!(!cancellations.cancel("a"));
        cancellations.register("a");
        let check = cancellations.checkpoint("a");
        assert!(check.check().is_ok());
        assert!(cancellations.cancel("a"));
        assert_eq!(check.check().unwrap_err().code, "cancelled");
        cancellations.finish("a");
        assert!(!cancellations.cancel("a"));
    }

    #[test]
    fn stop_ends_a_running_batch_and_is_used_up_once_taken() {
        let cancellations = Cancellations::default();
        cancellations.register("b");
        let check = cancellations.checkpoint("b");
        cancellations.stop.press();
        // A look is not stopped; a batch of actions is.
        assert!(check.check().is_ok());
        cancellations.stop.set_acting(true);
        assert_eq!(check.check().unwrap_err().code, "stopped_by_person");
        assert!(cancellations.stop.take());
        assert!(check.check().is_ok());
        assert!(!cancellations.stop.take());
    }
}
