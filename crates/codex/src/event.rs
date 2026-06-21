use ace_runtime::{
    provider::{
        NormalizedThreadItem, ProviderEvent, ProviderMetadata, ThreadItemKind, ThreadItemStatus,
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
            vec![ProviderEvent::RawServerRequest {
                id: id.to_string(),
                method: method.clone(),
                params: params.clone(),
            }]
        }
        CodexInboundEvent::StderrLine(line) => {
            vec![ProviderEvent::StderrLine { line: line.clone() }]
        }
        CodexInboundEvent::ServerExited { .. } => vec![ProviderEvent::Exited],
    }
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
        | "command/exec/outputDelta"
        | "process/outputDelta" => ToolRunStatus::Updated,
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval" => ToolRunStatus::ApprovalRequested,
        _ => return None,
    };

    let item = params.get("item").unwrap_or(params);
    let item_type = string_at(item, "type")
        .or_else(|| item_type_from_method(method))
        .unwrap_or_else(|| method.to_string());
    let mut provider = ProviderToolMetadata::new();
    provider.provider = Some("codex".to_string());
    provider.method = Some(method.to_string());
    provider.thread_id = string_at(params, "threadId");
    provider.turn_id = string_at(params, "turnId");
    provider.item_id = string_at(params, "itemId").or_else(|| string_at(item, "id"));
    provider.tool_name = tool_name_for_item(&item_type, item);
    provider.server_name = string_at(item, "serverName").or_else(|| string_at(item, "server"));
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
    string_at(item, "toolName")
        .or_else(|| string_at(item, "tool_name"))
        .or_else(|| string_at(item, "name"))
        .or_else(|| string_at(item, "tool"))
        .or_else(|| {
            if item_type == "commandExecution" {
                Some("shell".to_string())
            } else if item_type == "fileChange" {
                Some("apply_patch".to_string())
            } else {
                None
            }
        })
}

fn operation_for_item(item_type: &str, item: &Value) -> Option<String> {
    item.get("input")
        .and_then(|input| string_at(input, "operation"))
        .or_else(|| {
            item.get("arguments")
                .and_then(|args| string_at(args, "operation"))
        })
        .or_else(|| {
            item.get("args")
                .and_then(|args| string_at(args, "operation"))
        })
        .or_else(|| string_at(item, "operation"))
        .or_else(|| {
            if item_type == "commandExecution" {
                Some("run".to_string())
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
    } else {
        None
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

#[cfg(test)]
mod tests {
    use ace_runtime::{
        provider::{ProviderEvent, ThreadItemKind, ThreadItemStatus},
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
        assert_eq!(exited, vec![ProviderEvent::Exited]);
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
