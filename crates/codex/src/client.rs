use crate::{
    AppServerTransport, CodexError, CodexStdioTransport, Result, normalize_codex_inbound_event,
};
use ace_core::{ProviderCapability, ProviderKind};
use ace_runtime::provider::{
    ProviderDescriptor, ProviderDriver, ProviderDriverError, ProviderEvent, ProviderRequest,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub const DEFAULT_CODEX_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

impl Default for CodexClientInfo {
    fn default() -> Self {
        Self {
            name: "ace_desktop".to_string(),
            title: "Ace Desktop".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexConfig {
    pub command: String,
    pub args: Vec<String>,
    pub client_info: CodexClientInfo,
    pub request_timeout: Duration,
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            command: "codex".to_string(),
            args: vec!["app-server".to_string()],
            client_info: CodexClientInfo::default(),
            request_timeout: DEFAULT_CODEX_REQUEST_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexThreadStart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default)]
    pub ephemeral: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexTurnStart {
    pub thread_id: String,
    pub input: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_mode: Option<Value>,
}

impl CodexTurnStart {
    #[must_use]
    pub fn plan(thread_id: impl Into<String>, prompt: impl Into<String>, model: String) -> Self {
        Self {
            thread_id: thread_id.into(),
            input: vec![json!({ "type": "text", "text": prompt.into() })],
            model: None,
            cwd: None,
            sandbox_policy: None,
            approval_policy: None,
            approvals_reviewer: None,
            collaboration_mode: Some(json!({
                "mode": "plan",
                "settings": {
                    "model": model,
                    "developer_instructions": null,
                    "reasoning_effort": null,
                }
            })),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexProviderRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone)]
pub struct CodexClient<T: AppServerTransport> {
    transport: Arc<T>,
    timeout: Duration,
}

impl CodexClient<CodexStdioTransport> {
    pub async fn spawn(config: CodexConfig) -> Result<Self> {
        let transport = CodexStdioTransport::spawn(&config.command, &config.args).await?;
        let client = Self::new(transport, config.request_timeout);
        client.initialize(config.client_info).await?;
        Ok(client)
    }
}

impl<T: AppServerTransport> CodexClient<T> {
    #[must_use]
    pub fn new(transport: T, timeout: Duration) -> Self {
        Self {
            transport: Arc::new(transport),
            timeout,
        }
    }

    pub async fn initialize(&self, client_info: CodexClientInfo) -> Result<Value> {
        let response = self
            .raw_request(
                "initialize",
                json!({
                    "clientInfo": client_info,
                    "capabilities": {
                        "experimentalApi": true
                    }
                }),
            )
            .await?;
        self.transport.notify("initialized", json!({})).await?;
        Ok(response)
    }

    pub async fn raw_request(&self, method: &str, params: Value) -> Result<Value> {
        self.transport.request(method, params, self.timeout).await
    }

    pub async fn start_thread(&self, request: CodexThreadStart) -> Result<Value> {
        self.raw_request("thread/start", serde_json::to_value(request)?)
            .await
    }

    pub async fn resume_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/resume", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn fork_thread(&self, thread_id: &str, ephemeral: bool) -> Result<Value> {
        self.raw_request(
            "thread/fork",
            json!({
                "threadId": thread_id,
                "ephemeral": ephemeral,
            }),
        )
        .await
    }

    pub async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
        self.raw_request("turn/start", serde_json::to_value(request)?)
            .await
    }

    pub async fn interrupt_turn(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("turn/interrupt", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn next_provider_events(&self) -> Option<Vec<ProviderEvent>> {
        self.transport
            .recv()
            .await
            .map(|event| normalize_codex_inbound_event(&event))
    }

    pub async fn respond_tool_result(&self, request_id: i64, result: Value) -> Result<()> {
        self.transport.respond_result(request_id, result).await
    }

    pub async fn respond_tool_error(
        &self,
        request_id: i64,
        code: i64,
        message: &str,
    ) -> Result<()> {
        self.transport
            .respond_error(request_id, code, message)
            .await
    }
}

#[derive(Clone)]
pub struct CodexAdapter<T: AppServerTransport> {
    client: CodexClient<T>,
}

impl<T: AppServerTransport> CodexAdapter<T> {
    #[must_use]
    pub fn new(client: CodexClient<T>) -> Self {
        Self { client }
    }

    #[must_use]
    pub fn client(&self) -> &CodexClient<T> {
        &self.client
    }
}

#[async_trait]
impl<T: AppServerTransport + 'static> ProviderDriver for CodexAdapter<T> {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            kind: ProviderKind::Codex,
            capabilities: vec![
                ProviderCapability {
                    key: "codex.app_server".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.experimental_api".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.semantic_tools".to_string(),
                    version: 1,
                },
            ],
        }
    }

    async fn request(
        &self,
        request: ProviderRequest,
    ) -> std::result::Result<Value, ProviderDriverError> {
        self.client
            .raw_request(&request.method, request.params)
            .await
            .map_err(|error| ProviderDriverError::RequestFailed {
                provider: "codex".to_string(),
                method: request.method,
                message: error.to_string(),
            })
    }
}

impl From<CodexError> for ProviderDriverError {
    fn from(error: CodexError) -> Self {
        Self::RequestFailed {
            provider: "codex".to_string(),
            method: "unknown".to_string(),
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CodexInboundEvent;
    use crate::transport::tests::FakeTransport;
    use serde_json::json;

    #[tokio::test]
    async fn initialize_sends_experimental_api_and_initialized_notification() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "platformFamily": "unix" })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        let response = client
            .initialize(CodexClientInfo {
                name: "ace_test".to_string(),
                title: "Ace Test".to_string(),
                version: "0.1.0".to_string(),
            })
            .await
            .expect("initialize");
        assert_eq!(response["platformFamily"], "unix");

        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "initialize");
        assert_eq!(requests[0].1["capabilities"]["experimentalApi"], true);
        drop(requests);

        let notifications = client
            .transport
            .notifications
            .lock()
            .expect("notifications");
        assert_eq!(notifications[0].0, "initialized");
    }

    #[tokio::test]
    async fn starts_plan_turn_with_codex_collaboration_mode() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "turn": { "id": "turn-1" } })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make a plan",
                "gpt-5.5".to_string(),
            ))
            .await
            .expect("turn");
        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "turn/start");
        assert_eq!(requests[0].1["collaboration_mode"]["mode"], "plan");
        assert_eq!(
            requests[0].1["collaboration_mode"]["settings"]["model"],
            "gpt-5.5"
        );
    }

    #[tokio::test]
    async fn exposes_semantic_provider_events_from_inbound_codex_items() {
        let fake = FakeTransport::default();
        fake.inbound
            .lock()
            .expect("inbound")
            .push_back(CodexInboundEvent::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "id": "item-1",
                        "type": "mcpToolCall",
                        "serverName": "browser",
                        "toolName": "ace_browser",
                        "input": {
                            "operation": "cua_click",
                            "label": "Continue"
                        }
                    }
                }),
            });
        let client = CodexClient::new(fake, Duration::from_secs(1));

        let events = client.next_provider_events().await.expect("events");
        assert!(matches!(
            &events[0],
            ProviderEvent::SemanticTool { tool }
                if tool.display.title == "Clicked Continue in Browser"
        ));
    }

    #[test]
    fn adapter_descriptor_advertises_codex_and_semantic_tools() {
        let client = CodexClient::new(FakeTransport::default(), Duration::from_secs(1));
        let adapter = CodexAdapter::new(client);
        let descriptor = adapter.descriptor();

        assert_eq!(descriptor.kind, ProviderKind::Codex);
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "provider.semantic_tools")
        );
    }
}
