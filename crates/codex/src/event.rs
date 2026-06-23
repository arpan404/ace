use ace_runtime::{
    provider::{
        NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedThreadItem, ProviderEvent,
    },
    runtime_signals::{RuntimeSignalNormalizationInput, normalize_provider_runtime_signal},
    server_requests::{ServerRequestNormalizationInput, normalize_provider_server_request},
    thread_items::{ThreadItemNormalizationInput, normalize_provider_thread_item},
    tools::{
        ProviderServerRequestToolNormalizationInput, ProviderToolEventNormalizationInput,
        normalize_provider_server_request_tool, normalize_provider_tool_event,
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
    normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
        provider: "codex".to_string(),
        method: method.to_string(),
        params: params.clone(),
    })
}

fn normalize_codex_server_request(
    id: i64,
    method: &str,
    params: &Value,
) -> NormalizedServerRequest {
    normalize_provider_server_request(ServerRequestNormalizationInput {
        provider: "codex".to_string(),
        request_id: id.to_string(),
        method: method.to_string(),
        params: params.clone(),
    })
}

fn normalize_codex_thread_item_notification(
    method: &str,
    params: &Value,
) -> Option<NormalizedThreadItem> {
    normalize_provider_thread_item(ThreadItemNormalizationInput {
        provider: "codex".to_string(),
        method: method.to_string(),
        params: params.clone(),
    })
}

fn normalize_codex_tool_notification(
    method: &str,
    params: &Value,
) -> Option<ace_runtime::tools::SemanticToolCall> {
    normalize_provider_tool_event(ProviderToolEventNormalizationInput {
        provider: "codex".to_string(),
        method: method.to_string(),
        params: params.clone(),
    })
}

fn normalize_codex_server_request_tool(
    id: i64,
    method: &str,
    params: &Value,
) -> Option<ace_runtime::tools::SemanticToolCall> {
    normalize_provider_server_request_tool(ProviderServerRequestToolNormalizationInput {
        provider: "codex".to_string(),
        request_id: id.to_string(),
        method: method.to_string(),
        params: params.clone(),
    })
}

#[cfg(test)]
mod tests {
    use ace_core::ProviderKind;
    use ace_runtime::{
        host_tools::{HostToolDescriptor, host_tool_invocation_from_server_request},
        provider::{ProviderEvent, ServerRequestKind, ThreadItemKind, ThreadItemStatus},
        tools::{ToolActionKind, ToolRunStatus, ToolSurface, ToolTransport},
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
    fn normalizes_bridge_style_mcp_tool_names_to_semantic_actions() {
        let browser_events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-browser",
                    "type": "mcpToolCall",
                    "serverName": "browser",
                    "toolName": "mcp__browser__click",
                    "input": {
                        "selector": "button.primary"
                    }
                }
            }),
        });
        let ProviderEvent::SemanticTool { tool } = &browser_events[0] else {
            panic!("expected browser semantic tool");
        };
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserClick);
        assert_eq!(tool.display.title, "Clicked button.primary in Browser");
        assert!(!tool.display.title.contains("MCP"));

        let computer_events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "item-computer",
                    "type": "mcpToolCall",
                    "serverName": "computer-use",
                    "toolName": "set_value",
                    "input": {
                        "app": "TextEdit",
                        "value": "hello"
                    }
                }
            }),
        });
        let ProviderEvent::SemanticTool { tool } = &computer_events[0] else {
            panic!("expected computer semantic tool");
        };
        assert_eq!(tool.surface, ToolSurface::Computer);
        assert_eq!(tool.action, ToolActionKind::ComputerType);
        assert_eq!(tool.display.title, "Typed into TextEdit on Computer");
        assert!(!tool.display.title.contains("MCP"));
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
        assert_eq!(tool.action, ToolActionKind::BrowserLogs);
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
    fn normalizes_browser_scroll_key_clipboard_and_wait_bridge_events() {
        let cases = [
            (
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-scroll",
                    "item": {
                        "id": "item-scroll",
                        "type": "dynamicToolCall",
                        "toolName": "ace_browser",
                        "input": { "operation": "dom_cua_scroll", "scrollY": 480 }
                    }
                }),
                ToolActionKind::BrowserScroll,
                "Scrolling 0,480 in Browser",
            ),
            (
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-key",
                    "item": {
                        "id": "item-key",
                        "type": "dynamicToolCall",
                        "toolName": "ace_browser",
                        "input": { "operation": "dom_cua_keypress", "key": "Escape" }
                    }
                }),
                ToolActionKind::BrowserKey,
                "Pressing key Escape in Browser",
            ),
            (
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-clipboard",
                    "item": {
                        "id": "item-clipboard",
                        "type": "dynamicToolCall",
                        "toolName": "ace_browser",
                        "input": { "operation": "tab_clipboard_read" }
                    }
                }),
                ToolActionKind::BrowserClipboard,
                "Using Browser clipboard",
            ),
            (
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-wait",
                    "item": {
                        "id": "item-wait",
                        "type": "mcpToolCall",
                        "serverName": "browser",
                        "toolName": "playwright_wait_for_selector",
                        "input": { "selector": "#loaded" }
                    }
                }),
                ToolActionKind::BrowserWait,
                "Waiting for #loaded in Browser",
            ),
        ];

        for (params, action, title) in cases {
            let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
                method: "item/dynamicToolCall/progress".to_string(),
                params: params.clone(),
            });
            let ProviderEvent::SemanticTool { tool } = &events[0] else {
                panic!("expected semantic browser bridge update");
            };
            assert_eq!(tool.surface, ToolSurface::Browser);
            assert_eq!(tool.action, action);
            assert_eq!(tool.display.title, title);
            assert_eq!(tool.provider.raw_payload, params);
            assert!(!tool.display.title.contains("MCP"));
        }
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
    fn normalizes_codex_warning_notifications() {
        let cases = [
            (
                "configWarning",
                json!({ "message": "Missing preferred model" }),
                "Missing preferred model",
            ),
            (
                "deprecationNotice",
                json!({ "text": "This command will change soon" }),
                "This command will change soon",
            ),
            (
                "error",
                json!({ "error": "Transport disconnected" }),
                "Transport disconnected",
            ),
            (
                "guardianWarning",
                json!({ "description": "Auto-review denied the command" }),
                "Auto-review denied the command",
            ),
            (
                "windows/worldWritableWarning",
                json!({ "path": "C:\\tmp" }),
                "World-writable path warning",
            ),
        ];

        for (method, params, message) in cases {
            let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
                method: method.to_string(),
                params,
            });
            let ProviderEvent::RuntimeSignal { signal } = &events[0] else {
                panic!("expected warning signal for {method}");
            };
            assert_eq!(
                signal.kind,
                ace_runtime::provider::RuntimeSignalKind::Warning,
                "{method}"
            );
            assert_eq!(signal.message.as_deref(), Some(message), "{method}");
            assert_eq!(signal.provider.method.as_deref(), Some(method));
            assert!(matches!(events[1], ProviderEvent::RawNotification { .. }));
        }
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
                "fs/changed",
                json!({ "files": [{ "path": "src/main.rs", "kind": "modified" }] }),
                "filesystem_changed",
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
                "hook/started",
                json!({ "name": "pre-commit" }),
                "hook_started",
                None,
            ),
            (
                "hook/completed",
                json!({ "name": "pre-commit", "status": "ok" }),
                "ok",
                None,
            ),
            (
                "mcpServer/oauthLogin/completed",
                json!({ "server": "github", "status": "authenticated" }),
                "authenticated",
                None,
            ),
            (
                "mcpServer/startupStatus/updated",
                json!({ "server": "browser", "status": "running" }),
                "running",
                None,
            ),
            (
                "model/verification",
                json!({ "model": "gpt-5", "status": "verified" }),
                "verified",
                None,
            ),
            (
                "remoteControl/status/changed",
                json!({ "status": "connected" }),
                "connected",
                None,
            ),
            (
                "skills/changed",
                json!({ "event": "installed", "name": "browser" }),
                "installed",
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
    fn normalizes_realtime_moderation_and_auto_review_notifications() {
        let realtime_cases = [
            (
                "thread/realtime/started",
                json!({ "threadId": "thread-1", "turnId": "turn-1" }),
                "started",
                None,
            ),
            (
                "thread/realtime/error",
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "error": "microphone unavailable"
                }),
                "error",
                Some("microphone unavailable"),
            ),
            (
                "thread/realtime/closed",
                json!({ "threadId": "thread-1", "turnId": "turn-1" }),
                "closed",
                None,
            ),
            (
                "thread/realtime/sdp",
                json!({ "threadId": "thread-1", "turnId": "turn-1", "sdp": "v=0" }),
                "sdp_updated",
                None,
            ),
            (
                "thread/realtime/itemAdded",
                json!({ "threadId": "thread-1", "turnId": "turn-1", "item": { "id": "rt-1" } }),
                "item_added",
                None,
            ),
            (
                "thread/realtime/transcript/done",
                json!({ "threadId": "thread-1", "turnId": "turn-1", "transcript": "done" }),
                "transcript_done",
                None,
            ),
        ];

        for (method, params, status, message) in realtime_cases {
            let events = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
                method: method.to_string(),
                params,
            });
            let ProviderEvent::RuntimeSignal { signal } = &events[0] else {
                panic!("expected realtime signal for {method}");
            };
            assert_eq!(
                signal.kind,
                ace_runtime::provider::RuntimeSignalKind::RealtimeSessionUpdated,
                "{method}"
            );
            assert_eq!(signal.status.as_deref(), Some(status), "{method}");
            assert_eq!(signal.message.as_deref(), message, "{method}");
            assert_eq!(signal.thread_id.as_deref(), Some("thread-1"));
            assert_eq!(signal.turn_id.as_deref(), Some("turn-1"));
            assert!(matches!(events[1], ProviderEvent::RawNotification { .. }));
        }

        let moderation = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "turn/moderationMetadata".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "flagged": false
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &moderation[0] else {
            panic!("expected moderation signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::TurnModerationUpdated
        );
        assert_eq!(
            signal.status.as_deref(),
            Some("moderation_metadata_updated")
        );
        assert_eq!(signal.provider.raw_payload["flagged"], false);
        assert!(matches!(
            moderation[1],
            ProviderEvent::RawNotification { .. }
        ));

        let review_started = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/autoApprovalReview/started".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "review-1"
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &review_started[0] else {
            panic!("expected auto-review signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::AutoApprovalReviewUpdated
        );
        assert_eq!(signal.status.as_deref(), Some("started"));
        assert_eq!(signal.item_id.as_deref(), Some("review-1"));
        assert!(matches!(
            review_started[1],
            ProviderEvent::RawNotification { .. }
        ));

        let review_completed = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/autoApprovalReview/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": { "id": "review-1" },
                "status": "approved",
                "reason": "command is within workspace"
            }),
        });
        let ProviderEvent::RuntimeSignal { signal } = &review_completed[0] else {
            panic!("expected auto-review completion signal");
        };
        assert_eq!(
            signal.kind,
            ace_runtime::provider::RuntimeSignalKind::AutoApprovalReviewUpdated
        );
        assert_eq!(signal.status.as_deref(), Some("approved"));
        assert_eq!(
            signal.message.as_deref(),
            Some("command is within workspace")
        );
        assert_eq!(signal.item_id.as_deref(), Some("review-1"));
        assert!(matches!(
            review_completed[1],
            ProviderEvent::RawNotification { .. }
        ));
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

            if matches!(
                kind,
                ServerRequestKind::CommandApproval
                    | ServerRequestKind::ExecApproval
                    | ServerRequestKind::FileChangeApproval
                    | ServerRequestKind::ApplyPatchApproval
                    | ServerRequestKind::ToolUserInput
                    | ServerRequestKind::McpElicitation
                    | ServerRequestKind::DynamicToolCall
            ) {
                let ProviderEvent::SemanticTool { tool } = &events[2] else {
                    panic!("expected semantic server request tool for {method}");
                };
                assert_eq!(tool.display.status, ToolRunStatus::ApprovalRequested);
                assert_eq!(tool.provider.method.as_deref(), Some(method));
                assert_eq!(tool.provider.raw_payload, request.provider.raw_payload);
            } else {
                assert_eq!(
                    events.len(),
                    2,
                    "{method} should not emit a tool display event"
                );
            }
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
    fn codex_dynamic_tool_request_feeds_provider_neutral_host_tool_registry() {
        let events = normalize_codex_inbound_event(&CodexInboundEvent::ServerRequest {
            id: 42,
            method: "dynamicTool/call".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "toolCallId": "tool-1",
                "toolName": "ace_browser",
                "arguments": {
                    "operation": "navigate_tab_url",
                    "url": "http://localhost:5173"
                }
            }),
        });

        let ProviderEvent::ServerRequest { request } = &events[0] else {
            panic!("expected normalized server request");
        };
        let mut descriptor = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        descriptor.aliases = vec!["ace_browser".to_string()];
        descriptor.actions = vec![ToolActionKind::BrowserNavigate];

        let invocation = host_tool_invocation_from_server_request(ProviderKind::Codex, request)
            .expect("host tool invocation");
        assert_eq!(invocation.request_id, "42");
        assert_eq!(invocation.tool_name, "ace_browser");
        assert_eq!(invocation.arguments["operation"], "navigate_tab_url");
        assert_eq!(invocation.raw_payload["toolCallId"], "tool-1");

        let semantic = invocation.semantic_tool(Some(&descriptor), ToolRunStatus::Started);
        assert_eq!(semantic.transport, ToolTransport::BrowserBridge);
        assert_eq!(semantic.surface, ToolSurface::Browser);
        assert_eq!(semantic.action, ToolActionKind::BrowserNavigate);
        assert_eq!(
            semantic.display.title,
            "Opening http://localhost:5173 in Browser"
        );
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

        let semantic = subagent
            .iter()
            .find_map(|event| match event {
                ProviderEvent::SemanticTool { tool } => Some(tool.as_ref()),
                _ => None,
            })
            .expect("semantic subagent tool");
        assert_eq!(semantic.surface, ToolSurface::Subagent);
        assert_eq!(semantic.action, ToolActionKind::SubagentSpawn);
        assert_eq!(semantic.display.title, "Started subagent Reviewer");
        assert_eq!(semantic.provider.raw_payload["threadId"], "parent-thread");
    }

    #[test]
    fn normalizes_web_search_and_image_items_to_semantic_events() {
        let web_search = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "search-1",
                    "type": "webSearch",
                    "query": "gpui rust app",
                    "result": {
                        "count": 3
                    }
                }
            }),
        });
        let ProviderEvent::SemanticTool { tool } = &web_search[0] else {
            panic!("expected semantic web search");
        };
        assert_eq!(tool.surface, ToolSurface::WebSearch);
        assert_eq!(tool.action, ToolActionKind::WebSearch);
        assert_eq!(tool.display.title, "Searched web for gpui rust app");
        assert_eq!(tool.provider.raw_result["count"], 3);
        assert_eq!(tool.provider.raw_payload["item"]["query"], "gpui rust app");

        let generated = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "image-1",
                    "type": "imageGeneration",
                    "prompt": "semantic tool timeline screenshot"
                }
            }),
        });
        let ProviderEvent::SemanticTool { tool } = &generated[0] else {
            panic!("expected semantic generated image");
        };
        assert_eq!(tool.surface, ToolSurface::Image);
        assert_eq!(tool.action, ToolActionKind::ImageGenerate);
        assert_eq!(
            tool.display.title,
            "Generated image semantic tool timeline screenshot"
        );

        let viewed = normalize_codex_inbound_event(&CodexInboundEvent::Notification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "image-2",
                    "type": "imageView",
                    "url": "https://github.com/openai/codex/raw/main/screenshot.png"
                }
            }),
        });
        let ProviderEvent::SemanticTool { tool } = &viewed[0] else {
            panic!("expected semantic viewed image");
        };
        assert_eq!(tool.surface, ToolSurface::Image);
        assert_eq!(tool.action, ToolActionKind::ImageView);
        assert_eq!(
            tool.display.title,
            "Viewed image https://github.com/openai/codex/raw/main/screenshot.png"
        );
    }
}
