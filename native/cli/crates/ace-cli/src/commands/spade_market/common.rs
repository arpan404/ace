// SPDX-License-Identifier: Apache-2.0
//! Shared shell for the Store/Spade port: person rules, threads, keys and Spade calls.

use std::io::Write;
use std::time::Duration;

use cli_out::{ErrorCode, Failure, Flags, Out, Outcome, env_on};
use cli_parse::Parsed;
use cli_wire::Connection;
use serde::Deserialize;

/// An agent's shell: ace starts every agent session with `ACE_THREAD_ID` and `ACE_NO_INPUT`.
#[must_use]
pub fn agent_shell() -> bool {
    let thread = std::env::var("ACE_THREAD_ID").unwrap_or_default();
    if !thread.trim().is_empty() {
        return true;
    }
    env_on(std::env::var("ACE_NO_INPUT").ok().as_deref())
}

/// The thread an agent's own shell runs in, unless the command named one.
#[must_use]
pub fn ace_thread_id() -> Option<String> {
    let thread = std::env::var("ACE_THREAD_ID").unwrap_or_default();
    let trimmed = thread.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// The thread a market request names: `--thread`, or the agent shell's own.
#[must_use]
pub fn own_thread(parsed: &Parsed<'_>) -> Option<String> {
    if let Some(named) = parsed.flags.value("thread") {
        return Some(named.to_owned());
    }
    ace_thread_id()
}

/// A market command that is the person's (the hidden maintainer tools aside).
#[must_use]
pub fn market_person_only(command_id: &str) -> bool {
    command_id.starts_with("market.")
        && !command_id.starts_with("market.maintainer.")
        && !AGENT_MARKET_COMMANDS.contains(&command_id)
}

/// The market commands an agent may run itself (the daemon's allowlist).
const AGENT_MARKET_COMMANDS: &[&str] = &[
    "market.discover",
    "market.search",
    "market.show",
    "market.installed",
    "market.check",
    "market.publish",
    "market.draft.list",
    "market.draft.show",
    "market.draft.update",
    "market.draft.publish",
    "market.draft.delete",
    "market.status",
    "market.versions",
    "market.signals",
    "market.profile.show",
    "market.verification.show",
    "market.source.list",
    "market.source.refresh",
];

/// Whether the daemon lets an agent run `operation` itself (`askBeforePublish` is on here).
#[must_use]
pub fn agent_may_run(op: &str, action: Option<&str>) -> bool {
    if op != "publish" {
        return AGENT_OPERATIONS.contains(&op);
    }
    action.is_some_and(|action| action != "draftPublish" && AGENT_PUBLISH_ACTIONS.contains(&action))
}

const AGENT_OPERATIONS: &[&str] = &[
    "sources",
    "search",
    "home",
    "read",
    "look",
    "prepare",
    "prepareUpdate",
    "readReview",
    "cancel",
    "installed",
    "refresh",
    "spadeSkills",
    "spadeSkillFiles",
    "spadeBot",
    "discover",
    "publisher",
    "picture",
    "publishables",
    "botRecipe",
    "privacyCheck",
];

const AGENT_PUBLISH_ACTIONS: &[&str] = &[
    "me",
    "entry",
    "signals",
    "verification",
    "draftCreate",
    "draftCheck",
    "draftRead",
    "draftUpdate",
    "draftDelete",
    "draftPublish",
];

/// Why a person-only Store action can't run in an agent's shell.
#[must_use]
pub fn market_refusal(command: &'static str) -> Failure<'static> {
    Failure::new(
        Outcome::NeedsHuman,
        "This Store action is yours to do, not an agent's.",
    )
    .with_code(ErrorCode::PersonOnly)
    .with_hint(
        "Agents never answer requests or change settings. Ask the person: they do it in the app, on a paired device or in their own terminal.",
    )
    .with_command(command)
}

/// Why a person-only setting change can't run in an agent's shell.
#[must_use]
pub fn setting_refusal(command: &'static str) -> Failure<'static> {
    Failure::new(
        Outcome::NeedsHuman,
        "Changing a setting is yours to do, not an agent's.",
    )
    .with_code(ErrorCode::PersonOnly)
    .with_hint(
        "Agents never answer requests or change settings. Ask the person: they do it in the app, on a paired device or in their own terminal.",
    )
    .with_command(command)
}

/// `--idempotency-key`, or a fresh random one; a mutation retried with it runs once.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub fn idempotency_key(flags: &Flags<'_>) -> Result<String, Failure<'static>> {
    if let Some(value) = flags.value("idempotency-key") {
        if (1..=128).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        {
            return Ok(value.to_owned());
        }
        return Err(Failure::usage(
            "--idempotency-key takes 1 to 128 letters, digits, dots, underscores or hyphens.",
        )
        .with_code(ErrorCode::BadArgument)
        .with_argument("--idempotency-key"));
    }
    Ok(uuid::Uuid::new_v4().simple().to_string())
}

/// Now, in milliseconds since the Unix epoch.
#[must_use]
pub fn current_millis() -> i64 {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    i64::try_from(millis).unwrap_or(0)
}

/// A write that failed after a mutation was admitted: retry with the same key.
#[must_use]
pub fn uncertain_write(command: &'static str, key: &str) -> Failure<'static> {
    let mut failure = Failure::new(
        Outcome::Uncertain,
        "ace took it, but the answer couldn't be printed.",
    )
    .with_code(ErrorCode::Uncertain)
    .with_command(command);
    failure.retry = Some(cli_out::Retry {
        idempotency_key: std::borrow::Cow::Owned(key.to_owned()),
    });
    failure
}

pub fn write_failed<W: Write, E: Write>(
    command: &'static str,
    error: &cli_out::WriteError,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    crate::run::fail(
        out,
        err,
        None,
        &Failure::new(
            Outcome::Failed,
            format!("ace couldn't write its output: {error}"),
        )
        .with_code(ErrorCode::Internal)
        .with_command(command),
    )
}

#[derive(serde::Serialize)]
struct SpadeHttpFrame<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    method: &'a str,
    path: &'a str,
    encoding: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<&'a str>,
}

#[derive(Deserialize)]
struct SpadeResultEnvelope<'a> {
    #[serde(borrow)]
    result: SpadeResult<'a>,
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum SpadeResult<'a> {
    #[serde(rename = "response")]
    Response {
        status: u16,
        #[serde(borrow, default)]
        body: &'a str,
        #[serde(default)]
        parts: Option<u64>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(borrow, default)]
        code: &'a str,
        #[serde(borrow, default)]
        message: &'a str,
    },
}

/// One Spade API call through the daemon's `spade.http`, answering with status and body.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub fn spade_call(
    conn: &mut Connection,
    timeout: Duration,
    method: &str,
    path: &str,
    body: Option<&str>,
    command: &'static str,
) -> Result<(u16, String), Failure<'static>> {
    let frame = SpadeHttpFrame {
        msg_type: "spade.http",
        method,
        path,
        encoding: "text",
        body,
    };
    let reply = conn
        .request_expecting(&frame, &["spade.http.result"], timeout)
        .map_err(|err| crate::commands::work::common::wire_failure(&err, Some(command)))?;
    let envelope: SpadeResultEnvelope<'_> = reply.decode().map_err(|_| spade_mangled(command))?;
    match envelope.result {
        SpadeResult::Response {
            status,
            body,
            parts,
        } => {
            if parts.is_some_and(|parts| parts > 1) {
                return Err(spade_mangled(command));
            }
            if !(100..=599).contains(&status) {
                return Err(spade_mangled(command));
            }
            if (200..=299).contains(&status) {
                return Ok((status, body.to_owned()));
            }
            Err(answer_failure(status, body, command))
        }
        SpadeResult::Error { code, message } => Err(spade_failure(code, message, command)),
    }
}

fn spade_mangled(command: &'static str) -> Failure<'static> {
    Failure::new(Outcome::Uncertain, "Spade's answer couldn't be read.")
        .with_code(ErrorCode::Uncertain)
        .with_command(command)
}

/// Why the daemon didn't forward a request, as one sentence and the next step.
pub fn spade_failure(code: &str, message: &str, command: &'static str) -> Failure<'static> {
    match code {
        "hidden" => Failure::new(
            Outcome::Refused,
            "Spade is hidden: Settings › Beta has it off.",
        )
        .with_code(ErrorCode::TurnedOff)
        .with_hint("Turn it on with ace spade on.")
        .with_command(command),
        "unavailable" => Failure::new(Outcome::Refused, "Spade isn't running.")
            .with_code(ErrorCode::Refused)
            .with_hint("See why with ace spade status.")
            .with_command(command),
        "forbidden" => Failure::new(Outcome::Refused, "This device may not talk to Spade.")
            .with_code(ErrorCode::Forbidden)
            .with_command(command),
        _ => Failure::new(Outcome::Failed, format!("Spade didn't answer: {message}"))
            .with_code(ErrorCode::Failed)
            .with_hint("See how Spade is with ace spade status.")
            .with_command(command),
    }
}

/// A non-2xx answer as the failure the CLI reports.
fn answer_failure(status: u16, body: &str, command: &'static str) -> Failure<'static> {
    let said = quoted_field(body, "error").or_else(|| quoted_field(body, "message"));
    let message = said.map_or_else(
        || format!("Spade answered {status}."),
        |said| format!("Spade said: {said}"),
    );
    if status == 404 {
        Failure::new(Outcome::Refused, message)
            .with_code(ErrorCode::NotFound)
            .with_command(command)
    } else {
        Failure::new(Outcome::Failed, message)
            .with_code(ErrorCode::Failed)
            .with_command(command)
    }
}

/// The first `"name": "value"` (up to 300 chars) in a JSON body, without escape handling.
fn quoted_field<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    for (index, _) in body.match_indices('"') {
        let rest = body.get(index + 1..)?;
        let key = rest.split('"').next()?;
        if key != name {
            continue;
        }
        let after = rest.get(key.len() + 1..)?.trim_start();
        let value = after.strip_prefix(':')?.trim_start().strip_prefix('"')?;
        let end = value.find('"')?;
        if end == 0 || end > 300 {
            continue;
        }
        return value.get(..end);
    }
    None
}
