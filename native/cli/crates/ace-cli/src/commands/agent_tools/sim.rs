// SPDX-License-Identifier: Apache-2.0
//! `ace sim`: one sim_* tool call for the thread's agent. Ports
//! `apps/daemon/src/cli/sim.ts` exactly: short words by default, the tool's own JSON with
//! `--json`, identifiers with `--quiet`, and the JPEG written byte-identically.

use std::io::Write;
use std::time::Duration;

use cli_out::{Env, ErrorCode, Failure, Flags, Out, Outcome, OutputMode, output_mode};
use cli_parse::Parsed;
use serde::Deserialize;

use super::sim_args::{SimCall, SimVerb, sim_call};
use super::sim_out::{failed, screenshot, success};
use crate::run::fail;

/// Default request deadline when `--timeout` is absent (TS `timeoutMs` default).
const DEFAULT_TIMEOUT_MS: u64 = 240_000;
/// Longest `--timeout` the CLI accepts (24h, matching TS).
const MAX_TIMEOUT_MS: u64 = 86_400_000;

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    result: &'a serde_json::value::RawValue,
}

#[derive(Deserialize)]
struct CliResult<'a> {
    ok: bool,
    #[serde(borrow, default)]
    code: Option<&'a str>,
    #[serde(borrow, default)]
    hint: Option<&'a str>,
    #[serde(borrow, default)]
    data: Option<&'a serde_json::value::RawValue>,
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn timeout_duration(
    flags: &Flags<'_>,
    command: &'static str,
) -> Result<Duration, Failure<'static>> {
    let Some(value) = flags.value("timeout") else {
        return Ok(Duration::from_millis(DEFAULT_TIMEOUT_MS));
    };
    let digits: usize = value.bytes().take_while(u8::is_ascii_digit).count();
    let suffix = &value[digits..];
    let valid = digits > 0 && matches!(suffix, "" | "ms" | "s" | "m" | "h") && !value.is_empty();
    if !valid {
        return Err(
            Failure::usage("--timeout takes a duration, like 30s or 10m.")
                .with_code(ErrorCode::BadArgument)
                .with_argument("--timeout")
                .with_command(command),
        );
    }
    let count: u64 = value[..digits].parse().unwrap_or(u64::MAX);
    let scale: u64 = match suffix {
        "h" => 3_600_000,
        "m" => 60_000,
        "s" => 1_000,
        _ => 1,
    };
    let result = count.saturating_mul(scale);
    if result == 0 || result > MAX_TIMEOUT_MS {
        return Err(Failure::usage("--timeout can be at most 24h.")
            .with_code(ErrorCode::BadArgument)
            .with_argument("--timeout")
            .with_command(command));
    }
    Ok(Duration::from_millis(result))
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn connect(
    timeout: Duration,
    command: &'static str,
) -> Result<cli_wire::Connection, Failure<'static>> {
    let home = cli_wire::Home::from_env().map_err(|err| wire_failure(&err, command))?;
    let local = cli_wire::reach_local(&home, &cli_wire::TcpProbe)
        .map_err(|err| wire_failure(&err, command))?;
    let config = cli_wire::ConnectConfig {
        handshake_timeout: std::cmp::min(timeout, Duration::from_secs(15)),
        request_timeout: timeout,
        ..cli_wire::ConnectConfig::default()
    };
    cli_wire::Connection::open_local(&local, cli_wire::LocalIdentity::from_env(), &config)
        .map_err(|err| wire_failure(&err, command))
}

fn wire_failure(err: &cli_wire::WireError, command: &'static str) -> Failure<'static> {
    let mapping = err.failure();
    let outcome = match mapping.outcome {
        cli_wire::CliOutcome::Ok => Outcome::Ok,
        cli_wire::CliOutcome::Failed => Outcome::Failed,
        cli_wire::CliOutcome::NeedsHuman => Outcome::NeedsHuman,
        cli_wire::CliOutcome::Timeout => Outcome::Timeout,
        cli_wire::CliOutcome::Refused => Outcome::Refused,
        cli_wire::CliOutcome::Uncertain => Outcome::Uncertain,
        cli_wire::CliOutcome::AddressInUse => Outcome::AddressInUse,
        cli_wire::CliOutcome::LockHeld => Outcome::LockHeld,
        cli_wire::CliOutcome::Usage => Outcome::Usage,
        cli_wire::CliOutcome::NewerData => Outcome::NewerData,
        cli_wire::CliOutcome::IncompatibleData => Outcome::IncompatibleData,
    };
    let code = match mapping.code {
        cli_wire::CliErrorCode::DaemonDown => ErrorCode::DaemonDown,
        cli_wire::CliErrorCode::Refused => ErrorCode::Refused,
        cli_wire::CliErrorCode::Timeout => ErrorCode::Timeout,
        cli_wire::CliErrorCode::Uncertain => ErrorCode::Uncertain,
        cli_wire::CliErrorCode::BadArgument => ErrorCode::BadArgument,
        cli_wire::CliErrorCode::NeedsHuman => ErrorCode::NeedsHuman,
        cli_wire::CliErrorCode::Failed => ErrorCode::Failed,
        cli_wire::CliErrorCode::Internal => ErrorCode::Internal,
    };
    let mut failure = Failure::new(outcome, err.to_string()).with_code(code);
    if let Some(hint) = mapping.hint {
        failure = failure.with_hint(hint);
    }
    failure.with_command(command)
}

/// A person holding the device is something to wait out, not a failure of the call.
pub(super) fn outcome(code: &str) -> Outcome {
    match code {
        "lease_required" => Outcome::NeedsHuman,
        "timeout" => Outcome::Timeout,
        "invalid_arguments" => Outcome::Refused,
        _ => Outcome::Failed,
    }
}

fn own_thread(flags: &Flags<'_>) -> Option<String> {
    if let Some(named) = flags.value("thread") {
        return Some(named.to_owned());
    }
    let own = Env::from_process().thread_id.unwrap_or_default();
    let trimmed = own.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

#[derive(serde::Serialize)]
struct SimOperation<'a> {
    op: &'static str,
    #[serde(rename = "threadId")]
    thread_id: &'a str,
    verb: &'static str,
    args: &'a serde_json::Value,
}

#[derive(serde::Serialize)]
struct SimRequest<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    operation: SimOperation<'a>,
}

pub fn run<W: Write, E: Write>(parsed: &Parsed<'_>, out: &mut Out<W>, err: &mut Out<E>) -> Outcome {
    let command = parsed.command.id;
    let timeout = match timeout_duration(&parsed.flags, command) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let mode = output_mode(&parsed.flags);
    // The session opens before the thread is read, as the TypeScript `withSession` does: with
    // no daemon and no thread, the answer is that ace isn't running, not the missing thread.
    let mut conn = match connect(timeout, command) {
        Ok(conn) => conn,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let Some(thread) = own_thread(&parsed.flags) else {
        return fail(
            out,
            err,
            Some(&parsed.flags),
            &Failure::usage("ace sim needs your thread: pass --thread THREAD.")
                .with_code(ErrorCode::MissingArgument)
                .with_argument("--thread")
                .with_hint("In an agent's shell ace sets ACE_THREAD_ID; see ace help sim act.")
                .with_command(parsed.command.id),
        );
    };
    let call = match sim_call(parsed.command.id, &parsed.words, &parsed.flags) {
        Ok(call) => call,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    match run_inner(
        &mut conn,
        &thread,
        &call,
        timeout,
        mode,
        &parsed.flags,
        command,
        out,
        err,
    ) {
        Ok(outcome) => outcome,
        Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
    }
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
#[allow(
    clippy::too_many_arguments,
    reason = "one call path: connection, thread, args, mode and both writers"
)]
fn run_inner<W: Write, E: Write>(
    conn: &mut cli_wire::Connection,
    thread: &str,
    call: &SimCall,
    timeout: Duration,
    mode: OutputMode,
    flags: &Flags<'_>,
    command: &'static str,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Result<Outcome, Failure<'static>> {
    let request = SimRequest {
        msg_type: "cli.request",
        operation: SimOperation {
            op: "sim",
            thread_id: thread,
            verb: call.verb.as_str(),
            args: &call.args,
        },
    };
    let reply = conn
        .cli_request_with_timeout(&request, timeout)
        .map_err(|err| wire_failure(&err, command))?;
    let envelope: Envelope<'_> = reply.decode().map_err(|err| wire_failure(&err, command))?;
    let result: CliResult<'_> =
        serde_json::from_str(envelope.result.get()).map_err(|_| unavailable(command))?;
    if !result.ok {
        return failed(
            result.code,
            result.hint,
            result.data,
            mode,
            command,
            out,
            err,
        );
    }
    let Some(data_raw) = result.data else {
        return Err(unavailable(command));
    };
    if call.verb == SimVerb::Screenshot {
        return screenshot(data_raw, mode, flags, command, out);
    }
    success(data_raw, call.verb, mode, command, out)
}

pub(super) fn unavailable(command: &'static str) -> Failure<'static> {
    Failure::new(Outcome::Uncertain, "ace couldn't reach the simulator.")
        .with_code(ErrorCode::Uncertain)
        .with_hint("Try again; if it keeps failing, run ace doctor.")
        .with_command(command)
}
