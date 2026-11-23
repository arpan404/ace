// SPDX-License-Identifier: Apache-2.0
//! The Store, Spade and bots, automations, features and org commands ported to Rust
//! (ADR 0221 step 4). Each family exposes one dispatch fn; `IDS` lists what runs here.
//!
//! Ported: the reads (`list/show/status/search/discover/installed/versions/signals`,
//! `feature list`, Spade and bot reads) and the simple daemon-routed mutations
//! (`automation run/remove`, `bot stop/pause/resume/unarchive`, the source commands,
//! `store remove/restore/report/withdraw`, draft reads and deletes, profile and verification
//! reads). `--json` the daemon already shaped passes through as `RawValue`; human text
//! matches the TypeScript renderers exactly.
//!
//! Handed over, with the bundle deciding: `bot init/check/test/dev/publish` and
//! `store publish` with the drafts, texts, reviews and confirmations they carry (the bot kit
//! runs JS packages locally); the publishing surface (`describe/changelog/latest/deprecate/`
//! `visibility/archive/unarchive/transfer/delete/appeal/profile/verif*`, `draft update`,
//! `install/update`, `check`); every `market.maintainer.*` tool; `org audit/registry` (their
//! crypto and programs are TypeScript-only); `spade skill import/export` (folders, git and
//! the skill checks); `spade move` (two machines with the person's say on both); `spade on/off`
//! and `feature on/off` (service control and setting saves); `automation create` (its
//! definition is validated by the daemon's schema).

mod automation;
mod bot;
pub(crate) mod common;
pub(crate) mod feature;
mod market;
mod market_ops;
mod market_render;
pub(crate) mod spade;

use std::io::Write;

use cli_out::{Failure, Out, Outcome};
use cli_parse::Parsed;

/// The spade-market ids this binary answers itself. Each exists in the table.
pub const IDS: &[&str] = &[
    "automation.list",
    "automation.show",
    "automation.run",
    "automation.remove",
    "feature.list",
    "spade.status",
    "spade.bot.list",
    "spade.bot.show",
    "bot.running",
    "bot.stop",
    "bot.pause",
    "bot.resume",
    "bot.unarchive",
    "market.discover",
    "market.search",
    "market.show",
    "market.installed",
    "market.source.list",
    "market.source.add",
    "market.source.remove",
    "market.source.on",
    "market.source.off",
    "market.source.refresh",
    "market.remove",
    "market.restore",
    "market.report",
    "market.withdraw",
    "market.status",
    "market.versions",
    "market.signals",
    "market.draft.list",
    "market.draft.show",
    "market.draft.delete",
    "market.profile.show",
    "market.verification.show",
    "market.verification.check",
];

/// The person-only refusal, if this line needs one before it may run.
///
/// This mirrors `main.ts`: a `personOnly` command, or a market action that is the person's
/// with no thread to ask in, is refused in an agent's shell before it ever reaches for a
/// daemon (exit 2, never the 4 of "ace isn't running").
#[must_use]
pub fn person_gate(parsed: &Parsed<'_>) -> Option<Failure<'static>> {
    let agent = common::agent_shell();
    if !agent {
        return None;
    }
    match parsed.command.id {
        "bot.resume" | "bot.unarchive" => Some(common::setting_refusal(parsed.command.id)),
        _ => {
            if common::market_person_only(parsed.command.id) && common::ace_thread_id().is_none() {
                Some(common::market_refusal(parsed.command.id))
            } else {
                None
            }
        }
    }
}

/// Runs one ported spade-market command. `os_args` is only for the terminal handover.
pub fn dispatch<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    // Remote machines need pinned TLS + profile sqlite; the bundle owns them in this step.
    if parsed.flags.has("remote") {
        return super::work::handover_fallback(parsed, os_args, out, err);
    }
    match parsed.command.id {
        "automation.list" => automation::run_list(parsed, out, err),
        "automation.show" => automation::run_show(parsed, out, err),
        "automation.run" => automation::run_run(parsed, out, err),
        "automation.remove" => automation::run_remove(parsed, out, err),
        "feature.list" => feature::run(parsed, out, err),
        "spade.status" => spade::run_status(parsed, out, err),
        "spade.bot.list" => spade::run_bot_list(parsed, out, err),
        "spade.bot.show" => spade::run_bot_show(parsed, out, err),
        "bot.running" => bot::run_running(parsed, out, err),
        "bot.stop" => bot::run_action(parsed, out, err, "stop", "bot.stop"),
        "bot.pause" => bot::run_action(parsed, out, err, "pause", "bot.pause"),
        "bot.resume" => bot::run_action(parsed, out, err, "resume", "bot.resume"),
        "bot.unarchive" => bot::run_action(parsed, out, err, "unarchive", "bot.unarchive"),
        "market.discover"
        | "market.search"
        | "market.show"
        | "market.installed"
        | "market.source.list"
        | "market.source.add"
        | "market.source.remove"
        | "market.source.on"
        | "market.source.off"
        | "market.source.refresh"
        | "market.remove"
        | "market.restore"
        | "market.report"
        | "market.withdraw"
        | "market.status"
        | "market.versions"
        | "market.signals"
        | "market.draft.list"
        | "market.draft.show"
        | "market.draft.delete"
        | "market.profile.show"
        | "market.verification.show"
        | "market.verification.check" => market::run(parsed, os_args, out, err),
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
