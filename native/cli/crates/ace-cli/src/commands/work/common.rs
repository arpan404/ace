// SPDX-License-Identifier: Apache-2.0
//! Shared I/O shell for ported work reads: home, daemon connection, timeouts and failures.

use std::io::Write;
use std::time::Duration;

use cli_out::{ErrorCode, Failure, Flags, Out, Outcome, OutputMode, output_mode};
use cli_parse::Parsed;
use cli_wire::{
    CliErrorCode, CliOutcome, ConnectConfig, Connection, Home, LocalIdentity, TcpProbe, WireError,
};

/// Default request deadline when `--timeout` is absent (TS `timeoutMs` default).
const DEFAULT_TIMEOUT_MS: u64 = 240_000;
/// Longest `--timeout` the CLI accepts (24h, matching TS).
const MAX_TIMEOUT_MS: u64 = 86_400_000;

/// Parses `--timeout` exactly as TS `timeoutMs` does.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub fn timeout_duration(flags: &Flags<'_>) -> Result<Duration, Failure<'static>> {
    let Some(value) = flags.value("timeout") else {
        return Ok(Duration::from_millis(DEFAULT_TIMEOUT_MS));
    };
    let bytes = value.as_bytes();
    let mut digits = 0;
    while digits < bytes.len() && bytes[digits].is_ascii_digit() {
        digits += 1;
    }
    let suffix = &value[digits..];
    let valid = digits > 0 && matches!(suffix, "" | "ms" | "s" | "m" | "h");
    if !valid {
        return Err(
            Failure::usage("--timeout takes a duration, like 30s or 10m.")
                .with_code(ErrorCode::BadArgument)
                .with_argument("--timeout"),
        );
    }
    let number: u64 = value[..digits].parse().unwrap_or(u64::MAX);
    let scale: u64 = match suffix {
        "h" => 3_600_000,
        "m" => 60_000,
        "s" => 1_000,
        _ => 1,
    };
    let result = number.saturating_mul(scale);
    if result == 0 || result > MAX_TIMEOUT_MS {
        return Err(Failure::usage("--timeout can be at most 24h.")
            .with_code(ErrorCode::BadArgument)
            .with_argument("--timeout"));
    }
    Ok(Duration::from_millis(result))
}

/// Opens the local daemon connection. Callers hand `--remote` to the bundle before reaching here.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub fn connect(_flags: &Flags<'_>, timeout: Duration) -> Result<Connection, Failure<'static>> {
    let home = Home::from_env().map_err(|err| wire_failure(&err, None))?;
    let local = cli_wire::reach_local(&home, &TcpProbe).map_err(|err| wire_failure(&err, None))?;
    let config = ConnectConfig {
        handshake_timeout: std::cmp::min(timeout, Duration::from_secs(15)),
        request_timeout: timeout,
        ..ConnectConfig::default()
    };
    Connection::open_local(&local, LocalIdentity::from_env(), &config)
        .map_err(|err| wire_failure(&err, None))
}

/// Maps a wire error to the CLI failure envelope, matching TS `toCliError`.
pub fn wire_failure(err: &WireError, command: Option<&'static str>) -> Failure<'static> {
    let mapping = err.failure();
    let outcome = match mapping.outcome {
        CliOutcome::Ok => Outcome::Ok,
        CliOutcome::Failed => Outcome::Failed,
        CliOutcome::NeedsHuman => Outcome::NeedsHuman,
        CliOutcome::Timeout => Outcome::Timeout,
        CliOutcome::Refused => Outcome::Refused,
        CliOutcome::Uncertain => Outcome::Uncertain,
        CliOutcome::AddressInUse => Outcome::AddressInUse,
        CliOutcome::LockHeld => Outcome::LockHeld,
        CliOutcome::Usage => Outcome::Usage,
        CliOutcome::NewerData => Outcome::NewerData,
        CliOutcome::IncompatibleData => Outcome::IncompatibleData,
    };
    let code = match mapping.code {
        CliErrorCode::DaemonDown => ErrorCode::DaemonDown,
        CliErrorCode::Refused => ErrorCode::Refused,
        CliErrorCode::Timeout => ErrorCode::Timeout,
        CliErrorCode::Uncertain => ErrorCode::Uncertain,
        CliErrorCode::BadArgument => ErrorCode::BadArgument,
        CliErrorCode::NeedsHuman => ErrorCode::NeedsHuman,
        CliErrorCode::Failed => ErrorCode::Failed,
        CliErrorCode::Internal => ErrorCode::Internal,
    };
    let mut failure = Failure::new(outcome, err.to_string()).with_code(code);
    if let Some(hint) = mapping.hint {
        failure = failure.with_hint(hint);
    }
    if let Some(command) = command {
        failure = failure.with_command(command);
    }
    failure
}

/// The output mode for a run, matching `outputMode` in TS.
pub fn mode(parsed: &Parsed<'_>) -> OutputMode {
    output_mode(&parsed.flags)
}

/// Writes a daemon-shaped `--json` value untouched, or human/quiet lines.
pub fn emit_json_or<W: Write>(
    out: &mut Out<W>,
    mode: OutputMode,
    raw: &serde_json::value::RawValue,
    human: &[String],
    quiet: &[String],
) -> Result<(), cli_out::WriteError> {
    match mode {
        OutputMode::Json => {
            out.write(raw.get())?;
            out.write("\n")
        }
        OutputMode::Human => {
            for line in human {
                out.line(line)?;
            }
            Ok(())
        }
        OutputMode::Quiet => {
            for line in quiet {
                out.line(line)?;
            }
            Ok(())
        }
    }
}

/// Parses `--limit N` within `1..=max`, or the default, with TS's exact sentence.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub fn limit_flag(flags: &Flags<'_>, fallback: u64, max: u64) -> Result<u64, Failure<'static>> {
    let Some(value) = flags.value("limit") else {
        return Ok(fallback);
    };
    let valid = !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    let number: u64 = if valid { value.parse().unwrap_or(0) } else { 0 };
    if number < 1 || number > max {
        return Err(
            Failure::usage(format!("--limit takes a number from 1 to {max}."))
                .with_code(ErrorCode::BadArgument)
                .with_argument("--limit"),
        );
    }
    Ok(number)
}
