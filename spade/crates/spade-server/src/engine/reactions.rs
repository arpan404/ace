//! Reactions (docs/chat-core.md, Messages, ids and replies): the person's through the API and the
//! bot's from a `<react>` in its words. Each is stored and served like any event; it opens no
//! reply, steers none and marks nothing unseen. The rules are `spade_core::reaction`.

use std::collections::BTreeMap;

use spade_core::event::ReactionBy;
use spade_core::reaction::{self, ReactionGroup};
use spade_store::StoreError;

use super::Engine;

#[derive(Debug, thiserror::Error)]
pub enum ReactError {
    #[error("no such conversation")]
    NotFound,
    #[error("no such message")]
    NoMessage,
    #[error("a reaction is one emoji of at most 16 bytes, with no spaces")]
    Emoji,
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl Engine {
    /// The person reacts `emoji` to `message` in conversation `id`, replacing their earlier one.
    pub fn react(&self, id: &str, message: &str, emoji: &str) -> Result<(), ReactError> {
        if !reaction::fits(emoji) {
            return Err(ReactError::Emoji);
        }
        self.reaction_target(id, message)?;
        self.record(id, &reaction::reacted(message, emoji, ReactionBy::Person))?;
        Ok(())
    }

    /// The person takes back their reaction to `message` in conversation `id`.
    pub fn take_back_reaction(&self, id: &str, message: &str) -> Result<(), ReactError> {
        self.reaction_target(id, message)?;
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let events = self.load(id)?;
        self.append(
            id,
            &reaction::taken_back(&events, message, ReactionBy::Person),
        )?;
        Ok(())
    }

    /// Standing reactions per message in conversation `id`, grouped as `{ emoji, by[] }`.
    /// `None` when no such conversation exists.
    pub fn reactions_summary(
        &self,
        id: &str,
    ) -> Result<Option<BTreeMap<String, Vec<ReactionGroup>>>, StoreError> {
        if !self.reachable(id)? || self.deleting(id) {
            return Ok(None);
        }
        let events = self.load(id)?;
        Ok(Some(reaction::summarize(&events)))
    }

    /// Standing reactions on one `message` in conversation `id`, grouped as `{ emoji, by[] }`.
    pub fn message_reactions(
        &self,
        id: &str,
        message: &str,
    ) -> Result<Vec<ReactionGroup>, ReactError> {
        self.reaction_target(id, message)?;
        let events = self.load(id)?;
        Ok(reaction::for_message(&events, message))
    }

    /// Stores the reactions in a bot's finished words, each on a message that is there; one on
    /// an id that names nothing is dropped.
    pub(super) fn bot_reactions(&self, id: &str, reactions: &[(String, String)]) {
        for (message, emoji) in reactions {
            if !self.names_message(id, message) {
                continue;
            }
            if let Err(error) = self.record(id, &reaction::reacted(message, emoji, ReactionBy::Bot))
            {
                tracing::warn!(%error, "the bot's reaction could not be stored");
            }
        }
    }

    /// Stores the reactions from club member `agent` in club transcript `id`, each on a message
    /// that is there; one on an id that names nothing is dropped.
    pub(super) fn member_reactions(&self, id: &str, agent: &str, reactions: &[(String, String)]) {
        for (message, emoji) in reactions {
            if !self.names_message(id, message) {
                continue;
            }
            if let Err(error) = self.record(id, &reaction::reacted_as(message, emoji, agent)) {
                tracing::warn!(%error, "a club member's reaction could not be stored");
            }
        }
    }

    fn reaction_target(&self, id: &str, message: &str) -> Result<(), ReactError> {
        if !self.reachable(id)? || self.deleting(id) {
            return Err(ReactError::NotFound);
        }
        if !self.names_message(id, message) {
            return Err(ReactError::NoMessage);
        }
        Ok(())
    }

    /// Whether `message` is the id of a message in conversation `id`.
    fn names_message(&self, id: &str, message: &str) -> bool {
        self.quote(id, Some(message)).is_some()
    }
}
