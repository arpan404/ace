// SPDX-License-Identifier: Apache-2.0
//! Reaching the daemon for the providers commands: the local or selected remote target,
//! wire failures as the CLI's envelope, and one answer in the mode asked for.

use std::io::Write;
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;

use cli_out::{ErrorCode, Failure, Flags, Out, Outcome, OutputMode, output_mode};
use cli_wire::{
    ConnectConfig, Connection, DirectRemote, Home, Local, LocalIdentity, TcpProbe, WireError,
    reach_local,
};

/// A fallible command step: the large [`Failure`] envelope travels boxed.
pub type CommandResult<T> = Result<T, Box<Failure<'static>>>;

/// The CLI's failure for a line that was wrong: exit 64, with the argument and next step.
pub fn usage(
    message: impl Into<String>,
    code: ErrorCode,
    command: &'static str,
) -> Failure<'static> {
    Failure::usage(message.into())
        .with_code(code)
        .with_command(command)
}

/// `--timeout`: how long one daemon request may take (the CLI's lifetime for it).
pub fn request_timeout(flags: &Flags<'_>, command: &'static str) -> CommandResult<Duration> {
    let Some(value) = flags.value("timeout") else {
        return Ok(Duration::from_mins(4));
    };
    let split = value
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(value.len());
    let (digits, suffix) = value.split_at(split);
    let number: u64 = digits.parse().unwrap_or(u64::MAX);
    let scale = match suffix {
        "" | "ms" => 1,
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        _ => {
            return Err(Box::new(
                usage(
                    "--timeout takes a duration, like 30s or 10m.",
                    ErrorCode::BadArgument,
                    command,
                )
                .with_argument("--timeout"),
            ));
        }
    };
    let Some(ms) = number.checked_mul(scale) else {
        return Err(Box::new(timeout_ceiling(command)));
    };
    if ms == 0 || ms > 86_400_000 {
        return Err(Box::new(timeout_ceiling(command)));
    }
    Ok(Duration::from_millis(ms))
}

fn timeout_ceiling(command: &'static str) -> Failure<'static> {
    usage(
        "--timeout can be at most 24h.",
        ErrorCode::BadArgument,
        command,
    )
    .with_argument("--timeout")
}

/// "ace isn't running.", exit 4 (the local daemon's endpoint, token or listener is missing).
fn daemon_down(command: &'static str) -> Failure<'static> {
    Failure::new(Outcome::Refused, "ace isn't running.")
        .with_code(ErrorCode::DaemonDown)
        .with_hint("Start it with ace start, or open the app.")
        .with_command(command)
}

/// A wire failure as the CLI prints it, with the command that ran.
pub fn wire_failure(error: &WireError, command: &'static str) -> Failure<'static> {
    if matches!(error, WireError::DaemonDown) {
        return daemon_down(command);
    }
    let mapping = error.failure();
    let outcome = match mapping.outcome {
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
        cli_wire::CliOutcome::Ok => Outcome::Ok,
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
    let mut failure = Failure::new(outcome, error.to_string()).with_code(code);
    if let Some(hint) = mapping.hint {
        failure = failure.with_hint(hint);
    }
    failure.with_command(command)
}

/// Opens one blocking connection to the local daemon, or to the selected remote when
/// `--remote` names one or `ace remote use` picked one (relay-only profiles refuse).
pub fn connect(flags: &Flags<'_>, command: &'static str) -> CommandResult<Connection> {
    let timeout = request_timeout(flags, command)?;
    let config = ConnectConfig {
        request_timeout: timeout,
        ..ConnectConfig::default()
    };
    let home = Home::from_env().map_err(|_| Box::new(daemon_down(command)))?;
    let store = super::store::open(home.path(), command)?;
    let selected = if flags.value("remote").is_some_and(|name| name == "local") {
        None
    } else {
        match flags.value("remote") {
            Some(name) => Some(store.get(name, command)?),
            None => match store.selected(command)? {
                Some(name) => Some(store.get(&name, command)?),
                None => None,
            },
        }
    };
    let Some(profile) = selected else {
        let local: Local =
            reach_local(&home, &TcpProbe).map_err(|error| wire_failure(&error, command))?;
        return Connection::open_local(&local, LocalIdentity::from_env(), &config)
            .map_err(|error| Box::new(wire_failure(&error, command)));
    };
    let direct: DirectRemote<'_> = profile
        .direct()
        .map_err(|error| wire_failure(&error, command))?;
    // A relay-only remote refuses before dispatch, as the TypeScript CLI does.
    Connection::open_remote(&direct, &config)
        .map_err(|error| Box::new(wire_failure(&error, command)))
}

/// One WebSocket request on an open connection.
pub fn ws_send<T: serde::Serialize>(
    conn: &mut Connection,
    command: &'static str,
    op: &T,
) -> CommandResult<WireReply> {
    let reply = conn
        .request(op)
        .map_err(|error| Box::new(wire_failure(&error, command)))?;
    receive(&reply, command)
}

/// One `cli.request` on an open connection.
pub fn cli_send<T: serde::Serialize>(
    conn: &mut Connection,
    command: &'static str,
    operation: &T,
) -> CommandResult<WireReply> {
    let reply = conn
        .cli_request(operation)
        .map_err(|error| Box::new(wire_failure(&error, command)))?;
    receive(&reply, command)
}

fn receive(reply: &cli_wire::Reply, command: &'static str) -> CommandResult<WireReply> {
    let text = reply.as_str().to_owned();
    let value: serde_json::Value = reply
        .decode()
        .map_err(|error| Box::new(wire_failure(&error, command)))?;
    Ok(WireReply { text, value })
}

/// One daemon reply: the parsed envelope for decisions and human output, and the raw
/// bytes `--json` writes untouched.
pub struct WireReply {
    /// The reply as received.
    pub text: String,
    /// The reply parsed.
    pub value: serde_json::Value,
}

impl std::ops::Deref for WireReply {
    type Target = serde_json::Value;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow, default)]
    result: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct DataEnvelope<'a> {
    #[serde(borrow, default)]
    data: Option<&'a RawValue>,
}

impl WireReply {
    /// The raw `result` field's bytes, when the envelope carries one.
    #[must_use]
    pub fn result_raw(&self) -> Option<&str> {
        serde_json::from_str::<Envelope<'_>>(&self.text)
            .ok()
            .and_then(|envelope| envelope.result.map(RawValue::get))
            .filter(|raw| !raw.is_empty())
    }

    /// The raw `result.data` field's bytes, for `cli.result` replies.
    #[must_use]
    pub fn data_raw(&self) -> Option<&str> {
        let result = self.result_raw()?;
        serde_json::from_str::<DataEnvelope<'_>>(result)
            .ok()
            .and_then(|parsed| parsed.data.map(RawValue::get))
            .filter(|raw| !raw.is_empty())
    }

    /// The raw bytes of `result`'s `field`, for values the CLI rebuilds.
    #[must_use]
    pub fn result_field_raw(&self, field: &str) -> Option<String> {
        let result = self.result_raw()?;
        let fields: std::collections::HashMap<String, Box<RawValue>> =
            serde_json::from_str(result).ok()?;
        fields.get(field).map(|raw| raw.get().to_owned())
    }
}
pub fn ws_once<T: serde::Serialize>(
    flags: &Flags<'_>,
    command: &'static str,
    op: &T,
) -> CommandResult<WireReply> {
    let mut conn = connect(flags, command)?;
    let reply = conn
        .request(op)
        .map_err(|error| Box::new(wire_failure(&error, command)))?;
    let shaped = receive(&reply, command);
    conn.close();
    shaped
}

/// One `cli.request` on a fresh connection: connect, send, decode, close.
pub fn cli_once<T: serde::Serialize>(
    flags: &Flags<'_>,
    command: &'static str,
    operation: &T,
) -> CommandResult<WireReply> {
    let mut conn = connect(flags, command)?;
    let reply = conn
        .cli_request(operation)
        .map_err(|error| Box::new(wire_failure(&error, command)))?;
    let shaped = receive(&reply, command);
    conn.close();
    shaped
}
/// The mode a ported command answers in.
pub fn mode_of(flags: &Flags<'_>) -> OutputMode {
    output_mode(flags)
}

pub fn answer<W: Write, E: Write>(
    out: &mut Out<W>,
    err: &mut Out<E>,
    flags: &Flags<'_>,
    json: &serde_json::Value,
    human: &[String],
    quiet: &[String],
) -> Outcome {
    answer_shaped(out, err, flags, json, None, human, quiet)
}

/// Prints one command's answer, with `--json` written exactly as the daemon shaped it when
/// the caller passes those bytes.
pub fn answer_shaped<W: Write, E: Write>(
    out: &mut Out<W>,
    err: &mut Out<E>,
    flags: &Flags<'_>,
    json: &serde_json::Value,
    shaped: Option<&str>,
    human: &[String],
    quiet: &[String],
) -> Outcome {
    let mode = mode_of(flags);
    let result = match mode {
        OutputMode::Json => match shaped {
            Some(raw) => out.line(raw),
            None => out.json(json),
        },
        OutputMode::Human => {
            if human.is_empty() {
                Ok(())
            } else {
                out.line(&human.join("\n"))
            }
        }
        OutputMode::Quiet => {
            if quiet.is_empty() {
                Ok(())
            } else {
                out.line(&quiet.join("\n"))
            }
        }
    };
    match result {
        Ok(()) => crate::run::finish(Ok(()), out, err),
        Err(error) => crate::run::write_failed(&error, out, err),
    }
}
