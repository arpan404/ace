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
    /// An `ask_user` question waiting for the person's next message.
    Asked,
    /// The person's message answering an `ask_user` question has arrived.
    Answered,
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
            let question = turn.iter().position(|event| {
                matches!(event, Event::Known(Known::QuestionAsked { call_id, .. }) if call_id == &call.id)
            });
            if let Some(at) = question {
                let answered = turn[at..].iter().any(|event| {
                    matches!(
                        event,
                        Event::Known(Known::UserMessage {
                            from_agent: None,
                            ..
                        })
                    )
                });
                let status = if answered {
                    Status::Answered
                } else {
                    Status::Asked
                };
                return Pending { call, status };
            }
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

/// Whether something arrived for the model that `reply` never answered and that should open a new
/// reply once `reply` closes: a message, or a job result not silenced by a stop, stored after the
/// reply's last step was prompted, or, if the person stopped the reply, after that stop.
pub fn unanswered_after(events: &[Event], reply: &str) -> bool {
    let started = events.iter().position(
        |e| matches!(e, Event::Known(Known::ReplyStarted { reply: r, .. }) if r == reply),
    );
    let Some(started) = started else {
        return false;
    };
    // The last step's prompt, and the stop, each bound what counts as unanswered; a step stored
    // after the stop must not move the bound back before it.
    let mut prompted = started + 1;
    let mut stopped = 0;
    for (at, event) in events.iter().enumerate().skip(started) {
        match event {
            Event::Known(Known::StepFinished { reply: r, seen, .. }) if r == reply => {
                prompted = seen.unwrap_or(at).max(started + 1);
            }
            Event::Known(Known::StopRequested { reply: Some(r), .. }) if r == reply => {
                stopped = at + 1;
            }
            _ => {}
        }
    }
    let from = prompted.max(stopped);
    events.iter().skip(from).any(|event| match event {
        Event::Known(Known::UserMessage { .. }) => true,
        Event::Known(Known::JobFinished { job, .. }) => !job_stopped(events, job),
        _ => false,
    })
}

/// Whether the conversation has something for the model and no reply open to answer it: a
/// message or job result stored while turns could not start (Spade was closing for an update).
/// When turns can start again, such a conversation opens a reply.
pub fn needs_reply(events: &[Event]) -> bool {
    let last = events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ReplyStarted { reply, .. }) => Some(reply.as_str()),
        _ => None,
    });
    match last {
        None => events.iter().any(|event| match event {
            Event::Known(Known::UserMessage { .. }) => true,
            Event::Known(Known::JobFinished { job, .. }) => !job_stopped(events, job),
            _ => false,
        }),
        Some(_) if open_reply(events).is_some() => false,
        Some(reply) => unanswered_after(events, reply),
    }
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
            risk: None,
            background: false,
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
                untrusted: false,
                reply: "r1".into(),
                call_id: id.into(),
                name: "send_email".into(),
                content: "done".into(),
                is_error: false,
                images: Vec::new(),
                uncertain: false,
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
    fn a_message_after_a_stop_is_unanswered_but_one_before_it_is_not() {
        let stop = Event::Known(Known::StopRequested {
            reply: Some("r1".into()),
            jobs: Vec::new(),
        });
        let mut events = vec![
            Event::user_message("Find flights"),
            Event::reply_started("r1", "m"),
            Event::user_message("Mornings only"),
            stop,
        ];
        assert!(
            !unanswered_after(&events, "r1"),
            "a message before Stop is stopped with it"
        );
        events.push(Event::user_message("Actually, evenings"));
        assert!(unanswered_after(&events, "r1"));
    }

    #[test]
    fn a_step_stored_after_the_stop_keeps_earlier_messages_stopped() {
        let mut late_step = step(Vec::new(), 0);
        if let Event::Known(Known::StepFinished { seen, .. }) = &mut late_step {
            *seen = Some(2);
        }
        let events = vec![
            Event::user_message("Find flights"),
            Event::reply_started("r1", "m"),
            Event::user_message("Mornings only"),
            Event::Known(Known::StopRequested {
                reply: Some("r1".into()),
                jobs: Vec::new(),
            }),
            // The stream finished just as Stop landed.
            late_step,
        ];
        assert!(!unanswered_after(&events, "r1"));
    }

    #[test]
    fn after_a_failed_step_a_message_it_never_saw_is_unanswered() {
        let mut seen_step = step(Vec::new(), 0);
        if let Event::Known(Known::StepFinished { seen, .. }) = &mut seen_step {
            *seen = Some(2);
        }
        let events = vec![
            Event::user_message("Hi"),
            Event::reply_started("r1", "m"),
            seen_step,
        ];
        assert!(!unanswered_after(&events, "r1"));
        let mut later = events.clone();
        later.insert(2, Event::user_message("Also this"));
        assert!(
            unanswered_after(&later, "r1"),
            "arrived while the step streamed"
        );
    }

    #[test]
    fn a_message_stored_while_turns_could_not_start_needs_a_reply() {
        let first = vec![Event::user_message("Hi")];
        assert!(
            needs_reply(&first),
            "a conversation started during an update"
        );
        let mut events = vec![
            Event::user_message("Hi"),
            Event::reply_started("r1", "m"),
            step(Vec::new(), 0),
        ];
        assert!(!needs_reply(&events), "the open reply answers it");
        events.push(Event::Known(Known::ReplyFinished {
            reply: "r1".into(),
            text: String::new(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        }));
        assert!(!needs_reply(&events), "answered");
        events.push(Event::user_message("And another thing"));
        assert!(needs_reply(&events));
    }

    #[test]
    fn a_stopped_jobs_result_needs_no_reply() {
        let events = vec![
            Event::user_message("Research"),
            Event::reply_started("r1", "m"),
            Event::Known(Known::JobStarted {
                reply: "r1".into(),
                job: "j1".into(),
                name: "research".into(),
            }),
            Event::Known(Known::StopRequested {
                reply: Some("r1".into()),
                jobs: vec!["j1".into()],
            }),
            Event::reply_ended(ReplyEnd::Stopped, "r1", ""),
            Event::Known(Known::JobFinished {
                job: "j1".into(),
                name: "research".into(),
                content: "late".into(),
                is_error: false,
                uncertain: false,
                files: Vec::new(),
            }),
        ];
        assert!(!needs_reply(&events));
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
