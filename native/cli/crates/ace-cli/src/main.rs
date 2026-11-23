// SPDX-License-Identifier: Apache-2.0
//! `ace`: the command-line tool for managing ace (ADR 0221). It runs ported commands itself and
//! hands every other command to the bundled runtime.

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
    let exe = std::env::current_exe().unwrap_or_default();
    let stdout = io::stdout();
    let stderr = io::stderr();
    let mut out = Out::new(stdout.lock());
    let mut err = Out::new(stderr.lock());
    let outcome = run::run(&exe, &line, &mut out, &mut err);
    let _ = out.flush();
    let _ = err.flush();
    ExitCode::from(outcome.exit_code())
}
