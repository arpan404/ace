//! What a conversation waits on the person for, one entry per open approval or question, in the
//! order asked, so the roster can say why a bot needs them ("Wants to pay €412 to TAP Air
//! Portugal") and not only that it does. A pure fold over the stored events.

use serde_json::{Value, json};

use crate::event::{Event, Known};
use crate::question::{Standing, views};

/// The most entries sent: a client says the first few and counts the rest.
pub const MOST: usize = 8;

/// The most of an approval's arguments sent; bigger ones are left out (the words come from a
/// recipient or an amount, which are short).
const ARGUMENTS_BYTES: usize = 2_000;

/// The open asks. `awaiting` is the call ids of the approvals the open reply still waits on;
/// `asking` whether a question it asked is unanswered (`Transcript::awaiting`, `Transcript::asking`).
///
/// Each entry is `{"kind":"approval","name","arguments"?,"effect"?,"reviewer_reason"?}`,
/// `{"kind":"question","prompt"}` or `{"kind":"connect","app"}`.
pub fn open<'a>(
    events: impl IntoIterator<Item = &'a Event> + Clone,
    awaiting: &[String],
    asking: bool,
) -> Vec<Value> {
    let mut found = Vec::new();
    if !awaiting.is_empty() {
        for event in events.clone() {
            let Event::Known(Known::ApprovalRequested {
                call_id,
                name,
                arguments,
                reviewer_reason,
                effect,
                ..
            }) = event
            else {
                continue;
            };
            if !awaiting.contains(call_id) {
                continue;
            }
            let mut entry = json!({ "kind": "approval", "name": name });
            if arguments.to_string().len() <= ARGUMENTS_BYTES {
                entry["arguments"] = arguments.clone();
            }
            if let Some(effect) = effect {
                entry["effect"] = json!(effect.name());
            }
            if let Some(reason) = reviewer_reason {
                entry["reviewer_reason"] = json!(reason);
            }
            found.push(entry);
        }
    }
    if asking {
        for card in views(events)
            .into_iter()
            .filter(|card| card.standing == Standing::Waiting)
        {
            for question in &card.questions {
                let shown = serde_json::to_value(question).unwrap_or(Value::Null);
                found.push(if shown["kind"] == "connect" {
                    json!({ "kind": "connect", "app": shown["name"] })
                } else {
                    json!({ "kind": "question", "prompt": question.prompt })
                });
            }
        }
    }
    found.truncate(MOST);
    found
}
