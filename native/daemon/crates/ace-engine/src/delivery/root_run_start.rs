// SPDX-License-Identifier: Apache-2.0
//! `root-run-start.ts` (E5.5): the trigger a root run records, and whether its start takes the
//! input ace handed the session.

use ace_json::Value;

/// What a provider calls a run it started for input it was given, not for its own reasons.
const GIVEN_INPUT: [&str; 3] = ["user", "queue", "unknown"];

/// Runs whose start takes the input ace handed the session: given input, ace's own labels for
/// it, and ace's continuations.
const TAKES_INPUT: [&str; 8] = [
    "user",
    "queue",
    "unknown",
    "spawn",
    "parent_agent",
    "schedule",
    "restart",
    "limit_resume",
];

/// The input ace handed the session that no run has taken yet (`pending.handedOver`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandedOver {
    pub kind: String,
    pub trigger: Option<String>,
}

impl HandedOver {
    /// The stored intent header as this rule reads it.
    pub fn from_intent(intent: &crate::intents::header::IntentHeader) -> HandedOver {
        HandedOver {
            kind: intent.kind.clone(),
            trigger: intent.trigger.clone(),
        }
    }
}

/// What a root run's start does with the input ace handed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootRunStart {
    pub trigger: String,
    pub takes_input: bool,
}

/// `rootRunStart`: a run started for given input is that input's run, so it carries the input's
/// own trigger and takes it, whatever the trigger is. Pure.
pub fn root_run_start(trigger: &str, handed: Option<&HandedOver>) -> RootRunStart {
    if let Some(handed) = handed
        && let Some(own) = handed.trigger.as_deref()
        && (handed.kind == "thread.create" || handed.kind == "thread.send")
        && GIVEN_INPUT.contains(&trigger)
    {
        return RootRunStart {
            trigger: own.to_owned(),
            takes_input: true,
        };
    }
    RootRunStart {
        trigger: trigger.to_owned(),
        takes_input: TAKES_INPUT.contains(&trigger),
    }
}

/// The handed-over input a stored intent row names, for a caller holding JSON.
pub fn handed_over(intent: &Value) -> Option<HandedOver> {
    Some(HandedOver {
        kind: intent.get("kind").and_then(Value::as_str)?.to_owned(),
        trigger: intent
            .get("trigger")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handed(kind: &str, trigger: Option<&str>) -> HandedOver {
        HandedOver {
            kind: kind.to_owned(),
            trigger: trigger.map(str::to_owned),
        }
    }

    fn start(trigger: &str, handed: Option<&HandedOver>) -> (String, bool) {
        let result = root_run_start(trigger, handed);
        (result.trigger, result.takes_input)
    }

    #[test]
    fn a_given_input_run_takes_aces_notice_and_carries_its_trigger() {
        let notice = handed("thread.send", Some("background_completion"));
        assert_eq!(
            start("user", Some(&notice)),
            ("background_completion".to_owned(), true)
        );
        assert_eq!(
            start("unknown", Some(&handed("thread.send", Some("goal")))),
            ("goal".to_owned(), true)
        );
        // A delegated child's first message, and a parent's follow-up.
        assert_eq!(
            start("queue", Some(&handed("thread.create", Some("spawn")))),
            ("spawn".to_owned(), true)
        );
        assert_eq!(
            start("user", Some(&handed("thread.send", Some("parent_agent")))),
            ("parent_agent".to_owned(), true)
        );
        // A person's message has no trigger of its own.
        assert_eq!(
            start("user", Some(&handed("thread.send", None))),
            ("user".to_owned(), true)
        );
    }

    #[test]
    fn a_provider_that_woke_for_its_own_reasons_takes_nothing() {
        let notice = handed("thread.send", Some("background_completion"));
        assert_eq!(
            start("background_completion", Some(&notice)),
            ("background_completion".to_owned(), false)
        );
        assert_eq!(start("goal", Some(&notice)), ("goal".to_owned(), false));
        assert_eq!(
            start("subagent_result", Some(&handed("thread.send", None))),
            ("subagent_result".to_owned(), false)
        );
        assert_eq!(
            start("subagent_result", None),
            ("subagent_result".to_owned(), false)
        );
        assert_eq!(start("goal", None), ("goal".to_owned(), false));
    }

    #[test]
    fn ace_hands_a_child_result_as_given_input_and_a_resumed_run_takes_its_own() {
        assert_eq!(
            start(
                "user",
                Some(&handed("thread.send", Some("subagent_result")))
            ),
            ("subagent_result".to_owned(), true)
        );
        assert_eq!(
            start(
                "restart",
                Some(&handed("thread.send", Some("background_completion")))
            ),
            ("restart".to_owned(), true)
        );
    }

    #[test]
    fn only_a_message_is_relabelled_and_another_intent_keeps_its_trigger() {
        assert_eq!(
            start(
                "user",
                Some(&handed("thread.switch", Some("background_completion")))
            ),
            ("user".to_owned(), true)
        );
    }
}
