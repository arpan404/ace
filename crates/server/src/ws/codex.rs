use crate::ws::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{
    PROTOCOL_VERSION,
    codex::{
        CodexPlanTurnStartRequest, CodexRawRequest, CodexThreadForkRequest, CodexThreadIdRequest,
        CodexThreadStartRequest, CodexTurnStartRequest,
    },
    provider_runtime::{
        PROVIDER_RUNTIME_EVENT_TOPIC, ProviderRuntimeEvent, ProviderRuntimeEventBatch,
        ProviderRuntimeSubscribeRequest, ProviderServerRequestError, ProviderServerRequestResult,
    },
    ws::{WsServerPayload, WsServerResponse, methods},
};
use ace_terminal::PtyAdapter;
use serde_json::Value;
use tokio::sync::mpsc;

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_codex_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::CODEX_RAW_REQUEST => {
                self.codex_json::<CodexRawRequest, _, _, _>(payload, |service, request| async move {
                    service.raw_request(request.method, request.params).await
                })
                .await
            }
            methods::CODEX_THREAD_START => {
                self.codex_json::<CodexThreadStartRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.start_thread(request.params).await },
                )
                .await
            }
            methods::CODEX_THREAD_RESUME => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.resume_thread(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_THREAD_FORK => {
                self.codex_json::<CodexThreadForkRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .fork_thread(request.thread_id, request.ephemeral)
                            .await
                    },
                )
                .await
            }
            methods::CODEX_TURN_START => {
                self.codex_json::<CodexTurnStartRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.start_turn(request.params).await },
                )
                .await
            }
            methods::CODEX_TURN_PLAN_START => {
                self.codex_json::<CodexPlanTurnStartRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .start_turn(ace_codex::CodexTurnStart::plan(
                                request.thread_id,
                                request.prompt,
                                request.model,
                            ))
                            .await
                    },
                )
                .await
            }
            methods::CODEX_TURN_INTERRUPT => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.interrupt_turn(request.thread_id).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }

    pub(super) async fn dispatch_provider_runtime_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::PROVIDER_RUNTIME_SERVER_REQUEST_RESULT => {
                self.codex_json::<ProviderServerRequestResult, _, _, _>(
                    payload,
                    |service, request| async move {
                        ensure_codex_provider(&request.provider)?;
                        service
                            .respond_server_request_result(request.request_id, request.result)
                            .await?;
                        Ok(serde_json::json!({ "responded": true }))
                    },
                )
                .await
            }
            methods::PROVIDER_RUNTIME_SERVER_REQUEST_ERROR => {
                self.codex_json::<ProviderServerRequestError, _, _, _>(
                    payload,
                    |service, request| async move {
                        ensure_codex_provider(&request.provider)?;
                        service
                            .respond_server_request_error(
                                request.request_id,
                                request.error.code,
                                request.error.message,
                            )
                            .await?;
                        Ok(serde_json::json!({ "responded": true }))
                    },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }

    pub(super) async fn subscribe_provider_runtime_events(
        &self,
        payload: Value,
        outbound: Option<mpsc::Sender<String>>,
    ) -> Result<Value, WsDispatchError> {
        let request = serde_json::from_value::<ProviderRuntimeSubscribeRequest>(payload)?;
        if !matches!(request.provider.as_deref(), None | Some("codex")) {
            return Ok(serde_json::json!({ "subscribed": false }));
        }
        let Some(outbound) = outbound else {
            return Ok(serde_json::json!({ "subscribed": false }));
        };

        let codex = self.codex.clone();
        tokio::spawn(async move {
            loop {
                let events = match codex.next_events().await {
                    Ok(Some(events)) => events,
                    Ok(None) => break,
                    Err(error) => {
                        let response = WsServerResponse {
                            version: PROTOCOL_VERSION,
                            request_id: String::new(),
                            payload: WsServerPayload::Error {
                                code: error.code().to_string(),
                                message: error.to_string(),
                            },
                        };
                        let Ok(text) = serde_json::to_string(&response) else {
                            break;
                        };
                        let _ = outbound.send(text).await;
                        break;
                    }
                };
                if events.is_empty() {
                    continue;
                }
                let batch = ProviderRuntimeEventBatch {
                    provider: "codex".to_string(),
                    events: events
                        .iter()
                        .cloned()
                        .map(|event| ProviderRuntimeEvent::from_provider_event("codex", event))
                        .collect(),
                    raw_events: events,
                };
                let response = WsServerResponse {
                    version: PROTOCOL_VERSION,
                    request_id: String::new(),
                    payload: WsServerPayload::Event {
                        topic: PROVIDER_RUNTIME_EVENT_TOPIC.to_string(),
                        body: serde_json::to_value(batch)
                            .expect("serialize provider runtime websocket event"),
                    },
                };
                let Ok(text) = serde_json::to_string(&response) else {
                    continue;
                };
                if outbound.send(text).await.is_err() {
                    break;
                }
            }
        });
        Ok(serde_json::json!({ "subscribed": true, "provider": "codex" }))
    }
}

fn ensure_codex_provider(provider: &str) -> Result<(), crate::codex::CodexApiError> {
    if provider == "codex" {
        Ok(())
    } else {
        Err(crate::codex::CodexApiError::UnsupportedProvider(
            provider.to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        codex::{
            CodexService,
            tests::{FakeCodexBackend, ServerRequestResponse},
        },
        git::GitService,
        github::GithubService,
    };
    use ace_git::{
        CommandOutput, CommandRequest, GitClient, GitToolError, GithubCliClient, ProcessRunner,
    };
    use ace_protocol::{
        PROTOCOL_VERSION,
        provider_runtime::PROVIDER_RUNTIME_EVENT_TOPIC,
        ws::{WsServerPayload, WsServerResponse, methods},
    };
    use ace_runtime::{
        provider::ProviderEvent,
        tools::{
            ProviderToolMetadata, ToolNormalizationInput, ToolRunStatus, ToolTransport,
            normalize_tool_call,
        },
    };
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Arc;

    use super::*;

    #[derive(Debug, Default)]
    struct FakeRunner;

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(&self, _request: CommandRequest) -> ace_git::Result<CommandOutput> {
            Err(GitToolError::Parse {
                context: "codex ws fake runner",
                message: "no git process expected".to_string(),
            })
        }
    }

    #[tokio::test]
    async fn dispatches_codex_plan_turn_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "codex-plan",
                    "method": methods::CODEX_TURN_PLAN_START,
                    "payload": {
                        "thread_id": "thread-1",
                        "prompt": "plan it",
                        "model": "gpt-5.5"
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");
        assert_eq!(response.version, PROTOCOL_VERSION);
        assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["turn/start:thread-1"]
        );
    }

    #[tokio::test]
    async fn subscribes_and_pushes_codex_provider_runtime_events() {
        let backend = Arc::new(FakeCodexBackend::default());
        let mut provider = ProviderToolMetadata::new();
        provider.tool_name = Some("ace_browser".to_string());
        provider.operation = Some("cua_click".to_string());
        provider.raw_args = json!({ "label": "Deploy" });
        let tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Mcp,
            status: ToolRunStatus::Completed,
            provider,
            item_type: Some("mcpToolCall".to_string()),
        });
        backend.push_events(vec![
            ProviderEvent::SemanticTool {
                tool: Box::new(tool),
            },
            ProviderEvent::RawNotification {
                method: "item/completed".to_string(),
                params: json!({ "item": { "id": "item-1" } }),
            },
        ]);

        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));
        let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::channel::<String>(8);

        let subscribe = state
            .dispatch_text_with_events(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
                Some(outbound_tx),
            )
            .await;
        let subscribe: WsServerResponse = serde_json::from_str(&subscribe).expect("subscribe");
        assert!(matches!(subscribe.payload, WsServerPayload::Result { .. }));

        let pushed = tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
            .await
            .expect("provider runtime event timeout")
            .expect("provider runtime event");
        let pushed: WsServerResponse = serde_json::from_str(&pushed).expect("pushed response");
        let WsServerPayload::Event { topic, body } = pushed.payload else {
            panic!("expected websocket event");
        };
        assert_eq!(topic, PROVIDER_RUNTIME_EVENT_TOPIC);
        assert_eq!(body["provider"], "codex");
        assert_eq!(body["events"][0]["type"], "tool_completed");
        assert_eq!(
            body["events"][0]["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );
        assert_eq!(body["raw_events"][1]["type"], "raw_notification");
        assert_eq!(body["raw_events"][1]["method"], "item/completed");
    }

    #[tokio::test]
    async fn responds_to_codex_server_request_result_over_provider_runtime_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "approval-result",
                    "method": methods::PROVIDER_RUNTIME_SERVER_REQUEST_RESULT,
                    "payload": {
                        "provider": "codex",
                        "request_id": 42,
                        "result": { "approved": true },
                        "audit": {
                            "scope": "command",
                            "source_thread_id": "thread-1",
                            "source_item_id": "item-1",
                            "prompt": "Run cargo test?",
                            "selected_policy": "on-request",
                            "decided_by": "user",
                            "reason": "requested by user",
                            "metadata": { "risk": "low" }
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");
        assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        assert_eq!(
            backend
                .server_request_responses
                .lock()
                .expect("server request responses")
                .as_slice(),
            [ServerRequestResponse::Result {
                request_id: 42,
                result: json!({ "approved": true })
            }]
        );
    }

    #[tokio::test]
    async fn responds_to_codex_server_request_error_over_provider_runtime_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "approval-error",
                    "method": methods::PROVIDER_RUNTIME_SERVER_REQUEST_ERROR,
                    "payload": {
                        "provider": "codex",
                        "request_id": 43,
                        "error": {
                            "code": -32001,
                            "message": "denied"
                        },
                        "audit": {
                            "scope": "filesystem",
                            "source_thread_id": "thread-1",
                            "selected_policy": "strict",
                            "decided_by": "user",
                            "reason": "outside workspace"
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");
        assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        assert_eq!(
            backend
                .server_request_responses
                .lock()
                .expect("server request responses")
                .as_slice(),
            [ServerRequestResponse::Error {
                request_id: 43,
                code: -32001,
                message: "denied".to_string()
            }]
        );
    }

    #[tokio::test]
    async fn rejects_unknown_provider_runtime_response_provider() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "bad-provider",
                    "method": methods::PROVIDER_RUNTIME_SERVER_REQUEST_RESULT,
                    "payload": {
                        "provider": "claude",
                        "request_id": 44,
                        "result": {}
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");
        let WsServerPayload::Error { code, .. } = response.payload else {
            panic!("expected provider error");
        };
        assert_eq!(code, "unsupported_provider");
    }
}
