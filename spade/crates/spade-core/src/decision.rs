//! The decision log (ADR 0165): a choice the bot made on the person's behalf, with its reason,
//! recorded with `decision_log` so the person can read and reverse it without the transcript.
//! These are its rules, with no I/O: the arguments checked, the id given, the log folded.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{Event, Known};

/// The tool a bot records a decision with.
pub const DECISION_LOG: &str = "decision_log";

const MOST_CHOICE: usize = 300;
const MOST_REASON: usize = 800;
const MOST_OPTIONS: usize = 5;
const MOST_OPTION: usize = 200;

/// One recorded decision, as stored in `decision_made`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    /// Given by Spade in order: `d1`, `d2`, …
    pub decision: String,
    /// The `decision_log` call that recorded it.
    pub call_id: String,
    pub choice: String,
    pub reason: String,
    /// The options it set aside.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// The plan item it belongs to (ADR 0159).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
}

/// Every decision in the conversation, oldest first.
pub fn log<'a>(events: impl IntoIterator<Item = &'a Event>) -> Vec<&'a Decision> {
    events
        .into_iter()
        .filter_map(|event| match event {
            Event::Known(Known::DecisionMade(decision)) => Some(decision),
            _ => None,
        })
        .collect()
}

/// Checks a `decision_log` call and gives the decision to store, or why it can't be.
/// Recording the same call twice (a restart) gives the one already stored.
pub fn record(events: &[Event], call_id: &str, arguments: &Value) -> Result<Decision, String> {
    let earlier = log(events);
    if let Some(stored) = earlier.iter().find(|d| d.call_id == call_id) {
        return Ok((*stored).clone());
    }
    let text = |field: &str, most: usize| -> Result<String, String> {
        let value = arguments
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if value.is_empty() {
            return Err(format!("{field} is required: say it in a sentence."));
        }
        if value.chars().count() > most {
            return Err(format!("{field} is longer than {most} characters."));
        }
        Ok(value.to_owned())
    };
    let choice = text("choice", MOST_CHOICE)?;
    let reason = text("reason", MOST_REASON)?;
    let options = match arguments.get("options") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => {
            if list.len() > MOST_OPTIONS {
                return Err(format!("options holds at most {MOST_OPTIONS}."));
            }
            let mut options = Vec::with_capacity(list.len());
            for option in list {
                let Some(option) = option.as_str().map(str::trim).filter(|o| !o.is_empty()) else {
                    return Err("each option is a short, non-empty text.".to_owned());
                };
                if option.chars().count() > MOST_OPTION {
                    return Err(format!(
                        "an option is longer than {MOST_OPTION} characters."
                    ));
                }
                options.push(option.to_owned());
            }
            options
        }
        Some(_) => return Err("options is a list of texts.".to_owned()),
    };
    let item = match arguments.get("item") {
        None | Some(Value::Null) => None,
        Some(Value::String(item)) => {
            let item = item.trim();
            let task = crate::goal::Task::fold(events);
            if task.as_ref().and_then(|t| t.item(item)).is_none() {
                return Err(format!("There is no plan item {item}."));
            }
            Some(item.to_owned())
        }
        Some(_) => return Err("item is a plan item's id, such as 2.1.".to_owned()),
    };
    Ok(Decision {
        decision: format!("d{}", earlier.len() + 1),
        call_id: call_id.to_owned(),
        choice,
        reason,
        options,
        item,
    })
}

/// What the bot reads as the call's result.
pub fn recorded(decision: &Decision) -> String {
    format!(
        "Recorded as decision {}. The person reads it in your digest; carry on.",
        decision.decision
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn made(decision: Decision) -> Event {
        Event::Known(Known::DecisionMade(decision))
    }

    #[test]
    fn decisions_are_numbered_in_order_and_a_repeated_call_gives_the_stored_one()
    -> Result<(), String> {
        let first = record(
            &[],
            "c1",
            &json!({ "choice": "Postgres", "reason": "it is there" }),
        );
        let first = first?;
        assert_eq!(first.decision, "d1");
        let events = vec![made(first.clone())];
        let again = record(&events, "c1", &json!({ "choice": "other", "reason": "x" }));
        assert_eq!(again, Ok(first));
        let second = record(
            &events,
            "c2",
            &json!({ "choice": "Rust", "reason": "speed",
                                                     "options": ["Go", " Zig "] }),
        );
        let second = second?;
        assert_eq!(second.decision, "d2");
        assert_eq!(second.options, vec!["Go".to_owned(), "Zig".to_owned()]);
        Ok(())
    }

    #[test]
    fn a_call_missing_its_choice_or_reason_or_with_bad_options_is_refused_with_why() {
        let cases = [
            (json!({ "reason": "r" }), "choice is required"),
            (
                json!({ "choice": "c", "reason": "  " }),
                "reason is required",
            ),
            (
                json!({ "choice": "c", "reason": "r", "options": "Go" }),
                "a list",
            ),
            (
                json!({ "choice": "c", "reason": "r", "options": [""] }),
                "non-empty",
            ),
            (
                json!({ "choice": "c", "reason": "r", "options": ["a","b","c","d","e","f"] }),
                "at most 5",
            ),
            (
                json!({ "choice": "x".repeat(301), "reason": "r" }),
                "longer than 300",
            ),
            (
                json!({ "choice": "c", "reason": "r", "item": "4" }),
                "no plan item 4",
            ),
        ];
        for (arguments, why) in cases {
            let Err(refused) = record(&[], "c1", &arguments) else {
                panic!("{arguments} was recorded");
            };
            assert!(refused.contains(why), "{arguments}: {refused}");
        }
    }

    #[test]
    fn a_decision_names_a_plan_item_only_when_the_plan_has_it() {
        let events = vec![
            Event::Known(Known::GoalSet {
                goal: "g1".into(),
                title: "Ship".into(),
                text: "Ship it".into(),
                criteria: Vec::new(),
                by: crate::goal::Author::Bot,
                verifier: None,
            }),
            Event::Known(Known::PlanChanged {
                goal: "g1".into(),
                change: crate::goal::Change::Add {
                    item: "1".into(),
                    text: "pick a database".into(),
                    parent: None,
                },
            }),
        ];
        let decision = record(
            &events,
            "c1",
            &json!({ "choice": "SQLite", "reason": "one file", "item": "1" }),
        );
        assert_eq!(decision.map(|d| d.item), Ok(Some("1".to_owned())));
    }
}
