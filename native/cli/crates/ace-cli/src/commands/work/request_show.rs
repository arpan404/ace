// SPDX-License-Identifier: Apache-2.0
//! `ace request show`: one request in full.

use std::io::{IsTerminal as _, Write};

use cli_out::{Env, ErrorCode, Failure, Out, Outcome, OutputMode, Stream, Terminal, use_color};
use cli_parse::Parsed;
use serde::Deserialize;

use super::common::{connect, mode, timeout_duration, wire_failure};
use super::render::{request_show_lines, resolve_request_ref};
use crate::handover;
use crate::run::fail;

#[derive(Deserialize)]
struct CliResultEnvelope<'a> {
    #[serde(borrow)]
    result: &'a serde_json::value::RawValue,
}

#[derive(Deserialize)]
struct CliResult<'a> {
    ok: bool,
    #[serde(borrow, default)]
    data: Option<&'a serde_json::value::RawValue>,
}

#[derive(serde::Serialize)]
struct ListOperation {
    op: &'static str,
    limit: u64,
}

#[derive(serde::Serialize)]
struct ListRequest {
    #[serde(rename = "type")]
    msg_type: &'static str,
    operation: ListOperation,
}

pub fn run<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    if parsed.words.is_empty() {
        let env = Env::from_process();
        let terminal = Terminal {
            stdin: std::io::stdin().is_terminal(),
            stdout: std::io::stdout().is_terminal(),
            stderr: false,
        };
        if cli_out::can_prompt(&parsed.flags, &env, terminal) {
            return handover(os_args, parsed, out, err);
        }
        let failure = Failure::usage("ace request show needs REQUEST.")
            .with_code(ErrorCode::MissingArgument)
            .with_argument("REQUEST")
            .with_hint(
                "Pass a request id: ace request show REQUEST. See them with ace request list.",
            )
            .with_command("request.show");
        return fail(out, err, Some(&parsed.flags), &failure);
    }
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let mode = mode(parsed);
    let colour = {
        let env = Env::from_process();
        let terminal = Terminal {
            stdin: false,
            stdout: std::io::stdout().is_terminal(),
            stderr: false,
        };
        use_color(&parsed.flags, &env, terminal, Stream::Stdout)
    };
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    match run_inner(&mut conn, parsed.words[0], timeout, mode, colour, out) {
        Ok(outcome) => outcome,
        Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
    }
}

fn handover<W: Write, E: Write>(
    os_args: &[std::ffi::OsString],
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::new());
    match handover::locate(&exe) {
        Ok(launch) => {
            let failure = handover::hand_over(&launch, os_args);
            fail(out, err, Some(&parsed.flags), &failure)
        }
        Err(error) => fail(out, err, Some(&parsed.flags), &error.failure()),
    }
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn run_inner<W: Write>(
    conn: &mut cli_wire::Connection,
    given: &str,
    timeout: std::time::Duration,
    mode: OutputMode,
    colour: bool,
    out: &mut Out<W>,
) -> Result<Outcome, Failure<'static>> {
    let list = read_request_list(conn, timeout)?;
    let known: Vec<String> = list
        .get("requests")
        .and_then(serde_json::Value::as_array)
        .map_or(Vec::new(), |requests| {
            requests
                .iter()
                .filter_map(|r| {
                    r.get("interaction")
                        .and_then(|i| i.get("id"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        });
    let id = resolve_request_ref(given, &known).map_err(|(error, argument, hint)| {
        if error.contains("could be") {
            Failure::usage(error)
                .with_code(ErrorCode::Ambiguous)
                .with_argument(argument)
                .with_hint(hint)
                .with_command("request.show")
        } else if error.contains("must be") {
            Failure::usage(error)
                .with_code(ErrorCode::BadArgument)
                .with_argument(argument)
                .with_hint(hint)
                .with_command("request.show")
        } else {
            Failure::new(Outcome::Refused, error)
                .with_code(ErrorCode::NotFound)
                .with_argument(argument)
                .with_hint(hint)
                .with_command("request.show")
        }
    })?;
    let found = list
        .get("requests")
        .and_then(serde_json::Value::as_array)
        .and_then(|requests| {
            requests.iter().find(|r| {
                r.get("interaction")
                    .and_then(|i| i.get("id"))
                    .and_then(serde_json::Value::as_str)
                    == Some(id.as_str())
            })
        })
        .cloned()
        .ok_or_else(|| {
            Failure::new(Outcome::Refused, format!("No request starting with {id}."))
                .with_code(ErrorCode::NotFound)
                .with_argument("REQUEST")
                .with_hint("See them with ace request list.")
                .with_command("request.show")
        })?;
    write_found(out, &found, &id, mode, colour)?;
    Ok(Outcome::Ok)
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn write_found<W: Write>(
    out: &mut Out<W>,
    found: &serde_json::Value,
    id: &str,
    mode: OutputMode,
    colour: bool,
) -> Result<(), Failure<'static>> {
    match mode {
        OutputMode::Json => {
            let raw = serde_json::to_string(found)
                .map_err(|error| write_failed(error, "request.show"))?;
            write_line(out, &raw, "request.show")?;
            Ok(())
        }
        OutputMode::Human => {
            for line in &request_show_lines(found, colour) {
                write_line(out, line, "request.show")?;
            }
            Ok(())
        }
        OutputMode::Quiet => {
            write_line(out, id, "request.show")?;
            Ok(())
        }
    }
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn write_line<W: Write>(
    out: &mut Out<W>,
    line: &str,
    command: &'static str,
) -> Result<(), Failure<'static>> {
    out.line(line).map_err(|error| write_failed(error, command))
}

fn write_failed(error: impl std::fmt::Display, command: &'static str) -> Failure<'static> {
    Failure::new(
        Outcome::Failed,
        format!("ace couldn't write its output: {error}"),
    )
    .with_code(ErrorCode::Internal)
    .with_command(command)
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn read_request_list(
    conn: &mut cli_wire::Connection,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, Failure<'static>> {
    let request = ListRequest {
        msg_type: "cli.request",
        operation: ListOperation {
            op: "request.list",
            limit: 200,
        },
    };
    let reply = conn
        .cli_request_with_timeout(&request, timeout)
        .map_err(|err| wire_failure(&err, Some("request.show")))?;
    let envelope: CliResultEnvelope<'_> = reply
        .decode()
        .map_err(|err| wire_failure(&err, Some("request.show")))?;
    let result: CliResult<'_> =
        serde_json::from_str(envelope.result.get()).map_err(|_| list_unavailable())?;
    if !result.ok {
        return Err(list_unavailable());
    }
    let data_raw = result.data.ok_or_else(list_unavailable)?;
    serde_json::from_str(data_raw.get()).map_err(|_| list_unavailable())
}

fn list_unavailable() -> Failure<'static> {
    Failure::new(Outcome::Uncertain, "ace couldn't read the open requests.")
        .with_code(ErrorCode::Uncertain)
        .with_hint("Try again; if it keeps failing, run ace doctor.")
        .with_command("request.show")
}
