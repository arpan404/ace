use crate::provider::{
    ProviderDescriptor, ProviderDriver, ProviderDriverError, ProviderEvent, ProviderEventSource,
    ProviderFeature, ProviderFeatureCategory, ProviderFeatureDirection, ProviderFeatureSupport,
    ProviderLifecycleAction, ProviderLifecycleResult, ProviderRequest, ProviderRuntimeHealth,
    ProviderServerRequestResponder, ace_provider_adapter_contract,
    ace_provider_contract_requirements, provider_adapter_profile, provider_contract_report,
};
use crate::tools::SemanticToolCall;
use ace_core::{ProviderCapability, ProviderKind};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::{Mutex, mpsc};

const ACE_NATIVE_EVENT_QUEUE_CAPACITY: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterValidationRequest {
    pub descriptor: ProviderDescriptor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeProviderEventsEmitRequest {
    pub events: Vec<ProviderEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeProviderSemanticToolEmitRequest {
    pub tool: SemanticToolCall,
}

#[derive(Debug)]
pub struct AceNativeProvider {
    event_tx: mpsc::Sender<Vec<ProviderEvent>>,
    event_rx: Mutex<mpsc::Receiver<Vec<ProviderEvent>>>,
}

impl AceNativeProvider {
    #[must_use]
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::channel(ACE_NATIVE_EVENT_QUEUE_CAPACITY);
        Self {
            event_tx,
            event_rx: Mutex::new(event_rx),
        }
    }

    #[must_use]
    pub fn descriptor_static() -> ProviderDescriptor {
        ProviderDescriptor {
            kind: ProviderKind::Ace,
            capabilities: vec![
                ProviderCapability {
                    key: "ace.provider_contract".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "ace.websocket_first".to_string(),
                    version: 1,
                },
            ],
        }
        .with_contract_capabilities()
    }

    #[must_use]
    pub fn features_static() -> Vec<ProviderFeature> {
        let capabilities = Self::descriptor_static().capabilities;
        [
            (
                "ace.provider_contract",
                "Ace provider contract",
                ProviderFeatureCategory::Native,
                "ace.contract",
            ),
            (
                "ace.descriptor",
                "Ace descriptor",
                ProviderFeatureCategory::Native,
                "ace.descriptor",
            ),
            (
                "ace.capabilities",
                "Ace capabilities",
                ProviderFeatureCategory::Native,
                "ace.capabilities",
            ),
            (
                "ace.adapter_validation",
                "Adapter validation",
                ProviderFeatureCategory::Native,
                "ace.adapter.validate",
            ),
            (
                "ace.events.emit",
                "Emit normalized provider events",
                ProviderFeatureCategory::Events,
                "ace.events.emit",
            ),
            (
                "ace.semantic_tool.emit",
                "Emit semantic tool call",
                ProviderFeatureCategory::Tools,
                "ace.semantic_tool.emit",
            ),
            (
                "provider.adapter_contract",
                "Provider adapter contract",
                ProviderFeatureCategory::Native,
                "ace.contract",
            ),
            (
                "provider.normalized_events",
                "Normalized provider events",
                ProviderFeatureCategory::Events,
                "provider.events",
            ),
            (
                "provider.semantic_tools",
                "Semantic tool calls",
                ProviderFeatureCategory::Tools,
                "provider.tools",
            ),
            (
                "provider.normalized_server_requests",
                "Normalized server requests",
                ProviderFeatureCategory::ServerRequests,
                "provider.server_requests",
            ),
        ]
        .into_iter()
        .map(
            |(key, display_name, category, provider_method)| ProviderFeature {
                key: key.to_string(),
                display_name: display_name.to_string(),
                category,
                support: ProviderFeatureSupport::Native,
                direction: Some(ProviderFeatureDirection::Internal),
                provider_method: Some(provider_method.to_string()),
                capability: capabilities
                    .iter()
                    .find(|&capability| capability.key == key)
                    .cloned(),
            },
        )
        .collect()
    }
}

impl Default for AceNativeProvider {
    fn default() -> Self {
        Self::new()
    }
}

trait WithContractCapabilities {
    fn with_contract_capabilities(self) -> Self;
}

impl WithContractCapabilities for ProviderDescriptor {
    fn with_contract_capabilities(mut self) -> Self {
        self.capabilities.extend(
            ace_provider_contract_requirements()
                .into_iter()
                .filter(|requirement| requirement.required)
                .map(|requirement| ProviderCapability {
                    key: requirement.key,
                    version: requirement.min_version,
                }),
        );
        self
    }
}

#[async_trait]
impl ProviderDriver for AceNativeProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        Self::descriptor_static()
    }

    fn features(&self) -> Vec<ProviderFeature> {
        Self::features_static()
    }

    async fn status(&self) -> crate::provider::ProviderDriverStatus {
        crate::provider::ProviderDriverStatus {
            health: ProviderRuntimeHealth::Ready,
            transport: Some("in_process".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            initialized: true,
            last_error: None,
            metadata: json!({
                "runtime": "ace",
                "adapter_contract": 1,
                "websocket_first": true
            }),
        }
    }

    async fn lifecycle_action(
        &self,
        action: ProviderLifecycleAction,
        _grace: Duration,
    ) -> Result<ProviderLifecycleResult, ProviderDriverError> {
        Ok(ProviderLifecycleResult {
            action,
            status: self.status().await,
            metadata: json!({
                "no_op": true,
                "reason": "ace provider is in-process"
            }),
        })
    }

    async fn request(&self, request: ProviderRequest) -> Result<Value, ProviderDriverError> {
        match request.method.as_str() {
            "ace.ping" => Ok(json!({
                "provider": "ace",
                "ok": true,
            })),
            "ace.descriptor" => Ok(serde_json::to_value(self.descriptor()).map_err(|error| {
                ProviderDriverError::RequestFailed {
                    provider: "ace".to_string(),
                    method: request.method.clone(),
                    message: error.to_string(),
                }
            })?),
            "ace.capabilities" => Ok(json!({
                "provider": "ace",
                "capabilities": self.descriptor().capabilities,
            })),
            "ace.events.emit" => {
                let emit =
                    serde_json::from_value::<NativeProviderEventsEmitRequest>(request.params)
                        .map_err(|error| ProviderDriverError::RequestFailed {
                            provider: "ace".to_string(),
                            method: "ace.events.emit".to_string(),
                            message: error.to_string(),
                        })?;
                let event_count = emit.events.len();
                self.event_tx.send(emit.events).await.map_err(|_| {
                    ProviderDriverError::RequestFailed {
                        provider: "ace".to_string(),
                        method: "ace.events.emit".to_string(),
                        message: "Ace native provider event queue is closed".to_string(),
                    }
                })?;
                Ok(json!({
                    "provider": "ace",
                    "accepted": true,
                    "event_count": event_count,
                }))
            }
            "ace.semantic_tool.emit" => {
                let emit =
                    serde_json::from_value::<NativeProviderSemanticToolEmitRequest>(request.params)
                        .map_err(|error| ProviderDriverError::RequestFailed {
                            provider: "ace".to_string(),
                            method: "ace.semantic_tool.emit".to_string(),
                            message: error.to_string(),
                        })?;
                self.event_tx
                    .send(vec![ProviderEvent::SemanticTool {
                        tool: Box::new(emit.tool),
                    }])
                    .await
                    .map_err(|_| ProviderDriverError::RequestFailed {
                        provider: "ace".to_string(),
                        method: "ace.semantic_tool.emit".to_string(),
                        message: "Ace native provider event queue is closed".to_string(),
                    })?;
                Ok(json!({
                    "provider": "ace",
                    "accepted": true,
                    "event_count": 1,
                }))
            }
            "ace.adapter.validate" => {
                let request = serde_json::from_value::<AdapterValidationRequest>(request.params)
                    .map_err(|error| ProviderDriverError::RequestFailed {
                        provider: "ace".to_string(),
                        method: "ace.adapter.validate".to_string(),
                        message: error.to_string(),
                    })?;
                let report = provider_contract_report(&request.descriptor);
                let profile = provider_adapter_profile(&request.descriptor);
                Ok(json!({
                    "provider": "ace",
                    "descriptor": request.descriptor,
                    "satisfies_required": report.satisfies_required,
                    "missing_required": report.missing_required,
                    "contract_report": report,
                    "adapter_profile": profile,
                }))
            }
            "ace.contract" => {
                let contract = ace_provider_adapter_contract();
                Ok(json!({
                    "provider": "ace",
                    "version": contract.version,
                    "runtime": {
                        "transport": "websocket",
                        "websocket_first": contract.websocket_first,
                        "events": contract.provider_event_types,
                        "raw_payload_policy": contract.raw_payload_policy,
                        "raw_payload": contract.raw_payload
                    },
                    "adapter_contract": contract,
                    "provider_requirements": {
                        "capabilities": ace_provider_contract_requirements(),
                        "events": "emit normalized ProviderEvent values",
                        "tools": "map provider tool calls to SemanticToolCall when possible",
                        "server_requests": "map provider host requests to NormalizedServerRequest",
                        "fallback": "preserve raw provider methods and payloads"
                    }
                }))
            }
            _ => Err(ProviderDriverError::RequestFailed {
                provider: "ace".to_string(),
                method: request.method,
                message: "unsupported Ace native provider method".to_string(),
            }),
        }
    }
}

#[async_trait]
impl ProviderEventSource for AceNativeProvider {
    async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>, ProviderDriverError> {
        let mut event_rx = self.event_rx.lock().await;
        Ok(event_rx.recv().await)
    }
}

#[async_trait]
impl ProviderServerRequestResponder for AceNativeProvider {
    async fn respond_server_request_result(
        &self,
        request_id: String,
        _result: Value,
    ) -> Result<(), ProviderDriverError> {
        Err(ProviderDriverError::RequestFailed {
            provider: "ace".to_string(),
            method: "provider.server_request.result".to_string(),
            message: format!("Ace native provider has no pending server request `{request_id}`"),
        })
    }

    async fn respond_server_request_error(
        &self,
        request_id: String,
        code: i64,
        message: String,
    ) -> Result<(), ProviderDriverError> {
        Err(ProviderDriverError::RequestFailed {
            provider: "ace".to_string(),
            method: "provider.server_request.error".to_string(),
            message: format!(
                "Ace native provider has no pending server request `{request_id}` for error {code}: {message}"
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{
        ProviderToolMetadata, ToolActionKind, ToolDisplay, ToolRunStatus, ToolSurface, ToolTarget,
        ToolTargetKind, ToolTransport,
    };
    use std::time::Duration;

    #[test]
    fn descriptor_advertises_provider_contract_capabilities() {
        let descriptor = AceNativeProvider::descriptor_static();
        assert_eq!(descriptor.kind, ProviderKind::Ace);
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "ace.provider_contract")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "provider.semantic_tools")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "provider.normalized_server_requests")
        );
        assert!(AceNativeProvider::features_static().iter().any(|feature| {
            feature.key == "provider.semantic_tools"
                && feature.category == ProviderFeatureCategory::Tools
                && feature.support == ProviderFeatureSupport::Native
        }));
    }

    #[tokio::test]
    async fn native_provider_returns_contract_for_future_adapters() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.contract".to_string(),
                params: Value::Null,
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("contract");

        assert_eq!(response["provider"], "ace");
        assert_eq!(response["version"], 1);
        assert_eq!(response["runtime"]["transport"], "websocket");
        assert_eq!(response["runtime"]["websocket_first"], true);
        assert_eq!(
            response["runtime"]["raw_payload_policy"],
            "preserve_provider_payloads"
        );
        assert_eq!(
            response["runtime"]["raw_payload"]["retention"],
            "preserve_provider_payloads"
        );
        assert_eq!(
            response["runtime"]["raw_payload"]["large_payload_strategy"],
            "store_once_reference_deltas"
        );
        assert_eq!(
            response["runtime"]["raw_payload"]["inspector_only_by_default"],
            true
        );
        assert!(
            response["runtime"]["events"]
                .as_array()
                .expect("events")
                .contains(&json!("semantic_tool"))
        );
        assert_eq!(response["adapter_contract"]["version"], 1);
        assert!(
            response["adapter_contract"]["normalized_thread_item_kinds"]
                .as_array()
                .expect("thread item kinds")
                .contains(&json!("plan"))
        );
        assert!(
            response["adapter_contract"]["normalized_server_request_kinds"]
                .as_array()
                .expect("server request kinds")
                .contains(&json!("mcp_elicitation"))
        );
        assert!(
            response["adapter_contract"]["tool_surfaces"]
                .as_array()
                .expect("tool surfaces")
                .contains(&json!("browser"))
        );
        assert!(
            response["adapter_contract"]["tool_action_kinds"]
                .as_array()
                .expect("tool action kinds")
                .contains(&json!("browser.zoom"))
        );
        assert!(
            response["adapter_contract"]["tool_action_kinds"]
                .as_array()
                .expect("tool action kinds")
                .contains(&json!("terminal.output"))
        );
        assert!(
            response["adapter_contract"]["execution_locations"]
                .as_array()
                .expect("execution locations")
                .contains(&json!("worktree"))
        );
        assert_eq!(
            response["provider_requirements"]["server_requests"],
            "map provider host requests to NormalizedServerRequest"
        );
    }

    #[tokio::test]
    async fn native_provider_validates_future_adapter_descriptors() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.adapter.validate".to_string(),
                params: json!({
                    "descriptor": {
                        "kind": ProviderKind::ClaudeCode,
                        "capabilities": ace_provider_contract_requirements()
                            .into_iter()
                            .map(|requirement| ProviderCapability {
                                key: requirement.key,
                                version: requirement.min_version,
                            })
                            .collect::<Vec<_>>()
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("adapter validation");

        assert_eq!(response["provider"], "ace");
        assert_eq!(response["descriptor"]["kind"], "ClaudeCode");
        assert_eq!(response["satisfies_required"], true);
        assert_eq!(response["missing_required"], json!([]));
        assert_eq!(
            response["adapter_profile"]["raw_payload"]["large_payload_strategy"],
            "store_once_reference_deltas"
        );
        assert!(
            response["adapter_profile"]["operations"]
                .as_array()
                .expect("operations")
                .iter()
                .any(|operation| operation["operation"] == "semantic_tools"
                    && operation["invocation"] == "event_stream")
        );
    }

    #[tokio::test]
    async fn native_provider_validation_reports_missing_required_capabilities() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.adapter.validate".to_string(),
                params: json!({
                    "descriptor": {
                        "kind": ProviderKind::ClaudeCode,
                        "capabilities": [
                            { "key": "provider.adapter_contract", "version": 1 }
                        ]
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("adapter validation");

        assert_eq!(response["satisfies_required"], false);
        assert!(
            response["missing_required"]
                .as_array()
                .expect("missing required")
                .contains(&json!("provider.semantic_tools"))
        );
        assert_eq!(
            response["contract_report"]["satisfies_required"],
            response["satisfies_required"]
        );
    }

    #[tokio::test]
    async fn native_provider_reports_ready_status() {
        let provider = AceNativeProvider::new();
        let status = provider.status().await;

        assert_eq!(status.health, ProviderRuntimeHealth::Ready);
        assert_eq!(status.transport.as_deref(), Some("in_process"));
        assert!(status.initialized);
        assert_eq!(status.metadata["websocket_first"], true);
    }

    #[tokio::test]
    async fn native_provider_lifecycle_is_idempotent() {
        let provider = AceNativeProvider::new();
        let result = provider
            .lifecycle_action(ProviderLifecycleAction::Shutdown, Duration::from_millis(1))
            .await
            .expect("lifecycle");

        assert_eq!(result.action, ProviderLifecycleAction::Shutdown);
        assert_eq!(result.status.health, ProviderRuntimeHealth::Ready);
        assert_eq!(result.metadata["reason"], "ace provider is in-process");
    }

    #[tokio::test]
    async fn native_provider_emits_queued_normalized_events() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.events.emit".to_string(),
                params: json!({
                    "events": [
                        {
                            "type": "raw_notification",
                            "method": "thread/list/updated",
                            "params": { "threadId": "thread-1" }
                        }
                    ]
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("emit events");

        assert_eq!(response["accepted"], true);
        assert_eq!(response["event_count"], 1);

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("queued events");
        assert_eq!(
            events,
            vec![ProviderEvent::RawNotification {
                method: "thread/list/updated".to_string(),
                params: json!({ "threadId": "thread-1" }),
            }]
        );
    }

    #[tokio::test]
    async fn native_provider_emits_semantic_tool_events() {
        let provider = AceNativeProvider::new();
        let mut metadata = ProviderToolMetadata::new();
        metadata.provider = Some("ace".to_string());
        metadata.tool_name = Some("browser".to_string());
        metadata.operation = Some("click".to_string());
        metadata.raw_args = json!({ "selector": "#submit" });
        let tool = SemanticToolCall {
            transport: ToolTransport::BrowserBridge,
            surface: ToolSurface::Browser,
            action: ToolActionKind::BrowserClick,
            display: ToolDisplay {
                title: "Clicked #submit in Browser".to_string(),
                summary: None,
                target: Some(ToolTarget {
                    kind: ToolTargetKind::Selector,
                    label: "#submit".to_string(),
                }),
                status: ToolRunStatus::Completed,
                icon_key: "browser-click".to_string(),
                technical_metadata: json!({ "provider": "ace" }),
            },
            provider: metadata,
        };

        let response = provider
            .request(ProviderRequest {
                method: "ace.semantic_tool.emit".to_string(),
                params: json!({ "tool": tool }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("emit semantic tool");

        assert_eq!(response["accepted"], true);
        assert_eq!(response["event_count"], 1);
        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("semantic tool event");

        let ProviderEvent::SemanticTool { tool } = &events[0] else {
            panic!("expected semantic tool event");
        };
        assert_eq!(tool.display.title, "Clicked #submit in Browser");
        assert_eq!(tool.provider.raw_args, json!({ "selector": "#submit" }));
    }

    #[tokio::test]
    async fn native_provider_rejects_unknown_server_request_responses() {
        let provider = AceNativeProvider::new();
        let error = provider
            .respond_server_request_result("missing".to_string(), json!({ "ok": true }))
            .await
            .expect_err("missing server request");

        assert!(matches!(
            error,
            ProviderDriverError::RequestFailed {
                provider,
                method,
                message
            } if provider == "ace"
                && method == "provider.server_request.result"
                && message.contains("missing")
        ));
    }
}
