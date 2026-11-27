// SPDX-License-Identifier: Apache-2.0
//! Result-side failure recording and change-digest attachment, ported from
//! `packages/mcp-server/src/changes.ts`.

use ace_json::{JsString, Map, Value};

use crate::awareness::SessionAwareness;
use crate::credentials::Principal;
use crate::result::{CallToolResult, Content};
use crate::toolsets::AceClient;

/// Which part of a tool result reaches the client's model.
/// Claude Code, OpenCode and Pi show the model the text blocks; Codex shows it
/// `structuredContent` and drops the text when both are present.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultReader {
    Text,
    Structured,
}

/// The part of a result this client's model reads: Codex reads `structuredContent`, others text.
pub const fn result_reader(client: Option<AceClient>) -> ResultReader {
    match client {
        Some(AceClient::Codex) => ResultReader::Structured,
        Some(AceClient::Cursor) | None => ResultReader::Text,
    }
}

/// Reserved `structuredContent` key for the digest; no tool's own output uses it.
pub const CHANGES_KEY: &str = "aceChanges";

/// Remember a failure for the brief, then attach what changed since this session's last ace call
/// where the client's model reads it: a text block for text readers, a reserved key in
/// `structuredContent` for structured results, and `_meta["ace/changes"]`.
pub fn with_changes(
    awareness: &SessionAwareness,
    principal: &Principal,
    tool: &str,
    mut result: CallToolResult,
    reader: ResultReader,
) -> CallToolResult {
    if let Some(code) = failure_code(&result) {
        awareness.failed(principal, tool, &code);
    }
    let Some(changes) = awareness.changes(principal) else {
        return result;
    };

    let has_structured_object = matches!(&result.structured, Some(Value::Object(_)));
    if !(has_structured_object && reader == ResultReader::Structured) {
        result.content.push(Content::text(changes.clone()));
    }
    if let Some(Value::Object(ref mut structured)) = result.structured {
        structured.insert(CHANGES_KEY, Value::String(JsString::from(changes.as_str())));
    }
    let mut meta = result
        .meta
        .unwrap_or_else(|| Box::new(Map::with_capacity(1)));
    meta.insert(
        "ace/changes",
        Value::String(JsString::from(changes.as_str())),
    );
    result.meta = Some(meta);
    result
}

/// Extract a failure code from a tool result:
/// 1. `structuredContent` matching `{ ok: false, code: string (<=64 code points) }`;
/// 2. Else if `is_error`, parse the first text block as JSON `{ code: string (<=64 code points) }`,
///    falling back to `"failed"`.
pub fn failure_code(result: &CallToolResult) -> Option<String> {
    if let Some(Value::Object(structured)) = &result.structured
        && structured.get("ok") == Some(&Value::Bool(false))
        && let Some(Value::String(code)) = structured.get("code")
    {
        let s = code.as_str();
        if s.chars().count() <= 64 {
            return Some(s.to_owned());
        }
    }
    if !result.is_error {
        return None;
    }
    let Some(first) = result.content.first() else {
        return Some("failed".to_owned());
    };
    if first.kind != "text" {
        return Some("failed".to_owned());
    }
    if let Ok(Value::Object(parsed)) = ace_json::parse(&first.text)
        && let Some(Value::String(code)) = parsed.get("code")
    {
        let s = code.as_str();
        if s.chars().count() <= 64 {
            return Some(s.to_owned());
        }
    }
    Some("failed".to_owned())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::awareness::{AwarenessPort, CallerFacts};
    use crate::brief::{AccessMode, DelegateTarget};
    use crate::credentials::{LeaseId, McpScope};
    use crate::signal::Abort;

    struct Port(Mutex<CallerFacts>);

    impl AwarenessPort for Port {
        fn facts(&self, _caller: &McpScope) -> Option<CallerFacts> {
            self.0.lock().ok().map(|f| f.clone())
        }

        fn delegates(&self, _caller: &McpScope) -> Vec<DelegateTarget> {
            vec![]
        }
    }

    fn principal() -> Principal {
        Principal {
            scope: Arc::new(McpScope::new("s1", "t1", "a1", &[])),
            lease: LeaseId(1),
            lifetime: Abort::new(),
        }
    }

    #[test]
    fn text_and_structured_readers_receive_changes_in_their_expected_slots() {
        let port = Arc::new(Port(Mutex::new(CallerFacts {
            access: Some(AccessMode::Ask),
            ..CallerFacts::default()
        })));
        let awareness = SessionAwareness::new(port.clone(), |_| vec![], |_| vec![]);
        let p = principal();
        // Prime seen state.
        let _ = awareness.guidance(&p);

        // Mutate access for a text reader: adds both text block and structuredContent.aceChanges.
        if let Ok(mut f) = port.0.lock() {
            f.access = Some(AccessMode::FullAccess);
        }
        let structured = ace_json::parse("{\"ok\":true}").unwrap_or(Value::Null);
        let text_out = with_changes(
            &awareness,
            &p,
            "context",
            CallToolResult::success(structured.clone()),
            result_reader(None),
        );
        assert_eq!(text_out.content.len(), 2);
        assert!(
            text_out.content[1]
                .text
                .contains("access is now full-access")
        );
        let json = text_out.to_json();
        assert!(
            json.as_object()
                .and_then(|o| o.get("structuredContent"))
                .and_then(Value::as_object)
                .and_then(|s| s.get(CHANGES_KEY))
                .is_some()
        );
        assert!(
            json.as_object()
                .and_then(|o| o.get("_meta"))
                .and_then(Value::as_object)
                .and_then(|m| m.get("ace/changes"))
                .is_some()
        );

        // Mutate again for a structured reader (Codex): omits duplicate text block on structured results.
        if let Ok(mut f) = port.0.lock() {
            f.access = Some(AccessMode::ReadOnly);
        }
        let codex_out = with_changes(
            &awareness,
            &p,
            "context",
            CallToolResult::success(structured),
            result_reader(Some(AceClient::Codex)),
        );
        assert_eq!(codex_out.content.len(), 1);
        assert!(
            codex_out
                .structured
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|s| s.get(CHANGES_KEY))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .contains("access is now read-only")
        );
    }

    #[test]
    fn failure_code_reads_control_failure_json_errors_and_plain_text_fallbacks() {
        let port = Arc::new(Port(Mutex::new(CallerFacts::default())));
        let awareness = SessionAwareness::new(port, |_| vec![], |_| vec![]);
        let p = principal();

        let control_err = CallToolResult::structured(
            false,
            ace_json::parse("{\"ok\":false,\"code\":\"model_unavailable\"}").unwrap_or(Value::Null),
        );
        let _ = with_changes(&awareness, &p, "delegate", control_err, ResultReader::Text);

        let json_err = CallToolResult::failure("{\"code\":\"tool_unavailable\"}");
        let _ = with_changes(&awareness, &p, "browser_open", json_err, ResultReader::Text);

        let plain_err = CallToolResult::failure("boom");
        let _ = with_changes(&awareness, &p, "wait", plain_err, ResultReader::Text);

        let recent = awareness.recent_failures("s1");
        let pairs: Vec<(&str, &str)> = recent
            .iter()
            .map(|e| (e.tool.as_str(), e.code.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("wait", "failed"),
                ("browser_open", "tool_unavailable"),
                ("delegate", "model_unavailable"),
            ]
        );
    }
}
