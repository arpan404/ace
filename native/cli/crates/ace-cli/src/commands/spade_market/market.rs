// SPDX-License-Identifier: Apache-2.0
//! `ace store …`: reads and simple mutations through the daemon's `marketplace.request`.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome, OutputMode};
use cli_parse::Parsed;
use cli_wire::Connection;

use super::common;
use super::market_ops::{market_operation, operation_verb};
use super::market_render::{
    discover_lines, entry_lines, installed_lines, publish_lines, publisher_lines, search_lines,
    source_lines,
};
use crate::commands::work::common::{connect, mode, timeout_duration, wire_failure};
use crate::run::fail;

pub fn run<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    if parsed.flags.has("remote") {
        return handover(parsed, os_args, out, err);
    }
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let output = mode(parsed);
    // Usage errors come before any connection.
    let operation = match market_operation(parsed) {
        Ok(operation) => operation,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    // No thread to ask in: an agent's shell runs only the agents' allowlist.
    let thread = common::own_thread(parsed);
    if thread.is_none() && common::agent_shell() {
        let (op, action) = operation_verb(&operation);
        if !common::agent_may_run(&op, action.as_deref()) {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &common::market_refusal(parsed.command.id),
            );
        }
    }
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let answer = match ask_market(
        &mut conn,
        &operation,
        thread.as_deref(),
        timeout,
        parsed.command.id,
    ) {
        Ok(answer) => answer,
        Err(failure) => {
            // Signed out, on a terminal: the bundle offers a sign-in, then runs it once more.
            if failure.code == ErrorCode::SignedOut && interactive_human(parsed) {
                return handover(parsed, os_args, out, err);
            }
            return fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    render_answer(&answer, parsed.command.id, output, out, err)
}

fn interactive_human(parsed: &Parsed<'_>) -> bool {
    if mode(parsed) != OutputMode::Human {
        return false;
    }
    let env = cli_out::Env::from_process();
    cli_out::can_prompt(&parsed.flags, &env, crate::run::terminal())
}

/// One daemon connection for a command's market requests.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn ask_market(
    conn: &mut Connection,
    operation: &serde_json::Value,
    thread: Option<&str>,
    timeout: std::time::Duration,
    command: &'static str,
) -> Result<serde_json::Value, Failure<'static>> {
    let mut frame = serde_json::Map::new();
    frame.insert(
        "type".to_owned(),
        serde_json::Value::String("marketplace.request".to_owned()),
    );
    frame.insert("operation".to_owned(), operation.clone());
    if let Some(thread) = thread {
        frame.insert(
            "thread".to_owned(),
            serde_json::Value::String(thread.to_owned()),
        );
    }
    let reply = conn
        .request_with_timeout(&serde_json::Value::Object(frame), timeout)
        .map_err(|err| wire_failure(&err, Some(command)))?;
    let envelope: MarketEnvelope<'_> = reply
        .decode()
        .map_err(|err| wire_failure(&err, Some(command)))?;
    let result: serde_json::Value = serde_json::from_str(envelope.result.get()).map_err(|_| {
        wire_failure(
            &cli_wire::WireError::Protocol {
                detail: "Malformed marketplace result".into(),
            },
            Some(command),
        )
    })?;
    if result.get("op").and_then(serde_json::Value::as_str) == Some("error") {
        return Err(market_failure(&result, command));
    }
    Ok(result)
}

#[derive(serde::Deserialize)]
struct MarketEnvelope<'a> {
    #[serde(borrow)]
    result: &'a serde_json::value::RawValue,
}

fn handover<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    os_args: &[std::ffi::OsString],
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::new());
    match crate::handover::locate(&exe) {
        Ok(launch) => {
            let failure = crate::handover::hand_over(&launch, os_args);
            crate::run::fail(out, err, Some(&parsed.flags), &failure)
        }
        Err(error) => {
            let failure = error.failure();
            crate::run::fail(out, err, Some(&parsed.flags), &failure)
        }
    }
}

/// The Store's refusal as the CLI reports it (ADR 0178 §12.3–§12.4).
fn market_failure(error: &serde_json::Value, command: &'static str) -> Failure<'static> {
    let code = error
        .get("code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("failed");
    let (outcome, mapped) = market_outcome(code);
    let message = error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    let message = if code == "signed_out" {
        "Sign in to publish.".to_owned()
    } else if message.is_empty() {
        code.to_owned()
    } else {
        message.to_owned()
    };
    let turned_off = code == "unavailable"
        && (message.starts_with("The Store is turned off")
            || message.starts_with("The Marketplace is turned off")
            || message.starts_with("The marketplace is turned off")
            || message == "store.acehq.dev is turned off"
            || message == "market.acehq.dev is turned off");
    let mapped = if turned_off { "turned_off" } else { mapped };
    let hint = if code == "blocked" {
        Some(
            "The draft is kept. Fix the files and update it, or ask for a look with ace store appeal REF@VERSION --note TEXT.",
        )
    } else if turned_off {
        Some(
            if message == "store.acehq.dev is turned off"
                || message == "market.acehq.dev is turned off"
            {
                "Turn the source back on with ace store source on market."
            } else {
                "Turn the Store on with ace feature on store."
            },
        )
    } else {
        market_hint(code)
    };
    let mut failure = Failure::new(outcome, message)
        .with_code(error_code(mapped))
        .with_command(command);
    if let Some(hint) = hint {
        failure = failure.with_hint(hint);
    }
    let mut problems = Vec::new();
    let empty = Vec::new();
    for problem in error
        .get("problems")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
    {
        problems.push(cli_problem(problem));
    }
    if let Some(scan) = error.get("scan") {
        if let Some(findings) = scan.get("findings").and_then(serde_json::Value::as_array) {
            for finding in findings {
                if finding.get("level").and_then(serde_json::Value::as_str) == Some("note") {
                    continue;
                }
                problems.push(cli_problem(finding));
            }
        }
        failure.admission = Some(serde_json::json!({"scan": scan}));
    }
    if !problems.is_empty() {
        failure.problems = problems;
    }
    if let Some(request) = error.get("request").and_then(serde_json::Value::as_str) {
        failure.request = Some(std::borrow::Cow::Owned(request.to_owned()));
    }
    failure
}

fn market_hint(code: &str) -> Option<&'static str> {
    match code {
        "signed_out" => Some("Sign in with ace login, then run it again."),
        "reauth" => Some("Do this in the ace app signed in as you: the CLI can't prove it's you."),
        "person_grant" => {
            Some("Do this in an ace app you're signed in on: the Store takes it only from you.")
        }
        "not_member" => Some(
            "Install from an organization's registry in an ace app signed in to that organization.",
        ),
        "registry_trust" => {
            Some("Trust the organization's registry key in an ace app, on this machine.")
        }
        "unavailable" => Some(
            "Nothing was changed. Try again shortly; ace account status shows whether this machine is signed in.",
        ),
        "expired" => Some("The review ran out; run the command again for a fresh one."),
        _ => None,
    }
}

fn market_outcome(code: &str) -> (Outcome, &'static str) {
    match code {
        "signed_out" => (Outcome::NeedsHuman, "signed_out"),
        "reauth" => (Outcome::NeedsHuman, "reauth"),
        "person_only" | "person_grant" | "not_member" | "registry_trust" => {
            (Outcome::NeedsHuman, "person_only")
        }
        "blocked" => (Outcome::Failed, "blocked"),
        "suspended" => (Outcome::Refused, "suspended"),
        "quota" => (Outcome::Refused, "quota"),
        "forbidden" => (Outcome::Refused, "forbidden"),
        "conflict" => (Outcome::Refused, "conflict"),
        "not_found" => (Outcome::Refused, "not_found"),
        "invalid" | "refused" | "unavailable" | "busy" => (
            Outcome::Refused,
            if code == "busy" { "busy" } else { "refused" },
        ),
        _ => (Outcome::Failed, "failed"),
    }
}

fn error_code(code: &str) -> ErrorCode {
    match code {
        "signed_out" => ErrorCode::SignedOut,
        "reauth" => ErrorCode::Reauth,
        "person_only" => ErrorCode::PersonOnly,
        "blocked" => ErrorCode::Blocked,
        "suspended" => ErrorCode::Suspended,
        "quota" => ErrorCode::Quota,
        "forbidden" => ErrorCode::Forbidden,
        "conflict" => ErrorCode::Conflict,
        "not_found" => ErrorCode::NotFound,
        "busy" => ErrorCode::Busy,
        "turned_off" => ErrorCode::TurnedOff,
        "invalid" | "refused" | "unavailable" => ErrorCode::Refused,
        _ => ErrorCode::Failed,
    }
}

fn cli_problem(value: &serde_json::Value) -> cli_out::Problem<'static> {
    cli_out::Problem {
        path: value
            .get("path")
            .and_then(serde_json::Value::as_str)
            .map(|path| std::borrow::Cow::Owned(path.to_owned())),
        line: value
            .get("line")
            .and_then(serde_json::Value::as_u64)
            .and_then(|line| u32::try_from(line).ok()),
        message: value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_owned()
            .into(),
    }
}

fn render_answer<W: Write, E: Write>(
    answer: &serde_json::Value,
    command: &'static str,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let op = answer
        .get("op")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let printed = printed_value(answer, op);
    match output {
        OutputMode::Json => match out.json(&printed.value) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(command, &error, out, err),
        },
        OutputMode::Human => {
            let lines = printed.human.unwrap_or_else(|| vec!["Done.".to_owned()]);
            match lines.iter().try_for_each(|line| out.line(line)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(command, &error, out, err),
            }
        }
        OutputMode::Quiet => {
            let ids = printed.quiet.unwrap_or_default();
            match ids.iter().try_for_each(|id| out.line(id)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(command, &error, out, err),
            }
        }
    }
}

struct Printed {
    value: serde_json::Value,
    human: Option<Vec<String>>,
    quiet: Option<Vec<String>>,
}

fn entry_id(entry: &serde_json::Value) -> String {
    format!(
        "{}/{}",
        entry
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(""),
        entry
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    )
}

fn print_discover(answer: &serde_json::Value) -> Printed {
    let discover = answer.get("discover").cloned().unwrap_or_default();
    let human = discover_lines(&discover);
    Printed {
        value: discover,
        human: Some(human),
        quiet: Some(Vec::new()),
    }
}

fn print_sources(answer: &serde_json::Value) -> Printed {
    let sources = answer
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let human = source_lines(&sources);
    let quiet = sources
        .iter()
        .filter_map(|source| {
            source
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    Printed {
        value: serde_json::json!({"sources": sources}),
        human: Some(human),
        quiet: Some(quiet),
    }
}

fn print_done(answer: &serde_json::Value) -> Printed {
    let mut value = serde_json::json!({"ok": true});
    if let Some(installed) = answer.get("installed")
        && let Some(object) = value.as_object_mut()
    {
        object.insert("installed".to_owned(), installed.clone());
    }
    Printed {
        value,
        human: Some(vec!["Done.".to_owned()]),
        quiet: Some(Vec::new()),
    }
}

fn strip_op(answer: &serde_json::Value) -> serde_json::Value {
    let mut value = answer.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("op");
    }
    value
}

/// What a market command prints: the answer's data unchanged, lines for a person, ids for quiet.
fn printed_value(answer: &serde_json::Value, op: &str) -> Printed {
    match op {
        "discover" => print_discover(answer),
        "search" => {
            let value = strip_op(answer);
            let human = search_lines(answer);
            let quiet = answer
                .get("entries")
                .and_then(serde_json::Value::as_array)
                .map_or_else(Vec::new, |entries| entries.iter().map(entry_id).collect());
            Printed {
                value,
                human: Some(human),
                quiet: Some(quiet),
            }
        }
        "read" => {
            let entry = answer.get("entry").cloned().unwrap_or_default();
            let human = entry_lines(&entry);
            Printed {
                value: serde_json::json!({"kind": "entry", "entry": entry}),
                human: Some(human),
                quiet: Some(Vec::new()),
            }
        }
        "publisher" => {
            let page = answer.get("page").cloned().unwrap_or_default();
            let human = publisher_lines(&page);
            Printed {
                value: serde_json::json!({"kind": "publisher", "page": page}),
                human: Some(human),
                quiet: Some(Vec::new()),
            }
        }
        "installed" => {
            let installed = answer
                .get("installed")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let human = installed_lines(&installed);
            let quiet = installed.iter().map(entry_id).collect();
            Printed {
                value: serde_json::json!({"installed": installed}),
                human: Some(human),
                quiet: Some(quiet),
            }
        }
        "sources" => print_sources(answer),
        "done" => print_done(answer),
        "publish" => {
            let inner = answer.get("answer").cloned().unwrap_or_default();
            let human = publish_lines(&inner);
            let quiet = match inner.get("kind").and_then(serde_json::Value::as_str) {
                Some("draft") => inner
                    .get("draft")
                    .and_then(|draft| draft.get("id"))
                    .and_then(serde_json::Value::as_str)
                    .map_or_else(Vec::new, |id| vec![id.to_owned()]),
                Some("me") => inner
                    .get("me")
                    .and_then(|me| me.get("drafts"))
                    .and_then(serde_json::Value::as_array)
                    .map_or_else(Vec::new, |drafts| {
                        drafts
                            .iter()
                            .filter_map(|draft| {
                                draft
                                    .get("id")
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_owned)
                            })
                            .collect()
                    }),
                _ => Vec::new(),
            };
            Printed {
                value: inner,
                human: Some(human),
                quiet: Some(quiet),
            }
        }
        _ => Printed {
            value: strip_op(answer),
            human: None,
            quiet: None,
        },
    }
}
