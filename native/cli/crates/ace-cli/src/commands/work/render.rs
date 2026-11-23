// SPDX-License-Identifier: Apache-2.0
//! Human lines for ported work reads, matching the TypeScript renderers exactly.

use std::collections::BTreeMap;

pub const SHORTEST_PREFIX: usize = 6;

/// `formatAge` from `@ace/ui-core/time`: compact ages in lists. Integer rounding matches
/// `Math.round` for the non-negative inputs a list shows.
pub fn format_age(at: i64, now: i64) -> String {
    let seconds = ((now - at) / 1000).max(0);
    if seconds < 45 {
        return "now".to_owned();
    }
    let minutes = (seconds + 30) / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = (minutes + 30) / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    let days = (hours + 12) / 24;
    if days < 14 {
        return format!("{days}d");
    }
    format!("{}w", (days + 3) / 7)
}

pub(crate) fn paint(text: &str, tone: &str, colour: bool) -> String {
    let code: Option<&str> = match tone {
        "needs-you" | "limited" => Some("33"),
        "failed" => Some("31"),
        "working" | "waiting" => Some("36"),
        "background" => Some("35"),
        "finished" => Some("32"),
        _ => None,
    };
    if colour
        && let Some(code) = code
        && !text.is_empty()
    {
        return format!("\u{1b}[{code}m{text}\u{1b}[0m");
    }
    text.to_owned()
}

pub(crate) fn request_kind(value: &serde_json::Value) -> &str {
    value
        .get("interaction")
        .and_then(|i| i.get("request"))
        .and_then(|r| r.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
}

pub(crate) fn request_glyph(kind: &str) -> &'static str {
    if kind == "question" { "?" } else { "◆" }
}

pub(crate) fn request_sentence(interaction: &serde_json::Value) -> String {
    let request = interaction.get("request").cloned().unwrap_or_default();
    let kind = request
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match kind {
        "approval" => request
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_owned(),
        "question" => {
            let questions = request
                .get("questions")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let first = questions
                .first()
                .and_then(|q| q.get("text"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("A question");
            let more = questions.len().saturating_sub(1);
            if more > 0 {
                format!("{first} (and {more} more)")
            } else {
                first.to_owned()
            }
        }
        "plan_review" => {
            let title = request
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if title.is_empty() {
                "Review the plan".to_owned()
            } else {
                format!("Review the plan: {title}")
            }
        }
        "elicitation" => {
            let server = request
                .get("server")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let title = request
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let message = request
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let what = if title.is_empty() { message } else { title };
            format!("{server} asks: {what}")
        }
        "browser_help" => request
            .get("message")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("Help in the browser")
            .to_owned(),
        _ => kind.replace('_', " "),
    }
}

pub(crate) fn request_answers(interaction: &serde_json::Value, id: &str) -> String {
    let kind = interaction
        .get("request")
        .and_then(|r| r.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match kind {
        "question" => format!("ace request answer {id}"),
        "elicitation" => format!("ace request answer {id}, or ace request deny {id}"),
        "browser_help" => "Finish it in the app's browser".to_owned(),
        _ => format!("ace request allow {id}, or ace request deny {id}"),
    }
}

/// Shortest unique prefixes for ids, at least 8 chars, as the list shows them.
pub fn short_ids(ids: &[String], floor: usize) -> BTreeMap<String, String> {
    let mut sorted = ids.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut out = BTreeMap::new();
    for (index, id) in sorted.iter().enumerate() {
        let prev = if index > 0 {
            sorted[index - 1].as_str()
        } else {
            ""
        };
        let next = sorted.get(index + 1).map_or("", String::as_str);
        let shared = common_prefix(id, prev).max(common_prefix(id, next));
        let len = floor.max(shared + 1).min(id.len());
        out.insert(id.clone(), id[..len].to_owned());
    }
    out
}

fn common_prefix(a: &str, b: &str) -> usize {
    a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count()
}

/// Which id `input` names among `known`, or a usage/not-found failure message.
pub fn resolve_request_ref(
    input: &str,
    known: &[String],
) -> Result<String, (String, &'static str, String)> {
    let value = input.trim();
    if known.iter().any(|id| id == value) {
        return Ok(value.to_owned());
    }
    if value.len() < SHORTEST_PREFIX {
        return Err((
            "REQUEST must be a request id or at least 6 characters of one.".to_owned(),
            "REQUEST",
            "See the ids with ace request list.".to_owned(),
        ));
    }
    let matches: Vec<&String> = known.iter().filter(|id| id.starts_with(value)).collect();
    if matches.len() == 1 {
        let only = matches[0];
        return Ok(only.clone());
    }
    if matches.len() > 1 {
        let shown = matches
            .iter()
            .take(3)
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let more = if matches.len() > 3 {
            format!(" and {} more", matches.len() - 3)
        } else {
            String::new()
        };
        return Err((
            format!(
                "{} could be {} requests: {shown}{more}.",
                value,
                matches.len()
            ),
            "REQUEST",
            "Type more of the id.".to_owned(),
        ));
    }
    Err((
        format!("No request starting with {value}."),
        "REQUEST",
        "See them with ace request list.".to_owned(),
    ))
}

fn approval_lines(request: &serde_json::Value, lines: &mut Vec<String>) {
    if let Some(desc) = request
        .get("description")
        .and_then(serde_json::Value::as_str)
    {
        let trimmed = desc.trim_end();
        if !trimmed.is_empty() {
            lines.push(String::new());
            lines.extend(trimmed.split('\n').take(20).map(str::to_owned));
        }
    }
    lines.push(String::new());
    if let Some(options) = request.get("options").and_then(serde_json::Value::as_array) {
        for option in options {
            let oid = option
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let label = option
                .get("label")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            lines.push(format!("  {oid}  {label}"));
        }
    }
}

fn question_lines(request: &serde_json::Value, lines: &mut Vec<String>) {
    if let Some(questions) = request
        .get("questions")
        .and_then(serde_json::Value::as_array)
    {
        for question in questions {
            lines.push(String::new());
            let header = question
                .get("header")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let text = question
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let qid = question
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let head = if header.is_empty() {
                String::new()
            } else {
                format!("{header}: ")
            };
            lines.push(format!("{head}{text}  ({qid})"));
            if let Some(options) = question
                .get("options")
                .and_then(serde_json::Value::as_array)
            {
                for option in options {
                    let oid = option
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let label = option
                        .get("label")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let desc = option
                        .get("description")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    if desc.is_empty() {
                        lines.push(format!("  {oid}  {label}"));
                    } else {
                        lines.push(format!("  {oid}  {label} · {desc}"));
                    }
                }
            }
            let allow_other = question
                .get("allowOther")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if allow_other {
                lines.push("  Or type your own answer.".to_owned());
            }
            let multi = question
                .get("multiSelect")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if multi {
                lines.push("  Pick any number, with --choice for each.".to_owned());
            }
        }
    }
}

/// `ace request show` human lines.
pub fn request_show_lines(open: &serde_json::Value, colour: bool) -> Vec<String> {
    let interaction = open.get("interaction").cloned().unwrap_or_default();
    let request = interaction.get("request").cloned().unwrap_or_default();
    let kind = request
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let glyph = paint(request_glyph(kind), "needs-you", colour);
    let sentence = request_sentence(&interaction);
    let id = interaction
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let title = open
        .get("threadTitle")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let thread_id = open
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let provider = open
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let mut lines = vec![
        format!("{glyph} {sentence}"),
        format!("{id}  in {title} ({thread_id})  {provider}"),
    ];
    if interaction.get("truncated").is_some() {
        lines.push("This request is long; allowing it reads it whole first.".to_owned());
    }
    match kind {
        "approval" => approval_lines(&request, &mut lines),
        "question" => question_lines(&request, &mut lines),
        "plan_review" => {
            if let Some(markdown) = request.get("markdown").and_then(serde_json::Value::as_str) {
                lines.push(String::new());
                lines.extend(markdown.trim_end().split('\n').take(60).map(str::to_owned));
            }
        }
        "elicitation" => {
            lines.push(String::new());
            if let Some(message) = request.get("message").and_then(serde_json::Value::as_str) {
                lines.push(message.to_owned());
            }
            if let Some(url) = request.get("url").and_then(serde_json::Value::as_str) {
                lines.push(url.to_owned());
            }
        }
        "browser_help" => {
            if let Some(url) = request.get("url").and_then(serde_json::Value::as_str) {
                lines.push(String::new());
                lines.push(url.to_owned());
            }
        }
        _ => {}
    }
    lines.push(String::new());
    lines.push(request_answers(&interaction, id));
    lines
}
