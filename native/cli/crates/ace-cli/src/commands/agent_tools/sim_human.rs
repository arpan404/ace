// SPDX-License-Identifier: Apache-2.0
//! The short human form of an `ace sim` result. Ports
//! `apps/daemon/src/cli/sim-human.ts` exactly; anything unrecognised stays JSON.

use super::sim_args::SimVerb;

fn js_string(value: &str) -> String {
    match serde_json::to_string(value) {
        Ok(quoted) => quoted,
        Err(_) => format!("\"{value}\""),
    }
}

fn json_fallback(data: &serde_json::Value) -> String {
    match serde_json::to_string(data) {
        Ok(text) => text,
        Err(_) => "null".to_owned(),
    }
}

fn js_number(value: &serde_json::Value) -> Option<String> {
    if let Some(int) = value.as_i64() {
        return Some(int.to_string());
    }
    if let Some(uint) = value.as_u64() {
        return Some(uint.to_string());
    }
    value
        .as_f64()
        .map(|float| json_fallback(&serde_json::Value::from(float)))
}

struct Node {
    reference: Option<String>,
    role: String,
    name: String,
    value: Option<String>,
    children: Vec<Node>,
}

fn parse_node(data: &serde_json::Value) -> Option<Node> {
    let role = data.get("role")?.as_str()?.to_owned();
    let name = data.get("name")?.as_str()?.to_owned();
    let children: Vec<Node> = data
        .get("children")?
        .as_array()?
        .iter()
        .map(parse_node)
        .collect::<Option<Vec<_>>>()?;
    Some(Node {
        reference: data
            .get("ref")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        role,
        name,
        value: data
            .get("value")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        children,
    })
}

fn outline(nodes: &[Node], depth: usize, lines: &mut Vec<String>) {
    for node in nodes {
        let mut parts: Vec<String> = Vec::new();
        if let Some(reference) = &node.reference {
            parts.push(reference.clone());
        }
        parts.push(node.role.clone());
        if !node.name.is_empty() {
            parts.push(js_string(&node.name));
        }
        if let Some(value) = &node.value
            && value != &node.name
        {
            parts.push(format!("= {}", js_string(value)));
        }
        lines.push(format!("{}{}", "  ".repeat(depth), parts.join(" ")));
        outline(&node.children, depth + 1, lines);
    }
}

/// The short human form of an `ace sim` result; anything unrecognised stays JSON.
#[allow(
    clippy::too_many_lines,
    reason = "one verb table, mirroring sim-human.ts in order"
)]
#[must_use]
pub fn sim_human(verb: SimVerb, data: &serde_json::Value) -> String {
    let fallback = || json_fallback(data);
    match verb {
        SimVerb::List => {
            let Some(devices) = data.get("devices").and_then(serde_json::Value::as_array) else {
                return fallback();
            };
            let mut lines = Vec::new();
            for device in devices {
                let (Some(id), Some(name), Some(state)) = (
                    device.get("id").and_then(serde_json::Value::as_str),
                    device.get("name").and_then(serde_json::Value::as_str),
                    device.get("state").and_then(serde_json::Value::as_str),
                ) else {
                    return fallback();
                };
                lines.push(format!("{id}  {name}  {state}"));
            }
            if lines.is_empty() {
                return "No simulators or emulators.".to_owned();
            }
            lines.join("\n")
        }
        SimVerb::Start | SimVerb::Stop => {
            let (Some(sim_id), Some(name), Some(lifecycle), Some(controller)) = (
                data.get("simId").and_then(serde_json::Value::as_str),
                data.get("name").and_then(serde_json::Value::as_str),
                data.get("lifecycle").and_then(serde_json::Value::as_str),
                data.get("controller").and_then(serde_json::Value::as_str),
            ) else {
                return fallback();
            };
            let first = format!("{sim_id} {name}: {lifecycle}, controller {controller}");
            match data.get("guide").and_then(serde_json::Value::as_str) {
                Some(guide) if !guide.is_empty() => format!("{first}\n{guide}"),
                _ => first,
            }
        }
        SimVerb::Ui => {
            let (Some(nodes), Some(truncated)) = (
                data.get("nodes").and_then(serde_json::Value::as_array),
                data.get("truncated").and_then(serde_json::Value::as_bool),
            ) else {
                return fallback();
            };
            let parsed: Vec<Node> = nodes
                .iter()
                .map(parse_node)
                .collect::<Option<Vec<_>>>()
                .unwrap_or_default();
            if parsed.len() != nodes.len() {
                return fallback();
            }
            let mut lines: Vec<String> = Vec::new();
            outline(&parsed, 0, &mut lines);
            if truncated {
                lines.push("(truncated: narrow with a NAME, --text or --role)".to_owned());
            }
            if lines.is_empty() {
                return "No elements.".to_owned();
            }
            lines.join("\n")
        }
        SimVerb::Act => {
            let clipboard = match (
                data.get("text").and_then(serde_json::Value::as_str),
                data.get("truncated").and_then(serde_json::Value::as_bool),
            ) {
                (Some(text), Some(truncated)) => Some(if truncated {
                    format!("{text}\n(truncated)")
                } else {
                    text.to_owned()
                }),
                _ => None,
            };
            if let Some(line) = clipboard {
                return line;
            }
            match (
                data.get("ref").and_then(serde_json::Value::as_str),
                data.get("role").and_then(serde_json::Value::as_str),
                data.get("name").and_then(serde_json::Value::as_str),
            ) {
                (Some(reference), Some(role), Some(name)) => {
                    if name.is_empty() {
                        format!("ok {reference} {role}")
                    } else {
                        format!("ok {reference} {role} {}", js_string(name))
                    }
                }
                _ => "ok".to_owned(),
            }
        }
        SimVerb::Screenshot => {
            let (Some(path), Some(width), Some(height), Some(scale)) = (
                data.get("path").and_then(serde_json::Value::as_str),
                data.get("width").and_then(js_number),
                data.get("height").and_then(js_number),
                data.get("scale").and_then(js_number),
            ) else {
                return fallback();
            };
            format!("{path} ({width}x{height}; divide pixels by {scale} for points)")
        }
        SimVerb::Logs => {
            let Some(lines) = data.get("lines").and_then(serde_json::Value::as_array) else {
                return fallback();
            };
            let mut texts = Vec::new();
            for line in lines {
                let Some(text) = line.as_str() else {
                    return fallback();
                };
                texts.push(text.to_owned());
            }
            texts.join("\n")
        }
    }
}

/// What `--quiet` prints for a value: its identifiers, one per line.
/// Ports `apps/daemon/src/cli/render/generic.ts` `identifiers` exactly.
#[must_use]
pub fn identifiers(data: &serde_json::Value) -> Vec<String> {
    if let Some(list) = data.as_array() {
        let mut out = Vec::new();
        for item in list {
            out.extend(identifiers(item).into_iter().take(1));
        }
        return out;
    }
    let Some(record) = data.as_object() else {
        return Vec::new();
    };
    for key in ["threadId", "id", "requestId", "ref", "planId", "path"] {
        if let Some(text) = record.get(key).and_then(serde_json::Value::as_str) {
            return vec![text.to_owned()];
        }
    }
    for value in record.values() {
        if value.as_array().is_some_and(|list| !list.is_empty()) {
            return identifiers(value);
        }
    }
    Vec::new()
}
