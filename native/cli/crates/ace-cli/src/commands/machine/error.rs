// SPDX-License-Identifier: Apache-2.0
//! Machine failures: the wire's typed errors as the CLI's failure envelope and exit codes.
#![allow(
    clippy::result_large_err,
    reason = "the failure envelope is returned by value to its one printer; boxing would only add an allocation"
)]

use std::time::Duration;

use cli_out::{ErrorCode, Failure, Outcome};
use cli_wire::WireError;

/// What a failed machine command prints and how it exits, with the command that failed.
pub(crate) fn wire_failure(error: &WireError, command: &'static str) -> Failure<'static> {
    let (outcome, code, hint): (Outcome, ErrorCode, Option<&str>) = match error {
        WireError::DaemonDown => (
            Outcome::Refused,
            ErrorCode::DaemonDown,
            Some(cli_wire::DAEMON_DOWN_HINT),
        ),
        WireError::Timeout { .. } => (Outcome::Timeout, ErrorCode::Timeout, None),
        WireError::Auth { .. } | WireError::RelayOnly { .. } | WireError::InvalidTarget { .. } => {
            (Outcome::Refused, ErrorCode::Refused, None)
        }
        WireError::MachineCode { .. }
        | WireError::Offline { .. }
        | WireError::Protocol { .. }
        | WireError::Limit { .. }
        | WireError::Identity { .. }
        | WireError::Daemon { .. } => (Outcome::Uncertain, ErrorCode::Uncertain, None),
    };
    let mut failure = Failure::new(outcome, sentence(&error.to_string()))
        .with_code(code)
        .with_command(command);
    if let Some(hint) = hint {
        failure = failure.with_hint(hint);
    }
    failure
}

/// The sentence a person reads: trimmed, ending in `.`, `!` or `?`.
fn sentence(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "it failed.".to_owned();
    }
    if trimmed.ends_with(['.', '!', '?']) {
        trimmed.to_owned()
    } else {
        format!("{trimmed}.")
    }
}

/// A command line that was wrong: exit 64, with the argument and the next step.
pub(crate) fn usage(
    message: impl Into<String>,
    argument: &'static str,
    command: &'static str,
) -> Failure<'static> {
    Failure::usage(message.into())
        .with_argument(argument)
        .with_command(command)
}

/// A failure the CLI caused itself, not the daemon or the command line.
pub(crate) fn internal(message: &str) -> Failure<'static> {
    Failure::new(
        Outcome::Failed,
        format!("Something went wrong in ace: {message}."),
    )
    .with_code(ErrorCode::Internal)
    .with_hint("Run ace triage to report it.")
}

/// `--timeout`: how long a daemon request may take, 240 s unless asked otherwise.
pub(crate) fn request_timeout(
    value: Option<&str>,
    command: &'static str,
) -> Result<Duration, Failure<'static>> {
    const DEFAULT_MS: u64 = 240_000;
    const MAX_MS: u128 = 86_400_000;
    let Some(text) = value else {
        return Ok(Duration::from_millis(DEFAULT_MS));
    };
    // `/^\d+(ms|s|m|h)?$/`: digits, then at most one known suffix.
    let suffix_len = if text.ends_with("ms") {
        2
    } else {
        usize::from(text.ends_with(['s', 'm', 'h']))
    };
    let (number, suffix) = text.split_at(text.len() - suffix_len);
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(usage(
            "--timeout takes a duration, like 30s or 10m.",
            "--timeout",
            command,
        ));
    }
    let scale: u128 = match suffix {
        "" | "ms" => 1,
        "s" => 1_000,
        "m" => 60_000,
        _ => 3_600_000,
    };
    let amount: u128 = number.parse().unwrap_or(u128::MAX);
    let millis = amount.saturating_mul(scale);
    if millis == 0 || millis > MAX_MS {
        return Err(usage("--timeout can be at most 24h.", "--timeout", command));
    }
    Ok(Duration::from_millis(
        u64::try_from(millis).unwrap_or(u64::MAX),
    ))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::request_timeout;

    #[test]
    fn timeout_reads_durations_and_refuses_what_is_not_one() {
        assert_eq!(
            request_timeout(None, "storage.plan").ok(),
            Some(Duration::from_mins(4))
        );
        assert_eq!(
            request_timeout(Some("20s"), "storage.plan").ok(),
            Some(Duration::from_secs(20))
        );
        assert_eq!(
            request_timeout(Some("10m"), "storage.plan").ok(),
            Some(Duration::from_mins(10))
        );
        assert!(request_timeout(Some("soon"), "storage.plan").is_err());
        assert!(request_timeout(Some("0"), "storage.plan").is_err());
    }
}
