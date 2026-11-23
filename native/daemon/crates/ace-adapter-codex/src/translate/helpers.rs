// SPDX-License-Identifier: Apache-2.0
//! Small JSON readers and native key helpers, ported from `native.ts`,
//! `shell-command.ts` and the request/error helpers they use.

use ace_json::{Map, Value};
use std::sync::LazyLock;

static EMPTY_MAP: LazyLock<Map> = LazyLock::new(Map::new);
static EMPTY_VEC: LazyLock<Vec<Value>> = LazyLock::new(Vec::new);

/// The value's map if it is a JSON object, otherwise the shared empty one.
pub fn obj_map(value: &Value) -> &Map {
    match value {
        Value::Object(map) => map,
        _ => &EMPTY_MAP,
    }
}

/// `str(value, fallback)`: the string itself, else the fallback.
pub fn str_of<'a>(value: Option<&'a Value>, fallback: &'a str) -> &'a str {
    match value {
        Some(Value::String(s)) => s.as_str(),
        _ => fallback,
    }
}

/// `str(value)` with an empty fallback.
pub fn str_empty(value: Option<&Value>) -> &str {
    str_of(value, "")
}

/// `list(value)`: the array itself, else an empty slice.
pub fn list_of(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &EMPTY_VEC,
    }
}

/// JavaScript `typeof` for a JSON value, as `requestKey` needs it.
fn js_typeof(value: &Value) -> &'static str {
    match value {
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::Null => "object",
        Value::Array(_) | Value::Object(_) => "object",
    }
}

/// JavaScript `String(id)` for the JSON ids request keys see.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => String::from(s.clone()),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => {
            if *b {
                "true".to_owned()
            } else {
                "false".to_owned()
            }
        }
        Value::Null => "null".to_owned(),
        Value::Array(_) | Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `requestKey(id, scope)`: the native request key, same strings as TypeScript.
pub fn request_key(id: &Value, scope: &str) -> String {
    let kind = js_typeof(id);
    let text = js_string(id);
    if scope.is_empty() {
        format!("request:{kind}:{text}")
    } else {
        let inner = format!(
            "[{},{},{}]",
            json_string(scope),
            json_string(kind),
            json_string(&text)
        );
        format!("request:{inner}")
    }
}

pub fn async_key(item: &str) -> String {
    format!("async:{item}")
}

pub fn plan_key(turn: &str) -> String {
    format!("plan:{turn}")
}

pub fn shell_key(item: &str) -> String {
    format!("shell:{item}")
}

pub fn child_key(thread: &str) -> String {
    format!("subagent:{thread}")
}

/// Decode only a single conventional login-shell wrapper, never execute it.
pub fn unwrap_shell_command(command: &str) -> Option<(String, String)> {
    let (shell_path, args) = command.split_once(' ')?;
    if !shell_path.starts_with('/') {
        return None;
    }
    let exe = shell_path.rsplit('/').next()?;
    if !matches!(exe, "sh" | "bash" | "zsh" | "dash" | "fish") {
        return None;
    }
    for segment in shell_path[1..].split('/') {
        if segment.is_empty()
            || !segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        {
            return None;
        }
    }
    let (flag, quoted) = args.split_once(' ')?;
    if flag != "-lc" && flag != "-c" {
        return None;
    }
    if !quoted.starts_with('\'') || !quoted.ends_with('\'') || quoted.len() < 2 {
        return None;
    }
    let inner_quoted = &quoted[1..quoted.len() - 1];
    let mut inner = String::with_capacity(inner_quoted.len());
    let bytes = inner_quoted.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            if i + 4 <= bytes.len()
                && bytes[i + 1] == b'\\'
                && bytes[i + 2] == b'\''
                && bytes[i + 3] == b'\''
            {
                inner.push('\'');
                i += 4;
            } else {
                return None;
            }
        } else {
            let ch = inner_quoted[i..].chars().next()?;
            inner.push(ch);
            i += ch.len_utf8();
        }
    }
    Some((inner, shell_path.to_owned()))
}

/// Best-effort metadata can corroborate exact executable text, never substitute.
pub fn command_actions_match(command: &str, actions: Option<&Value>) -> bool {
    let actions = match actions {
        None => return true,
        Some(v) => v,
    };
    let items = match actions {
        Value::Array(items) => items,
        _ => return false,
    };
    if items.is_empty() {
        return true;
    }
    let mut commands: Vec<&str> = Vec::with_capacity(items.len());
    for item in items {
        let map = obj_map(item);
        match map.get("command") {
            Some(Value::String(s)) => commands.push(s.as_str()),
            _ => return false,
        }
    }
    let joined = commands.join(" && ");
    if joined == command {
        return true;
    }
    let inner = unwrap_shell_command(command)
        .map(|(inner, _)| inner)
        .unwrap_or(command.to_owned());
    joined == inner
}

/// Whether a turn error says the account is out of usage.
pub fn turn_error_kind(info: &str, message: &str) -> &'static str {
    if info == "usageLimitExceeded" {
        return "quota";
    }
    let info_lower = info.to_ascii_lowercase();
    if info_lower.contains("auth")
        || message.contains("Authentication failed")
        || message.contains("Not logged in")
    {
        return "auth";
    }
    if info.contains("Stream") || info.contains("network") || info.contains("Connection") {
        return "network";
    }
    "provider"
}

const REQUEST_METHODS: &[&str] = &[
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
];

pub fn is_interactive_request(method: &str) -> bool {
    REQUEST_METHODS.contains(&method)
}

pub fn is_known_delta(method: &str) -> bool {
    matches!(
        method,
        "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta"
            | "item/commandExecution/outputDelta"
            | "item/plan/delta"
    )
}

pub fn is_async_question(item: &Value) -> bool {
    let map = obj_map(item);
    if str_empty(map.get("type")) != "agentMessage" {
        return false;
    }
    if str_empty(map.get("delivery")) != "async" {
        return false;
    }
    !list_of(map.get("questions")).is_empty()
}
