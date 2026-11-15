//! When work that failed for a while is tried again (ADR 0158, ADR 0160): the backoff, and the
//! attempt a new retry is. One rule for a turn waiting out its endpoint, a parked job and a task
//! whose check of done could not reach its model: 1, 2, 4 … minutes, at most an hour, longer
//! only when the endpoint asked for longer (and then still at most an hour), with no attempt
//! limit. Pure.

use super::{CancelledBy, HOUR_MS, MINUTE_MS, Open, ParkReason, Purpose};
use crate::event::{Event, Known};

/// When retry attempt `attempt` (from 1) is tried, in milliseconds after the failure: 1, 2,
/// 4 … minutes, at most an hour, or the endpoint's `retry-after` when it asks for longer (an hour
/// at most, so a far-off date still gets a try each hour).
pub fn retry_after_ms(attempt: u32, asked_ms: Option<i64>) -> i64 {
    let backoff = MINUTE_MS
        .saturating_mul(1_i64 << attempt.saturating_sub(1).min(10))
        .min(HOUR_MS);
    asked_ms.map_or(backoff, |asked| backoff.max(asked.min(HOUR_MS)))
}

/// The attempt a closed reply's retry would be, as earlier builds counted them: one more than
/// the reply retries set since the last reply that finished. Only read for stored wakes.
pub fn next_reply_attempt(events: &[Event]) -> u32 {
    let since = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ReplyFinished { .. })))
        .map_or(0, |at| at + 1);
    let retries = events[since..]
        .iter()
        .filter(|e| {
            matches!(
                e,
                Event::Known(Known::WakeSet {
                    purpose: Purpose::Retry { job: None, .. },
                    ..
                })
            )
        })
        .count();
    count(retries)
}

/// The attempt a new retry of parked job `job` is.
pub fn next_job_attempt(events: &[Event], job: &str) -> u32 {
    let tries = events
        .iter()
        .filter(|e| {
            matches!(e, Event::Known(Known::WakeSet {
                purpose: Purpose::Retry { job: Some(j), .. }, ..
            }) if j == job)
        })
        .count();
    count(tries)
}

/// The attempt a new outage wait of `reply` is: one more than its waits since its last step
/// finished, so a long turn that once met an outage starts again from a minute. A `turn_parked`
/// stored by an earlier build counts as the round it says.
pub fn next_outage_attempt(events: &[Event], reply: &str) -> u32 {
    let mut waits = 0;
    for event in events.iter().rev() {
        match event {
            Event::Known(Known::WakeSet {
                reply: r,
                purpose: Purpose::Outage { .. },
                ..
            }) if r == reply => waits += 1,
            Event::Known(Known::TurnParked {
                reply: r, round, ..
            }) if r == reply => {
                return count(waits).saturating_add(*round);
            }
            Event::Known(
                Known::StepFinished { reply: r, .. } | Known::ReplyStarted { reply: r, .. },
            ) if r == reply => break,
            _ => {}
        }
    }
    count(waits)
}

/// The attempt a new task park for its check is: one more than those set since the last verdict.
pub fn next_park_attempt(events: &[Event]) -> u32 {
    let mut parks = 0;
    for event in events.iter().rev() {
        match event {
            Event::Known(Known::WakeSet {
                purpose:
                    Purpose::Park {
                        reason: ParkReason::Check,
                        ..
                    },
                ..
            }) => parks += 1,
            Event::Known(Known::TaskVerified { .. }) => break,
            _ => {}
        }
    }
    count(parks)
}

/// The open outage wait of `reply`, if its turn is waiting out its endpoint, with where its
/// `wake_set` is in `events`. Read from the newest back to the reply's last step, so a turn's
/// step costs what it adds, not its history.
pub fn open_outage(events: &[Event], reply: &str) -> Option<(usize, Open)> {
    for (at, event) in events.iter().enumerate().rev() {
        match event {
            Event::Known(Known::WakeSet {
                wake,
                reply: r,
                purpose: purpose @ Purpose::Outage { .. },
                due_ms,
                condition,
                reason,
            }) if r == reply => {
                return (!closed(&events[at..], wake)).then(|| {
                    (
                        at,
                        Open {
                            wake: wake.clone(),
                            reply: r.clone(),
                            purpose: purpose.clone(),
                            due_ms: *due_ms,
                            condition: condition.clone(),
                            reason: reason.clone(),
                        },
                    )
                });
            }
            Event::Known(
                Known::StepFinished { reply: r, .. } | Known::ReplyStarted { reply: r, .. },
            ) if r == reply => return None,
            _ => {}
        }
    }
    None
}

/// How `wake` ended in `events`, if it did: fired, or cancelled and by whom.
pub fn ended<'a>(events: impl IntoIterator<Item = &'a Event>, wake: &str) -> Option<Ended> {
    events.into_iter().find_map(|event| match event {
        Event::Known(Known::WakeFired { wake: w, .. }) if w == wake => Some(Ended::Fired),
        Event::Known(Known::WakeCancelled { wake: w, by }) if w == wake => {
            Some(Ended::Cancelled(*by))
        }
        _ => None,
    })
}

/// How a wake ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    Fired,
    Cancelled(CancelledBy),
}

fn closed(events: &[Event], wake: &str) -> bool {
    ended(events, wake).is_some()
}

/// A `turn_parked` an earlier build stored (ADR 0158 before wakes held it): when the open turn of
/// `reply` waits until, if no step of it finished since. A turn resumed after an update keeps
/// waiting until then.
pub fn legacy_turn_wait(events: &[Event], reply: &str) -> Option<i64> {
    for event in events.iter().rev() {
        match event {
            Event::Known(Known::TurnParked {
                reply: r, until_ms, ..
            }) if r == reply => return Some(*until_ms),
            Event::Known(
                Known::StepFinished { reply: r, .. }
                | Known::ReplyStarted { reply: r, .. }
                | Known::WakeSet { reply: r, .. },
            ) if r == reply => return None,
            _ => {}
        }
    }
    None
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX).saturating_add(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wake::{Cause, fired};

    fn step(reply: &str) -> Event {
        Event::Known(Known::StepFinished {
            reply: reply.into(),
            text: String::new(),
            calls: Vec::new(),
            thoughts: Vec::new(),
            usage: crate::event::Tokens::default(),
            cost_micros: 0,
            seen: None,
        })
    }

    fn outage(wake: &str, reply: &str) -> Event {
        Event::Known(Known::WakeSet {
            wake: wake.into(),
            reply: reply.into(),
            purpose: Purpose::Outage {
                attempt: 1,
                error: "503".into(),
            },
            due_ms: Some(1),
            condition: None,
            reason: String::new(),
        })
    }

    fn legacy(reply: &str, round: u32) -> Event {
        Event::Known(Known::TurnParked {
            reply: reply.into(),
            until_ms: 100 * i64::from(round),
            round,
            why: "down".into(),
        })
    }

    #[test]
    fn a_turns_outage_backs_off_until_a_step_of_it_finishes_and_only_for_that_reply() {
        let mut events = vec![Event::reply_started("r1", "m"), outage("w1", "r1")];
        events.push(fired("w1", Cause::Time, None, Vec::new()));
        events.push(outage("w2", "r1"));
        assert_eq!(next_outage_attempt(&events, "r1"), 3);
        assert_eq!(next_outage_attempt(&events, "r2"), 1);
        events.push(step("r1"));
        assert_eq!(next_outage_attempt(&events, "r1"), 1);
    }

    #[test]
    fn a_turn_parked_by_an_earlier_build_still_waits_and_still_counts() {
        let mut events = vec![
            Event::reply_started("r1", "m"),
            legacy("r1", 1),
            legacy("r1", 2),
        ];
        assert_eq!(legacy_turn_wait(&events, "r1"), Some(200));
        assert_eq!(legacy_turn_wait(&events, "r2"), None);
        assert_eq!(next_outage_attempt(&events, "r1"), 3);
        events.push(outage("w1", "r1"));
        assert_eq!(legacy_turn_wait(&events, "r1"), None, "a wake holds it now");
        assert_eq!(next_outage_attempt(&events, "r1"), 4);
        events.push(step("r1"));
        assert_eq!(legacy_turn_wait(&events, "r1"), None);
    }

    #[test]
    fn an_outage_wait_is_open_until_it_fires_or_is_cancelled_and_only_for_its_reply() {
        let mut events = vec![Event::reply_started("r1", "m"), outage("w1", "r1")];
        assert_eq!(
            open_outage(&events, "r1").map(|(at, o)| (at, o.wake)),
            Some((1, "w1".into()))
        );
        assert_eq!(open_outage(&events, "r2"), None);
        events.push(Event::user_message("still there?"));
        assert!(
            open_outage(&events, "r1").is_some(),
            "a message alone does not end it"
        );
        events.push(fired("w1", Cause::Message, None, Vec::new()));
        assert_eq!(open_outage(&events, "r1"), None);
        assert_eq!(ended(&events, "w1"), Some(Ended::Fired));
        events.push(outage("w2", "r1"));
        events.push(Event::Known(Known::WakeCancelled {
            wake: "w2".into(),
            by: CancelledBy::Person,
        }));
        assert_eq!(open_outage(&events, "r1"), None);
        assert_eq!(
            ended(&events, "w2"),
            Some(Ended::Cancelled(CancelledBy::Person))
        );
    }

    #[test]
    fn a_checks_park_backs_off_until_a_verdict_is_stored() {
        let park = Event::Known(Known::WakeSet {
            wake: "w1".into(),
            reply: String::new(),
            purpose: Purpose::Park {
                reason: ParkReason::Check,
                attempt: 1,
            },
            due_ms: Some(1),
            condition: None,
            reason: "down".into(),
        });
        let mut events = vec![park.clone(), park];
        assert_eq!(next_park_attempt(&events), 3);
        events.push(Event::Known(Known::TaskVerified {
            goal: "g1".into(),
            claim: "c1".into(),
            verdict: crate::goal::Finding::NotYet,
            criteria: Vec::new(),
            rejected: Vec::new(),
            missing: Vec::new(),
            model: String::new(),
            cost_micros: 0,
        }));
        assert_eq!(next_park_attempt(&events), 1);
    }
}
