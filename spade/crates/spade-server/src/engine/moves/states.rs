//! The move protocol's two state machines (ADR 0187, "The move's states"): each side's states,
//! the transitions it may take, and, for the source, how every answer from the other machine
//! moves it. Pure; the drivers (`send`, `receive`) act on it and store each state before the
//! message that follows it. An answer it doesn't know means "stay where you are and ask again",
//! never "give up": once its commit is sent, the source lets the bot go only when the other
//! machine says, from what it stored, that the move took (archive) or was given up (thaw).

use serde_json::Value;

use super::{
    ABORTED, ABORTING, ACCEPTED, ACTIVATING, CANCELLED, COMMITTED, COMMITTING, DONE, FAILED,
    FINISHING, PACKING, PLACING, RECEIVING, RESERVED, SENDING, SOURCE_ABORTING, UNDOING,
};

/// Every transition the source may take, `(from, to)`.
pub(super) const SOURCE: &[(&str, &str)] = &[
    (RESERVED, PACKING),
    (RESERVED, CANCELLED),
    (PACKING, SENDING),
    (PACKING, FAILED),
    (PACKING, CANCELLED),
    (SENDING, COMMITTING),
    (SENDING, FAILED),
    (SENDING, CANCELLED),
    // Its commit was sent once: stopping is asking the other machine to give it up first.
    (SENDING, SOURCE_ABORTING),
    (COMMITTING, FINISHING),
    (COMMITTING, SENDING),
    (COMMITTING, FAILED),
    (COMMITTING, SOURCE_ABORTING),
    (SOURCE_ABORTING, COMMITTING),
    (SOURCE_ABORTING, FAILED),
    (SOURCE_ABORTING, CANCELLED),
    (FINISHING, DONE),
];

/// Every transition the target may take, `(from, to)`.
pub(super) const TARGET: &[(&str, &str)] = &[
    (ACCEPTED, RECEIVING),
    (ACCEPTED, ABORTED),
    (RECEIVING, ACTIVATING),
    (RECEIVING, ABORTED),
    (ACTIVATING, PLACING),
    (ACTIVATING, UNDOING),
    (ACTIVATING, ABORTING),
    (PLACING, COMMITTED),
    (PLACING, UNDOING),
    (PLACING, ABORTING),
    (UNDOING, RECEIVING),
    (UNDOING, ABORTING),
    (ABORTING, ABORTED),
];

/// The states `to` may be reached from, on the side `table` describes.
#[cfg(test)]
pub(super) fn from_states(table: &[(&'static str, &'static str)], to: &str) -> Vec<&'static str> {
    table
        .iter()
        .filter(|(_, next)| *next == to)
        .map(|(from, _)| *from)
        .collect()
}

/// What the other machine's answer says, as the source acts on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Heard {
    /// It holds the move committed.
    Committed,
    /// It holds the move given up, durably.
    Aborted,
    /// It is still receiving and lacks parts.
    Missing,
    /// It refused the move, in these words; it may still hold some of it.
    Refused(String),
    /// Anything else: an error, no answer, an answer this build doesn't read.
    Unknown,
}

/// The answer `status`, `body` (or none) as the source acts on it. Only the state the other
/// machine says it stored can let the bot go.
pub(super) fn hear(answer: Option<(u16, &Value)>) -> Heard {
    let Some((status, body)) = answer else {
        return Heard::Unknown;
    };
    match body["state"].as_str() {
        Some(state) if state == COMMITTED => return Heard::Committed,
        Some(state) if state == ABORTED => return Heard::Aborted,
        _ => {}
    }
    match status {
        409 if body["missing"].is_array() => Heard::Missing,
        // Busy, or not now: ask again.
        408 | 429 => Heard::Unknown,
        400..=499 => Heard::Refused(
            body["error"]
                .as_str()
                .unwrap_or("the other machine refused the move")
                .to_owned(),
        ),
        _ => Heard::Unknown,
    }
}

/// What the source does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Then {
    /// The move took there: archive here.
    Finish,
    /// Given up there, durably: the bot carries on here.
    Thaw,
    /// Parts went missing there: send them again.
    Resend,
    /// Ask it to give the move up, and let the bot go only once it has.
    Abort,
    /// Stay where it is and ask again.
    Retry,
}

/// After `commit` was sent, on `heard`.
pub(super) fn committing(heard: &Heard) -> Then {
    match heard {
        Heard::Committed => Then::Finish,
        Heard::Aborted => Then::Thaw,
        Heard::Missing => Then::Resend,
        Heard::Refused(_) | Heard::Unknown => Then::Retry,
    }
}

/// While asking it to give the move up, on `heard`.
pub(super) fn aborting(heard: &Heard) -> Then {
    match heard {
        // It took after all: ask for the commit's answer again.
        Heard::Committed => Then::Finish,
        Heard::Aborted => Then::Thaw,
        Heard::Missing | Heard::Refused(_) | Heard::Unknown => Then::Retry,
    }
}

/// Stopping before it took (a refusal, the deadline, the person's cancel): with no commit sent
/// yet the other machine can't take it, so the bot carries on; once one was sent, only that
/// machine's word lets it go.
pub(super) fn stopping(commit_sent: bool) -> Then {
    if commit_sent { Then::Abort } else { Then::Thaw }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn once_the_commit_is_sent_only_the_other_machines_stored_word_lets_the_bot_go() {
        let table = [
            (
                Some((200, json!({ "committed": true, "state": "committed" }))),
                Then::Finish,
            ),
            (
                Some((422, json!({ "error": "x", "state": "aborted" }))),
                Then::Thaw,
            ),
            (Some((409, json!({ "missing": [3] }))), Then::Resend),
            // A refusal that doesn't say the move is given up there, an error reading the
            // state, a lost answer, an answer this build can't read: all stay and ask again.
            (Some((422, json!({ "error": "x" }))), Then::Retry),
            (
                Some((500, json!({ "error": "status unreadable" }))),
                Then::Retry,
            ),
            (Some((503, json!({ "state": "placing" }))), Then::Retry),
            (Some((200, json!({ "state": "receiving" }))), Then::Retry),
            (Some((200, json!("odd"))), Then::Retry),
            (None, Then::Retry),
        ];
        for (answer, then) in table {
            let heard = hear(answer.as_ref().map(|(s, b)| (*s, b)));
            assert_eq!(committing(&heard), then, "{answer:?}");
        }
    }

    #[test]
    fn asking_it_to_give_up_ends_only_with_its_word_either_way() {
        assert_eq!(
            aborting(&hear(Some((200, &json!({ "state": "aborted" }))))),
            Then::Thaw
        );
        assert_eq!(
            aborting(&hear(Some((409, &json!({ "state": "committed" }))))),
            Then::Finish
        );
        for answer in [json!({ "error": "busy" }), json!({ "state": "aborting" })] {
            assert_eq!(aborting(&hear(Some((503, &answer)))), Then::Retry);
        }
        assert_eq!(aborting(&hear(None)), Then::Retry);
        assert_eq!(stopping(false), Then::Thaw);
        assert_eq!(stopping(true), Then::Abort);
    }

    #[test]
    fn a_given_up_or_finished_move_is_left_only_as_the_tables_say() {
        for terminal in [DONE, FAILED, CANCELLED] {
            assert!(
                SOURCE.iter().all(|(from, _)| *from != terminal),
                "{terminal}"
            );
        }
        for terminal in [COMMITTED, ABORTED] {
            assert!(
                TARGET.iter().all(|(from, _)| *from != terminal),
                "{terminal}"
            );
        }
        // Thawing after a commit was sent goes through asking the other machine first.
        assert!(from_states(SOURCE, SOURCE_ABORTING).contains(&COMMITTING));
        assert!(!SOURCE.contains(&(FINISHING, FAILED)));
        // Being given up there only ever ends given up.
        assert_eq!(
            TARGET.iter().filter(|(from, _)| *from == ABORTING).count(),
            1
        );
    }
}
