// SPDX-License-Identifier: Apache-2.0
//! What a market command prints: the answer's data unchanged, lines for a person, ids for quiet.

use std::io::Write;

use cli_out::{Out, Outcome, OutputMode};

use super::common;
use super::market_publish::publish_lines;
use super::market_render::{
    discover_lines, entry_lines, installed_lines, publisher_lines, search_lines, source_lines,
};

pub(crate) fn render_answer<W: Write, E: Write>(
    answer: &serde_json::Value,
    command: &'static str,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let op = answer
        .get("op")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let printed = printed_value(answer, op);
    match output {
        OutputMode::Json => match out.json(&printed.value) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(command, &error, out, err),
        },
        OutputMode::Human => {
            let lines = printed.human.unwrap_or_else(|| vec!["Done.".to_owned()]);
            match lines.iter().try_for_each(|line| out.line(line)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(command, &error, out, err),
            }
        }
        OutputMode::Quiet => {
            let ids = printed.quiet.unwrap_or_default();
            match ids.iter().try_for_each(|id| out.line(id)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(command, &error, out, err),
            }
        }
    }
}
struct Printed {
    value: serde_json::Value,
    human: Option<Vec<String>>,
    quiet: Option<Vec<String>>,
}
fn entry_id(entry: &serde_json::Value) -> String {
    format!(
        "{}/{}",
        entry
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(""),
        entry
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    )
}
fn print_discover(answer: &serde_json::Value) -> Printed {
    let discover = answer.get("discover").cloned().unwrap_or_default();
    let human = discover_lines(&discover);
    Printed {
        value: discover,
        human: Some(human),
        quiet: Some(Vec::new()),
    }
}
fn print_sources(answer: &serde_json::Value) -> Printed {
    let sources = answer
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let human = source_lines(&sources);
    let quiet = sources
        .iter()
        .filter_map(|source| {
            source
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    Printed {
        value: serde_json::json!({"sources": sources}),
        human: Some(human),
        quiet: Some(quiet),
    }
}
fn print_done(answer: &serde_json::Value) -> Printed {
    let mut value = serde_json::json!({"ok": true});
    if let Some(installed) = answer.get("installed")
        && let Some(object) = value.as_object_mut()
    {
        object.insert("installed".to_owned(), installed.clone());
    }
    Printed {
        value,
        human: Some(vec!["Done.".to_owned()]),
        quiet: Some(Vec::new()),
    }
}
fn strip_op(answer: &serde_json::Value) -> serde_json::Value {
    match answer.as_object() {
        Some(object) => serde_json::Value::Object(
            object
                .iter()
                .filter(|(key, _)| *key != "op")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        None => answer.clone(),
    }
}

/// What a market command prints: the answer's data unchanged, lines for a person, ids for quiet.
fn print_search(answer: &serde_json::Value) -> Printed {
    let value = strip_op(answer);
    let human = search_lines(answer);
    let quiet = answer
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .map_or_else(Vec::new, |entries| entries.iter().map(entry_id).collect());
    Printed {
        value,
        human: Some(human),
        quiet: Some(quiet),
    }
}

fn print_read(answer: &serde_json::Value) -> Printed {
    let entry = answer.get("entry").cloned().unwrap_or_default();
    let human = entry_lines(&entry);
    Printed {
        value: serde_json::json!({"kind": "entry", "entry": entry}),
        human: Some(human),
        quiet: Some(Vec::new()),
    }
}

fn print_publisher(answer: &serde_json::Value) -> Printed {
    let page = answer.get("page").cloned().unwrap_or_default();
    let human = publisher_lines(&page);
    Printed {
        value: serde_json::json!({"kind": "publisher", "page": page}),
        human: Some(human),
        quiet: Some(Vec::new()),
    }
}

fn print_installed(answer: &serde_json::Value) -> Printed {
    let installed = answer
        .get("installed")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let human = installed_lines(&installed);
    let quiet = installed.iter().map(entry_id).collect();
    Printed {
        value: serde_json::json!({"installed": installed}),
        human: Some(human),
        quiet: Some(quiet),
    }
}

fn print_publish(answer: &serde_json::Value) -> Printed {
    let inner = answer.get("answer").cloned().unwrap_or_default();
    let human = publish_lines(&inner);
    let quiet = match inner.get("kind").and_then(serde_json::Value::as_str) {
        Some("draft") => inner
            .get("draft")
            .and_then(|draft| draft.get("id"))
            .and_then(serde_json::Value::as_str)
            .map_or_else(Vec::new, |id| vec![id.to_owned()]),
        Some("me") => inner
            .get("me")
            .and_then(|me| me.get("drafts"))
            .and_then(serde_json::Value::as_array)
            .map_or_else(Vec::new, |drafts| {
                drafts
                    .iter()
                    .filter_map(|draft| {
                        draft
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
                    .collect()
            }),
        _ => Vec::new(),
    };
    Printed {
        value: inner,
        human: Some(human),
        quiet: Some(quiet),
    }
}

fn printed_value(answer: &serde_json::Value, op: &str) -> Printed {
    match op {
        "discover" => print_discover(answer),
        "search" => print_search(answer),
        "read" => print_read(answer),
        "publisher" => print_publisher(answer),
        "installed" => print_installed(answer),
        "sources" => print_sources(answer),
        "done" => print_done(answer),
        "publish" => print_publish(answer),
        _ => Printed {
            value: strip_op(answer),
            human: None,
            quiet: None,
        },
    }
}
