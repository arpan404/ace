//! What routines (ADR 0129, `crate::routines`) need from the engine: its store and clock, and
//! delivering a routine's message as the person's are delivered.

use std::sync::Arc;

use spade_core::Event;
use spade_core::event::{FromRoutine, Known};
use spade_store::{Store, StoreError};

use super::Engine;
use super::roster::State;

/// Why a routine's message was not delivered.
#[derive(Debug, thiserror::Error)]
pub enum RoutineDeliveryError {
    #[error("the bot is gone")]
    Gone,
    #[error("Spade is switched off on this machine")]
    Disabled,
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl Engine {
    pub(crate) fn store(&self) -> &Store {
        &self.store
    }

    pub(crate) fn new_id(&self, prefix: &str) -> String {
        self.ids.next(prefix)
    }

    pub(crate) fn routines_shared(&self) -> &crate::routines::Shared {
        &self.routines
    }

    /// Whether the conversation has no open reply and no background job.
    pub(crate) fn idle(&self, conversation: &str) -> Result<bool, StoreError> {
        Ok(self.activity(conversation)?.state == State::Idle)
    }

    /// Whether today's spending cap leaves room for another turn.
    pub(crate) fn can_spend(&self) -> Result<bool, StoreError> {
        self.within_cap()
    }

    /// Stores the routine's message in `conversation`, where it starts a turn or steers the open
    /// one, and returns its seq.
    pub(crate) fn deliver_routine(
        self: &Arc<Self>,
        conversation: &str,
        text: &str,
        from: FromRoutine,
    ) -> Result<i64, RoutineDeliveryError> {
        if self.store.conversation(conversation)?.is_none() || self.deleting(conversation) {
            return Err(RoutineDeliveryError::Gone);
        }
        if self.disabled_main(conversation)? {
            return Err(RoutineDeliveryError::Disabled);
        }
        let run = from.run.clone();
        let message = Event::Known(Known::UserMessage {
            text: text.trim().to_owned(),
            context: None,
            images: Vec::new(),
            from_agent: None,
            from_routine: Some(Box::new(from)),
            from_group: None,
        });
        // The instruction is the person's own words: it recalls notes like their messages do.
        let message = super::memory::with_recall(self, conversation, message);
        self.deliver(conversation, &message).map_err(|e| match e {
            StoreError::NoConversation(_) => RoutineDeliveryError::Gone,
            e => RoutineDeliveryError::Store(e),
        })?;
        self.routine_message_seq(conversation, &run)?
            .ok_or(RoutineDeliveryError::Gone)
    }

    /// The seq of run `run`'s message in `conversation`, when it is stored.
    pub(crate) fn routine_message_seq(
        &self,
        conversation: &str,
        run: &str,
    ) -> Result<Option<i64>, StoreError> {
        Ok(self
            .store
            .events(conversation, 0)?
            .iter()
            .rev()
            .find_map(|stored| match &stored.event {
                Event::Known(Known::UserMessage {
                    from_routine: Some(from),
                    ..
                }) if from.run == run => Some(stored.seq),
                _ => None,
            }))
    }
}
