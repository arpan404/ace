// SPDX-License-Identifier: Apache-2.0
//! The offline commands (ADR 0092): help, version, completion and the management home. Each
//! touches only the static table; the daemon never runs for them.

use std::io::Write;
use std::path::Path;

use cli_out::{Env, Failure, Out, Outcome, OutputMode, can_prompt, output_mode};
use cli_parse::Parsed;

use crate::run::{emit_text, fail, finish, hand_over, terminal, write_failed};
use crate::{completion, help, help_json, version};

pub(crate) fn run_help<W: Write, E: Write>(
    exe: &Path,
    words: &[&str],
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    argv: &[&str],
) -> Outcome {
    // `--schema` prints a Zod schema, which lives in the bundle (ADR 0178 §5).
    if parsed.flags.on("schema") {
        return hand_over(&parsed.flags, out, err, argv);
    }
    let answer = match help::help_for(words) {
        Ok(answer) => answer,
        Err(failure) => return fail(out, err, Some(&parsed.flags), argv, &failure),
    };
    if output_mode(&parsed.flags) == OutputMode::Json {
        if let Some(command) = answer.command {
            return finish(out.json(&help_json::command_json(command)), out, err);
        }
        if words.is_empty() {
            let version = version::version(std::env::var("ACE_VERSION").ok().as_deref(), exe);
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
    exe: &Path,
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let value = version::version(std::env::var("ACE_VERSION").ok().as_deref(), exe);
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

pub(crate) fn home<W: Write, E: Write>(
    exe: &Path,
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    argv: &[&str],
) -> Outcome {
    let env = Env::from_process();
    // The interactive home is the bundle's (ADR 0221 §1); off a terminal this is the overview.
    if can_prompt(&parsed.flags, &env, terminal()) {
        return hand_over(&parsed.flags, out, err, argv);
    }
    if output_mode(&parsed.flags) == OutputMode::Json {
        let version = version::version(std::env::var("ACE_VERSION").ok().as_deref(), exe);
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
    argv: &[&str],
) -> Outcome {
    let word = parsed.words.first().copied().unwrap_or("");
    if word == "install" {
        return completion_install(parsed, out, err, argv);
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
        .with_argument("SHELL");
        return fail(out, err, Some(&parsed.flags), argv, &failure);
    };
    finish(out.write(completion::script(shell)), out, err)
}

fn completion_install<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    argv: &[&str],
) -> Outcome {
    let shell_name = std::env::var("SHELL").ok();
    let Some(shell) = completion::current_shell(shell_name.as_deref(), std::env::consts::OS) else {
        let shells: Vec<&str> = completion::SHELLS
            .iter()
            .map(|shell| shell.as_str())
            .collect();
        let failure = Failure::usage("ace can't tell which shell you use.").with_hint(format!(
            "Print a script with ace completion {} and add it yourself.",
            shells.join("|")
        ));
        return fail(out, err, Some(&parsed.flags), argv, &failure);
    };
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let plan = completion::install_plan(
        shell,
        &home,
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

pub(crate) fn run_complete<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    argv: &[&str],
) -> Outcome {
    let slot = completion::slot(&parsed.words);
    // A live reference is the daemon's to name; the connection lands in ADR 0221 step 3.
    if slot.reference.is_some() {
        return hand_over(&parsed.flags, out, err, argv);
    }
    finish(
        out.write(&completion::candidate_lines(&slot.candidates)),
        out,
        err,
    )
}
