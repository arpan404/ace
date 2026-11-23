// SPDX-License-Identifier: Apache-2.0
//! Which `marketplace.request` each ported `ace store` command sends: one command, one
//! operation, built from the command line. Pure.

use cli_out::{ErrorCode, Failure};
use cli_parse::Parsed;

const ENTRY_TYPES: &str = "suit, spade-skill, spade-plugin, spade-bot, ace-plugin";
const REPORT_REASONS: &[&str] = &[
    "malware",
    "impersonation",
    "spam",
    "copyright",
    "harmful",
    "other",
];

/// A usage error naming the argument and the next step.
fn usage(
    message: String,
    argument: &str,
    hint: Option<&str>,
    command: &'static str,
) -> Failure<'static> {
    let mut failure = Failure::usage(message)
        .with_code(ErrorCode::BadArgument)
        .with_argument(argument.to_owned())
        .with_command(command);
    if let Some(hint) = hint {
        failure = failure.with_hint(hint.to_owned());
    }
    failure
}

fn missing_argument(
    message: &str,
    argument: &str,
    hint: &str,
    command: &'static str,
) -> Failure<'static> {
    Failure::usage(message.to_owned())
        .with_code(ErrorCode::MissingArgument)
        .with_argument(argument.to_owned())
        .with_hint(hint.to_owned())
        .with_command(command)
}

fn is_market_type(value: &str) -> bool {
    matches!(
        value,
        "suit" | "spade-skill" | "spade-plugin" | "spade-bot" | "ace-plugin"
    )
}

fn is_entry_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    if !bytes[bytes.len() - 1].is_ascii_lowercase() && !bytes[bytes.len() - 1].is_ascii_digit() {
        return false;
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
    {
        return false;
    }
    !value.contains("..") && !value.contains("--")
}

fn is_version(value: &str) -> bool {
    if value.len() > 64 {
        return false;
    }
    let mut parts = value.splitn(2, '-');
    let numbers = parts.next().unwrap_or("");
    let mut dots = numbers.split('.');
    for _ in 0..3 {
        let Some(part) = dots.next() else {
            return false;
        };
        if part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    if dots.next().is_some() {
        return false;
    }
    match parts.next() {
        None => true,
        Some(pre) => {
            !pre.is_empty()
                && pre.len() <= 40
                && pre
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        }
    }
}

fn is_source_id(value: &str) -> bool {
    if value == "market" {
        return true;
    }
    if let Some(id) = value.strip_prefix("git:") {
        return (1..=32).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    }
    false
}

fn is_publisher_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 32 || value.contains("--") {
        return false;
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    if !bytes[bytes.len() - 1].is_ascii_lowercase() && !bytes[bytes.len() - 1].is_ascii_digit() {
        return false;
    }
    value
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

struct EntryRef {
    entry_type: String,
    name: String,
    version: Option<String>,
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn parse_entry_ref(word: &str, command: &'static str) -> Result<EntryRef, Failure<'static>> {
    if let Some(handle) = word.strip_prefix('@') {
        if !is_publisher_name(handle) {
            return Err(usage(
                format!("{word} isn't a publisher's handle."),
                "REF",
                Some("A handle is lowercase letters, digits and single hyphens: @arpan."),
                command,
            ));
        }
        return Err(usage(
            format!("{word} is a publisher; name one of their entries."),
            "REF",
            Some("As TYPE/NAME: suit/dusk-harbor."),
            command,
        ));
    }
    if word.matches('/').count() != 1 {
        return Err(usage(
            format!("{word} isn't a market entry."),
            "REF",
            Some("Name it as TYPE/NAME or TYPE/NAME@VERSION: suit/dusk-harbor@1.2.0."),
            command,
        ));
    }
    let slash = word.find('/').unwrap_or(0);
    let entry_type = word.get(..slash).unwrap_or("");
    let rest = word.get(slash + 1..).unwrap_or("");
    let (name, version) = match rest.find('@') {
        Some(at) => (
            rest.get(..at).unwrap_or(""),
            Some(rest.get(at + 1..).unwrap_or("").to_owned()),
        ),
        None => (rest, None),
    };
    if entry_type.is_empty()
        || !entry_type
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b == b'-')
    {
        return Err(usage(
            format!("{word} isn't a market entry."),
            "REF",
            Some("Name it as TYPE/NAME or TYPE/NAME@VERSION: suit/dusk-harbor@1.2.0."),
            command,
        ));
    }
    if !is_market_type(entry_type) {
        return Err(usage(
            format!("{entry_type} isn't a market type."),
            "REF",
            Some(&format!("Types: {ENTRY_TYPES}.")),
            command,
        ));
    }
    if !is_entry_name(name) {
        return Err(usage(
            format!("{name} isn't an entry name."),
            "REF",
            Some("Names are lowercase letters, digits and hyphens."),
            command,
        ));
    }
    if let Some(version) = &version
        && !is_version(version)
    {
        return Err(usage(
            format!("{version} isn't a version."),
            "REF",
            Some("A version is dotted numbers: 1.2.0."),
            command,
        ));
    }
    Ok(EntryRef {
        entry_type: entry_type.to_owned(),
        name: name.to_owned(),
        version,
    })
}

/// An entry, never a publisher; missing without a word at all.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn parse_entry(word: Option<&str>, command: &'static str) -> Result<EntryRef, Failure<'static>> {
    match word {
        None => Err(missing_argument(
            "Name the entry.",
            "REF",
            "As TYPE/NAME: suit/dusk-harbor.",
            command,
        )),
        Some(word) => parse_entry_ref(word, command),
    }
}

/// One version: `TYPE/NAME@VERSION`, or `--version` beside `TYPE/NAME`.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn parse_versioned(
    word: Option<&str>,
    version: Option<&str>,
    command: &'static str,
) -> Result<(EntryRef, String), Failure<'static>> {
    let entry = parse_entry(word, command)?;
    let chosen = entry.version.clone().or_else(|| version.map(str::to_owned));
    match chosen {
        None => Err(missing_argument(
            "Name the version.",
            "REF",
            &format!("As {}/{}@1.2.0.", entry.entry_type, entry.name),
            command,
        )),
        Some(chosen) => {
            if !is_version(&chosen) {
                return Err(usage(
                    format!("{chosen} isn't a version."),
                    "REF",
                    Some("Like 1.2.0."),
                    command,
                ));
            }
            Ok((entry, chosen))
        }
    }
}

/// A source id: `market` or `git:ID`.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn parse_source(
    value: Option<&str>,
    argument: &str,
    command: &'static str,
) -> Result<String, Failure<'static>> {
    match value {
        Some(value) if is_source_id(value) => Ok(value.to_owned()),
        _ => Err(usage(
            format!("{} isn't a source.", value.unwrap_or("That")),
            argument,
            Some("A source is market or git:ID; see them with ace store source list."),
            command,
        )),
    }
}

fn entry_json(entry: &EntryRef) -> serde_json::Value {
    serde_json::json!({"type": entry.entry_type, "name": entry.name})
}

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
    if let Some(limit) = flag("limit") {
        operation.insert("limit".to_owned(), search_limit(limit, command)?.into());
    } else {
        operation.insert("limit".to_owned(), 50.into());
    }
    operation.insert("offset".to_owned(), 0.into());
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
    let mut operation = entry_json(entry);
    if let Some(object) = operation.as_object_mut() {
        object.insert("op".to_owned(), op.into());
    }
    operation
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
    let mut operation = entry_json(&entry);
    if let Some(object) = operation.as_object_mut() {
        object.insert("op".to_owned(), "report".into());
        if let Some(version) = entry.version {
            object.insert("version".to_owned(), version.into());
        }
        object.insert("reason".to_owned(), reason.into());
        object.insert(
            "note".to_owned(),
            parsed.flags.value("note").unwrap_or("").to_owned().into(),
        );
    }
    Ok(operation)
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
