//! The stop check (ADR 0215 §3): a reply that would end with an ask still open gets one more
//! step naming it, once per reply. The engine adds what only it knows (a paused bot, a helper).

use super::{Checked, Ledger};
use crate::event::{Event, Known};

/// The `asks_checked` to store before one more step of `reply`, whose last step made no calls;
/// `None` when the reply may end. It runs at most once per reply, names only open asks no
/// earlier check named, and never while a question the bot asked waits on the person.
pub fn due(ledger: &Ledger, reply: &str) -> Option<Checked> {
    if ledger.checked.as_deref() == Some(reply) {
        return None;
    }
    let open: Vec<&super::Ask> = ledger.open_asks().filter(|a| !a.named).collect();
    if open.is_empty() {
        return None;
    }
    // The ledger keeps the open cards, so this never walks the history.
    if ledger.cards.any() {
        return None;
    }
    let listed: Vec<String> = open
        .iter()
        .take(super::block::SHOWN)
        .map(|a| format!("- {}: {}", a.id, super::block::quoted(&a.words)))
        .collect();
    let more = open.len().saturating_sub(listed.len());
    let mut note = format!(
        "<asks_check from=\"spade\">\nStill open:\n{}",
        listed.join("\n")
    );
    if more > 0 {
        note.push_str(&format!("\n+{more} more."));
    }
    note.push_str(
        "\nFinish them or update each with asks (done, dropped, changed, waiting or chat) and a \
         reason. Calling only asks ends the reply.\n</asks_check>",
    );
    Some(Checked {
        reply: reply.to_owned(),
        asks: open.iter().map(|a| a.id.clone()).collect(),
        note,
    })
}

/// Whether `reply` may end now without another model call: its last step answered the stop
/// check's note with `asks` calls only, and every one of them has its result. That step is the
/// check's one extra step.
pub fn settled(events: &[Event], reply: &str) -> bool {
    let mut finished: Vec<&str> = Vec::new();
    for (at, event) in events.iter().enumerate().rev() {
        let Event::Known(known) = event else { continue };
        match known {
            Known::ToolFinished { call_id, .. } => finished.push(call_id),
            Known::StepFinished {
                reply: r, calls, ..
            } if r == reply => {
                if calls.is_empty()
                    || calls.iter().any(|c| c.name != super::ASKS)
                    || calls.iter().any(|c| !finished.contains(&c.id.as_str()))
                {
                    return false;
                }
                // The check must come before this step, within the same reply.
                return checked_before(&events[..at], reply);
            }
            Known::ReplyStarted { .. } => return false,
            _ => {}
        }
    }
    false
}

/// Whether the latest of `before` that matters is `reply`'s stop check, not one of its steps.
fn checked_before(before: &[Event], reply: &str) -> bool {
    for event in before.iter().rev() {
        match event {
            Event::Known(Known::AsksChecked(checked)) => return checked.reply == reply,
            Event::Known(Known::StepFinished { reply: r, .. }) if r == reply => return false,
            Event::Known(Known::ReplyStarted { .. }) => return false,
            _ => {}
        }
    }
    false
}
