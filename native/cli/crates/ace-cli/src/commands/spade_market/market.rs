// SPDX-License-Identifier: Apache-2.0
//! `ace store …`: reads and simple mutations through the daemon's `marketplace.request`.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome, OutputMode};
use cli_parse::Parsed;
use cli_wire::Connection;

use super::common;
use super::market_failure::market_failure;
use super::market_ops::{market_operation, operation_verb};
use super::market_print::render_answer;
use crate::commands::work::common::{connect, mode, timeout_duration, wire_failure};
use crate::run::fail;
pub fn run<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    if parsed.flags.has("remote") {
        return handover(parsed, os_args, out, err);
    }
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
    // Usage errors come before any connection.
    let operation = match market_operation(parsed) {
        Ok(operation) => operation,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    // No thread to ask in: an agent's shell runs only the agents' allowlist.
    let thread = common::own_thread(parsed);
    if thread.is_none() && common::agent_shell() {
        let (op, action) = operation_verb(&operation);
        if !common::agent_may_run(&op, action.as_deref()) {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &common::market_refusal(parsed.command.id),
            );
        }
    }
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
    let answer = match ask_market(
        &mut conn,
        &operation,
        thread.as_deref(),
        timeout,
        parsed.command.id,
    ) {
        Ok(answer) => answer,
        Err(failure) => {
            // Signed out, on a terminal: the bundle offers a sign-in, then runs it once more.
            if failure.code == ErrorCode::SignedOut && interactive_human(parsed) {
                return handover(parsed, os_args, out, err);
            }
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    render_answer(&answer, parsed.command.id, output, out, err)
}
fn interactive_human(parsed: &Parsed<'_>) -> bool {
    if mode(parsed) != OutputMode::Human {
        return false;
    }
    let env = cli_out::Env::from_process();
    cli_out::can_prompt(&parsed.flags, &env, crate::run::terminal())
}

/// One daemon connection for a command's market requests.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn ask_market(
    conn: &mut Connection,
    operation: &serde_json::Value,
    thread: Option<&str>,
    timeout: std::time::Duration,
    command: &'static str,
) -> Result<serde_json::Value, Failure<'static>> {
    let mut frame = serde_json::Map::new();
    frame.insert(
        "type".to_owned(),
        serde_json::Value::String("marketplace.request".to_owned()),
    );
    frame.insert("operation".to_owned(), operation.clone());
    if let Some(thread) = thread {
        frame.insert(
            "thread".to_owned(),
            serde_json::Value::String(thread.to_owned()),
        );
    }
    let reply = conn
        .request_with_timeout(&serde_json::Value::Object(frame), timeout)
        .map_err(|err| wire_failure(&err, Some(command)))?;
    let envelope: MarketEnvelope<'_> = reply
        .decode()
        .map_err(|err| wire_failure(&err, Some(command)))?;
    let result: serde_json::Value = serde_json::from_str(envelope.result.get()).map_err(|_| {
        wire_failure(
            &cli_wire::WireError::Protocol {
                detail: "Malformed marketplace result".into(),
            },
            Some(command),
        )
    })?;
    if result.get("op").and_then(serde_json::Value::as_str) == Some("error") {
        return Err(market_failure(&result, command));
    }
    Ok(result)
}

#[derive(serde::Deserialize)]
struct MarketEnvelope<'a> {
    #[serde(borrow)]
    result: &'a serde_json::value::RawValue,
}
fn handover<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::new());
    match crate::handover::locate(&exe) {
        Ok(launch) => {
            let failure = crate::handover::hand_over(&launch, os_args);
            crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            )
        }
        Err(error) => {
            let failure = error.failure();
            crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            )
        }
    }
}
