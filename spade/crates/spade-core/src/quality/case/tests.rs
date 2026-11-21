use serde_json::json;

use super::*;
use crate::event::{Call, Tokens};

fn step(reply: &str, text: &str, calls: Vec<Call>) -> Event {
    Event::Known(Known::StepFinished {
        reply: reply.into(),
        text: text.into(),
        calls,
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: None,
    })
}

fn call(id: &str, name: &str, arguments: Value) -> Call {
    Call {
        id: id.into(),
        name: name.into(),
        arguments,
    }
}

fn tool(reply: &str, call_id: &str, name: &str, content: &str) -> Event {
    Event::Known(Known::ToolFinished {
        reply: reply.into(),
        call_id: call_id.into(),
        name: name.into(),
        content: content.into(),
        is_error: false,
        uncertain: false,
        images: Vec::new(),
        untrusted: false,
    })
}

fn finished(reply: &str, text: &str) -> Event {
    Event::Known(Known::ReplyFinished {
        reply: reply.into(),
        text: text.into(),
        input_tokens: None,
        output_tokens: None,
        cost_micros: 0,
    })
}

/// Two turns: the first answered, the second asking for fares and calling the web twice.
fn conversation() -> Vec<Event> {
    vec![
        Event::user_message("Hello"),
        Event::reply_started("r_1", "e/m"),
        finished("r_1", "Hi."),
        Event::user_message("Find the cheapest fare to Lisbon"),
        Event::reply_started("r_2", "e/m"),
        step(
            "r_2",
            "Looking.",
            vec![
                call(
                    "c_1",
                    "web_fetch",
                    json!({ "url": "https://fares.example/lis" }),
                ),
                call(
                    "c_2",
                    "web_fetch",
                    json!({ "url": "https://fares.example/opo" }),
                ),
            ],
        ),
        tool("r_2", "c_1", "web_fetch", "LIS 120 EUR"),
        Event::user_message("Only direct flights"),
        tool("r_2", "c_2", "web_fetch", "OPO 90 EUR"),
        step("r_2", "The cheapest direct fare is 120 EUR.", Vec::new()),
        finished("r_2", "The cheapest direct fare is 120 EUR."),
        Event::user_message("Thanks"),
    ]
}

#[test]
fn a_run_holds_what_it_was_given_its_steps_and_its_outside_answers_in_order() {
    let run = run(&conversation(), "r_2").unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        run.given.messages,
        vec!["Find the cheapest fare to Lisbon", "Only direct flights"],
        "the message it answered and the one steered in, nothing from the turn before or after"
    );
    assert_eq!(run.trigger.kind, TriggerKind::Message);
    assert_eq!(run.steps.len(), 2);
    assert_eq!(run.steps[0].calls[1].tool, "web_fetch");
    let answers: Vec<(&str, &Value, &str)> = run
        .tool_results
        .iter()
        .map(|r| (r.tool.as_str(), &r.arguments, r.content.as_str()))
        .collect();
    assert_eq!(
        answers,
        vec![
            (
                "web_fetch",
                &json!({ "url": "https://fares.example/lis" }),
                "LIS 120 EUR"
            ),
            (
                "web_fetch",
                &json!({ "url": "https://fares.example/opo" }),
                "OPO 90 EUR"
            ),
        ]
    );
    assert_eq!(run.outcome.text, "The cheapest direct fare is 120 EUR.");
}

#[test]
fn a_reply_that_is_still_open_or_stopped_is_not_kept() {
    let mut events = conversation();
    events.push(Event::reply_started("r_3", "e/m"));
    assert_eq!(run(&events, "r_3"), Err(NotKept::NotFinished));
    events.push(Event::reply_ended(crate::ReplyEnd::Stopped, "r_3", "half"));
    assert_eq!(run(&events, "r_3"), Err(NotKept::NotFinished));
    assert_eq!(run(&events, "r_9"), Err(NotKept::NoReply));
}

#[test]
fn a_routine_run_names_its_routine_as_its_trigger() {
    let events = vec![
        Event::Known(Known::UserMessage {
            text: "Check the fares.".into(),
            context: None,
            images: Vec::new(),
            documents: Vec::new(),
            voice: None,
            from_agent: None,
            from_routine: Some(Box::new(crate::event::FromRoutine {
                id: "rt_1".into(),
                name: "Morning fares".into(),
                run: "run_1".into(),
                label: "9:00".into(),
                heartbeat: false,
                event: None,
                untrusted: false,
            })),
            from_group: None,
            from_thread: None,
        }),
        Event::reply_started("r_1", "e/m"),
        finished("r_1", "Nothing new."),
    ];
    let run = run(&events, "r_1").unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        run.trigger,
        Trigger {
            kind: TriggerKind::Routine,
            name: Some("Morning fares".into())
        }
    );
}

#[test]
fn a_kept_case_reads_back_exactly_and_keeps_one_line_of_why() {
    let run = run(&conversation(), "r_2").unwrap_or_else(|e| panic!("{e}"));
    let kept = case(
        run,
        Keep {
            id: "case_1".into(),
            bot: "a_1".into(),
            package: Some(Package {
                name: "fares".into(),
                version: "1.2.0".into(),
                hash: "ab12".into(),
            }),
            mark: Some(Mark::Wrong),
            why: Some("  It picked\n a stop-over  ".into()),
            made_at: 7,
        },
    );
    assert_eq!(kept.why.as_deref(), Some("It picked a stop-over"));
    let text = to_json(&kept).unwrap_or_else(|e| panic!("{e}"));
    let back: Case = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(back, kept);
}
