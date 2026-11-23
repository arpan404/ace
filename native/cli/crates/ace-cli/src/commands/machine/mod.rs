// SPDX-License-Identifier: Apache-2.0
//! The `machine` command group (ADR 0221 step 4): the daemon, storage and settings on this
//! machine. `daemon.start`, `daemon.serve`, `doctor`, `doctor.bundle` and `triage` keep handing
//! over (the first two run the daemon; the rescue path owns the last three), as do
//! `daemon.stop`, every `service` command and every `config` command (see `daemon.rs` and
//! `storage.rs` for why each stays).

mod apply;
mod clean;
mod daemon;
mod error;
mod log_format;
mod logs;
mod plan;
mod render;
mod request;
mod storage;

use std::io::Write;

use cli_out::{
    Env, Failure, Flags, Out, Outcome, OutputMode, Stream, can_prompt, output_mode, use_color,
};
use cli_parse::Parsed;

use crate::run::{fail, finish, terminal};

/// The machine commands this binary answers itself. Every other id hands over; each of these
/// must exist in the table, which `check:cli` proves.
pub const IDS: &[&str] = &[
    "daemon.logs",
    "daemon.status",
    "daemon.token",
    "storage.apply",
    "storage.clean",
    "storage.compact",
    "storage.plan",
    "storage.status",
    "storage.usage",
];

/// Runs one machine command. The bundle owns `--jq` (its filter to compile and run) and
/// `--remote` (its profile store to read), so those hand over before any writer exists.
pub fn dispatch<W, E, FO, FE>(parsed: &Parsed<'_>, make_out: FO, make_err: FE) -> Outcome
where
    W: Write,
    E: Write,
    FO: FnOnce() -> Out<W>,
    FE: FnOnce() -> Out<E>,
{
    debug_assert!(IDS.contains(&parsed.command.id));
    debug_assert!(!defers_prompt(parsed));
    with_writers(make_out, make_err, |out, err| {
        if let Some(outcome) = check_alias(parsed, out, err) {
            return outcome;
        }
        match parsed.command.id {
            "daemon.logs" => logs::run(parsed, out, err),
            "daemon.status" => daemon::status(parsed, out, err),
            "daemon.token" => daemon::token(parsed, out, err),
            "storage.usage" => storage::usage(parsed, out, err),
            "storage.plan" => storage::plan(parsed, out, err),
            "storage.clean" => clean::clean(parsed, out, err),
            "storage.apply" => apply::apply(parsed, out, err),
            "storage.status" => apply::receipt_status(parsed, out, err),
            "storage.compact" => storage::compact(parsed, out, err),
            _ => {
                let failure = error::internal("an unreachable machine command ran");
                fail(out, err, Some(&parsed.flags), &failure)
            }
        }
    })
}

/// Whether the bundle must run this instead: `storage clean` asks the person on a terminal,
/// and its prompt belongs to the bundle. Every other shape answers here, including the
/// refusals, which need no answer.
pub fn defers_prompt(parsed: &Parsed<'_>) -> bool {
    parsed.command.id == "storage.clean"
        && !parsed.flags.on("dry-run")
        && !parsed.flags.on("yes")
        && can_prompt(&parsed.flags, &Env::from_process(), terminal())
}

/// Makes the run's writers, runs one answer, and flushes them once at the end.
fn with_writers<W, E, FO, FE>(
    make_out: FO,
    make_err: FE,
    answer: impl FnOnce(&mut Out<W>, &mut Out<E>) -> Outcome,
) -> Outcome
where
    W: Write,
    E: Write,
    FO: FnOnce() -> Out<W>,
    FE: FnOnce() -> Out<E>,
{
    let mut out = make_out();
    let mut err = make_err();
    let outcome = answer(&mut out, &mut err);
    let _ = out.flush();
    let _ = err.flush();
    outcome
}

/// An old spelling's notice or refusal (ADR 0178 decision 6): `None` runs the command, `Some`
/// already answered it. Only for a person at a terminal does a notice print; anywhere else the
/// old spelling just runs.
fn check_alias<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Option<Outcome> {
    let since = parsed.alias?.deprecated_since?;
    let words = parsed.command.words.join(" ");
    let typed = parsed.typed.join(" ");
    match alias_phase(since, &crate::version::current()) {
        Phase::Notice => {
            if output_mode(&parsed.flags) == OutputMode::Human && terminal().stderr {
                let _ = err.line(&format!("ace {typed} is now ace {words}."));
            }
            None
        }
        Phase::Error => {
            let failure = Failure::usage(format!("ace {typed} is now ace {words}."))
                .with_code(cli_out::ErrorCode::RetiredCommand)
                .with_hint(format!("Run ace {words} instead."))
                .with_command(parsed.command.id);
            Some(fail(out, err, Some(&parsed.flags), &failure))
        }
        Phase::Removed => {
            let failure = Failure::usage(format!("ace has no command {typed}."))
                .with_code(cli_out::ErrorCode::UnknownCommand)
                .with_hint(format!("Did you mean ace {words}?"))
                .with_command(parsed.command.id);
            Some(fail(out, err, Some(&parsed.flags), &failure))
        }
    }
}

/// Where an old spelling is in its retirement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// A notice in the release the new spelling ships in and the two after it.
    Notice,
    /// A usage error naming the new command in the third release after.
    Error,
    /// Gone: an usage error naming what was typed.
    Removed,
}

/// The phase of an old spelling deprecated since `since`, running on `version`.
fn alias_phase(since: &str, version: &str) -> Phase {
    match releases_since(since, version) {
        None => Phase::Notice,
        Some(count) if count <= 2 => Phase::Notice,
        Some(3) => Phase::Error,
        Some(_) => Phase::Removed,
    }
}

/// Releases from `since` to `version`, or `None` when either isn't a release number. While ace
/// is `0.0.N`, every release counts as a minor release.
fn releases_since(since: &str, version: &str) -> Option<i64> {
    let from = release(since)?;
    let to = release(version)?;
    if to[0] != from[0] {
        return Some(if to[0] > from[0] { i64::MAX } else { -1 });
    }
    // 0.0.N counts patches; anything later counts minors.
    if from[0] == 0 && from[1] == 0 && to[1] == 0 {
        Some(to[2] - from[2])
    } else {
        Some(to[1] - from[1])
    }
}

/// The `X.Y.Z` at the start of a release number, ignoring any `-prerelease` suffix.
fn release(value: &str) -> Option<[i64; 3]> {
    let mut parts = value.split('.');
    let major: i64 = parts.next()?.parse().ok()?;
    let minor: i64 = parts.next()?.parse().ok()?;
    let patch: String = parts
        .next()?
        .bytes()
        .take_while(u8::is_ascii_digit)
        .map(char::from)
        .collect();
    if patch.is_empty() {
        return None;
    }
    Some([major, minor, patch.parse().ok()?])
}

/// Whether colour may mark state on stdout (ADR 0178 §3).
pub(crate) fn stdout_color(flags: &Flags<'_>) -> bool {
    let stderr_terminal = terminal();
    use_color(
        flags,
        &Env::from_process(),
        cli_out::Terminal {
            stdin: false,
            stdout: stderr_terminal.stdout,
            stderr: false,
        },
        Stream::Stdout,
    )
}

/// Human lines, the `--json` value, or quiet identifiers, in the mode asked for.
pub(crate) fn emit<W: Write, E: Write>(
    out: &mut Out<W>,
    err: &mut Out<E>,
    flags: &Flags<'_>,
    human: &[String],
    json: &serde_json::value::RawValue,
    quiet: &[String],
) -> Outcome {
    match output_mode(flags) {
        OutputMode::Json => finish(write_raw(out, json), out, err),
        OutputMode::Human => {
            let mut text = human.join("\n");
            if !human.is_empty() {
                text.push('\n');
            }
            finish(out.write(&text), out, err)
        }
        OutputMode::Quiet => {
            let mut text = quiet.join("\n");
            if !quiet.is_empty() {
                text.push('\n');
            }
            finish(out.write(&text), out, err)
        }
    }
}

/// Writes already-shaped daemon JSON untouched: no decode and re-encode.
fn write_raw<W: Write>(
    out: &mut Out<W>,
    raw: &serde_json::value::RawValue,
) -> Result<(), cli_out::WriteError> {
    out.write(raw.get())?;
    out.write("\n")
}

#[cfg(test)]
mod tests {
    use super::{IDS, Phase, alias_phase, release, releases_since};

    #[test]
    fn every_machine_command_is_in_the_table() {
        for id in IDS {
            assert!(
                cli_table::by_id(id).is_some(),
                "{id} is dispatched natively but is no longer in the CLI table"
            );
        }
    }

    #[test]
    fn an_old_spelling_warns_for_three_releases_then_refuses_then_is_gone() {
        assert_eq!(alias_phase("0.0.24", "development"), Phase::Notice);
        assert_eq!(alias_phase("0.0.24", "0.0.24"), Phase::Notice);
        assert_eq!(alias_phase("0.0.24", "0.0.26"), Phase::Notice);
        assert_eq!(alias_phase("0.0.24", "0.0.27"), Phase::Error);
        assert_eq!(alias_phase("0.0.24", "0.0.28"), Phase::Removed);
        assert_eq!(alias_phase("0.0.24", "0.0.23"), Phase::Notice);
    }

    #[test]
    fn releases_count_patches_while_minor_and_major_are_zero() {
        assert_eq!(releases_since("0.0.24", "1.0.0"), Some(i64::MAX));
        assert_eq!(releases_since("0.0.24", "0.1.0"), Some(1));
        assert_eq!(release("0.0.25-beta.3"), Some([0, 0, 25]));
        assert_eq!(release("development"), None);
    }
}
