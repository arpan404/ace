// SPDX-License-Identifier: Apache-2.0
//! `storage clean` (ADR 0178 §7): plan, show the plan, ask, then apply that exact plan and
//! revision once the person says yes. Off a terminal it needs `--yes`, and refuses before
//! planning without it, so an unattended run never removes anything without consent.

use std::io::Write;

use cli_out::{Failure, Out, Outcome};
use cli_parse::Parsed;

use super::apply::{Reviewed, apply_reviewed};
use super::error;
use super::plan::{self};
use super::render::{self, Plan};
use super::request::{self, Answer};

/// Plans a cleanup, shows it, asks, then applies it.
pub(crate) fn clean<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "storage.clean";
    plan_or_clean(parsed, out, err, ID, false)
}

/// Plans, or only previews with `--dry-run`, as `storage plan` does.
pub(crate) fn plan_or_clean<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    id: &'static str,
    dry_run_only: bool,
) -> Outcome {
    let timeout = match error::request_timeout(parsed.flags.value("timeout"), id) {
        Ok(timeout) => timeout,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let operation = match plan::plan_operation(
        &parsed.flags,
        &plan::flag_lists(parsed),
        |path| std::fs::read_to_string(path),
        id,
    ) {
        Ok(operation) => operation,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    if dry_run_only || parsed.flags.on("dry-run") {
        return super::storage::print_plan(parsed, out, err, id, &operation, timeout);
    }
    if !operation.force_items().is_empty() {
        let failure = Failure::new(
            Outcome::Refused,
            "--force-item needs --dry-run first. Nothing was removed.",
        )
        .with_code(cli_out::ErrorCode::Refused)
        .with_hint("Review the plan with --dry-run, then apply it with ace storage apply PLAN --revision R.")
        .with_command(id);
        return crate::run::fail(out, err, Some(&parsed.flags), &failure);
    }
    let interactive = cli_out::can_prompt(
        &parsed.flags,
        &cli_out::Env::from_process(),
        crate::run::terminal(),
    );
    if !parsed.flags.on("yes") && !interactive {
        let failure = Failure::new(
            Outcome::Refused,
            "Pass --yes to clean without a terminal, or --dry-run to preview. Nothing was removed.",
        )
        .with_code(cli_out::ErrorCode::Confirm)
        .with_command(id);
        return crate::run::fail(out, err, Some(&parsed.flags), &failure);
    }
    let reply = match request::plan_request(&operation, timeout) {
        Ok(reply) => reply,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &error::wire_failure(&error, id),
            );
        }
    };
    clean_reviewed(parsed, out, err, id, timeout, &reply)
}

/// Shows the reviewed plan, asks, and applies it once the person says yes.
fn clean_reviewed<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    id: &'static str,
    timeout: std::time::Duration,
    reply: &cli_wire::Reply,
) -> Outcome {
    let raw = match request::payload(reply, "plan", "The daemon returned no plan.", id, None) {
        Ok(raw) => raw,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let measured: Plan<'_> = match request::decode(raw, id) {
        Ok(measured) => measured,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let human = cli_out::output_mode(&parsed.flags) == cli_out::OutputMode::Human;
    if human {
        let lines = render::plan_lines(&measured);
        let quiet = vec![measured.id.to_string()];
        let outcome = request::print_answer(
            parsed,
            out,
            err,
            id,
            &Answer {
                human: &lines,
                json: raw.get(),
                quiet: &quiet,
                outcome: Outcome::Ok,
            },
        );
        if outcome != Outcome::Ok {
            return outcome;
        }
    }
    let removable = measured
        .items
        .iter()
        .any(|item| item.disposition == "remove");
    if !removable {
        let nothing = ["Nothing to remove.".to_owned()];
        let json = format!("{{\"plan\":{},\"apply\":null}}", raw.get());
        return request::print_answer(
            parsed,
            out,
            err,
            id,
            &Answer {
                human: &nothing,
                json: &json,
                quiet: &[],
                outcome: Outcome::Ok,
            },
        );
    }
    if !parsed.flags.on("yes") {
        if !human {
            let _ = err.write(&format!("{}\n", render::plan_lines(&measured).join("\n")));
        }
        if !ask_confirm(&render::confirm_question(&measured)) {
            let failure = Failure::new(Outcome::Refused, "Cleanup cancelled. Nothing was removed.")
                .with_code(cli_out::ErrorCode::Refused)
                .with_command(id);
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    }
    let reviewed = Reviewed {
        plan_raw: raw.get(),
        plan_id: &measured.id,
        revision: &measured.revision,
    };
    apply_reviewed(parsed, out, err, id, timeout, &reviewed)
}

/// Asks the person to confirm; an aborted or cancelled prompt refuses.
fn ask_confirm(question: &str) -> bool {
    use std::io::BufRead as _;
    let mut stderr = std::io::stderr().lock();
    let _ = write!(stderr, "{question} (y/N): ");
    let _ = stderr.flush();
    drop(stderr);
    let stdin = std::io::stdin();
    let mut answer = String::new();
    if stdin.lock().read_line(&mut answer).is_err() {
        return false;
    }
    answer.trim().eq_ignore_ascii_case("y") || answer.trim().eq_ignore_ascii_case("yes")
}
