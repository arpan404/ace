// SPDX-License-Identifier: Apache-2.0
//! `daemon status` and `daemon.token`: the local daemon's health over HTTP, and this machine's
//! host token from its file. `daemon.start` and `daemon.serve` run the daemon, so they keep
//! handing over; `daemon.stop` proves the shutdown swept the run's processes, which lives deep
//! in the daemon's process evidence, so it keeps handing over too.
#![allow(
    clippy::result_large_err,
    reason = "the failure envelope is returned by value to its one printer; boxing would only add an allocation"
)]

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome};
use cli_parse::Parsed;
use cli_wire::{
    DEFAULT_HTTP_TIMEOUT, Home, HostFilesError, HttpMethod, http_request_local, is_hex64,
};

use super::error;
use super::render::{self, Health};

/// The daemon's health from its `/v1/status`, or not running when none runs for this home.
///
/// A stopped daemon is not a failure: it prints `{running: false}` and exits 0, as
/// `daemonHealth` does. Corrupt files fail the way it fails them instead: an endpoint that is
/// no URL at all is the runtime's own failure, malformed files are a usage error.
pub(crate) fn status<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "daemon.status";
    let response = match run_status() {
        Ok(response) => response,
        Err(StatusError::Down) => return emit_down(parsed, out, err, ID),
        Err(StatusError::Failed(failure)) => {
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    let health: Health<'_> = match response.decode() {
        Ok(health) => health,
        Err(_) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &error::wire_failure(
                    &cli_wire::WireError::Protocol {
                        detail: "Daemon returned an unexpected status".into(),
                    },
                    ID,
                ),
            );
        }
    };
    if health.running && health.version.is_none() {
        let failure = Failure::usage(
            "An argument isn't in the form ace expects: the daemon's status has no version.",
        )
        .with_hint("See ace help daemon status.")
        .with_command(ID);
        return crate::run::fail(out, err, Some(&parsed.flags), &failure);
    }
    super::emit(
        out,
        err,
        &parsed.flags,
        &render::health_lines(&health),
        response.raw(),
        &[],
    )
}

/// A stopped daemon, or a failed status read.
/// A stopped daemon or a failed status read.
enum StatusError {
    Down,
    Failed(Failure<'static>),
}

/// Prints a stopped daemon the way the health check does: `{running: false}`, exit 0.
fn emit_down<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    id: &'static str,
) -> Outcome {
    let raw = serde_json::value::RawValue::from_string(r#"{"running":false}"#.to_owned());
    let Ok(raw) = raw else {
        return crate::run::fail(
            out,
            err,
            Some(&parsed.flags),
            &error::internal("the daemon's status couldn't be printed").with_command(id),
        );
    };
    let health = Health {
        running: false,
        version: None,
        ready: None,
    };
    super::emit(
        out,
        err,
        &parsed.flags,
        &render::health_lines(&health),
        &raw,
        &[],
    )
}

/// The local daemon's `/v1/status`: a missing daemon reads as stopped, a refused connection
/// reads as uncertain, and anything else fails the way the health check fails it.
fn run_status() -> Result<cli_wire::HttpResponse, StatusError> {
    const ID: &str = "daemon.status";
    let failed = |error: HostFilesError| {
        StatusError::Failed(match error {
            HostFilesError::Unreadable(std::io::ErrorKind::NotFound) => {
                return StatusError::Down;
            }
            // The bundle names the OS error here; this port approximates its words.
            HostFilesError::Unreadable(kind) => {
                error::internal(&format!("the daemon files couldn't be read: {kind}"))
                    .with_command(ID)
            }
            HostFilesError::InvalidUrl => error::internal("Invalid URL").with_command(ID),
            HostFilesError::InvalidEndpoint => Failure::usage(
                "An argument isn't in the form ace expects: Invalid input.",
            )
            .with_hint("See ace help daemon status.")
            .with_command(ID),
            HostFilesError::InvalidToken => Failure::usage(
                "An argument isn't in the form ace expects: Invalid string: must match pattern /^[0-9a-f]{64}$/.",
            )
            .with_hint("See ace help daemon status.")
            .with_command(ID),
        })
    };
    let home =
        Home::from_env().map_err(|error| StatusError::Failed(error::wire_failure(&error, ID)))?;
    let local = cli_wire::read_host_files(&home).map_err(failed)?;
    http_request_local(
        &local,
        HttpMethod::Get,
        "/v1/status",
        None,
        DEFAULT_HTTP_TIMEOUT,
    )
    .map_err(|error| {
        // A refused connection is uncertain work state, as the health check's own catch has
        // it; only a missing file reads as a stopped daemon.
        if matches!(error, cli_wire::WireError::DaemonDown) {
            StatusError::Failed(error::wire_failure(
                &cli_wire::WireError::Offline {
                    detail: "Access transport unavailable".into(),
                },
                ID,
            ))
        } else {
            StatusError::Failed(error::wire_failure(&error, ID))
        }
    })
}

/// This machine's host token: the file the daemon wrote when it first started.
pub(crate) fn token<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "daemon.token";
    let home = match Home::from_env() {
        Ok(home) => home,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &error::wire_failure(&error, ID),
            );
        }
    };
    let raw = std::fs::read_to_string(home.token_path()).unwrap_or_default();
    let token = raw.trim();
    if !is_hex64(token) {
        let failure = Failure::new(Outcome::Refused, "This machine has no host token yet.")
            .with_code(ErrorCode::NotFound)
            .with_hint("ace makes one when the daemon first starts: ace start.")
            .with_command(ID);
        return crate::run::fail(out, err, Some(&parsed.flags), &failure);
    }
    let result = match cli_out::output_mode(&parsed.flags) {
        cli_out::OutputMode::Json => out.json(&TokenValue { token }),
        cli_out::OutputMode::Human | cli_out::OutputMode::Quiet => out.line(token),
    };
    crate::run::finish(result, out, err)
}

#[derive(serde::Serialize)]
struct TokenValue<'a> {
    token: &'a str,
}
