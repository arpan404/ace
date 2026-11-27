// SPDX-License-Identifier: Apache-2.0
//! A live ace wait tool call marks its agent as waiting for the children it names
//! (`ace-waits.ts`, `packages/mcp-server/src/waits.ts:15`, E5.4b), so the parent reads
//! "Waiting on N subagents" rather than plain working. Delegated children appear in the parent
//! tree as `ace-child:<threadId>` summary agents; ids that are not children never become refs.

use ace_core::ThreadState;
use ace_core::item_model::ToolDetail;
use ace_core::items::Item;
use ace_json::Value;

/// `maxWaitThreads` (`packages/protocol/src/agent-monitor.ts:16`).
pub const MAX_WAIT_THREADS: usize = 64;
/// A waited-on thread id's longest text (`z.string().min(1).max(256)`).
const MAX_THREAD_ID: usize = 256;

fn valid_thread_id(value: &Value) -> bool {
    value.as_str().is_some_and(|id| {
        let units = id.encode_utf16().count();
        (1..=MAX_THREAD_ID).contains(&units)
    })
}

/// `aceWaitTargets`: the threads a live ace tool call blocks on, or `None` for another tool.
pub fn ace_wait_targets(name: &str, input: Option<&Value>) -> Option<Vec<String>> {
    let tool = ace_core::ace_tools::bare_tool_name(name);
    if tool == "wait" {
        let object = input?.as_object()?;
        let ids = object.get("threadIds")?.as_array()?;
        if ids.is_empty() || ids.len() > MAX_WAIT_THREADS || !ids.iter().all(valid_thread_id) {
            return None;
        }
        let mut targets: Vec<String> = Vec::with_capacity(ids.len());
        for id in ids {
            let id = id.as_str().unwrap_or_default();
            if !targets.iter().any(|seen| seen == id) {
                targets.push(id.to_owned());
            }
        }
        return Some(targets);
    }
    if tool == "delegate" {
        let object = input?.as_object()?;
        return match object.get("waitSeconds") {
            // A delegation that waits for the children it creates names none.
            Some(seconds) if seconds.as_f64().is_some() => Some(Vec::new()),
            Some(_) => None,
            None => None,
        };
    }
    None
}

/// `aceWaitFact`: the `subagents.waiting` fact for a live ace wait, once per item.
pub fn ace_wait_fact(state: &ThreadState, fact: &Value) -> Option<Value> {
    let kind = fact.get("type").and_then(Value::as_str)?;
    if kind != "item.upsert" && kind != "item.reconciled" {
        return None;
    }
    let item_key = fact.get("item").and_then(Value::as_str)?;
    let Item::ToolCall { call, .. } = state.items.get(item_key)? else {
        return None;
    };
    if call.status != "running" && call.status != "pending" {
        return None;
    }
    if state
        .item_links
        .get(item_key)
        .is_some_and(|link| link.waiting_for.is_some())
    {
        return None;
    }
    let ToolDetail::Mcp {
        server,
        tool,
        arguments,
        ..
    } = &call.detail
    else {
        return None;
    };
    if server != "ace" {
        return None;
    }
    let arguments = arguments.as_ref().map(ace_json::Raw::to_value);
    let targets = ace_wait_targets(tool, arguments.as_ref())?;
    let mut waiting = ace_json::Map::new();
    waiting.insert("type", Value::from("subagents.waiting"));
    waiting.insert(
        "agent",
        Value::from(
            fact.get("agent")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
    );
    waiting.insert("item", Value::from(item_key));
    waiting.insert(
        "targets",
        Value::Array(
            targets
                .into_iter()
                .map(|id| Value::from(format!("ace-child:{id}").as_str()))
                .collect(),
        ),
    );
    Some(Value::Object(waiting))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn a_wait_keeps_its_first_seen_targets_and_a_delegate_with_a_wait_names_none() {
        let arguments = value(r#"{"threadIds":["t1","t1","t2"]}"#);
        assert_eq!(
            ace_wait_targets("ace_wait", Some(&arguments)),
            Some(vec!["t1".into(), "t2".into()])
        );
        assert_eq!(
            ace_wait_targets("delegate", Some(&value(r#"{"waitSeconds":30}"#))),
            Some(Vec::new())
        );
        assert_eq!(
            ace_wait_targets("delegate", Some(&value(r#"{"waitSeconds":"30"}"#))),
            None
        );
        assert_eq!(ace_wait_targets("delegate", Some(&value("{}"))), None);
        assert_eq!(ace_wait_targets("context", Some(&arguments)), None);
        // An id past 256 code units, or an empty list, is not a valid wait.
        let too_long = format!(r#"{{"threadIds":["{}"]}}"#, "x".repeat(257));
        assert_eq!(ace_wait_targets("wait", Some(&value(&too_long))), None);
        assert_eq!(
            ace_wait_targets("wait", Some(&value(r#"{"threadIds":[]}"#))),
            None
        );
    }
}
