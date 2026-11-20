//! One change to a bot's package at a time (ADR 0200 §6.1). An update, a rollback, a switch and a
//! withdrawal each read the bot's link, change what it owns and write the link back: two at once
//! would write back what the other had just changed (a switch the person turned off, on again).
//! Each holds its bot here from its first read to its commit. Runs on the blocking pool, so
//! waiting holds up no async worker.

use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex};

/// The bots whose package is being changed now.
#[derive(Default)]
pub struct Changing(Arc<(Mutex<HashSet<String>>, Condvar)>);

impl Changing {
    /// Waits until no other change to `bot`'s package is under way, then holds it until the
    /// answer is dropped.
    pub fn hold(&self, bot: &str) -> Busy {
        let (held, freed) = &*self.0;
        let mut now = held.lock().unwrap_or_else(|p| p.into_inner());
        while now.contains(bot) {
            now = freed.wait(now).unwrap_or_else(|p| p.into_inner());
        }
        now.insert(bot.to_owned());
        Busy {
            changing: self.0.clone(),
            bot: bot.to_owned(),
        }
    }
}

/// A bot's package held for one change; let go when dropped.
pub struct Busy {
    changing: Arc<(Mutex<HashSet<String>>, Condvar)>,
    bot: String,
}

impl Drop for Busy {
    fn drop(&mut self) {
        let (held, freed) = &*self.changing;
        held.lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.bot);
        freed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    #[test]
    fn a_second_change_to_a_bots_package_waits_for_the_first_and_another_bots_doesnt() {
        let changing = Arc::new(Changing::default());
        let first = changing.hold("a1");
        let (done, finished) = mpsc::channel();
        for bot in ["a1", "a2"] {
            let (changing, done) = (changing.clone(), done.clone());
            std::thread::spawn(move || {
                let _held = changing.hold(bot);
                let _ = done.send(bot);
            });
        }
        // Another bot's change goes ahead; the same bot's waits while the first holds it.
        assert_eq!(finished.recv_timeout(Duration::from_secs(5)), Ok("a2"));
        assert!(finished.recv_timeout(Duration::from_millis(100)).is_err());
        drop(first);
        assert_eq!(finished.recv_timeout(Duration::from_secs(5)), Ok("a1"));
    }
}
