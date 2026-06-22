use crate::{
    AppServerTransport, CodexError, CodexStdioTransport, Result, normalize_codex_inbound_event,
};
use crate::{
    CodexGoalSet, CodexGuardianDeniedActionApproval, CodexHandoffToAgent, CodexPermissionCatalog,
    CodexSubagentSteer,
};
use ace_core::{ProviderCapability, ProviderKind};
use ace_runtime::provider::{
    ProviderDescriptor, ProviderDriver, ProviderDriverError, ProviderEvent, ProviderFeature,
    ProviderRequest,
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

    #[must_use]
    pub fn is_plan_mode(&self) -> bool {
        self.collaboration_mode
            .as_ref()
            .and_then(|mode| mode.get("mode"))
            .and_then(Value::as_str)
            == Some("plan")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexPlanImplementation {
    pub thread_id: String,
    pub plan: Value,
    pub prompt: String,
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
}

impl CodexPlanImplementation {
    #[must_use]
    pub fn into_turn_start(self, thread_id: String) -> CodexTurnStart {
        CodexTurnStart {
            thread_id,
            input: vec![json!({ "type": "text", "text": self.prompt })],
            model: self.model,
            cwd: self.cwd,
            sandbox_policy: self.sandbox_policy,
            approval_policy: self.approval_policy,
            approvals_reviewer: self.approvals_reviewer,
            collaboration_mode: None,
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

    pub async fn read_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/read", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn list_threads(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/list", params).await
    }

    pub async fn list_loaded_threads(&self) -> Result<Value> {
        self.raw_request("thread/loadedList", json!({})).await
    }

    pub async fn archive_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/archive", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn unarchive_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/unarchive", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn delete_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/delete", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn unsubscribe_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/unsubscribe", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn set_thread_name(&self, thread_id: &str, name: &str) -> Result<Value> {
        self.raw_request(
            "thread/setName",
            json!({
                "threadId": thread_id,
                "name": name,
            }),
        )
        .await
    }

    pub async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value> {
        self.raw_request(
            "thread/updateMetadata",
            json!({
                "threadId": thread_id,
                "metadata": metadata,
            }),
        )
        .await
    }

    pub async fn compact_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/compact", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn rollback_thread(&self, thread_id: &str, turn_id: &str) -> Result<Value> {
        self.raw_request(
            "thread/rollback",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        )
        .await
    }

    pub async fn inject_thread_items(&self, thread_id: &str, items: Vec<Value>) -> Result<Value> {
        self.raw_request(
            "thread/injectItems",
            json!({
                "threadId": thread_id,
                "items": items,
            }),
        )
        .await
    }

    pub async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
        self.raw_request("turn/start", serde_json::to_value(request)?)
            .await
    }

    pub async fn continue_plan_in_thread(&self, request: CodexPlanImplementation) -> Result<Value> {
        let thread_id = request.thread_id.clone();
        self.inject_thread_items(&thread_id, vec![accepted_plan_item(request.plan.clone())])
            .await?;
        let turn = request.into_turn_start(thread_id.clone());
        let turn_response = self.start_turn(turn).await?;
        Ok(json!({
            "threadId": thread_id,
            "turn": turn_response,
            "forked": false,
            "ephemeral": false,
        }))
    }

    pub async fn fork_plan_for_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> Result<Value> {
        self.implement_plan_in_fork(request, false).await
    }

    pub async fn side_implementation(&self, request: CodexPlanImplementation) -> Result<Value> {
        self.implement_plan_in_fork(request, true).await
    }

    async fn implement_plan_in_fork(
        &self,
        request: CodexPlanImplementation,
        ephemeral: bool,
    ) -> Result<Value> {
        let parent_thread_id = request.thread_id.clone();
        let fork_response = self.fork_thread(&parent_thread_id, ephemeral).await?;
        let thread_id = extract_thread_id(&fork_response).ok_or_else(|| {
            CodexError::InvalidMessage(
                "thread/fork response did not include a thread id".to_string(),
            )
        })?;
        self.inject_thread_items(&thread_id, vec![accepted_plan_item(request.plan.clone())])
            .await?;
        let turn = request.into_turn_start(thread_id.clone());
        let turn_response = self.start_turn(turn).await?;
        Ok(json!({
            "threadId": thread_id,
            "parentThreadId": parent_thread_id,
            "fork": fork_response,
            "turn": turn_response,
            "forked": true,
            "ephemeral": ephemeral,
        }))
    }

    pub async fn interrupt_turn(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("turn/interrupt", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn config_requirements_read(&self) -> Result<Value> {
        self.raw_request("configRequirements/read", json!({})).await
    }

    pub async fn permission_profile_list(&self) -> Result<Value> {
        self.raw_request("permissionProfile/list", json!({})).await
    }

    pub async fn permission_catalog(&self) -> Result<CodexPermissionCatalog> {
        let requirements = self.config_requirements_read().await?;
        let profiles = self.permission_profile_list().await?;
        Ok(CodexPermissionCatalog::from_sources(requirements, profiles))
    }

    pub async fn approve_guardian_denied_action(
        &self,
        request: CodexGuardianDeniedActionApproval,
    ) -> Result<Value> {
        self.raw_request(
            "thread/approveGuardianDeniedAction",
            serde_json::to_value(request)?,
        )
        .await
    }

    pub async fn goal_set(&self, request: CodexGoalSet) -> Result<Value> {
        self.raw_request(
            "goal/set",
            json!({
                "threadId": request.thread_id,
                "objective": request.objective,
                "tokenBudget": request.token_budget,
            }),
        )
        .await
    }

    pub async fn goal_get(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("goal/get", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn goal_clear(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("goal/clear", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn goal_pause(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("goal/pause", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn goal_resume(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("goal/resume", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn subagent_list(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("subagent/list", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn subagent_read(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        self.raw_request(
            "subagent/read",
            json!({
                "threadId": thread_id,
                "subagentThreadId": subagent_thread_id,
            }),
        )
        .await
    }

    pub async fn subagent_steer(&self, request: CodexSubagentSteer) -> Result<Value> {
        self.raw_request(
            "subagent/steer",
            json!({
                "threadId": request.thread_id,
                "subagentThreadId": request.subagent_thread_id,
                "prompt": request.prompt,
            }),
        )
        .await
    }

    pub async fn subagent_stop(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        self.raw_request(
            "subagent/stop",
            json!({
                "threadId": thread_id,
                "subagentThreadId": subagent_thread_id,
            }),
        )
        .await
    }

    pub async fn subagent_close(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        self.raw_request(
            "subagent/close",
            json!({
                "threadId": thread_id,
                "subagentThreadId": subagent_thread_id,
            }),
        )
        .await
    }

    pub async fn handoff_to_agent(&self, request: CodexHandoffToAgent) -> Result<Value> {
        self.raw_request("thread/handoffToAgent", serde_json::to_value(request)?)
            .await
    }

    pub async fn review_start(&self, params: Value) -> Result<Value> {
        self.raw_request("review/start", params).await
    }

    pub async fn command_exec(&self, params: Value) -> Result<Value> {
        self.raw_request("command/exec", params).await
    }

    pub async fn command_write_stdin(&self, params: Value) -> Result<Value> {
        self.raw_request("command/writeStdin", params).await
    }

    pub async fn command_resize(&self, params: Value) -> Result<Value> {
        self.raw_request("command/resize", params).await
    }

    pub async fn command_terminate(&self, params: Value) -> Result<Value> {
        self.raw_request("command/terminate", params).await
    }

    pub async fn process_list(&self, params: Value) -> Result<Value> {
        self.raw_request("process/list", params).await
    }

    pub async fn process_clean(&self, params: Value) -> Result<Value> {
        self.raw_request("process/clean", params).await
    }

    pub async fn mcp_status(&self, params: Value) -> Result<Value> {
        self.raw_request("mcp/status", params).await
    }

    pub async fn mcp_resource_read(&self, params: Value) -> Result<Value> {
        self.raw_request("mcp/resourceRead", params).await
    }

    pub async fn mcp_oauth_login(&self, params: Value) -> Result<Value> {
        self.raw_request("mcp/oauthLogin", params).await
    }

    pub async fn mcp_tool_call(&self, params: Value) -> Result<Value> {
        self.raw_request("mcp/toolCall", params).await
    }

    pub async fn skills_list(&self, params: Value) -> Result<Value> {
        self.raw_request("skills/list", params).await
    }

    pub async fn skills_read(&self, params: Value) -> Result<Value> {
        self.raw_request("skills/read", params).await
    }

    pub async fn skills_install(&self, params: Value) -> Result<Value> {
        self.raw_request("skills/install", params).await
    }

    pub async fn plugins_list(&self, params: Value) -> Result<Value> {
        self.raw_request("plugins/list", params).await
    }

    pub async fn plugins_install(&self, params: Value) -> Result<Value> {
        self.raw_request("plugins/install", params).await
    }

    pub async fn apps_list(&self, params: Value) -> Result<Value> {
        self.raw_request("apps/list", params).await
    }

    pub async fn apps_config_write(&self, params: Value) -> Result<Value> {
        self.raw_request("apps/configWrite", params).await
    }

    pub async fn remote_connection_list(&self, params: Value) -> Result<Value> {
        self.raw_request("remote/connectionList", params).await
    }

    pub async fn remote_handoff(&self, params: Value) -> Result<Value> {
        self.raw_request("remote/handoff", params).await
    }

    pub async fn next_provider_events(&self) -> Option<Vec<ProviderEvent>> {
        self.transport
            .recv()
            .await
            .map(|event| normalize_codex_inbound_event(&event))
    }

    pub async fn stderr_tail(&self) -> Vec<String> {
        self.transport.stderr_tail().await
    }

    pub async fn shutdown(&self, timeout: Duration) -> Result<()> {
        self.transport.shutdown(timeout).await
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

#[must_use]
pub fn accepted_plan_item(plan: Value) -> Value {
    json!({
        "type": "plan",
        "status": "accepted",
        "content": plan,
    })
}

fn extract_thread_id(response: &Value) -> Option<String> {
    response
        .pointer("/thread/id")
        .or_else(|| response.pointer("/thread/threadId"))
        .or_else(|| response.get("threadId"))
        .or_else(|| response.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
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
                    key: "codex.compatibility_inventory".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.execution_location.local".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.execution_location.worktree".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.adapter_contract".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.semantic_tools".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.normalized_events".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.normalized_server_requests".to_string(),
                    version: 1,
                },
            ],
        }
    }

    fn features(&self) -> Vec<ProviderFeature> {
        crate::codex_provider_features()
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
    async fn thread_lifecycle_methods_use_typed_codex_app_server_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client.read_thread("thread-1").await.expect("read");
        client
            .list_threads(json!({ "includeArchived": true, "limit": 20 }))
            .await
            .expect("list");
        client.list_loaded_threads().await.expect("loaded");
        client.archive_thread("thread-1").await.expect("archive");
        client
            .unarchive_thread("thread-1")
            .await
            .expect("unarchive");
        client.delete_thread("thread-1").await.expect("delete");
        client
            .unsubscribe_thread("thread-1")
            .await
            .expect("unsubscribe");
        client
            .set_thread_name("thread-1", "Adapter work")
            .await
            .expect("set name");
        client
            .update_thread_metadata("thread-1", json!({ "project": "ace" }))
            .await
            .expect("metadata");
        client.compact_thread("thread-1").await.expect("compact");
        client
            .rollback_thread("thread-1", "turn-2")
            .await
            .expect("rollback");
        client
            .inject_thread_items("thread-1", vec![json!({ "type": "userMessage" })])
            .await
            .expect("inject");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "thread/read",
                "thread/list",
                "thread/loadedList",
                "thread/archive",
                "thread/unarchive",
                "thread/delete",
                "thread/unsubscribe",
                "thread/setName",
                "thread/updateMetadata",
                "thread/compact",
                "thread/rollback",
                "thread/injectItems",
            ]
        );
        assert_eq!(requests[7].1["name"], "Adapter work");
        assert_eq!(requests[8].1["metadata"]["project"], "ace");
        assert_eq!(requests[10].1["turnId"], "turn-2");
        assert_eq!(requests[11].1["items"][0]["type"], "userMessage");
    }

    #[tokio::test]
    async fn continues_plan_by_injecting_accepted_plan_then_starting_turn() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "injected": 1 })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "turn": { "id": "turn-1" } })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        let response = client
            .continue_plan_in_thread(CodexPlanImplementation {
                thread_id: "thread-1".to_string(),
                plan: json!({ "markdown": "Do it carefully" }),
                prompt: "implement the plan".to_string(),
                model: Some("gpt-5.5".to_string()),
                cwd: None,
                sandbox_policy: None,
                approval_policy: None,
                approvals_reviewer: None,
            })
            .await
            .expect("continue plan");

        assert_eq!(response["threadId"], "thread-1");
        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "thread/injectItems");
        assert_eq!(requests[0].1["items"][0]["status"], "accepted");
        assert_eq!(requests[1].0, "turn/start");
        assert_eq!(requests[1].1["thread_id"], "thread-1");
        assert_eq!(requests[1].1["model"], "gpt-5.5");
    }

    #[tokio::test]
    async fn forks_plan_implementation_into_new_or_side_thread() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "thread": { "id": "fork-1" } })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "injected": 1 })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "turn": { "id": "turn-1" } })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        let response = client
            .side_implementation(CodexPlanImplementation {
                thread_id: "thread-1".to_string(),
                plan: json!({ "markdown": "Implement in isolation" }),
                prompt: "build it".to_string(),
                model: None,
                cwd: Some("/tmp/repo".to_string()),
                sandbox_policy: None,
                approval_policy: None,
                approvals_reviewer: None,
            })
            .await
            .expect("side implementation");

        assert_eq!(response["threadId"], "fork-1");
        assert_eq!(response["parentThreadId"], "thread-1");
        assert_eq!(response["ephemeral"], true);
        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "thread/fork");
        assert_eq!(requests[0].1["ephemeral"], true);
        assert_eq!(requests[1].0, "thread/injectItems");
        assert_eq!(requests[1].1["threadId"], "fork-1");
        assert_eq!(requests[2].0, "turn/start");
        assert_eq!(requests[2].1["thread_id"], "fork-1");
        assert_eq!(requests[2].1["cwd"], "/tmp/repo");
    }

    #[tokio::test]
    async fn reads_permission_catalog_and_retries_guardian_denials() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({
                "allowedPermissionPresets": ["strict", "auto_review"]
            })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({
                "profiles": [{ "id": "strict" }, { "id": "auto_review" }]
            })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "approved": true })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        let catalog = client.permission_catalog().await.expect("catalog");
        assert_eq!(catalog.available_presets.len(), 2);
        client
            .approve_guardian_denied_action(CodexGuardianDeniedActionApproval {
                thread_id: "thread-1".to_string(),
                item_id: Some("item-1".to_string()),
                action_id: Some("action-1".to_string()),
                approved: true,
                reason: Some("user approved retry".to_string()),
                audit: json!({ "reviewer": "user" }),
            })
            .await
            .expect("approve denial");

        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "configRequirements/read");
        assert_eq!(requests[1].0, "permissionProfile/list");
        assert_eq!(requests[2].0, "thread/approveGuardianDeniedAction");
        assert_eq!(requests[2].1["threadId"], "thread-1");
        assert_eq!(requests[2].1["approved"], true);
    }

    #[tokio::test]
    async fn goal_methods_use_typed_codex_app_server_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .goal_set(CodexGoalSet {
                thread_id: "thread-1".to_string(),
                objective: "finish the adapter".to_string(),
                token_budget: Some(10_000),
            })
            .await
            .expect("goal set");
        client.goal_get("thread-1").await.expect("goal get");
        client.goal_pause("thread-1").await.expect("goal pause");
        client.goal_resume("thread-1").await.expect("goal resume");
        client.goal_clear("thread-1").await.expect("goal clear");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "goal/set",
                "goal/get",
                "goal/pause",
                "goal/resume",
                "goal/clear"
            ]
        );
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["objective"], "finish the adapter");
        assert_eq!(requests[0].1["tokenBudget"], 10_000);
    }

    #[tokio::test]
    async fn subagent_and_handoff_methods_use_typed_codex_app_server_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client.subagent_list("thread-1").await.expect("list");
        client
            .subagent_read("thread-1", "subagent-1")
            .await
            .expect("read");
        client
            .subagent_steer(CodexSubagentSteer {
                thread_id: "thread-1".to_string(),
                subagent_thread_id: "subagent-1".to_string(),
                prompt: "focus on tests".to_string(),
            })
            .await
            .expect("steer");
        client
            .subagent_stop("thread-1", "subagent-1")
            .await
            .expect("stop");
        client
            .subagent_close("thread-1", "subagent-1")
            .await
            .expect("close");
        client
            .handoff_to_agent(CodexHandoffToAgent {
                thread_id: "thread-1".to_string(),
                prompt: "take over implementation".to_string(),
                agent_role: Some("implementer".to_string()),
                nickname: Some("builder".to_string()),
                model: Some("gpt-5.5".to_string()),
                reasoning_effort: Some("high".to_string()),
                sandbox_policy: Some(json!({ "mode": "workspace-write" })),
                approval_policy: Some(json!({ "mode": "on-request" })),
                approvals_reviewer: Some("user".to_string()),
                skills: vec!["rust".to_string()],
                mcp_config: json!({ "servers": [] }),
            })
            .await
            .expect("handoff");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "subagent/list",
                "subagent/read",
                "subagent/steer",
                "subagent/stop",
                "subagent/close",
                "thread/handoffToAgent",
            ]
        );
        assert_eq!(requests[2].1["prompt"], "focus on tests");
        assert_eq!(requests[5].1["agent_role"], "implementer");
        assert_eq!(requests[5].1["skills"][0], "rust");
    }

    #[tokio::test]
    async fn version_gated_tool_methods_use_documented_codex_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .review_start(json!({ "threadId": "thread-1" }))
            .await
            .expect("review");
        client
            .command_exec(json!({ "command": "cargo test" }))
            .await
            .expect("exec");
        client
            .command_write_stdin(json!({ "processId": "p1", "stdin": "q" }))
            .await
            .expect("stdin");
        client
            .command_resize(json!({ "processId": "p1", "cols": 120, "rows": 40 }))
            .await
            .expect("resize");
        client
            .command_terminate(json!({ "processId": "p1" }))
            .await
            .expect("terminate");
        client.process_list(json!({})).await.expect("process list");
        client
            .process_clean(json!({}))
            .await
            .expect("process clean");
        client.mcp_status(json!({})).await.expect("mcp status");
        client
            .mcp_resource_read(json!({ "server": "docs", "uri": "file://readme" }))
            .await
            .expect("resource");
        client
            .mcp_oauth_login(json!({ "server": "github" }))
            .await
            .expect("oauth");
        client
            .mcp_tool_call(json!({ "server": "github", "tool": "list_issues" }))
            .await
            .expect("tool call");
        client.skills_list(json!({})).await.expect("skills list");
        client
            .skills_read(json!({ "skill": "rust" }))
            .await
            .expect("skills read");
        client
            .skills_install(json!({ "skill": "rust" }))
            .await
            .expect("skills install");
        client.plugins_list(json!({})).await.expect("plugins list");
        client
            .plugins_install(json!({ "plugin": "browser" }))
            .await
            .expect("plugins install");
        client.apps_list(json!({})).await.expect("apps list");
        client
            .apps_config_write(json!({ "app": "browser", "config": {} }))
            .await
            .expect("apps config");
        client
            .remote_connection_list(json!({}))
            .await
            .expect("remote list");
        client
            .remote_handoff(json!({ "threadId": "thread-1", "host": "devbox" }))
            .await
            .expect("remote handoff");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "review/start",
                "command/exec",
                "command/writeStdin",
                "command/resize",
                "command/terminate",
                "process/list",
                "process/clean",
                "mcp/status",
                "mcp/resourceRead",
                "mcp/oauthLogin",
                "mcp/toolCall",
                "skills/list",
                "skills/read",
                "skills/install",
                "plugins/list",
                "plugins/install",
                "apps/list",
                "apps/configWrite",
                "remote/connectionList",
                "remote/handoff",
            ]
        );
        assert_eq!(requests[1].1["command"], "cargo test");
        assert_eq!(requests[10].1["tool"], "list_issues");
        assert_eq!(requests[19].1["host"], "devbox");
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
                .any(|capability| capability.key == "provider.adapter_contract")
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
                .any(|capability| capability.key == "codex.compatibility_inventory")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "codex.execution_location.local")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "codex.execution_location.worktree")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .all(|capability| capability.key != "codex.execution_location.cloud")
        );
    }
}
