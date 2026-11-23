// SPDX-License-Identifier: Apache-2.0
//! `ace provider list|show`: the installed provider CLIs and whether they're ready.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome};
use serde::Serialize;
use serde_json::Value;

use super::render::columns;
use super::session::{CommandResult, answer_shaped, usage, ws_once};

const COMMAND_LIST: &str = "provider.list";
const COMMAND_SHOW: &str = "provider.show";

const PROVIDERS: &[&str] = &["codex", "claude", "cursor", "opencode", "antigravity", "pi"];

/// A provider name as typed, or the sentence naming the ones there are.
pub fn provider_argument(word: Option<&str>, command: &'static str) -> CommandResult<String> {
    let Some(word) = word.map(str::trim).map(str::to_lowercase) else {
        return provider_usage(command);
    };
    if word != "acp" && PROVIDERS.contains(&word.as_str()) {
        return Ok(word);
    }
    provider_usage(command)
}

fn provider_usage(command: &'static str) -> CommandResult<String> {
    Err(Box::new(
        usage(
            "PROVIDER must be codex, claude, cursor, opencode, antigravity or pi.",
            ErrorCode::BadArgument,
            command,
        )
        .with_argument("PROVIDER")
        .with_hint("See the providers with ace provider list."),
    ))
}

/// The refusal a daemon error for providers carries.
fn refused(code: &str, command: &'static str) -> Failure<'static> {
    let message = match code {
        "forbidden" => "This connection can't manage providers.",
        "unavailable" => "Providers aren't available on this daemon right now.",
        "busy" => "Another sign-in for this provider is running. Finish or cancel it first.",
        "not_found" => "That provider or account isn't on this machine.",
        "invalid_input" => "The provider didn't take that answer.",
        _ => {
            return Failure::new(Outcome::Refused, format!("The daemon refused: {code}."))
                .with_command(command);
        }
    };
    let error = match code {
        "busy" => ErrorCode::Busy,
        "not_found" => ErrorCode::NotFound,
        _ => ErrorCode::Refused,
    };
    Failure::new(Outcome::Refused, message)
        .with_code(error)
        .with_hint("See their state with ace provider list.")
        .with_command(command)
}

#[derive(Serialize)]
struct ProvidersListRequest<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    operation: &'a str,
}

fn ok_result(reply: &Value) -> Option<&Value> {
    let result = reply.get("result")?;
    if result.get("ok")?.as_bool()? {
        Some(result)
    } else {
        None
    }
}

fn refused_code(reply: &Value) -> String {
    reply
        .get("result")
        .and_then(|result| result.get("error"))
        .and_then(Value::as_str)
        .unwrap_or("refused")
        .to_owned()
}

pub fn provider_list<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let reply = match ws_once(
        &parsed.flags,
        COMMAND_LIST,
        &ProvidersListRequest {
            kind: "providers.request",
            operation: "list",
        },
    ) {
        Ok(reply) => reply,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let result = match ok_providers(&reply, COMMAND_LIST) {
        Ok(result) => result,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let human = provider_list_lines(&result);
    let quiet = super::render::quiet_of_show(&result, false);
    answer_shaped(
        out,
        err,
        &parsed.flags,
        &result,
        reply.result_raw(),
        &human,
        &quiet,
    )
}

pub fn provider_show<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    // The session opens first: a missing daemon refuses before the argument is checked.
    let mut conn = match super::session::connect(&parsed.flags, COMMAND_SHOW) {
        Ok(conn) => conn,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let provider = match provider_argument(parsed.words.first().copied(), COMMAND_SHOW) {
        Ok(provider) => provider,
        Err(failure) => {
            conn.close();
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    let reply = match super::session::ws_send(
        &mut conn,
        COMMAND_SHOW,
        &ProvidersListRequest {
            kind: "providers.request",
            operation: "list",
        },
    ) {
        Ok(reply) => reply,
        Err(failure) => {
            conn.close();
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    conn.close();
    let Some(result) = ok_result(&reply) else {
        let code = refused_code(&reply);
        return crate::run::fail(out, err, Some(&parsed.flags), &refused(&code, COMMAND_SHOW));
    };
    let status = result
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|providers| {
            providers.iter().find(|status| {
                status.get("provider").and_then(Value::as_str) == Some(provider.as_str())
            })
        });
    let Some(status) = status else {
        return crate::run::fail(
            out,
            err,
            Some(&parsed.flags),
            &Failure::new(
                Outcome::Refused,
                format!("{} isn't on this machine.", provider_name(&provider)),
            )
            .with_code(ErrorCode::NotFound)
            .with_hint("See the providers ace found with ace provider list.")
            .with_command(COMMAND_SHOW),
        );
    };
    let human = provider_show_lines(status);
    let quiet = super::render::quiet_of_show(status, true);
    let shaped = super::render::provider_element_raw(&reply, &provider);
    answer_shaped(
        out,
        err,
        &parsed.flags,
        status,
        shaped.as_deref(),
        &human,
        &quiet,
    )
}

/// The provider's display name.
pub fn provider_name(provider: &str) -> &str {
    match provider {
        "codex" => "Codex",
        "claude" => "Claude Code",
        "cursor" => "Cursor",
        "opencode" => "OpenCode",
        "antigravity" => "Antigravity",
        "pi" => "Pi",
        "acp" => "ACP agent",
        _ => provider,
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// The `result` a `providers.result` reply carries, or its refusal.
pub fn ok_providers(reply: &Value, command: &'static str) -> CommandResult<Value> {
    let Some(result) = ok_result(reply) else {
        return Err(Box::new(refused(&refused_code(reply), command)));
    };
    Ok(result.clone())
}

/// The providers a `providers.result` reply lists, or its refusal.
pub fn providers_of_reply(reply: &Value, command: &'static str) -> CommandResult<Vec<Value>> {
    Ok(ok_providers(reply, command)?
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// The state a person reads.
pub fn provider_state(status: &Value) -> (&'static str, bool) {
    if status.get("enabled").and_then(Value::as_bool) == Some(false) {
        return ("off", false);
    }
    if status.get("installed").and_then(Value::as_bool) == Some(false)
        || str_field(status, "readiness") == Some("not_installed")
    {
        return ("not installed", true);
    }
    if status
        .get("versionCheck")
        .and_then(|check| check.get("status"))
        .and_then(Value::as_str)
        == Some("too_old")
        || str_field(status, "readiness") == Some("needs_update")
    {
        return ("needs an update", true);
    }
    if str_field(status, "readiness") == Some("not_configured")
        || str_field(status, "state") == Some("not_configured")
    {
        return ("not set up", true);
    }
    if str_field(status, "auth") == Some("logged_out")
        || str_field(status, "readiness") == Some("installed_signed_out")
    {
        return ("signed out", true);
    }
    if str_field(status, "readiness") == Some("needs_attention")
        || status
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| !error.is_empty())
    {
        return ("needs attention", true);
    }
    if str_field(status, "auth") == Some("logged_in")
        || str_field(status, "readiness") == Some("signed_in")
    {
        return ("ready", false);
    }
    ("checking", false)
}

fn provider_list_lines(value: &Value) -> Vec<String> {
    let providers = value
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if providers.is_empty() {
        return vec!["No provider CLIs found. Install Codex or Claude Code.".to_owned()];
    }
    columns(
        &providers
            .iter()
            .map(|status| {
                let (words, _) = provider_state(status);
                vec![
                    str_field(status, "provider").map(str::to_owned),
                    Some(words.to_owned()),
                    str_field(status, "version").map(str::to_owned),
                    str_field(status, "accountLabel").map(str::to_owned),
                ]
            })
            .collect::<Vec<_>>(),
    )
}

/// The next command for a provider that isn't ready, or nothing.
fn provider_next_step(status: &Value) -> Option<String> {
    let (words, _) = provider_state(status);
    let provider = str_field(status, "provider").unwrap_or("");
    match words {
        "not installed" => Some(
            str_field(status, "installCommand")
                .map(|command| format!("Install it: {command}"))
                .or_else(|| str_field(status, "installHint").map(str::to_owned))?,
        ),
        "signed out" => Some(format!("Sign in: ace provider login {provider}")),
        "needs an update" => Some(
            str_field(status, "installCommand")
                .map(|command| format!("Update it: {command}"))
                .or_else(|| str_field(status, "installHint").map(str::to_owned))?,
        ),
        "needs attention" => str_field(status, "error")
            .map(str::to_owned)
            .or_else(|| str_field(status, "loginHint").map(str::to_owned)),
        _ => None,
    }
}

fn provider_show_lines(status: &Value) -> Vec<String> {
    let (words, _) = provider_state(status);
    let provider = str_field(status, "provider").unwrap_or("");
    let tools = status
        .get("nativeTools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .map(|tool| {
                    format!(
                        "{} {}",
                        tool.get("label").and_then(Value::as_str).unwrap_or(""),
                        tool.get("state").and_then(Value::as_str).unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        });
    let rows: Vec<(String, Option<String>)> = vec![
        ("state".to_owned(), Some(words.to_owned())),
        (
            "version".to_owned(),
            str_field(status, "version").map(str::to_owned),
        ),
        (
            "latest".to_owned(),
            if status.get("updateAvailable").and_then(Value::as_bool) == Some(true) {
                str_field(status, "latestVersion").map(str::to_owned)
            } else {
                None
            },
        ),
        (
            "path".to_owned(),
            str_field(status, "path").map(str::to_owned),
        ),
        (
            "account".to_owned(),
            str_field(status, "accountLabel").map(str::to_owned),
        ),
        (
            "sign-in".to_owned(),
            str_field(status, "authMethod").map(str::to_owned),
        ),
        ("tools".to_owned(), tools.filter(|tools| !tools.is_empty())),
    ];
    let mut lines = vec![format!("{} ({provider})", provider_name(provider))];
    lines.extend(columns(
        &rows
            .into_iter()
            .filter_map(|(name, value)| {
                value.map(|value| vec![Some(format!("  {name}")), Some(value)])
            })
            .collect::<Vec<_>>(),
    ));
    if let Some(next) = provider_next_step(status) {
        lines.push(String::new());
        lines.push(next);
    }
    lines
}
