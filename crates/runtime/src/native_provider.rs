use crate::provider::{
    ProviderDescriptor, ProviderDriver, ProviderDriverError, ProviderFeature,
    ProviderFeatureCategory, ProviderFeatureDirection, ProviderFeatureSupport, ProviderRequest,
    ProviderRuntimeHealth, ace_provider_contract_requirements,
};
use ace_core::{ProviderCapability, ProviderKind};
use async_trait::async_trait;
use serde_json::{Value, json};

#[derive(Debug, Clone, Default)]
pub struct AceNativeProvider;

impl AceNativeProvider {
    #[must_use]
    pub fn new() -> Self {
        Self
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
            "ace.contract" => Ok(json!({
                "provider": "ace",
                "version": 1,
                "runtime": {
                    "transport": "websocket",
                    "events": [
                        "thread_item",
                        "tool_started",
                        "tool_updated",
                        "tool_completed",
                        "tool_failed",
                        "tool_approval_requested",
                        "server_request",
                        "raw_notification",
                        "raw_server_request"
                    ],
                    "raw_payload_policy": "preserve_provider_payloads"
                },
                "provider_requirements": {
                    "capabilities": ace_provider_contract_requirements(),
                    "events": "emit normalized ProviderEvent values",
                    "tools": "map provider tool calls to SemanticToolCall when possible",
                    "server_requests": "map provider host requests to NormalizedServerRequest",
                    "fallback": "preserve raw provider methods and payloads"
                }
            })),
            _ => Err(ProviderDriverError::RequestFailed {
                provider: "ace".to_string(),
                method: request.method,
                message: "unsupported Ace native provider method".to_string(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(response["runtime"]["transport"], "websocket");
        assert_eq!(
            response["provider_requirements"]["server_requests"],
            "map provider host requests to NormalizedServerRequest"
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
}
