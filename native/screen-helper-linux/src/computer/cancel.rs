//! Requests in flight and which of them the client cancelled. Used from the stdin thread
//! (cancel is answered at once, outside the serial worker) and from the worker.
use crate::computer::error::{CuResult, cancelled};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct Cancellations {
    flags: Arc<Mutex<HashMap<String, bool>>>,
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
}
