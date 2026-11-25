// SPDX-License-Identifier: Apache-2.0
//! Delta coalescing (`delta-batch.ts`). Only adjacent appends merge, and every other boundary is
//! kept, so a batch of deltas never grows the transcript it is folded into.

use ace_json::{JsString, Value};

/// The cap one run of merged appends may reach, in UTF-8 bytes.
const MAX_MERGED_BYTES: usize = 4096;

fn field<'a>(fact: &'a Value, name: &str) -> Option<&'a Value> {
    match fact {
        Value::Object(map) => map.get(name),
        _ => None,
    }
}

fn kind(fact: &Value) -> Option<&str> {
    match field(fact, "type") {
        Some(Value::String(text)) => Some(text.as_str()),
        _ => None,
    }
}

/// `a === b` for two optional properties: absent is `undefined`, which equals only itself.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn same_field(left: &Value, right: &Value, name: &str) -> bool {
    same(field(left, name), field(right, name))
}

fn append(fact: &Value) -> Option<&JsString> {
    match field(fact, "append") {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

fn merged_bytes(left: &Value, right: &Value) -> Option<usize> {
    let left = append(left)?;
    let right = append(right)?;
    Some(crate::frames::utf8_len(left) + crate::frames::utf8_len(right))
}

fn mergeable(left: &Value, right: &Value) -> bool {
    kind(left) == Some("item.delta")
        && kind(right) == Some("item.delta")
        && same_field(left, right, "agent")
        && same_field(left, right, "item")
        && same_field(left, right, "field")
        && merged_bytes(left, right).is_some_and(|bytes| bytes <= MAX_MERGED_BYTES)
}

/// Merge adjacent appends up to 4096 bytes, dropping a transport signal only where it is the
/// deltas' own agent's, and keeping every other boundary.
pub fn coalesce_facts(facts: &[Value]) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::with_capacity(facts.len());
    for (index, fact) in facts.iter().enumerate() {
        let previous = result.last();
        let next = facts.get(index + 1);
        // Codex and Claude put a transport signal before each delta. The first signal already
        // covers this same-clock run of appends; retain it and all other boundaries.
        if kind(fact) == Some("signal")
            && let (Some(previous), Some(next)) = (previous, next)
            && mergeable(previous, next)
            && same(field(fact, "agent"), field(previous, "agent"))
        {
            continue;
        }
        if let Some(previous) = previous
            && mergeable(previous, fact)
            && let Value::Object(mut merged) = previous.clone()
        {
            // An `ace_json::Map` insert on an existing key keeps its position, so the merged
            // fact's key order is the previous one's.
            let mut text = append(previous).cloned().unwrap_or_default();
            if let Some(more) = append(fact) {
                text.push_js(more);
            }
            merged.insert("append", Value::String(text));
            result.pop();
            result.push(Value::Object(merged));
            continue;
        }
        result.push(fact.clone());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::coalesce_facts;
    use ace_json::{JsString, Value, json};

    fn delta(agent: &str, append: &str) -> Value {
        match json!({
            "type": "item.delta",
            "agent": agent,
            "item": "message",
            "field": "text",
            "append": append,
        }) {
            Value::Object(map) => Value::Object(map),
            _ => unreachable!(),
        }
    }

    fn signal(agent: Option<&str>) -> Value {
        match agent {
            Some(agent) => json!({"type": "signal", "agent": agent}),
            None => json!({"type": "signal"}),
        }
    }

    fn append_of(fact: &Value) -> String {
        match fact {
            Value::Object(map) => match map.get("append") {
                Some(Value::String(text)) => text.to_string_lossy().into_owned(),
                _ => String::new(),
            },
            _ => String::new(),
        }
    }

    fn keys(fact: &Value) -> Vec<String> {
        match fact {
            Value::Object(map) => map
                .keys()
                .map(|key| key.to_string_lossy().into_owned())
                .collect(),
            _ => Vec::new(),
        }
    }

    #[test]
    fn adjacent_deltas_merge_up_to_4096_bytes_and_keep_the_previous_facts_key_order() {
        let first = match json!({"type": "item.delta", "agent": "root", "item": "message",
            "field": "text", "append": "a"})
        {
            Value::Object(map) => Value::Object(map),
            _ => unreachable!(),
        };
        let facts = vec![first.clone(), delta("root", "b")];
        let merged = coalesce_facts(&facts);
        assert_eq!(merged.len(), 1);
        assert_eq!(append_of(&merged[0]), "ab");
        assert_eq!(keys(&merged[0]), keys(&first));
        let crowded = vec![
            delta("root", &"x".repeat(4000)),
            delta("root", &"y".repeat(200)),
        ];
        assert_eq!(
            coalesce_facts(&crowded).len(),
            2,
            "the bound stops the merge"
        );
    }

    #[test]
    fn a_signal_between_two_mergeable_deltas_is_dropped_only_when_it_is_their_agents() {
        let same = vec![delta("root", "a"), signal(Some("root")), delta("root", "b")];
        let merged = coalesce_facts(&same);
        assert_eq!(merged.len(), 1);
        let other = vec![
            delta("root", "a"),
            signal(Some("child")),
            delta("root", "b"),
        ];
        let kept = coalesce_facts(&other);
        // The other agent's signal is kept, and it breaks the run: three facts remain.
        assert_eq!(kept.len(), 3, "another agent's signal is kept");
        assert_eq!(append_of(&kept[0]), "a");
        let agentless = vec![delta("root", "a"), signal(None), delta("root", "b")];
        assert_eq!(
            coalesce_facts(&agentless).len(),
            3,
            "a signal with no agent is kept"
        );
    }

    #[test]
    fn a_lone_surrogate_append_counts_three_bytes_toward_the_bound() {
        let lone = JsString::from_units(&[0xd800]);
        let previous = match json!({
            "type": "item.delta", "agent": "root", "item": "message", "field": "text",
            "append": Value::String(JsString::from("é").clone()),
        }) {
            Value::Object(map) => Value::Object(map),
            _ => unreachable!(),
        };
        // 2 bytes for "é" plus 4095 more is over the bound once a three-byte surrogate joins.
        let mut wide = match previous {
            Value::Object(mut map) => {
                let mut text = JsString::from("é");
                for _ in 0..4094 {
                    text.push_str("a");
                }
                map.insert("append", Value::String(text));
                Value::Object(map)
            }
            _ => unreachable!(),
        };
        let mut next = delta("root", "z");
        if let Value::Object(map) = &mut next {
            map.insert("append", Value::String(lone.clone()));
        }
        assert_eq!(coalesce_facts(&[wide.clone(), next.clone()]).len(), 2);
        if let Value::Object(map) = &mut wide {
            map.insert("append", Value::String(JsString::from("é")));
        }
        assert_eq!(coalesce_facts(&[wide, next]).len(), 1);
    }
}
