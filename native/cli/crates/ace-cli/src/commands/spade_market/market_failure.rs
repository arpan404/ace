// SPDX-License-Identifier: Apache-2.0
//! The Store's refusal as the CLI reports it (ADR 0178 §12.3–§12.4). Pure.

use cli_out::{ErrorCode, Failure, Outcome};

pub(crate) fn market_failure(error: &serde_json::Value, command: &'static str) -> Failure<'static> {
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
