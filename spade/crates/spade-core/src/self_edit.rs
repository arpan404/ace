//! A bot changing itself (spade/docs/agents.md, "A bot's task over time"): its task with
//! `task_update`, its name and face with `profile_update`. Pure: the engine brings the events and
//! whether untrusted content is in view.
//!
//! The rules, in one place:
//! - A task change runs at once while the prompt shows nothing untrusted. With a web page, an
//!   app's answer, a file or another bot's words in view it goes to the person, in every access
//!   level, and no "always" covers it: standing instructions are never rewritten by injected
//!   content.
//! - A name or face change goes to the person, except a bot's own first naming: made from one
//!   message, it names itself in its first reply, while nothing untrusted is in view.

use crate::effect::Route;
use crate::event::{Event, Known, TaskChange};

pub const TASK_UPDATE: &str = "task_update";
pub const PROFILE_UPDATE: &str = "profile_update";

/// The request's line when a task change waits for the person.
pub const TASK_TAINTED: &str = "Content from outside the conversation is in view, so you decide \
whether its task changes.";
/// The request's line for a name or face change after the bot's first naming.
pub const PROFILE_ASKS: &str = "It wants to change its own name or face, so you decide.";

/// Who changed a task: the person, or the bot itself.
pub const BY_PERSON: &str = "person";
pub const BY_BOT: &str = "bot";

/// Where a call to one of these tools goes; `None` for any other tool. Decided before access
/// levels and grants, so Full access and "always" never skip it.
pub fn route(tool: &str, tainted: bool, naming_open: bool) -> Option<Route> {
    let ask = |line: &str| Route::Ask {
        line: line.to_owned(),
        ask: None,
    };
    match tool {
        TASK_UPDATE if tainted => Some(ask(TASK_TAINTED)),
        TASK_UPDATE => Some(Route::Run),
        PROFILE_UPDATE if naming_open && !tainted => Some(Route::Run),
        PROFILE_UPDATE => Some(ask(PROFILE_ASKS)),
        _ => None,
    }
}

/// Whether the bot may still name itself without asking: it was made to (`naming_opened`), and
/// since then nobody named it and no reply of its finished.
pub fn naming_open(events: &[Event]) -> bool {
    let Some(opened) = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::NamingOpened {})))
    else {
        return false;
    };
    !events[opened + 1..].iter().any(|e| {
        matches!(
            e,
            Event::Known(Known::ProfileChanged { .. } | Known::ReplyFinished { .. })
        )
    })
}

/// What the instructions add for a bot that still names itself, fixed for the turn: only while
/// naming was open when the turn's reply started, so the prompt's top never changes mid-turn.
pub fn naming_note(events: &[Event]) -> Option<&'static str> {
    let started = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ReplyStarted { .. })))
        .unwrap_or(events.len());
    naming_open(&events[..started]).then_some(NAMING_NOTE)
}

const NAMING_NOTE: &str = "You were just made from the person's first message and have no name \
yet. Before anything else in this reply, choose yourself a short, friendly name that fits the job \
(one or two words, not \"Bot\" or \"Assistant\") and a face, with profile_update. Then answer.";

/// One version of a bot's task, as its history lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    /// The `agent_configured` event that set it.
    pub seq: u64,
    pub at: i64,
    pub task: String,
    /// `person` or `bot`; empty for a version from before task history.
    pub by: String,
    pub why: String,
}

/// The versions of a task, newest first, from its `agent_configured` events oldest first: each
/// one whose task differs from the one before it (a change of model alone is no version).
pub fn history<'a>(events: impl IntoIterator<Item = (u64, i64, &'a Event)>) -> Vec<Version> {
    let mut versions: Vec<Version> = Vec::new();
    for (seq, at, event) in events {
        let Event::Known(Known::AgentConfigured { task, change, .. }) = event else {
            continue;
        };
        if versions.last().is_some_and(|last| &last.task == task) {
            continue;
        }
        let (by, why) = change
            .as_deref()
            .map_or((String::new(), String::new()), |c| {
                (c.by.clone(), c.why.clone())
            });
        versions.push(Version {
            seq,
            at,
            task: task.clone(),
            by,
            why,
        });
    }
    versions.reverse();
    versions
}

/// The change record for a new task, or `None` when the task stays the same.
pub fn change(previous: &str, task: &str, by: &str, why: &str) -> Option<Box<TaskChange>> {
    (previous != task).then(|| {
        Box::new(TaskChange {
            by: by.to_owned(),
            previous: previous.to_owned(),
            why: why.trim().to_owned(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured(task: &str, by: Option<&str>) -> Event {
        Event::Known(Known::AgentConfigured {
            task: task.into(),
            model: "e/m".into(),
            personality: None,
            change: by.and_then(|by| change("", task, by, "why")),
        })
    }

    #[test]
    fn a_task_change_with_untrusted_content_in_view_asks_the_person() {
        assert_eq!(route(TASK_UPDATE, false, false), Some(Route::Run));
        assert!(matches!(
            route(TASK_UPDATE, true, false),
            Some(Route::Ask { line, .. }) if line == TASK_TAINTED
        ));
        // Naming open changes nothing for the task.
        assert!(matches!(
            route(TASK_UPDATE, true, true),
            Some(Route::Ask { .. })
        ));
        assert_eq!(route("memory_save", true, true), None);
    }

    #[test]
    fn a_bot_names_itself_once_and_asks_for_any_later_change() {
        assert_eq!(route(PROFILE_UPDATE, false, true), Some(Route::Run));
        assert!(matches!(
            route(PROFILE_UPDATE, false, false),
            Some(Route::Ask { line, .. }) if line == PROFILE_ASKS
        ));
        // A page in view during its first reply: even its first name waits for the person.
        assert!(matches!(
            route(PROFILE_UPDATE, true, true),
            Some(Route::Ask { .. })
        ));
    }

    #[test]
    fn naming_closes_once_named_or_once_the_first_reply_finishes() {
        let opened = Event::Known(Known::NamingOpened {});
        let started = Event::reply_started("r1", "e/m");
        let finished = Event::Known(Known::ReplyFinished {
            reply: "r1".into(),
            text: "Hi".into(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        });
        let named = Event::Known(Known::ProfileChanged {
            name: "Ivy".into(),
            by: BY_BOT.into(),
            face: true,
        });
        assert!(!naming_open(&[]));
        assert!(naming_open(&[opened.clone(), started.clone()]));
        assert!(!naming_open(&[opened.clone(), started.clone(), named]));
        assert!(!naming_open(&[opened.clone(), started.clone(), finished]));
        // The note is fixed by the turn's start: present for the first turn, absent before any.
        assert!(naming_note(&[opened.clone(), started]).is_some());
        assert!(naming_note(&[]).is_none());
    }

    #[test]
    fn history_lists_each_task_newest_first_and_skips_model_only_changes() {
        let events = [
            configured("Sort my inbox", None),
            configured("Sort my inbox", None),
            configured("Sort my inbox and Slack", Some(BY_BOT)),
            configured("Sort my inbox", Some(BY_PERSON)),
        ];
        let versions = history(events.iter().enumerate().map(|(i, e)| (i as u64 + 1, 0, e)));
        let shown: Vec<(&str, &str, u64)> = versions
            .iter()
            .map(|v| (v.task.as_str(), v.by.as_str(), v.seq))
            .collect();
        assert_eq!(
            shown,
            [
                ("Sort my inbox", "person", 4),
                ("Sort my inbox and Slack", "bot", 3),
                ("Sort my inbox", "", 1),
            ]
        );
    }
}
