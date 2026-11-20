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
