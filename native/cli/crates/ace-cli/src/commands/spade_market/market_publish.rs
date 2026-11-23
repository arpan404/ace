// SPDX-License-Identifier: Apache-2.0
//! A publishing answer, in the publisher's words (ADR 0178 §12.2). Pure.

use super::market_render::{entry_ref, finding_sentence};

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
