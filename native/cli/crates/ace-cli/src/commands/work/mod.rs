// SPDX-License-Identifier: Apache-2.0
//! Headless work reads ported to Rust (ADR 0221 step 4): `project.list`, `request.list`,
//! `request.show`. Every other work id hands over; see the reasons in `FINAL` docs.
//!
//! Reads use only `cli.request` / `projects.request` (no client selections, no outbox), `--json`
//! passes the daemon's value through as `RawValue`, and human text matches the TypeScript
//! renderers exactly.

pub(crate) mod common;
mod lists;
mod project_list;
mod render;
mod request_list;
mod request_show;

use std::io::Write;

use cli_out::{Out, Outcome};
use cli_parse::Parsed;

use crate::handover;

/// The work ids this binary answers itself. Each exists in the table (`check:cli` proves it).
pub const IDS: &[&str] = &["project.list", "request.list", "request.show"];

/// Runs one ported work command. `os_args` is only for the request-show terminal handover.
pub fn dispatch<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    // Remote machines need pinned TLS + profile sqlite; the bundle owns them in this step.
    if parsed.flags.has("remote") {
        return handover_fallback(parsed, os_args, out, err);
    }
    match parsed.command.id {
        "project.list" => project_list::run(parsed, out, err),
        "request.list" => {
            // `--thread` needs thread-id resolution through the thread list (client selections);
            // keep it on the bundle rather than approximating.
            if parsed.flags.has("thread") {
                return handover_fallback(parsed, os_args, out, err);
            }
            request_list::run(parsed, out, err)
        }
        "request.show" => request_show::run(parsed, os_args, out, err),
        _ => crate::run::fail(
            out,
            err,
            Some(&parsed.flags),
            &cli_out::Failure::usage(format!("ace {} is not yet native.", parsed.command.id))
                .with_code(cli_out::ErrorCode::BadArgument)
                .with_command(parsed.command.id),
        ),
    }
}

pub(crate) fn handover_fallback<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::new());
    match handover::locate(&exe) {
        Ok(launch) => {
            let failure = handover::hand_over(&launch, os_args);
            crate::run::fail(out, err, Some(&parsed.flags), &failure)
        }
        Err(error) => {
            let failure = error.failure();
            crate::run::fail(out, err, Some(&parsed.flags), &failure)
        }
    }
}
