//! Try again on a failed reply (docs/chat-core.md, Try again): the same turn answered again from
//! the same history, in place. Nothing the person sent is posted twice.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use spade_core::Event;
use spade_core::event::Known;

use super::{Engine, SendError};

/// Why a failed reply can't be tried again.
#[derive(Debug, thiserror::Error)]
pub enum RetryError {
    #[error(transparent)]
    Send(#[from] SendError),
    /// The reply isn't the conversation's last, or it didn't fail: something came after it.
    #[error("only the last reply can be tried again, and only when it failed")]
    NotLast,
    #[error("a reply is running; wait for it to end")]
    Busy,
    #[error(
        "the bot isn't taking work right now (its computer is with the person, or Spade is closing)"
    )]
    NotAdmitted,
    #[error(transparent)]
    Store(#[from] spade_store::StoreError),
}

/// Whether `reply` is the conversation's last reply and it failed. Read from the end, so it
/// costs the events since the last reply started, not the whole history.
pub(super) fn last_failed(events: &[Event], reply: &str) -> bool {
    let mut failed = false;
    for event in events.iter().rev() {
        let Event::Known(known) = event else { continue };
        match known {
            Known::ReplyFailed { reply: r, .. } if r == reply => failed = true,
            Known::ReplyStarted { reply: r, .. } => return r == reply && failed,
            _ => {}
        }
    }
    false
}

impl Engine {
    /// Answers the turn of `reply`, the conversation's last reply, which failed, once more: on
    /// the bot's model now (the person may just have chosen one), from the same history. The
    /// failed reply is marked retried in the same write that opens the new one, so a client shows
    /// the new reply in its place and a crash never keeps one without the other.
    pub fn try_again(self: &Arc<Self>, id: &str, reply: &str) -> Result<(), RetryError> {
        if !self.reachable(id)? || self.deleting(id) {
            return Err(SendError::NotFound.into());
        }
        if self.disabled_main(id)? {
            return Err(SendError::Disabled.into());
        }
        if self.store.group_for_conversation(id)?.is_some() {
            return Err(SendError::Group.into());
        }
        if self.helper_of(id).is_some() {
            return Err(SendError::Helper.into());
        }
        if self.lacks_model(id) {
            return Err(SendError::NoModel.into());
        }
        let model = self.reply_model(id);
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(id)?;
            if spade_core::Transcript::fold(events.iter())
                .open_reply()
                .is_some()
            {
                return Err(RetryError::Busy);
            }
            if !last_failed(&events, reply) {
                return Err(RetryError::NotLast);
            }
            if !self.admission.load(Ordering::SeqCst) || self.closed(id) {
                return Err(RetryError::NotAdmitted);
            }
            let retried = Event::Known(Known::ReplyRetried {
                reply: reply.to_owned(),
            });
            let started = Event::reply_started(self.ids.next("r"), model);
            self.append_events(id, &[retried, started])?;
        }
        self.spawn_turn(id);
        Ok(())
    }
}
