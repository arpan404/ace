//! Decides what an open turn does next, from its stored events alone. The engine runs this after
//! every change, so a turn picks up where it left off after a restart, and a message steered in
//! mid-turn is simply seen by the next model call.

use crate::event::{Call, Event, Known};

/// What the open turn needs now.
#[derive(Debug, Clone, PartialEq)]
pub enum Next {
    /// No turn is open.
    Idle,
    /// Ask the model for the next step.
    CallModel { reply: String },
    /// The last step's tool calls that have no result yet, with where each stands.
    Calls { reply: String, calls: Vec<Pending> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub call: Call,
    pub status: Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Not yet seen by the gate.
    New,
    /// Waiting for the person.
    Awaiting,
    Allowed,
    Declined,
    /// Started and not finished.
    Running,
}

/// The open turn's progress so far.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Progress {
    pub steps: u32,
    pub cost_micros: u64,
}

pub fn next_step(events: &[Event]) -> Next {
    let Some((reply, start)) = open_reply(events) else {
        return Next::Idle;
    };
    let turn = &events[start..];
    let last_calls = turn.iter().rev().find_map(|event| match event {
        Event::Known(Known::StepFinished { calls, .. }) => Some(calls.clone()),
        _ => None,
    });
    let Some(calls) = last_calls else {
        return Next::CallModel { reply };
    };
    let pending: Vec<Pending> = calls
        .into_iter()
        .filter(|call| {
            !has(
                turn,
                |k| matches!(k, Known::ToolFinished { call_id, .. } if call_id == &call.id),
            )
        })
        .map(|call| {
            let started = has(
                turn,
                |k| matches!(k, Known::ToolStarted { call_id, .. } if call_id == &call.id),
            );
            let answer = turn.iter().rev().find_map(|event| match event {
                Event::Known(Known::ApprovalAnswered {
                    call_id, allowed, ..
                }) if call_id == &call.id => Some(*allowed),
                _ => None,
            });
            let asked = has(
                turn,
                |k| matches!(k, Known::ApprovalRequested { call_id, .. } if call_id == &call.id),
            );
            let status = match (started, answer, asked) {
                (true, _, _) => Status::Running,
                (false, Some(true), _) => Status::Allowed,
                (false, Some(false), _) => Status::Declined,
                (false, None, true) => Status::Awaiting,
                (false, None, false) => Status::New,
            };
            Pending { call, status }
        })
        .collect();
    if pending.is_empty() {
        Next::CallModel { reply }
    } else {
        Next::Calls {
            reply,
            calls: pending,
        }
    }
}

/// The step's calls with ids unique in the conversation. Providers may reuse ids across steps
/// (some number them `call_0`, `call_1` in each reply); a reused id would match an earlier call's
/// result or approval, so it is replaced with one from `mint`. The stored id is the one the model
/// sees from then on, so the call and its result still pair up.
pub fn unique_call_ids(
    events: &[Event],
    calls: Vec<Call>,
    mut mint: impl FnMut() -> String,
) -> Vec<Call> {
    let mut used: std::collections::HashSet<String> = events
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::StepFinished { calls, .. }) => Some(calls),
            _ => None,
        })
        .flatten()
        .map(|call| call.id.clone())
        .collect();
    calls
        .into_iter()
        .map(|mut call| {
            while call.id.is_empty() || !used.insert(call.id.clone()) {
                call.id = mint();
            }
            call
        })
        .collect()
}

/// Whether the person pressed Stop on `reply`.
pub fn stop_requested(events: &[Event], reply: &str) -> bool {
    events.iter().any(
        |e| matches!(e, Event::Known(Known::StopRequested { reply: Some(r), .. }) if r == reply),
    )
}

/// Whether the person stopped `job`, or the reply that started it, so its result must not open a
/// reply.
pub fn job_stopped(events: &[Event], job: &str) -> bool {
    let named = events.iter().any(|e| {
        matches!(e, Event::Known(Known::StopRequested { jobs, .. }) if jobs.iter().any(|j| j == job))
    });
    named
        || events.iter().any(|e| match e {
            Event::Known(Known::JobStarted { job: j, reply, .. }) if j == job => {
                stop_requested(events, reply)
            }
            _ => false,
        })
}

/// Steps taken and money spent by the open turn.
pub fn progress(events: &[Event]) -> Progress {
    let Some((_, start)) = open_reply(events) else {
        return Progress::default();
    };
    events[start..]
        .iter()
        .fold(Progress::default(), |mut acc, event| {
            if let Event::Known(Known::StepFinished { cost_micros, .. }) = event {
                acc.steps += 1;
                acc.cost_micros += cost_micros;
            }
            acc
        })
}

/// The open reply's id and the index of its `reply_started`, if a reply is open.
fn open_reply(events: &[Event]) -> Option<(String, usize)> {
    let (start, reply) = events
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, event)| match event {
            Event::Known(Known::ReplyStarted { reply, .. }) => Some((i, reply.clone())),
            _ => None,
        })?;
    let closed = events[start..].iter().any(|event| {
        matches!(
            event,
            Event::Known(
                Known::ReplyFinished { .. }
                    | Known::ReplyStopped { .. }
                    | Known::ReplyFailed { .. }
                    | Known::ReplyInterrupted { .. }
            )
        )
    });
    (!closed).then_some((reply, start))
}

fn has(turn: &[Event], test: impl Fn(&Known) -> bool) -> bool {
    turn.iter()
        .any(|event| matches!(event, Event::Known(k) if test(k)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::event::{ReplyEnd, Tokens};

    fn call(id: &str) -> Call {
        Call {
            id: id.into(),
            name: "send_email".into(),
            arguments: json!({}),
        }
    }

    fn step(calls: Vec<Call>, cost: u64) -> Event {
        Event::Known(Known::StepFinished {
            reply: "r1".into(),
            text: String::new(),
            calls,
            thoughts: Vec::new(),
            usage: Tokens::default(),
            cost_micros: cost,
            seen: None,
        })
    }

    fn statuses(next: &Next) -> Vec<(String, Status)> {
        match next {
            Next::Calls { calls, .. } => calls
                .iter()
                .map(|p| (p.call.id.clone(), p.status))
                .collect(),
            _ => Vec::new(),
        }
    }

    #[test]
    fn a_new_turn_calls_the_model_and_a_closed_one_is_idle() {
        let mut events = vec![Event::user_message("Hi"), Event::reply_started("r1", "m")];
        assert_eq!(next_step(&events), Next::CallModel { reply: "r1".into() });
        events.push(Event::reply_ended(ReplyEnd::Stopped, "r1", ""));
        assert_eq!(next_step(&events), Next::Idle);
        assert_eq!(next_step(&[]), Next::Idle);
    }

    #[test]
    fn tool_calls_move_from_new_to_answered_and_then_the_model_is_called_again() {
        let mut events = vec![
            Event::user_message("Email Sam and Jo"),
            Event::reply_started("r1", "m"),
            step(vec![call("c1"), call("c2")], 10),
        ];
        assert_eq!(
            statuses(&next_step(&events)),
            vec![("c1".into(), Status::New), ("c2".into(), Status::New)]
        );

        events.push(Event::Known(Known::ApprovalRequested {
            reply: "r1".into(),
            call_id: "c1".into(),
            name: "send_email".into(),
            arguments: json!({}),
        }));
        events.push(Event::Known(Known::ApprovalRequested {
            reply: "r1".into(),
            call_id: "c2".into(),
            name: "send_email".into(),
            arguments: json!({}),
        }));
        events.push(Event::Known(Known::ApprovalAnswered {
            reply: "r1".into(),
            call_id: "c1".into(),
            allowed: true,
            always: false,
        }));
        assert_eq!(
            statuses(&next_step(&events)),
            vec![
                ("c1".into(), Status::Allowed),
                ("c2".into(), Status::Awaiting)
            ]
        );

        events.push(Event::Known(Known::ApprovalAnswered {
            reply: "r1".into(),
            call_id: "c2".into(),
            allowed: false,
            always: false,
        }));
        events.push(Event::Known(Known::ToolStarted {
            reply: "r1".into(),
            call_id: "c1".into(),
            name: "send_email".into(),
        }));
        assert_eq!(
            statuses(&next_step(&events)),
            vec![
                ("c1".into(), Status::Running),
                ("c2".into(), Status::Declined)
            ]
        );

        for id in ["c1", "c2"] {
            events.push(Event::Known(Known::ToolFinished {
                reply: "r1".into(),
                call_id: id.into(),
                name: "send_email".into(),
                content: "done".into(),
                is_error: false,
            }));
        }
        assert_eq!(next_step(&events), Next::CallModel { reply: "r1".into() });
    }

    #[test]
    fn a_steered_message_does_not_change_what_comes_next() {
        let events = vec![
            Event::user_message("Find flights"),
            Event::reply_started("r1", "m"),
            step(vec![call("c1")], 0),
            Event::user_message("Mornings only"),
        ];
        assert_eq!(
            statuses(&next_step(&events)),
            vec![("c1".into(), Status::New)]
        );
    }

    #[test]
    fn a_call_id_used_before_in_the_conversation_is_replaced() {
        let events = vec![
            Event::user_message("Email Sam"),
            Event::reply_started("r1", "m"),
            step(vec![call("call_0")], 0),
        ];
        let mut minted = 0;
        let calls = unique_call_ids(
            &events,
            vec![call("call_0"), call("call_1"), call("call_1"), call("")],
            || {
                minted += 1;
                format!("t{minted}")
            },
        );
        let ids: Vec<&str> = calls.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["t1", "call_1", "t2", "t3"]);
    }

    #[test]
    fn a_stop_affects_only_the_reply_and_jobs_it_names() {
        let started = |job: &str, reply: &str| {
            Event::Known(Known::JobStarted {
                reply: reply.into(),
                job: job.into(),
                name: "research".into(),
            })
        };
        let stop = |reply: Option<&str>, jobs: &[&str]| {
            Event::Known(Known::StopRequested {
                reply: reply.map(str::to_owned),
                jobs: jobs.iter().map(|j| (*j).to_owned()).collect(),
            })
        };
        let events = vec![
            Event::reply_started("r1", "m"),
            stop(Some("r1"), &[]),
            // Logged after the stop, but started by the stopped reply.
            started("j1", "r1"),
            Event::reply_started("r2", "m"),
            started("j2", "r2"),
            started("j3", "r2"),
            stop(None, &["j3"]),
            Event::reply_started("r3", "m"),
        ];
        assert!(stop_requested(&events, "r1"));
        assert!(!stop_requested(&events, "r2"));
        assert!(
            !stop_requested(&events, "r3"),
            "a late stop never reaches a newer reply"
        );
        assert!(job_stopped(&events, "j1"));
        assert!(!job_stopped(&events, "j2"));
        assert!(job_stopped(&events, "j3"));
    }

    #[test]
    fn progress_counts_the_open_turns_steps_and_cost_only() {
        let events = vec![
            Event::user_message("One"),
            Event::reply_started("r0", "m"),
            step(Vec::new(), 500),
            Event::reply_ended(ReplyEnd::Stopped, "r0", ""),
            Event::user_message("Two"),
            Event::reply_started("r1", "m"),
            step(vec![call("c1")], 30),
            step(Vec::new(), 12),
        ];
        assert_eq!(
            progress(&events),
            Progress {
                steps: 2,
                cost_micros: 42
            }
        );
    }
}
