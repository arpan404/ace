// SPDX-License-Identifier: Apache-2.0
//! One automation and its schedule, and the automation list renderer.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome, OutputMode};

use super::super::common;
use super::render::{automation_lines, automation_list_lines, emit_lines};
use super::uncertain;
use crate::run::fail;

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(crate) fn show_value(raw: &str, id: &str) -> Result<serde_json::Value, Failure<'static>> {
    let mut value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| uncertain("automation.show", "The daemon gave no automation answer."))?;
    let found = value
        .get("automations")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|list| {
            list.iter().any(|automation| {
                automation.get("id").and_then(serde_json::Value::as_str) == Some(id)
            })
        });
    if !found {
        return Err(
            Failure::new(Outcome::Refused, format!("ace has no automation {id}."))
                .with_code(ErrorCode::NotFound)
                .with_argument("AUTOMATION")
                .with_hint("See your automations with ace automation list.")
                .with_command("automation.show"),
        );
    }
    if let Some(object) = value.as_object_mut() {
        let one = object
            .get("automations")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .find(|automation| {
                automation.get("id").and_then(serde_json::Value::as_str) == Some(id)
            });
        object.insert(
            "automations".to_owned(),
            one.map_or_else(
                || serde_json::Value::Array(Vec::new()),
                |automation| serde_json::Value::Array(vec![automation]),
            ),
        );
        let schedules = object
            .get("schedules")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|schedule| schedule.get("id").and_then(serde_json::Value::as_str) == Some(id))
            .collect();
        object.insert("schedules".to_owned(), serde_json::Value::Array(schedules));
    }
    Ok(value)
}

pub(crate) fn render_list<W: Write, E: Write>(
    raw: &str,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    render_automation(raw, output, out, err, "automation.list", |value| {
        automation_list_lines(value)
    })
}

pub(crate) fn render_show<W: Write, E: Write>(
    value: &serde_json::Value,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    match output {
        OutputMode::Json => match out.json(value) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed("automation.show", &error, out, err),
        },
        OutputMode::Human => {
            let automation = value
                .get("automations")
                .and_then(serde_json::Value::as_array)
                .and_then(|list| list.first())
                .cloned()
                .unwrap_or_default();
            let schedule = value
                .get("schedules")
                .and_then(serde_json::Value::as_array)
                .and_then(|list| list.first())
                .cloned();
            match emit_lines(out, &automation_lines(&automation, schedule.as_ref())) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed("automation.show", &error, out, err),
            }
        }
        OutputMode::Quiet => {
            let ids: Vec<String> = value
                .get("automations")
                .and_then(serde_json::Value::as_array)
                .map_or_else(Vec::new, |list| {
                    list.iter()
                        .filter_map(|automation| {
                            automation
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned)
                        })
                        .collect()
                });
            match emit_lines(out, &ids) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed("automation.show", &error, out, err),
            }
        }
    }
}

pub(crate) fn render_automation<W: Write, E: Write>(
    raw: &str,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
    command: &'static str,
    human: impl FnOnce(&serde_json::Value) -> Vec<String>,
) -> Outcome {
    match output {
        OutputMode::Json => match out.write(raw).and_then(|()| out.write("\n")) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(command, &error, out, err),
        },
        OutputMode::Human | OutputMode::Quiet => {
            let value: serde_json::Value = match serde_json::from_str(raw) {
                Ok(value) => value,
                Err(_) => {
                    return fail(
                        out,
                        err,
                        None,
                        &uncertain(command, "The daemon gave no automation answer."),
                    );
                }
            };
            let lines = match output {
                OutputMode::Human => human(&value),
                _ => value
                    .get("automations")
                    .and_then(serde_json::Value::as_array)
                    .map_or_else(Vec::new, |list| {
                        list.iter()
                            .filter_map(|automation| {
                                automation
                                    .get("id")
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_owned)
                            })
                            .collect()
                    }),
            };
            match emit_lines(out, &lines) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(command, &error, out, err),
            }
        }
    }
}

/// `--variables @FILE` reads a JSON object of strings; inline JSON still works in the window.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(crate) fn automation_variables(
    raw: Option<&str>,
) -> Result<serde_json::Value, Failure<'static>> {
    let Some(raw) = raw else {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    };
    let (path, text) = if let Some(path) = raw.strip_prefix('@') {
        match std::fs::read_to_string(path) {
            Ok(text) => (Some(path), text),
            Err(_) => {
                return Err(
                    Failure::usage(format!("Couldn't read {path} for --variables."))
                        .with_code(ErrorCode::BadArgument)
                        .with_argument("--variables"),
                );
            }
        }
    } else {
        (None, raw.to_owned())
    };
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        Failure::usage(format!(
            "--variables needs a JSON object{}.",
            path.map_or_else(String::new, |path| format!(", and {path} isn't JSON"))
        ))
        .with_code(ErrorCode::BadArgument)
        .with_argument("--variables")
        .with_hint("Write them in a file, like {\"branch\": \"main\"}.")
    })?;
    let object = value.as_object().filter(|object| {
        object.len() <= 64
            && object.iter().all(|(key, item)| {
                item.is_string()
                    && key.len() <= 128
                    && valid_variable_name(key)
                    && item.as_str().is_some_and(|text| text.len() <= 8192)
            })
    });
    match object {
        Some(_) => Ok(value),
        None => Err(
            Failure::usage("--variables must map names to text, at most 64 of them.")
                .with_code(ErrorCode::BadArgument)
                .with_argument("--variables")
                .with_hint("Names start with a letter, like {\"branch\": \"main\"}."),
        ),
    }
}

fn valid_variable_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    match bytes.next() {
        Some(b'A'..=b'Z' | b'a'..=b'z') => (),
        _ => return false,
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.'))
}
