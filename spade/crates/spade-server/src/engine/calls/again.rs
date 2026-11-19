//! A call that couldn't be vouched for right before it started outside the sandbox (ADR 0163,
//! amendment 3): what it runs couldn't be read again, couldn't be read whole, or changed after its
//! verdict. It doesn't start on that verdict; the person is asked again, on what it runs now.

use serde_json::Value;
use spade_core::Event;
use spade_core::autonomy::escalate::{self, Settled, Stop, Stopped};
use spade_core::effect;
use spade_core::event::{Authorized, Call, Known, Verdict};

use super::super::Engine;
use super::Classified;
use crate::workspace::outside;

/// Why a call that would start outside the sandbox now can't, if it can't: with what it runs as
/// read now, which the person's answer will bind.
pub(super) fn stop_at_launch(
    now: Classified,
    held: &Held,
) -> Option<(Stop<'static>, Option<String>)> {
    match now {
        Classified::Failed(_) => Some((Stop::UnreadAtLaunch, held.bound.clone())),
        Classified::Done(now) => {
            let read = outside::binding(&now).stored();
            if now.incomplete && (!held.incomplete || read != held.bound) {
                Some((Stop::IncompleteAtLaunch, read))
            } else if read != held.bound {
                Some((Stop::ChangedAtLaunch, read))
            } else {
                None
            }
        }
    }
}

/// A call let run outside the sandbox, as the verdict that let it run left it.
pub(super) struct Held {
    /// What it ran when that verdict was given.
    pub(super) bound: Option<String>,
    /// The most that verdict lets it launch.
    pub(super) limit: Authorized,
    /// The person allowed it though part of what it runs couldn't be read whole.
    pub(super) incomplete: bool,
    /// Read again right before it starts; not when the person allowed it after it couldn't be
    /// (the check at the spawn still reads it).
    pub(super) recheck: bool,
    /// What an Always allow of it covers, for a request asked again.
    pub(super) scope: Option<String>,
    /// The `ask` it was put to the person with, kept when it is asked again.
    pub(super) ask: Option<effect::Ask>,
}

/// A call asked about again right before it would have started.
pub(super) struct Again<'a> {
    pub(super) call: &'a Call,
    pub(super) name: &'a str,
    pub(super) arguments: &'a Value,
    pub(super) held: &'a Held,
    /// What it runs as read now, which the person's answer binds.
    pub(super) read: Option<String>,
}

/// Puts a call that couldn't be vouched for at its launch to the person, never running the
/// verdict it had: a verdict stored for this reading, then the request. `Ok(false)` when the
/// reply was stopped.
pub(super) fn ask_again(
    engine: &Engine,
    id: &str,
    reply: &str,
    again: Again<'_>,
    stop: Stop<'_>,
) -> Result<bool, spade_store::StoreError> {
    let Settled::Ask { line, stopped } = escalate::settle(stop) else {
        return Ok(true);
    };
    let Again {
        call,
        name,
        arguments,
        held,
        read,
    } = again;
    let reviewed = super::super::autonomy::record_rule(
        engine,
        id,
        reply,
        call,
        name,
        Verdict::Escalate,
        &line,
        read,
        held.limit,
    )?;
    if !reviewed {
        return Ok(false);
    }
    let asked = Event::Known(Known::ApprovalRequested {
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: name.to_owned(),
        arguments: arguments.clone(),
        scope: held.scope.clone(),
        reviewer_reason: Some(line),
        ask: held.ask,
        tool_key: None,
        app: None,
        acts_in: None,
        helper: None,
        launch: Some(held.limit),
        stopped: Some(stopped),
    });
    match engine.helper_of(id) {
        Some(helper) => engine.ask_for_helper(&helper, reply, &asked),
        None => engine.record_unless_stopped(id, reply, &asked),
    }
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
