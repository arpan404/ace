// SPDX-License-Identifier: Apache-2.0
//! `ace request allow|deny|answer` in Rust: the person's gate, then the bundle's prompt.
//!
//! Answering is the person's to do (never an agent's), and it needs a person at a terminal to
//! type the word. Both refusals answer here with no daemon; a terminal hands over so the bundle's
//! own prompt asks. Anything else (`--thread` resolution, the open list, the durable resolve)
//! stays on the bundle in this step rather than approximated.

use std::io::Write;

use cli_out::{Env, Failure, Out, Outcome, Terminal, can_prompt};
use cli_parse::Parsed;

use crate::run::fail;

fn agent_shell(env: &Env) -> bool {
    let thread = env.thread_id.as_deref().unwrap_or("").trim();
    if !thread.is_empty() {
        return true;
    }
    cli_out::env_on(env.no_input.as_deref())
}

fn terminal() -> Terminal {
    Terminal {
        stdin: std::io::IsTerminal::is_terminal(&std::io::stdin()),
        stdout: std::io::IsTerminal::is_terminal(&std::io::stdout()),
        stderr: false,
    }
}

pub fn run<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
    _verb: &str,
) -> Outcome {
    let env = Env::from_process();
    let term = terminal();
    // An agent's shell never answers: exit 2, never the 4 of "ace isn't running".
    if agent_shell(&env) {
        let failure = Failure::new(
            Outcome::NeedsHuman,
            "Answering a request is yours to do, not an agent's.",
        )
        .with_code(cli_out::ErrorCode::PersonOnly)
        .with_hint("Agents never answer requests or change settings. Ask the person: they do it in the app, on a paired device or in their own terminal.");
        return fail(out, err, Some(&parsed.flags), &failure);
    }
    // Off a terminal nobody can confirm: exit 2 with the confirm step, before any daemon.
    if !can_prompt(&parsed.flags, &env, term) {
        let failure = Failure::new(
            Outcome::NeedsHuman,
            "Answering a request needs you at a terminal to confirm it.",
        )
        .with_code(cli_out::ErrorCode::Confirm)
        .with_hint("Run it in your own terminal without --json, --quiet or --no-input, or answer in the app or on a paired device.");
        return fail(out, err, Some(&parsed.flags), &failure);
    }
    // A person at a terminal types the word; the asking is the bundle's.
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::new());
    match crate::handover::locate(&exe) {
        Ok(launch) => {
            let failure = crate::handover::hand_over(&launch, os_args);
            fail(out, err, Some(&parsed.flags), &failure)
        }
        Err(error) => fail(out, err, Some(&parsed.flags), &error.failure()),
    }
}
