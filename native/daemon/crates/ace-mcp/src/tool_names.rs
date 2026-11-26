// SPDX-License-Identifier: Apache-2.0
//! Tool names, ported from `packages/mcp-server/src/tool-names.ts` and
//! `packages/provider-kit/src/ace-tool-names.ts`.
//!
//! ace's server is named `ace`, so every provider already namespaces its tools
//! (`mcp__ace__context`, `ace_context`); a registered name is bare, and every spelling resolves
//! to one tool. `tools_call` dispatches to its target, and approvals and transcripts read a
//! dispatched call as the tool it ran.

use ace_json::Value;

/// Finds ace tools for a task, listed to every client.
pub const ACE_TOOL_SEARCH: &str = "tools_find";
/// Runs any ace tool by name, for clients that never reload their tool list.
pub const ACE_TOOL_DISPATCH: &str = "tools_call";

/// A registered name: bare lowercase snake case (`tool-names.ts:20`).
pub fn valid_tool_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 101 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .skip(1)
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// `bareToolName`: the registered name of any provider spelling, including a toolkit's old
/// `ace_` prefix.
pub fn bare_tool_name(name: &str) -> String {
    let mut bare = name.strip_prefix("mcp__ace__").unwrap_or(name);
    while let Some(rest) = bare.strip_prefix("ace_") {
        bare = rest;
    }
    bare.to_owned()
}

/// `defaultToolset`: the family of a toolkit that names its tools by family, else none.
pub fn default_toolset(name: &str) -> Option<&'static str> {
    let bare = bare_tool_name(name);
    if bare.starts_with("browser_") {
        return Some("ace-browser");
    }
    if bare.starts_with("screen_") || bare.starts_with("sim_") {
        return Some("ace-computer-use");
    }
    None
}

/// `defaultToolTitle`: `thread_read` reads "Thread read".
pub fn default_tool_title(name: &str) -> String {
    let words = bare_tool_name(name).replace('_', " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// The call a `tools_call` runs. Any other call, a malformed dispatch, or one naming a meta tool
/// comes back as it went.
pub struct DispatchedCall {
    pub name: String,
    pub input: Value,
}

pub fn dispatched_ace_call(name: &str, input: &Value) -> DispatchedCall {
    let unchanged = || DispatchedCall {
        name: name.to_owned(),
        input: input.clone(),
    };
    if bare_tool_name(name) != ACE_TOOL_DISPATCH {
        return unchanged();
    }
    let Some(object) = input.as_object() else {
        return unchanged();
    };
    let Some(target) = object.get("name").and_then(Value::as_str) else {
        return unchanged();
    };
    let bare = bare_tool_name(target);
    if bare == ACE_TOOL_DISPATCH || bare == ACE_TOOL_SEARCH {
        return unchanged();
    }
    // `arguments ?? {}`: absent or null is an empty object.
    let args = match object.get("arguments") {
        Some(value) if !value.is_null() => value.clone(),
        _ => Value::Object(ace_json::Map::new()),
    };
    DispatchedCall {
        name: bare,
        input: args,
    }
}

#[cfg(test)]
mod tests {
    // Ported from the cases `tool-names.ts` guards; the dispatch cases are those
    // `action-target.ts` and the registry rely on.
    use super::*;
    use ace_json::parse;

    #[test]
    fn every_provider_spelling_reaches_the_same_bare_name() {
        for (spelling, bare) in [
            ("context", "context"),
            ("mcp__ace__context", "context"),
            ("ace_context", "context"),
            ("ace_ace_thread_read", "thread_read"),
            ("mcp__ace__ace_wait", "wait"),
        ] {
            assert_eq!(bare_tool_name(spelling), bare, "{spelling}");
        }
    }

    #[test]
    fn a_registered_name_is_bare_lowercase_snake_case() {
        assert!(valid_tool_name("thread_read"));
        assert!(valid_tool_name("a"));
        assert!(!valid_tool_name("Thread_read"));
        assert!(!valid_tool_name("thread-read"));
        assert!(!valid_tool_name("1thread"));
        assert!(!valid_tool_name(""));
        assert!(!valid_tool_name(&format!("a{}", "b".repeat(101))));
    }

    #[test]
    fn an_undeclared_family_is_read_from_the_toolkits_prefix() {
        assert_eq!(default_toolset("browser_open"), Some("ace-browser"));
        assert_eq!(default_toolset("screen_state"), Some("ace-computer-use"));
        assert_eq!(default_toolset("sim_tap"), Some("ace-computer-use"));
        assert_eq!(default_toolset("thread_read"), None);
        assert_eq!(default_tool_title("thread_read"), "Thread read");
        assert_eq!(default_tool_title("ace_context"), "Context");
    }

    #[test]
    fn a_dispatch_runs_its_target_and_never_nests_a_meta_tool() {
        let input =
            parse("{\"name\":\"mcp__ace__thread_read\",\"arguments\":{\"threadId\":\"t\"}}")
                .expect("json");
        let call = dispatched_ace_call("tools_call", &input);
        assert_eq!(call.name, "thread_read");
        assert_eq!(
            call.input.get("threadId").and_then(Value::as_str),
            Some("t")
        );

        // No arguments: an empty object, not the dispatch's own body.
        let empty = parse("{\"name\":\"wait\"}").expect("json");
        let call = dispatched_ace_call("ace_tools_call", &empty);
        assert_eq!(call.name, "wait");
        assert_eq!(call.input.as_object().map(ace_json::Map::len), Some(0));

        // Nested meta tools and malformed dispatches come back as they went.
        for text in [
            "{\"name\":\"tools_call\",\"arguments\":{}}",
            "{\"name\":\"tools_find\",\"arguments\":{}}",
            "{\"name\":7}",
            "[]",
        ] {
            let input = parse(text).expect("json");
            let call = dispatched_ace_call("tools_call", &input);
            assert_eq!(call.name, "tools_call", "{text}");
        }
        let direct = parse("{}").expect("json");
        assert_eq!(dispatched_ace_call("context", &direct).name, "context");
    }
}
