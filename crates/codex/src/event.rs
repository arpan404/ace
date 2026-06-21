use ace_runtime::{
    provider::ProviderEvent,
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
    }
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
    } else if method.contains("fileChange") {
        Some("fileChange".to_string())
    } else if method.contains("mcpToolCall") {
        Some("mcpToolCall".to_string())
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
        provider::ProviderEvent,
        tools::{ToolActionKind, ToolSurface},
    };
    use serde_json::json;

    use super::*;

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
}
