// SPDX-License-Identifier: Apache-2.0
//! The market's answers as a person reads them (ADR 0178 §3, §11, §12). Pure.

pub(crate) fn entry_ref(entry: &serde_json::Value) -> String {
    let entry_type = entry
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let name = entry
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    format!("{entry_type}/{name}")
}

fn day_text(at: i64) -> String {
    chrono::DateTime::from_timestamp_millis(at)
        .map(|date| date.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// One row: `suit/dusk-harbor 1.2.0  Dusk Harbor: A calm dark look. @arpan, reviewed`.
pub fn entry_row(entry: &serde_json::Value) -> String {
    let version = entry
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map_or_else(String::new, |version| format!(" {version}"));
    let title = entry
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let line = entry
        .get("line")
        .and_then(serde_json::Value::as_str)
        .map_or_else(String::new, |line| format!(": {line}"));
    let mut marks: Vec<String> = Vec::new();
    if let Some(publisher) = entry.get("publisher") {
        let name = publisher
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let verified = entry.get("verified").and_then(serde_json::Value::as_bool) == Some(true);
        marks.push(format!(
            "@{name}{}",
            if verified { " (verified)" } else { "" }
        ));
    } else if let Some(from) = entry.get("from").and_then(serde_json::Value::as_str) {
        marks.push(from.to_owned());
    }
    if entry.get("byAce").and_then(serde_json::Value::as_bool) == Some(true) {
        marks.push("by ace".to_owned());
    } else if entry.get("reviewed").and_then(serde_json::Value::as_bool) == Some(true) {
        marks.push("reviewed".to_owned());
    }
    if entry
        .get("deprecated")
        .and_then(serde_json::Value::as_str)
        .is_some()
    {
        marks.push("deprecated".to_owned());
    }
    if entry.get("supported").and_then(serde_json::Value::as_bool) != Some(true) {
        marks.push("not installable here".to_owned());
    }
    let marks = if marks.is_empty() {
        String::new()
    } else {
        format!(" ({})", marks.join(", "))
    };
    format!("{}{version}  {title}{line}{marks}", entry_ref(entry))
}

pub fn search_lines(value: &serde_json::Value) -> Vec<String> {
    let empty = Vec::new();
    let entries = value
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    if entries.is_empty() {
        return vec!["Nothing in the market matches.".to_owned()];
    }
    let total = value
        .get("total")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let mut lines: Vec<String> = entries.iter().map(entry_row).collect();
    if total > entries.len() as u64 {
        lines.push(format!(
            "{} more; narrow it with --type or --category.",
            total - entries.len() as u64
        ));
    }
    lines
}

pub fn entry_lines(entry: &serde_json::Value) -> Vec<String> {
    let summary = entry.get("summary").cloned().unwrap_or_default();
    let mut lines = vec![entry_row(&summary)];
    if let Some(description) = entry.get("description").and_then(serde_json::Value::as_str) {
        let trimmed = description.trim();
        if !trimmed.is_empty() {
            lines.push(String::new());
            lines.push(trimmed.to_owned());
            lines.push(String::new());
        }
    }
    if let Some(installed) = entry.get("installed") {
        let version = installed
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let state = installed
            .get("state")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        lines.push(format!("Installed: {version} ({state})."));
    }
    let empty = Vec::new();
    let versions = entry
        .get("versions")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    for version in versions.iter().take(10) {
        let number = version
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let published = version
            .get("published")
            .and_then(serde_json::Value::as_i64)
            .map_or_else(String::new, |at| format!("  {}", day_text(at)));
        let mut notes = Vec::new();
        if let Some(withdrawn) = version.get("withdrawn").and_then(serde_json::Value::as_str) {
            notes.push(format!("withdrawn: {withdrawn}"));
        }
        if let Some(deprecated) = version
            .get("deprecated")
            .and_then(serde_json::Value::as_str)
        {
            notes.push(format!("deprecated: {deprecated}"));
        }
        let notes = if notes.is_empty() {
            String::new()
        } else {
            format!("  {}", notes.join("; "))
        };
        let changelog = version
            .get("changelog")
            .and_then(serde_json::Value::as_str)
            .map_or_else(String::new, |changelog| {
                format!("  {}", changelog.split('\n').next().unwrap_or(""))
            });
        lines.push(format!("  {number}{published}{notes}{changelog}"));
    }
    if versions.len() > 10 {
        lines.push(format!("  and {} older.", versions.len() - 10));
    }
    lines.push(format!(
        "Install it with ace store install {}.",
        entry_ref(&summary)
    ));
    lines
}

pub fn publisher_lines(page: &serde_json::Value) -> Vec<String> {
    let profile = page.get("profile").cloned().unwrap_or_default();
    let handle = profile
        .get("handle")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let display = profile
        .get("displayName")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let verified = profile
        .get("verified")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let official = page
        .get("official")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let mut lines = vec![format!(
        "@{handle}: {display}{}{}",
        if verified { ", verified" } else { "" },
        if official { ", ace's own" } else { "" }
    )];
    if let Some(bio) = profile.get("bio").and_then(serde_json::Value::as_str)
        && !bio.is_empty()
    {
        lines.push(bio.to_owned());
    }
    let empty = Vec::new();
    let entries = page
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    let downloads = page
        .get("downloads")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let joined = page
        .get("profile")
        .and_then(|profile| profile.get("joined"))
        .and_then(serde_json::Value::as_i64)
        .map_or_else(String::new, day_text);
    lines.push(format!(
        "{} entries, {downloads} downloads, joined {joined}.",
        entries.len()
    ));
    lines.extend(entries.iter().map(entry_row));
    lines
}

pub fn installed_row(entry: &serde_json::Value) -> String {
    let state = entry
        .get("state")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let state = if state == "on" {
        None
    } else {
        let reason = entry
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .map_or_else(String::new, |reason| format!(": {reason}"));
        Some(format!("{state}{reason}"))
    };
    let mut notes: Vec<String> = Vec::new();
    if let Some(state) = state {
        notes.push(state);
    }
    if let Some(update) = entry.get("update").and_then(serde_json::Value::as_str) {
        notes.push(format!("update {update}"));
    }
    if let Some(deprecated) = entry.get("deprecated").and_then(serde_json::Value::as_str) {
        notes.push(format!("deprecated: {deprecated}"));
    }
    let version = entry
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let title = entry
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let notes = if notes.is_empty() {
        String::new()
    } else {
        format!(" ({})", notes.join("; "))
    };
    format!("{} {version}  {title}{notes}", entry_ref(entry))
}

pub fn installed_lines(installed: &[serde_json::Value]) -> Vec<String> {
    if installed.is_empty() {
        return vec!["Nothing is installed from the Store.".to_owned()];
    }
    installed.iter().map(installed_row).collect()
}

pub fn source_lines(sources: &[serde_json::Value]) -> Vec<String> {
    sources
        .iter()
        .map(|source| {
            let id = source
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let address = source
                .get("address")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let enabled = source
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let entries = source
                .get("entries")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let read = source
                .get("readAt")
                .and_then(serde_json::Value::as_i64)
                .map_or_else(String::new, |at| format!(", read {}", day_text(at)));
            let problem = source
                .get("problem")
                .and_then(serde_json::Value::as_str)
                .map_or_else(String::new, |problem| {
                    format!(". Last read failed: {problem}")
                });
            format!(
                "{id}  {address}  {}, {entries} entries{read}{problem}",
                if enabled { "on" } else { "off" }
            )
        })
        .collect()
}

pub fn discover_lines(discover: &serde_json::Value) -> Vec<String> {
    let empty = Vec::new();
    let featured = discover
        .get("featured")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    let trending = discover
        .get("trending")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    let fresh = discover
        .get("fresh")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    let mut lines = Vec::new();
    if !featured.is_empty() {
        lines.push("Featured".to_owned());
        lines.extend(
            featured
                .iter()
                .take(8)
                .map(|entry| format!("  {}", entry_row(entry))),
        );
    }
    if !trending.is_empty() {
        lines.push("Trending".to_owned());
        lines.extend(trending.iter().take(5).map(|item| {
            format!(
                "  {}",
                entry_row(item.get("entry").unwrap_or(&serde_json::Value::Null))
            )
        }));
    }
    if !fresh.is_empty() {
        lines.push("New".to_owned());
        lines.extend(
            fresh
                .iter()
                .take(5)
                .map(|entry| format!("  {}", entry_row(entry))),
        );
    }
    if lines.is_empty() {
        lines.push("The Store has nothing to show yet.".to_owned());
    }
    lines.push(String::new());
    lines.push("  ace store search QUERY       find entries".to_owned());
    lines.push("  ace store show TYPE/NAME     an entry, its publisher and versions".to_owned());
    lines.push("  ace store install TYPE/NAME  read its review, then install".to_owned());
    lines.push("  ace store installed          what's installed, and updates".to_owned());
    lines.push("  ace help publishing          publishing your own".to_owned());
    lines
}

/// A scan finding in the publisher's words.
pub(crate) fn finding_sentence(finding: &serde_json::Value) -> String {
    let path = finding.get("path").and_then(serde_json::Value::as_str);
    let line = finding.get("line").and_then(serde_json::Value::as_u64);
    let message = finding
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match path {
        Some(path) => {
            let line = line.map_or_else(String::new, |line| format!(" line {line}"));
            format!("{path}{line}: {message}")
        }
        None => message.to_owned(),
    }
}
