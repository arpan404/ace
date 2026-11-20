//! Which bots have a package update or rollback being applied now (ADR 0200 §6.2): such a bot
//! reads `updating`, which counts as working, from the moment the step is taken until it
//! commits or fails, so it never reads done or idle while its package changes under it.

use std::collections::HashMap;
use std::sync::Mutex;

use super::Engine;

/// The conversations being updated, each with how many steps hold it.
#[derive(Default)]
pub(super) struct Shared(Mutex<HashMap<String, usize>>);

/// A bot marked as updating; unmarked when dropped.
pub(crate) struct Updating<'a> {
    engine: &'a Engine,
    conversation: String,
}

impl Drop for Updating<'_> {
    fn drop(&mut self) {
        {
            let mut held = self
                .engine
                .updating
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if let Some(count) = held.get_mut(&self.conversation) {
                *count -= 1;
                if *count == 0 {
                    held.remove(&self.conversation);
                }
            }
        }
        self.engine.announce(&self.conversation);
    }
}

impl Engine {
    /// Marks `agent` as updating until the answer is dropped; `None` for no such bot.
    pub(crate) fn mark_updating(&self, agent: &str) -> Option<Updating<'_>> {
        let conversation = self.store.agent(agent).ok()??.conversation;
        *self
            .updating
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(conversation.clone())
            .or_default() += 1;
        self.announce(&conversation);
        self.registering("package_step", &conversation);
        Some(Updating {
            engine: self,
            conversation,
        })
    }

    /// Whether the bot of `conversation` has an update or rollback being applied now.
    pub(crate) fn is_updating(&self, conversation: &str) -> bool {
        self.updating
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(conversation)
    }
}
