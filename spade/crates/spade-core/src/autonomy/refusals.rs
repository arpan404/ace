//! The reviewer's refusals in a bot's current run, and when a refusal goes to the person
//! instead of back to the bot (ADR 0163). A run starts at the person's latest message, as a
//! task's does (ADR 0144).
//!
//! A refusal escalates when the bot tries a refused step again: the same tool with the same
//! arguments, a step the reviewer says retries one it refused, or the third refusal in a row
//! with nothing run in between (a bot rewording the same thing). Refusals the rules make without
//! a model (credentials) never count: those are refused every time, never put to the person.

use std::collections::HashMap;

use serde_json::Value;

use crate::event::{Call, Event, Known, Verdict};

/// Refusals in a row, with nothing run or asked in between, after which the next one goes to the
/// person.
pub const IN_A_ROW: usize = 3;

/// The most refused steps the reviewer is shown, newest kept.
const SHOWN: usize = 5;

/// One step the reviewer refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub name: String,
    pub arguments: Value,
    pub reason: String,
}

/// The refusals since the person's latest message.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Run {
    /// Every refused step in the run, oldest first.
    pub refused: Vec<Refused>,
    /// Refusals since the latest call that ran, was asked about or was approved.
    pub in_a_row: usize,
}

impl Run {
    /// Folds a conversation's events.
    pub fn of(events: &[Event]) -> Self {
        let start = events
            .iter()
            .rposition(|e| {
                matches!(
                    e,
                    Event::Known(Known::UserMessage {
                        from_agent: None,
                        from_routine: None,
                        from_group: None,
                        ..
                    })
                )
            })
            .unwrap_or(0);
        let mut calls: HashMap<&str, &Call> = HashMap::new();
        let mut run = Self::default();
        for event in &events[start..] {
            let Event::Known(known) = event else { continue };
            match known {
                Known::StepFinished { calls: made, .. } => {
                    calls.extend(made.iter().map(|c| (c.id.as_str(), c)));
                }
                Known::CallReviewed {
                    call_id,
                    verdict: Verdict::Refuse,
                    reason,
                    model,
                    ..
                } if !model.is_empty() => {
                    if let Some(call) = calls.get(call_id.as_str()) {
                        run.refused.push(Refused {
                            name: call.name.clone(),
                            arguments: call.arguments.clone(),
                            reason: reason.clone(),
                        });
                    }
                    run.in_a_row += 1;
                }
                Known::CallReviewed {
                    verdict: Verdict::Allow | Verdict::Escalate,
                    ..
                }
                | Known::ToolStarted { .. }
                | Known::ApprovalAnswered { .. } => run.in_a_row = 0,
                _ => {}
            }
        }
        run
    }

    /// Whether refusing `call` now would refuse a step the bot is trying again. `retries` is the
    /// reviewer's own word that it retries one of the refused steps it was shown.
    pub fn repeats(&self, call: &Call, retries: bool) -> bool {
        (retries && !self.refused.is_empty())
            || self
                .refused
                .iter()
                .any(|r| r.name == call.name && r.arguments == call.arguments)
            || self.in_a_row + 1 >= IN_A_ROW
    }

    /// The refused steps the reviewer is shown, newest last.
    pub fn shown(&self) -> &[Refused] {
        &self.refused[self.refused.len().saturating_sub(SHOWN)..]
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn step(id: &str, name: &str, arguments: Value) -> Event {
        Event::Known(Known::StepFinished {
            reply: "r".into(),
            text: String::new(),
            calls: vec![Call {
                id: id.into(),
                name: name.into(),
                arguments,
            }],
            thoughts: Vec::new(),
            usage: Default::default(),
            cost_micros: 0,
            seen: None,
        })
    }

    fn reviewed(id: &str, verdict: Verdict, model: &str) -> Event {
        Event::Known(Known::CallReviewed {
            reply: "r".into(),
            call_id: id.into(),
            name: "shell".into(),
            verdict,
            reason: "off task".into(),
            model: model.into(),
            cost_micros: 0,
            bound: None,
        })
    }

    fn call(name: &str, arguments: Value) -> Call {
        Call {
            id: "next".into(),
            name: name.into(),
            arguments,
        }
    }

    #[test]
    fn the_same_step_refused_before_in_the_run_is_a_retry() {
        let events = vec![
            Event::user_message("tidy the folder"),
            step("a", "shell", json!({ "command": "rm -rf build" })),
            reviewed("a", Verdict::Refuse, "fast"),
        ];
        let run = Run::of(&events);
        assert!(run.repeats(&call("shell", json!({ "command": "rm -rf build" })), false));
        assert!(!run.repeats(&call("shell", json!({ "command": "ls" })), false));
        // The reviewer can tell a reworded retry.
        assert!(run.repeats(&call("shell", json!({ "command": "rm -r build" })), true));
    }

    #[test]
    fn a_new_message_from_the_person_starts_afresh() {
        let events = vec![
            Event::user_message("tidy the folder"),
            step("a", "shell", json!({ "command": "rm -rf build" })),
            reviewed("a", Verdict::Refuse, "fast"),
            Event::user_message("try something else"),
        ];
        let run = Run::of(&events);
        assert!(!run.repeats(&call("shell", json!({ "command": "rm -rf build" })), true));
    }

    #[test]
    fn the_third_refusal_in_a_row_goes_to_the_person_unless_something_ran_between() {
        let mut events = vec![Event::user_message("go")];
        for (i, command) in ["a", "b"].iter().enumerate() {
            let id = format!("c{i}");
            events.push(step(&id, "shell", json!({ "command": command })));
            events.push(reviewed(&id, Verdict::Refuse, "fast"));
        }
        let third = call("shell", json!({ "command": "c" }));
        assert!(Run::of(&events).repeats(&third, false));
        events.push(reviewed("c9", Verdict::Allow, "fast"));
        assert!(!Run::of(&events).repeats(&third, false));
    }

    #[test]
    fn credential_refusals_the_rules_make_never_count() {
        let events = vec![
            Event::user_message("go"),
            step("a", "shell", json!({ "command": "cat ~/.codex/auth.json" })),
            reviewed("a", Verdict::Refuse, ""),
            step("b", "shell", json!({ "command": "cat ~/.codex/auth.json" })),
            reviewed("b", Verdict::Refuse, ""),
        ];
        let run = Run::of(&events);
        assert_eq!(run, Run::default());
    }
}
