// SPDX-License-Identifier: Apache-2.0
//! `ace`: the command-line tool for managing ace (ADR 0221). It runs ported commands itself and
//! hands every other command to the bundled runtime.

mod commands;
mod completion;
mod handover;
mod help;
mod help_json;
mod offline;
mod pages;
mod run;
mod version;

use std::borrow::Cow;
use std::io;
use std::process::ExitCode;

use cli_out::Out;

fn main() -> ExitCode {
    let os_args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let args: Vec<Cow<'_, str>> = os_args.iter().map(|arg| arg.to_string_lossy()).collect();
    let line: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
    // A hand-over makes no writer: the closures run only when a command answers here.
    let outcome = run::run(
        &line,
        &os_args,
        || Out::new(io::stdout().lock()),
        || Out::new(io::stderr().lock()),
    );
    ExitCode::from(outcome.exit_code())
}
