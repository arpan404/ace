// SPDX-License-Identifier: Apache-2.0
//! Which `marketplace.request` each ported `ace store` command sends: one command, one
//! operation, built from the command line. Pure.

use cli_out::{ErrorCode, Failure};
use cli_parse::Parsed;

use super::market_refs::{
    ENTRY_TYPES, EntryRef, REPORT_REASONS, is_market_type, is_publisher_name, parse_entry,
    parse_source, parse_versioned, usage,
};

/// The operation one ported market command sends.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub fn market_operation(parsed: &Parsed<'_>) -> Result<serde_json::Value, Failure<'static>> {
    let command: &'static str = parsed.command.id;
    let word = parsed.words.first().copied();
    match command {
        "market.discover" => Ok(serde_json::json!({"op": "discover"})),
        "market.search" => search_operation(parsed, command),
        "market.show" => show_operation(parsed, word, command),
        "market.installed" => Ok(serde_json::json!({"op": "installed"})),
        "market.source.list" => Ok(serde_json::json!({"op": "sources"})),
        "market.source.add" => {
            let address = word.unwrap_or("");
            Ok(serde_json::json!({"op": "addSource", "address": address}))
        }
        "market.source.remove" => {
            let id = parse_source(word, "SOURCE", command)?;
            Ok(serde_json::json!({"op": "removeSource", "id": id}))
        }
        "market.source.on" => {
            let id = parse_source(word, "SOURCE", command)?;
            Ok(serde_json::json!({"op": "setSource", "id": id, "enabled": true}))
        }
        "market.source.off" => {
            let id = parse_source(word, "SOURCE", command)?;
            Ok(serde_json::json!({"op": "setSource", "id": id, "enabled": false}))
        }
        "market.source.refresh" => match word {
            Some(id) => {
                let id = parse_source(Some(id), "SOURCE", command)?;
                Ok(serde_json::json!({"op": "refresh", "id": id}))
            }
            None => Ok(serde_json::json!({"op": "refresh"})),
        },
        "market.remove" => Ok(keyed_operation(&parse_entry(word, command)?, "remove")),
        "market.restore" => Ok(keyed_operation(&parse_entry(word, command)?, "turnOn")),
        "market.report" => report_operation(parsed, word, command),
        "market.withdraw" => withdraw_operation(parsed, word, command),
        "market.status" | "market.draft.list" | "market.profile.show" => {
            Ok(serde_json::json!({"op": "publish", "request": {"action": "me"}}))
        }
        "market.versions" => {
            let entry = parse_entry(word, command)?;
            Ok(serde_json::json!({
                "op": "publish",
                "request": {"action": "entry", "type": entry.entry_type, "name": entry.name},
            }))
        }
        "market.signals" => {
            let entry = parse_entry(word, command)?;
            Ok(serde_json::json!({
                "op": "publish",
                "request": {"action": "signals", "type": entry.entry_type, "name": entry.name},
            }))
        }
        "market.draft.show" => {
            let draft = draft_id(word, command)?;
            Ok(serde_json::json!({
                "op": "publish",
                "request": {"action": "draftRead", "id": draft},
            }))
        }
        "market.draft.delete" => {
            let draft = draft_id(word, command)?;
            Ok(serde_json::json!({
                "op": "publish",
                "request": {"action": "draftDelete", "id": draft},
            }))
        }
        "market.verification.show" => {
            Ok(serde_json::json!({"op": "publish", "request": {"action": "verification"}}))
        }
        "market.verification.check" => {
            Ok(serde_json::json!({"op": "publish", "request": {"action": "checkVerification"}}))
        }
        _ => Err(Failure::usage(format!("ace {command} is not yet native."))
            .with_code(ErrorCode::BadArgument)
            .with_command(command)),
    }
}

/// A draft id, named or the usage error asking for it.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn draft_id(word: Option<&str>, command: &'static str) -> Result<String, Failure<'static>> {
    match word {
        Some(draft) if !draft.is_empty() => Ok(draft.to_owned()),
        _ => Err(Failure::usage("Name the draft.")
            .with_code(ErrorCode::MissingArgument)
            .with_argument("--draft")
            .with_command(command)),
    }
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn search_operation(
    parsed: &Parsed<'_>,
    command: &'static str,
) -> Result<serde_json::Value, Failure<'static>> {
    let flag = |name: &str| parsed.flags.value(name);
    let mut operation = serde_json::Map::new();
    operation.insert("op".to_owned(), "search".into());
    operation.insert("query".to_owned(), parsed.words.join(" ").into());
    if let Some(entry_type) = flag("type") {
        if !is_market_type(entry_type) {
            return Err(usage(
                format!("{entry_type} isn't a market type."),
                "--type",
                Some(&format!("Types: {ENTRY_TYPES}.")),
                command,
            ));
        }
        operation.insert("type".to_owned(), entry_type.to_owned().into());
    }
    if let Some(category) = flag("category") {
        operation.insert("category".to_owned(), category.to_owned().into());
    }
    if let Some(source) = flag("source") {
        operation.insert(
            "source".to_owned(),
            parse_source(Some(source), "--source", command)?.into(),
        );
    }
    operation.insert("offset".to_owned(), 0.into());
    if let Some(limit) = flag("limit") {
        operation.insert("limit".to_owned(), search_limit(limit, command)?.into());
    } else {
        operation.insert("limit".to_owned(), 50.into());
    }
    Ok(serde_json::Value::Object(operation))
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn search_limit(limit: &str, command: &'static str) -> Result<u64, Failure<'static>> {
    let number: f64 = limit.trim().parse().unwrap_or(f64::NAN);
    if number.is_nan() || number.fract() != 0.0 || !(1.0..=100.0).contains(&number) {
        return Err(usage(
            format!("{limit} isn't a limit from 1 to 100."),
            "--limit",
            None,
            command,
        ));
    }
    Ok(limit_value(number))
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn show_operation(
    parsed: &Parsed<'_>,
    word: Option<&str>,
    command: &'static str,
) -> Result<serde_json::Value, Failure<'static>> {
    let reference = word.unwrap_or("");
    if let Some(handle) = reference.strip_prefix('@') {
        if !is_publisher_name(handle) {
            return Err(usage(
                format!("{reference} isn't a publisher's handle."),
                "REF",
                Some("A handle is lowercase letters, digits and single hyphens: @arpan."),
                command,
            ));
        }
        return Ok(serde_json::json!({"op": "publisher", "handle": handle}));
    }
    let entry = parse_entry(word, command)?;
    let source = parsed.flags.value("source");
    if source.is_some() {
        parse_source(source, "--source", command)?;
    }
    let mut operation = serde_json::Map::new();
    operation.insert("op".to_owned(), "read".into());
    operation.insert(
        "source".to_owned(),
        source
            .map_or_else(|| "market".to_owned(), str::to_owned)
            .into(),
    );
    operation.insert("type".to_owned(), entry.entry_type.into());
    operation.insert("name".to_owned(), entry.name.into());
    Ok(serde_json::Value::Object(operation))
}

fn keyed_operation(entry: &EntryRef, op: &str) -> serde_json::Value {
    let mut operation = serde_json::Map::new();
    operation.insert("op".to_owned(), op.into());
    operation.insert("type".to_owned(), entry.entry_type.clone().into());
    operation.insert("name".to_owned(), entry.name.clone().into());
    serde_json::Value::Object(operation)
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn report_operation(
    parsed: &Parsed<'_>,
    word: Option<&str>,
    command: &'static str,
) -> Result<serde_json::Value, Failure<'static>> {
    let entry = parse_entry(word, command)?;
    let reason = match parsed.flags.value("reason") {
        Some(reason) if REPORT_REASONS.contains(&reason) => reason.to_owned(),
        _ => {
            return Err(Failure::usage("Say what's wrong with --reason.")
                .with_code(ErrorCode::MissingArgument)
                .with_argument("--reason")
                .with_hint(format!("One of {}.", REPORT_REASONS.join(", ")))
                .with_command(command));
        }
    };
    let mut operation = serde_json::Map::new();
    operation.insert("op".to_owned(), "report".into());
    operation.insert("type".to_owned(), entry.entry_type.clone().into());
    operation.insert("name".to_owned(), entry.name.clone().into());
    if let Some(version) = entry.version {
        operation.insert("version".to_owned(), version.into());
    }
    operation.insert("reason".to_owned(), reason.into());
    operation.insert(
        "note".to_owned(),
        parsed.flags.value("note").unwrap_or("").to_owned().into(),
    );
    Ok(serde_json::Value::Object(operation))
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn withdraw_operation(
    parsed: &Parsed<'_>,
    word: Option<&str>,
    command: &'static str,
) -> Result<serde_json::Value, Failure<'static>> {
    let (entry, version) = parse_versioned(word, None, command)?;
    let reason = match parsed.flags.value("reason") {
        Some(reason) => reason.to_owned(),
        None => {
            return Err(Failure::usage("Name why it's withdrawn (reason).")
                .with_code(ErrorCode::MissingArgument)
                .with_argument("--reason")
                .with_command(command));
        }
    };
    Ok(serde_json::json!({
        "op": "publish",
        "request": {
            "action": "withdraw",
            "type": entry.entry_type,
            "name": entry.name,
            "version": version,
            "reason": reason,
        },
    }))
}

/// A validated 1..=100 limit as an integer.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "validated to an integer from 1 to 100 just above"
)]
fn limit_value(number: f64) -> u64 {
    number as u64
}

/// The verb the daemon's allowlist checks, for the person-only gate.
pub fn operation_verb(operation: &serde_json::Value) -> (String, Option<String>) {
    let op = operation
        .get("op")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    let action = operation
        .get("request")
        .and_then(|request| request.get("action"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    (op, action)
}
