//! Work that waits instead of ending (ADR 0158): a task stopped by a spending cap carries on at
//! the cap's reset, and a turn whose model endpoint is down sends its step again later. Pure: the
//! engine stores the events and keeps the time.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::event::{Event, Known};

/// Why a task waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParkReason {
    /// A spending cap: the service's, or one of the bot's own.
    Cap,
    /// A kind a later build adds.
    #[serde(other)]
    Other,
}

/// A task waiting on a cap: when it carries on, and why, in words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parked {
    pub reason: ParkReason,
    pub until_ms: Option<i64>,
    pub why: String,
}

/// The task's park in effect: the latest `task_parked` with no reply or message after it.
pub fn parked<'a>(events: impl DoubleEndedIterator<Item = &'a Event>) -> Option<Parked> {
    for event in events.rev() {
        match event {
            Event::Known(Known::TaskParked {
                reason,
                until_ms,
                why,
            }) => {
                return Some(Parked {
                    reason: *reason,
                    until_ms: *until_ms,
                    why: why.clone(),
                });
            }
            Event::Known(
                Known::ReplyStarted { .. }
                | Known::UserMessage { .. }
                | Known::StopRequested { .. },
            ) => return None,
            _ => {}
        }
    }
    None
}

/// The open turn's wait for its endpoint, if it is waiting: the latest `turn_parked` of `reply`
/// with no step finished after it. A restart resumes the turn and keeps waiting until `until_ms`.
pub fn turn_wait<'a>(
    events: impl DoubleEndedIterator<Item = &'a Event>,
    reply: &str,
) -> Option<(i64, u32)> {
    for event in events.rev() {
        match event {
            Event::Known(Known::TurnParked {
                reply: r,
                until_ms,
                round,
                ..
            }) if r == reply => return Some((*until_ms, *round)),
            Event::Known(Known::StepFinished { reply: r, .. }) if r == reply => return None,
            Event::Known(Known::ReplyStarted { reply: r, .. }) if r == reply => return None,
            _ => {}
        }
    }
    None
}

/// How many times this turn already waited for its endpoint, so a resumed turn keeps backing off.
pub fn turn_rounds<'a>(events: impl DoubleEndedIterator<Item = &'a Event>, reply: &str) -> u32 {
    for event in events.rev() {
        match event {
            Event::Known(Known::TurnParked {
                reply: r, round, ..
            }) if r == reply => return *round,
            Event::Known(Known::ReplyStarted { reply: r, .. }) if r == reply => return 0,
            _ => {}
        }
    }
    0
}

/// How long a turn waits for its endpoint before sending its step again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    /// The first wait; each later one doubles...
    pub first: Duration,
    /// ...up to this. A turn waits as many rounds as it takes; Stop ends it.
    pub longest: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            first: Duration::from_secs(60),
            longest: Duration::from_secs(60 * 60),
        }
    }
}

/// The wait before round `round` (1 is the first): the backoff, or the endpoint's own
/// `retry-after` when it asks for longer.
pub fn wait(backoff: &Backoff, round: u32, hint: Option<Duration>) -> Duration {
    let doubled = backoff
        .first
        .saturating_mul(1u32 << round.saturating_sub(1).min(20))
        .min(backoff.longest);
    hint.map_or(doubled, |hint| hint.max(doubled))
}

/// What the person reads while a turn waits for its endpoint.
pub fn turn_words(endpoint: &str, minutes: i64) -> String {
    match minutes {
        ..=1 => format!("Waiting for {endpoint}; trying again in a minute"),
        n if n < 120 => format!("Waiting for {endpoint}; trying again in {n} minutes"),
        n => format!("Waiting for {endpoint}; trying again in {} hours", n / 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn waits_double_from_a_minute_to_an_hour_and_honour_a_longer_retry_after() {
        let backoff = Backoff::default();
        let waits: Vec<u64> = (1..=9)
            .map(|round| wait(&backoff, round, None).as_secs() / 60)
            .collect();
        assert_eq!(waits, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
        assert_eq!(wait(&backoff, 1, Some(5 * MINUTE)), 5 * MINUTE);
        assert_eq!(wait(&backoff, 3, Some(MINUTE)), 4 * MINUTE);
        assert_eq!(wait(&backoff, 1_000, None), 60 * MINUTE);
    }

    fn task_parked(until: i64) -> Event {
        Event::Known(Known::TaskParked {
            reason: ParkReason::Cap,
            until_ms: Some(until),
            why: "at its cap".into(),
        })
    }

    #[test]
    fn a_park_holds_until_the_next_reply_or_message() {
        let mut events = vec![Event::reply_started("r1", "m"), task_parked(9)];
        assert_eq!(parked(events.iter()).and_then(|p| p.until_ms), Some(9));
        events.push(Event::reply_started("r2", "m"));
        assert_eq!(parked(events.iter()), None);
        events.push(task_parked(10));
        events.push(Event::user_message("go on"));
        assert_eq!(parked(events.iter()), None);
    }

    #[test]
    fn a_turns_wait_ends_once_a_step_of_it_finishes_and_its_rounds_carry_on() {
        let parked = |round: u32| {
            Event::Known(Known::TurnParked {
                reply: "r1".into(),
                until_ms: 100 * i64::from(round),
                round,
                why: "down".into(),
            })
        };
        let mut events = vec![Event::reply_started("r1", "m"), parked(1), parked(2)];
        assert_eq!(turn_wait(events.iter(), "r1"), Some((200, 2)));
        assert_eq!(turn_wait(events.iter(), "r2"), None);
        events.push(Event::Known(Known::StepFinished {
            reply: "r1".into(),
            text: String::new(),
            calls: Vec::new(),
            thoughts: Vec::new(),
            usage: crate::event::Tokens::default(),
            cost_micros: 0,
            seen: None,
        }));
        assert_eq!(turn_wait(events.iter(), "r1"), None);
        assert_eq!(turn_rounds(events.iter(), "r1"), 2);
    }
}
