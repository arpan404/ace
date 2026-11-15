//! Each activity entry in Spade's words: one sentence of what the bot did and one line of the
//! detail that matters for that kind of call (a command, a file's path, a note, an email's
//! recipient and subject), never a tool's raw name or its arguments as JSON. Pure; secrets are
//! hidden before the words leave here. Never shown to the model.

use serde_json::{Map, Value};

use super::Kind;
use crate::redact;

/// A tool in words: after "wants to", on the Working line, and once it ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolWords {
    /// "search the web"
    pub base: String,
    /// "Searching the web"
    pub doing: String,
    /// "Searched the web"
    pub done: String,
}

const TOOLS: &[(&str, &str, &str, &str)] = &[
    (
        "web_search",
        "search the web",
        "Searching the web",
        "Searched the web",
    ),
    (
        "web_fetch",
        "read a web page",
        "Reading a web page",
        "Read a web page",
    ),
    (
        "todo",
        "update its plan",
        "Updating its plan",
        "Updated its plan",
    ),
    (
        "tool_search",
        "look for a tool",
        "Looking for a tool",
        "Looked for a tool",
    ),
    (
        "skill_search",
        "look for a skill",
        "Looking for a skill",
        "Looked for a skill",
    ),
    ("call_tool", "use a tool", "Using a tool", "Used a tool"),
    (
        "skill_load",
        "load a skill",
        "Reading a skill",
        "Read a skill",
    ),
    (
        "skill_propose",
        "suggest a skill",
        "Writing a skill",
        "Suggested a skill",
    ),
    (
        "skill_feedback",
        "note how a skill worked",
        "Noting how a skill worked",
        "Noted how a skill worked",
    ),
    (
        "shell",
        "run a command",
        "Running a command",
        "Ran a command",
    ),
    (
        "workspace_list",
        "look through its files",
        "Looking through its files",
        "Looked through its files",
    ),
    (
        "workspace_read",
        "read a file",
        "Reading a file",
        "Read a file",
    ),
    (
        "workspace_search",
        "search its files",
        "Searching its files",
        "Searched its files",
    ),
    (
        "workspace_write",
        "write a file",
        "Writing a file",
        "Wrote a file",
    ),
    (
        "workspace_edit",
        "change a file",
        "Changing a file",
        "Changed a file",
    ),
    (
        "memory_save",
        "save a note",
        "Saving a note",
        "Saved a note",
    ),
    (
        "memory_update",
        "update a note",
        "Updating a note",
        "Updated a note",
    ),
    (
        "memory_forget",
        "forget a note",
        "Forgetting a note",
        "Forgot a note",
    ),
    (
        "memory_search",
        "search its notes",
        "Searching its notes",
        "Searched its notes",
    ),
    (
        "bot_message",
        "message another bot",
        "Messaging another bot",
        "Messaged another bot",
    ),
    (
        "bots_list",
        "check the other bots",
        "Checking the other bots",
        "Checked the other bots",
    ),
    (
        "routine_save",
        "save a routine",
        "Saving a routine",
        "Saved a routine",
    ),
    (
        "routine_delete",
        "delete a routine",
        "Deleting a routine",
        "Deleted a routine",
    ),
    (
        "send_email",
        "send an email",
        "Sending an email",
        "Sent an email",
    ),
    ("research", "research", "Researching", "Researched"),
    (
        "helper",
        "hand work to a helper",
        "Helpers working",
        "Handed work to a helper",
    ),
    (
        "delegate",
        "hand work to agents",
        "Handing work to agents",
        "Handed work to agents",
    ),
    (
        "wait",
        "wait for agents",
        "Waiting for agents",
        "Waited for agents",
    ),
    (
        "ace_threads_list",
        "list your threads",
        "Listing threads",
        "Listed threads",
    ),
    (
        "ace_thread_read",
        "read a thread",
        "Reading a thread",
        "Read a thread",
    ),
    (
        "ace_thread_status",
        "check a thread",
        "Checking a thread",
        "Checked a thread",
    ),
    (
        "ace_thread_run",
        "start a thread",
        "Starting a thread",
        "Started a thread",
    ),
    (
        "ace_thread_send",
        "send a message to a thread",
        "Sending a message to a thread",
        "Sent a message to a thread",
    ),
    (
        "screen_state",
        "look at a screen",
        "Looking at a screen",
        "Looked at a screen",
    ),
    (
        "screen_act",
        "use an app on the screen",
        "Using an app on the screen",
        "Used an app",
    ),
    (
        "screen_apps",
        "list open apps",
        "Listing open apps",
        "Listed open apps",
    ),
    (
        "browser_open",
        "open a web page",
        "Opening a web page",
        "Opened a web page",
    ),
    (
        "browser_act",
        "use a web page",
        "Using a web page",
        "Used a web page",
    ),
    (
        "notify",
        "send you a notification",
        "Notifying you",
        "Notified you",
    ),
    (
        "ace_task_control",
        "control a task",
        "Controlling a task",
        "Controlled a task",
    ),
];

/// `ace__thread_start` or `ace_thread_start` → "thread start".
fn plain_name(name: &str) -> String {
    let last = name.rsplit("__").next().unwrap_or(name);
    let last = last.strip_prefix("ace_").unwrap_or(last);
    let words: Vec<&str> = last.split(['_', '-']).filter(|w| !w.is_empty()).collect();
    if words.is_empty() {
        name.to_owned()
    } else {
        words.join(" ")
    }
}

/// A tool's words; ace's tools may arrive under its server's name (`ace__screen_act`), and one
/// this table doesn't know reads by its name in words.
pub fn tool_words(name: &str) -> ToolWords {
    let last = name.rsplit("__").next().unwrap_or(name);
    if let Some((_, base, doing, done)) = TOOLS
        .iter()
        .find(|(tool, ..)| *tool == name)
        .or_else(|| TOOLS.iter().find(|(tool, ..)| *tool == last))
    {
        return ToolWords {
            base: (*base).to_owned(),
            doing: (*doing).to_owned(),
            done: (*done).to_owned(),
        };
    }
    let plain = plain_name(name);
    ToolWords {
        base: format!("use {plain}"),
        doing: format!("Using {plain}"),
        done: format!("Used {plain}"),
    }
}

fn text<'a>(fields: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    fields
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}

/// A name or address from a `to` field: a string, a list of them, or `{name, email}`.
fn recipient(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => Some(s.trim().to_owned()).filter(|s| !s.is_empty()),
        Value::Array(items) => {
            let names: Vec<String> = items.iter().filter_map(|i| recipient(Some(i))).collect();
            match names.len() {
                0 => None,
                1 | 2 => Some(names.join(" and ")),
                n => Some(format!("{} and {} others", names[0], n - 1)),
            }
        }
        Value::Object(fields) => recipient(fields.get("name"))
            .or_else(|| recipient(fields.get("email")))
            .or_else(|| recipient(fields.get("address"))),
        _ => None,
    }
}

/// `due_date` → "Due date".
fn label(key: &str) -> String {
    let words: Vec<&str> = key.split(['_', '-']).filter(|w| !w.is_empty()).collect();
    let words = words.join(" ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A value in words: text as it is, numbers, yes or no, lists joined; deeper objects left out.
fn said(value: &Value, depth: u8) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()).filter(|s| !s.trim().is_empty()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(if *b { "Yes" } else { "No" }.to_owned()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(|i| said(i, depth + 1)).collect();
            (!parts.is_empty()).then(|| parts.join(", "))
        }
        Value::Object(fields) if depth <= 1 => {
            let parts: Vec<String> = fields
                .iter()
                .filter_map(|(k, v)| said(v, depth + 1).map(|s| format!("{}: {s}", label(k))))
                .collect();
            (!parts.is_empty()).then(|| parts.join("; "))
        }
        _ => None,
    }
}

/// The one line under a call's sentence, by the kind of call; `None` when nothing is worth
/// saying. `arguments` are the call's own, already unwrapped from `call_tool`.
pub fn call_detail(name: &str, arguments: &Value) -> Option<String> {
    // Secrets go before anything is picked out: a key never reaches a line.
    let shown = redact::value(arguments);
    let line = match &shown {
        Value::String(s) => Some(s.clone()).filter(|s| !s.trim().is_empty()),
        Value::Object(fields) => object_detail(name, fields),
        _ => None,
    }?;
    Some(redact::one_line(&line)).filter(|l| !l.is_empty())
}

fn object_detail(name: &str, fields: &Map<String, Value>) -> Option<String> {
    let tool = name.rsplit("__").next().unwrap_or(name);
    match tool {
        "shell" => return text(fields, "command").map(str::to_owned),
        "workspace_write" | "workspace_edit" | "workspace_read" => {
            return text(fields, "path").map(str::to_owned);
        }
        "memory_save" | "memory_update" => return text(fields, "text").map(str::to_owned),
        // Only the note's id: its text is the person's to look up.
        "memory_forget" => return None,
        "bot_message" => {
            let words = text(fields, "text")?;
            return Some(match text(fields, "bot") {
                Some(bot) => format!("To {bot}: {words}"),
                None => words.to_owned(),
            });
        }
        "web_search" | "memory_search" | "workspace_search" | "skill_search" | "tool_search" => {
            if let Some(query) = text(fields, "query").or_else(|| text(fields, "q")) {
                return Some(query.to_owned());
            }
        }
        "web_fetch" | "browser_open" => {
            if let Some(url) = text(fields, "url") {
                return Some(url.to_owned());
            }
        }
        _ => {}
    }
    let to = recipient(
        fields
            .get("to")
            .or_else(|| fields.get("recipient"))
            .or_else(|| fields.get("recipients")),
    );
    let subject = text(fields, "subject");
    if to.is_some() || subject.is_some() {
        let parts: Vec<String> = [to.map(|t| format!("To {t}")), subject.map(str::to_owned)]
            .into_iter()
            .flatten()
            .collect();
        return Some(parts.join(" · "));
    }
    // A hidden secret says nothing worth a line.
    let parts: Vec<String> = fields
        .iter()
        .filter(|(_, v)| v.as_str() != Some(redact::HIDDEN))
        .filter_map(|(k, v)| said(v, 1).map(|s| format!("{}: {s}", label(k))))
        .collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// `slack__send_message` → app "slack", tool "send_message".
fn connector_parts(name: &str) -> (&str, &str) {
    name.split_once("__").unwrap_or(("", name))
}

fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn access_label(level: &str) -> Option<&'static str> {
    match level {
        "auto_review" => Some("Auto-review"),
        _ => None,
    }
}

/// What an entry's sentence is made from.
pub struct Facts<'a> {
    pub kind: Kind,
    pub name: Option<&'a str>,
    pub summary: &'a str,
    pub outcome: Option<&'a str>,
}

/// An entry's sentence: what the bot did, or what happened to it, in Spade's words.
pub fn sentence(facts: &Facts<'_>) -> String {
    let name = facts.name.unwrap_or("");
    let outcome = facts.outcome.unwrap_or("");
    let words = tool_words(name);
    match facts.kind {
        // A file a background job made, named by the job's tool.
        Kind::File if !name.starts_with("workspace_") => "Saved a file".to_owned(),
        Kind::Tool | Kind::File if outcome == "running" => words.doing,
        Kind::Tool | Kind::File => words.done,
        Kind::Connector => {
            let (app, tool) = connector_parts(name);
            let plain = tool_words(tool);
            if app.is_empty() {
                plain.done
            } else {
                format!("{} in {}", plain.done, capitalised(app))
            }
        }
        Kind::Bot if outcome == "received" => format!("Message from {name}"),
        Kind::Bot => format!("Messaged {name}"),
        Kind::Approval => match outcome {
            "allowed" => format!("You allowed it to {}", words.base),
            "always" => format!("You always allow it to {}", words.base),
            "declined" => format!("You declined: {}", words.base),
            _ => format!("Asked you to {}", words.base),
        },
        Kind::Routine if outcome == "heartbeat" => "Heartbeat ran".to_owned(),
        Kind::Routine if name.is_empty() => "A routine ran".to_owned(),
        Kind::Routine => format!("{name} ran"),
        Kind::Review => {
            let verdict = match outcome {
                "refused" => "refused",
                "escalated" => "asked you",
                _ => "approved",
            };
            format!("The reviewer {verdict}: {}", words.base)
        }
        Kind::Access => match access_label(name) {
            Some(label) => format!("Access changed to {label}"),
            None => "Access changed".to_owned(),
        },
        Kind::Task | Kind::Hook if !facts.summary.is_empty() => capitalised(facts.summary),
        Kind::Task if name == "paused" => "Paused its task".to_owned(),
        Kind::Task => "Carried on by itself".to_owned(),
        Kind::Hook => "A plugin's hook ran".to_owned(),
        Kind::Spend => match outcome {
            "stopped" => "Stopped a turn",
            "failed" => "A turn failed",
            "interrupted" => "A turn was cut off",
            _ => "Finished a turn",
        }
        .to_owned(),
        Kind::Cap if name == "monthly" => "Reached its monthly cap".to_owned(),
        Kind::Cap => "Reached its daily cap".to_owned(),
    }
}

/// An entry's detail when it isn't a call's: what the summary already says in words, or
/// nothing when the sentence says it all.
pub fn other_detail(kind: Kind, summary: &str) -> Option<String> {
    match kind {
        Kind::Access | Kind::Task | Kind::Hook => None,
        _ => Some(summary.to_owned()).filter(|s| !s.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_tool_this_table_does_not_know_reads_by_its_name_in_words() {
        assert_eq!(tool_words("ace__screen_act").done, "Used an app");
        assert_eq!(tool_words("linear__create_issue").base, "use create issue");
        assert_eq!(tool_words("ace_thread_start").doing, "Using thread start");
    }

    #[test]
    fn each_kind_of_call_has_the_detail_that_matters() {
        let cases = [
            (
                "shell",
                json!({ "command": "ls -la", "timeout": 30 }),
                Some("ls -la"),
            ),
            (
                "workspace_edit",
                json!({ "path": "a.md", "old": "x", "new": "y" }),
                Some("a.md"),
            ),
            (
                "memory_save",
                json!({ "text": "Likes tea" }),
                Some("Likes tea"),
            ),
            ("memory_forget", json!({ "id": "n1" }), None),
            (
                "bot_message",
                json!({ "bot": "Research", "text": "Hi" }),
                Some("To Research: Hi"),
            ),
            (
                "gmail__send",
                json!({ "to": [{ "name": "Marta" }, "b@x.dev", "c@x.dev"], "subject": "Plan" }),
                Some("To Marta and 2 others · Plan"),
            ),
            (
                "linear__create_issue",
                json!({ "due_date": "Friday", "urgent": true }),
                Some("Due date: Friday; Urgent: Yes"),
            ),
            (
                "web_search",
                json!({ "query": "flights to Oslo" }),
                Some("flights to Oslo"),
            ),
        ];
        for (name, arguments, expected) in cases {
            assert_eq!(call_detail(name, &arguments).as_deref(), expected, "{name}");
        }
    }

    #[test]
    fn a_detail_never_carries_a_secret_or_more_than_one_line() {
        let detail = call_detail(
            "linear__create_issue",
            &json!({ "title": "Bug\nsecond line", "api_token": "lin_abc" }),
        )
        .unwrap_or_default();
        assert!(!detail.contains("lin_abc"), "{detail}");
        assert!(!detail.contains('\n'), "{detail}");
    }
}
