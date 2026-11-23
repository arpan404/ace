// SPDX-License-Identifier: Apache-2.0
//! Tool names, the SDK byte budget and ace-call recognition (`tool-events.ts`).

use serde_json::{Map, Value};

use super::envelope::string;
use super::{BudgetError, BudgetResult};

/// Byte budget for one tool's retained arguments, and the structural budgets.
pub(crate) const ARGS_BYTES: usize = 262_144;
const NODES: usize = 32_768;
const DEPTH: usize = 64;

/// Serialize with the SDK's byte, node and depth budgets (`boundedJson`).
pub(crate) fn bounded_json(value: &Value, max_bytes: usize) -> BudgetResult<String> {
    let mut nodes = 0;
    walk(value, 0, &mut nodes)?;
    let text = serde_json::to_string(value).map_err(|_| BudgetError::Exceeded)?;
    if text.len() > max_bytes {
        return Err(BudgetError::Exceeded);
    }
    Ok(text)
}

fn walk(value: &Value, depth: usize, nodes: &mut usize) -> BudgetResult<()> {
    *nodes += 1;
    if *nodes > NODES || depth > DEPTH {
        return Err(BudgetError::Exceeded);
    }
    match value {
        Value::Array(items) => {
            for item in items {
                walk(item, depth + 1, nodes)?;
            }
        }
        Value::Object(map) => {
            for (_, item) in map {
                walk(item, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

const SCREEN: &[&str] = &[
    "open_app",
    "windows",
    "ui_tree",
    "ui_act",
    "input",
    "screenshot",
    "measure",
    "apps",
    "state",
    "act",
];
const BROWSER: &[&str] = &[
    "open",
    "snapshot",
    "act",
    "wait_for",
    "find",
    "screenshot",
    "logs",
    "evaluate",
    "history",
    "settings",
    "measure",
];
const SIM: &[&str] = &["list", "start", "stop", "ui", "act", "screenshot", "logs"];

fn bare_tool_name(name: &str) -> &str {
    let mut bare = name;
    if let Some(rest) = bare.strip_prefix("mcp__ace__") {
        bare = rest;
    }
    while let Some(rest) = bare.strip_prefix("ace_") {
        bare = rest;
    }
    bare
}

fn is_tool_name(bare: &str) -> bool {
    let bytes = bare.as_bytes();
    if bytes.is_empty() || bytes.len() > 101 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// The bare name of an ace tool, when the spelling is one of ace's.
fn ace_tool_name(name: &str) -> Option<&str> {
    let bare = bare_tool_name(name);
    if !is_tool_name(bare) {
        return None;
    }
    if name.starts_with("mcp__ace__") || name.starts_with("ace_") {
        return Some(bare);
    }
    for (prefix, names) in [("browser_", BROWSER), ("screen_", SCREEN), ("sim_", SIM)] {
        if let Some(rest) = bare.strip_prefix(prefix)
            && names.contains(&rest)
        {
            return Some(bare);
        }
    }
    None
}

/// Whether the call ran one of ace's own tools, whose real error text shows.
pub(crate) fn is_ace_call(detail: &Map<String, Value>, kind: &str, title: &str) -> bool {
    if string(detail.get("kind").unwrap_or(&Value::Null)) == Some("mcp") {
        let server = string(detail.get("server").unwrap_or(&Value::Null)).unwrap_or("");
        if !["ace", "unknown", ""].contains(&server) {
            return false;
        }
        let tool = string(detail.get("tool").unwrap_or(&Value::Null)).unwrap_or("");
        return ace_tool_name(tool).is_some();
    }
    if string(detail.get("kind").unwrap_or(&Value::Null)) != Some("custom") && kind != "custom" {
        return false;
    }
    ace_tool_name(title).is_some()
}
