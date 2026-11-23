// SPDX-License-Identifier: Apache-2.0
//! One run of `ace` (ADR 0178): read the line against the static table, run the command it
//! names here, or hand it to the bundle. Pure decisions; all I/O is passed in, and a hand-over
//! creates no writer at all.

use std::ffi::OsString;
use std::io::{IsTerminal as _, Write};
use std::path::PathBuf;

use cli_out::{
    Env, Failure, FlagValue, Flags, Out, Outcome, OutputMode, Stream, Terminal, WriteError,
    can_prompt, human_error, output_mode, use_color,
};
use cli_parse::{NounOnly, ParseResult, Parsed, Usage, parse};

use crate::offline::{complete, home, run_completion, run_help, run_version};
use crate::{completion, handover, help, help_json};

/// The commands this binary answers itself. Every other id hands over; each of these must exist
/// in the table, which `check:cli` proves.
const NATIVE_IDS: &[&str] = &[
    "home",
    "help",
    "version",
    "completion",
    "complete",
    "project.list",
    "request.list",
    "request.show",
];

/// The spade-market commands this binary answers itself (ADR 0221 step 4).
const SPADE_MARKET_IDS: &[&str] = crate::commands::spade_market::IDS;

/// Runs one command line, returning the outcome whose exit code ends the process.
///
/// The writers are made only when a command answers here: a hand-over never allocates them.
pub fn run<W, E, FO, FE>(argv: &[&str], os_args: &[OsString], make_out: FO, make_err: FE) -> Outcome
where
    W: Write,
    E: Write,
    FO: FnOnce() -> Out<W>,
    FE: FnOnce() -> Out<E>,
{
    match parse(argv) {
        ParseResult::Usage(usage) => {
            let Usage {
                code,
                message,
                hint,
                argument,
                flags,
                ..
            } = usage;
            let mut failure = Failure::usage(message).with_code(code);
            if let Some(hint) = hint {
                failure = failure.with_hint(hint);
            }
            if let Some(argument) = argument {
                failure = failure.with_argument(argument);
            }
            // A line that didn't parse answers in JSON when --json was anywhere on it, even
            // after `--`; a command's own failures do not (TypeScript reassigns its flags once
            // it knows the command).
            let mut flags = flags;
            if argv.contains(&"--json") {
                flags.set("json", FlagValue::Switch);
            }
            with_writers(make_out, make_err, |out, err| {
                fail(out, err, Some(&flags), &failure)
            })
        }
        ParseResult::Noun(noun) => with_writers(make_out, make_err, |out, err| {
            noun_page(&noun, out, err, argv)
        }),
        ParseResult::Command(parsed) => command(&parsed, os_args, make_out, make_err),
    }
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

/// The terminal this run sees. The only I/O in a decision.
pub(crate) fn terminal() -> Terminal {
    Terminal {
        stdin: std::io::stdin().is_terminal(),
        stdout: std::io::stdout().is_terminal(),
        stderr: std::io::stderr().is_terminal(),
    }
}

/// Prints a failure where the flags asked for it and returns its outcome.
pub(crate) fn fail<W: Write, E: Write>(
    out: &mut Out<W>,
    err: &mut Out<E>,
    flags: Option<&Flags<'_>>,
    failure: &Failure<'static>,
) -> Outcome {
    let empty = Flags::new();
    let flags = flags.unwrap_or(&empty);
    if output_mode(flags) == OutputMode::Json {
        let _ = out.json(failure);
        return failure.outcome;
    }
    let env = Env::from_process();
    let terminal = terminal();
    let paint = use_color(
        flags,
        &env,
        Terminal {
            stdin: false,
            stdout: false,
            stderr: terminal.stderr,
        },
        Stream::Stderr,
    );
    let _ = err.write(&human_error(failure, paint.then_some("\u{1b}[31m")));
    failure.outcome
}

pub(crate) fn write_failed<W: Write, E: Write>(
    error: &WriteError,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let failure = Failure::new(
        Outcome::Failed,
        format!("ace couldn't write its output: {error}"),
    )
    .with_code(cli_out::ErrorCode::Internal);
    fail(out, err, None, &failure)
}

/// Emits one text answer in the mode asked for.
pub(crate) fn emit_text<W: Write>(
    out: &mut Out<W>,
    mode: OutputMode,
    text: &str,
) -> Result<(), WriteError> {
    match mode {
        OutputMode::Human => out.line(text),
        OutputMode::Json => out.json(&text),
        OutputMode::Quiet => Ok(()),
    }
}

fn noun_page<W: Write, E: Write>(
    noun: &NounOnly<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    argv: &[&str],
) -> Outcome {
    // The noun branch reads its flags from before the words only; a `--json` after them still
    // makes the answer JSON, which is why the page prints as a JSON string here (as it does in
    // TypeScript).
    let mode = if argv.contains(&"--json") {
        OutputMode::Json
    } else {
        output_mode(&noun.flags)
    };
    let page = help::noun_page(&noun.words);
    let result = if noun.flags.on("help") || output_mode(&noun.flags) != OutputMode::Json {
        emit_text(out, mode, &page)
    } else {
        out.json(&help_json::TextValue { help: &page })
    };
    finish(result, out, err)
}

pub(crate) fn finish<W: Write, E: Write>(
    result: Result<(), WriteError>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    match result {
        Ok(()) => Outcome::Ok,
        Err(error) => write_failed(&error, out, err),
    }
}

fn command<W, E, FO, FE>(
    parsed: &Parsed<'_>,
    os_args: &[OsString],
    make_out: FO,
    make_err: FE,
) -> Outcome
where
    W: Write,
    E: Write,
    FO: FnOnce() -> Out<W>,
    FE: FnOnce() -> Out<E>,
{
    // A jq filter is compiled and run by jq itself; the bundle owns that today.
    if parsed.flags.has("jq") {
        return hand_over(os_args, &parsed.flags, make_out, make_err);
    }
    let help_words = early_help(parsed);
    // `--schema` prints a Zod schema, which lives in the bundle (ADR 0178 §5).
    if parsed.flags.on("schema") && (help_words.is_some() || parsed.command.id == "help") {
        return hand_over(os_args, &parsed.flags, make_out, make_err);
    }
    // `--help` and `--version` answer before anything runs, whatever command they follow.
    if let Some(words) = help_words {
        return with_writers(make_out, make_err, |out, err| {
            run_help(&words, parsed, out, err)
        });
    }
    if early_version(parsed) {
        return with_writers(make_out, make_err, |out, err| run_version(parsed, out, err));
    }
    // An old spelling's notice or refusal belongs to the command it reaches; unported, it is
    // the bundle's to print, once.
    if parsed.alias.is_some() {
        return hand_over(os_args, &parsed.flags, make_out, make_err);
    }
    // Whoever runs it, the bundle decides what an unported command's missing arguments mean (a
    // person-only action refuses before it ever asks for one). A ported spade-market id is
    // refused first when the person owns it, exactly as the TypeScript dispatcher does.
    if SPADE_MARKET_IDS.contains(&parsed.command.id)
        && let Some(refusal) = crate::commands::spade_market::person_gate(parsed)
    {
        return with_writers(make_out, make_err, |out, err| {
            fail(out, err, Some(&parsed.flags), &refusal)
        });
    }
    if !NATIVE_IDS.contains(&parsed.command.id) && !SPADE_MARKET_IDS.contains(&parsed.command.id) {
        return hand_over(os_args, &parsed.flags, make_out, make_err);
    }
    if !parsed.missing.is_empty() {
        let env = Env::from_process();
        // A person at a terminal is asked for it, and the asking is the bundle's.
        if can_prompt(&parsed.flags, &env, terminal()) {
            return hand_over(os_args, &parsed.flags, make_out, make_err);
        }
        return with_writers(make_out, make_err, |out, err| {
            missing_argument(parsed, out, err)
        });
    }
    match parsed.command.id {
        "home" => {
            let env = Env::from_process();
            // The interactive home is the bundle's (ADR 0221 §1); off a terminal this is the
            // overview.
            if can_prompt(&parsed.flags, &env, terminal()) {
                return hand_over(os_args, &parsed.flags, make_out, make_err);
            }
            with_writers(make_out, make_err, |out, err| home(parsed, out, err))
        }
        "help" => {
            let words = parsed.words.clone();
            with_writers(make_out, make_err, |out, err| {
                run_help(&words, parsed, out, err)
            })
        }
        "version" => with_writers(make_out, make_err, |out, err| run_version(parsed, out, err)),
        "completion" => with_writers(make_out, make_err, |out, err| {
            run_completion(parsed, out, err)
        }),
        "complete" => {
            let slot = completion::slot(&parsed.words);
            // A live reference is the daemon's to name; the connection lands in ADR 0221 step 3.
            if slot.reference.is_some() {
                return hand_over(os_args, &parsed.flags, make_out, make_err);
            }
            with_writers(make_out, make_err, |out, err| complete(&slot, out, err))
        }
        _ if crate::commands::work::IDS.contains(&parsed.command.id) => {
            with_writers(make_out, make_err, |out, err| {
                crate::commands::work::dispatch(parsed, os_args, out, err)
            })
        }
        _ if SPADE_MARKET_IDS.contains(&parsed.command.id) => {
            with_writers(make_out, make_err, |out, err| {
                crate::commands::spade_market::dispatch(parsed, os_args, out, err)
            })
        }
        _ => hand_over(os_args, &parsed.flags, make_out, make_err),
    }
}

/// The words an early `--help` answers for (ADR 0178 §5): a noun's page, or the command's own.
fn early_help<'a>(parsed: &Parsed<'a>) -> Option<Vec<&'a str>> {
    if !parsed.flags.on("help") || parsed.command.id == "help" {
        return None;
    }
    if parsed.typed.len() < parsed.command.words.len() && parsed.alias.is_none() {
        Some(parsed.typed.clone())
    } else {
        Some(parsed.command.words.to_vec())
    }
}

fn early_version(parsed: &Parsed<'_>) -> bool {
    (parsed.flags.on("version") || parsed.flags.on("V")) && parsed.command.id == "home"
}

fn missing_argument<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let missing: Vec<&str> = parsed.missing.iter().map(|arg| arg.name).collect();
    let names = missing.join(" and ");
    let usage = format!("ace {}", parsed.command.words.join(" "));
    let first = parsed.missing.first();
    let mut failure = Failure::usage(format!("{usage} needs {names}."))
        .with_code(cli_out::ErrorCode::MissingArgument)
        .with_hint(format!(
            "{}: {usage} {}.",
            first.map_or("Pass it", |arg| arg.summary),
            missing.join(" ")
        ))
        .with_command(parsed.command.id);
    if let Some(arg) = first {
        failure = failure.with_argument(arg.name);
    }
    fail(out, err, Some(&parsed.flags), &failure)
}

fn hand_over<W, E, FO, FE>(
    os_args: &[OsString],
    flags: &Flags<'_>,
    make_out: FO,
    make_err: FE,
) -> Outcome
where
    W: Write,
    E: Write,
    FO: FnOnce() -> Out<W>,
    FE: FnOnce() -> Out<E>,
{
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::new());
    let launch = match handover::locate(&exe) {
        Ok(launch) => launch,
        Err(error) => {
            let failure = error.failure();
            return with_writers(make_out, make_err, |out, err| {
                fail(out, err, Some(flags), &failure)
            });
        }
    };
    let failure = handover::hand_over(&launch, os_args);
    with_writers(make_out, make_err, |out, err| {
        fail(out, err, Some(flags), &failure)
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_native_command_is_in_the_table() {
        for id in super::NATIVE_IDS
            .iter()
            .chain(super::SPADE_MARKET_IDS.iter())
        {
            assert!(
                cli_table::by_id(id).is_some(),
                "{id} is dispatched natively but is no longer in the CLI table"
            );
        }
    }
}
