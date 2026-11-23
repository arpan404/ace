// SPDX-License-Identifier: Apache-2.0
//! `turn.steps`, as `long-thread/steps.ts` reads it.

use super::common::{LongError, all_rows, as_count, get_row, invalid, row_value};
use crate::{Connection, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

fn site_origin(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    let (protocol, rest) = if lower.starts_with("https://") {
        ("https://", &url[8..])
    } else if lower.starts_with("http://") {
        ("http://", &url[7..])
    } else {
        return None;
    };
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host_port.is_empty() {
        return None;
    }
    let host = host_port.split('@').next_back().unwrap_or("");
    let (host, port) = match host.rsplit_once(':') {
        Some((host, port)) => {
            if port.chars().all(|ch| ch.is_ascii_digit()) && !port.is_empty() && port.len() <= 5 {
                (host, Some(port))
            } else {
                (host_port, None)
            }
        }
        None => (host_port, None),
    };
    let host_lower = host.to_ascii_lowercase();
    if host_lower.is_empty() || host_lower.len() > 253 {
        return None;
    }
    if !host_lower
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
    {
        return None;
    }
    if host_lower.starts_with('.') || host_lower.starts_with('-') {
        return None;
    }
    let mut origin = format!("{protocol}{host_lower}");
    if let Some(port) = port {
        origin.push(':');
        origin.push_str(port);
    }
    if origin.len() > 512 {
        return None;
    }
    Some(origin)
}

fn contains_browser(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut index = 0;
    while let Some(found) = lower[index..].find("browser") {
        let start = index + found;
        let end = start + 7;
        let before = if start == 0 {
            None
        } else {
            Some(bytes[start - 1] as char)
        };
        let after = bytes.get(end).map(|byte| *byte as char);
        let before_ok = before.is_none_or(|ch| !ch.is_ascii_lowercase());
        let after_ok = after.is_none_or(|ch| !ch.is_ascii_lowercase());
        if before_ok && after_ok {
            return true;
        }
        index = start + 1;
    }
    false
}

fn contains_screen(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    for keyword in ["screen", "computer"] {
        let mut index = 0;
        while let Some(found) = lower[index..].find(keyword) {
            let start = index + found;
            let end = start + keyword.len();
            let before = if start == 0 {
                None
            } else {
                Some(lower.as_bytes()[start - 1] as char)
            };
            let after = lower.as_bytes().get(end).map(|byte| *byte as char);
            let before_ok = before.is_none_or(|ch| !ch.is_ascii_lowercase());
            let after_ok = after.is_some_and(|ch| matches!(ch, '_' | '.' | '-'));
            if before_ok && after_ok {
                return true;
            }
            index = start + 1;
        }
    }
    false
}

fn field(arguments: &serde_json::Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_owned())
}

fn tool_surface(call: &serde_json::Value, carried: Option<&str>) -> Option<serde_json::Value> {
    let result_target = call.get("result").and_then(|result| result.get("target"));
    if let Some(target) = result_target
        && let Some(bundle) = target.get("bundleId").and_then(|value| value.as_str())
        && !bundle.is_empty()
        && bundle.len() <= 1024
    {
        let mut icon = serde_json::Map::new();
        icon.insert(
            "kind".to_owned(),
            serde_json::Value::String("app".to_owned()),
        );
        icon.insert(
            "identity".to_owned(),
            serde_json::Value::String(bundle.to_owned()),
        );
        if let Some(name) = target.get("displayName").and_then(|value| value.as_str()) {
            icon.insert(
                "name".to_owned(),
                serde_json::Value::String(name.to_owned()),
            );
        }
        let mut surface = serde_json::Map::new();
        surface.insert(
            "kind".to_owned(),
            serde_json::Value::String("computer".to_owned()),
        );
        surface.insert("icon".to_owned(), serde_json::Value::Object(icon));
        return Some(serde_json::Value::Object(surface));
    }
    let detail = call.get("detail")?;
    let kind = detail.get("kind").and_then(|value| value.as_str())?;
    if kind == "web.fetch" {
        let url = detail.get("url").and_then(|value| value.as_str())?;
        let origin = site_origin(url)?;
        let mut icon = serde_json::Map::new();
        icon.insert(
            "kind".to_owned(),
            serde_json::Value::String("site".to_owned()),
        );
        icon.insert("origin".to_owned(), serde_json::Value::String(origin));
        let mut surface = serde_json::Map::new();
        surface.insert(
            "kind".to_owned(),
            serde_json::Value::String("browser".to_owned()),
        );
        surface.insert("icon".to_owned(), serde_json::Value::Object(icon));
        return Some(serde_json::Value::Object(surface));
    }
    let title = call
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let name = if kind == "mcp" {
        detail.get("tool").and_then(|value| value.as_str())
    } else if kind == "custom" || kind == "browser" {
        Some(title)
    } else {
        None
    };
    let arguments = if kind == "mcp" {
        detail.get("arguments")
    } else {
        None
    };
    if let Some(name) = name
        && contains_screen(name)
    {
        let args = arguments.cloned().unwrap_or(serde_json::Value::Null);
        let app = field(&args, "app");
        let bundle = field(&args, "bundleId").or_else(|| {
            app.clone().filter(|app| {
                app.len() <= 1024
                    && app.split('.').count() >= 2
                    && app
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
            })
        });
        if let Some(bundle) = bundle
            && bundle.len() <= 1024
            && !bundle.is_empty()
        {
            let mut icon = serde_json::Map::new();
            icon.insert(
                "kind".to_owned(),
                serde_json::Value::String("app".to_owned()),
            );
            icon.insert("identity".to_owned(), serde_json::Value::String(bundle));
            let mut surface = serde_json::Map::new();
            surface.insert(
                "kind".to_owned(),
                serde_json::Value::String("computer".to_owned()),
            );
            surface.insert("icon".to_owned(), serde_json::Value::Object(icon));
            return Some(serde_json::Value::Object(surface));
        }
        let mut surface = serde_json::Map::new();
        surface.insert(
            "kind".to_owned(),
            serde_json::Value::String("computer".to_owned()),
        );
        return Some(serde_json::Value::Object(surface));
    }
    let is_browser = kind == "browser" || name.is_some_and(contains_browser);
    if is_browser {
        let url = arguments.and_then(|args| field(args, "url"));
        let origin = url
            .as_deref()
            .and_then(site_origin)
            .or_else(|| carried.map(|origin| origin.to_owned()));
        let mut surface = serde_json::Map::new();
        surface.insert(
            "kind".to_owned(),
            serde_json::Value::String("browser".to_owned()),
        );
        if let Some(origin) = origin {
            let mut icon = serde_json::Map::new();
            icon.insert(
                "kind".to_owned(),
                serde_json::Value::String("site".to_owned()),
            );
            icon.insert("origin".to_owned(), serde_json::Value::String(origin));
            surface.insert("icon".to_owned(), serde_json::Value::Object(icon));
        }
        return Some(serde_json::Value::Object(surface));
    }
    None
}

fn step_item(
    conn: &Arc<Connection>,
    thread_id: &str,
    item_id: &str,
) -> Result<Option<serde_json::Value>, LongError> {
    let head = get_row(
        conn,
        "SELECT item_type FROM item_heads WHERE thread_id=? AND id=?",
        vec![
            Value::Text(thread_id.to_owned()),
            Value::Text(item_id.to_owned()),
        ],
    )?;
    let head = match head {
        None => return Ok(None),
        Some(head) => head,
    };
    let item_type = match row_value(&head, "item_type")? {
        Value::Text(text) => text.clone(),
        _ => return Err(invalid("invalid index row")),
    };
    if item_type == "message" || item_type == "notice" || item_type == "reasoning" {
        let row = get_row(
            conn,
            "SELECT item FROM item_previews WHERE id=?",
            vec![Value::Text(item_id.to_owned())],
        )?;
        if let Some(row) = row {
            let text = match row_value(&row, "item")? {
                Value::Text(text) => text.clone(),
                _ => return Err(invalid("invalid index row")),
            };
            let value: serde_json::Value =
                serde_json::from_str(&text).map_err(|_| invalid("invalid index row"))?;
            return Ok(Some(value));
        }
        return Ok(None);
    }
    let row = get_row(
        conn,
        "SELECT item FROM items WHERE id=? AND thread_id=?",
        vec![
            Value::Text(item_id.to_owned()),
            Value::Text(thread_id.to_owned()),
        ],
    )?;
    if let Some(row) = row {
        let text = match row_value(&row, "item")? {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| invalid("invalid index row"))?;
        return Ok(Some(value));
    }
    Ok(None)
}

fn light_item(mut item: serde_json::Value) -> serde_json::Value {
    if let Some(object) = item.as_object_mut() {
        let is_tool = object.get("type").and_then(|value| value.as_str()) == Some("tool_call");
        if is_tool && let Some(call) = object.get_mut("call").and_then(|call| call.as_object_mut())
        {
            let kind = call
                .get("detail")
                .and_then(|detail| detail.get("kind"))
                .and_then(|kind| kind.as_str())
                .unwrap_or("");
            let raw_empty = call
                .get("raw")
                .and_then(|raw| raw.as_array())
                .is_none_or(|raw| raw.is_empty());
            if kind != "custom" && !raw_empty {
                call.insert("raw".to_owned(), serde_json::Value::Array(Vec::new()));
            }
        }
    }
    item
}

fn site_before(
    conn: &Arc<Connection>,
    thread_id: &str,
    ordinal: i64,
    agent_id: Option<&str>,
    seq: i64,
) -> Result<Option<String>, LongError> {
    let agent_param = match agent_id {
        Some(agent) => Value::Text(agent.to_owned()),
        None => Value::Null,
    };
    // SQLite `IS ?` matches NULL, so an agent-less step finds agent-less history.
    let rows = all_rows(
        conn,
        "SELECT i.item_id FROM long_items i JOIN item_heads h ON h.id=i.item_id AND h.thread_id=i.thread_id WHERE i.thread_id=? AND i.ordinal=? AND i.agent_id IS ? AND i.created_seq<? AND h.item_type='tool_call' ORDER BY i.created_seq DESC LIMIT 16",
        vec![
            Value::Text(thread_id.to_owned()),
            Value::Integer(ordinal),
            agent_param,
            Value::Integer(seq),
        ],
    )?;
    for row in rows {
        let item_id = match row.get("item_id") {
            Some(Value::Text(text)) => text.clone(),
            _ => continue,
        };
        if let Some(item) = step_item(conn, thread_id, &item_id)? {
            let call = match item.get("call") {
                Some(call) => call.clone(),
                None => continue,
            };
            if let Some(surface) = tool_surface(&call, None)
                && let Some(icon) = surface.get("icon")
                && icon.get("kind").and_then(|kind| kind.as_str()) == Some("site")
                && let Some(origin) = icon.get("origin").and_then(|origin| origin.as_str())
            {
                return Ok(Some(origin.to_owned()));
            }
        }
    }
    Ok(None)
}

#[allow(clippy::too_many_arguments)]
pub fn turn_steps(
    conn: &Arc<Connection>,
    thread_id: &str,
    turn_ordinal: i64,
    after: Option<i64>,
    limit: i64,
    request_id: &str,
    head_seq: i64,
) -> Result<String, LongError> {
    if !(1..=200).contains(&limit) {
        return Err(invalid("search_invalid_query"));
    }
    if turn_ordinal < 1 {
        return Err(invalid("turn_target_unavailable"));
    }
    let turn = get_row(
        conn,
        "SELECT end_seq FROM long_turns WHERE thread_id=? AND ordinal=?",
        vec![
            Value::Text(thread_id.to_owned()),
            Value::Integer(turn_ordinal),
        ],
    )?
    .ok_or_else(|| invalid("turn_target_unavailable"))?;
    let end_seq = match row_value(&turn, "end_seq")? {
        Value::Integer(n) => *n,
        Value::Real(n) => *n as i64,
        _ => return Err(invalid("invalid index row")),
    };
    as_count(&Value::Integer(end_seq))?;
    let after_seq = after.unwrap_or(0);
    let rows = all_rows(
        conn,
        "SELECT item_id,created_seq FROM long_items WHERE thread_id=? AND ordinal=? AND created_seq>? AND (role IS NULL OR role<>'user') ORDER BY created_seq LIMIT ?",
        vec![
            Value::Text(thread_id.to_owned()),
            Value::Integer(turn_ordinal),
            Value::Integer(after_seq),
            Value::Integer(limit + 1),
        ],
    )?;
    let mut steps: Vec<(i64, serde_json::Value)> = Vec::new();
    let mut bytes = 512usize;
    for row in rows.iter().take(limit as usize) {
        let item_id = match row_value(row, "item_id")? {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        let seq = match row_value(row, "created_seq")? {
            Value::Integer(n) => *n,
            Value::Real(n) => *n as i64,
            _ => return Err(invalid("invalid index row")),
        };
        let item = match step_item(conn, thread_id, &item_id)? {
            None => continue,
            Some(item) => item,
        };
        let light = light_item(item);
        let mut step = serde_json::Map::new();
        step.insert("seq".to_owned(), serde_json::Value::Number(seq.into()));
        step.insert("item".to_owned(), light);
        let size = serde_json::to_string(&serde_json::Value::Object(step.clone()))
            .map_err(|error| invalid(&error.to_string()))?
            .len();
        if !steps.is_empty() && bytes + size > 1024 * 1024 {
            break;
        }
        bytes += size;
        let item = step.remove("item").unwrap_or(serde_json::Value::Null);
        steps.push((seq, item));
    }
    let items: Vec<serde_json::Value> = steps.iter().map(|(_, item)| item.clone()).collect();
    let mut sites: BTreeMap<String, String> = BTreeMap::new();
    let mut surfaces: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for item in &items {
        let id = item.get("id").and_then(|id| id.as_str()).unwrap_or("");
        let agent = item
            .get("agentId")
            .and_then(|agent| agent.as_str())
            .unwrap_or("")
            .to_owned();
        let call = match item.get("call") {
            Some(call) => call.clone(),
            None => continue,
        };
        let carried = sites.get(&agent).map(|origin| origin.as_str());
        if let Some(surface) = tool_surface(&call, carried) {
            surfaces.insert(id.to_owned(), surface.clone());
            if let Some(icon) = surface.get("icon")
                && icon.get("kind").and_then(|kind| kind.as_str()) == Some("site")
                && let Some(origin) = icon.get("origin").and_then(|origin| origin.as_str())
            {
                sites.insert(agent, origin.to_owned());
            }
        }
    }
    let first = steps.first().map(|(seq, _)| *seq);
    if after.is_some()
        && let Some(first_seq) = first
    {
        let mut carried: BTreeMap<String, String> = BTreeMap::new();
        for (index, item) in items.iter().enumerate() {
            let id = item.get("id").and_then(|id| id.as_str()).unwrap_or("");
            let agent = item
                .get("agentId")
                .and_then(|agent| agent.as_str())
                .unwrap_or("")
                .to_owned();
            let surface = surfaces.get(id);
            let needs = matches!(
                surface
                    .and_then(|surface| surface.get("kind"))
                    .and_then(|kind| kind.as_str()),
                Some("browser")
            ) && surface.and_then(|surface| surface.get("icon")).is_none()
                && !carried.contains_key(&agent);
            if needs {
                let agent_opt = if agent.is_empty() {
                    None
                } else {
                    Some(agent.as_str())
                };
                if let Some(origin) =
                    site_before(conn, thread_id, turn_ordinal, agent_opt, first_seq)?
                {
                    carried.insert(agent.clone(), origin);
                }
            }
            let _ = index;
        }
        if !carried.is_empty() {
            sites = BTreeMap::new();
            for (agent, origin) in &carried {
                sites.insert(agent.clone(), origin.clone());
            }
            surfaces.clear();
            for item in &items {
                let id = item.get("id").and_then(|id| id.as_str()).unwrap_or("");
                let agent = item
                    .get("agentId")
                    .and_then(|agent| agent.as_str())
                    .unwrap_or("")
                    .to_owned();
                let call = match item.get("call") {
                    Some(call) => call.clone(),
                    None => continue,
                };
                let carried_origin = sites.get(&agent).map(|origin| origin.as_str());
                if let Some(surface) = tool_surface(&call, carried_origin) {
                    surfaces.insert(id.to_owned(), surface.clone());
                    if let Some(icon) = surface.get("icon")
                        && icon.get("kind").and_then(|kind| kind.as_str()) == Some("site")
                        && let Some(origin) = icon.get("origin").and_then(|origin| origin.as_str())
                    {
                        sites.insert(agent, origin.to_owned());
                    }
                }
            }
        }
    }
    let mut out_steps = Vec::new();
    for (seq, item) in steps {
        let id = item
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or("")
            .to_owned();
        let mut step = serde_json::Map::new();
        step.insert("seq".to_owned(), serde_json::Value::Number(seq.into()));
        step.insert("item".to_owned(), item);
        if let Some(surface) = surfaces.get(&id) {
            step.insert("surface".to_owned(), surface.clone());
        }
        out_steps.push(serde_json::Value::Object(step));
    }
    let last = out_steps
        .last()
        .and_then(|step| step.get("seq"))
        .and_then(|seq| seq.as_i64());
    let more = (out_steps.len() as i64) < (rows.len() as i64);
    let mut response = serde_json::Map::new();
    response.insert(
        "type".to_owned(),
        serde_json::Value::String("turn.steps".to_owned()),
    );
    response.insert(
        "requestId".to_owned(),
        serde_json::Value::String(request_id.to_owned()),
    );
    response.insert(
        "threadId".to_owned(),
        serde_json::Value::String(thread_id.to_owned()),
    );
    response.insert(
        "turnOrdinal".to_owned(),
        serde_json::Value::Number(turn_ordinal.into()),
    );
    response.insert("seq".to_owned(), serde_json::Value::Number(head_seq.into()));
    response.insert(
        "endSeq".to_owned(),
        serde_json::Value::Number(end_seq.into()),
    );
    response.insert("steps".to_owned(), serde_json::Value::Array(out_steps));
    response.insert(
        "after".to_owned(),
        if more {
            last.map_or(serde_json::Value::Null, |seq| {
                serde_json::Value::Number(seq.into())
            })
        } else {
            serde_json::Value::Null
        },
    );
    let text = serde_json::to_string(&serde_json::Value::Object(response))
        .map_err(|error| invalid(&error.to_string()))?;
    Ok(text)
}
