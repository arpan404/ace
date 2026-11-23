// SPDX-License-Identifier: Apache-2.0
//! The market's answers as a person reads them (ADR 0178 §3, §11, §12). Pure.

fn entry_ref(entry: &serde_json::Value) -> String {
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
pub fn finding_sentence(finding: &serde_json::Value) -> String {
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

/// A publishing answer, in the publisher's words (ADR 0178 §12.2).
pub fn publish_lines(answer: &serde_json::Value) -> Vec<String> {
    match answer.get("kind").and_then(serde_json::Value::as_str) {
        Some("published") => published_lines(answer),
        Some("draft") => draft_lines(answer),
        Some("me") => me_lines(answer),
        Some("entry") => publish_entry_lines(answer),
        Some("pending") => pending_lines(answer),
        Some("profile") => profile_lines(answer),
        Some("checked") => checked_lines(answer),
        Some("signals") => signals_lines(answer),
        Some("verification") => verification_lines(answer),
        _ => vec!["Done.".to_owned()],
    }
}

fn published_lines(answer: &serde_json::Value) -> Vec<String> {
    let entry_type = answer
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let name = answer
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let version = answer
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    vec![
        format!("Published {entry_type}/{name} {version}."),
        if answer.get("held").and_then(serde_json::Value::as_bool) == Some(true) {
            "It waits for a maintainer to look first, because it's your first version.".to_owned()
        } else {
            "It waits for ace's signer, usually a few minutes.".to_owned()
        },
    ]
}

fn draft_lines(answer: &serde_json::Value) -> Vec<String> {
    let draft = answer.get("draft").cloned().unwrap_or_default();
    let id = draft
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let entry_type = draft
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let name = draft
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let version = draft
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let files = draft
        .get("files")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let size = draft
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let mut lines = vec![format!(
        "Draft {id}: {entry_type}/{name} {version}, {files} files, {} KB.",
        size.div_ceil(1024)
    )];
    let scan = draft.get("scan").cloned().unwrap_or_default();
    if scan.get("state").and_then(serde_json::Value::as_str) == Some("scanning") {
        lines.push("The Store is still scanning it.".to_owned());
    }
    if let Some(report) = scan.get("report") {
        let empty = Vec::new();
        let findings = report
            .get("findings")
            .and_then(serde_json::Value::as_array)
            .unwrap_or(&empty);
        let mut warned: Vec<String> = findings
            .iter()
            .filter(|finding| {
                finding.get("level").and_then(serde_json::Value::as_str) != Some("note")
            })
            .map(|finding| {
                let level = finding
                    .get("level")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                format!("  {level}: {}", finding_sentence(finding))
            })
            .collect();
        if warned.is_empty() {
            warned.push("The scan found nothing to warn about.".to_owned());
        }
        lines.extend(warned);
    }
    let empty = Vec::new();
    let problems = draft
        .get("problems")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    lines.extend(problems.iter().map(|problem| {
        let path = problem
            .get("path")
            .and_then(serde_json::Value::as_str)
            .map_or_else(String::new, |path| format!("{path}: "));
        let message = problem
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        format!("  {path}{message}")
    }));
    lines.push(format!("Publish it with ace store draft publish {id}."));
    lines
}

fn me_lines(answer: &serde_json::Value) -> Vec<String> {
    let me = answer.get("me").cloned().unwrap_or_default();
    let mut lines = Vec::new();
    match me.get("profile") {
        Some(profile) => {
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
            let state = me
                .get("state")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            lines.push(format!(
                "@{handle}: {display}{}{}",
                if verified { ", verified" } else { "" },
                if state == "active" {
                    String::new()
                } else {
                    format!(" ({state})")
                }
            ));
        }
        None => lines.push(
            "No publisher profile yet: ace store profile create --handle HANDLE --name NAME."
                .to_owned(),
        ),
    }
    let empty = Vec::new();
    for entry in me
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
    {
        let title = entry
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        lines.push(format!("{}  {title}", entry_ref(entry)));
    }
    for draft in me
        .get("drafts")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
    {
        let id = draft
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let entry_type = draft
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let name = draft
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let version = draft
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        lines.push(format!("Draft {id}: {entry_type}/{name} {version}"));
    }
    transfer_lines(
        me.get("transfers")
            .and_then(serde_json::Value::as_array)
            .map_or(&[], Vec::as_slice),
        &mut lines,
    );
    lines
}

fn transfer_lines(transfers: &[serde_json::Value], lines: &mut Vec<String>) {
    for transfer in transfers {
        lines.push(transfer_line(transfer));
    }
}

fn transfer_line(transfer: &serde_json::Value) -> String {
    let id = transfer
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let direction = transfer
        .get("direction")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let party = if direction == "incoming" {
        format!(
            "from @{}",
            transfer
                .get("from")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
        )
    } else {
        format!(
            "to @{}",
            transfer
                .get("to")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
        )
    };
    format!("Transfer {id}: {} {party}", entry_ref(transfer))
}

fn publish_entry_lines(answer: &serde_json::Value) -> Vec<String> {
    let entry = answer.get("entry").cloned().unwrap_or_default();
    let summary = entry.get("summary").cloned().unwrap_or_default();
    let title = entry
        .get("listing")
        .and_then(|listing| listing.get("title"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let latest = answer
        .get("latest")
        .and_then(serde_json::Value::as_str)
        .map_or_else(String::new, |latest| format!(", showing {latest}"));
    let mut lines = vec![format!("{}: {title}{latest}", entry_ref(&summary))];
    let empty = Vec::new();
    for version in entry
        .get("versions")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
    {
        let number = version
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let status = version
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let deprecated = version
            .get("deprecated")
            .and_then(serde_json::Value::as_str)
            .map_or_else(String::new, |deprecated| {
                format!(", deprecated: {deprecated}")
            });
        let changelog = version
            .get("changelog")
            .and_then(serde_json::Value::as_str)
            .map_or_else(String::new, |changelog| {
                format!("  {}", changelog.split('\n').next().unwrap_or(""))
            });
        lines.push(format!("  {number}  {status}{deprecated}{changelog}"));
    }
    if entry.get("pendingListing").is_some() {
        lines.push("A listing edit waits for a maintainer.".to_owned());
    }
    lines
}

fn pending_lines(answer: &serde_json::Value) -> Vec<String> {
    if answer.get("what").and_then(serde_json::Value::as_str) == Some("withdrawal") {
        vec!["Withdrawal taken; ace's signer signs it next, and devices turn it off.".to_owned()]
    } else {
        vec![
            "The listing edit waits for a maintainer, because its scan asks for a look.".to_owned(),
        ]
    }
}

fn profile_lines(answer: &serde_json::Value) -> Vec<String> {
    let profile = answer.get("profile").cloned().unwrap_or_default();
    let handle = profile
        .get("handle")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let display = profile
        .get("displayName")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    vec![format!("@{handle}: {display}")]
}

fn checked_lines(answer: &serde_json::Value) -> Vec<String> {
    let check = answer.get("check").cloned().unwrap_or_default();
    let empty = Vec::new();
    let files = check
        .get("files")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    let mut lines = vec![format!("{} files would upload.", files.len())];
    let findings = check
        .get("findings")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    lines.extend(findings.iter().map(|finding| {
        format!(
            "  {}",
            finding
                .get("sentence")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
        )
    }));
    lines
}

fn signals_lines(answer: &serde_json::Value) -> Vec<String> {
    let signals = answer.get("signals").cloned().unwrap_or_default();
    match signals.as_object() {
        Some(object) => object
            .iter()
            .map(|(key, value)| {
                format!(
                    "{key}: {}",
                    serde_json::to_string(value).unwrap_or_default()
                )
            })
            .collect(),
        None => Vec::new(),
    }
}

fn verification_lines(answer: &serde_json::Value) -> Vec<String> {
    let verification = answer.get("verification").cloned().unwrap_or_default();
    let mut lines = vec![if verification
        .get("verified")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        "Verified.".to_owned()
    } else {
        "Not verified.".to_owned()
    }];
    let empty = Vec::new();
    for challenge in verification
        .get("challenges")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
    {
        let kind = challenge
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let subject = challenge
            .get("subject")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let state = challenge
            .get("state")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let problem = challenge
            .get("problem")
            .and_then(serde_json::Value::as_str)
            .map_or_else(String::new, |problem| format!(": {problem}"));
        lines.push(format!("  {kind} {subject}: {state}{problem}"));
    }
    lines
}
