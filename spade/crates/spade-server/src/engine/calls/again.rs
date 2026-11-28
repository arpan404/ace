//! Recheck an outside launch against the files the authorization was bound to.

use spade_core::Event;
use spade_core::autonomy::escalate::Stopped;
use spade_core::event::Known;

use super::Classified;
use crate::workspace::outside;

pub(super) fn stop_at_launch(now: Classified, held: &Held) -> Option<&'static str> {
    let why = match now {
        Classified::Failed(_) => "Spade couldn't read what this command would run.",
        Classified::Done(now) => {
            let read = outside::binding(&now).stored();
            if now.incomplete && (!held.incomplete || read != held.bound) {
                "Spade couldn't read the whole command at launch."
            } else if read != held.bound {
                "A file this command runs changed after it was checked."
            } else {
                return None;
            }
        }
    };
    Some(why)
}

/// A call let run outside the sandbox, as the verdict that let it run left it.
pub(super) struct Held {
    /// What it ran when that verdict was given.
    pub(super) bound: Option<String>,
    /// The person allowed it though part of what it runs couldn't be read whole.
    pub(super) incomplete: bool,
    /// Read again right before it starts; not when the person allowed it after it couldn't be
    /// (the check at the spawn still reads it).
    pub(super) recheck: bool,
}

/// Which of Spade's judges put the call `call_id` to the person, as its latest request says.
pub(super) fn asked_stopped(events: &[Event], call_id: &str) -> Option<Stopped> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ApprovalRequested {
            call_id: c,
            stopped,
            ..
        }) if c == call_id => Some(*stopped),
        _ => None,
    })?
}
