// SPDX-License-Identifier: Apache-2.0
//! The offline commands (ADR 0092): help, version, completion and the management home. Each
//! touches only the static table; the daemon never runs for them.

use std::io::Write;
use std::path::Path;

use cli_out::{Failure, Out, Outcome, OutputMode, output_mode};
use cli_parse::Parsed;

use crate::run::{emit_text, fail, finish, write_failed};
use crate::{completion, help, help_json, version};

pub(crate) fn run_help<W: Write, E: Write>(
    words: &[&str],
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let answer = match help::help_for(words) {
        Ok(answer) => answer,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    if output_mode(&parsed.flags) == OutputMode::Json {
        if let Some(command) = answer.command {
            return finish(out.json(&help_json::command_json(command)), out, err);
        }
        if words.is_empty() {
            let version = version::current();
            return finish(out.json(&help_json::tree(&version)), out, err);
        }
        return finish(
            out.json(&help_json::TextValue { help: &answer.text }),
            out,
            err,
        );
    }
    finish(
        emit_text(out, output_mode(&parsed.flags), &answer.text),
        out,
        err,
    )
}

pub(crate) fn run_version<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let value = version::current();
    let result = match output_mode(&parsed.flags) {
        OutputMode::Json => out.json(&VersionValue { version: &value }),
        OutputMode::Human | OutputMode::Quiet => out.line(&value),
    };
    finish(result, out, err)
}

#[derive(serde::Serialize)]
struct VersionValue<'a> {
    version: &'a str,
}

/// The management home off a terminal (a person at one gets the bundle's interactive home).
pub(crate) fn home<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    if output_mode(&parsed.flags) == OutputMode::Json {
        let version = version::current();
        return finish(out.json(&help_json::tree(&version)), out, err);
    }
    finish(
        emit_text(out, output_mode(&parsed.flags), &help::overview()),
        out,
        err,
    )
}

pub(crate) fn run_completion<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let word = parsed.words.first().copied().unwrap_or("");
    if word == "install" {
        return completion_install(parsed, out, err);
    }
    let shells: Vec<&str> = completion::SHELLS
        .iter()
        .map(|shell| shell.as_str())
        .collect();
    let Some(shell) = completion::CompletionShell::parse(word) else {
        let failure = Failure::usage(format!(
            "ace completion takes {} or install, not {word}.",
            shells.join(", ")
        ))
        .with_argument("SHELL")
        .with_command(parsed.command.id);
        return fail(out, err, Some(&parsed.flags), &failure);
    };
    finish(out.write(completion::script(shell)), out, err)
}

fn completion_install<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let shell_name = std::env::var("SHELL").ok();
    let Some(shell) = completion::current_shell(shell_name.as_deref(), cfg!(windows)) else {
        let shells: Vec<&str> = completion::SHELLS
            .iter()
            .map(|shell| shell.as_str())
            .collect();
        let failure = Failure::usage("ace can't tell which shell you use.")
            .with_hint(format!(
                "Print a script with ace completion {} and add it yourself.",
                shells.join("|")
            ))
            .with_command(parsed.command.id);
        return fail(out, err, Some(&parsed.flags), &failure);
    };
    // The OS's home lookup, as Node's `os.homedir()` uses: HOME, else the account's own.
    let Some(home) = std::env::home_dir() else {
        let failure = Failure::new(Outcome::Failed, "ace can't find your home folder.")
            .with_code(cli_out::ErrorCode::Internal)
            .with_hint("Set HOME (or USERPROFILE on Windows) and try again.");
        return fail(out, err, Some(&parsed.flags), &failure);
    };
    let plan = completion::install_plan(
        shell,
        &home.to_string_lossy(),
        std::env::var("XDG_DATA_HOME").ok().as_deref(),
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        std::env::var("ZDOTDIR").ok().as_deref(),
    );
    if let Some(directory) = Path::new(&plan.path).parent()
        && let Err(error) = std::fs::create_dir_all(directory)
    {
        return write_failed(&error.into(), out, err);
    }
    if let Err(error) = std::fs::write(&plan.path, completion::script(shell)) {
        return write_failed(&error.into(), out, err);
    }
    let result = match output_mode(&parsed.flags) {
        OutputMode::Json => out.json(&InstallValue {
            shell: shell.as_str(),
            path: &plan.path,
        }),
        OutputMode::Quiet => out.line(&plan.path),
        OutputMode::Human => {
            let mut text = format!("Installed {} completion in {}.", shell.as_str(), plan.path);
            text.push('\n');
            text.push_str(
                plan.next
                    .as_deref()
                    .unwrap_or("Open a new shell to use it."),
            );
            out.line(&text)
        }
    };
    finish(result, out, err)
}

#[derive(serde::Serialize)]
struct InstallValue<'a> {
    shell: &'a str,
    path: &'a str,
}

/// Prints the candidates a completion slot already computed (the daemon's live ones hand over
/// before any writer exists).
pub(crate) fn complete<W: Write, E: Write>(
    slot: &completion::Slot,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    finish(
        out.write(&completion::candidate_lines(&slot.candidates)),
        out,
        err,
    )
}
