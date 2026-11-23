// SPDX-License-Identifier: Apache-2.0
//! `ace automation list|show|run|remove` (ADR 0178 §7), over the daemon's automation requests.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome, OutputMode};
use cli_parse::Parsed;
use cli_wire::Connection;

use super::common;
use crate::commands::work::common::{connect, mode, timeout_duration, wire_failure};
use crate::run::fail;

pub fn run_list<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let output = mode(parsed);
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    match ask(
        &mut conn,
        "automation.list",
        &automation_list_frame(),
        timeout,
    ) {
        Ok(raw) => render_list(&raw, output, out, err),
        Err(failure) => fail(
            out,
            err,
            Some(&parsed.flags),
            &failure.with_command(parsed.command.id),
        ),
    }
}

pub fn run_show<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let output = mode(parsed);
    let id = parsed.words.first().copied().unwrap_or("");
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let raw = match ask(
        &mut conn,
        "automation.show",
        &automation_list_frame(),
        timeout,
    ) {
        Ok(raw) => raw,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    match show_value(&raw, id) {
        Ok(value) => render_show(&value, output, out, err),
        Err(failure) => fail(
            out,
            err,
            Some(&parsed.flags),
            &failure.with_command(parsed.command.id),
        ),
    }
}

pub fn run_run<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let output = mode(parsed);
    let id = parsed.words.first().copied().unwrap_or("").to_owned();
    // The session opens first: usage errors surface only once ace answers.
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let key = match common::idempotency_key(&parsed.flags) {
        Ok(key) => key,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let variables = match automation_variables(parsed.flags.value("variables")) {
        Ok(variables) => variables,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let mut operation = serde_json::Map::new();
    operation.insert("type".to_owned(), "automation.run".into());
    operation.insert("id".to_owned(), id.clone().into());
    operation.insert("variables".to_owned(), variables);
    if let Some(message) = parsed.flags.value("message") {
        operation.insert("message".to_owned(), message.to_owned().into());
    }
    let frame = serde_json::Value::Object(operation);
    let raw = match admit(&mut conn, &frame, &key, "automation.run", timeout) {
        Ok(raw) => raw,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    admit_value(&raw, &key, &id, "automation.run", output, out, err)
}

pub fn run_remove<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let output = mode(parsed);
    let id = parsed.words.first().copied().unwrap_or("").to_owned();
    // The session opens first: usage errors surface only once ace answers.
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let key = match common::idempotency_key(&parsed.flags) {
        Ok(key) => key,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let frame = serde_json::json!({"type": "automation.remove", "id": id});
    let raw = match admit(&mut conn, &frame, &key, "automation.remove", timeout) {
        Ok(raw) => raw,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    admit_value(&raw, &key, &id, "automation.remove", output, out, err)
}

fn automation_list_frame() -> serde_json::Value {
    serde_json::json!({"type": "automation.list"})
}

/// One `automation.*` request; a missing answer or a refusal becomes the CLI's failure.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn ask(
    conn: &mut Connection,
    command: &'static str,
    frame: &serde_json::Value,
    timeout: std::time::Duration,
) -> Result<String, Failure<'static>> {
    let reply = conn
        .request_with_timeout(frame, timeout)
        .map_err(|err| wire_failure(&err, Some(command)))?;
    let raw: &serde_json::value::RawValue = reply
        .decode()
        .map_err(|_| uncertain(command, "The daemon gave no automation answer."))?;
    check_automation_result(raw.get(), command)?;
    Ok(raw.get().to_owned())
}

/// The daemon's answer, or the refusal it carries.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn check_automation_result(raw: &str, command: &'static str) -> Result<(), Failure<'static>> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| uncertain(command, "The daemon gave no automation answer."))?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("automation.result") {
        return Err(uncertain(command, "The daemon gave no automation answer."));
    }
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let error = value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("ace refused it.");
        let not_found = error.contains("not found") || error.contains("unknown automation");
        return Err(Failure::new(Outcome::Refused, error.to_owned())
            .with_code(if not_found {
                ErrorCode::NotFound
            } else {
                ErrorCode::Refused
            })
            .with_hint("See your automations with ace automation list.")
            .with_command(command));
    }
    Ok(())
}

fn uncertain(command: &'static str, message: &str) -> Failure<'static> {
    Failure::new(Outcome::Uncertain, message.to_owned())
        .with_code(ErrorCode::Uncertain)
        .with_command(command)
}

/// A mutation's receipt: admitted under its key, retried with the same key it runs once.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn admit(
    conn: &mut Connection,
    frame: &serde_json::Value,
    key: &str,
    command: &'static str,
    timeout: std::time::Duration,
) -> Result<String, Failure<'static>> {
    let Ok(request_id) = cli_wire::RequestId::parse(key.to_owned()) else {
        return Err(uncertain(
            command,
            "ace didn't confirm the automation request.",
        ));
    };
    let reply = conn
        .request_with_id_timeout(frame, &request_id, timeout)
        .map_err(|err| admit_failure(&err, key, command))?;
    let raw: &serde_json::value::RawValue = reply
        .decode()
        .map_err(|_| uncertain(command, "The daemon gave no automation answer."))?;
    check_automation_result(raw.get(), command)?;
    Ok(raw.get().to_owned())
}

fn admit_failure(err: &cli_wire::WireError, key: &str, command: &'static str) -> Failure<'static> {
    match err {
        cli_wire::WireError::Timeout { .. } | cli_wire::WireError::Offline { .. } => {
            let mut failure = Failure::new(
                Outcome::Uncertain,
                "ace didn't confirm the automation request, so it may or may not have run.",
            )
            .with_code(ErrorCode::Uncertain)
            .with_command(command);
            failure.retry = Some(cli_out::Retry {
                idempotency_key: std::borrow::Cow::Owned(key.to_owned()),
            });
            failure
        }
        _ => crate::commands::work::common::wire_failure(err, Some(command)),
    }
}

/// The receipt of a mutation that might not have run: retried with its key, it runs once.
fn admit_value<W: Write, E: Write>(
    raw: &str,
    key: &str,
    id: &str,
    command: &'static str,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let mut value: serde_json::Value = match serde_json::from_str(raw) {
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
    if let Some(object) = value.as_object_mut() {
        object.insert("idempotencyKey".to_owned(), key.to_owned().into());
        object.insert("automationId".to_owned(), id.to_owned().into());
    }
    render_admit(&value, id, command, output, out, err, key)
}

fn render_admit<W: Write, E: Write>(
    value: &serde_json::Value,
    id: &str,
    command: &'static str,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
    key: &str,
) -> Outcome {
    match output {
        OutputMode::Json => match out.json(value) {
            Ok(()) => Outcome::Ok,
            Err(_error) => fail(out, err, None, &common::uncertain_write(command, key)),
        },
        OutputMode::Human => {
            let lines: Vec<String> = if command == "automation.run" {
                automation_run_lines(value, id)
            } else {
                vec![format!("Automation {id} is removed.")]
            };
            match emit_lines(out, &lines) {
                Ok(()) => Outcome::Ok,
                Err(_) => fail(out, err, None, &common::uncertain_write(command, key)),
            }
        }
        OutputMode::Quiet => {
            let quiet_ids: Vec<String> = if command == "automation.run" {
                value
                    .get("run")
                    .and_then(|run| run.get("threadId"))
                    .and_then(serde_json::Value::as_str)
                    .map_or_else(Vec::new, |thread| vec![thread.to_owned()])
            } else {
                Vec::new()
            };
            match emit_lines(out, &quiet_ids) {
                Ok(()) => Outcome::Ok,
                Err(_) => fail(out, err, None, &common::uncertain_write(command, key)),
            }
        }
    }
}

/// One automation and its schedule, from the list; not found is a refusal naming the list.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn show_value(raw: &str, id: &str) -> Result<serde_json::Value, Failure<'static>> {
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

fn render_list<W: Write, E: Write>(
    raw: &str,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    render_automation(raw, output, out, err, "automation.list", |value| {
        automation_list_lines(value)
    })
}

fn render_show<W: Write, E: Write>(
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

fn render_automation<W: Write, E: Write>(
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

fn emit_lines<W: Write>(out: &mut Out<W>, lines: &[String]) -> Result<(), cli_out::WriteError> {
    for line in lines {
        out.line(line)?;
    }
    Ok(())
}

/// `--variables @FILE` reads a JSON object of strings; inline JSON still works in the window.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn automation_variables(raw: Option<&str>) -> Result<serde_json::Value, Failure<'static>> {
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

/* Human lines for `ace automation` (ADR 0178 §3). Pure: the daemon's answer → lines. */

fn trigger_text(automation: &serde_json::Value) -> String {
    let trigger = automation.get("trigger").cloned().unwrap_or_default();
    match trigger.get("kind").and_then(serde_json::Value::as_str) {
        Some("manual") => "by hand".to_owned(),
        Some("schedule") => {
            let kind = trigger
                .get("schedule")
                .and_then(|schedule| schedule.get("kind"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let expression = trigger
                .get("schedule")
                .and_then(|schedule| schedule.get("expression"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            format!("{kind} {expression}")
        }
        Some("github") => {
            let repository = trigger
                .get("repository")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let event = trigger
                .get("event")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .replace('_', " ");
            format!("{repository} {event}")
        }
        Some("file") => {
            let paths = trigger
                .get("paths")
                .and_then(serde_json::Value::as_array)
                .map_or_else(Vec::new, |paths| {
                    paths
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                });
            if paths.len() == 1 {
                format!("when {} change", paths[0])
            } else {
                format!("when {} paths change", paths.len())
            }
        }
        Some("webhook") => "webhook".to_owned(),
        _ => String::new(),
    }
}

fn when_text(at: i64) -> String {
    let text = chrono::DateTime::from_timestamp_millis(at)
        .map(|date| date.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    text.get(..16).unwrap_or(&text).to_owned()
}

fn run_glyph(status: &str) -> &'static str {
    match status {
        "queued" | "running" => "◌",
        "succeeded" => "✓",
        "failed" => "✕",
        _ => "-",
    }
}

fn automation_list_lines(response: &serde_json::Value) -> Vec<String> {
    let empty = Vec::new();
    let automations = response
        .get("automations")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    if automations.is_empty() {
        return vec![
            "No automations yet. Make one in the app, or ace automation create @FILE.".to_owned(),
        ];
    }
    let width = automations
        .iter()
        .map(|automation| {
            automation
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .len()
        })
        .max()
        .unwrap_or(0)
        .min(32);
    let schedules: std::collections::BTreeMap<&str, &serde_json::Value> = response
        .get("schedules")
        .and_then(serde_json::Value::as_array)
        .map_or_else(std::collections::BTreeMap::new, |list| {
            list.iter()
                .filter_map(|schedule| {
                    schedule
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(|id| (id, schedule))
                })
                .collect()
        });
    automations
        .iter()
        .map(|automation| {
            let id = automation
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let title = automation
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let schedule = schedules.get(id).copied();
            let state = if automation
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                ""
            } else {
                "off  "
            };
            let next = schedule
                .and_then(|schedule| schedule.get("nextRunAt"))
                .and_then(serde_json::Value::as_i64)
                .map(|at| format!("  next {}", when_text(at)))
                .unwrap_or_default();
            let last = schedule
                .and_then(|schedule| schedule.get("lastRun"))
                .map(|last| {
                    let status = last
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    format!("  {} {status}", run_glyph(status))
                })
                .unwrap_or_default();
            let failing = schedule.is_some_and(|schedule| {
                schedule.get("triggerError").is_some() || schedule.get("lastPollError").is_some()
            });
            let problem = if failing { "  ✕ trigger failing" } else { "" };
            format!(
                "{title:<width$}  {id}  {state}{}{next}{last}{problem}",
                trigger_text(automation)
            )
        })
        .collect()
}

fn automation_lines(
    automation: &serde_json::Value,
    schedule: Option<&serde_json::Value>,
) -> Vec<String> {
    let title = automation
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let id = automation
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let enabled = automation
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let workspace = automation
        .get("workspace")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let worktree = automation
        .get("worktree")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let provider = automation
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let model = automation
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let mut lines = vec![
        format!("{title}  {id}{}", if enabled { "" } else { "  (off)" }),
        format!("Runs         {}", trigger_text(automation)),
        format!(
            "In           {workspace}{}",
            if worktree { ", in a worktree" } else { "" }
        ),
        format!(
            "With         {provider}{}",
            if model.is_empty() {
                String::new()
            } else {
                format!(" {model}")
            }
        ),
    ];
    if let Some(next) = schedule
        .and_then(|schedule| schedule.get("nextRunAt"))
        .and_then(serde_json::Value::as_i64)
    {
        lines.push(format!("Next run     {}", when_text(next)));
    }
    if let Some(last) = schedule.and_then(|schedule| schedule.get("lastRun")) {
        let status = last
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let started = last
            .get("startedAt")
            .and_then(serde_json::Value::as_i64)
            .map_or_else(String::new, when_text);
        let thread = last
            .get("threadId")
            .and_then(serde_json::Value::as_str)
            .map_or_else(String::new, |thread| format!(", thread {thread}"));
        lines.push(format!(
            "Last run     {} {status}, {started}{thread}",
            run_glyph(status)
        ));
    }
    let error = schedule
        .and_then(|schedule| {
            schedule
                .get("triggerError")
                .or_else(|| schedule.get("lastPollError"))
        })
        .and_then(|error| error.get("message"))
        .and_then(serde_json::Value::as_str);
    if let Some(error) = error {
        lines.push(format!("✕ {error}"));
    }
    if let Some(url) = schedule
        .and_then(|schedule| schedule.get("webhook"))
        .and_then(|webhook| webhook.get("url"))
        .and_then(serde_json::Value::as_str)
    {
        lines.push(format!("Webhook      {url}"));
    }
    let prompt = automation
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    lines.push(String::new());
    lines.push(prompt.split('\n').next().unwrap_or("").to_owned());
    lines.push(String::new());
    lines.push(format!("Run it now with ace automation run {id}"));
    lines
}

fn automation_run_lines(result: &serde_json::Value, automation_id: &str) -> Vec<String> {
    let run = result.get("run");
    let Some(run) = run else {
        return vec![format!("Automation {automation_id} was started.")];
    };
    let status = run
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let thread = run
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .map_or_else(String::new, |thread| format!(" in thread {thread}"));
    let mut lines = vec![if status == "queued" {
        format!("Automation {automation_id} is queued behind its running one{thread}.")
    } else {
        format!("Automation {automation_id} is {status}{thread}.")
    }];
    if let Some(thread) = run.get("threadId").and_then(serde_json::Value::as_str) {
        lines.push(format!("Follow it with ace thread wait {thread}"));
    }
    lines
}
