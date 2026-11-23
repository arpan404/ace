// SPDX-License-Identifier: Apache-2.0
//! `ace provider capabilities` and `ace model list`: everything at once, and the catalogue.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome};
use serde::Serialize;
use serde_json::Value;

use super::provider::{provider_argument, providers_of_reply};
use super::render::{array_at, columns, count, is_record, model_ids};
use super::session::{CommandResult, answer_shaped, usage};

const COMMAND_CAPABILITIES: &str = "provider.capabilities";
const COMMAND_MODEL_LIST: &str = "model.list";

#[derive(Serialize)]
struct ProvidersListRequest<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    operation: &'a str,
}

#[derive(Serialize)]
struct ModelsListOptions {
    offset: u32,
    limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instance: Option<String>,
}

#[derive(Serialize)]
struct ModelsListRequest {
    #[serde(rename = "type")]
    kind: &'static str,
    options: ModelsListOptions,
}

#[derive(Serialize)]
struct PermissionsRequest<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    provider: &'a str,
}

#[derive(Serialize)]
struct CapabilitiesOperation<'a> {
    op: &'a str,
}

pub fn capabilities<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let mut conn = match super::session::connect(&parsed.flags, COMMAND_CAPABILITIES) {
        Ok(conn) => conn,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let outcome = capabilities_on(&mut conn);
    conn.close();
    let (value, shaped, human, quiet) = match outcome {
        Ok(answer) => answer,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    answer_shaped(
        out,
        err,
        &parsed.flags,
        &value,
        shaped.as_deref(),
        &human,
        &quiet,
    )
}

type CapabilitiesAnswer = (Value, Option<String>, Vec<String>, Vec<String>);

fn capabilities_on(
    conn: &mut cli_wire::Connection,
) -> super::session::CommandResult<CapabilitiesAnswer> {
    let providers_reply = super::session::ws_send(
        conn,
        COMMAND_CAPABILITIES,
        &ProvidersListRequest {
            kind: "providers.request",
            operation: "list",
        },
    )?;
    let providers = providers_of_reply(&providers_reply, COMMAND_CAPABILITIES)?;
    let providers_raw = providers_reply.result_field_raw("providers");
    let models_reply = super::session::ws_send(
        conn,
        COMMAND_CAPABILITIES,
        &ModelsListRequest {
            kind: "models.list",
            options: ModelsListOptions {
                offset: 0,
                limit: 100,
                provider: None,
                instance: None,
            },
        },
    )?;
    let models = models_reply.get("result").cloned().unwrap_or(Value::Null);
    let models_raw = models_reply.result_raw().map(str::to_owned);
    let mut permissions = Vec::with_capacity(providers.len());
    let mut permissions_raw = Vec::with_capacity(providers.len());
    for provider in &providers {
        let Some(name) = provider.get("provider").and_then(Value::as_str) else {
            continue;
        };
        let result = super::session::ws_send(
            conn,
            COMMAND_CAPABILITIES,
            &PermissionsRequest {
                kind: "permissions.capabilities",
                provider: name,
            },
        )?;
        let name_json = serde_json::to_string(name).unwrap_or_default();
        permissions_raw.push(format!(
            "{{\"provider\":{name_json},\"result\":{}}}",
            result.text
        ));
        permissions.push(serde_json::json!({"provider": name, "result": result.value}));
    }
    let tools_reply = super::session::cli_send(
        conn,
        COMMAND_CAPABILITIES,
        &CapabilitiesOperation { op: "capabilities" },
    )?;
    let tools = tools_reply.get("result").cloned().unwrap_or(Value::Null);
    let tools_raw = tools_reply.result_raw().map(str::to_owned);
    let value = serde_json::json!({"providers": providers, "models": models, "permissions": permissions, "tools": tools});
    let shaped = match (providers_raw, models_raw, tools_raw) {
        (Some(providers), Some(models), Some(tools)) => Some(format!(
            "{{\"providers\":{providers},\"models\":{models},\"permissions\":[{}],\"tools\":{tools}}}",
            permissions_raw.join(","),
        )),
        _ => None,
    };
    let human = capabilities_lines(&value);
    let quiet: Vec<String> = value
        .get("providers")
        .and_then(Value::as_array)
        .map(|providers| {
            providers
                .iter()
                .filter_map(|status| status.get("provider").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok((value, shaped, human, quiet))
}

pub fn model_list<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    // The session opens first: a missing daemon refuses before the arguments are checked.
    let mut conn = match super::session::connect(&parsed.flags, COMMAND_MODEL_LIST) {
        Ok(conn) => conn,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let provider = match parsed.flags.value("provider") {
        None => None,
        Some(name) => match provider_argument(Some(name), COMMAND_MODEL_LIST) {
            Ok(provider) => Some(provider),
            Err(failure) => {
                conn.close();
                return crate::run::fail(out, err, Some(&parsed.flags), &failure);
            }
        },
    };
    let size = match parsed.flags.value("limit") {
        None => 100,
        Some(limit) => match limit_size(limit) {
            Ok(size) => size,
            Err(failure) => {
                conn.close();
                return crate::run::fail(out, err, Some(&parsed.flags), &failure);
            }
        },
    };
    let reply = match super::session::ws_send(
        &mut conn,
        COMMAND_MODEL_LIST,
        &ModelsListRequest {
            kind: "models.list",
            options: ModelsListOptions {
                offset: 0,
                limit: size,
                provider,
                instance: parsed.flags.value("account").map(str::to_owned),
            },
        },
    ) {
        Ok(reply) => reply,
        Err(failure) => {
            conn.close();
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    conn.close();
    let Some(result) = reply
        .get("result")
        .filter(|result| result.get("models").is_some())
    else {
        return crate::run::fail(
            out,
            err,
            Some(&parsed.flags),
            &Failure::new(Outcome::Refused, "The daemon didn't list models.")
                .with_hint("See the providers with ace provider list.")
                .with_command(COMMAND_MODEL_LIST),
        );
    };
    let human = model_list_lines(result);
    let quiet = model_ids(result);
    let shaped = reply.result_raw();
    answer_shaped(out, err, &parsed.flags, result, shaped, &human, &quiet)
}

fn limit_size(limit: &str) -> CommandResult<u32> {
    let trimmed = limit.trim();
    let number: f64 = trimmed.parse().unwrap_or(f64::NAN);
    if number.is_finite() && number.fract() == 0.0 && (1.0..=100.0).contains(&number) {
        // Range-checked to 1..=100 just above, so neither lint applies.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        return Ok(number as u32);
    }
    Err(Box::new(
        usage(
            "--limit takes a whole number from 1 to 100.",
            ErrorCode::BadArgument,
            COMMAND_MODEL_LIST,
        )
        .with_argument("--limit"),
    ))
}

/// The capabilities in a few lines; `--json` has every field.
fn capabilities_lines(value: &Value) -> Vec<String> {
    let providers = value
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let models = value.get("models").map_or(&Value::Null, |models| models);
    let tools = value.get("tools").map_or(&Value::Null, |tools| tools);
    let list = array_at(models, "models");
    let empty: &[Value] = &[];
    let mut per_provider = std::collections::HashMap::new();
    for model in list.map_or(empty, Vec::as_slice) {
        let provider = if is_record(model) {
            model
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        } else {
            String::new()
        };
        *per_provider.entry(provider).or_insert(0) += 1;
    }
    let tools_len = array_at(tools, "tools").map_or_else(
        || {
            if tools.is_array() {
                tools.as_array().map_or(0, Vec::len)
            } else {
                0
            }
        },
        Vec::len,
    );
    let mut lines = columns(
        &providers
            .iter()
            .map(|status| {
                let provider = status.get("provider").and_then(Value::as_str).unwrap_or("");
                let (words, _) = super::provider::provider_state(status);
                let mode_count = status
                    .get("permissionModes")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                vec![
                    Some(provider.to_owned()),
                    Some(words.to_owned()),
                    Some(count(
                        per_provider.get(provider).copied().unwrap_or(0),
                        "model",
                    )),
                    if mode_count == 0 {
                        None
                    } else {
                        Some(count(mode_count, "mode"))
                    },
                ]
            })
            .collect::<Vec<_>>(),
    );
    lines.push(String::new());
    lines.push(format!(
        "{}. Every field: ace provider capabilities --json",
        count(tools_len, "ace tool")
    ));
    lines
}

/// One model per line, grouped by provider in the catalogue's order.
fn model_list_lines(value: &Value) -> Vec<String> {
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let instances = value
        .get("instances")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if models.is_empty() {
        let failing: Vec<String> = instances
            .iter()
            .filter(|instance| instance.get("error").is_some())
            .map(|instance| {
                format!(
                    "{}: models couldn't be read ({}).",
                    instance
                        .get("instance")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    instance.get("error").and_then(Value::as_str).unwrap_or("")
                )
            })
            .collect();
        if failing.is_empty() {
            return vec!["No models yet. Check the providers with ace provider list.".to_owned()];
        }
        return failing;
    }
    let rows = models
        .iter()
        .map(|model| {
            let display = model.get("displayName").and_then(Value::as_str);
            let id = model.get("id").and_then(Value::as_str).unwrap_or("");
            vec![
                model
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                Some(id.to_owned()),
                display.filter(|display| *display != id).map(str::to_owned),
                if model.get("tier").and_then(Value::as_str) == Some("legacy") {
                    Some("older".to_owned())
                } else {
                    None
                },
            ]
        })
        .collect::<Vec<_>>();
    let mut lines = columns(&rows);
    let notes: Vec<String> = instances
        .iter()
        .filter_map(|instance| {
            let name = instance
                .get("instance")
                .and_then(Value::as_str)
                .unwrap_or("");
            if let Some(error) = instance.get("error").and_then(Value::as_str) {
                Some(format!("{name}: couldn't refresh its models ({error})."))
            } else if instance.get("stale").and_then(Value::as_bool) == Some(true) {
                Some(format!("{name}: models may be out of date."))
            } else {
                None
            }
        })
        .collect();
    let more = value.get("nextOffset").is_some();
    if !notes.is_empty() || more {
        lines.push(String::new());
        lines.extend(notes);
        if more {
            lines.push("More models: pass --limit with a larger number.".to_owned());
        }
    }
    lines
}
