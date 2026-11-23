// SPDX-License-Identifier: Apache-2.0
//! How the CLI names market things (ADR 0178 §11): an entry is `TYPE/NAME`, one version of it
//! `TYPE/NAME@VERSION`, and a publisher `@handle`. Pure.

use cli_out::{ErrorCode, Failure};

pub(crate) const ENTRY_TYPES: &str = "suit, spade-skill, spade-plugin, spade-bot, ace-plugin";
pub(crate) const REPORT_REASONS: &[&str] = &[
    "malware",
    "harmful",
    "impersonation",
    "spam",
    "copyright",
    "other",
];

/// A usage error naming the argument and the next step.
pub(crate) fn usage(
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

pub(crate) fn missing_argument(
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

pub(crate) fn is_market_type(value: &str) -> bool {
    matches!(
        value,
        "suit" | "spade-skill" | "spade-plugin" | "spade-bot" | "ace-plugin"
    )
}

pub(crate) fn is_entry_name(value: &str) -> bool {
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

pub(crate) fn is_version(value: &str) -> bool {
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

pub(crate) fn is_source_id(value: &str) -> bool {
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

pub(crate) fn is_publisher_name(value: &str) -> bool {
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

pub(crate) struct EntryRef {
    pub(crate) entry_type: String,
    pub(crate) name: String,
    pub(crate) version: Option<String>,
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(crate) fn parse_entry_ref(
    word: &str,
    command: &'static str,
) -> Result<EntryRef, Failure<'static>> {
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
pub(crate) fn parse_entry(
    word: Option<&str>,
    command: &'static str,
) -> Result<EntryRef, Failure<'static>> {
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
pub(crate) fn parse_versioned(
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
pub(crate) fn parse_source(
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
