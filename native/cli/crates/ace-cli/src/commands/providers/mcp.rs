// SPDX-License-Identifier: Apache-2.0
//! `ace mcp list|add|revoke`: outside MCP clients' access.

use cli_out::{ErrorCode, Failure, Out, Outcome};
use serde::Serialize;
use serde_json::Value;
use std::io::Write;

use super::render::mcp_added_lines;
use super::session::{CommandResult, answer_shaped, cli_once, schema_error, usage};

const COMMAND_LIST: &str = "mcp.list";
const COMMAND_ADD: &str = "mcp.add";
const COMMAND_REVOKE: &str = "mcp.revoke";

const OUTSIDE_SCOPES: &[&str] = &[
    "threads:read",
    "threads:start",
    "threads:message",
    "threads:stop",
    "browser",
    "computer",
    "spade-contracts",
];

#[derive(Serialize)]
struct McpListOperation<'a> {
    op: &'a str,
}

#[derive(Serialize)]
struct McpEnrollOperation {
    op: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allow: Option<Vec<String>>,
    #[serde(rename = "ttlMs")]
    ttl_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    projects: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize)]
struct McpRevokeOperation<'a> {
    op: &'a str,
    id: &'a str,
}

/// `--ttl` for a grant: `30m`, `12h`, `30d`, or `never` (null).
fn grant_lifetime_ms(value: &str, command: &'static str) -> CommandResult<Option<i64>> {
    if value == "never" {
        return Ok(None);
    }
    let split = value
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(value.len());
    let (digits, suffix) = value.split_at(split);
    if digits.is_empty() || digits.len() > 4 {
        return lifetime_usage(command);
    }
    let number: i64 = digits.parse().unwrap_or(0);
    if number == 0 {
        return lifetime_usage(command);
    }
    let scale = match suffix {
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return lifetime_usage(command),
    };
    Ok(Some(number * scale))
}

fn lifetime_usage(command: &'static str) -> CommandResult<Option<i64>> {
    Err(Box::new(
        usage(
            "--ttl takes minutes, hours or days (30m, 12h, 30d), or never.",
            ErrorCode::BadArgument,
            command,
        )
        .with_argument("--ttl"),
    ))
}

fn list_flag(parsed: &cli_parse::Parsed<'_>, name: &str) -> Option<Vec<String>> {
    parsed.flags.value(name).map(|value| {
        value
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_owned)
            .collect()
    })
}

pub fn list<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let reply = match cli_once(
        &parsed.flags,
        COMMAND_LIST,
        &McpListOperation { op: "mcp.list" },
    ) {
        Ok(reply) => reply,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let data = reply
        .get("result")
        .and_then(|result| result.get("data"))
        .cloned()
        .unwrap_or(Value::Null);
    if is_daemon_refusal(&reply) {
        return crate::run::fail(
            out,
            err,
            Some(&parsed.flags),
            &daemon_refused(&reply, COMMAND_LIST),
        );
    }
    let human = super::render::mcp_list_lines(&data, super::render::now_ms());
    let quiet = super::render::grant_ids(&data, super::render::now_ms());
    answer_shaped(
        out,
        err,
        &parsed.flags,
        &data,
        reply.data_raw(),
        &human,
        &quiet,
    )
}

fn is_daemon_refusal(reply: &Value) -> bool {
    reply
        .get("result")
        .and_then(|result| result.get("ok"))
        .and_then(Value::as_bool)
        == Some(false)
}

fn daemon_refused(reply: &Value, command: &'static str) -> Failure<'static> {
    let code = reply
        .get("result")
        .and_then(|result| result.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("refused");
    Failure::new(Outcome::Refused, format!("The daemon refused: {code}.")).with_command(command)
}

/// The enroll operation its flags describe, or what is wrong with them.
/// The checks run where the TypeScript CLI's do: missing and clashing flags, then the
/// time-to-live's own grammar, then `CliOperation`'s schema in field order.
fn enroll_validated(
    parsed: &cli_parse::Parsed<'_>,
) -> super::session::CommandResult<McpEnrollOperation> {
    if parsed.flags.value("ttl").is_none() {
        return Err(Box::new(
            usage(
                "ace mcp add needs --ttl: how long the client keeps access.",
                ErrorCode::MissingArgument,
                COMMAND_ADD,
            )
            .with_argument("--ttl")
            .with_hint("For example --ttl 30d, or --ttl never."),
        ));
    }
    if parsed.flags.value("scope").is_some() && parsed.flags.value("allow").is_some() {
        return Err(Box::new(
            usage(
                "Pass --scope or --allow, not both.",
                ErrorCode::BadArgument,
                COMMAND_ADD,
            )
            .with_argument("--allow"),
        ));
    }
    let ttl = grant_lifetime_ms(parsed.flags.value("ttl").unwrap_or("1h"), COMMAND_ADD)?;
    let allow = list_flag(parsed, "allow");
    if let Some(scopes) = &allow {
        if scopes.is_empty() {
            return Err(Box::new(schema_error(
                "Too small: expected array to have >=1 items",
                COMMAND_ADD,
            )));
        }
        if !scopes
            .iter()
            .all(|scope| OUTSIDE_SCOPES.contains(&scope.as_str()))
        {
            return Err(Box::new(schema_error(
                format!(
                    "Invalid option: expected one of {}.",
                    OUTSIDE_SCOPES
                        .iter()
                        .map(|scope| format!("\"{scope}\""))
                        .collect::<Vec<_>>()
                        .join("|"),
                ),
                COMMAND_ADD,
            )));
        }
    }
    if ttl.is_some_and(|ttl| ttl > 366 * 86_400_000) {
        return Err(Box::new(schema_error(
            "Too big: expected number to be <=31622400000",
            COMMAND_ADD,
        )));
    }
    let projects = list_flag(parsed, "project");
    if projects.as_ref().is_some_and(Vec::is_empty) {
        return Err(Box::new(schema_error(
            "Too small: expected array to have >=1 items",
            COMMAND_ADD,
        )));
    }
    if let Some(name) = parsed.flags.value("name") {
        if name.is_empty() {
            return Err(Box::new(schema_error(
                "Too small: expected string to have >=1 characters",
                COMMAND_ADD,
            )));
        }
        if name.encode_utf16().count() > 256 {
            return Err(Box::new(schema_error(
                "Too big: expected string to have <=256 characters",
                COMMAND_ADD,
            )));
        }
    }
    Ok(McpEnrollOperation {
        op: "mcp.enroll",
        scope: parsed.flags.value("scope").map(str::to_owned),
        allow,
        ttl_ms: ttl,
        projects,
        name: parsed.flags.value("name").map(str::to_owned),
    })
}

pub fn add<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    // The session opens first: a missing daemon refuses before the arguments are checked.
    let mut conn = match super::session::connect(&parsed.flags, COMMAND_ADD) {
        Ok(conn) => conn,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let validated = enroll_validated(parsed);
    let operation = match validated {
        Ok(operation) => operation,
        Err(failure) => {
            conn.close();
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    let reply = match super::session::cli_send(&mut conn, COMMAND_ADD, &operation) {
        Ok(reply) => reply,
        Err(failure) => {
            conn.close();
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    conn.close();
    if is_daemon_refusal(&reply) {
        return crate::run::fail(
            out,
            err,
            Some(&parsed.flags),
            &daemon_refused(&reply, COMMAND_ADD),
        );
    }
    let data = reply
        .get("result")
        .and_then(|result| result.get("data"))
        .cloned()
        .unwrap_or(Value::Null);
    let id = data
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let human = mcp_added_lines(&data);
    let quiet = [id];
    answer_shaped(
        out,
        err,
        &parsed.flags,
        &data,
        reply.data_raw(),
        &human,
        &quiet,
    )
}

pub fn revoke<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let id = parsed.words.first().copied().unwrap_or("");
    // The session opens first: a missing daemon refuses before the argument is checked.
    let mut conn = match super::session::connect(&parsed.flags, COMMAND_REVOKE) {
        Ok(conn) => conn,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    if id.is_empty() {
        conn.close();
        return crate::run::fail(
            out,
            err,
            Some(&parsed.flags),
            &schema_error(
                "Too small: expected string to have >=1 characters",
                COMMAND_REVOKE,
            ),
        );
    }
    if id.encode_utf16().count() > 128 {
        conn.close();
        return crate::run::fail(
            out,
            err,
            Some(&parsed.flags),
            &schema_error(
                "Too big: expected string to have <=128 characters",
                COMMAND_REVOKE,
            ),
        );
    }
    let reply = match super::session::cli_send(
        &mut conn,
        COMMAND_REVOKE,
        &McpRevokeOperation {
            op: "mcp.revoke",
            id,
        },
    ) {
        Ok(reply) => reply,
        Err(failure) => {
            conn.close();
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    conn.close();
    if is_daemon_refusal(&reply) {
        let code = reply
            .get("result")
            .and_then(|result| result.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("refused");
        if code == "not_found" {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &Failure::new(
                    Outcome::Refused,
                    format!("No grant {id}: it ended or was revoked."),
                )
                .with_code(ErrorCode::NotFound)
                .with_hint("See the grants with ace mcp list.")
                .with_command(COMMAND_REVOKE),
            );
        }
        return crate::run::fail(
            out,
            err,
            Some(&parsed.flags),
            &daemon_refused(&reply, COMMAND_REVOKE),
        );
    }
    let data = reply
        .get("result")
        .and_then(|result| result.get("data"))
        .cloned()
        .unwrap_or(Value::Null);
    let human = [format!("Revoked {id}.")];
    let quiet: &[String] = &[];
    answer_shaped(
        out,
        err,
        &parsed.flags,
        &data,
        reply.data_raw(),
        &human,
        quiet,
    )
}
