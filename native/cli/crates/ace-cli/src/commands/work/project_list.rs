// SPDX-License-Identifier: Apache-2.0
//! `ace project list`: your projects, in the daemon's order.

use std::io::Write;

use super::common::{connect, emit_json_or, limit_flag, mode, timeout_duration, wire_failure};
use super::lists::project_list_lines;
use crate::run::fail;
use cli_out::{ErrorCode, Failure, Out, Outcome, OutputMode};
use cli_parse::Parsed;
use serde::Deserialize;

#[derive(serde::Serialize)]
struct ListOperation<'a> {
    op: &'static str,
    limit: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<&'a str>,
}

#[derive(serde::Serialize)]
struct ListRequest<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    operation: ListOperation<'a>,
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    result: &'a serde_json::value::RawValue,
}

pub fn run<W: Write, E: Write>(parsed: &Parsed<'_>, out: &mut Out<W>, err: &mut Out<E>) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let limit = match limit_flag(&parsed.flags, 50, 100) {
        Ok(limit) => limit,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let after = parsed.flags.value("after").map(str::to_owned);
    let mode = mode(parsed);
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    match run_inner(&mut conn, limit, after.as_deref(), timeout, mode, out) {
        Ok(outcome) => outcome,
        Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
    }
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn run_inner<W: Write>(
    conn: &mut cli_wire::Connection,
    limit: u64,
    after: Option<&str>,
    timeout: std::time::Duration,
    mode: OutputMode,
    out: &mut Out<W>,
) -> Result<Outcome, Failure<'static>> {
    let operation = ListRequest {
        msg_type: "projects.request",
        operation: ListOperation {
            op: "workspace.list",
            limit,
            after,
        },
    };
    let reply = conn
        .request_with_timeout(&operation, timeout)
        .map_err(|err| wire_failure(&err, Some("project.list")))?;
    let envelope: Envelope<'_> = reply
        .decode()
        .map_err(|err| wire_failure(&err, Some("project.list")))?;
    let result_value: serde_json::Value =
        serde_json::from_str(envelope.result.get()).map_err(|_| {
            Failure::new(Outcome::Uncertain, "Project list unavailable")
                .with_code(ErrorCode::Uncertain)
                .with_command("project.list")
        })?;
    let kind = result_value
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if kind != "projects" {
        if kind == "error" {
            let code = result_value
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let message = if code.is_empty() {
                "Project list unavailable".to_owned()
            } else {
                code.to_owned()
            };
            return Err(Failure::new(Outcome::Refused, message)
                .with_code(ErrorCode::Refused)
                .with_command("project.list"));
        }
        return Err(Failure::new(Outcome::Refused, "Project list unavailable")
            .with_code(ErrorCode::Refused)
            .with_command("project.list"));
    }
    if mode == OutputMode::Json {
        emit_json_or(out, mode, envelope.result, &[], &[]).map_err(|error| {
            Failure::new(
                Outcome::Failed,
                format!("ace couldn't write its output: {error}"),
            )
            .with_code(ErrorCode::Internal)
            .with_command("project.list")
        })?;
        return Ok(Outcome::Ok);
    }
    let projects = result_value
        .get("projects")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    let next = result_value.get("next").and_then(serde_json::Value::as_str);
    let human = project_list_lines(&projects, next);
    let quiet: Vec<String> = projects.as_array().map_or(Vec::new(), |list| {
        list.iter()
            .filter_map(|p| {
                p.get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .collect()
    });
    emit_json_or(out, mode, envelope.result, &human, &quiet).map_err(|error| {
        Failure::new(
            Outcome::Failed,
            format!("ace couldn't write its output: {error}"),
        )
        .with_code(ErrorCode::Internal)
        .with_command("project.list")
    })?;
    Ok(Outcome::Ok)
}
