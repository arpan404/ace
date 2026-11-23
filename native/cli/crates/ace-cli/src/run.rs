// SPDX-License-Identifier: Apache-2.0
//! One run of `ace` (ADR 0178): read the line against the static table, run the command it
//! names here, or hand it to the bundle. Pure decisions; all I/O is passed in.

use std::io::{IsTerminal as _, Write};
use std::path::Path;

use cli_out::{
    Env, Failure, Flags, Out, Outcome, OutputMode, Stream, Terminal, WriteError, can_prompt,
    human_error, output_mode, use_color,
};
use cli_parse::{NounOnly, ParseResult, Parsed, Usage, parse};

use crate::offline::{home, run_complete, run_completion, run_help, run_version};
use crate::{handover, help, help_json};

/// Runs one command line, returning the outcome whose exit code ends the process.
pub fn run<W: Write, E: Write>(
    exe: &Path,
    argv: &[&str],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    match parse(argv) {
        ParseResult::Usage(usage) => {
            let failure = failure_from(usage);
            fail(out, err, None, argv, &failure)
        }
        ParseResult::Noun(noun) => noun_page(&noun, out, err, argv),
        ParseResult::Command(parsed) => command(exe, &parsed, out, err, argv),
    }
}

fn failure_from(usage: Usage<'_>) -> Failure<'static> {
    let mut failure = Failure::usage(usage.message).with_code(usage.code);
    if let Some(hint) = usage.hint {
        failure = failure.with_hint(hint);
    }
    if let Some(argument) = usage.argument {
        failure = failure.with_argument(argument);
    }
    failure
}

pub(crate) fn terminal() -> Terminal {
    Terminal {
        stdin: std::io::stdin().is_terminal(),
        stdout: std::io::stdout().is_terminal(),
        stderr: std::io::stderr().is_terminal(),
    }
}

/// Prints a failure where `--json` asked for it and returns its outcome.
pub(crate) fn fail<W: Write, E: Write>(
    out: &mut Out<W>,
    err: &mut Out<E>,
    flags: Option<&Flags<'_>>,
    argv: &[&str],
    failure: &Failure<'static>,
) -> Outcome {
    let empty = Flags::new();
    let flags = flags.unwrap_or(&empty);
    let mode = if argv.contains(&"--json") {
        OutputMode::Json
    } else {
        output_mode(flags)
    };
    if mode == OutputMode::Json {
        let _ = out.json(&failure);
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
    fail(out, err, None, &[], &failure)
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

fn command<W: Write, E: Write>(
    exe: &Path,
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    argv: &[&str],
) -> Outcome {
    // A jq filter is compiled and run by jq itself; the bundle owns that today.
    if parsed.flags.has("jq") {
        return hand_over(&parsed.flags, out, err, argv);
    }
    // `--help` and `--version` answer before anything runs, whatever command they follow.
    if let Some(words) = early_help(parsed) {
        return run_help(exe, &words, parsed, out, err, argv);
    }
    if early_version(parsed) {
        return run_version(exe, parsed, out, err);
    }
    // An old spelling's notice or refusal belongs to the command it reaches; unported, it is
    // the bundle's to print, once.
    if parsed.alias.is_some() {
        return hand_over(&parsed.flags, out, err, argv);
    }
    if !parsed.missing.is_empty() {
        return missing_argument(parsed, out, err, argv);
    }
    match parsed.command.id {
        "home" => home(exe, parsed, out, err, argv),
        "help" => {
            let words = parsed.words.clone();
            run_help(exe, &words, parsed, out, err, argv)
        }
        "version" => run_version(exe, parsed, out, err),
        "completion" => run_completion(parsed, out, err, argv),
        "complete" => run_complete(parsed, out, err, argv),
        _ => hand_over(&parsed.flags, out, err, argv),
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
    argv: &[&str],
) -> Outcome {
    let env = Env::from_process();
    // A person at a terminal is asked; anywhere else the missing argument is an error.
    if can_prompt(&parsed.flags, &env, terminal()) {
        return hand_over(&parsed.flags, out, err, argv);
    }
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
    fail(out, err, Some(&parsed.flags), argv, &failure)
}

pub(crate) fn hand_over<W: Write, E: Write>(
    flags: &Flags<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    argv: &[&str],
) -> Outcome {
    let exe = std::env::current_exe().unwrap_or_default();
    let Some(launch) = handover::locate(&exe) else {
        let failure = handover::missing();
        return fail(out, err, Some(flags), argv, &failure);
    };
    let failure = handover::hand_over(&launch, argv);
    fail(out, err, Some(flags), argv, &failure)
}
