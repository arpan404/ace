// SPDX-License-Identifier: Apache-2.0
//! `input-fate.ts` (E5.4a): what became of an input the engine accepted, in its precedence.
//! Pure: the caller reads the three facts and gets the fate back.

/// The queue's own words for a message the person took out (`input-fate.ts:45`).
pub const REMOVED_FROM_QUEUE: &str = "Removed from queue";
/// A Stop's words for an input it cancelled before any run took it (`stop-intents.ts`).
pub const CANCELLED_BY_STOP: &str = "Cancelled before delivery";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputFate {
    Waiting,
    Sending,
    Delivered(Option<String>),
    Uncertain,
    Replaced(String),
    Removed,
    Failed(String),
    Unknown,
}

#[derive(Debug, Clone)]
pub struct IntentFacts {
    pub status: String,
    pub uncertain: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InputFacts {
    pub replacement: Option<String>,
    /// Whether the input's transcript item was written.
    pub written: bool,
    pub run_id: Option<String>,
    pub intent: Option<IntentFacts>,
}

/// `inputFate` (`input-fate.ts:54`).
pub fn input_fate(facts: &InputFacts) -> InputFate {
    if let Some(by) = &facts.replacement {
        return InputFate::Replaced(by.clone());
    }
    // A steer joins its run when admitted, before the provider takes it: a lost one stays
    // uncertain, and one back in the queue is still waiting.
    if facts.intent.as_ref().is_some_and(|intent| intent.uncertain) {
        return InputFate::Uncertain;
    }
    if facts
        .intent
        .as_ref()
        .is_some_and(|intent| matches!(intent.status.as_str(), "pending" | "queued"))
    {
        return InputFate::Waiting;
    }
    if let Some(run) = &facts.run_id {
        return InputFate::Delivered(Some(run.clone()));
    }
    // Written, but no run took it and its delivery failed: it will never reach a run.
    if facts
        .intent
        .as_ref()
        .is_some_and(|intent| intent.status == "failed")
    {
        let error = facts
            .intent
            .as_ref()
            .and_then(|intent| intent.error.clone());
        return failed_fate(error);
    }
    if facts.written {
        return InputFate::Delivered(None);
    }
    match facts.intent.as_ref().map(|intent| intent.status.as_str()) {
        None => InputFate::Unknown,
        Some("running") => InputFate::Sending,
        Some("done") => InputFate::Delivered(None),
        // Pending, queued and failed returned above; an unknown status has no fate.
        Some(_) => InputFate::Unknown,
    }
}

fn failed_fate(error: Option<String>) -> InputFate {
    if error.as_deref() == Some(REMOVED_FROM_QUEUE) {
        return InputFate::Removed;
    }
    InputFate::Failed(error.unwrap_or_else(|| "Not sent".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(status: &str, uncertain: bool, error: Option<&str>) -> Option<IntentFacts> {
        Some(IntentFacts {
            status: status.to_owned(),
            uncertain,
            error: error.map(str::to_owned),
        })
    }

    fn facts() -> InputFacts {
        InputFacts {
            replacement: None,
            written: false,
            run_id: None,
            intent: None,
        }
    }

    #[test]
    fn fate_follows_its_precedence() {
        // A replacement wins over an uncertain intent.
        let mut case = facts();
        case.replacement = Some("again".into());
        case.intent = intent("done", true, None);
        assert_eq!(input_fate(&case), InputFate::Replaced("again".to_owned()));
        // Uncertain beats waiting.
        case = facts();
        case.intent = intent("queued", true, None);
        assert_eq!(input_fate(&case), InputFate::Uncertain);
        // Waiting beats a recorded run.
        case = facts();
        case.intent = intent("queued", false, None);
        case.run_id = Some("run".into());
        assert_eq!(input_fate(&case), InputFate::Waiting);
        // A written input that failed a Stop is failed, not delivered.
        case = facts();
        case.written = true;
        case.intent = intent("failed", false, Some(CANCELLED_BY_STOP));
        assert_eq!(
            input_fate(&case),
            InputFate::Failed(CANCELLED_BY_STOP.to_owned())
        );
        // A removed one is removed; a written one with no intent is delivered.
        case = facts();
        case.intent = intent("failed", false, Some(REMOVED_FROM_QUEUE));
        assert_eq!(input_fate(&case), InputFate::Removed);
        case = facts();
        case.written = true;
        assert_eq!(input_fate(&case), InputFate::Delivered(None));
        // The remaining statuses.
        case = facts();
        case.intent = intent("running", false, None);
        assert_eq!(input_fate(&case), InputFate::Sending);
        case.intent = intent("done", false, None);
        assert_eq!(input_fate(&case), InputFate::Delivered(None));
        case.intent = None;
        assert_eq!(input_fate(&case), InputFate::Unknown);
    }

    #[test]
    fn a_failed_input_without_its_own_words_says_not_sent() {
        let mut case = facts();
        case.intent = intent("failed", false, None);
        assert_eq!(input_fate(&case), InputFate::Failed("Not sent".to_owned()));
    }
}
