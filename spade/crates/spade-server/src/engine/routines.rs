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

    /// Stores the routine's message in `conversation`, where it starts a turn or steers the open
    /// one, and returns its seq.
    pub(crate) fn deliver_routine(
        self: &Arc<Self>,
        conversation: &str,
        text: &str,
        from: FromRoutine,
    ) -> Result<i64, RoutineDeliveryError> {
        // A bot moving to another machine runs no routine meanwhile (ADR 0187).
        if self.frozen(conversation) {
            return Err(RoutineDeliveryError::Disabled);
        }
        if !self.reachable(conversation)? || self.deleting(conversation) {
            return Err(RoutineDeliveryError::Gone);
        }
        if self.disabled_main(conversation)? {
            return Err(RoutineDeliveryError::Disabled);
        }
        let run = from.run.clone();
        // A trigger that says `"verify": true` opens a goal for the run (ADR 0204 §3), stored
        // right after its message; the message tells the bot.
        let note = self.routine_goal_note(conversation, text, &from);
        let text = match &note {
            Some(note) => format!("{}\n\n{note}", text.trim()),
            None => text.trim().to_owned(),
        };
        let message = Event::Known(Known::UserMessage {
            text,
            context: None,
            images: Vec::new(),
            documents: Vec::new(),
            voice: None,
            from_agent: None,
            from_routine: Some(Box::new(from.clone())),
            from_group: None,
            from_thread: None,
        });
        // The instruction is the person's own words: it recalls notes like their messages do.
        let message = super::memory::with_recall(self, conversation, message);
        self.deliver(conversation, &message).map_err(|e| match e {
            StoreError::NoConversation(_) => RoutineDeliveryError::Gone,
            e => RoutineDeliveryError::Store(e),
        })?;
        if note.is_some() {
            self.open_routine_goal(conversation, &from)?;
        }
        self.routine_message_seq(conversation, &run)?
            .ok_or(RoutineDeliveryError::Gone)
    }

    /// The goal a run of `from`'s routine opens, when its trigger says `"verify": true`, with
    /// the package's `criterion` checks as its criteria.
    fn routine_goal(
        &self,
        conversation: &str,
        instruction: &str,
        from: &FromRoutine,
    ) -> Option<(Known, String)> {
        let link = self
            .agent_of(conversation)
            .and_then(|agent| self.bot_package(&agent))?;
        if from.heartbeat || !link.manifest.verifies(&from.name) {
            return None;
        }
        let events = self.load(conversation).ok()?;
        // Delivered again after a restart: the goal it opened stands.
        if spade_core::goal::view::run_check(events.iter(), &from.run).is_some() {
            return None;
        }
        let required = spade_core::package::checks::criteria(&link.manifest.checks);
        spade_core::goal::change::routine_goal(
            &events,
            &from.name,
            instruction,
            &required,
            &from.run,
        )
    }

    /// The note the run's message carries when it opens a goal.
    fn routine_goal_note(
        &self,
        conversation: &str,
        instruction: &str,
        from: &FromRoutine,
    ) -> Option<String> {
        self.routine_goal(conversation, instruction, from)
            .map(|(_, note)| note)
    }

    /// Stores the goal of run `from.run`, right after its message, unless a goal opened since.
    fn open_routine_goal(
        &self,
        conversation: &str,
        from: &FromRoutine,
    ) -> Result<(), RoutineDeliveryError> {
        let instruction = self
            .store
            .routine(&from.id)?
            .map(|r| r.instruction)
            .unwrap_or_default();
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((goal, _)) = self.routine_goal(conversation, &instruction, from) {
            self.append(conversation, &Event::Known(goal))?;
        }
        Ok(())
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
