// SPDX-License-Identifier: Apache-2.0
//! One log record as one line: when, level, component, message, then its data compactly.

use std::borrow::Cow;

use serde_json::value::RawValue;

/// One log record as the daemon writes it to `logs/ace.jsonl`.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct LogRecord<'a> {
    pub(crate) at: i64,
    #[serde(borrow)]
    pub(crate) level: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) component: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) message: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) data: Option<Cow<'a, RawValue>>,
}

/// One log record as one line: when, level, component, message, then its data compactly.
pub(crate) fn log_line(record: &LogRecord<'_>, color: bool) -> String {
    let level = format!("{:<5}", record.level);
    let shown = if color {
        match record.level.as_ref() {
            "debug" => format!("\u{1b}[2m{level}\u{1b}[0m"),
            "warn" => format!("\u{1b}[33m{level}\u{1b}[0m"),
            "error" => format!("\u{1b}[31m{level}\u{1b}[0m"),
            _ => level,
        }
    } else {
        level
    };
    let data = record.data.as_deref().map_or_else(String::new, |data| {
        // A JSON null reads as no data, as in the TypeScript it mirrors.
        if data.get() == "null" {
            return String::new();
        }
        let text = compact_data(data);
        if text.is_empty() {
            String::new()
        } else {
            format!("  {text}")
        }
    });
    format!(
        "{} {shown} {}  {}{data}",
        clock(record.at),
        record.component,
        record.message
    )
}

/// When the record happened, in this machine's time: `2026-11-23 09:41:07`.
fn clock(at: i64) -> String {
    use chrono::TimeZone as _;
    chrono::Local.timestamp_millis_opt(at).single().map_or_else(
        || at.to_string(),
        |time| time.format("%Y-%m-%d %H:%M:%S").to_string(),
    )
}

/// A record's data on one line: a string as it is, anything else compactly.
fn compact_data(data: &RawValue) -> String {
    let text = data.get();
    let flat = if text.starts_with('"') {
        serde_json::from_str::<String>(text).unwrap_or_default()
    } else {
        text.to_owned()
    };
    // `/\s+/g` to one space, ends kept, like the TypeScript it mirrors.
    let mut collapsed = String::with_capacity(flat.len());
    let mut was_space = false;
    for c in flat.chars() {
        if c.is_whitespace() {
            if !was_space {
                collapsed.push(' ');
            }
            was_space = true;
        } else {
            collapsed.push(c);
            was_space = false;
        }
    }
    if collapsed.encode_utf16().count() > 400 {
        let mut taken = 0;
        let mut end = 0;
        for (index, c) in collapsed.char_indices() {
            let width = c.len_utf16();
            if taken + width > 399 {
                break;
            }
            taken += width;
            end = index + c.len_utf8();
        }
        format!("{}…", &collapsed[..end])
    } else {
        collapsed
    }
}
