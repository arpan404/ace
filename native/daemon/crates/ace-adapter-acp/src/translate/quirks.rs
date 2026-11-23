// SPDX-License-Identifier: Apache-2.0
//! Per-agent quirks (`quirks/generic.ts`, `quirks/types.ts` and the two
//! concrete quirks the translator tests use). Functions cannot cross the
//! binding, so the shell names one of these and Rust implements it.

use crate::translate::data::{object, string};
use ace_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuirksKind {
    Generic,
    Antigravity,
    Extension,
}

impl QuirksKind {
    pub fn provider(self) -> &'static str {
        match self {
            QuirksKind::Generic | QuirksKind::Extension => "acp",
            QuirksKind::Antigravity => "antigravity",
        }
    }

    pub fn from_name(name: &str) -> Self {
        match name {
            "antigravity" => QuirksKind::Antigravity,
            "extension" => QuirksKind::Extension,
            _ => QuirksKind::Generic,
        }
    }

    /// The tool kind an update names, or None.
    pub fn tool_kind(self, update: &Value) -> Option<String> {
        match self {
            QuirksKind::Generic => None,
            QuirksKind::Antigravity => antigravity_tool_kind(update),
            QuirksKind::Extension => extension_tool_kind(update),
        }
    }

    /// Classify message text as a provider or network failure, or None.
    pub fn classify_error(self, text: &str) -> Option<Value> {
        match self {
            QuirksKind::Generic => None,
            QuirksKind::Antigravity => {
                if let Some(message) = text.strip_prefix("Usage Limit Reached") {
                    let _ = message;
                    return Some(error_object("provider", Some("usage_limit"), text));
                }
                if let Some(message) = text.strip_prefix("Agent execution error:") {
                    let _ = message;
                    return Some(error_object("provider", None, text));
                }
                if text.to_lowercase().starts_with("connection lost") {
                    return Some(error_object("network", None, text));
                }
                None
            }
            QuirksKind::Extension => {
                if let Some(message) = text.strip_prefix("\n\nError: ") {
                    return Some(error_object("provider", None, message));
                }
                None
            }
        }
    }

    /// Whether agent message text only reports the client's own cancel.
    pub fn cancel_notice(self, text: &str) -> bool {
        match self {
            QuirksKind::Antigravity => text.trim() == "The request was cancelled by the client.",
            _ => false,
        }
    }
}

fn error_object(kind: &str, code: Option<&str>, message: &str) -> Value {
    let mut map = ace_json::Map::with_capacity(3);
    map.insert("kind".to_owned(), Value::from(kind.to_owned()));
    if let Some(code) = code {
        map.insert("code".to_owned(), Value::from(code.to_owned()));
    }
    map.insert("message".to_owned(), Value::from(message.to_owned()));
    Value::Object(map)
}

fn antigravity_tool_kind(update: &Value) -> Option<String> {
    let name = {
        let direct = string(update.get("name").unwrap_or(&Value::Null));
        if !direct.is_empty() {
            direct.to_owned()
        } else {
            let raw_input = object(update.get("rawInput").unwrap_or(&Value::Null));
            let nested = string(raw_input.get("_toolName").unwrap_or(&Value::Null));
            if !nested.is_empty() {
                nested.to_owned()
            } else {
                string(update.get("title").unwrap_or(&Value::Null)).to_owned()
            }
        }
    };
    if name.starts_with("chrome_devtools/") {
        return Some("browser".to_owned());
    }
    let meta = object(update.get("_meta").unwrap_or(&Value::Null));
    if meta
        .get("is_mcp_tool_call")
        .is_some_and(|v| v.as_bool().unwrap_or(false))
    {
        return Some("mcp".to_owned());
    }
    const NAMES: &[(&str, &str)] = &[
        ("start_subagent", "agent.spawn"),
        ("run_command", "shell"),
        ("shell", "shell"),
        ("view_file", "file.read"),
        ("read_file", "file.read"),
        ("client_view_file", "file.read"),
        ("create_file", "file.write"),
        ("write_to_file", "file.write"),
        ("write_file", "file.write"),
        ("client_create_file", "file.write"),
        ("edit_file", "file.edit"),
        ("replace_file_content", "file.edit"),
        ("multi_replace_file_content", "file.edit"),
        ("client_edit_file", "file.edit"),
        ("grep_search", "search"),
        ("search_directory", "search"),
        ("find_by_name", "search"),
        ("find_file", "search"),
        ("list_dir", "search"),
        ("list_directory", "search"),
        ("search_web", "web.search"),
        ("read_url_content", "web.fetch"),
        ("call_mcp_tool", "mcp"),
        ("generate_image", "image"),
        ("ask_question", "ask_user"),
    ];
    for (candidate, kind) in NAMES {
        if name == *candidate {
            return Some((*kind).to_owned());
        }
    }
    None
}

fn extension_tool_kind(update: &Value) -> Option<String> {
    let raw_input = object(update.get("rawInput").unwrap_or(&Value::Null));
    let tool_name = string(raw_input.get("_toolName").unwrap_or(&Value::Null));
    let title = string(update.get("title").unwrap_or(&Value::Null));
    if tool_name == "task" || title.starts_with("Task:") {
        return Some("agent.spawn".to_owned());
    }
    if tool_name == "createPlan" || title.starts_with("Create Plan") {
        return Some("plan".to_owned());
    }
    if raw_input.contains_key("providerIdentifier") && raw_input.contains_key("toolName") {
        return Some("mcp".to_owned());
    }
    if tool_name == "updateTodos" {
        return Some("todo".to_owned());
    }
    if tool_name == "askQuestion" {
        return Some("ask_user".to_owned());
    }
    if tool_name == "generateImage" {
        return Some("image".to_owned());
    }
    None
}
