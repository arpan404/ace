// SPDX-License-Identifier: Apache-2.0
//! Deep payload rewriting (`attachment-payload.ts`). Native JSON can contain deeply nested
//! future fields, so the walk uses a heap stack and never the call stack. The visiting order is
//! the TypeScript's, because `replace` has effects: a container pushes its children forward and
//! the stack pops the last first, so siblings are visited last first.

use ace_json::{JsString, Value};

/// What a node of the rewritten payload is.
enum Node {
    Leaf(Value),
    Array(Vec<usize>),
    Object(Vec<(JsString, usize)>),
}

/// Where a node goes once it is finished.
enum Slot {
    Root,
    Child(usize, usize),
}

struct Task<'a> {
    source: &'a Value,
    key: JsString,
    slot: Slot,
}

/// Rewrite every string in `value` through `replace`, keeping each container's order.
pub fn attachment_payload(
    value: &Value,
    replace: &mut dyn FnMut(&str, &JsString) -> JsString,
) -> Value {
    let mut nodes: Vec<Node> = Vec::new();
    let mut stack: Vec<Task<'_>> = vec![Task {
        source: value,
        key: JsString::new(),
        slot: Slot::Root,
    }];
    let mut root = usize::MAX;
    while let Some(task) = stack.pop() {
        let id = nodes.len();
        match task.slot {
            Slot::Root => root = id,
            Slot::Child(parent, index) => {
                if let Some(Node::Array(children)) = nodes.get_mut(parent) {
                    children[index] = id;
                } else if let Some(Node::Object(children)) = nodes.get_mut(parent)
                    && let Some(slot) = children.get_mut(index)
                {
                    slot.1 = id;
                }
            }
        }
        match task.source {
            Value::String(text) => {
                nodes.push(Node::Leaf(Value::String(replace(&task.key, text))));
            }
            Value::Array(items) => {
                nodes.push(Node::Array(vec![usize::MAX; items.len()]));
                for (index, item) in items.iter().enumerate() {
                    stack.push(Task {
                        source: item,
                        key: JsString::new(),
                        slot: Slot::Child(id, index),
                    });
                }
            }
            Value::Object(map) => {
                let entries: Vec<(JsString, usize)> = map
                    .iter()
                    .map(|(key, _)| (key.clone(), usize::MAX))
                    .collect();
                nodes.push(Node::Object(entries));
                for (index, (key, item)) in map.iter().enumerate() {
                    stack.push(Task {
                        source: item,
                        key: key.clone(),
                        slot: Slot::Child(id, index),
                    });
                }
            }
            _ => nodes.push(Node::Leaf(task.source.clone())),
        }
    }
    // A child node is always created after its parent, so reverse order materialises children
    // before the containers that hold them.
    let count = nodes.len();
    let mut built: Vec<Option<Value>> = (0..count).map(|_| None).collect();
    for id in (0..count).rev() {
        let node = std::mem::replace(&mut nodes[id], Node::Leaf(Value::Null));
        let value = match node {
            Node::Leaf(value) => value,
            Node::Array(children) => Value::Array(
                children
                    .into_iter()
                    .map(|child| built[child].take().unwrap_or(Value::Null))
                    .collect::<Vec<Value>>()
                    .into(),
            ),
            Node::Object(children) => {
                let mut map = ace_json::Map::new();
                for (key, child) in children {
                    map.insert(key, built[child].take().unwrap_or(Value::Null));
                }
                Value::Object(map)
            }
        };
        built[id] = Some(value);
    }
    if root == usize::MAX {
        return Value::Null;
    }
    built[root].take().unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::attachment_payload;
    use ace_json::{JsString, Value, json};

    fn marks(key: &str, value: &JsString) -> JsString {
        JsString::from(format!("{key}:{}", value.as_str()))
    }

    #[test]
    fn a_string_in_an_array_gets_the_empty_key() {
        let value = json!(["a", "b"]);
        let replaced = attachment_payload(&value, &mut marks);
        assert_eq!(
            ace_json::to_string(&replaced),
            "[\":a\",\":b\"]".to_string()
        );
    }

    #[test]
    fn siblings_are_visited_last_first_and_the_output_keeps_its_order() {
        let value = json!({"first": "1", "second": {"inner": "2"}, "third": ["3"]});
        let mut order = Vec::new();
        let replaced = attachment_payload(&value, &mut |key, text| {
            order.push(format!("{key}={}", text.as_str()));
            JsString::from(text.as_str())
        });
        assert_eq!(
            order,
            vec![
                "=3".to_string(),
                "inner=2".to_string(),
                "first=1".to_string()
            ]
        );
        assert_eq!(
            ace_json::to_string(&replaced),
            ace_json::to_string(&value),
            "the output keeps the input order"
        );
    }

    #[test]
    fn a_deeply_nested_payload_is_walked_without_recursion() {
        let mut value = Value::String(JsString::from("leaf"));
        for _ in 0..100_000 {
            value = Value::Array(vec![value].into());
        }
        let replaced = attachment_payload(&value, &mut |_key, text| text.clone());
        let mut depth = 0;
        let mut node = &replaced;
        while let Value::Array(items) = node {
            depth += 1;
            match items.first() {
                Some(next) => node = next,
                None => break,
            }
        }
        assert_eq!(depth, 100_000);
    }
}
