use ace_runtime::{
    provider::{
        NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedThreadItem, ProviderEvent,
        ProviderMetadata, RuntimeSignalKind, ServerRequestKind, ThreadItemKind, ThreadItemStatus,
    },
    tools::{
        ProviderToolMetadata, ToolNormalizationInput, ToolRunStatus, ToolTransport,
        normalize_tool_call,
    },
};
use serde_json::Value;

pub use crate::transport::CodexInboundEvent;

#[must_use]
pub fn normalize_codex_inbound_event(event: &CodexInboundEvent) -> Vec<ProviderEvent> {
    match event {
        CodexInboundEvent::Notification { method, params } => {
            let mut events = Vec::new();
            if let Some(signal) = normalize_codex_runtime_signal(method, params) {
                events.push(ProviderEvent::RuntimeSignal {
                    signal: Box::new(signal),
                });
            }
            if let Some(tool) = normalize_codex_tool_notification(method, params) {
                events.push(ProviderEvent::SemanticTool {
                    tool: Box::new(tool),
                });
            }
            if let Some(item) = normalize_codex_thread_item_notification(method, params) {
                events.push(ProviderEvent::ThreadItem {
                    item: Box::new(item),
                });
            }
            events.push(ProviderEvent::RawNotification {
                method: method.clone(),
                params: params.clone(),
            });
            events
        }
        CodexInboundEvent::ServerRequest { id, method, params } => {
            let mut events = vec![
                ProviderEvent::ServerRequest {
                    request: Box::new(normalize_codex_server_request(*id, method, params)),
                },
                ProviderEvent::RawServerRequest {
                    id: id.to_string(),
                    method: method.clone(),
                    params: params.clone(),
                },
            ];
            if let Some(tool) = normalize_codex_server_request_tool(*id, method, params) {
                events.push(ProviderEvent::SemanticTool {
                    tool: Box::new(tool),
                });
            }
            events
        }
        CodexInboundEvent::StderrLine(line) => {
            vec![ProviderEvent::StderrLine { line: line.clone() }]
        }
        CodexInboundEvent::ServerExited { code } => vec![ProviderEvent::Exited { code: *code }],
    }
}

fn normalize_codex_runtime_signal(method: &str, params: &Value) -> Option<NormalizedRuntimeSignal> {
    let mut signal = NormalizedRuntimeSignal {
        kind: runtime_signal_kind(method)?,
        thread_id: string_at(params, "threadId")
            .or_else(|| string_at(params, "thread_id"))
            .or_else(|| nested_string_at(params, "/thread", &["id", "threadId", "thread_id"])),
        turn_id: string_at(params, "turnId")
            .or_else(|| string_at(params, "turn_id"))
            .or_else(|| nested_string_at(params, "/turn", &["id", "turnId", "turn_id"])),
        message: None,
        from_model: None,
        to_model: None,
        reason: None,
        text: None,
        audio: None,
        status: None,
        name: None,
        active: None,
        archived: None,
        diff: None,
        files: None,
        process_id: None,
        exit_code: None,
        request_id: None,
        metadata: params.clone(),
        provider: ProviderMetadata {
            provider: "codex".to_string(),
            method: Some(method.to_string()),
            schema_version: string_at(params, "schemaVersion"),
            raw_payload: params.clone(),
        },
    };
    match signal.kind {
        RuntimeSignalKind::Warning => {
            signal.message = first_string([
                string_at(params, "message").as_deref(),
                string_at(params, "text").as_deref(),
                string_at(params, "warning").as_deref(),
                string_at(params, "description").as_deref(),
            ]);
            signal.message.as_ref()?;
        }
        RuntimeSignalKind::ModelRerouted => {
            signal.from_model = first_string([
                string_at(params, "fromModel").as_deref(),
                string_at(params, "from_model").as_deref(),
                string_at(params, "previousModel").as_deref(),
                string_at(params, "previous_model").as_deref(),
            ]);
            signal.to_model = first_string([
                string_at(params, "toModel").as_deref(),
                string_at(params, "to_model").as_deref(),
                string_at(params, "model").as_deref(),
                string_at(params, "targetModel").as_deref(),
                string_at(params, "target_model").as_deref(),
            ]);
            signal.reason = first_string([
                string_at(params, "reason").as_deref(),
                string_at(params, "message").as_deref(),
                string_at(params, "description").as_deref(),
            ]);
        }
        RuntimeSignalKind::RealtimeTranscriptDelta => {
            signal.text = first_string([
                string_at(params, "delta").as_deref(),
                string_at(params, "text").as_deref(),
                string_at(params, "transcript").as_deref(),
                string_at(params, "content").as_deref(),
            ]);
            signal.text.as_ref()?;
        }
        RuntimeSignalKind::RealtimeAudioDelta => {
            signal.audio = first_string([
                string_at(params, "audio").as_deref(),
                string_at(params, "delta").as_deref(),
                string_at(params, "data").as_deref(),
                string_at(params, "base64").as_deref(),
            ]);
            signal.audio.as_ref()?;
        }
        RuntimeSignalKind::ThreadLifecycleChanged => {
            signal.status = first_string([
                string_at(params, "status").as_deref(),
                string_at(params, "state").as_deref(),
                string_at(params, "lifecycle").as_deref(),
            ])
            .or_else(|| lifecycle_status_from_method(method));
            signal.name = string_at(params, "name")
                .or_else(|| nested_string_at(params, "/thread", &["name", "title"]));
            signal.active =
                bool_at(params, "active").or_else(|| lifecycle_active_from_method(method));
            signal.archived =
                bool_at(params, "archived").or_else(|| lifecycle_archived_from_method(method));
        }
        RuntimeSignalKind::ThreadSettingsUpdated => {
            signal.status = Some("settings_updated".to_string());
        }
        RuntimeSignalKind::ThreadTokenUsageUpdated => {
            signal.status = Some("token_usage_updated".to_string());
        }
        RuntimeSignalKind::TurnDiffUpdated => {
            signal.diff = string_at(params, "diff").or_else(|| string_at(params, "patch"));
            signal.files = params.get("files").cloned();
        }
        RuntimeSignalKind::ProcessExited => {
            signal.process_id = first_string([
                string_at(params, "processId").as_deref(),
                string_at(params, "process_id").as_deref(),
                string_at(params, "id").as_deref(),
            ]);
            signal.exit_code = i64_at(params, "exitCode")
                .or_else(|| i64_at(params, "exit_code"))
                .or_else(|| i64_at(params, "code"));
        }
        RuntimeSignalKind::ServerRequestResolved => {
            signal.request_id = first_string([
                string_at(params, "requestId").as_deref(),
                string_at(params, "request_id").as_deref(),
                string_at(params, "id").as_deref(),
            ]);
            signal.status = first_string([
                string_at(params, "status").as_deref(),
                string_at(params, "outcome").as_deref(),
                string_at(params, "result").as_deref(),
            ])
            .or_else(|| Some("resolved".to_string()));
        }
        RuntimeSignalKind::ProviderStateUpdated => {
            signal.status = first_string([
                string_at(params, "status").as_deref(),
                string_at(params, "state").as_deref(),
                string_at(params, "event").as_deref(),
                string_at(params, "type").as_deref(),
            ])
            .or_else(|| provider_state_status_from_method(method));
            signal.message = first_string([
                string_at(params, "message").as_deref(),
                string_at(params, "text").as_deref(),
                string_at(params, "description").as_deref(),
                string_at(params, "error").as_deref(),
            ]);
            signal.name = first_string([
                string_at(params, "name").as_deref(),
                string_at(params, "title").as_deref(),
                string_at(params, "app").as_deref(),
                string_at(params, "account").as_deref(),
                string_at(params, "query").as_deref(),
            ]);
        }
    }
    Some(signal)
}

fn runtime_signal_kind(method: &str) -> Option<RuntimeSignalKind> {
    match method {
        "warning" => Some(RuntimeSignalKind::Warning),
        "model/rerouted" => Some(RuntimeSignalKind::ModelRerouted),
        "realtime/transcriptDelta" | "thread/realtime/transcript/delta" => {
            Some(RuntimeSignalKind::RealtimeTranscriptDelta)
        }
        "realtime/audioDelta" | "thread/realtime/outputAudio/delta" => {
            Some(RuntimeSignalKind::RealtimeAudioDelta)
        }
        "thread/started"
        | "thread/status/changed"
        | "thread/archived"
        | "thread/unarchived"
        | "thread/deleted"
        | "thread/closed"
        | "thread/compacted"
        | "thread/name/updated" => Some(RuntimeSignalKind::ThreadLifecycleChanged),
        "thread/settings/updated" => Some(RuntimeSignalKind::ThreadSettingsUpdated),
        "thread/tokenUsage/updated" => Some(RuntimeSignalKind::ThreadTokenUsageUpdated),
        "turn/diff/updated" => Some(RuntimeSignalKind::TurnDiffUpdated),
        "process/exited" => Some(RuntimeSignalKind::ProcessExited),
        "serverRequest/resolved" => Some(RuntimeSignalKind::ServerRequestResolved),
        "account/login/completed"
        | "account/rateLimits/updated"
        | "account/updated"
        | "app/list/updated"
        | "externalAgentConfig/import/completed"
        | "fuzzyFileSearch/sessionCompleted"
        | "fuzzyFileSearch/sessionUpdated"
        | "remoteControl/status/changed"
        | "windowsSandbox/setupCompleted" => Some(RuntimeSignalKind::ProviderStateUpdated),
        _ => None,
    }
}

fn provider_state_status_from_method(method: &str) -> Option<String> {
    match method {
        "account/login/completed" => Some("account_login_completed".to_string()),
        "account/rateLimits/updated" => Some("account_rate_limits_updated".to_string()),
        "account/updated" => Some("account_updated".to_string()),
        "app/list/updated" => Some("app_list_updated".to_string()),
        "externalAgentConfig/import/completed" => {
            Some("external_agent_config_import_completed".to_string())
        }
        "fuzzyFileSearch/sessionCompleted" => Some("fuzzy_file_search_completed".to_string()),
        "fuzzyFileSearch/sessionUpdated" => Some("fuzzy_file_search_updated".to_string()),
        "remoteControl/status/changed" => Some("remote_control_status_changed".to_string()),
        "windowsSandbox/setupCompleted" => Some("windows_sandbox_setup_completed".to_string()),
        _ => None,
    }
}

fn normalize_codex_server_request(
    id: i64,
    method: &str,
    params: &Value,
) -> NormalizedServerRequest {
    let kind = server_request_kind(method);
    NormalizedServerRequest {
        kind,
        request_id: id.to_string(),
        method: method.to_string(),
        thread_id: string_at(params, "threadId")
            .or_else(|| string_at(params, "thread_id"))
            .or_else(|| string_at(params, "conversationId"))
            .or_else(|| string_at(params, "conversation_id"))
            .or_else(|| nested_string_at(params, "/thread", &["id", "threadId", "thread_id"])),
        turn_id: string_at(params, "turnId").or_else(|| string_at(params, "turn_id")),
        item_id: string_at(params, "itemId")
            .or_else(|| string_at(params, "item_id"))
            .or_else(|| string_at(params, "sourceItemId"))
            .or_else(|| string_at(params, "source_item_id"))
            .or_else(|| string_at(params, "toolCallId"))
            .or_else(|| string_at(params, "tool_call_id")),
        scope: server_request_scope(kind, params),
        title: Some(server_request_title(kind).to_string()),
        prompt: server_request_prompt(params),
        selected_policy: string_at(params, "approvalPolicy")
            .or_else(|| string_at(params, "approval_policy"))
            .or_else(|| string_at(params, "permissionPolicy"))
            .or_else(|| string_at(params, "permission_policy")),
        metadata: metadata_for_server_request(params),
        provider: ProviderMetadata {
            provider: "codex".to_string(),
            method: Some(method.to_string()),
            schema_version: string_at(params, "schemaVersion"),
            raw_payload: params.clone(),
        },
    }
}

fn server_request_kind(method: &str) -> ServerRequestKind {
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

fn normalize_codex_thread_item_notification(
    method: &str,
    params: &Value,
) -> Option<NormalizedThreadItem> {
    let status = thread_item_status_from_method(method)?;
    let item = params.get("item").unwrap_or(params);
    let item_type = string_at(item, "type").or_else(|| item_type_from_method(method));
    let kind = item_type
        .as_deref()
        .map(thread_item_kind_for_type)
        .unwrap_or(ThreadItemKind::Unknown);

    let item_id = string_at(params, "itemId").or_else(|| string_at(item, "id"));
    let text = text_for_thread_item(method, item, params);
    let title = title_for_thread_item(kind, item, text.as_deref());
    let metadata = metadata_for_thread_item(item);

    Some(NormalizedThreadItem {
        kind,
        status,
        thread_id: string_at(params, "threadId").or_else(|| string_at(item, "threadId")),
        turn_id: string_at(params, "turnId").or_else(|| string_at(item, "turnId")),
        item_id,
        parent_thread_id: string_at(item, "parentThreadId")
            .or_else(|| string_at(item, "parent_thread_id"))
            .or_else(|| string_at(item, "senderThreadId")),
        child_thread_id: string_at(item, "childThreadId")
            .or_else(|| string_at(item, "child_thread_id"))
            .or_else(|| string_at(item, "threadId")),
        sender: string_at(item, "sender")
            .or_else(|| string_at(item, "senderName"))
            .or_else(|| string_at(item, "agentName")),
        role: string_at(item, "role")
            .or_else(|| string_at(item, "agentRole"))
            .or_else(|| string_at(item, "agent_role")),
        title,
        text,
        metadata,
        provider: ProviderMetadata {
            provider: "codex".to_string(),
            method: Some(method.to_string()),
            schema_version: string_at(params, "schemaVersion")
                .or_else(|| string_at(item, "schemaVersion")),
            raw_payload: params.clone(),
        },
    })
}

fn thread_item_status_from_method(method: &str) -> Option<ThreadItemStatus> {
    match method {
        "item/started" => Some(ThreadItemStatus::Started),
        "item/completed" => Some(ThreadItemStatus::Completed),
        "item/failed" => Some(ThreadItemStatus::Failed),
        "item/agentMessage/delta"
        | "item/reasoning/delta"
        | "item/reasoning/textDelta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/summaryPartAdded"
        | "item/plan/delta"
        | "turn/plan/updated"
        | "item/commandExecution/outputDelta"
        | "item/commandExecution/terminalInteraction"
        | "item/fileChange/outputDelta"
        | "item/fileChange/patchUpdated"
        | "item/mcpToolCall/progress"
        | "item/subAgentActivity/delta"
        | "item/collabAgentToolCall/progress"
        | "command/exec/outputDelta"
        | "process/outputDelta" => Some(ThreadItemStatus::Updated),
        _ => {
            if method.starts_with("item/") && method.ends_with("/delta") {
                Some(ThreadItemStatus::Updated)
            } else {
                None
            }
        }
    }
}

fn thread_item_kind_for_type(item_type: &str) -> ThreadItemKind {
    match item_type {
        "userMessage" => ThreadItemKind::UserMessage,
        "hookPrompt" => ThreadItemKind::HookPrompt,
        "agentMessage" => ThreadItemKind::AgentMessage,
        "plan" => ThreadItemKind::Plan,
        "reasoning" => ThreadItemKind::Reasoning,
        "commandExecution" => ThreadItemKind::CommandExecution,
        "fileChange" => ThreadItemKind::FileChange,
        "mcpToolCall" => ThreadItemKind::McpToolCall,
        "dynamicToolCall" => ThreadItemKind::DynamicToolCall,
        "collabAgentToolCall" => ThreadItemKind::CollabAgentToolCall,
        "subAgentActivity" => ThreadItemKind::SubAgentActivity,
        "webSearch" => ThreadItemKind::WebSearch,
        "imageView" => ThreadItemKind::ImageView,
        "imageGeneration" => ThreadItemKind::ImageGeneration,
        "enteredReviewMode" => ThreadItemKind::EnteredReviewMode,
        "exitedReviewMode" => ThreadItemKind::ExitedReviewMode,
        "contextCompaction" => ThreadItemKind::ContextCompaction,
        _ => ThreadItemKind::Unknown,
    }
}

fn text_for_thread_item(method: &str, item: &Value, params: &Value) -> Option<String> {
    if method.ends_with("/delta") || method == "turn/plan/updated" {
        return string_at(params, "delta")
            .or_else(|| string_at(params, "text"))
            .or_else(|| string_at(params, "content"))
            .or_else(|| string_at(item, "delta"));
    }

    string_at(item, "text")
        .or_else(|| string_at(item, "message"))
        .or_else(|| string_at(item, "content"))
        .or_else(|| string_at(item, "summary"))
        .or_else(|| item.get("input").and_then(|input| string_at(input, "text")))
}

fn title_for_thread_item(kind: ThreadItemKind, item: &Value, text: Option<&str>) -> Option<String> {
    string_at(item, "title")
        .or_else(|| string_at(item, "name"))
        .or_else(|| {
            if matches!(
                kind,
                ThreadItemKind::EnteredReviewMode | ThreadItemKind::ExitedReviewMode
            ) {
                Some(
                    match kind {
                        ThreadItemKind::EnteredReviewMode => "Entered review mode",
                        ThreadItemKind::ExitedReviewMode => "Exited review mode",
                        _ => unreachable!(),
                    }
                    .to_string(),
                )
            } else {
                None
            }
        })
        .or_else(|| text.map(compact_title))
}

fn metadata_for_thread_item(item: &Value) -> Value {
    let mut metadata = serde_json::Map::new();
    for key in [
        "status",
        "model",
        "agentRole",
        "agentName",
        "nickname",
        "target",
        "url",
        "files",
        "diff",
        "tokens",
    ] {
        if let Some(value) = item.get(key) {
            metadata.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(metadata)
}

fn compact_title(text: &str) -> String {
    let trimmed = text.trim();
    let mut title = trimmed.chars().take(80).collect::<String>();
    if trimmed.chars().count() > 80 {
        title.push_str("...");
    }
    title
}

fn normalize_codex_tool_notification(
    method: &str,
    params: &Value,
) -> Option<ace_runtime::tools::SemanticToolCall> {
    let status = match method {
        "item/started" => ToolRunStatus::Started,
        "item/completed" => ToolRunStatus::Completed,
        "item/commandExecution/outputDelta"
        | "item/commandExecution/terminalInteraction"
        | "item/fileChange/outputDelta"
        | "item/fileChange/patchUpdated"
        | "item/mcpToolCall/progress"
        | "item/dynamicToolCall/progress"
        | "item/collabAgentToolCall/progress"
        | "item/subAgentActivity/delta"
        | "command/exec/outputDelta"
        | "process/outputDelta" => ToolRunStatus::Updated,
        "item/failed" => ToolRunStatus::Failed,
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval" => ToolRunStatus::ApprovalRequested,
        _ => return None,
    };

    let item = params.get("item").unwrap_or(params);
    let item_type = string_at(item, "type")
        .or_else(|| item_type_from_method(method))
        .unwrap_or_else(|| method.to_string());
    if !is_tool_item_type(&item_type) {
        return None;
    }
    let mut provider = ProviderToolMetadata::new();
    provider.provider = Some("codex".to_string());
    provider.method = Some(method.to_string());
    provider.thread_id = string_at(params, "threadId");
    provider.turn_id = string_at(params, "turnId");
    provider.item_id = string_at(params, "itemId").or_else(|| string_at(item, "id"));
    provider.tool_name = tool_name_for_item(&item_type, item);
    provider.server_name = string_at_deep(item, "serverName")
        .or_else(|| string_at_deep(item, "server_name"))
        .or_else(|| string_at_deep(item, "server"))
        .or_else(|| string_at_deep(item, "mcpServer"));
    provider.operation = operation_for_item(&item_type, item);
    provider.raw_args = args_for_item(item);
    provider.raw_result = item.get("result").cloned().unwrap_or(Value::Null);
    provider.raw_payload = params.clone();

    let transport = transport_for_item(&item_type, &provider);
    Some(normalize_tool_call(ToolNormalizationInput {
        transport,
        status,
        provider,
        item_type: Some(item_type),
    }))
}

fn normalize_codex_server_request_tool(
    id: i64,
    method: &str,
    params: &Value,
) -> Option<ace_runtime::tools::SemanticToolCall> {
    let kind = server_request_kind(method);
    let item_type = tool_item_type_for_server_request(kind)?;
    let mut provider = ProviderToolMetadata::new();
    provider.provider = Some("codex".to_string());
    provider.method = Some(method.to_string());
    provider.thread_id = string_at(params, "threadId")
        .or_else(|| string_at(params, "thread_id"))
        .or_else(|| nested_string_at(params, "/thread", &["id", "threadId", "thread_id"]));
    provider.turn_id = string_at(params, "turnId").or_else(|| string_at(params, "turn_id"));
    provider.item_id = string_at(params, "itemId")
        .or_else(|| string_at(params, "item_id"))
        .or_else(|| string_at(params, "sourceItemId"))
        .or_else(|| string_at(params, "source_item_id"))
        .or_else(|| string_at(params, "toolCallId"))
        .or_else(|| string_at(params, "tool_call_id"))
        .or_else(|| Some(id.to_string()));
    provider.server_name = string_at_deep(params, "serverName")
        .or_else(|| string_at_deep(params, "server_name"))
        .or_else(|| string_at_deep(params, "server"))
        .or_else(|| string_at_deep(params, "mcpServer"));
    provider.tool_name = tool_name_for_server_request(kind, params);
    provider.operation = operation_for_server_request(kind, params);
    provider.raw_args = args_for_server_request(params);
    provider.raw_result = params.get("result").cloned().unwrap_or(Value::Null);
    provider.raw_payload = params.clone();

    Some(normalize_tool_call(ToolNormalizationInput {
        transport: transport_for_server_request(kind, &provider),
        status: ToolRunStatus::ApprovalRequested,
        provider,
        item_type: Some(item_type.to_string()),
    }))
}

fn tool_item_type_for_server_request(kind: ServerRequestKind) -> Option<&'static str> {
    match kind {
        ServerRequestKind::CommandApproval | ServerRequestKind::ExecApproval => {
            Some("commandExecution")
        }
        ServerRequestKind::FileChangeApproval | ServerRequestKind::ApplyPatchApproval => {
            Some("fileChange")
        }
        ServerRequestKind::McpElicitation | ServerRequestKind::ToolUserInput => Some("mcpToolCall"),
        ServerRequestKind::DynamicToolCall => Some("dynamicToolCall"),
        ServerRequestKind::Unknown
        | ServerRequestKind::PermissionApproval
        | ServerRequestKind::AccountTokenRefresh
        | ServerRequestKind::Attestation => None,
    }
}

fn tool_name_for_server_request(kind: ServerRequestKind, params: &Value) -> Option<String> {
    string_at_deep(params, "toolName")
        .or_else(|| string_at_deep(params, "tool_name"))
        .or_else(|| string_at_deep(params, "tool"))
        .or_else(|| string_at_deep(params, "function"))
        .or_else(|| string_at_deep(params, "name"))
        .or_else(|| match kind {
            ServerRequestKind::CommandApproval | ServerRequestKind::ExecApproval => {
                Some("shell".to_string())
            }
            ServerRequestKind::FileChangeApproval | ServerRequestKind::ApplyPatchApproval => {
                Some("apply_patch".to_string())
            }
            ServerRequestKind::McpElicitation | ServerRequestKind::ToolUserInput => {
                Some("mcp".to_string())
            }
            _ => None,
        })
}

fn operation_for_server_request(kind: ServerRequestKind, params: &Value) -> Option<String> {
    string_at_deep(params, "operation")
        .or_else(|| string_at_deep(params, "action"))
        .or_else(|| string_at_deep(params, "action_type"))
        .or_else(|| match kind {
            ServerRequestKind::CommandApproval | ServerRequestKind::ExecApproval => {
                Some("run".to_string())
            }
            ServerRequestKind::FileChangeApproval | ServerRequestKind::ApplyPatchApproval => {
                Some("apply_patch".to_string())
            }
            ServerRequestKind::McpElicitation => Some("elicitation".to_string()),
            ServerRequestKind::ToolUserInput => Some("user_input".to_string()),
            _ => None,
        })
}

fn args_for_server_request(params: &Value) -> Value {
    params
        .get("input")
        .or_else(|| params.get("arguments"))
        .or_else(|| params.get("args"))
        .cloned()
        .unwrap_or_else(|| params.clone())
}

fn transport_for_server_request(
    kind: ServerRequestKind,
    provider: &ProviderToolMetadata,
) -> ToolTransport {
    let label = [
        provider.tool_name.as_deref().unwrap_or_default(),
        provider.server_name.as_deref().unwrap_or_default(),
        provider.operation.as_deref().unwrap_or_default(),
    ]
    .join(" ")
    .to_lowercase();
    if label.contains("ace_browser") || label.contains("browser") || label.contains("playwright") {
        ToolTransport::BrowserBridge
    } else if label.contains("computer") || label.contains("desktop") {
        ToolTransport::ComputerBridge
    } else {
        match kind {
            ServerRequestKind::CommandApproval | ServerRequestKind::ExecApproval => {
                ToolTransport::Shell
            }
            ServerRequestKind::FileChangeApproval | ServerRequestKind::ApplyPatchApproval => {
                ToolTransport::Filesystem
            }
            ServerRequestKind::McpElicitation | ServerRequestKind::ToolUserInput => {
                ToolTransport::Mcp
            }
            ServerRequestKind::DynamicToolCall => ToolTransport::CodexDynamic,
            _ => ToolTransport::CodexBuiltin,
        }
    }
}

fn is_tool_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "commandExecution"
            | "fileChange"
            | "mcpToolCall"
            | "dynamicToolCall"
            | "collabAgentToolCall"
            | "subAgentActivity"
            | "webSearch"
            | "imageView"
            | "imageGeneration"
    )
}

fn transport_for_item(item_type: &str, provider: &ProviderToolMetadata) -> ToolTransport {
    let label = [
        item_type,
        provider.tool_name.as_deref().unwrap_or_default(),
        provider.server_name.as_deref().unwrap_or_default(),
        provider.operation.as_deref().unwrap_or_default(),
    ]
    .join(" ")
    .to_lowercase();
    if label.contains("ace_browser") || label.contains("browser") {
        ToolTransport::BrowserBridge
    } else if label.contains("computer") {
        ToolTransport::ComputerBridge
    } else {
        match item_type {
            "commandExecution" => ToolTransport::Shell,
            "fileChange" => ToolTransport::Filesystem,
            "mcpToolCall" => ToolTransport::Mcp,
            "dynamicToolCall" => ToolTransport::CodexDynamic,
            _ => ToolTransport::CodexBuiltin,
        }
    }
}

fn tool_name_for_item(item_type: &str, item: &Value) -> Option<String> {
    string_at_deep(item, "toolName")
        .or_else(|| string_at_deep(item, "tool_name"))
        .or_else(|| string_at_deep(item, "tool"))
        .or_else(|| string_at_deep(item, "function"))
        .or_else(|| string_at_deep(item, "name"))
        .or_else(|| {
            if item_type == "commandExecution" {
                Some("shell".to_string())
            } else if item_type == "fileChange" {
                Some("apply_patch".to_string())
            } else if item_type == "webSearch" {
                Some("web_search".to_string())
            } else if item_type == "imageView" {
                Some("image_view".to_string())
            } else if item_type == "imageGeneration" {
                Some("image_generation".to_string())
            } else {
                None
            }
        })
}

fn operation_for_item(item_type: &str, item: &Value) -> Option<String> {
    string_at_deep(item, "operation")
        .or_else(|| string_at_deep(item, "action"))
        .or_else(|| string_at_deep(item, "action_type"))
        .or_else(|| {
            if item_type == "commandExecution" {
                Some("run".to_string())
            } else if item_type == "webSearch" {
                Some("search".to_string())
            } else if item_type == "imageView" {
                Some("view".to_string())
            } else if item_type == "imageGeneration" {
                Some("generate".to_string())
            } else {
                None
            }
        })
}

fn args_for_item(item: &Value) -> Value {
    item.get("input")
        .or_else(|| item.get("arguments"))
        .or_else(|| item.get("args"))
        .cloned()
        .unwrap_or_else(|| item.clone())
}

fn item_type_from_method(method: &str) -> Option<String> {
    if method.contains("commandExecution") || method.starts_with("command/exec") {
        Some("commandExecution".to_string())
    } else if method.contains("agentMessage") {
        Some("agentMessage".to_string())
    } else if method.contains("userMessage") {
        Some("userMessage".to_string())
    } else if method.contains("hookPrompt") {
        Some("hookPrompt".to_string())
    } else if method.contains("plan") {
        Some("plan".to_string())
    } else if method.contains("reasoning") {
        Some("reasoning".to_string())
    } else if method.contains("fileChange") {
        Some("fileChange".to_string())
    } else if method.contains("mcpToolCall") {
        Some("mcpToolCall".to_string())
    } else if method.contains("dynamicToolCall") {
        Some("dynamicToolCall".to_string())
    } else if method.contains("collabAgentToolCall") {
        Some("collabAgentToolCall".to_string())
    } else if method.contains("subAgentActivity") {
        Some("subAgentActivity".to_string())
    } else if method.contains("webSearch") {
        Some("webSearch".to_string())
    } else if method.contains("imageView") {
        Some("imageView".to_string())
    } else if method.contains("imageGeneration") {
        Some("imageGeneration".to_string())
    } else {
        None
    }
}

fn lifecycle_status_from_method(method: &str) -> Option<String> {
    Some(
        match method {
            "thread/started" => "started",
            "thread/archived" => "archived",
            "thread/unarchived" => "unarchived",
            "thread/deleted" => "deleted",
            "thread/closed" => "closed",
            "thread/compacted" => "compacted",
            "thread/name/updated" => "renamed",
            _ => return None,
        }
        .to_string(),
    )
}

fn lifecycle_active_from_method(method: &str) -> Option<bool> {
    match method {
        "thread/deleted" | "thread/closed" => Some(false),
        "thread/started" => Some(true),
        _ => None,
    }
}

fn lifecycle_archived_from_method(method: &str) -> Option<bool> {
    match method {
        "thread/archived" => Some(true),
        "thread/unarchived" => Some(false),
        _ => None,
    }
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(|value| match value {
            Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
}

fn bool_at(value: &Value, key: &str) -> Option<bool> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_bool)
}

fn i64_at(value: &Value, key: &str) -> Option<i64> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_i64)
}

fn string_at_deep(value: &Value, key: &str) -> Option<String> {
    string_at(value, key).or_else(|| {
        ["input", "arguments", "args", "parameters", "params"]
            .into_iter()
            .filter_map(|nested| value.get(nested))
            .find_map(|nested| string_at_deep(nested, key))
    })
}

fn nested_string_at(value: &Value, pointer: &str, keys: &[&str]) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(|nested| keys.iter().find_map(|key| string_at(nested, key)))
}

fn first_string<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use ace_runtime::{
        provider::{ProviderEvent, ServerRequestKind, ThreadItemKind, ThreadItemStatus},
        tools::{ToolActionKind, ToolSurface},
    };
    use serde_json::json;

    use super::*;

    fn first_thread_item(events: &[ProviderEvent]) -> &ace_runtime::provider::NormalizedThreadItem {
        events
            .iter()
            .find_map(|event| match event {
                ProviderEvent::ThreadItem { item } => Some(item.as_ref()),
                _ => None,
            })
            .expect("thread item")
    }

    #[test]
    fn normalizes_codex_browser_dynamic_tool_to_semantic_browser_event() {
        let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-1",
                    "type": "dynamicToolCall",
                    "toolName": "ace_browser",
                    "input": {
                        "operation": "cua_click",
                        "label": "Deploy"
                    }
                }
            }),
        });

        let ProviderEvent::SemanticTool { tool } = &events[0] else {
            panic!("expected semantic tool");
        };
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserClick);
        assert_eq!(tool.display.title, "Clicked Deploy in Browser");
        assert_eq!(tool.provider.raw_payload["threadId"], "thread-1");
    }

    #[test]
    fn normalizes_nested_bridge_payloads_without_generic_mcp_titles() {
        let raw = json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "item": {
                "id": "item-1",
                "type": "mcpToolCall",
                "serverName": "browser",
                "toolName": "playwright_locator_click",
                "input": {
                    "arguments": {
                        "operation": "playwright_locator_click",
                        "selector": "#continue"
                    }
                },
                "result": {
                    "ok": true
                }
            }
        });
        let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: raw.clone(),
        });

        let ProviderEvent::SemanticTool { tool } = &events[0] else {
            panic!("expected semantic tool");
        };
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserClick);
        assert_eq!(tool.display.title, "Clicked #continue in Browser");
        assert!(!tool.display.title.contains("MCP"));
        assert_eq!(tool.provider.raw_payload, raw);
        assert_eq!(tool.provider.raw_result["ok"], true);
    }

    #[test]
    fn normalizes_computer_use_mcp_tool_names_as_desktop_actions() {
        let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-1",
                    "type": "mcpToolCall",
                    "serverName": "computer-use",
                    "toolName": "press_key",
                    "input": {
                        "arguments": {
                            "app": "Xcode",
                            "key": "Return"
                        }
                    }
                }
            }),
        });

        let ProviderEvent::SemanticTool { tool } = &events[0] else {
            panic!("expected semantic tool");
        };
        assert_eq!(tool.surface, ToolSurface::Computer);
        assert_eq!(tool.action, ToolActionKind::ComputerKey);
        assert_eq!(tool.display.title, "Pressed key in Xcode on Computer");
    }

    #[test]
    fn normalizes_codex_command_item_to_terminal_event() {
        let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-1",
                    "type": "commandExecution",
                    "command": "cargo test"
                }
            }),
        });

        let ProviderEvent::SemanticTool { tool } = &events[0] else {
            panic!("expected semantic tool");
        };
        assert_eq!(tool.surface, ToolSurface::Terminal);
        assert_eq!(tool.display.title, "Ran `cargo test`");
    }

    #[test]
    fn normalizes_failed_tool_items_without_semantic_non_tool_failures() {
        let failed_tool = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/failed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-1",
                    "type": "dynamicToolCall",
                    "toolName": "ace_browser",
                    "input": {
                        "operation": "navigate_tab_url",
                        "url": "http://localhost:5173"
                    },
                    "error": "navigation failed"
                }
            }),
        });

        let ProviderEvent::SemanticTool { tool } = &failed_tool[0] else {
            panic!("expected failed semantic tool");
        };
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserNavigate);
        assert_eq!(
            tool.display.status,
            ace_runtime::tools::ToolRunStatus::Failed
        );
        assert_eq!(
            tool.display.title,
            "Failed http://localhost:5173 in Browser"
        );
        assert_eq!(
            tool.provider.raw_payload["item"]["error"],
            "navigation failed"
        );

        let failed_message = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/failed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "item": {
                    "id": "message-1",
                    "type": "agentMessage",
                    "text": "Could not respond"
                }
            }),
        });
        assert!(
            failed_message
                .iter()
                .all(|event| !matches!(event, ProviderEvent::SemanticTool { .. }))
        );
        assert!(matches!(
            failed_message[0],
            ProviderEvent::ThreadItem { .. }
        ));
    }

    #[test]
    fn normalizes_dynamic_tool_progress_to_semantic_updates() {
        let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/dynamicToolCall/progress".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "item": {
                    "id": "item-1",
                    "type": "dynamicToolCall",
                    "toolName": "ace_browser",
                    "input": {
                        "operation": "tab_dev_logs"
                    }
                }
            }),
        });

        let ProviderEvent::SemanticTool { tool } = &events[0] else {
            panic!("expected semantic update");
        };
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserConsole);
        assert_eq!(
            tool.display.status,
            ace_runtime::tools::ToolRunStatus::Updated
        );
        assert_eq!(tool.display.title, "Reading Browser console logs");
    }

    #[test]
    fn normalizes_browser_tab_zoom_resize_and_terminal_output_updates() {
        let cases = [
            (
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-tab",
                    "item": {
                        "id": "item-tab",
                        "type": "dynamicToolCall",
                        "toolName": "ace_browser",
                        "input": { "operation": "select_tab", "label": "Docs" }
                    }
                }),
                ToolActionKind::BrowserTab,
                "Switching Docs in Browser",
            ),
            (
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-zoom",
                    "item": {
                        "id": "item-zoom",
                        "type": "dynamicToolCall",
                        "toolName": "ace_browser",
                        "input": { "operation": "set_browser_zoom", "zoom": "125%" }
                    }
                }),
                ToolActionKind::BrowserZoom,
                "Changing zoom for 125% in Browser",
            ),
            (
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-resize",
                    "item": {
                        "id": "item-resize",
                        "type": "dynamicToolCall",
                        "toolName": "ace_browser",
                        "input": {
                            "operation": "set_viewport_size",
                            "width": 1440,
                            "height": 900
                        }
                    }
                }),
                ToolActionKind::BrowserViewport,
                "Resizing 1440x900 in Browser",
            ),
        ];

        for (params, action, title) in cases {
            let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
                method: "item/dynamicToolCall/progress".to_string(),
                params,
            });
            let ProviderEvent::SemanticTool { tool } = &events[0] else {
                panic!("expected semantic browser update");
            };
            assert_eq!(tool.surface, ToolSurface::Browser);
            assert_eq!(tool.action, action);
            assert_eq!(tool.display.title, title);
            assert!(!tool.display.title.contains("MCP tool"));
        }

        let terminal = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "process/outputDelta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "cmd-1",
                "item": {
                    "id": "cmd-1",
                    "type": "commandExecution",
                    "processId": "proc-1",
                    "delta": "cargo test output"
                }
            }),
        });

        let ProviderEvent::SemanticTool { tool } = &terminal[0] else {
            panic!("expected semantic terminal update");
        };
        assert_eq!(tool.surface, ToolSurface::Terminal);
        assert_eq!(tool.action, ToolActionKind::TerminalOutput);
        assert_eq!(tool.display.title, "Reading terminal output from proc-1");
    }

    #[test]
    fn normalizes_stdio_lifecycle_events() {
        let stderr =
            normalize_codex_inbound_event(&CodexInboundEvent::StderrLine("warning".to_string()));
        assert_eq!(
            stderr,
            vec![ProviderEvent::StderrLine {
                line: "warning".to_string()
            }]
        );

        let exited =
            normalize_codex_inbound_event(&CodexInboundEvent::ServerExited { code: Some(0) });
        assert_eq!(exited, vec![ProviderEvent::Exited { code: Some(0) }]);
    }

    #[test]
    fn normalizes_runtime_signals_and_preserves_raw_notifications() {
        let warning = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "warning".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "message": "Context is almost full",
                "severity": "warning"
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &warning[0] else {
            panic!("expected runtime signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::Warning
        );
        assert_eq!(signal.message.as_deref(), Some("Context is almost full"));
        assert_eq!(signal.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(signal.provider.raw_payload["severity"], "warning");
        assert!(matches!(warning[1], ProviderEvent::RawNotification { .. }));

        let reroute = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "model/rerouted".to_string(),
            params: json!({
                "thread": { "id": "thread-1" },
                "turn": { "id": "turn-1" },
                "fromModel": "gpt-5",
                "toModel": "gpt-5-mini",
                "reason": "capacity"
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &reroute[0] else {
            panic!("expected reroute signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::ModelRerouted
        );
        assert_eq!(signal.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(signal.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(signal.from_model.as_deref(), Some("gpt-5"));
        assert_eq!(signal.to_model.as_deref(), Some("gpt-5-mini"));

        let transcript = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "realtime/transcriptDelta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "delta": "hello"
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &transcript[0] else {
            panic!("expected transcript signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::RealtimeTranscriptDelta
        );
        assert_eq!(signal.text.as_deref(), Some("hello"));

        let account = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "account/updated".to_string(),
            params: json!({
                "status": "signed_in",
                "account": "work",
                "email": "user@example.com"
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &account[0] else {
            panic!("expected provider state signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::ProviderStateUpdated
        );
        assert_eq!(signal.status.as_deref(), Some("signed_in"));
        assert_eq!(signal.name.as_deref(), Some("work"));
        assert_eq!(signal.provider.method.as_deref(), Some("account/updated"));
        assert_eq!(signal.provider.raw_payload["email"], "user@example.com");
        assert!(matches!(account[1], ProviderEvent::RawNotification { .. }));
    }

    #[test]
    fn normalizes_provider_state_notifications() {
        let cases = [
            (
                "account/login/completed",
                json!({ "message": "Signed in", "account": "chatgpt" }),
                "account_login_completed",
                Some("Signed in"),
            ),
            (
                "app/list/updated",
                json!({ "apps": [{ "id": "browser" }] }),
                "app_list_updated",
                None,
            ),
            (
                "externalAgentConfig/import/completed",
                json!({ "status": "imported", "name": "Codex" }),
                "imported",
                None,
            ),
            (
                "fuzzyFileSearch/sessionUpdated",
                json!({ "query": "main", "status": "searching" }),
                "searching",
                None,
            ),
            (
                "fuzzyFileSearch/sessionCompleted",
                json!({ "query": "main", "results": [] }),
                "fuzzy_file_search_completed",
                None,
            ),
            (
                "remoteControl/status/changed",
                json!({ "status": "connected" }),
                "connected",
                None,
            ),
            (
                "windowsSandbox/setupCompleted",
                json!({ "message": "Sandbox ready" }),
                "windows_sandbox_setup_completed",
                Some("Sandbox ready"),
            ),
        ];

        for (method, params, status, message) in cases {
            let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
                method: method.to_string(),
                params,
            });
            let ProviderEvent::RuntimeSignal { signal } = &events[0] else {
                panic!("expected provider state signal for {method}");
            };
            assert_eq!(
                signal.kind,
                ace_runtime::provider::RuntimeSignalKind::ProviderStateUpdated,
                "{method}"
            );
            assert_eq!(signal.status.as_deref(), Some(status), "{method}");
            assert_eq!(signal.message.as_deref(), message, "{method}");
            assert_eq!(signal.provider.method.as_deref(), Some(method));
            assert!(matches!(events[1], ProviderEvent::RawNotification { .. }));
        }
    }

    #[test]
    fn normalizes_current_lifecycle_diff_and_process_notifications() {
        let lifecycle = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "thread/status/changed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "status": "running",
                "active": true
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &lifecycle[0] else {
            panic!("expected lifecycle signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::ThreadLifecycleChanged
        );
        assert_eq!(signal.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(signal.status.as_deref(), Some("running"));
        assert_eq!(signal.active, Some(true));
        assert_eq!(signal.provider.raw_payload["status"], "running");

        let renamed = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "thread/name/updated".to_string(),
            params: json!({
                "thread": { "id": "thread-1", "name": "Adapter parity" }
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &renamed[0] else {
            panic!("expected rename signal");
        };
        assert_eq!(signal.status.as_deref(), Some("renamed"));
        assert_eq!(signal.name.as_deref(), Some("Adapter parity"));

        let diff = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "turn/diff/updated".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "diff": "@@ -1 +1 @@",
                "files": [{ "path": "src/lib.rs" }]
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &diff[0] else {
            panic!("expected diff signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::TurnDiffUpdated
        );
        assert_eq!(signal.diff.as_deref(), Some("@@ -1 +1 @@"));
        assert_eq!(signal.files.as_ref().unwrap()[0]["path"], "src/lib.rs");

        let process = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "process/exited".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "processId": "proc-1",
                "exitCode": 2
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &process[0] else {
            panic!("expected process signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::ProcessExited
        );
        assert_eq!(signal.process_id.as_deref(), Some("proc-1"));
        assert_eq!(signal.exit_code, Some(2));
    }

    #[test]
    fn normalizes_codex_approval_server_request_and_preserves_raw_payload() {
        let events = normalize_codex_inbound_event(&CodexInboundEvent::ServerRequest {
            id: 42,
            method: "command/approvalRequest".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "command": "cargo test --workspace",
                "cwd": "/repo",
                "prompt": "Run tests?",
                "approvalPolicy": "on-request"
            }),
        });

        let ProviderEvent::ServerRequest { request } = &events[0] else {
            panic!("expected normalized server request");
        };
        assert_eq!(request.kind, ServerRequestKind::CommandApproval);
        assert_eq!(request.request_id, "42");
        assert_eq!(request.scope.as_deref(), Some("command"));
        assert_eq!(request.title.as_deref(), Some("Approve command execution"));
        assert_eq!(request.prompt.as_deref(), Some("Run tests?"));
        assert_eq!(request.selected_policy.as_deref(), Some("on-request"));
        assert_eq!(request.metadata["command"], "cargo test --workspace");
        assert_eq!(request.provider.raw_payload["cwd"], "/repo");

        let ProviderEvent::RawServerRequest { id, method, params } = &events[1] else {
            panic!("expected raw server request");
        };
        assert_eq!(id, "42");
        assert_eq!(method, "command/approvalRequest");
        assert_eq!(params["command"], "cargo test --workspace");
    }

    #[test]
    fn normalizes_mcp_elicitation_server_request() {
        let events = normalize_codex_inbound_event(&CodexInboundEvent::ServerRequest {
            id: 77,
            method: "mcp/elicitation".to_string(),
            params: json!({
                "threadId": "thread-1",
                "serverName": "github",
                "toolName": "create_issue",
                "question": "Which repository?",
                "schemaVersion": "2026-01-01"
            }),
        });

        let ProviderEvent::ServerRequest { request } = &events[0] else {
            panic!("expected normalized server request");
        };
        assert_eq!(request.kind, ServerRequestKind::McpElicitation);
        assert_eq!(request.scope.as_deref(), Some("mcp"));
        assert_eq!(request.title.as_deref(), Some("MCP server needs input"));
        assert_eq!(request.prompt.as_deref(), Some("Which repository?"));
        assert_eq!(
            request.provider.schema_version.as_deref(),
            Some("2026-01-01")
        );
        assert_eq!(request.metadata["serverName"], "github");
        assert_eq!(request.metadata["toolName"], "create_issue");
    }

    #[test]
    fn normalizes_all_codex_server_request_kinds_with_audit_metadata() {
        let cases = [
            (
                "fileChange/approvalRequest",
                ServerRequestKind::FileChangeApproval,
                "filesystem",
                "Approve file changes",
                json!({
                    "thread": { "id": "thread-1" },
                    "turnId": "turn-1",
                    "sourceItemId": "file-1",
                    "path": "src/lib.rs",
                    "patch": "@@ -1 +1 @@",
                    "description": "Apply patch?"
                }),
                "patch",
            ),
            (
                "tool/userInputRequest",
                ServerRequestKind::ToolUserInput,
                "tool",
                "Tool needs input",
                json!({
                    "threadId": "thread-1",
                    "toolCallId": "tool-1",
                    "toolName": "browser",
                    "question": "Which tab?",
                    "choices": ["current", "new"]
                }),
                "choices",
            ),
            (
                "permission/approvalRequest",
                ServerRequestKind::PermissionApproval,
                "permission",
                "Approve permission change",
                json!({
                    "threadId": "thread-1",
                    "permissionPolicy": "workspace-write",
                    "sandboxPolicy": { "mode": "workspace-write" },
                    "approvalPolicy": "on-request",
                    "message": "Allow writes?"
                }),
                "sandboxPolicy",
            ),
            (
                "dynamicTool/call",
                ServerRequestKind::DynamicToolCall,
                "tool",
                "Run dynamic tool",
                json!({
                    "threadId": "thread-1",
                    "toolName": "browser.click",
                    "arguments": { "selector": "#submit" },
                    "operation": "click"
                }),
                "arguments",
            ),
            (
                "account/tokenRefresh",
                ServerRequestKind::AccountTokenRefresh,
                "account",
                "Refresh account token",
                json!({
                    "threadId": "thread-1",
                    "accountId": "acct-1",
                    "resource": "openai",
                    "reason": "expired"
                }),
                "accountId",
            ),
            (
                "attestation/request",
                ServerRequestKind::Attestation,
                "attestation",
                "Provide attestation",
                json!({
                    "threadId": "thread-1",
                    "challenge": "nonce",
                    "attestation": { "kind": "device" },
                    "description": "Verify device"
                }),
                "challenge",
            ),
            (
                "applyPatch/approvalRequest",
                ServerRequestKind::ApplyPatchApproval,
                "filesystem",
                "Approve patch application",
                json!({
                    "threadId": "thread-1",
                    "itemId": "patch-1",
                    "patch": "@@ -1 +1 @@",
                    "files": ["src/lib.rs"],
                    "prompt": "Apply this patch?"
                }),
                "files",
            ),
            (
                "exec/approvalRequest",
                ServerRequestKind::ExecApproval,
                "command",
                "Approve command execution",
                json!({
                    "threadId": "thread-1",
                    "itemId": "exec-1",
                    "command": "cargo test",
                    "cwd": "/repo",
                    "approval_policy": "on-request"
                }),
                "cwd",
            ),
        ];

        for (index, (method, kind, scope, title, params, metadata_key)) in
            cases.into_iter().enumerate()
        {
            let events = normalize_codex_inbound_event(&CodexInboundEvent::ServerRequest {
                id: index as i64 + 100,
                method: method.to_string(),
                params,
            });

            let ProviderEvent::ServerRequest { request } = &events[0] else {
                panic!("expected normalized server request for {method}");
            };
            assert_eq!(request.kind, kind, "{method}");
            assert_eq!(request.scope.as_deref(), Some(scope), "{method}");
            assert_eq!(request.title.as_deref(), Some(title), "{method}");
            assert!(request.prompt.is_some(), "{method}");
            assert!(
                request.metadata.get(metadata_key).is_some(),
                "{method} missing metadata key {metadata_key}"
            );
            let ProviderEvent::RawServerRequest { params, .. } = &events[1] else {
                panic!("expected raw server request for {method}");
            };
            assert_eq!(&request.provider.raw_payload, params);
        }
    }

    #[test]
    fn normalizes_current_app_server_request_methods_with_audit_metadata() {
        let cases = [
            (
                "item/commandExecution/requestApproval",
                ServerRequestKind::CommandApproval,
                "command",
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "cmd-1",
                    "command": "cargo test --workspace",
                    "cwd": "/repo",
                    "prompt": "Run tests?",
                    "approvalPolicy": "on-request"
                }),
                "command",
            ),
            (
                "item/fileChange/requestApproval",
                ServerRequestKind::FileChangeApproval,
                "filesystem",
                json!({
                    "threadId": "thread-1",
                    "itemId": "file-1",
                    "path": "src/lib.rs",
                    "patch": "@@ -1 +1 @@",
                    "description": "Apply patch?"
                }),
                "patch",
            ),
            (
                "item/tool/requestUserInput",
                ServerRequestKind::ToolUserInput,
                "tool",
                json!({
                    "threadId": "thread-1",
                    "toolCallId": "tool-1",
                    "toolName": "browser",
                    "question": "Which tab?",
                    "choices": ["current", "new"]
                }),
                "choices",
            ),
            (
                "mcpServer/elicitation/request",
                ServerRequestKind::McpElicitation,
                "mcp",
                json!({
                    "threadId": "thread-1",
                    "serverName": "linear",
                    "toolName": "choose_issue",
                    "question": "Which issue?"
                }),
                "serverName",
            ),
            (
                "item/permissions/requestApproval",
                ServerRequestKind::PermissionApproval,
                "permission",
                json!({
                    "threadId": "thread-1",
                    "permissionPolicy": "workspace-write",
                    "sandboxPolicy": { "mode": "workspace-write" },
                    "approvalPolicy": "on-request",
                    "message": "Allow writes?"
                }),
                "sandboxPolicy",
            ),
            (
                "item/tool/call",
                ServerRequestKind::DynamicToolCall,
                "tool",
                json!({
                    "threadId": "thread-1",
                    "toolName": "browser.click",
                    "arguments": { "selector": "#submit" },
                    "operation": "click"
                }),
                "arguments",
            ),
            (
                "account/chatgptAuthTokens/refresh",
                ServerRequestKind::AccountTokenRefresh,
                "account",
                json!({
                    "threadId": "thread-1",
                    "accountId": "acct-1",
                    "resource": "openai",
                    "reason": "expired"
                }),
                "accountId",
            ),
            (
                "attestation/generate",
                ServerRequestKind::Attestation,
                "attestation",
                json!({
                    "threadId": "thread-1",
                    "challenge": "nonce",
                    "attestation": { "kind": "device" },
                    "description": "Verify device"
                }),
                "challenge",
            ),
            (
                "applyPatchApproval",
                ServerRequestKind::ApplyPatchApproval,
                "filesystem",
                json!({
                    "threadId": "thread-1",
                    "itemId": "patch-1",
                    "patch": "@@ -1 +1 @@",
                    "files": ["src/lib.rs"],
                    "prompt": "Apply this patch?"
                }),
                "files",
            ),
            (
                "execCommandApproval",
                ServerRequestKind::ExecApproval,
                "command",
                json!({
                    "threadId": "thread-1",
                    "itemId": "exec-1",
                    "command": "cargo test",
                    "cwd": "/repo",
                    "approvalPolicy": "on-request"
                }),
                "cwd",
            ),
        ];

        for (index, (method, kind, scope, params, metadata_key)) in cases.into_iter().enumerate() {
            let events = normalize_codex_inbound_event(&CodexInboundEvent::ServerRequest {
                id: index as i64 + 500,
                method: method.to_string(),
                params,
            });

            let ProviderEvent::ServerRequest { request } = &events[0] else {
                panic!("expected normalized server request for {method}");
            };
            assert_eq!(request.kind, kind, "{method}");
            assert_eq!(request.scope.as_deref(), Some(scope), "{method}");
            assert!(request.prompt.is_some(), "{method}");
            assert!(
                request.metadata.get(metadata_key).is_some(),
                "{method} missing metadata key {metadata_key}"
            );
            assert_eq!(request.provider.method.as_deref(), Some(method));
            let ProviderEvent::RawServerRequest {
                method: raw_method,
                params,
                ..
            } = &events[1]
            else {
                panic!("expected raw server request for {method}");
            };
            assert_eq!(raw_method, method);
            assert_eq!(&request.provider.raw_payload, params);
        }
    }

    #[test]
    fn server_request_dynamic_tool_emits_semantic_browser_approval() {
        let raw = json!({
            "thread": { "id": "thread-1" },
            "turnId": "turn-1",
            "toolCallId": "tool-1",
            "toolName": "ace_browser",
            "arguments": {
                "operation": "navigate_tab_url",
                "url": "http://localhost:5173"
            },
            "prompt": "Open this page?"
        });
        let events = normalize_codex_inbound_event(&CodexInboundEvent::ServerRequest {
            id: 42,
            method: "dynamicTool/call".to_string(),
            params: raw.clone(),
        });

        assert!(matches!(events[0], ProviderEvent::ServerRequest { .. }));
        assert!(matches!(events[1], ProviderEvent::RawServerRequest { .. }));
        let ProviderEvent::SemanticTool { tool } = &events[2] else {
            panic!("expected semantic tool approval");
        };
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserNavigate);
        assert_eq!(
            tool.display.status,
            ace_runtime::tools::ToolRunStatus::ApprovalRequested
        );
        assert_eq!(
            tool.display.title,
            "Opening http://localhost:5173 in Browser"
        );
        assert_eq!(tool.provider.raw_payload, raw);
        assert_eq!(tool.provider.item_id.as_deref(), Some("tool-1"));
    }

    #[test]
    fn server_request_mcp_elicitation_falls_back_to_named_external_tool() {
        let events = normalize_codex_inbound_event(&CodexInboundEvent::ServerRequest {
            id: 43,
            method: "mcp/elicitation".to_string(),
            params: json!({
                "threadId": "thread-1",
                "serverName": "linear",
                "toolName": "choose_issue",
                "input": {
                    "options": ["ACE-1", "ACE-2"]
                },
                "question": "Which issue?"
            }),
        });

        let ProviderEvent::SemanticTool { tool } = &events[2] else {
            panic!("expected semantic tool approval");
        };
        assert_eq!(tool.surface, ToolSurface::GenericMcp);
        assert_eq!(tool.action, ToolActionKind::ToolRun);
        assert_eq!(tool.display.title, "Running linear.choose_issue tool");
        assert!(!tool.display.title.contains("MCP tool"));
        assert_eq!(tool.provider.server_name.as_deref(), Some("linear"));
        assert_eq!(tool.provider.tool_name.as_deref(), Some("choose_issue"));
    }

    #[test]
    fn server_request_command_approval_emits_terminal_tool_approval() {
        let events = normalize_codex_inbound_event(&CodexInboundEvent::ServerRequest {
            id: 44,
            method: "command/approvalRequest".to_string(),
            params: json!({
                "threadId": "thread-1",
                "itemId": "cmd-1",
                "command": "cargo test -p ace-codex",
                "cwd": "/repo",
                "message": "Approve command?"
            }),
        });

        let ProviderEvent::SemanticTool { tool } = &events[2] else {
            panic!("expected semantic tool approval");
        };
        assert_eq!(tool.surface, ToolSurface::Terminal);
        assert_eq!(tool.action, ToolActionKind::TerminalRun);
        assert_eq!(tool.display.title, "Running `cargo test -p ace-codex`");
        assert_eq!(
            tool.display.status,
            ace_runtime::tools::ToolRunStatus::ApprovalRequested
        );
    }

    #[test]
    fn normalizes_user_and_agent_message_items() {
        let user = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-user",
                    "type": "userMessage",
                    "text": "Build the adapter"
                }
            }),
        });
        let item = first_thread_item(&user);
        assert_eq!(item.kind, ThreadItemKind::UserMessage);
        assert_eq!(item.status, ThreadItemStatus::Completed);
        assert_eq!(item.text.as_deref(), Some("Build the adapter"));
        assert_eq!(item.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(item.provider.raw_payload["threadId"], "thread-1");

        let agent = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/agentMessage/delta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-agent",
                "delta": "Working on it"
            }),
        });
        let item = first_thread_item(&agent);
        assert_eq!(item.kind, ThreadItemKind::AgentMessage);
        assert_eq!(item.status, ThreadItemStatus::Updated);
        assert_eq!(item.text.as_deref(), Some("Working on it"));
        assert_eq!(item.item_id.as_deref(), Some("item-agent"));
    }

    #[test]
    fn normalizes_plan_and_reasoning_deltas() {
        let plan = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/plan/delta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "plan-1",
                "delta": "1. Inspect the code"
            }),
        });
        let item = first_thread_item(&plan);
        assert_eq!(item.kind, ThreadItemKind::Plan);
        assert_eq!(item.status, ThreadItemStatus::Updated);
        assert_eq!(item.text.as_deref(), Some("1. Inspect the code"));

        let reasoning = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "item": {
                    "id": "reasoning-1",
                    "type": "reasoning",
                    "summary": "Need to preserve raw payloads"
                }
            }),
        });
        let item = first_thread_item(&reasoning);
        assert_eq!(item.kind, ThreadItemKind::Reasoning);
        assert_eq!(item.text.as_deref(), Some("Need to preserve raw payloads"));
    }

    #[test]
    fn normalizes_review_compaction_and_subagent_items() {
        let review = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "item": {
                    "id": "review-1",
                    "type": "enteredReviewMode"
                }
            }),
        });
        let item = first_thread_item(&review);
        assert_eq!(item.kind, ThreadItemKind::EnteredReviewMode);
        assert_eq!(item.title.as_deref(), Some("Entered review mode"));

        let compaction = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "item": {
                    "id": "compact-1",
                    "type": "contextCompaction",
                    "summary": "Compressed older turns",
                    "tokens": 4096
                }
            }),
        });
        let item = first_thread_item(&compaction);
        assert_eq!(item.kind, ThreadItemKind::ContextCompaction);
        assert_eq!(item.metadata["tokens"], 4096);

        let subagent = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "parent-thread",
                "item": {
                    "id": "subagent-1",
                    "type": "subAgentActivity",
                    "parentThreadId": "parent-thread",
                    "childThreadId": "child-thread",
                    "agentRole": "reviewer",
                    "agentName": "Reviewer",
                    "status": "running"
                }
            }),
        });
        let item = first_thread_item(&subagent);
        assert_eq!(item.kind, ThreadItemKind::SubAgentActivity);
        assert_eq!(item.parent_thread_id.as_deref(), Some("parent-thread"));
        assert_eq!(item.child_thread_id.as_deref(), Some("child-thread"));
        assert_eq!(item.role.as_deref(), Some("reviewer"));
        assert_eq!(item.sender.as_deref(), Some("Reviewer"));
    }
}
