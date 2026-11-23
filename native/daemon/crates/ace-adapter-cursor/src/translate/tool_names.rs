// SPDX-License-Identifier: Apache-2.0
//! Tool names, the SDK byte budget and ace-call recognition (`tool-events.ts`).

use super::json::{J, json_bytes, units_eq, write_json};
use super::{BudgetError, BudgetResult};

/// Byte budget for one tool's retained arguments, and the structural budgets.
pub(crate) const ARGS_BYTES: usize = 262_144;
const NODES: usize = 32_768;
const DEPTH: usize = 64;

/// Serialize with the SDK's byte, node and depth budgets (`boundedJson`).
pub(crate) fn bounded_json(value: &J, max_bytes: usize) -> BudgetResult<String> {
    let mut nodes = 0;
    walk(value, 0, &mut nodes)?;
    if json_bytes(value) > max_bytes {
        return Err(BudgetError::Exceeded);
    }
    let mut text = String::new();
    write_json(&mut text, value);
    Ok(text)
}

fn walk(value: &J, depth: usize, nodes: &mut usize) -> BudgetResult<()> {
    *nodes += 1;
    if *nodes > NODES || depth > DEPTH {
        return Err(BudgetError::Exceeded);
    }
    match value {
        J::Arr(items) => {
            for item in items {
                walk(item, depth + 1, nodes)?;
            }
        }
        J::Obj(entries) => {
            for (_, item) in entries {
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

fn bare_tool_name(name: &[u16]) -> &[u16] {
    // One namespace strip, then the toolkit prefix it may still carry.
    let mut bare = name;
    let namespaced: Vec<u16> = "mcp__ace__".encode_utf16().collect();
    if let Some(rest) = bare.strip_prefix(namespaced.as_slice()) {
        bare = rest;
    }
    let legacy: Vec<u16> = "ace_".encode_utf16().collect();
    while let Some(rest) = bare.strip_prefix(legacy.as_slice()) {
        bare = rest;
    }
    bare
}

fn is_tool_name(bare: &[u16]) -> bool {
    let [first, ..] = bare else {
        return false;
    };
    if !(0x61..=0x7au16).contains(first) || bare.len() > 101 {
        return false;
    }
    bare.iter()
        .all(|unit| matches!(unit, 0x61..=0x7a | 0x30..=0x39 | 0x5f))
}

fn has_prefix(name: &[u16], prefix: &str) -> bool {
    let prefix: Vec<u16> = prefix.encode_utf16().collect();
    name.starts_with(prefix.as_slice())
}

/// The bare name of an ace tool, when the spelling is one of ace's.
fn ace_tool_name(name: &[u16]) -> Option<&[u16]> {
    let bare = bare_tool_name(name);
    if !is_tool_name(bare) {
        return None;
    }
    if has_prefix(name, "mcp__ace__") || has_prefix(name, "ace_") {
        return Some(bare);
    }
    for (prefix, names) in [("browser_", BROWSER), ("screen_", SCREEN), ("sim_", SIM)] {
        let encoded: Vec<u16> = prefix.encode_utf16().collect();
        if let Some(rest) = bare.strip_prefix(encoded.as_slice())
            && names.iter().any(|member| units_eq(rest, member))
        {
            return Some(bare);
        }
    }
    None
}

/// Whether the call ran one of ace's own tools, whose real error text shows.
pub(crate) fn is_ace_call(detail: &J, kind: &str, title: &[u16]) -> bool {
    if units_eq(
        string_or_empty(detail.get("kind").unwrap_or(&J::Null)),
        "mcp",
    ) {
        // A missing server counts as ace's, as the TypeScript reads it.
        let server = match detail.get("server") {
            Some(J::Str(server)) => server.as_slice(),
            _ => &[],
        };
        if !(server.is_empty() || units_eq(server, "ace") || units_eq(server, "unknown")) {
            return false;
        }
        let tool = string_or_empty(detail.get("tool").unwrap_or(&J::Null));
        return ace_tool_name(tool).is_some();
    }
    if !units_eq(
        string_or_empty(detail.get("kind").unwrap_or(&J::Null)),
        "custom",
    ) && kind != "custom"
    {
        return false;
    }
    ace_tool_name(title).is_some()
}

fn string_or_empty(value: &J) -> &[u16] {
    match value {
        J::Str(units) => units,
        _ => &[],
    }
}

/// Slice text to the first `max` UTF-16 code units, as the TypeScript does,
/// even mid-pair.
pub(crate) fn utf16_slice(text: &[u16], max: usize) -> Vec<u16> {
    text[..text.len().min(max)].to_vec()
}
