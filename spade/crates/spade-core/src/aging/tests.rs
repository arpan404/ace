use serde_json::json;
use spade_models::Message;

use super::*;
use crate::context;
use crate::event::{Call, Tokens};

const PAGE: usize = 15_000;

fn step(n: usize, name: &str) -> Event {
    Event::Known(Known::StepFinished {
        reply: "r".into(),
        text: String::new(),
        calls: vec![Call {
            id: format!("c{n}"),
            name: name.into(),
            arguments: json!({ "path": format!("src/file{n}.rs") }),
        }],
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: None,
    })
}

fn result(n: usize, name: &str, content: String, is_error: bool) -> Event {
    Event::Known(Known::ToolFinished {
        untrusted: false,
        reply: "r".into(),
        call_id: format!("c{n}"),
        name: name.into(),
        content,
        is_error,
        uncertain: false,
        images: Vec::new(),
    })
}

fn page(n: usize) -> String {
    format!("page {n} {}", "x".repeat(PAGE))
}

/// A person's message, then `steps` steps that each read a 15,000-character page.
fn task(steps: usize) -> Vec<Event> {
    let mut events = vec![
        Event::user_message("Always run the tests before you commit."),
        Event::reply_started("r", "m"),
    ];
    for n in 0..steps {
        events.push(step(n, "read_file"));
        events.push(result(n, "read_file", page(n), false));
    }
    events
}

/// Stores what `due` answers, as the engine does before each model call.
fn age(events: &mut Vec<Event>) -> bool {
    match due(events) {
        Some(before) => {
            events.push(Event::Known(Known::ResultsAged { before }));
            true
        }
        None => false,
    }
}

fn results(events: &[Event]) -> Vec<String> {
    context::prompt("system", Vec::new(), events)
        .messages
        .into_iter()
        .filter_map(|m| match m {
            Message::ToolResult { content, .. } => Some(content),
            _ => None,
        })
        .collect()
}

#[test]
fn an_old_long_result_shows_as_a_stub_that_says_how_to_get_it_back() {
    let mut events = task(16);
    assert!(age(&mut events), "sixteen 15k pages make a batch");
    let shown = results(&events);
    let first = &shown[0];
    assert!(first.len() < 600, "{first}");
    assert!(first.contains("read_file"), "{first}");
    assert!(first.contains("src/file0.rs"), "what it was for: {first}");
    assert!(
        first.contains(&format!("{}", PAGE + 7)),
        "its size: {first}"
    );
    // The first result is event 4 (seq 4): message, reply, step, result.
    assert!(
        first.contains(r#"history_read {"from": 4, "count": 1}"#),
        "{first}"
    );
    // The latest results are whole.
    let last = shown.last().map(String::as_str).unwrap_or_default();
    assert!(
        last.starts_with("page 15 ") && last.len() > PAGE,
        "{last:.40}"
    );
    let whole = shown.iter().filter(|r| r.len() > PAGE).count();
    assert!(whole >= KEEP_RESULTS, "{whole} whole");
}

#[test]
fn the_persons_words_errors_answers_and_short_results_never_age() {
    let mut events = task(0);
    events.push(step(100, context::ASK_USER));
    events.push(result(100, context::ASK_USER, "y".repeat(PAGE), false));
    events.push(step(101, "shell"));
    events.push(result(
        101,
        "shell",
        format!("error: {}", "e".repeat(PAGE)),
        true,
    ));
    events.push(step(102, "read_file"));
    events.push(result(102, "read_file", "short".into(), false));
    for n in 0..16 {
        events.push(step(n, "read_file"));
        events.push(result(n, "read_file", page(n), false));
    }
    assert!(age(&mut events));
    let prompt = context::prompt("system", Vec::new(), &events);
    let person = prompt.messages.iter().find_map(|m| match m {
        Message::Person { text, .. } => Some(text.clone()),
        _ => None,
    });
    assert!(
        person.is_some_and(|t| t.contains("Always run the tests before you commit.")),
        "the person's message is whole"
    );
    let shown = results(&events);
    assert_eq!(shown[0].len(), PAGE, "the person's answer");
    assert!(
        shown[1].starts_with("error: ") && shown[1].len() > PAGE,
        "an error"
    );
    assert_eq!(shown[2], "short");
    assert!(shown[3].starts_with("[Aged:"), "{:.60}", shown[3]);
}

#[test]
fn aging_waits_for_a_batch_and_the_prompt_only_grows_at_its_end_between_batches() {
    let mut events = task(1);
    let mut previous = context::prompt("system", Vec::new(), &events).messages;
    let mut batches = 0;
    for n in 1..60 {
        events.push(step(n, "read_file"));
        events.push(result(n, "read_file", page(n), false));
        let aged = age(&mut events);
        let now = context::prompt("system", Vec::new(), &events).messages;
        let grew = now.len() >= previous.len() && now[..previous.len()] == previous[..];
        if aged {
            batches += 1;
            assert!(!grew, "a batch changes earlier bytes, once");
        } else {
            assert!(
                grew,
                "between batches the prompt only grows at its end (step {n})"
            );
        }
        previous = now;
    }
    // About 64,000 characters go per batch: four or five pages, so far fewer batches than steps.
    assert!((8..=14).contains(&batches), "{batches} batches in 60 steps");
}

#[test]
fn deciding_reads_only_the_prompts_span_not_the_history_before_a_compaction() {
    // A long history summarised away, with nothing aged in it: everything before the cut is
    // out of view, so nothing there makes a batch due.
    let mut events = task(40);
    let cut = events.len();
    events.push(Event::user_message("Now the next part."));
    events.push(Event::Known(Known::ContextCompacted {
        summary: "Summary".into(),
        keep_from: cut,
        tokens_before: 0,
        images_left_out: None,
        untrusted: false,
        carried: None,
        asks: None,
    }));
    for n in 100..104 {
        events.push(step(n, "read_file"));
        events.push(result(n, "read_file", page(n), false));
    }
    assert_eq!(due(&events), None);
    assert_eq!(boundary(&events), 0);
}
