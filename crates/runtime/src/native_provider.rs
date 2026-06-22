use crate::provider::{
    NormalizedServerRequest, NormalizedServerRequestDecision, ProviderDescriptor, ProviderDriver,
    ProviderDriverError, ProviderEvent, ProviderEventSource, ProviderFeature,
    ProviderFeatureCategory, ProviderFeatureDirection, ProviderFeatureSupport,
    ProviderLifecycleAction, ProviderLifecycleResult, ProviderRequest, ProviderRuntimeHealth,
    ProviderServerRequestResponder, ProviderStateSource, ace_provider_adapter_contract,
    ace_provider_contract_requirements, provider_adapter_profile, provider_contract_report,
};
use crate::runtime_signals::{RuntimeSignalNormalizationInput, normalize_provider_runtime_signal};
use crate::server_requests::{ServerRequestNormalizationInput, normalize_provider_server_request};
use crate::thread_items::{ThreadItemNormalizationInput, normalize_provider_thread_item};
use crate::threads::{AgentRuntimeSnapshot, ProviderStateRecord};
use crate::tools::{
    ProviderServerRequestToolNormalizationInput, ProviderToolEventNormalizationInput,
    SemanticToolCall, ToolNormalizationInput, normalize_provider_server_request_tool,
    normalize_provider_tool_event, normalize_tool_call,
};
use ace_core::{ProviderCapability, ProviderKind};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeProviderSemanticToolNormalizeRequest {
    pub input: ToolNormalizationInput,
    #[serde(default)]
    pub emit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeProviderToolEventNormalizeRequest {
    #[serde(flatten)]
    pub input: ProviderToolEventNormalizationInput,
    #[serde(default)]
    pub emit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeProviderServerRequestToolNormalizeRequest {
    #[serde(flatten)]
    pub input: ProviderServerRequestToolNormalizationInput,
    #[serde(default)]
    pub emit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeProviderServerRequestNormalizeRequest {
    #[serde(flatten)]
    pub input: ServerRequestNormalizationInput,
    #[serde(default)]
    pub emit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeProviderThreadItemNormalizeRequest {
    #[serde(flatten)]
    pub input: ThreadItemNormalizationInput,
    #[serde(default)]
    pub emit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeProviderRuntimeSignalNormalizeRequest {
    #[serde(flatten)]
    pub input: RuntimeSignalNormalizationInput,
    #[serde(default)]
    pub emit: bool,
}

#[derive(Debug)]
pub struct AceNativeProvider {
    event_tx: mpsc::Sender<Vec<ProviderEvent>>,
    event_rx: Mutex<mpsc::Receiver<Vec<ProviderEvent>>>,
    pending_server_requests: Mutex<HashMap<String, NormalizedServerRequest>>,
}

impl AceNativeProvider {
    #[must_use]
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::channel(ACE_NATIVE_EVENT_QUEUE_CAPACITY);
        Self {
            event_tx,
            event_rx: Mutex::new(event_rx),
            pending_server_requests: Mutex::new(HashMap::new()),
        }
    }

    async fn emit_events(
        &self,
        method: &'static str,
        events: Vec<ProviderEvent>,
    ) -> Result<(), ProviderDriverError> {
        self.track_pending_server_requests(&events).await;
        self.event_tx
            .send(events)
            .await
            .map_err(|_| ProviderDriverError::RequestFailed {
                provider: "ace".to_string(),
                method: method.to_string(),
                message: "Ace native provider event queue is closed".to_string(),
            })
    }

    async fn track_pending_server_requests(&self, events: &[ProviderEvent]) {
        let mut pending = self.pending_server_requests.lock().await;
        for event in events {
            match event {
                ProviderEvent::ServerRequest { request } => {
                    pending.insert(request.request_id.clone(), request.as_ref().clone());
                }
                ProviderEvent::ServerRequestResolved { request_id, .. } => {
                    pending.remove(request_id);
                }
                _ => {}
            }
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
                "ace.semantic_tool.normalize",
                "Normalize provider tool call",
                ProviderFeatureCategory::Tools,
                "ace.semantic_tool.normalize",
            ),
            (
                "ace.tool_event.normalize",
                "Normalize provider tool event",
                ProviderFeatureCategory::Tools,
                "ace.tool_event.normalize",
            ),
            (
                "ace.server_request_tool.normalize",
                "Normalize provider server request tool",
                ProviderFeatureCategory::Tools,
                "ace.server_request_tool.normalize",
            ),
            (
                "ace.server_request.normalize",
                "Normalize provider server request",
                ProviderFeatureCategory::ServerRequests,
                "ace.server_request.normalize",
            ),
            (
                "ace.thread_item.normalize",
                "Normalize provider thread item",
                ProviderFeatureCategory::Events,
                "ace.thread_item.normalize",
            ),
            (
                "ace.runtime_signal.normalize",
                "Normalize provider runtime signal",
                ProviderFeatureCategory::Events,
                "ace.runtime_signal.normalize",
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
                self.emit_events("ace.events.emit", emit.events).await?;
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
                self.emit_events(
                    "ace.semantic_tool.emit",
                    vec![ProviderEvent::SemanticTool {
                        tool: Box::new(emit.tool),
                    }],
                )
                .await?;
                Ok(json!({
                    "provider": "ace",
                    "accepted": true,
                    "event_count": 1,
                }))
            }
            "ace.semantic_tool.normalize" => {
                let normalize =
                    serde_json::from_value::<NativeProviderSemanticToolNormalizeRequest>(
                        request.params,
                    )
                    .map_err(|error| ProviderDriverError::RequestFailed {
                        provider: "ace".to_string(),
                        method: "ace.semantic_tool.normalize".to_string(),
                        message: error.to_string(),
                    })?;
                let tool = normalize_tool_call(normalize.input);
                if normalize.emit {
                    self.emit_events(
                        "ace.semantic_tool.normalize",
                        vec![ProviderEvent::SemanticTool {
                            tool: Box::new(tool.clone()),
                        }],
                    )
                    .await?;
                }
                Ok(json!({
                    "provider": "ace",
                    "accepted": true,
                    "tool": tool,
                    "emitted": normalize.emit,
                    "event_count": if normalize.emit { 1 } else { 0 },
                }))
            }
            "ace.tool_event.normalize" => {
                let normalize = serde_json::from_value::<NativeProviderToolEventNormalizeRequest>(
                    request.params,
                )
                .map_err(|error| ProviderDriverError::RequestFailed {
                    provider: "ace".to_string(),
                    method: "ace.tool_event.normalize".to_string(),
                    message: error.to_string(),
                })?;
                let emit = normalize.emit;
                let tool = normalize_provider_tool_event(normalize.input).ok_or_else(|| {
                    ProviderDriverError::RequestFailed {
                        provider: "ace".to_string(),
                        method: "ace.tool_event.normalize".to_string(),
                        message: "unsupported provider tool event method".to_string(),
                    }
                })?;
                if emit {
                    self.emit_events(
                        "ace.tool_event.normalize",
                        vec![ProviderEvent::SemanticTool {
                            tool: Box::new(tool.clone()),
                        }],
                    )
                    .await?;
                }
                Ok(json!({
                    "provider": "ace",
                    "accepted": true,
                    "tool": tool,
                    "emitted": emit,
                    "event_count": if emit { 1 } else { 0 },
                }))
            }
            "ace.server_request_tool.normalize" => {
                let normalize = serde_json::from_value::<
                    NativeProviderServerRequestToolNormalizeRequest,
                >(request.params)
                .map_err(|error| ProviderDriverError::RequestFailed {
                    provider: "ace".to_string(),
                    method: "ace.server_request_tool.normalize".to_string(),
                    message: error.to_string(),
                })?;
                let emit = normalize.emit;
                let tool =
                    normalize_provider_server_request_tool(normalize.input).ok_or_else(|| {
                        ProviderDriverError::RequestFailed {
                            provider: "ace".to_string(),
                            method: "ace.server_request_tool.normalize".to_string(),
                            message: "unsupported provider server request tool method".to_string(),
                        }
                    })?;
                if emit {
                    self.emit_events(
                        "ace.server_request_tool.normalize",
                        vec![ProviderEvent::SemanticTool {
                            tool: Box::new(tool.clone()),
                        }],
                    )
                    .await?;
                }
                Ok(json!({
                    "provider": "ace",
                    "accepted": true,
                    "tool": tool,
                    "emitted": emit,
                    "event_count": if emit { 1 } else { 0 },
                }))
            }
            "ace.server_request.normalize" => {
                let normalize =
                    serde_json::from_value::<NativeProviderServerRequestNormalizeRequest>(
                        request.params,
                    )
                    .map_err(|error| ProviderDriverError::RequestFailed {
                        provider: "ace".to_string(),
                        method: "ace.server_request.normalize".to_string(),
                        message: error.to_string(),
                    })?;
                let emit = normalize.emit;
                let normalized = normalize_provider_server_request(normalize.input);
                if emit {
                    self.emit_events(
                        "ace.server_request.normalize",
                        vec![ProviderEvent::ServerRequest {
                            request: Box::new(normalized.clone()),
                        }],
                    )
                    .await?;
                }
                Ok(json!({
                    "provider": "ace",
                    "accepted": true,
                    "request": normalized,
                    "emitted": emit,
                    "event_count": if emit { 1 } else { 0 },
                }))
            }
            "ace.thread_item.normalize" => {
                let normalize = serde_json::from_value::<NativeProviderThreadItemNormalizeRequest>(
                    request.params,
                )
                .map_err(|error| ProviderDriverError::RequestFailed {
                    provider: "ace".to_string(),
                    method: "ace.thread_item.normalize".to_string(),
                    message: error.to_string(),
                })?;
                let emit = normalize.emit;
                let item = normalize_provider_thread_item(normalize.input).ok_or_else(|| {
                    ProviderDriverError::RequestFailed {
                        provider: "ace".to_string(),
                        method: "ace.thread_item.normalize".to_string(),
                        message: "unsupported provider thread item method".to_string(),
                    }
                })?;
                if emit {
                    self.emit_events(
                        "ace.thread_item.normalize",
                        vec![ProviderEvent::ThreadItem {
                            item: Box::new(item.clone()),
                        }],
                    )
                    .await?;
                }
                Ok(json!({
                    "provider": "ace",
                    "accepted": true,
                    "item": item,
                    "emitted": emit,
                    "event_count": if emit { 1 } else { 0 },
                }))
            }
            "ace.runtime_signal.normalize" => {
                let normalize =
                    serde_json::from_value::<NativeProviderRuntimeSignalNormalizeRequest>(
                        request.params,
                    )
                    .map_err(|error| ProviderDriverError::RequestFailed {
                        provider: "ace".to_string(),
                        method: "ace.runtime_signal.normalize".to_string(),
                        message: error.to_string(),
                    })?;
                let emit = normalize.emit;
                let signal =
                    normalize_provider_runtime_signal(normalize.input).ok_or_else(|| {
                        ProviderDriverError::RequestFailed {
                            provider: "ace".to_string(),
                            method: "ace.runtime_signal.normalize".to_string(),
                            message: "unsupported provider runtime signal method".to_string(),
                        }
                    })?;
                if emit {
                    self.emit_events(
                        "ace.runtime_signal.normalize",
                        vec![ProviderEvent::RuntimeSignal {
                            signal: Box::new(signal.clone()),
                        }],
                    )
                    .await?;
                }
                Ok(json!({
                    "provider": "ace",
                    "accepted": true,
                    "signal": signal,
                    "emitted": emit,
                    "event_count": if emit { 1 } else { 0 },
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
        result: Value,
    ) -> Result<(), ProviderDriverError> {
        let request = self
            .pending_server_requests
            .lock()
            .await
            .remove(&request_id)
            .ok_or_else(|| ProviderDriverError::RequestFailed {
                provider: "ace".to_string(),
                method: "provider.server_request.result".to_string(),
                message: format!(
                    "Ace native provider has no pending server request `{request_id}`"
                ),
            })?;

        self.emit_events(
            "provider.server_request.result",
            vec![ProviderEvent::ServerRequestResolved {
                request_id,
                decision: NormalizedServerRequestDecision {
                    outcome: "result".to_string(),
                    payload: result,
                    audit: json!({
                        "provider": "ace",
                        "source": "ace_native_provider",
                    }),
                },
                request: Some(Box::new(request)),
            }],
        )
        .await
    }

    async fn respond_server_request_error(
        &self,
        request_id: String,
        code: i64,
        message: String,
    ) -> Result<(), ProviderDriverError> {
        let request = self
            .pending_server_requests
            .lock()
            .await
            .remove(&request_id)
            .ok_or_else(|| ProviderDriverError::RequestFailed {
                provider: "ace".to_string(),
                method: "provider.server_request.error".to_string(),
                message: format!(
                    "Ace native provider has no pending server request `{request_id}` for error {code}: {message}"
                ),
            })?;

        self.emit_events(
            "provider.server_request.error",
            vec![ProviderEvent::ServerRequestResolved {
                request_id,
                decision: NormalizedServerRequestDecision {
                    outcome: "error".to_string(),
                    payload: json!({
                        "code": code,
                        "message": message,
                    }),
                    audit: json!({
                        "provider": "ace",
                        "source": "ace_native_provider",
                        "error_code": code,
                    }),
                },
                request: Some(Box::new(request)),
            }],
        )
        .await
    }
}

#[async_trait]
impl ProviderStateSource for AceNativeProvider {
    async fn runtime_state_snapshot(&self) -> Result<AgentRuntimeSnapshot, ProviderDriverError> {
        let pending_server_requests = self.pending_server_requests.lock().await.len();
        Ok(AgentRuntimeSnapshot {
            provider_states: vec![ProviderStateRecord {
                provider: "ace".to_string(),
                status: "ready".to_string(),
                message: None,
                name: Some("Ace native provider".to_string()),
                metadata: json!({
                    "runtime": "in_process",
                    "adapter_contract": 1,
                    "pending_server_requests": pending_server_requests,
                    "websocket_first": true,
                }),
            }],
            ..AgentRuntimeSnapshot::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ServerRequestKind;
    use crate::tools::{
        ProviderToolMetadata, ToolActionKind, ToolDisplay, ToolNormalizationInput, ToolRunStatus,
        ToolSurface, ToolTarget, ToolTargetKind, ToolTransport,
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
        assert_eq!(response["version"], 3);
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
        assert_eq!(response["adapter_contract"]["version"], 3);
        assert!(
            response["adapter_contract"]["operations"]
                .as_array()
                .expect("operations")
                .iter()
                .any(|operation| operation["operation"] == "thread_shell_command"
                    && operation["policy"]["requires_user_initiation"] == true
                    && operation["policy"]["escapes_thread_sandbox"] == true)
        );
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
    async fn native_provider_normalizes_provider_tool_metadata_without_emitting() {
        let provider = AceNativeProvider::new();
        let mut metadata = ProviderToolMetadata::new();
        metadata.provider = Some("future-provider".to_string());
        metadata.server_name = Some("browser".to_string());
        metadata.tool_name = Some("playwright_locator_click".to_string());
        metadata.operation = Some("playwright_locator_click".to_string());
        metadata.raw_args = json!({
            "selector": "button:has-text('Deploy')",
            "label": "Deploy"
        });
        metadata.raw_payload = json!({
            "providerSpecificEnvelope": true
        });

        let response = provider
            .request(ProviderRequest {
                method: "ace.semantic_tool.normalize".to_string(),
                params: json!({
                    "input": ToolNormalizationInput {
                        transport: ToolTransport::Mcp,
                        status: ToolRunStatus::Completed,
                        provider: metadata,
                        item_type: Some("mcpToolCall".to_string()),
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize semantic tool");

        assert_eq!(response["emitted"], false);
        assert_eq!(response["event_count"], 0);
        assert_eq!(response["tool"]["surface"], "browser");
        assert_eq!(response["tool"]["action"], "browser.click");
        assert_eq!(
            response["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );
        assert_eq!(
            response["tool"]["provider"]["raw_payload"],
            json!({ "providerSpecificEnvelope": true })
        );
    }

    #[tokio::test]
    async fn native_provider_normalizes_and_emits_provider_tool_metadata() {
        let provider = AceNativeProvider::new();
        let mut metadata = ProviderToolMetadata::new();
        metadata.provider = Some("future-provider".to_string());
        metadata.tool_name = Some("dom_cua_type".to_string());
        metadata.operation = Some("dom_cua_type".to_string());
        metadata.raw_args = json!({
            "text": "hello",
            "selector": "input[name=q]"
        });

        let response = provider
            .request(ProviderRequest {
                method: "ace.semantic_tool.normalize".to_string(),
                params: json!({
                    "emit": true,
                    "input": ToolNormalizationInput {
                        transport: ToolTransport::Mcp,
                        status: ToolRunStatus::Started,
                        provider: metadata,
                        item_type: Some("dynamicToolCall".to_string()),
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize and emit semantic tool");

        assert_eq!(response["emitted"], true);
        assert_eq!(response["event_count"], 1);
        assert_eq!(
            response["tool"]["display"]["title"],
            "Typing into hello in Browser"
        );

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("semantic tool event");
        let ProviderEvent::SemanticTool { tool } = &events[0] else {
            panic!("expected semantic tool event");
        };
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserType);
        assert_eq!(tool.display.title, "Typing into hello in Browser");
        assert_eq!(tool.provider.raw_args["text"], "hello");
    }

    #[tokio::test]
    async fn native_provider_normalizes_tool_event_without_emitting() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.tool_event.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "method": "item/completed",
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "item": {
                            "id": "tool-1",
                            "type": "dynamicToolCall",
                            "toolName": "ace_browser",
                            "input": {
                                "operation": "navigate_tab_url",
                                "url": "https://example.com"
                            },
                            "result": { "ok": true }
                        }
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize tool event");

        assert_eq!(response["accepted"], true);
        assert_eq!(response["emitted"], false);
        assert_eq!(response["event_count"], 0);
        assert_eq!(response["tool"]["surface"], "browser");
        assert_eq!(response["tool"]["action"], "browser.navigate");
        assert_eq!(
            response["tool"]["display"]["title"],
            "Opened https://example.com in Browser"
        );
        assert_eq!(response["tool"]["provider"]["provider"], "future-provider");
        assert_eq!(
            response["tool"]["provider"]["raw_payload"]["item"]["result"]["ok"],
            true
        );
    }

    #[tokio::test]
    async fn native_provider_normalizes_and_emits_server_request_tool() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.server_request_tool.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "request_id": "approval-1",
                    "method": "command/approvalRequest",
                    "emit": true,
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "command": "cargo test --workspace",
                        "cwd": "/repo",
                        "prompt": "Run tests?"
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize and emit server request tool");

        assert_eq!(response["accepted"], true);
        assert_eq!(response["emitted"], true);
        assert_eq!(response["event_count"], 1);
        assert_eq!(response["tool"]["surface"], "terminal");
        assert_eq!(response["tool"]["action"], "terminal.run");
        assert_eq!(response["tool"]["display"]["status"], "approval_requested");

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("semantic tool event");
        let ProviderEvent::SemanticTool { tool } = &events[0] else {
            panic!("expected semantic tool event");
        };
        assert_eq!(tool.surface, ToolSurface::Terminal);
        assert_eq!(tool.action, ToolActionKind::TerminalRun);
        assert_eq!(tool.display.status, ToolRunStatus::ApprovalRequested);
        assert_eq!(tool.display.title, "Running `cargo test --workspace`");
        assert_eq!(tool.provider.provider.as_deref(), Some("future-provider"));
    }

    #[tokio::test]
    async fn native_provider_normalizes_server_request_without_emitting() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.server_request.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "request_id": "req-1",
                    "method": "command/approvalRequest",
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "itemId": "item-1",
                        "command": "cargo test --workspace",
                        "approvalPolicy": "on-request",
                        "schemaVersion": "2026-06-22"
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize server request");

        assert_eq!(response["accepted"], true);
        assert_eq!(response["emitted"], false);
        assert_eq!(response["event_count"], 0);
        assert_eq!(response["request"]["kind"], "command_approval");
        assert_eq!(response["request"]["request_id"], "req-1");
        assert_eq!(response["request"]["scope"], "command");
        assert_eq!(
            response["request"]["prompt"],
            "Run `cargo test --workspace`?"
        );
        assert_eq!(response["request"]["selected_policy"], "on-request");
        assert_eq!(
            response["request"]["provider"]["provider"],
            "future-provider"
        );
        assert_eq!(
            response["request"]["provider"]["raw_payload"]["command"],
            "cargo test --workspace"
        );
        assert_eq!(
            response["request"]["metadata"]["command"],
            "cargo test --workspace"
        );
    }

    #[tokio::test]
    async fn native_provider_normalizes_and_emits_server_request() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.server_request.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "request_id": "req-2",
                    "method": "mcp/elicitation",
                    "emit": true,
                    "params": {
                        "thread_id": "thread-2",
                        "tool_call_id": "tool-1",
                        "serverName": "linear",
                        "prompt": "Pick a workspace",
                        "choices": ["eng", "design"]
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize and emit server request");

        assert_eq!(response["emitted"], true);
        assert_eq!(response["event_count"], 1);
        assert_eq!(response["request"]["kind"], "mcp_elicitation");
        assert_eq!(response["request"]["scope"], "mcp");
        assert_eq!(response["request"]["prompt"], "Pick a workspace");

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("server request event");
        let ProviderEvent::ServerRequest { request } = &events[0] else {
            panic!("expected server request event");
        };
        assert_eq!(request.kind, ServerRequestKind::McpElicitation);
        assert_eq!(request.request_id, "req-2");
        assert_eq!(request.thread_id.as_deref(), Some("thread-2"));
        assert_eq!(request.item_id.as_deref(), Some("tool-1"));
        assert_eq!(request.provider.provider, "future-provider");
        assert_eq!(request.metadata["choices"], json!(["eng", "design"]));
    }

    #[tokio::test]
    async fn native_provider_records_and_resolves_emitted_server_request_result() {
        let provider = AceNativeProvider::new();
        provider
            .request(ProviderRequest {
                method: "ace.server_request.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "request_id": "req-result",
                    "method": "mcp/elicitation",
                    "emit": true,
                    "params": {
                        "thread_id": "thread-2",
                        "tool_call_id": "tool-1",
                        "serverName": "linear",
                        "prompt": "Pick a workspace",
                        "choices": ["eng", "design"]
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize and emit server request");

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("server request event");
        let ProviderEvent::ServerRequest { request } = &events[0] else {
            panic!("expected server request event");
        };
        assert_eq!(request.kind, ServerRequestKind::McpElicitation);
        assert_eq!(request.request_id, "req-result");

        provider
            .respond_server_request_result(
                "req-result".to_string(),
                json!({
                    "choice": "eng"
                }),
            )
            .await
            .expect("respond server request result");

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("server request resolved event");
        let ProviderEvent::ServerRequestResolved {
            request_id,
            decision,
            request,
        } = &events[0]
        else {
            panic!("expected server request resolved event");
        };
        assert_eq!(request_id, "req-result");
        assert_eq!(decision.outcome, "result");
        assert_eq!(decision.payload["choice"], "eng");
        assert_eq!(decision.audit["provider"], "ace");
        assert_eq!(
            request.as_ref().expect("resolved request").request_id,
            "req-result"
        );

        let error = provider
            .respond_server_request_result("req-result".to_string(), json!({ "choice": "design" }))
            .await
            .expect_err("duplicate server request response");
        assert!(matches!(
            error,
            ProviderDriverError::RequestFailed {
                provider,
                method,
                message
            } if provider == "ace"
                && method == "provider.server_request.result"
                && message.contains("no pending server request")
        ));
    }

    #[tokio::test]
    async fn native_provider_records_and_resolves_emitted_server_request_error() {
        let provider = AceNativeProvider::new();
        provider
            .request(ProviderRequest {
                method: "ace.server_request.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "request_id": "req-error",
                    "method": "permission/approvalRequest",
                    "emit": true,
                    "params": {
                        "threadId": "thread-3",
                        "turnId": "turn-3",
                        "prompt": "Allow full access?",
                        "permission": "danger-full-access"
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize and emit server request");

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("server request event");
        let ProviderEvent::ServerRequest { request } = &events[0] else {
            panic!("expected server request event");
        };
        assert_eq!(request.request_id, "req-error");

        provider
            .respond_server_request_error("req-error".to_string(), 403, "denied".to_string())
            .await
            .expect("respond server request error");

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("server request resolved event");
        let ProviderEvent::ServerRequestResolved {
            request_id,
            decision,
            request,
        } = &events[0]
        else {
            panic!("expected server request resolved event");
        };
        assert_eq!(request_id, "req-error");
        assert_eq!(decision.outcome, "error");
        assert_eq!(decision.payload["code"], 403);
        assert_eq!(decision.payload["message"], "denied");
        assert_eq!(decision.audit["error_code"], 403);
        assert_eq!(
            request.as_ref().expect("resolved request").request_id,
            "req-error"
        );
    }

    #[tokio::test]
    async fn native_provider_normalizes_thread_item_without_emitting() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.thread_item.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "method": "item/agentMessage/delta",
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "itemId": "item-agent",
                        "delta": "Working on it"
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize thread item");

        assert_eq!(response["accepted"], true);
        assert_eq!(response["emitted"], false);
        assert_eq!(response["event_count"], 0);
        assert_eq!(response["item"]["kind"], "agentMessage");
        assert_eq!(response["item"]["status"], "updated");
        assert_eq!(response["item"]["text"], "Working on it");
        assert_eq!(response["item"]["provider"]["provider"], "future-provider");
        assert_eq!(
            response["item"]["provider"]["raw_payload"]["threadId"],
            "thread-1"
        );
    }

    #[tokio::test]
    async fn native_provider_normalizes_and_emits_thread_item() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.thread_item.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "method": "item/completed",
                    "emit": true,
                    "params": {
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
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize and emit thread item");

        assert_eq!(response["emitted"], true);
        assert_eq!(response["event_count"], 1);
        assert_eq!(response["item"]["kind"], "subAgentActivity");

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("thread item event");
        let ProviderEvent::ThreadItem { item } = &events[0] else {
            panic!("expected thread item event");
        };
        assert_eq!(item.kind, crate::provider::ThreadItemKind::SubAgentActivity);
        assert_eq!(item.parent_thread_id.as_deref(), Some("parent-thread"));
        assert_eq!(item.child_thread_id.as_deref(), Some("child-thread"));
        assert_eq!(item.role.as_deref(), Some("reviewer"));
        assert_eq!(item.sender.as_deref(), Some("Reviewer"));
        assert_eq!(item.provider.provider, "future-provider");
    }

    #[tokio::test]
    async fn native_provider_normalizes_runtime_signal_without_emitting() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.runtime_signal.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "method": "model/rerouted",
                    "params": {
                        "thread": { "id": "thread-1" },
                        "turn": { "id": "turn-1" },
                        "fromModel": "gpt-5",
                        "toModel": "gpt-5-mini",
                        "reason": "capacity"
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize runtime signal");

        assert_eq!(response["accepted"], true);
        assert_eq!(response["emitted"], false);
        assert_eq!(response["event_count"], 0);
        assert_eq!(response["signal"]["kind"], "model_rerouted");
        assert_eq!(response["signal"]["thread_id"], "thread-1");
        assert_eq!(response["signal"]["turn_id"], "turn-1");
        assert_eq!(response["signal"]["from_model"], "gpt-5");
        assert_eq!(response["signal"]["to_model"], "gpt-5-mini");
        assert_eq!(
            response["signal"]["provider"]["provider"],
            "future-provider"
        );
        assert_eq!(
            response["signal"]["provider"]["raw_payload"]["reason"],
            "capacity"
        );
    }

    #[tokio::test]
    async fn native_provider_normalizes_and_emits_runtime_signal() {
        let provider = AceNativeProvider::new();
        let response = provider
            .request(ProviderRequest {
                method: "ace.runtime_signal.normalize".to_string(),
                params: json!({
                    "provider": "future-provider",
                    "method": "thread/name/updated",
                    "emit": true,
                    "params": {
                        "thread": {
                            "id": "thread-1",
                            "name": "Adapter parity"
                        }
                    }
                }),
                timeout: Duration::from_secs(1),
            })
            .await
            .expect("normalize and emit runtime signal");

        assert_eq!(response["emitted"], true);
        assert_eq!(response["event_count"], 1);
        assert_eq!(response["signal"]["kind"], "thread_lifecycle_changed");
        assert_eq!(response["signal"]["name"], "Adapter parity");

        let events = provider
            .next_events()
            .await
            .expect("event poll")
            .expect("runtime signal event");
        let ProviderEvent::RuntimeSignal { signal } = &events[0] else {
            panic!("expected runtime signal event");
        };
        assert_eq!(
            signal.kind,
            crate::provider::RuntimeSignalKind::ThreadLifecycleChanged
        );
        assert_eq!(signal.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(signal.status.as_deref(), Some("renamed"));
        assert_eq!(signal.name.as_deref(), Some("Adapter parity"));
        assert_eq!(signal.provider.provider, "future-provider");
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
