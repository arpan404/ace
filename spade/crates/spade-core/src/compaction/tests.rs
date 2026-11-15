use serde_json::json;
use spade_models::{Message, ToolSpec};

use super::*;
use crate::context;
use crate::event::{Call, Tokens};
use crate::tools::ToolDef;

fn turn(n: usize, words: usize) -> Vec<Event> {
    vec![
        Event::user_message(format!("question {n} {}", "word ".repeat(words))),
        Event::reply_started(format!("r{n}"), "m"),
        Event::Known(Known::StepFinished {
            reply: format!("r{n}"),
            text: format!("answer {n} {}", "word ".repeat(words)),
            calls: Vec::new(),
            thoughts: Vec::new(),
            usage: Tokens::default(),
            cost_micros: 0,
            seen: None,
        }),
        Event::Known(Known::ReplyFinished {
            reply: format!("r{n}"),
            text: format!("answer {n}"),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        }),
    ]
}

fn conversation(turns: usize) -> Vec<Event> {
    (0..turns).flat_map(|n| turn(n, 50)).collect()
}

#[test]
fn nothing_happens_below_three_quarters_of_the_budget() {
    assert_eq!(plan(&conversation(10), 7_499, 10_000), None);
}

#[test]
fn at_the_high_mark_the_cut_keeps_recent_turns_and_starts_at_a_message() {
    let events = conversation(10);
    let plan = plan(&events, 8_000, 10_000);
    let keep_from = plan.map(|p| p.keep_from).unwrap_or(0);
    assert!(matches!(
        events[keep_from],
        Event::Known(Known::UserMessage { .. })
    ));
    // 10 equal turns at 8,000 tokens are 800 each; 4 turns (3,200) fit under 3,500 (35%).
    assert_eq!(keep_from, 6 * 4);
}

#[test]
fn one_huge_turn_still_keeps_the_latest_message() {
    let mut events = conversation(2);
    events.extend(turn(2, 5_000));
    let plan = plan(&events, 9_000, 10_000);
    assert_eq!(plan.map(|p| p.keep_from), Some(8));
}

#[test]
fn a_second_compaction_only_cuts_after_the_first() {
    let mut events = conversation(10);
    events.push(Event::Known(Known::ContextCompacted {
        summary: "earlier".into(),
        keep_from: 28,
        tokens_before: 8_000,
        images_left_out: None,
        untrusted: false,
    }));
    events.extend((10..12).flat_map(|n| turn(n, 50)));
    let second = plan(&events, 8_000, 10_000)
        .map(|p| p.keep_from)
        .unwrap_or(0);
    assert!(second > 28, "{second}");
}

#[test]
fn the_model_sees_the_summary_then_the_kept_turns_with_the_top_unchanged() {
    let mut events = conversation(4);
    let tools = vec![ToolSpec {
        name: "web_search".into(),
        description: "Search".into(),
        schema: json!({}),
    }];
    let before = context::prompt(context::SYSTEM, tools.clone(), &events);
    events.push(Event::Known(Known::ContextCompacted {
        summary: "Summary of the earlier conversation".into(),
        keep_from: 8,
        tokens_before: 5_000,
        images_left_out: None,
        untrusted: false,
    }));
    let after = context::prompt(context::SYSTEM, tools, &events);

    assert_eq!(before.system, after.system);
    assert_eq!(before.tools, after.tools);
    let first = match &after.messages[0] {
        Message::Person { text, .. } => text.clone(),
        other => format!("{other:?}"),
    };
    assert!(
        first.starts_with("<summary>\nSummary of the earlier conversation"),
        "{first}"
    );
    assert!(
        first.ends_with("question 2 ".to_owned().as_str()) || first.contains("question 2"),
        "{first}"
    );
    assert!(
        !after
            .messages
            .iter()
            .any(|m| matches!(m, Message::Person { text, .. } if text.contains("question 0")))
    );
}

#[test]
fn completed_writes_are_listed_with_ids_and_arguments_and_reads_and_failures_are_not() {
    let registry = Registry::new([
        ToolDef {
            spec: ToolSpec {
                name: "send_email".into(),
                description: "".into(),
                schema: json!({}),
            },
            risk: Risk::Write,
            untrusted_output: false,
            deferred: false,
            background: false,
        },
        ToolDef {
            spec: ToolSpec {
                name: "web_search".into(),
                description: "".into(),
                schema: json!({}),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        },
    ]);
    let finished = |id: &str, name: &str, is_error: bool| {
        Event::Known(Known::ToolFinished {
            untrusted: false,
            reply: "r".into(),
            call_id: id.into(),
            name: name.into(),
            content: "".into(),
            is_error,
            images: Vec::new(),
            uncertain: false,
        })
    };
    let events = vec![
        Event::Known(Known::StepFinished {
            reply: "r".into(),
            text: "".into(),
            calls: vec![
                Call {
                    id: "c1".into(),
                    name: "send_email".into(),
                    arguments: json!({ "to": "sam@example.com" }),
                },
                Call {
                    id: "c4".into(),
                    name: "call_tool".into(),
                    arguments: json!({ "name": "send_email", "arguments": { "to": "jo@example.com" } }),
                },
            ],
            thoughts: Vec::new(),
            usage: Tokens::default(),
            cost_micros: 0,
            seen: None,
        }),
        // Allowed always: no approval request carries the arguments.
        finished("c1", "send_email", false),
        finished("c2", "web_search", false),
        finished("c3", "send_email", true),
        finished("c4", "send_email", false),
    ];
    assert_eq!(
        carried_out(&events, events.len(), &registry),
        vec![
            r#"send_email (call c1) {"to":"sam@example.com"}"#.to_owned(),
            r#"send_email (call c4) {"to":"jo@example.com"}"#.to_owned()
        ]
    );
    let text = render(
        &Summary {
            goal: "Email Sam".into(),
            decisions: vec![],
            facts: vec![],
            open: vec![],
            references: vec![],
            notes: vec![],
        },
        &carried_out(&events, events.len(), &registry),
    );
    assert!(
        text.contains("Already carried out (do not repeat):\n- send_email"),
        "{text}"
    );
}

#[test]
fn compaction_never_cuts_at_a_message_sent_while_tools_ran() {
    let call = |id: &str| Call {
        id: id.into(),
        name: "search".into(),
        arguments: json!({}),
    };
    let mut events = conversation(3);
    let steered = events.len() + 2;
    events.extend([
        Event::user_message(format!("find flights {}", "word ".repeat(200))),
        Event::reply_started("r9", "m"),
        Event::Known(Known::StepFinished {
            reply: "r9".into(),
            text: String::new(),
            calls: vec![call("c1")],
            thoughts: Vec::new(),
            usage: Tokens::default(),
            cost_micros: 0,
            seen: None,
        }),
        Event::user_message("only mornings"),
        Event::Known(Known::ToolFinished {
            untrusted: false,
            reply: "r9".into(),
            call_id: "c1".into(),
            name: "search".into(),
            content: "word ".repeat(400),
            is_error: false,
            images: Vec::new(),
            uncertain: false,
        }),
    ]);
    assert!(matches!(
        events[steered + 1],
        Event::Known(Known::UserMessage { .. })
    ));
    assert!(!safe_starts(&events, None).contains(&(steered + 1)));
    let keep_from = plan(&events, 9_000, 10_000).map(|p| p.keep_from);
    assert_ne!(keep_from, Some(steered + 1));
    assert_eq!(
        keep_from,
        Some(steered - 2),
        "it cuts at the turn's own first message"
    );
}

#[test]
fn a_summary_is_read_from_a_fenced_or_bare_json_reply() {
    let fenced = "```json\n{\"goal\":\"Trip\",\"decisions\":[],\"facts\":[],\"open\":[],\"references\":[]}\n```";
    assert_eq!(
        parse_summary(fenced).map(|s| s.goal),
        Some("Trip".to_owned())
    );
    assert_eq!(parse_summary("I could not summarise that."), None);
}

#[test]
fn writes_keep_their_ids_and_arguments_and_uncertain_ones_say_so() {
    let registry = Registry::new([
        ToolDef {
            spec: ToolSpec {
                name: "book".into(),
                description: "".into(),
                schema: json!({}),
            },
            risk: Risk::Write,
            untrusted_output: false,
            deferred: false,
            background: true,
        },
        ToolDef {
            spec: ToolSpec {
                name: "pay".into(),
                description: "".into(),
                schema: json!({}),
            },
            risk: Risk::Destructive,
            untrusted_output: false,
            deferred: false,
            background: false,
        },
    ]);
    let call = |id: &str, name: &str, at: &str| Call {
        id: id.into(),
        name: name.into(),
        arguments: json!({ "at": at }),
    };
    let known = |k: Known| Event::Known(k);
    let job = |id: &str, is_error: bool, content: &str| {
        known(Known::JobFinished {
            job: id.into(),
            name: "book".into(),
            content: content.into(),
            is_error,
            uncertain: false,
            files: Vec::new(),
            untrusted: false,
            cost_micros: None,
        })
    };
    let mut events = vec![known(Known::StepFinished {
        reply: "r".into(),
        text: "".into(),
        calls: vec![
            call("j1", "book", "9am"),
            call("j2", "book", "10am"),
            call("j3", "book", "11am"),
            call("j4", "book", "noon"),
            call("j5", "book", "1pm"),
            call("p1", "pay", "now"),
        ],
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: None,
    })];
    for id in ["j1", "j2", "j3", "j4", "j5"] {
        events.push(known(Known::JobStarted {
            reply: "r".into(),
            job: id.into(),
            name: "book".into(),
        }));
    }
    events.push(known(Known::ToolStarted {
        reply: "r".into(),
        call_id: "p1".into(),
        name: "pay".into(),
        risk: None,
        background: false,
    }));
    events.push(job("j1", false, "booked"));
    events.push(job("j2", true, "no table free"));
    events.push(job("j3", true, crate::context::JOB_STOPPED));
    let cut = events.len();
    // Finished after the cut: still counted, with the arguments from before it.
    events.push(job("j5", false, "booked"));
    assert_eq!(
        carried_out(&events, cut, &registry),
        vec![
            r#"book (call j1) {"at":"9am"}"#.to_owned(),
            r#"book (call j3) {"at":"11am"}, may have taken effect; check before trying it again"#
                .to_owned(),
            r#"book (call j4) {"at":"noon"}, still running in the background; its result has not arrived"#
                .to_owned(),
            r#"book (call j5) {"at":"1pm"}"#.to_owned(),
            r#"pay (call p1) {"at":"now"}, may have taken effect; check before trying it again"#
                .to_owned(),
        ]
    );
}

#[test]
fn right_after_a_compaction_the_old_prompt_size_does_not_compact_again() {
    let mut events = conversation(10);
    let first = plan(&events, 8_000, 10_000).map(|p| p.keep_from);
    assert!(first.is_some());
    events.push(Event::Known(Known::ContextCompacted {
        summary: "earlier".into(),
        keep_from: first.unwrap_or(0),
        tokens_before: 8_000,
        images_left_out: None,
        untrusted: false,
    }));
    assert_eq!(
        plan(&events, 8_000, 10_000),
        None,
        "the 8,000 is from before the compaction"
    );
    events.extend(turn(10, 50));
    assert!(
        plan(&events, 8_000, 10_000).is_some(),
        "a new step's size counts again"
    );
}

fn step_calling(calls: &[(&str, &str)]) -> Event {
    Event::Known(Known::StepFinished {
        reply: "r".into(),
        text: "".into(),
        calls: calls
            .iter()
            .map(|(id, name)| Call {
                id: (*id).into(),
                name: (*name).into(),
                arguments: json!({ "id": id }),
            })
            .collect(),
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: None,
    })
}

fn tool_ended(id: &str, name: &str, is_error: bool, uncertain: bool, content: &str) -> Event {
    Event::Known(Known::ToolFinished {
        untrusted: false,
        reply: "r".into(),
        call_id: id.into(),
        name: name.into(),
        content: content.into(),
        is_error,
        uncertain,
        images: Vec::new(),
    })
}

fn tool_started(id: &str, name: &str, risk: Option<Risk>, background: bool) -> Event {
    Event::Known(Known::ToolStarted {
        reply: "r".into(),
        call_id: id.into(),
        name: name.into(),
        risk,
        background,
    })
}

fn write_tool(name: &str, risk: Risk) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.into(),
            description: "".into(),
            schema: json!({}),
        },
        risk,
        untrusted_output: false,
        deferred: false,
        background: false,
    }
}

#[test]
fn writes_cut_off_or_lost_stay_in_the_do_not_repeat_list_with_their_arguments() {
    let registry = Registry::new([write_tool("send_email", Risk::Write)]);
    let events = vec![
        step_calling(&[
            ("t1", "send_email"),
            ("t2", "send_email"),
            ("t3", "send_email"),
        ]),
        // Stored as unknown: a timeout.
        tool_ended(
            "t1",
            "send_email",
            true,
            true,
            "send_email did not answer in time",
        ),
        // Stored before the outcome was recorded: known by Spade's own text.
        tool_ended("t2", "send_email", true, false, crate::context::MAYBE_RAN),
        // A real failure stays out.
        tool_ended("t3", "send_email", true, false, "mailbox full"),
    ];
    assert_eq!(
        carried_out(&events, events.len(), &registry),
        vec![
            r#"send_email (call t1) {"id":"t1"}, may have taken effect; check before trying it again"#
                .to_owned(),
            r#"send_email (call t2) {"id":"t2"}, may have taken effect; check before trying it again"#
                .to_owned(),
        ]
    );
}

#[test]
fn a_background_job_cut_off_stays_in_the_do_not_repeat_list() {
    let events = vec![
        step_calling(&[("j1", "book")]),
        tool_started("j1", "book", Some(Risk::Write), true),
        Event::Known(Known::JobStarted {
            reply: "r".into(),
            job: "j1".into(),
            name: "book".into(),
        }),
        Event::Known(Known::JobFinished {
            job: "j1".into(),
            name: "book".into(),
            content: "book did not finish within 30 minutes.".into(),
            is_error: true,
            uncertain: true,
            files: Vec::new(),
            untrusted: false,
            cost_micros: None,
        }),
    ];
    assert_eq!(
        carried_out(&events, events.len(), &Registry::default()),
        vec![
            r#"book (call j1) {"id":"j1"}, may have taken effect; check before trying it again"#
                .to_owned()
        ]
    );
}

#[test]
fn completed_writes_stay_listed_after_their_tool_is_gone_or_reclassified() {
    // ace is disconnected (its tools are gone) and `post` now reads as a read.
    let today = Registry::new([write_tool("post", Risk::Read)]);
    let events = vec![
        step_calling(&[("a1", "ace_send"), ("p1", "post"), ("s1", "search")]),
        tool_started("a1", "ace_send", Some(Risk::Write), false),
        tool_ended("a1", "ace_send", false, false, "sent"),
        tool_started("p1", "post", Some(Risk::Destructive), false),
        tool_ended("p1", "post", false, false, "posted"),
        tool_started("s1", "search", Some(Risk::Read), false),
        tool_ended("s1", "search", false, false, "found"),
    ];
    assert_eq!(
        carried_out(&events, events.len(), &today),
        vec![
            r#"ace_send (call a1) {"id":"a1"}"#.to_owned(),
            r#"post (call p1) {"id":"p1"}"#.to_owned(),
        ]
    );
}

#[test]
fn calls_stored_before_their_risk_was_recorded_fall_back_to_the_registry() {
    let registry = Registry::new([write_tool("send_email", Risk::Write)]);
    let old_start = serde_json::json!({
        "type": "tool_started", "reply": "r", "call_id": "o1", "name": "send_email"
    });
    let events = vec![
        step_calling(&[("o1", "send_email")]),
        Event::from_json(old_start),
        tool_ended("o1", "send_email", false, false, "sent"),
    ];
    assert_eq!(
        carried_out(&events, events.len(), &registry),
        vec![r#"send_email (call o1) {"id":"o1"}"#.to_owned()]
    );
}

/// A turn of `steps` steps, each calling `lookup` once and reading a long result; the turn is
/// still open, as it is before its next model call.
fn long_turn(reply: &str, steps: usize) -> Vec<Event> {
    let mut events = vec![
        Event::user_message("clean up every module"),
        Event::reply_started(reply, "m"),
    ];
    for n in 0..steps {
        let id = format!("{reply}-c{n}");
        events.push(Event::Known(Known::StepFinished {
            reply: reply.into(),
            text: String::new(),
            calls: vec![Call {
                id: id.clone(),
                name: "lookup".into(),
                arguments: json!({ "n": n }),
            }],
            thoughts: Vec::new(),
            usage: Tokens::default(),
            cost_micros: 0,
            seen: Some(events.len()),
        }));
        events.push(tool_ended(
            &id,
            "lookup",
            false,
            false,
            &"word ".repeat(200),
        ));
    }
    events
}

fn compacted(keep_from: usize) -> Event {
    Event::Known(Known::ContextCompacted {
        summary: "Summary of the earlier conversation".into(),
        keep_from,
        tokens_before: 9_000,
        images_left_out: None,
        untrusted: false,
    })
}

#[test]
fn a_turn_too_long_to_keep_whole_is_cut_at_one_of_its_own_steps() {
    let mut events = conversation(2);
    let turn_start = events.len();
    events.extend(long_turn("r9", 50));
    let keep_from = plan(&events, 9_000, 10_000).map(|p| p.keep_from);
    let Some(keep_from) = keep_from else {
        panic!("a full prompt in one long turn must still compact");
    };
    assert!(keep_from > turn_start + 1, "{keep_from}");
    assert!(matches!(
        events[keep_from],
        Event::Known(Known::StepFinished { .. })
    ));
    // The kept part is under the low mark: about 35% of 50 steps.
    let kept_steps = (events.len() - keep_from) / 2;
    assert!((10..=20).contains(&kept_steps), "{kept_steps}");

    // The model reads the summary, then whole steps: every result follows its own call.
    events.push(compacted(keep_from));
    let prompt = context::prompt(context::SYSTEM, Vec::new(), &events);
    assert!(
        matches!(&prompt.messages[0], Message::Person { text, .. } if text.starts_with("<summary>"))
    );
    assert!(matches!(&prompt.messages[1], Message::Spade { calls, .. } if calls.len() == 1));
    let mut called = Vec::new();
    for message in &prompt.messages {
        match message {
            Message::Spade { calls, .. } => called.extend(calls.iter().map(|c| c.id.clone())),
            Message::ToolResult { call_id, .. } => assert!(called.contains(call_id), "{call_id}"),
            _ => {}
        }
    }
}

#[test]
fn a_turn_of_thousands_of_steps_keeps_compacting_further_on() {
    let mut events = long_turn("r1", 60);
    let mut cut = 0;
    for round in 0..5 {
        let keep_from = plan(&events, 9_000, 10_000).map(|p| p.keep_from);
        let Some(keep_from) = keep_from else {
            panic!("round {round}: the turn did not compact");
        };
        assert!(keep_from > cut, "round {round}: {keep_from} after {cut}");
        cut = keep_from;
        events.push(compacted(keep_from));
        // A step reports the smaller prompt, then the turn goes on.
        let more = long_turn("r1", 60).split_off(2);
        events.extend(more.into_iter().map(|event| {
            match event {
                Event::Known(Known::StepFinished {
                    reply,
                    text,
                    calls,
                    thoughts,
                    usage,
                    cost_micros,
                    ..
                }) => Event::Known(Known::StepFinished {
                    reply,
                    text,
                    calls: calls
                        .into_iter()
                        .map(|c| Call {
                            id: format!("{}-{round}", c.id),
                            ..c
                        })
                        .collect(),
                    thoughts,
                    usage,
                    cost_micros,
                    seen: None,
                }),
                Event::Known(Known::ToolFinished {
                    call_id,
                    name,
                    content,
                    ..
                }) => tool_ended(&format!("{call_id}-{round}"), &name, false, false, &content),
                other => other,
            }
        }));
    }
}

#[test]
fn a_turn_is_never_cut_at_a_step_whose_prompt_missed_a_message() {
    let mut events = long_turn("r9", 3);
    // "Only the tests" arrived while the next step was being asked for, so that step never saw
    // it; cutting there would summarise away a message the model has yet to read.
    let steered = events.len();
    events.push(Event::user_message("only the tests"));
    let missed = events.len();
    events.push(Event::Known(Known::StepFinished {
        reply: "r9".into(),
        text: "Working through them.".into(),
        calls: Vec::new(),
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: Some(steered),
    }));
    assert!(!step_starts(&events, 0).contains(&missed));
    assert!(step_starts(&events, 0).contains(&2));
}

/// A write that outlived the foreground window (ADR 0158): stored as a foreground call, answered
/// at once that it moved to the background, then ended (or not) as job `id`.
fn handed_off(id: &str, name: &str) -> Vec<Event> {
    vec![
        step_calling(&[(id, name)]),
        tool_started(id, name, Some(Risk::Write), false),
        Event::Known(Known::JobStarted {
            reply: "r".into(),
            job: id.into(),
            name: name.into(),
        }),
        tool_ended(
            id,
            name,
            false,
            false,
            &crate::context::moved_to_background(id, 30),
        ),
    ]
}

fn job_ended(id: &str, name: &str, is_error: bool, uncertain: bool, content: &str) -> Event {
    Event::Known(Known::JobFinished {
        job: id.into(),
        name: name.into(),
        content: content.into(),
        is_error,
        uncertain,
        files: Vec::new(),
        untrusted: false,
        cost_micros: None,
    })
}

#[test]
fn a_write_handed_to_the_background_takes_its_outcome_from_its_job() {
    let registry = Registry::default();
    let listed = |end: Option<Event>| {
        let mut events = handed_off("w1", "deploy");
        events.extend(end);
        carried_out(&events, events.len(), &registry)
    };
    let line = |note: &str| vec![format!(r#"deploy (call w1) {{"id":"w1"}}{note}"#)];
    assert_eq!(
        listed(None),
        line(", still running in the background; its result has not arrived"),
        "no end yet: still running, not done"
    );
    assert_eq!(
        listed(Some(job_ended("w1", "deploy", false, false, "deployed"))),
        line(""),
        "done only once its job succeeded"
    );
    assert_eq!(
        listed(Some(job_ended(
            "w1",
            "deploy",
            true,
            false,
            "exit 1: build failed"
        ))),
        Vec::<String>::new(),
        "a failed job is not carried out"
    );
    let maybe = line(MAYBE);
    assert_eq!(
        listed(Some(job_ended(
            "w1",
            "deploy",
            true,
            false,
            crate::context::JOB_STOPPED
        ))),
        maybe,
        "stopped by the person: may have taken effect"
    );
    assert_eq!(
        listed(Some(job_ended(
            "w1",
            "deploy",
            true,
            true,
            crate::context::JOB_LOST
        ))),
        maybe,
        "lost in a restart: may have taken effect"
    );
}
