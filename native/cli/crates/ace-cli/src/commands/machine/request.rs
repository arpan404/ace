// SPDX-License-Identifier: Apache-2.0
//! One blocking storage request: the connection, the protocol shapes, and printing one answer.
#![allow(
    clippy::result_large_err,
    reason = "the failure envelope is returned by value to its one printer; boxing would only add an allocation"
)]

use std::io::Write;

use cli_out::{Failure, Out, Outcome};
use cli_parse::Parsed;
use serde::Serialize;
use serde_json::value::RawValue;

use super::error;
use super::plan::PlanOperation;

/// Sends a `cleanup.plan` built from the command line.
pub(crate) fn plan_request(
    operation: &PlanOperation,
    timeout: std::time::Duration,
) -> Result<cli_wire::Reply, cli_wire::WireError> {
    request(
        &StorageOperation::Plan {
            kinds: operation.kinds(),
            retention: operation.retention_json(),
            force_items: operation.force_items(),
        },
        timeout,
    )
}

/// Opens one blocking connection to this machine's daemon for a single request.
fn connect(timeout: std::time::Duration) -> Result<cli_wire::Connection, cli_wire::WireError> {
    let home = cli_wire::Home::from_env()?;
    let local = cli_wire::reach_local(&home, &cli_wire::TcpProbe)?;
    let config = cli_wire::ConnectConfig {
        request_timeout: timeout,
        ..cli_wire::ConnectConfig::default()
    };
    cli_wire::Connection::open_local(&local, cli_wire::LocalIdentity::from_env(), &config)
}

/// Sends one `storage.request` and waits for its `storage.result`.
pub(crate) fn request(
    operation: &StorageOperation<'_>,
    timeout: std::time::Duration,
) -> Result<cli_wire::Reply, cli_wire::WireError> {
    let mut connection = connect(timeout)?;
    let reply = connection.request_with_timeout(
        &StorageRequest {
            msg_type: "storage.request",
            operation,
        },
        timeout,
    );
    connection.close();
    reply
}

#[derive(Serialize)]
struct StorageRequest<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    operation: &'a StorageOperation<'a>,
}

/// The daemon's storage operations, keys as the protocol names them.
#[derive(Serialize)]
#[serde(tag = "op")]
pub(crate) enum StorageOperation<'a> {
    #[serde(rename = "storage.usage")]
    Usage { force: bool },
    #[serde(rename = "cleanup.plan")]
    Plan {
        #[serde(skip_serializing_if = "Option::is_none")]
        kinds: Option<&'a [String]>,
        #[serde(skip_serializing_if = "Option::is_none")]
        retention: Option<serde_json::Value>,
        #[serde(rename = "forceItems")]
        force_items: &'a [String],
    },
    #[serde(rename = "cleanup.apply")]
    Apply {
        #[serde(rename = "planId")]
        plan_id: &'a str,
        revision: &'a str,
    },
    #[serde(rename = "cleanup.status")]
    Status {
        #[serde(rename = "planId")]
        plan_id: &'a str,
    },
    #[serde(rename = "cleanup.compact")]
    Compact,
    #[serde(rename = "cleanup.compactAbandon")]
    CompactAbandon {
        #[serde(rename = "compactionId")]
        compaction_id: &'a str,
    },
}

/// The result the daemon's `storage.result` carries, borrowing from the reply.
#[derive(serde::Deserialize)]
struct Payload<'a> {
    #[serde(borrow, default)]
    usage: Option<&'a RawValue>,
    #[serde(borrow, default)]
    plan: Option<&'a RawValue>,
    #[serde(borrow, default)]
    apply: Option<&'a RawValue>,
    #[serde(borrow, default)]
    compaction: Option<&'a RawValue>,
    #[serde(borrow, default)]
    code: Option<&'a str>,
    #[serde(borrow, default)]
    message: Option<&'a str>,
}

#[derive(serde::Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    result: Payload<'a>,
}

/// The payload for `kind`, or the daemon's refusal, or that it sent nothing usable.
pub(crate) fn payload<'a>(
    reply: &'a cli_wire::Reply,
    kind: &str,
    missing: &'static str,
    command: &'static str,
    evidence: Option<serde_json::Value>,
) -> Result<&'a RawValue, Failure<'static>> {
    let envelope: Envelope<'a> = serde_json::from_str(reply.as_str()).map_err(|_| {
        error::wire_failure(
            &cli_wire::WireError::Protocol {
                detail: "Daemon returned an unexpected storage result".into(),
            },
            command,
        )
    })?;
    if let Some(code) = envelope.result.code {
        return Err(storage_error(
            code,
            envelope.result.message.unwrap_or(""),
            evidence,
            command,
        ));
    }
    let found = match kind {
        "usage" => envelope.result.usage,
        "plan" => envelope.result.plan,
        "apply" => envelope.result.apply,
        "compaction" => envelope.result.compaction,
        _ => None,
    };
    found.map_or_else(
        || {
            Err(Failure::new(Outcome::Uncertain, missing)
                .with_code(cli_out::ErrorCode::Uncertain)
                .with_command(command))
        },
        Ok,
    )
}

/// Already-shaped daemon JSON into the fields a person reads, borrowing from the reply.
pub(crate) fn decode<'a, T: serde::Deserialize<'a>>(
    raw: &'a RawValue,
    command: &'static str,
) -> Result<T, Failure<'static>> {
    serde_json::from_str(raw.get()).map_err(|_| {
        error::wire_failure(
            &cli_wire::WireError::Protocol {
                detail: "Daemon returned an unexpected storage result".into(),
            },
            command,
        )
    })
}

/// A refused or failed request, as the retention commands report it.
pub(crate) fn storage_error(
    code: &str,
    message: &str,
    evidence: Option<serde_json::Value>,
    command: &'static str,
) -> Failure<'static> {
    let refused = matches!(code, "forbidden" | "not_found" | "invalid_request");
    let mut failure = Failure::new(
        if refused {
            Outcome::Refused
        } else {
            Outcome::Uncertain
        },
        if message.trim().is_empty() {
            "The daemon refused the request.".to_owned()
        } else {
            message.trim().to_owned()
        },
    )
    .with_command(command);
    match code {
        "not_found" => {
            failure = failure
                .with_code(cli_out::ErrorCode::NotFound)
                .with_hint("Plan a new cleanup with ace storage plan.");
        }
        "forbidden" => {
            failure = failure.with_code(cli_out::ErrorCode::Forbidden);
        }
        _ => {}
    }
    if let Some(evidence) = evidence {
        failure.admission = Some(evidence);
    }
    failure
}

/// A lost apply acknowledgement carries the plan identity so it can be read or retried.
pub(crate) fn apply_transport(
    error: &cli_wire::WireError,
    plan_id: &str,
    revision: &str,
    command: &'static str,
) -> Failure<'static> {
    if matches!(error, cli_wire::WireError::DaemonDown) {
        return error::wire_failure(error, command);
    }
    let mut failure = Failure::new(
        Outcome::Uncertain,
        "ace didn't confirm the cleanup, so it may or may not have run.",
    )
    .with_code(cli_out::ErrorCode::Uncertain)
    .with_hint(format!(
        "See where it stands with ace storage status {plan_id}, or apply the same plan and revision again."
    ))
    .with_command(command);
    failure.admission = Some(serde_json::json!({ "planId": plan_id, "revision": revision }));
    failure
}

/// One storage answer: human lines, already-shaped JSON, quiet identifiers, and its outcome.
pub(crate) struct Answer<'a> {
    pub(crate) human: &'a [String],
    pub(crate) json: &'a str,
    pub(crate) quiet: &'a [String],
    pub(crate) outcome: Outcome,
}

/// Prints one storage answer in the mode asked for; a result taken but unprintable is uncertain.
pub(crate) fn print_answer<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    command: &'static str,
    answer: &Answer<'_>,
) -> Outcome {
    let modes = cli_out::output_mode(&parsed.flags);
    let text = match modes {
        cli_out::OutputMode::Json => format!("{}\n", answer.json),
        cli_out::OutputMode::Human => {
            if answer.human.is_empty() {
                String::new()
            } else {
                format!("{}\n", answer.human.join("\n"))
            }
        }
        cli_out::OutputMode::Quiet => {
            if answer.quiet.is_empty() {
                String::new()
            } else {
                format!("{}\n", answer.quiet.join("\n"))
            }
        }
    };
    if out.write(&text).is_err() {
        let mut failure = Failure::new(Outcome::Uncertain, "The result couldn't be printed.")
            .with_code(cli_out::ErrorCode::Uncertain)
            .with_hint("Read where it stands with ace storage status PLAN.")
            .with_command(command);
        failure.admission = serde_json::from_str(answer.json).ok();
        return crate::run::fail(out, err, Some(&parsed.flags), &failure);
    }
    answer.outcome
}
