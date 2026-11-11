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
            signatures: Vec::new(),
            usage: Tokens::default(),
            cost_micros: 0,
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
    }));
    let after = context::prompt(context::SYSTEM, tools, &events);

    assert_eq!(before.system, after.system);
    assert_eq!(before.tools, after.tools);
    let first = match &after.messages[0] {
        Message::Person { text } => text.clone(),
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
            .any(|m| matches!(m, Message::Person { text } if text.contains("question 0")))
    );
}

#[test]
fn completed_writes_are_listed_and_reads_and_failures_are_not() {
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
        },
    ]);
    let finished = |id: &str, name: &str, is_error: bool| {
        Event::Known(Known::ToolFinished {
            reply: "r".into(),
            call_id: id.into(),
            name: name.into(),
            content: "".into(),
            is_error,
        })
    };
    let events = vec![
        Event::Known(Known::StepFinished {
            reply: "r".into(),
            text: "".into(),
            calls: vec![Call {
                id: "c1".into(),
                name: "send_email".into(),
                arguments: json!({}),
            }],
            signatures: Vec::new(),
            usage: Tokens::default(),
            cost_micros: 0,
        }),
        Event::Known(Known::ApprovalRequested {
            reply: "r".into(),
            call_id: "c1".into(),
            name: "send_email".into(),
            arguments: json!({ "to": "sam@example.com" }),
        }),
        finished("c1", "send_email", false),
        finished("c2", "web_search", false),
        finished("c3", "send_email", true),
    ];
    assert_eq!(
        carried_out(&events, events.len(), &registry),
        vec![r#"send_email {"to":"sam@example.com"}"#.to_owned()]
    );
    let text = render(
        &Summary {
            goal: "Email Sam".into(),
            decisions: vec![],
            facts: vec![],
            open: vec![],
            references: vec![],
        },
        &carried_out(&events, events.len(), &registry),
    );
    assert!(
        text.contains("Already carried out (do not repeat):\n- send_email"),
        "{text}"
    );
}
