// SPDX-License-Identifier: Apache-2.0
//! The user message line this side writes: ace's object, field for field
//! (adapter-claude `session.ts:388`-`:401`).

use ace_json::{Map, Value};

/// One `stdin` user line. `content` is the message body (a string or a content-part array);
/// `priority` is `"now"` or `"next"`, and `synthetic` adds `isSynthetic: true` for ace's own
/// messages. Keys keep the order the TypeScript object writes them in.
pub fn user_message(
    uuid: &str,
    session_id: &str,
    content: Value,
    priority: &str,
    synthetic: bool,
) -> Value {
    let mut message = Map::with_capacity(2);
    message.insert("role", Value::from("user"));
    message.insert("content", content);
    let mut line = Map::with_capacity(7);
    line.insert("type", Value::from("user"));
    line.insert("uuid", Value::from(uuid));
    line.insert("session_id", Value::from(session_id));
    line.insert("parent_tool_use_id", Value::Null);
    line.insert("message", Value::Object(message));
    line.insert("priority", Value::from(priority));
    if synthetic {
        line.insert("isSynthetic", Value::Bool(true));
    }
    Value::Object(line)
}
