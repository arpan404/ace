// SPDX-License-Identifier: Apache-2.0
//! The `agent-tools` command group (ADR 0221 step 4): simulators agents drive from a shell.
//!
//! `ace sim …` runs here: one `cli.request` with the `sim` operation, the same validation and
//! words the TypeScript CLI prints, and the JPEG written byte-identically. `--json` passes the
//! daemon's value through untouched; `--remote` hands over, as the work group does.
//!
//! The rest of the group stays on the bundle: `browser screenshot|record` streams frames,
//! subscribes to the thread's store and downloads a private artifact through the TypeScript
//! client's lease machinery, which the blocking Rust connection does not speak; `cloud codex
//! …` spawns the person's own `codex` CLI, prompts for the exec text, keeps idempotency
//! receipts in `cli-cloud.sqlite` and forwards the child's stderr, all of which the TypeScript
//! runner owns. Handing over prints the bundle's exact output instead of approximating it.

mod sim;
mod sim_act;
mod sim_args;
mod sim_human;
mod sim_out;

use std::io::Write;

use cli_out::{Out, Outcome};
use cli_parse::Parsed;

/// The agent-tools commands this binary answers itself. Every other id hands over; each of
/// these must exist in the table, which `check:cli` proves.
pub const IDS: &[&str] = &[
    "sim.list",
    "sim.start",
    "sim.stop",
    "sim.ui",
    "sim.act",
    "sim.screenshot",
    "sim.logs",
];

/// Runs one ported agent-tools command. The bundle owns `--jq` (its filter to compile and
/// run) and `--remote` (its profile store to read), so those hand over before any writer
/// exists; `browser` and `cloud` are not in [`IDS`] and never reach here.
pub fn dispatch<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    debug_assert!(IDS.contains(&parsed.command.id));
    if parsed.flags.has("remote") {
        return handover(parsed, os_args, out, err);
    }
    match parsed.command.id {
        "sim.list" | "sim.start" | "sim.stop" | "sim.ui" | "sim.act" | "sim.screenshot"
        | "sim.logs" => sim::run(parsed, out, err),
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
            crate::run::fail(out, err, Some(&parsed.flags), &failure)
        }
        Err(error) => crate::run::fail(out, err, Some(&parsed.flags), &error.failure()),
    }
}

#[cfg(test)]
mod tests {
    use super::IDS;

    #[test]
    fn every_agent_tools_command_is_in_the_table() {
        for id in IDS {
            assert!(
                cli_table::by_id(id).is_some(),
                "{id} is dispatched natively but is no longer in the CLI table"
            );
        }
    }
}
