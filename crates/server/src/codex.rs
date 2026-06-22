use ace_codex::{
    CodexClient, CodexConfig, CodexGoalSet, CodexGuardianDeniedActionApproval, CodexHandoffToAgent,
    CodexPermissionCatalog, CodexPlanImplementation, CodexStdioTransport, CodexSubagentSteer,
    CodexThreadStart, CodexTurnStart, Result,
};
use ace_core::{ProviderCapability, ProviderKind};
use ace_runtime::{
    provider::{
        ProviderDescriptor, ProviderDriver, ProviderDriverError, ProviderEvent, ProviderRequest,
    },
    threads::{
        AgentRuntimeState, ExecutionLocation, ForkPoint, HandoffPlan, PlanSessionStatus,
        RuntimeStateError, SideChat, TurnMode,
    },
};
use async_trait::async_trait;
use serde_json::Value;
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

#[async_trait]
pub trait CodexBackend: Send + Sync {
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
    client: Mutex<Option<CodexClient<CodexStdioTransport>>>,
}

impl LiveCodexBackend {
    #[must_use]
    pub fn production() -> Self {
        Self {
            config: CodexConfig::default(),
            client: Mutex::new(None),
        }
    }

    async fn client(&self) -> Result<CodexClient<CodexStdioTransport>> {
        let mut guard = self.client.lock().await;
        if let Some(client) = guard.as_ref() {
            return Ok(client.clone());
        }
        let client = CodexClient::spawn(self.config.clone()).await?;
        *guard = Some(client.clone());
        Ok(client)
    }
}

#[async_trait]
impl CodexBackend for LiveCodexBackend {
    async fn raw_request(&self, method: &str, params: Value) -> Result<Value> {
        self.client().await?.raw_request(method, params).await
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
        Ok(self.backend.raw_request(&method, params).await?)
    }

    pub async fn start_thread(
        &self,
        request: CodexThreadStart,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.start_thread(request).await?)
    }

    pub async fn resume_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.resume_thread(&thread_id).await?)
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
        Ok(self.backend.read_thread(&thread_id).await?)
    }

    pub async fn list_threads(&self, params: Value) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.list_threads(params).await?)
    }

    pub async fn list_loaded_threads(&self) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.list_loaded_threads().await?)
    }

    pub async fn archive_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.archive_thread(&thread_id).await?)
    }

    pub async fn unarchive_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.unarchive_thread(&thread_id).await?)
    }

    pub async fn delete_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.delete_thread(&thread_id).await?)
    }

    pub async fn unsubscribe_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.unsubscribe_thread(&thread_id).await?)
    }

    pub async fn set_thread_name(
        &self,
        thread_id: String,
        name: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.set_thread_name(&thread_id, &name).await?)
    }

    pub async fn update_thread_metadata(
        &self,
        thread_id: String,
        metadata: Value,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self
            .backend
            .update_thread_metadata(&thread_id, metadata)
            .await?)
    }

    pub async fn compact_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.compact_thread(&thread_id).await?)
    }

    pub async fn rollback_thread(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.rollback_thread(&thread_id, &turn_id).await?)
    }

    pub async fn inject_thread_items(
        &self,
        thread_id: String,
        items: Vec<Value>,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.inject_thread_items(&thread_id, items).await?)
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

    pub async fn continue_plan_in_thread(
        &self,
        request: CodexPlanImplementation,
    ) -> std::result::Result<Value, CodexApiError> {
        let thread_id = request.thread_id.clone();
        let response = self.backend.continue_plan_in_thread(request).await?;
        self.state.lock().await.mark_plan_implementing(&thread_id);
        Ok(response)
    }

    pub async fn fork_plan_for_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> std::result::Result<Value, CodexApiError> {
        let parent_thread_id = request.thread_id.clone();
        let response = self.backend.fork_plan_for_implementation(request).await?;
        if let Some(child_thread_id) = extract_thread_id(&response) {
            self.state.lock().await.record_fork(ForkPoint {
                parent_thread_id,
                child_thread_id,
                turn_id: None,
            });
        }
        Ok(response)
    }

    pub async fn side_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> std::result::Result<Value, CodexApiError> {
        let parent_thread_id = request.thread_id.clone();
        let response = self.backend.side_implementation(request).await?;
        if let Some(child_thread_id) = extract_thread_id(&response) {
            let mut state = self.state.lock().await;
            state.record_fork(ForkPoint {
                parent_thread_id: parent_thread_id.clone(),
                child_thread_id: child_thread_id.clone(),
                turn_id: None,
            });
            state.record_side_chat(SideChat {
                parent_thread_id,
                thread_id: child_thread_id,
                ephemeral: true,
            });
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

    pub async fn approve_guardian_denied_action(
        &self,
        request: CodexGuardianDeniedActionApproval,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.approve_guardian_denied_action(request).await?)
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
        Ok(self.backend.subagent_steer(request).await?)
    }

    pub async fn subagent_stop(
        &self,
        thread_id: String,
        subagent_thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self
            .backend
            .subagent_stop(&thread_id, &subagent_thread_id)
            .await?)
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
        self.state.lock().await.close_subagent(&subagent_thread_id);
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
            target_thread_id: extract_thread_id(&response),
        });
        Ok(response)
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
                    key: "provider.semantic_tools".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.runtime.raw_request".to_string(),
                    version: 1,
                },
            ],
        }
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
        pub shutdowns: StdMutex<Vec<Duration>>,
        pub restarts: StdMutex<Vec<Duration>>,
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
        async fn raw_request(&self, method: &str, _params: Value) -> Result<Value> {
            self.calls.lock().expect("calls").push(method.to_string());
            Ok(serde_json::json!({ "method": method }))
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
            Ok(serde_json::json!({ "thread": { "id": thread_id } }))
        }

        async fn list_threads(&self, _params: Value) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("thread/list".to_string());
            Ok(serde_json::json!({ "threads": [] }))
        }

        async fn list_loaded_threads(&self) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("thread/loadedList".to_string());
            Ok(serde_json::json!({ "threads": [] }))
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
                .push(format!("thread/setName:{thread_id}:{name}"));
            Ok(serde_json::json!({ "name": name }))
        }

        async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/updateMetadata:{thread_id}"));
            Ok(serde_json::json!({ "metadata": metadata }))
        }

        async fn compact_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/compact:{thread_id}"));
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
                .push(format!("thread/injectItems:{thread_id}:{}", items.len()));
            Ok(serde_json::json!({ "injected": items.len() }))
        }

        async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("turn/start:{}", request.thread_id));
            Ok(serde_json::json!({ "turn": { "id": "turn-1" } }))
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
                "allowedPermissionPresets": ["strict", "auto", "auto_review"],
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
                .push(format!("goal/set:{}", request.thread_id));
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
                .push(format!("goal/get:{thread_id}"));
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
                .push(format!("goal/clear:{thread_id}"));
            Ok(serde_json::json!({ "threadId": thread_id, "status": "cleared" }))
        }

        async fn goal_pause(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("goal/pause:{thread_id}"));
            Ok(serde_json::json!({ "threadId": thread_id, "status": "paused" }))
        }

        async fn goal_resume(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("goal/resume:{thread_id}"));
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
    async fn service_rejects_plan_turn_while_thread_has_active_turn() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        service
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make a plan",
                "gpt-5.5".to_string(),
            ))
            .await
            .expect("first plan turn");

        let error = service
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make another plan",
                "gpt-5.5".to_string(),
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
    async fn service_clears_active_turn_from_provider_completion_event() {
        let backend = Arc::new(FakeCodexBackend::default());
        let service = CodexService::new(backend.clone());

        service
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make a plan",
                "gpt-5.5".to_string(),
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
            ))
            .await
            .expect("second plan turn after completion");

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["turn/start:thread-1", "turn/start:thread-1"]
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
                "goal/set:thread-1",
                "goal/get:thread-1",
                "goal/pause:thread-1",
                "goal/resume:thread-1",
                "goal/clear:thread-1",
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
    }
}
