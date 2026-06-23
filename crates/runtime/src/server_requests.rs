use crate::provider::{
    NormalizedServerRequest, ProviderMetadata, ServerRequestDetail, ServerRequestKind,
};
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

pub const KNOWN_SERVER_REQUEST_METHODS: &[&str] = &[
    "item/commandExecution/requestApproval",
    "command/approvalRequest",
    "item/fileChange/requestApproval",
    "fileChange/approvalRequest",
    "item/tool/requestUserInput",
    "tool/userInputRequest",
    "mcpServer/elicitation/request",
    "mcp/elicitation",
    "item/permissions/requestApproval",
    "permission/approvalRequest",
    "item/tool/call",
    "dynamicTool/call",
    "account/chatgptAuthTokens/refresh",
    "account/tokenRefresh",
    "attestation/generate",
    "attestation/request",
    "applyPatchApproval",
    "applyPatch/approvalRequest",
    "execCommandApproval",
    "exec/approvalRequest",
];

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
        detail: server_request_detail(&request.params),
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

fn server_request_detail(params: &Value) -> ServerRequestDetail {
    ServerRequestDetail {
        command: command_text(params),
        argv: string_vec_at(params, "argv")
            .or_else(|| string_vec_at(params, "args"))
            .or_else(|| nested_string_vec_at(params, "/command", &["argv", "args"]))
            .or_else(|| nested_string_vec_at(params, "/exec", &["argv", "args"]))
            .or_else(|| nested_string_vec_at(params, "/process", &["argv", "args"])),
        cwd: string_at(params, "cwd")
            .or_else(|| string_at(params, "workingDirectory"))
            .or_else(|| string_at(params, "working_directory"))
            .or_else(|| nested_string_at(params, "/command", &["cwd", "workingDirectory"]))
            .or_else(|| nested_string_at(params, "/exec", &["cwd", "workingDirectory"])),
        path: string_at(params, "path")
            .or_else(|| string_at(params, "file"))
            .or_else(|| string_at(params, "uri"))
            .or_else(|| nested_string_at(params, "/file", &["path", "file", "uri"]))
            .or_else(|| nested_string_at(params, "/patch", &["path", "file"])),
        paths: string_vec_at(params, "paths")
            .or_else(|| string_vec_at(params, "files"))
            .or_else(|| nested_string_vec_at(params, "/patch", &["paths", "files"]))
            .or_else(|| nested_string_vec_at(params, "/fileChange", &["paths", "files"]))
            .or_else(|| string_at(params, "path").map(|path| vec![path])),
        diff: value_at(params, "diff")
            .or_else(|| value_at(params, "fileDiff"))
            .or_else(|| value_at(params, "file_diff"))
            .or_else(|| nested_value_at(params, "/fileChange/diff")),
        patch: value_at(params, "patch")
            .or_else(|| value_at(params, "changes"))
            .or_else(|| nested_value_at(params, "/fileChange/patch")),
        tool_name: string_at(params, "toolName")
            .or_else(|| string_at(params, "tool_name"))
            .or_else(|| nested_string_at(params, "/tool", &["name", "toolName", "tool_name"]))
            .or_else(|| nested_string_at(params, "/toolCall", &["name", "toolName", "tool_name"]))
            .or_else(|| string_at(params, "name")),
        server_name: string_at(params, "serverName")
            .or_else(|| string_at(params, "server_name"))
            .or_else(|| {
                nested_string_at(params, "/server", &["name", "serverName", "server_name"])
            }),
        operation: string_at(params, "operation")
            .or_else(|| string_at(params, "action"))
            .or_else(|| string_at(params, "kind")),
        permission: string_at(params, "permission")
            .or_else(|| string_at(params, "permissionPolicy"))
            .or_else(|| string_at(params, "permission_policy"))
            .or_else(|| string_at(params, "sandbox"))
            .or_else(|| nested_string_at(params, "/sandboxPolicy", &["mode"]))
            .or_else(|| nested_string_at(params, "/sandbox_policy", &["mode"])),
        resource: string_at(params, "resource")
            .or_else(|| string_at(params, "uri"))
            .or_else(|| string_at(params, "account"))
            .or_else(|| string_at(params, "accountId"))
            .or_else(|| string_at(params, "account_id"))
            .or_else(|| string_at(params, "provider"))
            .or_else(|| string_at(params, "audience"))
            .or_else(|| string_at(params, "subject")),
        choices: value_at(params, "choices").or_else(|| value_at(params, "options")),
        schema: value_at(params, "schema"),
        arguments: value_at(params, "arguments")
            .or_else(|| value_at(params, "args"))
            .or_else(|| value_at(params, "input"))
            .or_else(|| value_at(params, "payload")),
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
        .or_else(|| command_text(params).map(|command| format!("Run `{command}`?")))
        .or_else(|| {
            first_string([
                string_at(params, "path").as_deref(),
                string_at(params, "file").as_deref(),
                nested_string_at(params, "/file", &["path", "file"]).as_deref(),
            ])
            .map(|path| format!("Allow changes to `{path}`?"))
        })
        .or_else(|| {
            first_string([
                string_at(params, "resource").as_deref(),
                string_at(params, "accountId").as_deref(),
                string_at(params, "account_id").as_deref(),
                string_at(params, "audience").as_deref(),
                string_at(params, "subject").as_deref(),
            ])
            .map(|resource| format!("Allow provider request for `{resource}`?"))
        })
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

fn nested_value_at(value: &Value, pointer: &str) -> Option<Value> {
    value.pointer(pointer).cloned()
}

fn value_at(value: &Value, key: &str) -> Option<Value> {
    value.get(key).cloned()
}

fn string_vec_at(value: &Value, key: &str) -> Option<Vec<String>> {
    let values = value.get(key)?.as_array()?;
    let strings = values
        .iter()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    (!strings.is_empty()).then_some(strings)
}

fn nested_string_at(value: &Value, pointer: &str, keys: &[&str]) -> Option<String> {
    let nested = value.pointer(pointer)?;
    keys.iter().find_map(|key| string_at(nested, key))
}

fn nested_string_vec_at(value: &Value, pointer: &str, keys: &[&str]) -> Option<Vec<String>> {
    let nested = value.pointer(pointer)?;
    keys.iter().find_map(|key| string_vec_at(nested, key))
}

fn first_string<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    values.into_iter().flatten().find_map(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn command_text(params: &Value) -> Option<String> {
    string_at(params, "command")
        .or_else(|| string_at(params, "cmd"))
        .or_else(|| nested_string_at(params, "/command", &["text", "command", "cmd"]))
        .or_else(|| nested_string_at(params, "/exec", &["text", "command", "cmd"]))
        .or_else(|| {
            string_vec_at(params, "argv")
                .or_else(|| string_vec_at(params, "args"))
                .or_else(|| nested_string_vec_at(params, "/command", &["argv", "args"]))
                .or_else(|| nested_string_vec_at(params, "/exec", &["argv", "args"]))
                .map(|argv| argv.join(" "))
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
        assert_eq!(
            request.detail.command.as_deref(),
            Some("cargo test --workspace")
        );
        assert_eq!(request.metadata["command"], "cargo test --workspace");
    }

    #[test]
    fn extracts_typed_details_for_interactive_and_permission_requests() {
        let tool_request = normalize_provider_server_request(ServerRequestNormalizationInput {
            provider: "codex".to_string(),
            request_id: "tool-req".to_string(),
            method: "tool/userInputRequest".to_string(),
            params: json!({
                "threadId": "thread-1",
                "toolCallId": "tool-1",
                "serverName": "browser",
                "toolName": "navigate_tab_url",
                "operation": "navigate",
                "question": "Which tab?",
                "choices": ["current", "new"],
                "schema": { "type": "object" }
            }),
        });

        assert_eq!(tool_request.kind, ServerRequestKind::ToolUserInput);
        assert_eq!(tool_request.detail.server_name.as_deref(), Some("browser"));
        assert_eq!(
            tool_request.detail.tool_name.as_deref(),
            Some("navigate_tab_url")
        );
        assert_eq!(tool_request.detail.operation.as_deref(), Some("navigate"));
        assert_eq!(
            tool_request.detail.choices.as_ref().expect("choices")[0],
            "current"
        );
        assert_eq!(
            tool_request.detail.schema.as_ref().expect("schema")["type"],
            "object"
        );
        assert_eq!(tool_request.provider.raw_payload["choices"][1], "new");

        let permission_request =
            normalize_provider_server_request(ServerRequestNormalizationInput {
                provider: "codex".to_string(),
                request_id: "permission-req".to_string(),
                method: "permission/approvalRequest".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "permissionPolicy": "workspace-write",
                    "sandboxPolicy": { "mode": "workspace-write" },
                    "approvalPolicy": "on-request",
                    "message": "Allow writes?"
                }),
            });

        assert_eq!(
            permission_request.detail.permission.as_deref(),
            Some("workspace-write")
        );
        assert_eq!(
            permission_request.selected_policy.as_deref(),
            Some("on-request")
        );
        assert_eq!(
            permission_request.provider.raw_payload["sandboxPolicy"]["mode"],
            "workspace-write"
        );
    }

    #[test]
    fn extracts_nested_command_patch_account_and_attestation_details() {
        let exec_request = normalize_provider_server_request(ServerRequestNormalizationInput {
            provider: "codex".to_string(),
            request_id: "exec-req".to_string(),
            method: "exec/approvalRequest".to_string(),
            params: json!({
                "threadId": "thread-1",
                "exec": {
                    "argv": ["cargo", "test", "--workspace"],
                    "cwd": "/repo"
                },
                "approvalPolicy": "on-request"
            }),
        });

        assert_eq!(exec_request.kind, ServerRequestKind::ExecApproval);
        assert_eq!(
            exec_request.detail.command.as_deref(),
            Some("cargo test --workspace")
        );
        assert_eq!(
            exec_request.detail.argv.as_ref().expect("argv"),
            &vec![
                "cargo".to_string(),
                "test".to_string(),
                "--workspace".to_string()
            ]
        );
        assert_eq!(exec_request.detail.cwd.as_deref(), Some("/repo"));
        assert_eq!(
            exec_request.prompt.as_deref(),
            Some("Run `cargo test --workspace`?")
        );

        let patch_request = normalize_provider_server_request(ServerRequestNormalizationInput {
            provider: "codex".to_string(),
            request_id: "patch-req".to_string(),
            method: "applyPatchApproval".to_string(),
            params: json!({
                "threadId": "thread-1",
                "fileChange": {
                    "files": ["src/lib.rs", "Cargo.toml"],
                    "patch": "@@ -1 +1 @@",
                    "diff": "diff --git a/src/lib.rs b/src/lib.rs"
                }
            }),
        });

        assert_eq!(patch_request.kind, ServerRequestKind::ApplyPatchApproval);
        assert_eq!(
            patch_request.detail.paths.as_ref().expect("paths"),
            &vec!["src/lib.rs".to_string(), "Cargo.toml".to_string()]
        );
        assert_eq!(
            patch_request.detail.patch.as_ref().expect("patch"),
            "@@ -1 +1 @@"
        );
        assert_eq!(
            patch_request.detail.diff.as_ref().expect("diff"),
            "diff --git a/src/lib.rs b/src/lib.rs"
        );

        let account_request = normalize_provider_server_request(ServerRequestNormalizationInput {
            provider: "codex".to_string(),
            request_id: "account-req".to_string(),
            method: "account/chatgptAuthTokens/refresh".to_string(),
            params: json!({
                "threadId": "thread-1",
                "account_id": "acct-1",
                "audience": "openai-api"
            }),
        });

        assert_eq!(account_request.kind, ServerRequestKind::AccountTokenRefresh);
        assert_eq!(account_request.detail.resource.as_deref(), Some("acct-1"));
        assert_eq!(
            account_request.prompt.as_deref(),
            Some("Allow provider request for `acct-1`?")
        );

        let attestation_request =
            normalize_provider_server_request(ServerRequestNormalizationInput {
                provider: "codex".to_string(),
                request_id: "attestation-req".to_string(),
                method: "attestation/request".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "subject": "device-key",
                    "challenge": "nonce"
                }),
            });

        assert_eq!(attestation_request.kind, ServerRequestKind::Attestation);
        assert_eq!(
            attestation_request.detail.resource.as_deref(),
            Some("device-key")
        );
        assert_eq!(
            attestation_request.prompt.as_deref(),
            Some("Allow provider request for `device-key`?")
        );
    }

    #[test]
    fn classifies_all_known_server_request_methods() {
        for method in KNOWN_SERVER_REQUEST_METHODS {
            assert_ne!(
                server_request_kind(method),
                ServerRequestKind::Unknown,
                "{method}"
            );
        }

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
        ];

        for (method, kind) in cases {
            assert_eq!(server_request_kind(method), kind, "{method}");
        }

        assert_eq!(
            server_request_kind("unknown/request"),
            ServerRequestKind::Unknown
        );
    }
}
