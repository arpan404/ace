use serde_json::json;

use super::*;
use crate::event::{Call, Tokens};

fn write_step(id: &str, content: &str) -> Event {
    Event::Known(Known::StepFinished {
        reply: "r".into(),
        text: "".into(),
        calls: vec![Call {
            id: id.into(),
            name: "workspace_write".into(),
            arguments: json!({ "path": format!("notes/{id}.md"), "content": content }),
        }],
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: None,
    })
}

fn started(id: &str, background: bool) -> Event {
    Event::Known(Known::ToolStarted {
        reply: "r".into(),
        call_id: id.into(),
        name: "workspace_write".into(),
        risk: Some(Risk::Write),
        background,
    })
}

fn finished(id: &str) -> Event {
    Event::Known(Known::ToolFinished {
        untrusted: false,
        reply: "r".into(),
        call_id: id.into(),
        name: "workspace_write".into(),
        content: "written".into(),
        is_error: false,
        images: Vec::new(),
        uncertain: false,
    })
}

fn job_started(id: &str) -> Event {
    Event::Known(Known::JobStarted {
        reply: "r".into(),
        job: id.into(),
        name: "workspace_write".into(),
    })
}

fn job_finished(id: &str, is_error: bool) -> Event {
    Event::Known(Known::JobFinished {
        job: id.into(),
        name: "workspace_write".into(),
        content: if is_error { "disk full" } else { "written" }.into(),
        is_error,
        uncertain: false,
        files: Vec::new(),
        untrusted: false,
        cost_micros: None,
    })
}

fn written(id: &str, content: &str) -> Vec<Event> {
    vec![write_step(id, content), started(id, false), finished(id)]
}

/// Compacts at the end, as the engine does: the list stored with the summary.
fn compact(events: &mut Vec<Event>) {
    events.push(Event::user_message("go on"));
    let keep_from = events.len() - 1;
    let ledger = ledger(events, keep_from, &Registry::default());
    events.push(Event::Known(Known::ContextCompacted {
        summary: "earlier".into(),
        keep_from,
        tokens_before: 0,
        images_left_out: None,
        untrusted: false,
        carried: Some(ledger),
    }));
}

fn listed(events: &[Event]) -> Vec<String> {
    carried_out(events, events.len(), &Registry::default())
}

#[test]
fn over_weeks_of_compactions_the_list_stays_bounded_and_keeps_every_recent_write() {
    let big = "x".repeat(50_000);
    let mut events = Vec::new();
    for round in 0..400 {
        events.extend(written(&format!("w{round}"), &big));
        compact(&mut events);
    }
    events.extend(written("w400", &big));
    let lines = listed(&events);
    let size: usize = lines.iter().map(String::len).sum();
    assert!(
        size < CARRIED_CHARS + 2_000,
        "the list grew to {size} characters"
    );
    for recent in ["w400", "w399", "w398", "w390", "w380"] {
        assert!(
            lines
                .iter()
                .any(|l| l.contains(&format!("(call {recent})"))),
            "{recent} is missing from {lines:?}"
        );
    }
    let counted: u64 = lines[0]
        .split(' ')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    assert_eq!(
        counted + lines.len() as u64 - 1,
        401,
        "every write is either listed or counted: {}",
        lines[0]
    );
}

#[test]
fn a_write_with_huge_arguments_is_listed_on_one_short_line() {
    let events = written("w1", &format!("line one\n{}", "y".repeat(2_000_000)));
    let lines = listed(&events);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].len() < 600, "{} characters", lines[0].len());
    assert!(
        lines[0].starts_with(
            r#"workspace_write (call w1) {"path":"notes/w1.md","content":"line one\ny"#
        ),
        "{}",
        lines[0]
    );
    assert!(lines[0].contains("(2000009 characters)"), "{}", lines[0]);
}

#[test]
fn a_job_running_at_one_compaction_shows_its_end_at_the_next() {
    for (failed, expected) in [
        (
            false,
            vec!["workspace_write (call j1) {\"path\":\"notes/j1.md\",\"content\":\"a\"}"],
        ),
        (true, vec![]),
    ] {
        let mut events = vec![
            write_step("j1", "a"),
            started("j1", true),
            job_started("j1"),
        ];
        compact(&mut events);
        assert!(
            listed(&events)[0]
                .ends_with("still running in the background; its result has not arrived"),
            "{:?}",
            listed(&events)
        );
        events.push(job_finished("j1", failed));
        compact(&mut events);
        assert_eq!(listed(&events), expected, "failed: {failed}");
    }
}

#[test]
fn a_summary_stored_without_a_list_makes_the_next_compaction_walk_from_the_start() {
    let mut events = written("old", "a");
    events.push(Event::user_message("go on"));
    events.push(Event::Known(Known::ContextCompacted {
        summary: "Already carried out (do not repeat):\n- workspace_write (call old) …".into(),
        keep_from: events.len() - 1,
        tokens_before: 0,
        images_left_out: None,
        untrusted: false,
        carried: None,
    }));
    events.extend(written("new", "b"));
    let lines = listed(&events);
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(lines[0].contains("(call old)") && lines[1].contains("(call new)"));
}

#[test]
fn a_write_already_listed_by_an_earlier_summary_is_listed_once() {
    let mut events = written("w1", "a");
    compact(&mut events);
    compact(&mut events);
    events.extend(written("w2", "b"));
    compact(&mut events);
    let lines = listed(&events);
    assert_eq!(lines.len(), 2, "{lines:?}");
}
