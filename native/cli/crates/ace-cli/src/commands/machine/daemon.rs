// SPDX-License-Identifier: Apache-2.0
//! `daemon status` and `daemon.token`: the local daemon's health over HTTP, and this machine's
//! host token from its file. `daemon.start` and `daemon.serve` run the daemon, so they keep
//! handing over; `daemon.stop` proves the shutdown swept the run's processes, which lives deep
//! in the daemon's process evidence, so it keeps handing over too.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome};
use cli_parse::Parsed;
use cli_wire::{DEFAULT_HTTP_TIMEOUT, Home, HttpMethod, TcpProbe, http_request_local, is_hex64};

use super::error;
use super::render::{self, Health};

/// The daemon's health from its `/v1/status`, or not running when none runs for this home.
pub(crate) fn status<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "daemon.status";
    let response = match run_status() {
        Ok(response) => response,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &error::wire_failure(&error, ID),
            );
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

/// The local daemon's `/v1/status`, or `daemon_down` when nothing listens for this home.
fn run_status() -> Result<cli_wire::HttpResponse, cli_wire::WireError> {
    let home = Home::from_env()?;
    let local = cli_wire::reach_local(&home, &TcpProbe)?;
    http_request_local(
        &local,
        HttpMethod::Get,
        "/v1/status",
        None,
        DEFAULT_HTTP_TIMEOUT,
    )
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
