use crate::provider::{NormalizedServerRequest, ProviderMetadata, ServerRequestKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerRequestNormalizationInput {
    pub provider: String,
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[must_use]
pub fn normalize_provider_server_request(
    request: ServerRequestNormalizationInput,
) -> NormalizedServerRequest {
    let kind = server_request_kind(&request.method);
    NormalizedServerRequest {
        kind,
        request_id: request.request_id,
        method: request.method.clone(),
        thread_id: string_at(&request.params, "threadId")
            .or_else(|| string_at(&request.params, "thread_id"))
            .or_else(|| string_at(&request.params, "conversationId"))
            .or_else(|| string_at(&request.params, "conversation_id"))
            .or_else(|| {
                nested_string_at(&request.params, "/thread", &["id", "threadId", "thread_id"])
            }),
        turn_id: string_at(&request.params, "turnId")
            .or_else(|| string_at(&request.params, "turn_id")),
        item_id: string_at(&request.params, "itemId")
            .or_else(|| string_at(&request.params, "item_id"))
            .or_else(|| string_at(&request.params, "sourceItemId"))
            .or_else(|| string_at(&request.params, "source_item_id"))
            .or_else(|| string_at(&request.params, "toolCallId"))
            .or_else(|| string_at(&request.params, "tool_call_id")),
        scope: server_request_scope(kind, &request.params),
        title: Some(server_request_title(kind).to_string()),
        prompt: server_request_prompt(&request.params),
        selected_policy: string_at(&request.params, "approvalPolicy")
            .or_else(|| string_at(&request.params, "approval_policy"))
            .or_else(|| string_at(&request.params, "permissionPolicy"))
            .or_else(|| string_at(&request.params, "permission_policy")),
        metadata: metadata_for_server_request(&request.params),
        provider: ProviderMetadata {
            provider: request.provider,
            method: Some(request.method),
            schema_version: string_at(&request.params, "schemaVersion"),
            raw_payload: request.params,
        },
    }
}

#[must_use]
pub fn server_request_kind(method: &str) -> ServerRequestKind {
    match method {
        "item/commandExecution/requestApproval" | "command/approvalRequest" => {
            ServerRequestKind::CommandApproval
        }
        "item/fileChange/requestApproval" | "fileChange/approvalRequest" => {
            ServerRequestKind::FileChangeApproval
        }
        "item/tool/requestUserInput" | "tool/userInputRequest" => ServerRequestKind::ToolUserInput,
        "mcpServer/elicitation/request" | "mcp/elicitation" => ServerRequestKind::McpElicitation,
        "item/permissions/requestApproval" | "permission/approvalRequest" => {
            ServerRequestKind::PermissionApproval
        }
        "item/tool/call" | "dynamicTool/call" => ServerRequestKind::DynamicToolCall,
        "account/chatgptAuthTokens/refresh" | "account/tokenRefresh" => {
            ServerRequestKind::AccountTokenRefresh
        }
        "attestation/generate" | "attestation/request" => ServerRequestKind::Attestation,
        "applyPatchApproval" | "applyPatch/approvalRequest" => {
            ServerRequestKind::ApplyPatchApproval
        }
        "execCommandApproval" | "exec/approvalRequest" => ServerRequestKind::ExecApproval,
        _ => ServerRequestKind::Unknown,
    }
}

fn server_request_scope(kind: ServerRequestKind, params: &Value) -> Option<String> {
    string_at(params, "scope").or_else(|| {
        Some(
            match kind {
                ServerRequestKind::CommandApproval | ServerRequestKind::ExecApproval => "command",
                ServerRequestKind::FileChangeApproval | ServerRequestKind::ApplyPatchApproval => {
                    "filesystem"
                }
                ServerRequestKind::ToolUserInput | ServerRequestKind::DynamicToolCall => "tool",
                ServerRequestKind::McpElicitation => "mcp",
                ServerRequestKind::PermissionApproval => "permission",
                ServerRequestKind::AccountTokenRefresh => "account",
                ServerRequestKind::Attestation => "attestation",
                ServerRequestKind::Unknown => return None,
            }
            .to_string(),
        )
    })
}

fn server_request_title(kind: ServerRequestKind) -> &'static str {
    match kind {
        ServerRequestKind::CommandApproval => "Approve command execution",
        ServerRequestKind::FileChangeApproval => "Approve file changes",
        ServerRequestKind::ToolUserInput => "Tool needs input",
        ServerRequestKind::McpElicitation => "MCP server needs input",
        ServerRequestKind::PermissionApproval => "Approve permission change",
        ServerRequestKind::DynamicToolCall => "Run dynamic tool",
        ServerRequestKind::AccountTokenRefresh => "Refresh account token",
        ServerRequestKind::Attestation => "Provide attestation",
        ServerRequestKind::ApplyPatchApproval => "Approve patch application",
        ServerRequestKind::ExecApproval => "Approve command execution",
        ServerRequestKind::Unknown => "Provider request",
    }
}

fn server_request_prompt(params: &Value) -> Option<String> {
    string_at(params, "prompt")
        .or_else(|| string_at(params, "message"))
        .or_else(|| string_at(params, "question"))
        .or_else(|| string_at(params, "userPrompt"))
        .or_else(|| string_at(params, "user_prompt"))
        .or_else(|| string_at(params, "reason"))
        .or_else(|| string_at(params, "description"))
        .or_else(|| string_at(params, "instructions"))
        .or_else(|| string_at(params, "command").map(|command| format!("Run `{command}`?")))
        .or_else(|| {
            first_string([
                string_at(params, "toolName").as_deref(),
                string_at(params, "tool_name").as_deref(),
                string_at(params, "name").as_deref(),
            ])
            .map(|tool| format!("Run `{tool}`?"))
        })
}

fn metadata_for_server_request(params: &Value) -> Value {
    let mut metadata = serde_json::Map::new();
    for key in [
        "requestId",
        "request_id",
        "threadId",
        "thread_id",
        "turnId",
        "turn_id",
        "itemId",
        "item_id",
        "sourceItemId",
        "source_item_id",
        "toolCallId",
        "tool_call_id",
        "command",
        "argv",
        "args",
        "arguments",
        "input",
        "result",
        "cwd",
        "env",
        "path",
        "paths",
        "uri",
        "files",
        "diff",
        "patch",
        "toolName",
        "tool_name",
        "tool",
        "name",
        "serverName",
        "server_name",
        "server",
        "operation",
        "action",
        "sandbox",
        "sandboxPolicy",
        "sandbox_policy",
        "permission",
        "permissions",
        "permissionPolicy",
        "permission_policy",
        "approvalPolicy",
        "approval_policy",
        "approvalsReviewer",
        "approvals_reviewer",
        "account",
        "accountId",
        "account_id",
        "attestation",
        "challenge",
        "resource",
        "schema",
        "choices",
        "options",
        "timeoutMs",
        "timeout_ms",
    ] {
        if let Some(value) = params.get(key) {
            metadata.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(metadata)
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(ToString::to_string)
}

fn nested_string_at(value: &Value, pointer: &str, keys: &[&str]) -> Option<String> {
    let nested = value.pointer(pointer)?;
    keys.iter().find_map(|key| string_at(nested, key))
}

fn first_string<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    values.into_iter().flatten().find_map(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_command_approval_with_prompt_and_policy() {
        let request = normalize_provider_server_request(ServerRequestNormalizationInput {
            provider: "future-provider".to_string(),
            request_id: "req-1".to_string(),
            method: "command/approvalRequest".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "command": "cargo test --workspace",
                "approvalPolicy": "on-request",
                "schemaVersion": "2026-06-22"
            }),
        });

        assert_eq!(request.kind, ServerRequestKind::CommandApproval);
        assert_eq!(request.scope.as_deref(), Some("command"));
        assert_eq!(
            request.prompt.as_deref(),
            Some("Run `cargo test --workspace`?")
        );
        assert_eq!(request.selected_policy.as_deref(), Some("on-request"));
        assert_eq!(request.provider.provider, "future-provider");
        assert_eq!(
            request.provider.raw_payload["command"],
            "cargo test --workspace"
        );
        assert_eq!(request.metadata["command"], "cargo test --workspace");
    }

    #[test]
    fn classifies_all_known_server_request_methods() {
        let cases = [
            (
                "item/commandExecution/requestApproval",
                ServerRequestKind::CommandApproval,
            ),
            (
                "command/approvalRequest",
                ServerRequestKind::CommandApproval,
            ),
            (
                "item/fileChange/requestApproval",
                ServerRequestKind::FileChangeApproval,
            ),
            (
                "fileChange/approvalRequest",
                ServerRequestKind::FileChangeApproval,
            ),
            (
                "item/tool/requestUserInput",
                ServerRequestKind::ToolUserInput,
            ),
            ("tool/userInputRequest", ServerRequestKind::ToolUserInput),
            (
                "mcpServer/elicitation/request",
                ServerRequestKind::McpElicitation,
            ),
            ("mcp/elicitation", ServerRequestKind::McpElicitation),
            (
                "item/permissions/requestApproval",
                ServerRequestKind::PermissionApproval,
            ),
            (
                "permission/approvalRequest",
                ServerRequestKind::PermissionApproval,
            ),
            ("item/tool/call", ServerRequestKind::DynamicToolCall),
            ("dynamicTool/call", ServerRequestKind::DynamicToolCall),
            (
                "account/chatgptAuthTokens/refresh",
                ServerRequestKind::AccountTokenRefresh,
            ),
            (
                "account/tokenRefresh",
                ServerRequestKind::AccountTokenRefresh,
            ),
            ("attestation/generate", ServerRequestKind::Attestation),
            ("attestation/request", ServerRequestKind::Attestation),
            ("applyPatchApproval", ServerRequestKind::ApplyPatchApproval),
            (
                "applyPatch/approvalRequest",
                ServerRequestKind::ApplyPatchApproval,
            ),
            ("execCommandApproval", ServerRequestKind::ExecApproval),
            ("exec/approvalRequest", ServerRequestKind::ExecApproval),
            ("unknown/request", ServerRequestKind::Unknown),
        ];

        for (method, kind) in cases {
            assert_eq!(server_request_kind(method), kind, "{method}");
        }
    }
}
