use ace_codex::{
    CodexConfig, CodexGoalSet, CodexGuardianDeniedActionApproval, CodexHandoffToAgent,
    CodexLiveClient, CodexMethodDirection, CodexMethodSupport, CodexPermissionCatalog,
    CodexPermissionPreset, CodexPlanImplementation, CodexSubagentSteer, CodexThreadStart,
    CodexTransportConfig, CodexTurnPermissions, CodexTurnStart, CodexTurnSteer, Result,
    classify_codex_method,
};
use ace_core::{ProviderCapability, ProviderKind};
use ace_protocol::codex::CodexRemoteHandoffRequest;
use ace_runtime::{
    provider::{
        ProviderDescriptor, ProviderDriver, ProviderDriverError, ProviderDriverStatus,
        ProviderEvent, ProviderEventSource, ProviderFeature, ProviderLifecycleAction,
        ProviderLifecycleResult, ProviderRequest, ProviderRuntimeHealth,
        ProviderServerRequestResponder, ProviderStateSource,
    },
    threads::{
        AgentRuntimeSnapshot, AgentRuntimeState, AgentThread, ApprovalRetryRecord,
        ExecutionLocation, ForkPoint, HandoffPlan, HandoffStatus, PlanImplementationMode,
        PlanImplementationRecord, PlanSessionStatus, RemoteConnectionRecord, RuntimeStateError,
        SideChat, SubagentActionKind, SubagentActionRecord, ThreadLifecycleActionKind,
        ThreadLifecycleRecord, TurnMode,
    },
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use thiserror::Error;
use tokio::sync::Mutex;

#[derive(Debug, Error)]
pub enum CodexApiError {
    #[error(transparent)]
    Codex(#[from] ace_codex::CodexError),
    #[error("unsupported provider `{0}` for Codex-backed provider runtime request")]
    UnsupportedProvider(String),
    #[error("thread `{thread_id}` already has an active turn")]
    TurnAlreadyActive { thread_id: String },
    #[error("cannot create a side chat from side chat `{thread_id}`")]
    NestedSideChat { thread_id: String },
    #[error("cannot create a side chat while thread `{thread_id}` is in review mode")]
    ReviewModeSideChat { thread_id: String },
    #[error("Codex response did not include a thread id")]
    MissingThreadId,
    #[error("unsupported execution location `{0}` for this handoff")]
    UnsupportedExecutionLocation(String),
    #[error("Codex method `{0}` is intentionally deferred")]
    DeferredMethod(String),
    #[error("unknown Codex client request method `{0}`")]
    UnknownClientMethod(String),
    #[error("Codex permission preset `{preset}` is unavailable: {reason}")]
    PermissionPresetUnavailable { preset: String, reason: String },
}

impl CodexApiError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Codex(ace_codex::CodexError::MissingBinary(_)) => "codex_missing",
            Self::Codex(ace_codex::CodexError::RequestTimeout { .. }) => "codex_timeout",
            Self::Codex(ace_codex::CodexError::RequestFailed { .. }) => "codex_request_failed",
            Self::Codex(_) => "codex_error",
            Self::UnsupportedProvider(_) => "unsupported_provider",
            Self::TurnAlreadyActive { .. } => "turn_already_active",
            Self::NestedSideChat { .. } => "nested_side_chat",
            Self::ReviewModeSideChat { .. } => "review_mode_side_chat",
            Self::MissingThreadId => "missing_thread_id",
            Self::UnsupportedExecutionLocation(_) => "unsupported_execution_location",
            Self::DeferredMethod(_) => "codex_deferred_method",
            Self::UnknownClientMethod(_) => "codex_unknown_client_method",
            Self::PermissionPresetUnavailable { .. } => "codex_permission_preset_unavailable",
        }
    }
}

impl From<RuntimeStateError> for CodexApiError {
    fn from(error: RuntimeStateError) -> Self {
        match error {
            RuntimeStateError::TurnAlreadyActive { thread_id } => {
                Self::TurnAlreadyActive { thread_id }
            }
        }
    }
}

fn validate_codex_client_request_method(method: &str) -> std::result::Result<(), CodexApiError> {
    match classify_codex_method(method, CodexMethodDirection::ClientRequest) {
        Some(CodexMethodSupport::IntentionallyDeferred) => {
            Err(CodexApiError::DeferredMethod(method.to_string()))
        }
        Some(
            CodexMethodSupport::TypedSupported
            | CodexMethodSupport::RawSupported
            | CodexMethodSupport::VersionGated,
        ) => Ok(()),
        None => Err(CodexApiError::UnknownClientMethod(method.to_string())),
    }
}

fn summarize_initialize_result(result: Value) -> Value {
    let Some(object) = result.as_object() else {
        return json!({ "payload_type": value_type_name(&result) });
    };

    let mut summary = serde_json::Map::new();
    for key in [
        "serverInfo",
        "serverVersion",
        "version",
        "protocolVersion",
        "capabilities",
        "experimentalApi",
    ] {
        if let Some(value) = object.get(key) {
            summary.insert(key.to_string(), value.clone());
        }
    }
    summary.insert("top_level_keys".to_string(), json!(object.len()));
    Value::Object(summary)
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[async_trait]
pub trait CodexBackend: Send + Sync {
    async fn status(&self) -> ProviderDriverStatus;
    async fn start(&self) -> Result<()>;
    async fn raw_request(&self, method: &str, params: Value) -> Result<Value>;
    async fn start_thread(&self, request: CodexThreadStart) -> Result<Value>;
    async fn resume_thread(&self, thread_id: &str) -> Result<Value>;
    async fn fork_thread(&self, thread_id: &str, ephemeral: bool) -> Result<Value>;
    async fn read_thread(&self, thread_id: &str) -> Result<Value>;
    async fn list_threads(&self, params: Value) -> Result<Value>;
    async fn list_loaded_threads(&self) -> Result<Value>;
    async fn archive_thread(&self, thread_id: &str) -> Result<Value>;
    async fn unarchive_thread(&self, thread_id: &str) -> Result<Value>;
    async fn delete_thread(&self, thread_id: &str) -> Result<Value>;
    async fn unsubscribe_thread(&self, thread_id: &str) -> Result<Value>;
    async fn set_thread_name(&self, thread_id: &str, name: &str) -> Result<Value>;
    async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value>;
    async fn compact_thread(&self, thread_id: &str) -> Result<Value>;
    async fn rollback_thread(&self, thread_id: &str, turn_id: &str) -> Result<Value>;
    async fn inject_thread_items(&self, thread_id: &str, items: Vec<Value>) -> Result<Value>;
    async fn start_turn(&self, request: CodexTurnStart) -> Result<Value>;
    async fn steer_turn(&self, request: CodexTurnSteer) -> Result<Value>;
    async fn continue_plan_in_thread(&self, request: CodexPlanImplementation) -> Result<Value>;
    async fn fork_plan_for_implementation(&self, request: CodexPlanImplementation)
    -> Result<Value>;
    async fn side_implementation(&self, request: CodexPlanImplementation) -> Result<Value>;
    async fn interrupt_turn(&self, thread_id: &str) -> Result<Value>;
    async fn config_requirements_read(&self) -> Result<Value>;
    async fn permission_profile_list(&self) -> Result<Value>;
    async fn permission_catalog(&self) -> Result<CodexPermissionCatalog>;
    async fn approve_guardian_denied_action(
        &self,
        request: CodexGuardianDeniedActionApproval,
    ) -> Result<Value>;
    async fn goal_set(&self, request: CodexGoalSet) -> Result<Value>;
    async fn goal_get(&self, thread_id: &str) -> Result<Value>;
    async fn goal_clear(&self, thread_id: &str) -> Result<Value>;
    async fn goal_pause(&self, thread_id: &str) -> Result<Value>;
    async fn goal_resume(&self, thread_id: &str) -> Result<Value>;
    async fn subagent_list(&self, thread_id: &str) -> Result<Value>;
    async fn subagent_read(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value>;
    async fn subagent_steer(&self, request: CodexSubagentSteer) -> Result<Value>;
    async fn subagent_stop(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value>;
    async fn subagent_close(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value>;
    async fn handoff_to_agent(&self, request: CodexHandoffToAgent) -> Result<Value>;
    async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>>;
    async fn respond_server_request_result(&self, request_id: i64, result: Value) -> Result<()>;
    async fn respond_server_request_error(
        &self,
        request_id: i64,
        code: i64,
        message: &str,
    ) -> Result<()>;
    async fn stderr_tail(&self) -> Result<Vec<String>>;
    async fn shutdown(&self, timeout: Duration) -> Result<()>;
    async fn restart(&self, timeout: Duration) -> Result<()>;
}

pub type DynCodexBackend = Arc<dyn CodexBackend>;

pub struct LiveCodexBackend {
    config: CodexConfig,
    client: Mutex<Option<CodexLiveClient>>,
    last_error: Mutex<Option<String>>,
}

impl LiveCodexBackend {
    #[must_use]
    pub fn production() -> Self {
        Self::with_config(CodexConfig::default())
    }

    #[must_use]
    pub fn with_config(config: CodexConfig) -> Self {
        Self {
            config,
            client: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }

    async fn client(&self) -> Result<CodexLiveClient> {
        let mut guard = self.client.lock().await;
        if let Some(client) = guard.as_ref()
            && !client.is_closed()
        {
            return Ok(client.clone());
        }
        if guard.as_ref().is_some_and(CodexLiveClient::is_closed) {
            *guard = None;
            *self.last_error.lock().await =
                Some("codex app-server transport closed; respawning on demand".to_string());
        }
        let client = match CodexLiveClient::connect(self.config.clone()).await {
            Ok(client) => client,
            Err(error) => {
                *self.last_error.lock().await = Some(error.to_string());
                return Err(error);
            }
        };
        *self.last_error.lock().await = None;
        *guard = Some(client.clone());
        Ok(client)
    }
}

fn transport_config_metadata(config: &CodexTransportConfig) -> Value {
    match config {
        CodexTransportConfig::Stdio { command, args } => {
            json!({
                "command": command,
                "args": args,
            })
        }
        CodexTransportConfig::UnixSocket { path } => {
            json!({
                "path": path,
            })
        }
        CodexTransportConfig::WebSocket { url } => {
            json!({
                "url": url,
            })
        }
    }
}

#[async_trait]
impl CodexBackend for LiveCodexBackend {
    async fn status(&self) -> ProviderDriverStatus {
        let (has_client, client_closed, client_initialized, initialize_result) = {
            let guard = self.client.lock().await;
            let client = guard.as_ref();
            let client_closed = client.is_some_and(CodexLiveClient::is_closed);
            let client_initialized = client.is_some_and(CodexLiveClient::is_initialized);
            let initialize_result = client.and_then(CodexLiveClient::initialize_result);
            (
                guard.is_some(),
                client_closed,
                client_initialized,
                initialize_result,
            )
        };
        let initialized = has_client && client_initialized && !client_closed;
        let last_error = self.last_error.lock().await.clone();
        ProviderDriverStatus {
            health: match (initialized, client_closed, last_error.is_some()) {
                (true, _, _) => ProviderRuntimeHealth::Running,
                (false, false, false) if has_client => ProviderRuntimeHealth::Degraded,
                (false, true, _) => ProviderRuntimeHealth::Degraded,
                (false, false, true) => ProviderRuntimeHealth::Unavailable,
                (false, false, false) => ProviderRuntimeHealth::Stopped,
            },
            transport: Some(self.config.transport.name().to_string()),
            version: None,
            initialized,
            last_error: last_error
                .or_else(|| client_closed.then(|| "codex app-server transport closed".to_string())),
            metadata: json!({
                "transport": self.config.transport.name(),
                "transport_config": transport_config_metadata(&self.config.transport),
                "request_timeout_ms": self.config.request_timeout.as_millis() as u64,
                "experimental_api": true,
                "spawns_on_first_request": true,
                "transport_closed": client_closed,
                "handshake_initialized": client_initialized,
                "initialize": initialize_result.map(summarize_initialize_result)
            }),
        }
    }

    async fn raw_request(&self, method: &str, params: Value) -> Result<Value> {
        self.client().await?.raw_request(method, params).await
    }

    async fn start(&self) -> Result<()> {
        let _ = self.client().await?;
        Ok(())
    }

    async fn start_thread(&self, request: CodexThreadStart) -> Result<Value> {
        self.client().await?.start_thread(request).await
    }

    async fn resume_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.resume_thread(thread_id).await
    }

    async fn fork_thread(&self, thread_id: &str, ephemeral: bool) -> Result<Value> {
        self.client().await?.fork_thread(thread_id, ephemeral).await
    }

    async fn read_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.read_thread(thread_id).await
    }

    async fn list_threads(&self, params: Value) -> Result<Value> {
        self.client().await?.list_threads(params).await
    }

    async fn list_loaded_threads(&self) -> Result<Value> {
        self.client().await?.list_loaded_threads().await
    }

    async fn archive_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.archive_thread(thread_id).await
    }

    async fn unarchive_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.unarchive_thread(thread_id).await
    }

    async fn delete_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.delete_thread(thread_id).await
    }

    async fn unsubscribe_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.unsubscribe_thread(thread_id).await
    }

    async fn set_thread_name(&self, thread_id: &str, name: &str) -> Result<Value> {
        self.client().await?.set_thread_name(thread_id, name).await
    }

    async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value> {
        self.client()
            .await?
            .update_thread_metadata(thread_id, metadata)
            .await
    }

    async fn compact_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.compact_thread(thread_id).await
    }

    async fn rollback_thread(&self, thread_id: &str, turn_id: &str) -> Result<Value> {
        self.client()
            .await?
            .rollback_thread(thread_id, turn_id)
            .await
    }

    async fn inject_thread_items(&self, thread_id: &str, items: Vec<Value>) -> Result<Value> {
        self.client()
            .await?
            .inject_thread_items(thread_id, items)
            .await
    }

    async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
        self.client().await?.start_turn(request).await
    }

    async fn steer_turn(&self, request: CodexTurnSteer) -> Result<Value> {
        self.client().await?.steer_turn(request).await
    }

    async fn continue_plan_in_thread(&self, request: CodexPlanImplementation) -> Result<Value> {
        self.client().await?.continue_plan_in_thread(request).await
    }

    async fn fork_plan_for_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> Result<Value> {
        self.client()
            .await?
            .fork_plan_for_implementation(request)
            .await
    }

    async fn side_implementation(&self, request: CodexPlanImplementation) -> Result<Value> {
        self.client().await?.side_implementation(request).await
    }

    async fn interrupt_turn(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.interrupt_turn(thread_id).await
    }

    async fn config_requirements_read(&self) -> Result<Value> {
        self.client().await?.config_requirements_read().await
    }

    async fn permission_profile_list(&self) -> Result<Value> {
        self.client().await?.permission_profile_list().await
    }

    async fn permission_catalog(&self) -> Result<CodexPermissionCatalog> {
        self.client().await?.permission_catalog().await
    }

    async fn approve_guardian_denied_action(
        &self,
        request: CodexGuardianDeniedActionApproval,
    ) -> Result<Value> {
        self.client()
            .await?
            .approve_guardian_denied_action(request)
            .await
    }

    async fn goal_set(&self, request: CodexGoalSet) -> Result<Value> {
        self.client().await?.goal_set(request).await
    }

    async fn goal_get(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.goal_get(thread_id).await
    }

    async fn goal_clear(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.goal_clear(thread_id).await
    }

    async fn goal_pause(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.goal_pause(thread_id).await
    }

    async fn goal_resume(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.goal_resume(thread_id).await
    }

    async fn subagent_list(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.subagent_list(thread_id).await
    }

    async fn subagent_read(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        self.client()
            .await?
            .subagent_read(thread_id, subagent_thread_id)
            .await
    }

    async fn subagent_steer(&self, request: CodexSubagentSteer) -> Result<Value> {
        self.client().await?.subagent_steer(request).await
    }

    async fn subagent_stop(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        self.client()
            .await?
            .subagent_stop(thread_id, subagent_thread_id)
            .await
    }

    async fn subagent_close(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        self.client()
            .await?
            .subagent_close(thread_id, subagent_thread_id)
            .await
    }

    async fn handoff_to_agent(&self, request: CodexHandoffToAgent) -> Result<Value> {
        self.client().await?.handoff_to_agent(request).await
    }

    async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>> {
        Ok(self.client().await?.next_provider_events().await)
    }

    async fn respond_server_request_result(&self, request_id: i64, result: Value) -> Result<()> {
        self.client()
            .await?
            .respond_tool_result(request_id, result)
            .await
    }

    async fn respond_server_request_error(
        &self,
        request_id: i64,
        code: i64,
        message: &str,
    ) -> Result<()> {
        self.client()
            .await?
            .respond_tool_error(request_id, code, message)
            .await
    }

    async fn stderr_tail(&self) -> Result<Vec<String>> {
        Ok(self.client().await?.stderr_tail().await)
    }

    async fn shutdown(&self, timeout: Duration) -> Result<()> {
        let client = self.client.lock().await.take();
        if let Some(client) = client {
            client.shutdown(timeout).await?;
        }
        Ok(())
    }

    async fn restart(&self, timeout: Duration) -> Result<()> {
        self.shutdown(timeout).await?;
        let _ = self.client().await?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct CodexService {
    backend: DynCodexBackend,
    state: Arc<Mutex<AgentRuntimeState>>,
}

impl CodexService {
    #[must_use]
    pub fn production() -> Self {
        Self {
            backend: Arc::new(LiveCodexBackend::production()),
            state: Arc::new(Mutex::new(AgentRuntimeState::default())),
        }
    }

    #[must_use]
    pub fn new(backend: DynCodexBackend) -> Self {
        Self {
            backend,
            state: Arc::new(Mutex::new(AgentRuntimeState::default())),
        }
    }

    pub async fn raw_request(
        &self,
        method: String,
        params: Value,
    ) -> std::result::Result<Value, CodexApiError> {
        validate_codex_client_request_method(&method)?;
        Ok(self.backend.raw_request(&method, params).await?)
    }

    pub async fn start_thread(
        &self,
        request: CodexThreadStart,
    ) -> std::result::Result<Value, CodexApiError> {
        let request_value = serde_json::to_value(&request).unwrap_or(Value::Null);
        let response = self.backend.start_thread(request).await?;
        let thread_id = extract_thread_id(&response).ok_or(CodexApiError::MissingThreadId)?;
        self.record_thread_lifecycle(thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::Start,
            request_value,
            response.clone(),
        ))
        .await;
        Ok(response)
    }

    pub async fn resume_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.resume_thread(&thread_id).await?;
        self.record_thread_lifecycle(thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::Resume,
            Value::Null,
            response.clone(),
        ))
        .await;
        Ok(response)
    }

    pub async fn fork_thread(
        &self,
        thread_id: String,
        ephemeral: bool,
        turn_id: Option<String>,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.fork_thread(&thread_id, ephemeral).await?;
        let child_thread_id = extract_thread_id(&response).ok_or(CodexApiError::MissingThreadId)?;
        if let Some(turn_id) = turn_id.as_deref() {
            self.backend
                .rollback_thread(&child_thread_id, turn_id)
                .await?;
        }
        self.state.lock().await.record_fork(ForkPoint {
            parent_thread_id: thread_id,
            child_thread_id,
            turn_id,
        });
        Ok(response)
    }

    pub async fn start_side_chat(
        &self,
        thread_id: String,
        turn_id: Option<String>,
    ) -> std::result::Result<Value, CodexApiError> {
        {
            let state = self.state.lock().await;
            if state.side_chat(&thread_id).is_some() {
                return Err(CodexApiError::NestedSideChat { thread_id });
            }
            if state.is_reviewing(&thread_id) {
                return Err(CodexApiError::ReviewModeSideChat { thread_id });
            }
        }

        let response = self
            .fork_thread(thread_id.clone(), true, turn_id.clone())
            .await?;
        let child_thread_id = extract_thread_id(&response).ok_or(CodexApiError::MissingThreadId)?;
        self.state.lock().await.record_side_chat(SideChat {
            parent_thread_id: thread_id,
            thread_id: child_thread_id,
            ephemeral: true,
        });
        Ok(response)
    }

    pub async fn read_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.read_thread(&thread_id).await?;
        self.record_threads_from_response(&response, Some(&thread_id))
            .await;
        Ok(response)
    }

    pub async fn list_threads(&self, params: Value) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.list_threads(params).await?;
        self.record_threads_from_response(&response, None).await;
        Ok(response)
    }

    pub async fn list_loaded_threads(&self) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.list_loaded_threads().await?;
        self.record_threads_from_response(&response, None).await;
        Ok(response)
    }

    pub async fn archive_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.archive_thread(&thread_id).await?;
        self.record_thread_lifecycle(thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::Archive,
            Value::Null,
            response.clone(),
        ))
        .await;
        Ok(response)
    }

    pub async fn unarchive_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.unarchive_thread(&thread_id).await?;
        self.record_thread_lifecycle(thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::Unarchive,
            Value::Null,
            response.clone(),
        ))
        .await;
        Ok(response)
    }

    pub async fn delete_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.delete_thread(&thread_id).await?;
        self.record_thread_lifecycle(thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::Delete,
            Value::Null,
            response.clone(),
        ))
        .await;
        Ok(response)
    }

    pub async fn unsubscribe_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.unsubscribe_thread(&thread_id).await?;
        self.record_thread_lifecycle(thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::Unsubscribe,
            Value::Null,
            response.clone(),
        ))
        .await;
        Ok(response)
    }

    pub async fn set_thread_name(
        &self,
        thread_id: String,
        name: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.set_thread_name(&thread_id, &name).await?;
        let mut record = thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::SetName,
            json!({ "name": name }),
            response.clone(),
        );
        record.name = record
            .request
            .get("name")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        self.record_thread_lifecycle(record).await;
        Ok(response)
    }

    pub async fn update_thread_metadata(
        &self,
        thread_id: String,
        metadata: Value,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self
            .backend
            .update_thread_metadata(&thread_id, metadata.clone())
            .await?;
        self.record_thread_lifecycle(thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::UpdateMetadata,
            json!({ "metadata": metadata }),
            response.clone(),
        ))
        .await;
        Ok(response)
    }

    pub async fn compact_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.compact_thread(&thread_id).await?;
        self.record_thread_lifecycle(thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::Compact,
            Value::Null,
            response.clone(),
        ))
        .await;
        Ok(response)
    }

    pub async fn rollback_thread(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.rollback_thread(&thread_id, &turn_id).await?;
        let mut record = thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::Rollback,
            json!({ "turn_id": turn_id }),
            response.clone(),
        );
        record.turn_id = record
            .request
            .get("turn_id")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        self.record_thread_lifecycle(record).await;
        Ok(response)
    }

    pub async fn inject_thread_items(
        &self,
        thread_id: String,
        items: Vec<Value>,
    ) -> std::result::Result<Value, CodexApiError> {
        let item_count = items.len();
        let response = self
            .backend
            .inject_thread_items(&thread_id, items.clone())
            .await?;
        let mut record = thread_lifecycle_record(
            thread_id,
            ThreadLifecycleActionKind::InjectItems,
            json!({ "items": items }),
            response.clone(),
        );
        record.item_count = Some(item_count);
        self.record_thread_lifecycle(record).await;
        Ok(response)
    }

    pub async fn start_turn(
        &self,
        request: CodexTurnStart,
    ) -> std::result::Result<Value, CodexApiError> {
        let thread_id = request.thread_id.clone();
        let mode = if request.is_plan_mode() {
            TurnMode::Plan
        } else {
            TurnMode::Normal
        };
        self.state
            .lock()
            .await
            .begin_turn(thread_id.clone(), None, mode)?;
        match self.backend.start_turn(request).await {
            Ok(response) => {
                let turn_id = extract_turn_id(&response);
                self.state.lock().await.update_turn_id(&thread_id, turn_id);
                Ok(response)
            }
            Err(error) => {
                self.state.lock().await.abandon_active_turn(&thread_id);
                Err(error.into())
            }
        }
    }

    pub async fn steer_turn(
        &self,
        request: CodexTurnSteer,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.steer_turn(request).await?)
    }

    pub async fn continue_plan_in_thread(
        &self,
        request: CodexPlanImplementation,
    ) -> std::result::Result<Value, CodexApiError> {
        let thread_id = request.thread_id.clone();
        let record = plan_implementation_record(
            &request,
            thread_id.clone(),
            PlanImplementationMode::ContinueInThread,
            Value::Null,
        );
        let response = self.backend.continue_plan_in_thread(request).await?;
        let mut record = record;
        record.provider_response = response.clone();
        let mut state = self.state.lock().await;
        state.mark_plan_implementing(&thread_id);
        state.record_plan_implementation(record);
        Ok(response)
    }

    pub async fn fork_plan_for_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> std::result::Result<Value, CodexApiError> {
        let parent_thread_id = request.thread_id.clone();
        let response = self
            .backend
            .fork_plan_for_implementation(request.clone())
            .await?;
        if let Some(child_thread_id) = extract_thread_id(&response) {
            let mut state = self.state.lock().await;
            state.record_fork(ForkPoint {
                parent_thread_id,
                child_thread_id: child_thread_id.clone(),
                turn_id: None,
            });
            state.record_plan_implementation(plan_implementation_record(
                &request,
                child_thread_id,
                PlanImplementationMode::ForkForImplementation,
                response.clone(),
            ));
        }
        Ok(response)
    }

    pub async fn side_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> std::result::Result<Value, CodexApiError> {
        let parent_thread_id = request.thread_id.clone();
        let response = self.backend.side_implementation(request.clone()).await?;
        if let Some(child_thread_id) = extract_thread_id(&response) {
            let mut state = self.state.lock().await;
            state.record_fork(ForkPoint {
                parent_thread_id: parent_thread_id.clone(),
                child_thread_id: child_thread_id.clone(),
                turn_id: None,
            });
            state.record_side_chat(SideChat {
                parent_thread_id,
                thread_id: child_thread_id.clone(),
                ephemeral: true,
            });
            state.record_plan_implementation(plan_implementation_record(
                &request,
                child_thread_id,
                PlanImplementationMode::SideImplementation,
                response.clone(),
            ));
        }
        Ok(response)
    }

    pub async fn interrupt_turn(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.interrupt_turn(&thread_id).await?;
        self.state
            .lock()
            .await
            .finish_active_turn(&thread_id, PlanSessionStatus::Rejected);
        Ok(response)
    }

    pub async fn review_start(
        &self,
        thread_id: String,
        params: Value,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.raw_request("review/start", params).await?;
        self.state.lock().await.set_review_mode(&thread_id, true);
        Ok(response)
    }

    pub async fn remote_connection_list(
        &self,
        params: Value,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self
            .backend
            .raw_request("remote/connectionList", params)
            .await?;
        let connections = remote_connections_from_codex_response(&response);
        self.state
            .lock()
            .await
            .replace_remote_connections(ProviderKind::Codex.runtime_id(), connections);
        Ok(response)
    }

    pub async fn remote_handoff(
        &self,
        request: CodexRemoteHandoffRequest,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self
            .backend
            .raw_request(
                "remote/handoff",
                serde_json::to_value(&request).unwrap_or(Value::Null),
            )
            .await?;
        self.state
            .lock()
            .await
            .record_handoff(remote_handoff_plan(&request, &response));
        Ok(response)
    }

    pub async fn has_active_turn(&self, thread_id: &str) -> bool {
        self.state.lock().await.active_turn(thread_id).is_some()
    }

    pub async fn runtime_state_snapshot(&self) -> AgentRuntimeSnapshot {
        self.state.lock().await.snapshot()
    }

    async fn record_thread_lifecycle(&self, record: ThreadLifecycleRecord) {
        self.state.lock().await.record_thread_lifecycle(record);
    }

    async fn record_threads_from_response(
        &self,
        response: &Value,
        fallback_thread_id: Option<&str>,
    ) {
        let threads = agent_threads_from_codex_response(response, fallback_thread_id);
        if !threads.is_empty() {
            self.state.lock().await.upsert_threads(threads);
        }
    }

    async fn record_subagent_action(&self, record: SubagentActionRecord) {
        self.state.lock().await.record_subagent_action(record);
    }

    pub async fn config_requirements_read(&self) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.config_requirements_read().await?)
    }

    pub async fn permission_profile_list(&self) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.permission_profile_list().await?)
    }

    pub async fn permission_catalog(
        &self,
    ) -> std::result::Result<CodexPermissionCatalog, CodexApiError> {
        Ok(self.backend.permission_catalog().await?)
    }

    pub async fn resolve_permission_preset(
        &self,
        preset: CodexPermissionPreset,
    ) -> std::result::Result<CodexTurnPermissions, CodexApiError> {
        let catalog = self.permission_catalog().await?;
        if let Some(entry) = catalog.preset_entry(preset)
            && entry.available
        {
            return Ok(entry.permissions.clone());
        }
        let reason = catalog
            .preset_entry(preset)
            .and_then(|entry| entry.unavailable_reason.clone())
            .unwrap_or_else(|| "missing_permission_catalog_entry".to_string());
        Err(CodexApiError::PermissionPresetUnavailable {
            preset: preset.as_key().to_string(),
            reason,
        })
    }

    pub async fn approve_guardian_denied_action(
        &self,
        request: CodexGuardianDeniedActionApproval,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self
            .backend
            .approve_guardian_denied_action(request.clone())
            .await?;
        self.state
            .lock()
            .await
            .record_approval_retry(ApprovalRetryRecord {
                thread_id: request.thread_id,
                item_id: request.item_id,
                action_id: request.action_id,
                approved: request.approved,
                reason: request.reason,
                audit: request.audit,
                provider_response: response.clone(),
            });
        Ok(response)
    }

    pub async fn goal_set(
        &self,
        request: CodexGoalSet,
    ) -> std::result::Result<Value, CodexApiError> {
        let thread_id = request.thread_id.clone();
        let objective = request.objective.clone();
        let token_budget = request.token_budget;
        let response = self.backend.goal_set(request).await?;
        self.state
            .lock()
            .await
            .set_goal(thread_id, objective, token_budget);
        Ok(response)
    }

    pub async fn goal_get(&self, thread_id: String) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.goal_get(&thread_id).await?)
    }

    pub async fn goal_clear(&self, thread_id: String) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.goal_clear(&thread_id).await?;
        self.state.lock().await.clear_goal(&thread_id);
        Ok(response)
    }

    pub async fn goal_pause(&self, thread_id: String) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.goal_pause(&thread_id).await?;
        self.state.lock().await.pause_goal(&thread_id);
        Ok(response)
    }

    pub async fn goal_resume(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self.backend.goal_resume(&thread_id).await?;
        self.state.lock().await.resume_goal(&thread_id);
        Ok(response)
    }

    pub async fn subagent_list(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.subagent_list(&thread_id).await?)
    }

    pub async fn subagent_read(
        &self,
        thread_id: String,
        subagent_thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self
            .backend
            .subagent_read(&thread_id, &subagent_thread_id)
            .await?)
    }

    pub async fn subagent_steer(
        &self,
        request: CodexSubagentSteer,
    ) -> std::result::Result<Value, CodexApiError> {
        let parent_thread_id = request.thread_id.clone();
        let subagent_thread_id = request.subagent_thread_id.clone();
        let prompt = request.prompt.clone();
        let response = self.backend.subagent_steer(request).await?;
        self.record_subagent_action(SubagentActionRecord {
            parent_thread_id,
            subagent_thread_id,
            action: SubagentActionKind::Steer,
            prompt: Some(prompt),
            provider_response: response.clone(),
        })
        .await;
        Ok(response)
    }

    pub async fn subagent_stop(
        &self,
        thread_id: String,
        subagent_thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self
            .backend
            .subagent_stop(&thread_id, &subagent_thread_id)
            .await?;
        self.record_subagent_action(SubagentActionRecord {
            parent_thread_id: thread_id,
            subagent_thread_id,
            action: SubagentActionKind::Stop,
            prompt: None,
            provider_response: response.clone(),
        })
        .await;
        Ok(response)
    }

    pub async fn subagent_close(
        &self,
        thread_id: String,
        subagent_thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        let response = self
            .backend
            .subagent_close(&thread_id, &subagent_thread_id)
            .await?;
        let mut state = self.state.lock().await;
        state.record_subagent_action(SubagentActionRecord {
            parent_thread_id: thread_id,
            subagent_thread_id: subagent_thread_id.clone(),
            action: SubagentActionKind::Close,
            prompt: None,
            provider_response: response.clone(),
        });
        state.close_subagent(&subagent_thread_id);
        Ok(response)
    }

    pub async fn handoff_to_agent(
        &self,
        request: CodexHandoffToAgent,
    ) -> std::result::Result<Value, CodexApiError> {
        let source_thread_id = request.thread_id.clone();
        let response = self.backend.handoff_to_agent(request).await?;
        self.state.lock().await.record_handoff(HandoffPlan {
            source_thread_id,
            target_location: ExecutionLocation::Local,
            status: HandoffStatus::Completed,
            target_thread_id: extract_thread_id(&response),
            repo_root: None,
            worktree_path: None,
            branch: None,
            start_point: None,
            checkpoint_ref: None,
            remote_host: None,
            transfer_status: Some("completed".to_string()),
            interrupted_active_turn: None,
            metadata: response.clone(),
        });
        Ok(response)
    }

    pub async fn record_handoff_to_location(&self, handoff: HandoffPlan) {
        self.state.lock().await.record_handoff(handoff);
    }

    pub async fn next_events(
        &self,
    ) -> std::result::Result<Option<Vec<ProviderEvent>>, CodexApiError> {
        let events = self.backend.next_events().await?;
        if let Some(events) = events.as_ref() {
            self.state.lock().await.apply_provider_events(events);
        }
        Ok(events)
    }

    pub async fn respond_server_request_result(
        &self,
        request_id: i64,
        result: Value,
    ) -> std::result::Result<(), CodexApiError> {
        Ok(self
            .backend
            .respond_server_request_result(request_id, result)
            .await?)
    }

    pub async fn respond_server_request_error(
        &self,
        request_id: i64,
        code: i64,
        message: String,
    ) -> std::result::Result<(), CodexApiError> {
        Ok(self
            .backend
            .respond_server_request_error(request_id, code, &message)
            .await?)
    }

    pub async fn stderr_tail(&self) -> std::result::Result<Vec<String>, CodexApiError> {
        Ok(self.backend.stderr_tail().await?)
    }

    pub async fn shutdown(&self, timeout: Duration) -> std::result::Result<(), CodexApiError> {
        Ok(self.backend.shutdown(timeout).await?)
    }

    pub async fn restart(&self, timeout: Duration) -> std::result::Result<(), CodexApiError> {
        Ok(self.backend.restart(timeout).await?)
    }
}

#[async_trait]
impl ProviderDriver for CodexService {
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
                ProviderCapability {
                    key: "provider.runtime.raw_request".to_string(),
                    version: 1,
                },
            ],
        }
    }

    fn features(&self) -> Vec<ProviderFeature> {
        ace_codex::codex_provider_features()
    }

    async fn status(&self) -> ProviderDriverStatus {
        self.backend.status().await
    }

    async fn lifecycle_action(
        &self,
        action: ProviderLifecycleAction,
        grace: Duration,
    ) -> std::result::Result<ProviderLifecycleResult, ProviderDriverError> {
        let result = match action {
            ProviderLifecycleAction::Start => self.backend.start().await,
            ProviderLifecycleAction::Restart => self.backend.restart(grace).await,
            ProviderLifecycleAction::Shutdown => self.backend.shutdown(grace).await,
        };
        result.map_err(|error| ProviderDriverError::RequestFailed {
            provider: "codex".to_string(),
            method: format!("lifecycle/{action:?}"),
            message: error.to_string(),
        })?;

        Ok(ProviderLifecycleResult {
            action,
            status: self.backend.status().await,
            metadata: json!({
                "grace_ms": grace.as_millis() as u64
            }),
        })
    }

    async fn request(
        &self,
        request: ProviderRequest,
    ) -> std::result::Result<Value, ProviderDriverError> {
        self.raw_request(request.method.clone(), request.params)
            .await
            .map_err(|error| ProviderDriverError::RequestFailed {
                provider: "codex".to_string(),
                method: request.method,
                message: error.to_string(),
            })
    }
}

#[async_trait]
impl ProviderEventSource for CodexService {
    async fn next_events(
        &self,
    ) -> std::result::Result<Option<Vec<ProviderEvent>>, ProviderDriverError> {
        CodexService::next_events(self)
            .await
            .map_err(|error| ProviderDriverError::RequestFailed {
                provider: "codex".to_string(),
                method: "events/next".to_string(),
                message: error.to_string(),
            })
    }
}

#[async_trait]
impl ProviderServerRequestResponder for CodexService {
    async fn respond_server_request_result(
        &self,
        request_id: String,
        result: Value,
    ) -> std::result::Result<(), ProviderDriverError> {
        let request_id = parse_codex_server_request_id(&request_id, "server_request/result")?;
        CodexService::respond_server_request_result(self, request_id, result)
            .await
            .map_err(|error| ProviderDriverError::RequestFailed {
                provider: "codex".to_string(),
                method: "server_request/result".to_string(),
                message: error.to_string(),
            })
    }

    async fn respond_server_request_error(
        &self,
        request_id: String,
        code: i64,
        message: String,
    ) -> std::result::Result<(), ProviderDriverError> {
        let request_id = parse_codex_server_request_id(&request_id, "server_request/error")?;
        CodexService::respond_server_request_error(self, request_id, code, message)
            .await
            .map_err(|error| ProviderDriverError::RequestFailed {
                provider: "codex".to_string(),
                method: "server_request/error".to_string(),
                message: error.to_string(),
            })
    }
}

#[async_trait]
impl ProviderStateSource for CodexService {
    async fn runtime_state_snapshot(
        &self,
    ) -> std::result::Result<AgentRuntimeSnapshot, ProviderDriverError> {
        Ok(CodexService::runtime_state_snapshot(self).await)
    }
}

fn parse_codex_server_request_id(
    request_id: &str,
    method: &'static str,
) -> std::result::Result<i64, ProviderDriverError> {
    request_id
        .parse::<i64>()
        .map_err(|error| ProviderDriverError::RequestFailed {
            provider: "codex".to_string(),
            method: method.to_string(),
            message: format!("invalid Codex server request id `{request_id}`: {error}"),
        })
}

fn extract_turn_id(response: &Value) -> Option<String> {
    response
        .pointer("/turn/id")
        .or_else(|| response.pointer("/turn/turnId"))
        .or_else(|| response.get("turnId"))
        .or_else(|| response.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
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

fn agent_threads_from_codex_response(
    response: &Value,
    fallback_thread_id: Option<&str>,
) -> Vec<AgentThread> {
    let mut threads = Vec::new();
    if let Some(thread) = response.get("thread") {
        if let Some(thread) = agent_thread_from_value(thread, fallback_thread_id) {
            threads.push(thread);
        }
    } else if let Some(thread) = agent_thread_from_value(response, fallback_thread_id) {
        threads.push(thread);
    }

    for key in ["threads", "loadedThreads", "loaded_threads"] {
        if let Some(items) = response.get(key).and_then(Value::as_array) {
            threads.extend(
                items
                    .iter()
                    .filter_map(|thread| agent_thread_from_value(thread, None)),
            );
        }
    }

    threads.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    threads.dedup_by(|left, right| left.thread_id == right.thread_id);
    threads
}

fn remote_connections_from_codex_response(response: &Value) -> Vec<RemoteConnectionRecord> {
    let mut connections = Vec::new();
    collect_remote_connections(response, &mut connections);
    for key in [
        "connections",
        "remoteConnections",
        "remote_connections",
        "hosts",
        "devices",
    ] {
        if let Some(items) = response.get(key).and_then(Value::as_array) {
            for item in items {
                collect_remote_connections(item, &mut connections);
            }
        }
    }
    connections.sort_by(|left, right| left.host_id.cmp(&right.host_id));
    connections.dedup_by(|left, right| left.host_id == right.host_id);
    connections
}

fn collect_remote_connections(value: &Value, connections: &mut Vec<RemoteConnectionRecord>) {
    if let Some(items) = value.as_array() {
        connections.extend(items.iter().filter_map(remote_connection_from_value));
    } else if let Some(connection) = remote_connection_from_value(value) {
        connections.push(connection);
    }
}

fn remote_connection_from_value(value: &Value) -> Option<RemoteConnectionRecord> {
    let host = string_field_any(value, &["host", "hostname", "hostName", "sshHost", "alias"]);
    let display_name = string_field_any(value, &["displayName", "display_name", "name", "title"]);
    let host_id = string_field_any(
        value,
        &["id", "hostId", "host_id", "connectionId", "deviceId"],
    )
    .or_else(|| host.clone())
    .or_else(|| display_name.clone())?;
    Some(RemoteConnectionRecord {
        provider: ProviderKind::Codex.runtime_id().to_string(),
        host_id,
        host,
        display_name,
        status: string_field_any(value, &["status", "state", "health"]),
        execution_location: execution_location_from_remote_connection(value),
        projects: value
            .get("projects")
            .or_else(|| value.get("savedProjects"))
            .or_else(|| value.get("saved_projects"))
            .or_else(|| value.get("repositories"))
            .cloned()
            .unwrap_or(Value::Null),
        metadata: value.clone(),
    })
}

fn execution_location_from_remote_connection(value: &Value) -> ExecutionLocation {
    match string_field_any(
        value,
        &[
            "executionLocation",
            "execution_location",
            "location",
            "kind",
            "type",
        ],
    )
    .as_deref()
    {
        Some("local") | Some("this_computer") | Some("this-computer") => ExecutionLocation::Local,
        Some("cloud") => ExecutionLocation::Cloud,
        _ => ExecutionLocation::RemoteHost,
    }
}

fn remote_handoff_plan(request: &CodexRemoteHandoffRequest, response: &Value) -> HandoffPlan {
    HandoffPlan {
        source_thread_id: request.thread_id.clone(),
        target_location: ExecutionLocation::RemoteHost,
        status: remote_handoff_status(response),
        target_thread_id: extract_thread_id(response)
            .or_else(|| string_field_any(response, &["targetThreadId", "target_thread_id"])),
        repo_root: None,
        worktree_path: request
            .target_path
            .clone()
            .or_else(|| string_field_any(response, &["targetPath", "target_path", "worktreePath"])),
        branch: request
            .branch
            .clone()
            .or_else(|| string_field_any(response, &["branch", "worktreeBranch"])),
        start_point: string_field_any(response, &["startPoint", "start_point"]),
        checkpoint_ref: string_field_any(response, &["checkpointRef", "checkpoint_ref"]),
        remote_host: Some(request.host.clone()),
        transfer_status: string_field_any(
            response,
            &["transferStatus", "transfer_status", "status"],
        ),
        interrupted_active_turn: bool_field(response, "interruptedActiveTurn")
            .or_else(|| bool_field(response, "interrupted_active_turn")),
        metadata: response.clone(),
    }
}

fn remote_handoff_status(response: &Value) -> HandoffStatus {
    match string_field_any(response, &["status", "handoffStatus", "handoff_status"]).as_deref() {
        Some("failed") | Some("error") => HandoffStatus::Failed,
        Some("requested") | Some("pending") => HandoffStatus::Requested,
        Some("transferring") => HandoffStatus::Transferring,
        Some("interrupted") => HandoffStatus::Interrupted,
        _ => HandoffStatus::Completed,
    }
}

fn agent_thread_from_value(value: &Value, fallback_thread_id: Option<&str>) -> Option<AgentThread> {
    let thread_id = extract_thread_id(value)
        .or_else(|| string_field(value, "thread_id"))
        .or_else(|| fallback_thread_id.map(ToString::to_string))?;
    Some(AgentThread {
        thread_id,
        provider: "codex".to_string(),
        execution_location: execution_location_from_thread(value),
        name: string_field(value, "name").or_else(|| {
            value
                .pointer("/metadata/name")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }),
        active: bool_field(value, "active").or_else(|| bool_field(value, "isActive")),
        archived: bool_field(value, "archived").or_else(|| bool_field(value, "isArchived")),
        active_turn: None,
        plan_session: None,
        settings: Value::Null,
        token_usage: Value::Null,
        metadata: value.clone(),
    })
}

fn execution_location_from_thread(value: &Value) -> ExecutionLocation {
    let location = string_field(value, "executionLocation")
        .or_else(|| string_field(value, "execution_location"))
        .or_else(|| string_field(value, "location"))
        .or_else(|| string_field(value, "runtimeLocation"))
        .or_else(|| {
            value
                .pointer("/metadata/executionLocation")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .or_else(|| {
            value
                .pointer("/metadata/execution_location")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        });
    match location.as_deref() {
        Some("worktree") => ExecutionLocation::Worktree,
        Some("remote") | Some("remote_host") | Some("remote-host") | Some("remoteHost") => {
            ExecutionLocation::RemoteHost
        }
        Some("cloud") => ExecutionLocation::Cloud,
        _ => ExecutionLocation::Local,
    }
}

fn bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn string_field_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| string_field(value, key))
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn plan_implementation_record(
    request: &CodexPlanImplementation,
    target_thread_id: String,
    mode: PlanImplementationMode,
    provider_response: Value,
) -> PlanImplementationRecord {
    PlanImplementationRecord {
        parent_thread_id: request.thread_id.clone(),
        target_thread_id,
        mode,
        prompt: request.prompt.clone(),
        model: request.model.clone(),
        reasoning_effort: request.reasoning_effort.clone(),
        cwd: request.cwd.clone(),
        plan: request.plan.clone(),
        sandbox_policy: request.sandbox_policy.clone().unwrap_or(Value::Null),
        approval_policy: request.approval_policy.clone().unwrap_or(Value::Null),
        approvals_reviewer: request.approvals_reviewer.clone(),
        provider_response,
    }
}

fn thread_lifecycle_record(
    thread_id: String,
    action: ThreadLifecycleActionKind,
    request: Value,
    provider_response: Value,
) -> ThreadLifecycleRecord {
    ThreadLifecycleRecord {
        thread_id,
        action,
        turn_id: None,
        name: None,
        item_count: None,
        request,
        provider_response,
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex as StdMutex};

    #[derive(Default)]
    pub struct FakeCodexBackend {
        pub calls: StdMutex<Vec<String>>,
        pub events: StdMutex<VecDeque<Vec<ProviderEvent>>>,
        pub server_request_responses: StdMutex<Vec<ServerRequestResponse>>,
        pub stderr_tail: StdMutex<Vec<String>>,
        pub starts: StdMutex<u64>,
        pub shutdowns: StdMutex<Vec<Duration>>,
        pub restarts: StdMutex<Vec<Duration>>,
        pub supported_client_request_methods: StdMutex<Option<Vec<String>>>,
    }

    #[derive(Debug, Clone, PartialEq)]
    pub enum ServerRequestResponse {
        Result {
            request_id: i64,
            result: Value,
        },
        Error {
            request_id: i64,
            code: i64,
            message: String,
        },
    }

    impl FakeCodexBackend {
        pub fn push_events(&self, events: Vec<ProviderEvent>) {
            self.events.lock().expect("events").push_back(events);
        }
    }

    #[async_trait]
    impl CodexBackend for FakeCodexBackend {
        async fn status(&self) -> ProviderDriverStatus {
            let supported_client_request_methods = self
                .supported_client_request_methods
                .lock()
                .expect("supported client request methods")
                .clone();
            ProviderDriverStatus {
                health: ProviderRuntimeHealth::Running,
                transport: Some("fake_stdio".to_string()),
                version: Some("fake-codex-1".to_string()),
                initialized: true,
                last_error: None,
                metadata: serde_json::json!({
                    "fake": true,
                    "queued_event_batches": self.events.lock().expect("events").len(),
                    "supported_client_request_methods": supported_client_request_methods
                }),
            }
        }

        async fn raw_request(&self, method: &str, params: Value) -> Result<Value> {
            self.calls.lock().expect("calls").push(method.to_string());
            if method == "remote/connectionList" {
                return Ok(serde_json::json!({
                    "connections": [
                        {
                            "id": "devbox",
                            "host": "devbox",
                            "displayName": "Devbox",
                            "status": "online",
                            "projects": [
                                {
                                    "path": "/srv/ace",
                                    "repoRoot": "/srv/ace"
                                }
                            ],
                            "platform": "linux"
                        },
                        {
                            "hostId": "mac-mini",
                            "hostname": "mac-mini.local",
                            "name": "Mac mini",
                            "state": "offline",
                            "metadata": {
                                "executionLocation": "remote_host"
                            }
                        }
                    ]
                }));
            }
            if method == "remote/handoff" {
                return Ok(serde_json::json!({
                    "threadId": params.get("threadId").cloned().unwrap_or(Value::Null),
                    "targetThreadId": params.get("threadId").cloned().unwrap_or(Value::Null),
                    "host": params.get("host").cloned().unwrap_or(Value::Null),
                    "targetPath": params.get("targetPath").cloned().unwrap_or(Value::Null),
                    "branch": params.get("branch").cloned().unwrap_or(Value::Null),
                    "status": "completed",
                    "transferStatus": "files_transferred",
                    "interruptedActiveTurn": true
                }));
            }
            if method == "model/list" {
                return Ok(serde_json::json!({
                    "defaultProvider": "openai",
                    "models": [
                        {
                            "id": "gpt-5",
                            "displayName": "GPT-5",
                            "provider": "openai",
                            "family": "gpt",
                            "contextWindow": 256000,
                            "maxOutputTokens": 32000,
                            "capabilities": ["reasoning", "tools", "vision"],
                            "defaultReasoningEffort": "medium"
                        }
                    ]
                }));
            }
            if method == "modelProvider/capabilities/read" {
                return Ok(serde_json::json!({
                    "providerId": params
                        .get("provider")
                        .or_else(|| params.get("providerId"))
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!("openai")),
                    "displayName": "OpenAI",
                    "capabilities": {
                        "reasoning": true,
                        "tool_use": true,
                        "parallel_tool_calls": true,
                        "subagents": true,
                        "attachments": true
                    },
                    "limits": {
                        "contextWindow": 256000,
                        "maxOutputTokens": 32000
                    },
                    "models": [
                        {
                            "id": "gpt-5",
                            "displayName": "GPT-5",
                            "supportsVision": true
                        }
                    ],
                    "schemaVersion": 1
                }));
            }
            Ok(serde_json::json!({ "method": method }))
        }

        async fn start(&self) -> Result<()> {
            *self.starts.lock().expect("starts") += 1;
            Ok(())
        }

        async fn start_thread(&self, _request: CodexThreadStart) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("thread/start".to_string());
            Ok(serde_json::json!({ "thread": { "id": "thread-1" } }))
        }

        async fn resume_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/resume:{thread_id}"));
            Ok(serde_json::json!({ "thread": { "id": thread_id } }))
        }

        async fn fork_thread(&self, thread_id: &str, ephemeral: bool) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/fork:{thread_id}:{ephemeral}"));
            Ok(serde_json::json!({ "thread": { "id": "fork-1" } }))
        }

        async fn read_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/read:{thread_id}"));
            Ok(serde_json::json!({
                "thread": {
                    "id": thread_id,
                    "name": "Read thread",
                    "executionLocation": "worktree",
                    "active": true,
                    "archived": false
                }
            }))
        }

        async fn list_threads(&self, _params: Value) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("thread/list".to_string());
            Ok(serde_json::json!({
                "threads": [
                    {
                        "id": "thread-1",
                        "name": "Listed thread",
                        "executionLocation": "local",
                        "active": true,
                        "archived": false
                    },
                    {
                        "threadId": "thread-2",
                        "name": "Remote thread",
                        "isActive": false,
                        "isArchived": true,
                        "metadata": { "executionLocation": "remote_host" }
                    }
                ]
            }))
        }

        async fn list_loaded_threads(&self) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("thread/loaded/list".to_string());
            Ok(serde_json::json!({
                "loadedThreads": [
                    {
                        "id": "thread-3",
                        "name": "Loaded cloud thread",
                        "execution_location": "cloud",
                        "active": true,
                        "archived": false
                    }
                ]
            }))
        }

        async fn archive_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/archive:{thread_id}"));
            Ok(serde_json::json!({ "archived": true }))
        }

        async fn unarchive_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/unarchive:{thread_id}"));
            Ok(serde_json::json!({ "archived": false }))
        }

        async fn delete_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/delete:{thread_id}"));
            Ok(serde_json::json!({ "deleted": true }))
        }

        async fn unsubscribe_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/unsubscribe:{thread_id}"));
            Ok(serde_json::json!({ "unsubscribed": true }))
        }

        async fn set_thread_name(&self, thread_id: &str, name: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/name/set:{thread_id}:{name}"));
            Ok(serde_json::json!({ "name": name }))
        }

        async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/metadata/update:{thread_id}"));
            Ok(serde_json::json!({ "metadata": metadata }))
        }

        async fn compact_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/compact/start:{thread_id}"));
            Ok(serde_json::json!({ "compacted": true }))
        }

        async fn rollback_thread(&self, thread_id: &str, turn_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/rollback:{thread_id}:{turn_id}"));
            Ok(serde_json::json!({ "rolled_back": true }))
        }

        async fn inject_thread_items(&self, thread_id: &str, items: Vec<Value>) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/inject_items:{thread_id}:{}", items.len()));
            Ok(serde_json::json!({ "injected": items.len() }))
        }

        async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("turn/start:{}", request.thread_id));
            Ok(serde_json::json!({ "turn": { "id": "turn-1" } }))
        }

        async fn steer_turn(&self, request: CodexTurnSteer) -> Result<Value> {
            self.calls.lock().expect("calls").push(format!(
                "turn/steer:{}:{}:{}",
                request.thread_id,
                request.expected_turn_id,
                request.input.len()
            ));
            Ok(serde_json::json!({ "turnId": request.expected_turn_id }))
        }

        async fn continue_plan_in_thread(&self, request: CodexPlanImplementation) -> Result<Value> {
            self.inject_thread_items(
                &request.thread_id,
                vec![ace_codex::accepted_plan_item(request.plan.clone())],
            )
            .await?;
            let thread_id = request.thread_id.clone();
            self.start_turn(request.into_turn_start(thread_id.clone()))
                .await?;
            Ok(serde_json::json!({ "threadId": thread_id, "forked": false }))
        }

        async fn fork_plan_for_implementation(
            &self,
            request: CodexPlanImplementation,
        ) -> Result<Value> {
            self.implement_plan_in_fake_fork(request, false).await
        }

        async fn side_implementation(&self, request: CodexPlanImplementation) -> Result<Value> {
            self.implement_plan_in_fake_fork(request, true).await
        }

        async fn interrupt_turn(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("turn/interrupt:{thread_id}"));
            Ok(serde_json::json!({ "interrupted": true }))
        }

        async fn config_requirements_read(&self) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("configRequirements/read".to_string());
            Ok(serde_json::json!({
                "allowedPermissionPresets": ["strict", "auto", "auto_review", "full_access"],
                "deniedPermissionPresets": ["full_access"]
            }))
        }

        async fn permission_profile_list(&self) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("permissionProfile/list".to_string());
            Ok(serde_json::json!({
                "profiles": [
                    { "id": "strict" },
                    { "id": "auto" },
                    { "id": "auto_review" }
                ]
            }))
        }

        async fn permission_catalog(&self) -> Result<CodexPermissionCatalog> {
            let requirements = self.config_requirements_read().await?;
            let profiles = self.permission_profile_list().await?;
            Ok(CodexPermissionCatalog::from_sources(requirements, profiles))
        }

        async fn approve_guardian_denied_action(
            &self,
            request: CodexGuardianDeniedActionApproval,
        ) -> Result<Value> {
            self.calls.lock().expect("calls").push(format!(
                "thread/approveGuardianDeniedAction:{}:{}",
                request.thread_id,
                request.action_id.as_deref().unwrap_or_default()
            ));
            Ok(serde_json::json!({ "approved": request.approved }))
        }

        async fn goal_set(&self, request: CodexGoalSet) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/goal/set:{}", request.thread_id));
            Ok(serde_json::json!({
                "threadId": request.thread_id,
                "objective": request.objective,
                "tokenBudget": request.token_budget,
                "status": "active"
            }))
        }

        async fn goal_get(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/goal/get:{thread_id}"));
            Ok(serde_json::json!({
                "threadId": thread_id,
                "objective": "finish adapter",
                "status": "active"
            }))
        }

        async fn goal_clear(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/goal/clear:{thread_id}"));
            Ok(serde_json::json!({ "threadId": thread_id, "status": "cleared" }))
        }

        async fn goal_pause(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/goal/set:{thread_id}:paused"));
            Ok(serde_json::json!({ "threadId": thread_id, "status": "paused" }))
        }

        async fn goal_resume(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/goal/set:{thread_id}:active"));
            Ok(serde_json::json!({ "threadId": thread_id, "status": "active" }))
        }

        async fn subagent_list(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("subagent/list:{thread_id}"));
            Ok(serde_json::json!({ "subagents": [] }))
        }

        async fn subagent_read(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("subagent/read:{thread_id}:{subagent_thread_id}"));
            Ok(serde_json::json!({
                "threadId": subagent_thread_id,
                "parentThreadId": thread_id,
            }))
        }

        async fn subagent_steer(&self, request: CodexSubagentSteer) -> Result<Value> {
            self.calls.lock().expect("calls").push(format!(
                "subagent/steer:{}:{}",
                request.thread_id, request.subagent_thread_id
            ));
            Ok(serde_json::json!({ "steered": true }))
        }

        async fn subagent_stop(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("subagent/stop:{thread_id}:{subagent_thread_id}"));
            Ok(serde_json::json!({ "stopped": true }))
        }

        async fn subagent_close(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("subagent/close:{thread_id}:{subagent_thread_id}"));
            Ok(serde_json::json!({ "closed": true }))
        }

        async fn handoff_to_agent(&self, request: CodexHandoffToAgent) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/handoffToAgent:{}", request.thread_id));
            Ok(serde_json::json!({
                "thread": {
                    "id": "agent-thread-1"
                },
                "role": request.agent_role,
            }))
        }

        async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>> {
            Ok(self.events.lock().expect("events").pop_front())
        }

        async fn respond_server_request_result(
            &self,
            request_id: i64,
            result: Value,
        ) -> Result<()> {
            self.server_request_responses
                .lock()
                .expect("server request responses")
                .push(ServerRequestResponse::Result { request_id, result });
            Ok(())
        }

        async fn respond_server_request_error(
            &self,
            request_id: i64,
            code: i64,
            message: &str,
        ) -> Result<()> {
            self.server_request_responses
                .lock()
                .expect("server request responses")
                .push(ServerRequestResponse::Error {
                    request_id,
                    code,
                    message: message.to_string(),
                });
            Ok(())
        }

        async fn stderr_tail(&self) -> Result<Vec<String>> {
            Ok(self.stderr_tail.lock().expect("stderr tail").clone())
        }

        async fn shutdown(&self, timeout: Duration) -> Result<()> {
            self.shutdowns.lock().expect("shutdowns").push(timeout);
            Ok(())
        }

        async fn restart(&self, timeout: Duration) -> Result<()> {
            self.restarts.lock().expect("restarts").push(timeout);
            Ok(())
        }
    }

    impl FakeCodexBackend {
        async fn implement_plan_in_fake_fork(
            &self,
            request: CodexPlanImplementation,
            ephemeral: bool,
        ) -> Result<Value> {
            let parent_thread_id = request.thread_id.clone();
            self.fork_thread(&parent_thread_id, ephemeral).await?;
            let thread_id = "fork-1".to_string();
            self.inject_thread_items(
                &thread_id,
                vec![ace_codex::accepted_plan_item(request.plan.clone())],
            )
            .await?;
            self.start_turn(request.into_turn_start(thread_id.clone()))
                .await?;
            Ok(serde_json::json!({
                "threadId": thread_id,
                "parentThreadId": parent_thread_id,
                "forked": true,
                "ephemeral": ephemeral,
            }))
        }
    }

    #[tokio::test]
    async fn raw_request_classifies_codex_client_methods_before_transport() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        let allowed = service
            .raw_request(
                "remote/handoff".to_string(),
                json!({ "threadId": "thread-1" }),
            )
            .await
            .expect("version-gated raw request");
        assert_eq!(allowed["status"], "completed");
        assert_eq!(allowed["threadId"], "thread-1");

        let deferred = service
            .raw_request("cloud/handoff".to_string(), json!({}))
            .await
            .expect_err("deferred method rejection");
        assert!(matches!(
            deferred,
            CodexApiError::DeferredMethod(ref method) if method == "cloud/handoff"
        ));
        assert_eq!(deferred.code(), "codex_deferred_method");

        let unknown = service
            .raw_request("command/approvalRequest".to_string(), json!({}))
            .await
            .expect_err("server request method rejection");
        assert!(matches!(
            unknown,
            CodexApiError::UnknownClientMethod(ref method) if method == "command/approvalRequest"
        ));
        assert_eq!(unknown.code(), "codex_unknown_client_method");
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["remote/handoff"]
        );
    }

    #[tokio::test]
    async fn service_records_remote_connections_and_handoff_state() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        let connections = service
            .remote_connection_list(json!({ "includeProjects": true }))
            .await
            .expect("remote connection list");
        assert_eq!(connections["connections"][0]["id"], "devbox");

        let handoff = service
            .remote_handoff(CodexRemoteHandoffRequest {
                thread_id: "thread-1".to_string(),
                host: "devbox".to_string(),
                target_path: Some("/srv/ace".to_string()),
                branch: Some("feature/remote".to_string()),
            })
            .await
            .expect("remote handoff");
        assert_eq!(handoff["status"], "completed");

        let snapshot = service.runtime_state_snapshot().await;
        assert_eq!(
            snapshot
                .remote_connections
                .iter()
                .map(|connection| connection.host_id.as_str())
                .collect::<Vec<_>>(),
            ["devbox", "mac-mini"]
        );
        assert_eq!(
            snapshot.remote_connections[0].display_name.as_deref(),
            Some("Devbox")
        );
        assert_eq!(
            snapshot.remote_connections[0].execution_location,
            ExecutionLocation::RemoteHost
        );
        assert_eq!(
            snapshot.remote_connections[0].projects[0]["path"],
            "/srv/ace"
        );
        assert_eq!(
            snapshot.remote_connections[1].host.as_deref(),
            Some("mac-mini.local")
        );
        assert_eq!(snapshot.handoffs.len(), 1);
        assert_eq!(snapshot.handoffs[0].source_thread_id, "thread-1");
        assert_eq!(
            snapshot.handoffs[0].target_location,
            ExecutionLocation::RemoteHost
        );
        assert_eq!(snapshot.handoffs[0].status, HandoffStatus::Completed);
        assert_eq!(snapshot.handoffs[0].remote_host.as_deref(), Some("devbox"));
        assert_eq!(
            snapshot.handoffs[0].worktree_path.as_deref(),
            Some("/srv/ace")
        );
        assert_eq!(
            snapshot.handoffs[0].branch.as_deref(),
            Some("feature/remote")
        );
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["remote/connectionList", "remote/handoff"]
        );
    }

    #[tokio::test]
    async fn service_records_remote_connection_status_from_provider_events() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());
        backend.push_events(vec![ProviderEvent::RuntimeSignal {
            signal: Box::new(ace_runtime::provider::NormalizedRuntimeSignal {
                kind: ace_runtime::provider::RuntimeSignalKind::ProviderStateUpdated,
                thread_id: None,
                turn_id: None,
                item_id: None,
                message: None,
                from_model: None,
                to_model: None,
                reason: None,
                text: None,
                audio: None,
                status: Some("connected".to_string()),
                name: Some("Devbox".to_string()),
                active: None,
                archived: None,
                diff: None,
                files: None,
                process_id: None,
                exit_code: None,
                request_id: None,
                metadata: serde_json::json!({
                    "hostId": "devbox",
                    "host": "devbox.example.com",
                    "displayName": "Devbox",
                    "status": "connected",
                    "projects": [{ "path": "/srv/ace" }]
                }),
                provider: ace_runtime::provider::ProviderMetadata {
                    provider: ProviderKind::Codex.runtime_id().to_string(),
                    method: Some("remoteControl/status/changed".to_string()),
                    schema_version: None,
                    raw_payload: serde_json::json!({
                        "hostId": "devbox",
                        "host": "devbox.example.com",
                        "displayName": "Devbox",
                        "status": "connected",
                        "projects": [{ "path": "/srv/ace" }]
                    }),
                },
            }),
        }]);

        service.next_events().await.expect("remote status event");

        let snapshot = service.runtime_state_snapshot().await;
        assert_eq!(snapshot.remote_connections.len(), 1);
        assert_eq!(snapshot.remote_connections[0].host_id, "devbox");
        assert_eq!(
            snapshot.remote_connections[0].host.as_deref(),
            Some("devbox.example.com")
        );
        assert_eq!(
            snapshot.remote_connections[0].status.as_deref(),
            Some("connected")
        );
        assert_eq!(
            snapshot.remote_connections[0].projects[0]["path"],
            "/srv/ace"
        );
    }

    #[tokio::test]
    async fn live_backend_status_reports_spawn_failures() {
        let backend = LiveCodexBackend::with_config(CodexConfig {
            transport: CodexTransportConfig::stdio(
                "__ace_missing_codex_binary_for_status_test__",
                vec!["app-server".to_string()],
            ),
            client_info: ace_codex::CodexClientInfo::default(),
            request_timeout: Duration::from_millis(25),
        });

        let error = backend.start().await.expect_err("missing binary");
        assert!(matches!(error, ace_codex::CodexError::MissingBinary(_)));

        let status = backend.status().await;
        assert_eq!(status.health, ProviderRuntimeHealth::Unavailable);
        assert_eq!(status.transport.as_deref(), Some("stdio"));
        assert!(!status.initialized);
        assert!(
            status
                .last_error
                .as_deref()
                .expect("last error")
                .contains("__ace_missing_codex_binary_for_status_test__")
        );
        assert_eq!(
            status.metadata["transport_config"]["command"],
            "__ace_missing_codex_binary_for_status_test__"
        );
        assert_eq!(status.metadata["transport"], "stdio");
        assert_eq!(status.metadata["request_timeout_ms"], 25);
        assert_eq!(status.metadata["spawns_on_first_request"], true);
    }

    #[tokio::test]
    async fn live_backend_status_reports_configured_unix_socket_transport() {
        let socket_path = std::path::PathBuf::from("/tmp/ace-codex-test.sock");
        let backend = LiveCodexBackend::with_config(CodexConfig {
            transport: CodexTransportConfig::unix_socket(socket_path.clone()),
            client_info: ace_codex::CodexClientInfo::default(),
            request_timeout: Duration::from_millis(50),
        });

        let status = backend.status().await;
        assert_eq!(status.health, ProviderRuntimeHealth::Stopped);
        assert_eq!(status.transport.as_deref(), Some("unix_socket"));
        assert_eq!(status.metadata["transport"], "unix_socket");
        assert_eq!(
            status.metadata["transport_config"]["path"],
            socket_path.to_string_lossy().as_ref()
        );
        assert_eq!(status.metadata["spawns_on_first_request"], true);
    }

    #[tokio::test]
    async fn live_backend_status_reports_configured_websocket_transport() {
        let url = "ws://127.0.0.1:54321/codex".to_string();
        let backend = LiveCodexBackend::with_config(CodexConfig {
            transport: CodexTransportConfig::websocket(url.clone()),
            client_info: ace_codex::CodexClientInfo::default(),
            request_timeout: Duration::from_millis(50),
        });

        let status = backend.status().await;
        assert_eq!(status.health, ProviderRuntimeHealth::Stopped);
        assert_eq!(status.transport.as_deref(), Some("websocket"));
        assert_eq!(status.metadata["transport"], "websocket");
        assert_eq!(status.metadata["transport_config"]["url"], url);
        assert_eq!(status.metadata["spawns_on_first_request"], true);
    }

    #[test]
    fn initialize_status_summary_keeps_handshake_metadata_bounded() {
        let summary = summarize_initialize_result(json!({
            "serverInfo": {
                "name": "codex",
                "version": "0.140.0"
            },
            "capabilities": {
                "experimentalApi": true
            },
            "hugeRawField": "not copied into status metadata"
        }));

        assert_eq!(summary["serverInfo"]["name"], "codex");
        assert_eq!(summary["capabilities"]["experimentalApi"], true);
        assert_eq!(summary["top_level_keys"], 3);
        assert!(summary.get("hugeRawField").is_none());
    }

    #[tokio::test]
    async fn service_rejects_plan_turn_while_thread_has_active_turn() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        service
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make a plan",
                "gpt-5.5".to_string(),
                None,
            ))
            .await
            .expect("first plan turn");

        let error = service
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make another plan",
                "gpt-5.5".to_string(),
                None,
            ))
            .await
            .expect_err("active turn rejection");
        assert!(matches!(
            error,
            CodexApiError::TurnAlreadyActive { ref thread_id } if thread_id == "thread-1"
        ));
        assert_eq!(error.code(), "turn_already_active");
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["turn/start:thread-1"]
        );
    }

    #[tokio::test]
    async fn service_steers_active_turn_through_backend() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        let response = service
            .steer_turn(CodexTurnSteer {
                thread_id: "thread-1".to_string(),
                expected_turn_id: "turn-1".to_string(),
                input: vec![serde_json::json!({ "type": "text", "text": "also update docs" })],
                client_user_message_id: None,
            })
            .await
            .expect("steer turn");

        assert_eq!(response["turnId"], "turn-1");
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["turn/steer:thread-1:turn-1:1"]
        );
    }

    #[tokio::test]
    async fn service_clears_active_turn_from_provider_completion_event() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        service
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make a plan",
                "gpt-5.5".to_string(),
                None,
            ))
            .await
            .expect("first plan turn");
        backend.push_events(vec![ProviderEvent::RawNotification {
            method: "turn/completed".to_string(),
            params: serde_json::json!({ "threadId": "thread-1", "turnId": "turn-1" }),
        }]);
        service.next_events().await.expect("events");
        service
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make another plan",
                "gpt-5.5".to_string(),
                None,
            ))
            .await
            .expect("second plan turn after completion");

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["turn/start:thread-1", "turn/start:thread-1"]
        );
    }

    #[tokio::test]
    async fn service_rejects_active_plan_state_when_provider_exits() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        service
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make a plan",
                "gpt-5.5".to_string(),
                None,
            ))
            .await
            .expect("plan turn");
        backend.push_events(vec![ProviderEvent::Exited { code: Some(9) }]);
        service.next_events().await.expect("exit event");

        let snapshot = service.runtime_state_snapshot().await;
        assert!(snapshot.active_turns.is_empty());
        assert_eq!(snapshot.plan_sessions.len(), 1);
        assert_eq!(
            snapshot.plan_sessions[0].status,
            PlanSessionStatus::Rejected
        );
    }

    #[tokio::test]
    async fn service_records_thread_metadata_from_read_and_lists() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        service
            .read_thread("thread-1".to_string())
            .await
            .expect("read thread");
        service
            .list_threads(json!({ "includeArchived": true }))
            .await
            .expect("list threads");
        service
            .list_loaded_threads()
            .await
            .expect("list loaded threads");

        let snapshot = service.runtime_state_snapshot().await;
        assert_eq!(
            snapshot
                .threads
                .iter()
                .map(|thread| thread.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["thread-1", "thread-2", "thread-3"]
        );
        assert_eq!(snapshot.threads[0].metadata["name"], "Listed thread");
        assert_eq!(snapshot.threads[0].name.as_deref(), Some("Listed thread"));
        assert_eq!(snapshot.threads[0].active, Some(true));
        assert_eq!(snapshot.threads[0].archived, Some(false));
        assert_eq!(
            snapshot.threads[0].execution_location,
            ExecutionLocation::Local
        );
        assert_eq!(snapshot.threads[1].name.as_deref(), Some("Remote thread"));
        assert_eq!(snapshot.threads[1].active, Some(false));
        assert_eq!(snapshot.threads[1].archived, Some(true));
        assert_eq!(
            snapshot.threads[1].execution_location,
            ExecutionLocation::RemoteHost
        );
        assert_eq!(
            snapshot.threads[2].execution_location,
            ExecutionLocation::Cloud
        );
        assert_eq!(snapshot.threads[2].metadata["name"], "Loaded cloud thread");
        assert_eq!(
            snapshot.threads[2].name.as_deref(),
            Some("Loaded cloud thread")
        );
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["thread/read:thread-1", "thread/list", "thread/loaded/list"]
        );
    }

    #[tokio::test]
    async fn service_records_fork_from_turn_and_side_chat_state() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        service
            .fork_thread("thread-1".to_string(), false, Some("turn-2".to_string()))
            .await
            .expect("fork from turn");
        service
            .start_side_chat("thread-1".to_string(), Some("turn-3".to_string()))
            .await
            .expect("side chat");

        let state = service.state.lock().await;
        assert_eq!(
            state
                .fork_point("fork-1")
                .and_then(|fork| fork.turn_id.as_deref()),
            Some("turn-3")
        );
        assert_eq!(
            state
                .side_chat("fork-1")
                .map(|side_chat| side_chat.parent_thread_id.as_str()),
            Some("thread-1")
        );
        drop(state);

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/fork:thread-1:false",
                "thread/rollback:fork-1:turn-2",
                "thread/fork:thread-1:true",
                "thread/rollback:fork-1:turn-3",
            ]
        );
    }

    #[tokio::test]
    async fn service_rejects_side_chat_from_side_chat_or_review_mode() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        service
            .start_side_chat("thread-1".to_string(), None)
            .await
            .expect("side chat");
        let nested = service
            .start_side_chat("fork-1".to_string(), None)
            .await
            .expect_err("nested side chat rejection");
        assert!(matches!(
            nested,
            CodexApiError::NestedSideChat { ref thread_id } if thread_id == "fork-1"
        ));

        backend.push_events(vec![ProviderEvent::ThreadItem {
            item: Box::new(ace_runtime::provider::NormalizedThreadItem {
                kind: ace_runtime::provider::ThreadItemKind::EnteredReviewMode,
                status: ace_runtime::provider::ThreadItemStatus::Started,
                thread_id: Some("review-thread".to_string()),
                turn_id: None,
                item_id: Some("review-1".to_string()),
                parent_thread_id: None,
                child_thread_id: None,
                sender: None,
                role: None,
                title: None,
                text: None,
                status_text: None,
                model: None,
                target: None,
                url: None,
                files: None,
                attachments: None,
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
                metadata: serde_json::json!({}),
                provider: ace_runtime::provider::ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/started".to_string()),
                    schema_version: None,
                    raw_payload: serde_json::json!({}),
                },
            }),
        }]);
        service.next_events().await.expect("events");
        let review = service
            .start_side_chat("review-thread".to_string(), None)
            .await
            .expect_err("review side chat rejection");
        assert_eq!(review.code(), "review_mode_side_chat");
    }

    #[tokio::test]
    async fn service_runs_goal_lifecycle_through_backend() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        let set = service
            .goal_set(CodexGoalSet {
                thread_id: "thread-1".to_string(),
                objective: "finish adapter".to_string(),
                token_budget: Some(12_000),
            })
            .await
            .expect("goal set");
        assert_eq!(set["status"], "active");
        service
            .goal_get("thread-1".to_string())
            .await
            .expect("goal get");
        service
            .goal_pause("thread-1".to_string())
            .await
            .expect("goal pause");
        service
            .goal_resume("thread-1".to_string())
            .await
            .expect("goal resume");
        service
            .goal_clear("thread-1".to_string())
            .await
            .expect("goal clear");

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/goal/set:thread-1",
                "thread/goal/get:thread-1",
                "thread/goal/set:thread-1:paused",
                "thread/goal/set:thread-1:active",
                "thread/goal/clear:thread-1",
            ]
        );
    }

    #[tokio::test]
    async fn service_runs_subagent_and_handoff_lifecycle_through_backend() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        service
            .subagent_list("thread-1".to_string())
            .await
            .expect("list");
        service
            .subagent_read("thread-1".to_string(), "subagent-1".to_string())
            .await
            .expect("read");
        service
            .subagent_steer(CodexSubagentSteer {
                thread_id: "thread-1".to_string(),
                subagent_thread_id: "subagent-1".to_string(),
                prompt: "focus on tests".to_string(),
            })
            .await
            .expect("steer");
        service
            .subagent_stop("thread-1".to_string(), "subagent-1".to_string())
            .await
            .expect("stop");
        service
            .subagent_close("thread-1".to_string(), "subagent-1".to_string())
            .await
            .expect("close");
        let handoff = service
            .handoff_to_agent(CodexHandoffToAgent {
                thread_id: "thread-1".to_string(),
                prompt: "take over".to_string(),
                agent_role: Some("implementer".to_string()),
                nickname: Some("builder".to_string()),
                model: None,
                reasoning_effort: None,
                sandbox_policy: None,
                approval_policy: None,
                approvals_reviewer: None,
                skills: vec![],
                mcp_config: serde_json::json!({}),
            })
            .await
            .expect("handoff");
        assert_eq!(handoff["thread"]["id"], "agent-thread-1");

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "subagent/list:thread-1",
                "subagent/read:thread-1:subagent-1",
                "subagent/steer:thread-1:subagent-1",
                "subagent/stop:thread-1:subagent-1",
                "subagent/close:thread-1:subagent-1",
                "thread/handoffToAgent:thread-1",
            ]
        );
        let snapshot = service.runtime_state_snapshot().await;
        assert_eq!(snapshot.subagent_actions.len(), 3);
        assert_eq!(
            snapshot.subagent_actions[0].action,
            SubagentActionKind::Steer
        );
        assert_eq!(
            snapshot.subagent_actions[0].prompt.as_deref(),
            Some("focus on tests")
        );
        assert_eq!(
            snapshot.subagent_actions[0].provider_response["steered"],
            true
        );
        assert_eq!(
            snapshot.subagent_actions[1].action,
            SubagentActionKind::Stop
        );
        assert_eq!(
            snapshot.subagent_actions[1].provider_response["stopped"],
            true
        );
        assert_eq!(
            snapshot.subagent_actions[2].action,
            SubagentActionKind::Close
        );
        assert_eq!(
            snapshot.subagent_actions[2].provider_response["closed"],
            true
        );
    }
}
