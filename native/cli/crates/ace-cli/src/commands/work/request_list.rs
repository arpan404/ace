// SPDX-License-Identifier: Apache-2.0
//! `ace request list`: every open approval, question and plan, across threads.

use std::collections::BTreeMap;
use std::io::{IsTerminal as _, Write};

use cli_out::{Env, ErrorCode, Failure, Out, Outcome, OutputMode, Stream, Terminal, use_color};
use cli_parse::Parsed;
use serde::Deserialize;

use super::common::{connect, emit_json_or, mode, timeout_duration, wire_failure};
use super::lists::request_list_lines;
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
    code: Option<&'a str>,
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

#[derive(Deserialize)]
struct ProjectsEnvelope<'a> {
    #[serde(borrow)]
    result: &'a serde_json::value::RawValue,
}

pub fn run<W: Write, E: Write>(parsed: &Parsed<'_>, out: &mut Out<W>, err: &mut Out<E>) -> Outcome {
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
    match run_inner(&mut conn, timeout, mode, colour, out) {
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
    timeout: std::time::Duration,
    mode: OutputMode,
    colour: bool,
    out: &mut Out<W>,
) -> Result<Outcome, Failure<'static>> {
    let request = ListRequest {
        msg_type: "cli.request",
        operation: ListOperation {
            op: "request.list",
            limit: 200,
        },
    };
    let reply = conn
        .cli_request_with_timeout(&request, timeout)
        .map_err(|err| wire_failure(&err, Some("request.list")))?;
    let envelope: CliResultEnvelope<'_> = reply
        .decode()
        .map_err(|err| wire_failure(&err, Some("request.list")))?;
    let result: CliResult<'_> =
        serde_json::from_str(envelope.result.get()).map_err(|_| refused_list_unavailable())?;
    if !result.ok {
        if result.code == Some("not_found") {
            return Err(
                Failure::new(Outcome::Refused, "No thread  on this machine.")
                    .with_code(ErrorCode::NotFound)
                    .with_hint("See your threads with ace thread list.")
                    .with_command("request.list"),
            );
        }
        return Err(refused_list_unavailable());
    }
    let data_raw = result.data.ok_or_else(refused_list_unavailable)?;
    let data_value: serde_json::Value =
        serde_json::from_str(data_raw.get()).map_err(|_| refused_list_unavailable())?;
    if mode == OutputMode::Json {
        emit_json_or(out, mode, data_raw, &[], &[])
            .map_err(|error| write_failed(&error, "request.list"))?;
        return Ok(Outcome::Ok);
    }
    let names = project_names(conn, timeout);
    let now = current_millis();
    let human = request_list_lines(&data_value, now, colour, &names);
    let quiet: Vec<String> = data_value
        .get("requests")
        .and_then(serde_json::Value::as_array)
        .map_or(Vec::new(), |list| {
            list.iter()
                .filter_map(|r| {
                    r.get("interaction")
                        .and_then(|i| i.get("id"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        });
    emit_json_or(out, mode, data_raw, &human, &quiet)
        .map_err(|error| write_failed(&error, "request.list"))?;
    Ok(Outcome::Ok)
}

fn refused_list_unavailable() -> Failure<'static> {
    Failure::new(Outcome::Uncertain, "ace couldn't read the open requests.")
        .with_code(ErrorCode::Uncertain)
        .with_hint("Try again; if it keeps failing, run ace doctor.")
        .with_command("request.list")
}

fn write_failed(error: &cli_out::WriteError, command: &'static str) -> Failure<'static> {
    Failure::new(
        Outcome::Failed,
        format!("ace couldn't write its output: {error}"),
    )
    .with_code(ErrorCode::Internal)
    .with_command(command)
}

fn current_millis() -> i64 {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    i64::try_from(millis).unwrap_or(0)
}

fn project_names(
    conn: &mut cli_wire::Connection,
    timeout: std::time::Duration,
) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    let mut after: Option<String> = None;
    for _ in 0..5 {
        let Some(page) = project_page(conn, timeout, after.as_deref()) else {
            break;
        };
        for (id, name) in page.names {
            names.insert(id, name);
        }
        if let Some(next) = page.next {
            after = Some(next);
        } else {
            break;
        }
    }
    names
}

struct ProjectPage {
    names: Vec<(String, String)>,
    next: Option<String>,
}

fn project_page(
    conn: &mut cli_wire::Connection,
    timeout: std::time::Duration,
    after: Option<&str>,
) -> Option<ProjectPage> {
    #[derive(serde::Serialize)]
    struct Operation<'a> {
        op: &'static str,
        limit: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        after: Option<&'a str>,
    }
    #[derive(serde::Serialize)]
    struct ProjectsRequest<'a> {
        #[serde(rename = "type")]
        msg_type: &'static str,
        operation: Operation<'a>,
    }
    let request = ProjectsRequest {
        msg_type: "projects.request",
        operation: Operation {
            op: "workspace.list",
            limit: 100,
            after,
        },
    };
    let reply = conn.request_with_timeout(&request, timeout).ok()?;
    let envelope: ProjectsEnvelope<'_> = reply.decode().ok()?;
    let value: serde_json::Value = serde_json::from_str(envelope.result.get()).ok()?;
    if value.get("kind").and_then(serde_json::Value::as_str) != Some("projects") {
        return None;
    }
    let empty = Vec::new();
    let projects = value
        .get("projects")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    let names = projects
        .iter()
        .filter_map(|project| {
            let id = project.get("id").and_then(serde_json::Value::as_str)?;
            let name = project.get("name").and_then(serde_json::Value::as_str)?;
            Some((id.to_owned(), name.to_owned()))
        })
        .collect();
    let next = value
        .get("next")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Some(ProjectPage { names, next })
}
