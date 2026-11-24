//! Learned tool pinning (spade/docs/harness.md, Tools): a deferred tool a bot keeps reaching for
//! is offered up front from its next conversation or compaction, never mid-conversation, so the
//! prompt's top stays byte-stable for the provider's cache (docs/design.md, Caching).
//!
//! Two small settings per bot: how often it ran each deferred tool (`tools.uses.<agent>`), and
//! the pins frozen for the conversation now (`tools.pinned.<agent>`). `spade_core::tools::pinning`
//! decides both from those strings alone.

use spade_core::tools::pinning;

use super::Engine;

/// Where a bot's deferred tool uses are stored.
fn uses_key(agent: &str) -> String {
    format!("tools.uses.{agent}")
}

/// Where the pins offered to a bot now are stored, frozen until its next compaction.
fn pinned_key(agent: &str) -> String {
    format!("tools.pinned.{agent}")
}

impl Engine {
    /// The agent whose tools `id` shares: a helper's or a lane's is its bot's.
    fn tool_agent(&self, id: &str) -> Option<String> {
        match self.hidden_of(id) {
            Some(hidden) => self.agent_of(&hidden.parent),
            None => self.agent_of(id),
        }
    }

    /// Whether `id` is offered its bot's list: the bot's own conversation, or a lane's, which
    /// takes it byte for byte (ADR 0217 §8). A helper keeps its profile's narrower list.
    fn shares_bot_list(&self, id: &str) -> bool {
        match self.hidden_of(id) {
            Some(hidden) => hidden.profile == spade_core::lane::PROFILE,
            None => true,
        }
    }

    /// The deferred tools `id` is offered up front, frozen for its conversation. The first call
    /// of a conversation (or of a build before pinning) freezes what the bot has learned; later
    /// calls read the same names, so the list never changes mid-conversation.
    pub(super) fn pins_for(&self, id: &str) -> Vec<String> {
        if !self.shares_bot_list(id) {
            return Vec::new();
        }
        let Some(agent) = self.tool_agent(id) else {
            return Vec::new();
        };
        let key = pinned_key(&agent);
        if let Ok(Some(text)) = self.store.setting(&key) {
            return pinning::names(&text);
        }
        let names = self.learned_pins(&agent);
        self.store_pins(&key, &names);
        names
    }

    /// Notes that `id` ran `name`, for its bot's next conversation or compaction. Only deferred
    /// tools count: the core ones are offered anyway.
    pub(super) fn note_tool_use(&self, id: &str, name: &str) {
        let Some(agent) = self.tool_agent(id) else {
            return;
        };
        let key = uses_key(&agent);
        let mut uses = match self.store.setting(&key) {
            Ok(Some(text)) => pinning::Uses::parse(&text),
            Ok(None) => pinning::Uses::default(),
            Err(error) => {
                tracing::warn!(%error, "could not read a bot's tool uses");
                return;
            }
        };
        uses.record(name);
        if let Err(error) = self.store.set_setting(&key, Some(&uses.text())) {
            tracing::warn!(%error, "could not store a bot's tool uses");
        }
    }

    /// Freezes the bot's pins again, after a compaction: the one point a conversation's prompt
    /// top may change (docs/design.md, Caching).
    pub(super) fn refreeze_pins(&self, id: &str) {
        if !self.shares_bot_list(id) {
            return;
        }
        let Some(agent) = self.tool_agent(id) else {
            return;
        };
        let names = self.learned_pins(&agent);
        self.store_pins(&pinned_key(&agent), &names);
    }

    /// What the bot has run often enough to pin, from its stored uses.
    fn learned_pins(&self, agent: &str) -> Vec<String> {
        match self.store.setting(&uses_key(agent)) {
            Ok(Some(text)) => pinning::Uses::parse(&text).pinned(),
            Ok(None) => Vec::new(),
            Err(error) => {
                tracing::warn!(%error, "could not read a bot's tool uses");
                Vec::new()
            }
        }
    }

    fn store_pins(&self, key: &str, names: &[String]) {
        if let Err(error) = self
            .store
            .set_setting(key, Some(&pinning::names_text(names)))
        {
            tracing::warn!(%error, "could not store a bot's pinned tools");
        }
    }
}
