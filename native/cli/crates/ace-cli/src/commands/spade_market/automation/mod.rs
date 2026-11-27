// SPDX-License-Identifier: Apache-2.0
//! `ace automation list|show|run|remove` (ADR 0178 §7), over the daemon's automation requests.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome, OutputMode};
use cli_parse::Parsed;
use cli_wire::Connection;

use super::common;
use crate::commands::work::common::{connect, mode, timeout_duration};
use crate::run::fail;

pub(crate) mod read;
pub(crate) mod render;

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
        Ok(raw) => read::render_list(&raw, output, out, err),
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
    match read::show_value(&raw, id) {
        Ok(value) => read::render_show(&value, output, out, err),
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
    let variables = match read::automation_variables(parsed.flags.value("variables")) {
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
        .map_err(|err| crate::commands::work::common::wire_failure(&err, Some(command)))?;
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

pub(crate) fn uncertain(command: &'static str, message: &str) -> Failure<'static> {
    Failure::new(Outcome::Uncertain, message.to_owned())
        .with_code(ErrorCode::Uncertain)
        .with_command(command)
}

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

pub(crate) fn admit_value<W: Write, E: Write>(
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
    render::render_admit(&value, id, command, output, out, err, key)
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

/* Human lines for `ace automation` (ADR 0178 §3). Pure: the daemon's answer → lines. */
