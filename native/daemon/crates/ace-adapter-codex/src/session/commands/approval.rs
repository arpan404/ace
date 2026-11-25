// SPDX-License-Identifier: Apache-2.0
//! `approvalResult` (`resolution.ts`): what a pending server request is answered
//! with, from the engine's resolution.

use ace_json::{Map, Value};

use crate::session::state::Pending;

/// Codex's question request (`item/tool/requestUserInput`).
const USER_INPUT: &str = "item/tool/requestUserInput";
/// Codex's MCP elicitation request, which also carries tool approvals.
const ELICITATION: &str = "mcpServer/elicitation/request";
/// Codex's permissions request (`item/permissions/requestApproval`).
const PERMISSIONS: &str = "item/permissions/requestApproval";
/// The decisions Codex offers when it names none.
const DECISIONS: [&str; 4] = ["accept", "acceptForSession", "decline", "cancel"];

/// `approvalResult(request, resolution)`: what the pending server request is
/// answered with.
pub(crate) fn approval_result(pending: &Pending, resolution: &Value) -> Result<Value, String> {
    let method = pending.method.as_str();
    let kind = resolution
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = pending
        .params
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if method == USER_INPUT && kind == "question" {
        let dismissed = resolution
            .get("dismissed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut answers = Map::new();
        for (id, chosen) in resolution
            .get("answers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
        {
            let mut answer = Map::new();
            answer.insert(
                "answers",
                match dismissed {
                    true => Value::Array(Vec::new().into()),
                    false => chosen,
                },
            );
            answers.insert(id, Value::Object(answer));
        }
        let mut result = Map::new();
        result.insert("answers", Value::Object(answers));
        return Ok(Value::Object(result));
    }
    if method == ELICITATION && kind == "elicitation" {
        let mut result = Map::new();
        result.insert(
            "action",
            resolution
                .get("action")
                .cloned()
                .unwrap_or_else(|| Value::from("")),
        );
        if let Some(content) = resolution.get("content") {
            result.insert("content", content.clone());
        }
        return Ok(Value::Object(result));
    }
    if kind != "approval" {
        return Err("Resolution kind does not match the Codex interaction".to_owned());
    }
    if method == ELICITATION {
        return mcp_tool_approval_result(resolution);
    }
    if method == PERMISSIONS {
        let mut result = Map::new();
        result.insert(
            "permissions",
            match resolution.get("optionId").and_then(Value::as_str) {
                Some("accept") => params
                    .get("permissions")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new())),
                _ => Value::Object(Map::new()),
            },
        );
        result.insert("scope", Value::from("turn"));
        return Ok(Value::Object(result));
    }
    let offered = params
        .get("availableDecisions")
        .cloned()
        .unwrap_or_else(|| {
            Value::Array(
                DECISIONS
                    .iter()
                    .map(|id| Value::from(*id))
                    .collect::<Vec<Value>>()
                    .into(),
            )
        });
    let option = resolution
        .get("optionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let decision = offered
        .as_array()
        .map(|decisions| decisions.to_vec())
        .unwrap_or_default()
        .into_iter()
        .find(|entry| decision_id(entry) == option)
        .ok_or_else(|| "Approval option is not offered by Codex".to_owned())?;
    let mut result = Map::new();
    result.insert("decision", decision);
    Ok(Value::Object(result))
}

/// `mcpToolApprovalResult`: the elicitation answer for an approval option; a
/// remembered scope rides in `_meta.persist`.
fn mcp_tool_approval_result(resolution: &Value) -> Result<Value, String> {
    let (action, persist) = match resolution.get("optionId").and_then(Value::as_str) {
        Some("accept") => ("accept", false),
        Some("accept_session") => ("accept", true),
        Some("decline") => ("decline", false),
        Some("cancel") => ("cancel", false),
        _ => return Err("Approval option is not offered by Codex".to_owned()),
    };
    let mut result = Map::new();
    result.insert("action", Value::from(action));
    if persist {
        let mut meta = Map::new();
        meta.insert("persist", Value::from("session"));
        result.insert("_meta", Value::Object(meta));
    }
    Ok(Value::Object(result))
}

/// `str(entry, Object.keys(obj(entry))[0])`: a decision's own id.
fn decision_id(entry: &Value) -> &str {
    match entry {
        Value::String(text) => text.as_str(),
        Value::Object(map) => map
            .keys()
            .next()
            .map(|key| key.as_str())
            .unwrap_or_default(),
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_supervisor::jsonrpc::RpcId;

    fn json(text: &str) -> Value {
        ace_json::parse(text).expect("fixture parses")
    }

    fn pending(method: &str, params: &str) -> Pending {
        Pending {
            id: RpcId::Number(1.0),
            method: ace_json::JsString::from(method),
            params: match params.is_empty() {
                true => None,
                false => Some(json(params)),
            },
        }
    }

    #[test]
    fn a_permission_approval_carries_the_offered_decision_its_option_names() {
        let request = pending(
            "item/commandExecution/requestApproval",
            r#"{"availableDecisions":["accept","acceptForSession",{"acceptWithExecpolicyAmendment":{}},"decline","cancel"]}"#,
        );
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"approval","optionId":"decline"}"#)
            ),
            Ok(json(r#"{"decision":"decline"}"#))
        );
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"approval","optionId":"acceptWithExecpolicyAmendment"}"#)
            ),
            Ok(json(r#"{"decision":{"acceptWithExecpolicyAmendment":{}}}"#))
        );
        assert_eq!(
            approval_result(&request, &json(r#"{"kind":"approval","optionId":"nope"}"#)),
            Err("Approval option is not offered by Codex".to_owned())
        );
    }

    #[test]
    fn a_permission_approval_without_offered_decisions_uses_codexs_own_four() {
        let request = pending("item/commandExecution/requestApproval", "");
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"approval","optionId":"acceptForSession"}"#)
            ),
            Ok(json(r#"{"decision":"acceptForSession"}"#))
        );
    }

    #[test]
    fn a_permissions_request_answers_with_the_permissions_it_asked_for_or_none() {
        let request = pending(
            "item/permissions/requestApproval",
            r#"{"permissions":{"network":true}}"#,
        );
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"approval","optionId":"accept"}"#)
            ),
            Ok(json(r#"{"permissions":{"network":true},"scope":"turn"}"#))
        );
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"approval","optionId":"decline"}"#)
            ),
            Ok(json(r#"{"permissions":{},"scope":"turn"}"#))
        );
    }

    #[test]
    fn an_mcp_tool_approval_keeps_a_remembered_scope_in_meta() {
        let request = pending("mcpServer/elicitation/request", r#"{"serverName":"s"}"#);
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"approval","optionId":"accept_session"}"#)
            ),
            Ok(json(r#"{"action":"accept","_meta":{"persist":"session"}}"#))
        );
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"approval","optionId":"cancel"}"#)
            ),
            Ok(json(r#"{"action":"cancel"}"#))
        );
    }

    #[test]
    fn an_elicitation_answer_carries_its_action_and_content_only_when_it_has_one() {
        let request = pending("mcpServer/elicitation/request", "");
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"elicitation","action":"decline"}"#)
            ),
            Ok(json(r#"{"action":"decline"}"#))
        );
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"elicitation","action":"accept","content":{"a":"b"}}"#)
            ),
            Ok(json(r#"{"action":"accept","content":{"a":"b"}}"#))
        );
    }

    #[test]
    fn a_question_answers_each_question_with_its_chosen_answers() {
        let request = pending("item/tool/requestUserInput", "");
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"question","answers":{"q1":["a","b"]}}"#)
            ),
            Ok(json(r#"{"answers":{"q1":{"answers":["a","b"]}}}"#))
        );
        assert_eq!(
            approval_result(
                &request,
                &json(r#"{"kind":"question","dismissed":true,"answers":{"q1":["a"]}}"#)
            ),
            Ok(json(r#"{"answers":{"q1":{"answers":[]}}}"#))
        );
    }

    #[test]
    fn a_resolution_of_the_wrong_kind_is_refused_rather_than_shaped_into_an_answer() {
        let request = pending("item/commandExecution/requestApproval", "");
        assert_eq!(
            approval_result(&request, &json(r#"{"kind":"question","answers":{}}"#)),
            Err("Resolution kind does not match the Codex interaction".to_owned())
        );
    }
}
