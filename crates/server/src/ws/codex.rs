use crate::ws::{ProviderEventStreamMessage, WsApiState, WsDispatchError};
use ace_core::ProviderKind;
use ace_git::ProcessRunner;
use ace_persistence::ProviderServerRequestStatus;
use ace_protocol::{
    PROTOCOL_VERSION,
    codex::{
        CodexAppConfigWriteRequest, CodexCommandExecRequest, CodexCommandProcessRequest,
        CodexCommandResizeRequest, CodexCommandWriteStdinRequest,
        CodexCompatibilityInventoryResponse, CodexFsCopyRequest, CodexFsPathRequest,
        CodexFsReadDirectoryRequest, CodexFsReadFileRequest, CodexFsWriteFileRequest,
        CodexGoalSetRequest, CodexGuardianDeniedActionApprovalRequest, CodexHandoffLocation,
        CodexHandoffToAgentRequest, CodexHandoffToLocationRequest, CodexHandoffToLocationResponse,
        CodexMcpOauthLoginRequest, CodexMcpResourceReadRequest, CodexMcpStatusRequest,
        CodexMcpToolCallRequest, CodexNamedQueryRequest, CodexPermissionPresetRequest,
        CodexPlanImplementationRequest, CodexPlanTurnStartRequest, CodexPluginRequest,
        CodexProcessCleanRequest, CodexProcessListRequest, CodexRawRequest,
        CodexRemoteHandoffRequest, CodexReviewStartRequest, CodexShutdownRequest,
        CodexSkillRequest, CodexSkillsConfigWriteRequest, CodexSkillsExtraRootsSetRequest,
        CodexStderrTailResponse, CodexSubagentSteerRequest, CodexSubagentThreadRpcRequest,
        CodexThreadForkRequest, CodexThreadIdRequest, CodexThreadInjectItemsRequest,
        CodexThreadRollbackRequest, CodexThreadSetNameRequest, CodexThreadStartRequest,
        CodexThreadUpdateMetadataRequest, CodexThreadsListRequest, CodexTurnStartRequest,
        CodexTurnSteerRequest, CodexVersionedRequest,
    },
    git::GitWorktreeCreateRequest,
    provider_runtime::{
        PROVIDER_RUNTIME_EVENT_TOPIC, ProviderHostToolInvokeServerRequest,
        ProviderHostToolsListResponse, ProviderRuntimeAdapterValidateRequest,
        ProviderRuntimeAdapterValidateResponse, ProviderRuntimeContractReport,
        ProviderRuntimeEvent, ProviderRuntimeEventBatch, ProviderRuntimeEventRecord,
        ProviderRuntimeFeaturesListRequest, ProviderRuntimeFeaturesListResponse,
        ProviderRuntimeLifecycleRequest, ProviderRuntimeLifecycleResponse,
        ProviderRuntimeOperationGateResolution, ProviderRuntimeOperationGateStatus,
        ProviderRuntimeOperationParams, ProviderRuntimeOperationRequest,
        ProviderRuntimeOperationRequestMode, ProviderRuntimeOperationsListRequest,
        ProviderRuntimeOperationsListResponse, ProviderRuntimeProviderFeatures,
        ProviderRuntimeProviderInfo, ProviderRuntimeProviderOperation,
        ProviderRuntimeProviderOperations, ProviderRuntimeProviderState,
        ProviderRuntimeProviderStatus, ProviderRuntimeProvidersList, ProviderRuntimeRawEventMode,
        ProviderRuntimeRawEventSummary, ProviderRuntimeRecentEventsRequest,
        ProviderRuntimeRecentEventsResponse, ProviderRuntimeRequest,
        ProviderRuntimeStateGetRequest, ProviderRuntimeStateGetResponse,
        ProviderRuntimeStateSource, ProviderRuntimeStatusListRequest,
        ProviderRuntimeStatusListResponse, ProviderRuntimeSubscribeRequest,
        ProviderServerRequestAudit, ProviderServerRequestDecisionRecord,
        ProviderServerRequestDecisionResponse, ProviderServerRequestError,
        ProviderServerRequestRecord, ProviderServerRequestResult,
        ProviderServerRequestStatusFilter, ProviderServerRequestsListRequest,
        ProviderServerRequestsListResponse, projection_deltas_for_events,
    },
    ws::{WsServerPayload, WsServerResponse, methods},
};
use ace_runtime::threads::{
    ApprovalRetryRecord, ExecutionLocation, ForkPoint, GoalState, GoalStatus, HandoffPlan,
    HandoffStatus, PlanImplementationMode, PlanImplementationRecord, SideChat, TurnMode,
};
use ace_runtime::{
    host_tools::{
        HostToolError, HostToolInvocation, HostToolResult, host_tool_invocation_from_server_request,
    },
    provider::{
        NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedServerRequestDecision,
        ProviderAdapterOperation, ProviderAdapterOperationGate, ProviderAdapterProfile,
        ProviderAdapterRequestResolution, ProviderDriverStatus, ProviderEvent, ProviderMetadata,
        ProviderRequest, RuntimeSignalKind, ace_provider_adapter_contract,
        provider_adapter_profile, provider_contract_report,
    },
    tools::{
        ProviderToolMetadata, SemanticToolCall, ToolNormalizationInput, ToolRunStatus,
        ToolTransport, normalize_tool_call,
    },
};
use ace_terminal::PtyAdapter;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};
use tokio::sync::{broadcast, mpsc};

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_codex_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        if method == methods::CODEX_REVIEW_START {
            let request = serde_json::from_value::<CodexReviewStartRequest>(payload)?;
            let params = serde_json::to_value(&request)?;
            let response = self
                .codex
                .review_start(request.thread_id.clone(), params.clone())
                .await?;
            self.publish_codex_review_mode_signal(CodexReviewModeSignal {
                thread_id: request.thread_id,
                active: true,
                status: "entered",
                request: params,
                provider_response: response.clone(),
                method: "ace/review/start",
            })?;
            return Ok(response);
        }

        if let Some((codex_method, params)) = codex_versioned_app_server_request(method, &payload)?
        {
            self.publish_codex_versioned_tool_event(
                method,
                codex_method,
                &params,
                None,
                ToolRunStatus::Started,
            )?;
            let response = match codex_method {
                "remote/connectionList" => self
                    .codex
                    .remote_connection_list(params.clone())
                    .await
                    .map_err(WsDispatchError::from),
                "remote/handoff" => {
                    match serde_json::from_value::<CodexRemoteHandoffRequest>(params.clone()) {
                        Ok(request) => self
                            .codex
                            .remote_handoff(request)
                            .await
                            .map_err(WsDispatchError::from),
                        Err(error) => Err(WsDispatchError::from(error)),
                    }
                }
                _ => self
                    .codex
                    .raw_request(codex_method.to_string(), params.clone())
                    .await
                    .map_err(WsDispatchError::from),
            };
            return match response {
                Ok(response) => {
                    self.publish_codex_versioned_tool_event(
                        method,
                        codex_method,
                        &params,
                        Some(&response),
                        ToolRunStatus::Completed,
                    )?;
                    Ok(response)
                }
                Err(error) => {
                    let error_payload = json!({
                        "message": error.to_string(),
                    });
                    self.publish_codex_versioned_tool_event(
                        method,
                        codex_method,
                        &params,
                        Some(&error_payload),
                        ToolRunStatus::Failed,
                    )?;
                    Err(error)
                }
            };
        }

        match method {
            methods::CODEX_RAW_REQUEST => {
                let request = serde_json::from_value::<CodexRawRequest>(payload)?;
                let params = user_initiated_codex_params(&request.method, request.params)?;
                self.codex
                    .raw_request(request.method, params)
                    .await
                    .map_err(Into::into)
            }
            methods::CODEX_THREAD_START => {
                let request = serde_json::from_value::<CodexThreadStartRequest>(payload)?;
                let response = self.codex.start_thread(request.params.clone()).await?;
                let thread_id = extract_thread_id_from_value(&response).ok_or_else(|| {
                    WsDispatchError::BadRequest(
                        "Codex thread start response did not include thread id".to_string(),
                    )
                })?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id,
                    status: "started",
                    name: None,
                    active: Some(true),
                    archived: None,
                    metadata: json!({
                        "action": "start",
                        "request": request.params,
                        "provider_response": response.clone()
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_RESUME => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.resume_thread(request.thread_id.clone()).await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id.clone(),
                    status: "resumed",
                    name: None,
                    active: Some(true),
                    archived: None,
                    metadata: json!({
                        "action": "resume",
                        "request": { "thread_id": request.thread_id },
                        "provider_response": response.clone()
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_FORK => {
                let request = serde_json::from_value::<CodexThreadForkRequest>(payload)?;
                let response = self
                    .codex
                    .fork_thread(
                        request.thread_id.clone(),
                        request.ephemeral,
                        request.turn_id.clone(),
                    )
                    .await?;
                let child_thread_id = extract_thread_id_from_value(&response).ok_or_else(|| {
                    WsDispatchError::BadRequest(
                        "Codex fork response did not include child thread id".to_string(),
                    )
                })?;
                self.publish_codex_fork_signal(CodexForkSignal {
                    fork: ForkPoint {
                        parent_thread_id: request.thread_id,
                        child_thread_id,
                        turn_id: request.turn_id,
                    },
                    ephemeral: request.ephemeral,
                    method: "ace/thread/fork",
                    provider_response: response.clone(),
                })?;
                Ok(response)
            }
            methods::CODEX_SIDE_CHAT_START => {
                let request = serde_json::from_value::<CodexThreadForkRequest>(payload)?;
                let response = self
                    .codex
                    .start_side_chat(request.thread_id.clone(), request.turn_id.clone())
                    .await?;
                let child_thread_id = extract_thread_id_from_value(&response).ok_or_else(|| {
                    WsDispatchError::BadRequest(
                        "Codex side chat response did not include child thread id".to_string(),
                    )
                })?;
                self.publish_codex_fork_signal(CodexForkSignal {
                    fork: ForkPoint {
                        parent_thread_id: request.thread_id.clone(),
                        child_thread_id: child_thread_id.clone(),
                        turn_id: request.turn_id.clone(),
                    },
                    ephemeral: true,
                    method: "ace/thread/fork",
                    provider_response: response.clone(),
                })?;
                self.publish_codex_side_chat_signal(CodexSideChatSignal {
                    side_chat: SideChat {
                        parent_thread_id: request.thread_id,
                        thread_id: child_thread_id,
                        ephemeral: true,
                    },
                    turn_id: request.turn_id,
                    method: "ace/side_chat/start",
                    provider_response: response.clone(),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_READ => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.read_thread(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_THREADS_LIST => {
                self.codex_json::<CodexThreadsListRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        let params =
                            serde_json::to_value(request).expect("serialize thread list request");
                        service.list_threads(params).await
                    },
                )
                .await
            }
            methods::CODEX_THREADS_LOADED_LIST => {
                let response = self.codex.list_loaded_threads().await?;
                Ok(response)
            }
            methods::CODEX_THREAD_ARCHIVE => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.archive_thread(request.thread_id.clone()).await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id,
                    status: "archived",
                    name: None,
                    active: None,
                    archived: Some(true),
                    metadata: json!({
                        "action": "archive",
                        "provider_response": response.clone(),
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_UNARCHIVE => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.unarchive_thread(request.thread_id.clone()).await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id,
                    status: "unarchived",
                    name: None,
                    active: None,
                    archived: Some(false),
                    metadata: json!({
                        "action": "unarchive",
                        "provider_response": response.clone(),
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_DELETE => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.delete_thread(request.thread_id.clone()).await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id,
                    status: "deleted",
                    name: None,
                    active: Some(false),
                    archived: None,
                    metadata: json!({
                        "action": "delete",
                        "provider_response": response.clone(),
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_UNSUBSCRIBE => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.unsubscribe_thread(request.thread_id.clone()).await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id,
                    status: "unsubscribed",
                    name: None,
                    active: Some(false),
                    archived: None,
                    metadata: json!({
                        "action": "unsubscribe",
                        "provider_response": response.clone(),
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_SET_NAME => {
                let request = serde_json::from_value::<CodexThreadSetNameRequest>(payload)?;
                let response = self
                    .codex
                    .set_thread_name(request.thread_id.clone(), request.name.clone())
                    .await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id,
                    status: "renamed",
                    name: Some(request.name),
                    active: None,
                    archived: None,
                    metadata: json!({
                        "action": "set_name",
                        "provider_response": response.clone(),
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_UPDATE_METADATA => {
                let request = serde_json::from_value::<CodexThreadUpdateMetadataRequest>(payload)?;
                let response = self
                    .codex
                    .update_thread_metadata(request.thread_id.clone(), request.metadata.clone())
                    .await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id,
                    status: "metadata_updated",
                    name: None,
                    active: None,
                    archived: None,
                    metadata: json!({
                        "action": "update_metadata",
                        "thread_metadata": request.metadata,
                        "provider_response": response.clone(),
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_COMPACT => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.compact_thread(request.thread_id.clone()).await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id,
                    status: "compacted",
                    name: None,
                    active: None,
                    archived: None,
                    metadata: json!({
                        "action": "compact",
                        "provider_response": response.clone(),
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_ROLLBACK => {
                let request = serde_json::from_value::<CodexThreadRollbackRequest>(payload)?;
                let response = self
                    .codex
                    .rollback_thread(request.thread_id.clone(), request.turn_id.clone())
                    .await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id,
                    status: "rolled_back",
                    name: None,
                    active: None,
                    archived: None,
                    metadata: json!({
                        "action": "rollback",
                        "turn_id": request.turn_id,
                        "provider_response": response.clone(),
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_THREAD_INJECT_ITEMS => {
                let request = serde_json::from_value::<CodexThreadInjectItemsRequest>(payload)?;
                let item_count = request.items.len();
                let response = self
                    .codex
                    .inject_thread_items(request.thread_id.clone(), request.items.clone())
                    .await?;
                self.publish_codex_thread_lifecycle_signal(CodexThreadLifecycleSignal {
                    thread_id: request.thread_id,
                    status: "items_injected",
                    name: None,
                    active: None,
                    archived: None,
                    metadata: json!({
                        "action": "inject_items",
                        "item_count": item_count,
                        "items": request.items,
                        "provider_response": response.clone(),
                    }),
                })?;
                Ok(response)
            }
            methods::CODEX_TURN_START => {
                let request = serde_json::from_value::<CodexTurnStartRequest>(payload)?;
                let params = request.params;
                let thread_id = params.thread_id.clone();
                let mode = if params.is_plan_mode() {
                    TurnMode::Plan
                } else {
                    TurnMode::Normal
                };
                let response = self.codex.start_turn(params.clone()).await?;
                self.publish_codex_turn_lifecycle_signal(CodexTurnLifecycleSignal {
                    thread_id,
                    turn_id: extract_turn_id_from_value(&response),
                    action: "started",
                    active: true,
                    mode,
                    request: serde_json::to_value(params)?,
                    provider_response: response.clone(),
                    method: "ace/turn/start",
                })?;
                Ok(response)
            }
            methods::CODEX_TURN_STEER => {
                self.codex_json::<CodexTurnSteerRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.steer_turn(request.params).await },
                )
                .await
            }
            methods::CODEX_TURN_PLAN_START => {
                let request = serde_json::from_value::<CodexPlanTurnStartRequest>(payload)?;
                let params = ace_codex::CodexTurnStart::plan(
                    request.thread_id.clone(),
                    request.prompt,
                    request.model,
                );
                let response = self.codex.start_turn(params.clone()).await?;
                self.publish_codex_turn_lifecycle_signal(CodexTurnLifecycleSignal {
                    thread_id: request.thread_id,
                    turn_id: extract_turn_id_from_value(&response),
                    action: "started",
                    active: true,
                    mode: TurnMode::Plan,
                    request: serde_json::to_value(params)?,
                    provider_response: response.clone(),
                    method: "ace/turn/start",
                })?;
                Ok(response)
            }
            methods::CODEX_TURN_INTERRUPT => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.interrupt_turn(request.thread_id.clone()).await?;
                self.publish_codex_turn_lifecycle_signal(CodexTurnLifecycleSignal {
                    thread_id: request.thread_id.clone(),
                    turn_id: extract_turn_id_from_value(&response),
                    action: "interrupted",
                    active: false,
                    mode: TurnMode::Normal,
                    request: json!({ "thread_id": request.thread_id }),
                    provider_response: response.clone(),
                    method: "ace/turn/interrupted",
                })?;
                Ok(response)
            }
            methods::CODEX_PLAN_CONTINUE_IN_THREAD => {
                let request = serde_json::from_value::<CodexPlanImplementationRequest>(payload)?;
                let params = request.params;
                let response = self.codex.continue_plan_in_thread(params.clone()).await?;
                self.publish_codex_plan_implementation_signal(CodexPlanImplementationSignal {
                    implementation: plan_implementation_record_from_codex(
                        &params,
                        params.thread_id.clone(),
                        PlanImplementationMode::ContinueInThread,
                        response.clone(),
                    ),
                    method: "ace/plan/continue_in_thread",
                })?;
                Ok(response)
            }
            methods::CODEX_PLAN_FORK_FOR_IMPLEMENTATION => {
                let request = serde_json::from_value::<CodexPlanImplementationRequest>(payload)?;
                let params = request.params;
                let response = self
                    .codex
                    .fork_plan_for_implementation(params.clone())
                    .await?;
                if let Some(target_thread_id) = extract_thread_id_from_value(&response) {
                    self.publish_codex_plan_implementation_signal(CodexPlanImplementationSignal {
                        implementation: plan_implementation_record_from_codex(
                            &params,
                            target_thread_id,
                            PlanImplementationMode::ForkForImplementation,
                            response.clone(),
                        ),
                        method: "ace/plan/fork_for_implementation",
                    })?;
                }
                Ok(response)
            }
            methods::CODEX_PLAN_SIDE_IMPLEMENTATION => {
                let request = serde_json::from_value::<CodexPlanImplementationRequest>(payload)?;
                let params = request.params;
                let response = self.codex.side_implementation(params.clone()).await?;
                if let Some(target_thread_id) = extract_thread_id_from_value(&response) {
                    self.publish_codex_plan_implementation_signal(CodexPlanImplementationSignal {
                        implementation: plan_implementation_record_from_codex(
                            &params,
                            target_thread_id,
                            PlanImplementationMode::SideImplementation,
                            response.clone(),
                        ),
                        method: "ace/plan/side_implementation",
                    })?;
                }
                Ok(response)
            }
            methods::CODEX_CONFIG_REQUIREMENTS_READ => {
                let response = self.codex.config_requirements_read().await?;
                Ok(response)
            }
            methods::CODEX_COMPATIBILITY_INVENTORY => {
                let adapter_contract = ace_provider_adapter_contract();
                Ok(serde_json::to_value(
                    CodexCompatibilityInventoryResponse::from_specs_and_adapter_coverage(
                        ace_codex::codex_method_inventory().iter().copied(),
                        ace_codex::codex_adapter_contract_coverage(&adapter_contract),
                    ),
                )?)
            }
            methods::CODEX_PERMISSION_PROFILES_LIST => {
                let response = self.codex.permission_profile_list().await?;
                Ok(response)
            }
            methods::CODEX_PERMISSION_CATALOG => {
                let response = self.codex.permission_catalog().await?;
                Ok(serde_json::to_value(response)?)
            }
            methods::CODEX_PERMISSION_PRESET_RESOLVE => {
                let request = serde_json::from_value::<CodexPermissionPresetRequest>(payload)?;
                Ok(serde_json::to_value(
                    self.codex.resolve_permission_preset(request.preset).await?,
                )?)
            }
            methods::CODEX_THREAD_APPROVE_GUARDIAN_DENIED_ACTION => {
                let request =
                    serde_json::from_value::<CodexGuardianDeniedActionApprovalRequest>(payload)?;
                let params = request.params;
                let response = self
                    .codex
                    .approve_guardian_denied_action(params.clone())
                    .await?;
                self.publish_codex_approval_retry_signal(CodexApprovalRetrySignal {
                    retry: approval_retry_record_from_codex(params, response.clone()),
                    method: "ace/approval_retry/guardian_denied_action",
                })?;
                Ok(response)
            }
            methods::CODEX_GOAL_SET => {
                let request = serde_json::from_value::<CodexGoalSetRequest>(payload)?;
                let params = request.params;
                let response = self.codex.goal_set(params.clone()).await?;
                self.publish_codex_goal_signal(CodexGoalSignal {
                    goal: GoalState {
                        thread_id: params.thread_id,
                        status: GoalStatus::Active,
                        objective: Some(params.objective),
                        token_budget: params.token_budget,
                        tokens_used: None,
                        time_used_seconds: None,
                    },
                    method: "ace/goal/set",
                })?;
                Ok(response)
            }
            methods::CODEX_GOAL_GET => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.goal_get(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_GOAL_CLEAR => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.goal_clear(request.thread_id.clone()).await?;
                self.publish_codex_goal_signal(CodexGoalSignal {
                    goal: GoalState {
                        thread_id: request.thread_id,
                        status: GoalStatus::Cleared,
                        objective: None,
                        token_budget: None,
                        tokens_used: None,
                        time_used_seconds: None,
                    },
                    method: "ace/goal/clear",
                })?;
                Ok(response)
            }
            methods::CODEX_GOAL_PAUSE => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.goal_pause(request.thread_id.clone()).await?;
                self.publish_codex_goal_signal(CodexGoalSignal {
                    goal: GoalState {
                        thread_id: request.thread_id,
                        status: GoalStatus::Paused,
                        objective: None,
                        token_budget: None,
                        tokens_used: None,
                        time_used_seconds: None,
                    },
                    method: "ace/goal/pause",
                })?;
                Ok(response)
            }
            methods::CODEX_GOAL_RESUME => {
                let request = serde_json::from_value::<CodexThreadIdRequest>(payload)?;
                let response = self.codex.goal_resume(request.thread_id.clone()).await?;
                self.publish_codex_goal_signal(CodexGoalSignal {
                    goal: GoalState {
                        thread_id: request.thread_id,
                        status: GoalStatus::Active,
                        objective: None,
                        token_budget: None,
                        tokens_used: None,
                        time_used_seconds: None,
                    },
                    method: "ace/goal/resume",
                })?;
                Ok(response)
            }
            methods::CODEX_SUBAGENTS_LIST => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.subagent_list(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_SUBAGENT_READ => {
                self.codex_json::<CodexSubagentThreadRpcRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .subagent_read(
                                request.params.thread_id,
                                request.params.subagent_thread_id,
                            )
                            .await
                    },
                )
                .await
            }
            methods::CODEX_SUBAGENT_STEER => {
                let request = serde_json::from_value::<CodexSubagentSteerRequest>(payload)?;
                let params = request.params;
                let response = self.codex.subagent_steer(params.clone()).await?;
                self.publish_codex_subagent_action_signal(CodexSubagentActionSignal {
                    parent_thread_id: params.thread_id,
                    subagent_thread_id: params.subagent_thread_id,
                    action: "steer",
                    prompt: Some(params.prompt),
                    metadata: json!({ "provider_response": response.clone() }),
                })?;
                Ok(response)
            }
            methods::CODEX_SUBAGENT_STOP => {
                let request = serde_json::from_value::<CodexSubagentThreadRpcRequest>(payload)?;
                let response = self
                    .codex
                    .subagent_stop(
                        request.params.thread_id.clone(),
                        request.params.subagent_thread_id.clone(),
                    )
                    .await?;
                self.publish_codex_subagent_action_signal(CodexSubagentActionSignal {
                    parent_thread_id: request.params.thread_id,
                    subagent_thread_id: request.params.subagent_thread_id,
                    action: "stop",
                    prompt: None,
                    metadata: json!({ "provider_response": response.clone() }),
                })?;
                Ok(response)
            }
            methods::CODEX_SUBAGENT_CLOSE => {
                let request = serde_json::from_value::<CodexSubagentThreadRpcRequest>(payload)?;
                let response = self
                    .codex
                    .subagent_close(
                        request.params.thread_id.clone(),
                        request.params.subagent_thread_id.clone(),
                    )
                    .await?;
                self.publish_codex_subagent_action_signal(CodexSubagentActionSignal {
                    parent_thread_id: request.params.thread_id,
                    subagent_thread_id: request.params.subagent_thread_id,
                    action: "close",
                    prompt: None,
                    metadata: json!({ "provider_response": response.clone() }),
                })?;
                Ok(response)
            }
            methods::CODEX_HANDOFF_TO_AGENT => {
                let request = serde_json::from_value::<CodexHandoffToAgentRequest>(payload)?;
                let source_thread_id = request.params.thread_id.clone();
                let response = self.codex.handoff_to_agent(request.params).await?;
                let handoff = HandoffPlan {
                    source_thread_id,
                    target_location: ExecutionLocation::Local,
                    status: HandoffStatus::Completed,
                    target_thread_id: extract_thread_id_from_value(&response),
                    repo_root: None,
                    worktree_path: None,
                    branch: None,
                    start_point: None,
                    checkpoint_ref: None,
                    remote_host: None,
                    transfer_status: Some("completed".to_string()),
                    interrupted_active_turn: None,
                    metadata: response.clone(),
                };
                self.publish_codex_handoff_signal(CodexHandoffSignal {
                    handoff,
                    method: "ace/handoff/agent",
                    provider_response: response.clone(),
                })?;
                Ok(response)
            }
            methods::CODEX_HANDOFF_TO_LOCATION => {
                let request = serde_json::from_value::<CodexHandoffToLocationRequest>(payload)?;
                self.handoff_codex_to_location(request).await
            }
            methods::CODEX_STDERR_TAIL => {
                let lines = self.codex.stderr_tail().await?;
                Ok(serde_json::to_value(CodexStderrTailResponse { lines })?)
            }
            methods::CODEX_SHUTDOWN => {
                self.codex_json::<CodexShutdownRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .shutdown(Duration::from_millis(request.grace_ms))
                            .await?;
                        Ok(serde_json::json!({ "shutdown": true }))
                    },
                )
                .await
            }
            methods::CODEX_RESTART => {
                self.codex_json::<CodexShutdownRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .restart(Duration::from_millis(request.grace_ms))
                            .await?;
                        Ok(serde_json::json!({ "restarted": true }))
                    },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }

    async fn handoff_codex_to_location(
        &self,
        request: CodexHandoffToLocationRequest,
    ) -> Result<Value, WsDispatchError> {
        if request.target_location != CodexHandoffLocation::Worktree {
            return Err(
                crate::codex::CodexApiError::UnsupportedExecutionLocation(format!(
                    "{:?}",
                    request.target_location
                ))
                .into(),
            );
        }

        let interrupted_active_turn = if self.codex.has_active_turn(&request.thread_id).await {
            self.codex.interrupt_turn(request.thread_id.clone()).await?;
            true
        } else {
            false
        };

        let worktree = self
            .git
            .create_worktree(GitWorktreeCreateRequest {
                repo_path: request.repo_path.clone(),
                preferred_branch: request.preferred_branch,
                start_point: request.start_point.clone(),
            })
            .await?;

        let worktree_path = worktree.path.to_string_lossy().to_string();
        let repo_root = worktree.repo_root.to_string_lossy().to_string();
        let transfer = transfer_handoff_files(Path::new(&request.repo_path), &worktree.path)?;
        let transfer_status = transfer.status.clone();
        let transferred_files = transfer.files.clone();
        let metadata = serde_json::json!({
            "execution_location": "worktree",
            "handoff": {
                "source_thread_id": request.thread_id,
                "worktree_path": worktree_path,
                "worktree_branch": worktree.branch,
                "repo_root": repo_root,
                "transfer_status": transfer_status,
                "transferred_files": transferred_files,
            }
        });
        self.codex
            .update_thread_metadata(request.thread_id.clone(), metadata.clone())
            .await?;
        let handoff = HandoffPlan {
            source_thread_id: request.thread_id.clone(),
            target_location: ExecutionLocation::Worktree,
            status: HandoffStatus::Completed,
            target_thread_id: Some(request.thread_id.clone()),
            repo_root: Some(repo_root.clone()),
            worktree_path: Some(worktree_path.clone()),
            branch: Some(worktree.branch.clone()),
            start_point: request.start_point.clone(),
            checkpoint_ref: None,
            remote_host: None,
            transfer_status: Some(transfer.status),
            interrupted_active_turn: Some(interrupted_active_turn),
            metadata: metadata.clone(),
        };
        self.codex.record_handoff_to_location(handoff.clone()).await;
        self.publish_codex_handoff_signal(CodexHandoffSignal {
            handoff,
            method: "ace/handoff/location",
            provider_response: metadata.clone(),
        })?;

        Ok(serde_json::to_value(CodexHandoffToLocationResponse {
            source_thread_id: request.thread_id.clone(),
            target_location: CodexHandoffLocation::Worktree,
            target_thread_id: Some(request.thread_id),
            worktree_path,
            worktree_branch: worktree.branch,
            repo_root,
            interrupted_active_turn,
            thread_metadata: metadata,
        })?)
    }

    pub(super) async fn dispatch_provider_runtime_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::PROVIDER_RUNTIME_PROVIDERS_LIST => {
                let providers = self.providers.descriptors();
                Ok(serde_json::to_value(ProviderRuntimeProvidersList {
                    runtime: providers
                        .iter()
                        .map(|descriptor| self.provider_runtime_info(descriptor.clone()))
                        .collect(),
                    providers,
                })?)
            }
            methods::PROVIDER_RUNTIME_CONTRACT => {
                Ok(serde_json::to_value(ProviderRuntimeContractReport {
                    adapter_contract: ace_provider_adapter_contract(),
                    reports: self.providers.contract_reports(),
                })?)
            }
            methods::PROVIDER_RUNTIME_ADAPTER_VALIDATE => {
                let request =
                    serde_json::from_value::<ProviderRuntimeAdapterValidateRequest>(payload)?;
                let contract = provider_contract_report(&request.descriptor);
                let adapter_profile = provider_adapter_profile(&request.descriptor);
                Ok(serde_json::to_value(
                    ProviderRuntimeAdapterValidateResponse {
                        descriptor: request.descriptor,
                        contract,
                        adapter_profile,
                    },
                )?)
            }
            methods::PROVIDER_RUNTIME_OPERATIONS_LIST => {
                let request =
                    serde_json::from_value::<ProviderRuntimeOperationsListRequest>(payload)?;
                let providers = self.provider_runtime_filter(request.provider, "operation list")?;
                let adapter_contract = ace_provider_adapter_contract();
                let mut provider_operations = Vec::with_capacity(providers.len());
                for provider in providers {
                    let adapter_profile = self.providers.adapter_profile(provider).ok_or(
                        ace_runtime::provider::ProviderRuntimeError::ProviderUnavailable {
                            provider,
                        },
                    )?;
                    let adapter_runtime = self.providers.adapter_runtime_report(provider).ok_or(
                        ace_runtime::provider::ProviderRuntimeError::ProviderUnavailable {
                            provider,
                        },
                    )?;
                    let status = self.providers.status(provider).await.ok();
                    provider_operations.push(ProviderRuntimeProviderOperations {
                        provider,
                        runtime_id: provider.runtime_id().to_string(),
                        display_name: provider.display_name().to_string(),
                        operations: provider_runtime_operations_for_provider(
                            provider,
                            &adapter_profile,
                            status.as_ref(),
                        ),
                        adapter_profile,
                        adapter_runtime,
                    });
                }
                Ok(serde_json::to_value(
                    ProviderRuntimeOperationsListResponse {
                        adapter_contract,
                        providers: provider_operations,
                    },
                )?)
            }
            methods::PROVIDER_RUNTIME_FEATURES_LIST => {
                let request =
                    serde_json::from_value::<ProviderRuntimeFeaturesListRequest>(payload)?;
                let providers = self.provider_runtime_filter(request.provider, "feature list")?;
                let mut provider_features = Vec::with_capacity(providers.len());
                for provider in providers {
                    let features = self.providers.features(provider).ok_or(
                        ace_runtime::provider::ProviderRuntimeError::ProviderUnavailable {
                            provider,
                        },
                    )?;
                    provider_features.push(ProviderRuntimeProviderFeatures {
                        provider,
                        runtime_id: provider.runtime_id().to_string(),
                        display_name: provider.display_name().to_string(),
                        features,
                    });
                }
                Ok(serde_json::to_value(ProviderRuntimeFeaturesListResponse {
                    providers: provider_features,
                })?)
            }
            methods::PROVIDER_RUNTIME_STATUS_LIST => {
                let request = serde_json::from_value::<ProviderRuntimeStatusListRequest>(payload)?;
                let providers = self.provider_runtime_filter(request.provider, "status list")?;
                let mut provider_statuses = Vec::with_capacity(providers.len());
                for provider in providers {
                    let descriptor = self
                        .providers
                        .get(provider)
                        .ok_or(
                            ace_runtime::provider::ProviderRuntimeError::ProviderUnavailable {
                                provider,
                            },
                        )?
                        .descriptor();
                    let status = self.providers.status(provider).await?;
                    provider_statuses.push(ProviderRuntimeProviderStatus {
                        provider,
                        runtime_id: provider.runtime_id().to_string(),
                        display_name: provider.display_name().to_string(),
                        status,
                        supports_events: self.providers.has_event_source(provider),
                        supports_server_request_responses: self
                            .providers
                            .has_server_request_responder(provider),
                        contract: ace_runtime::provider::provider_contract_report(&descriptor),
                        adapter_profile: self.providers.adapter_profile(provider).ok_or(
                            ace_runtime::provider::ProviderRuntimeError::ProviderUnavailable {
                                provider,
                            },
                        )?,
                        adapter_runtime: self.providers.adapter_runtime_report(provider).ok_or(
                            ace_runtime::provider::ProviderRuntimeError::ProviderUnavailable {
                                provider,
                            },
                        )?,
                    });
                }
                Ok(serde_json::to_value(ProviderRuntimeStatusListResponse {
                    providers: provider_statuses,
                })?)
            }
            methods::PROVIDER_RUNTIME_STATE_GET => {
                let request = serde_json::from_value::<ProviderRuntimeStateGetRequest>(payload)?;
                let requested_provider = request.provider.clone();
                let providers = self.provider_runtime_filter(request.provider, "state get")?;
                let mut provider_states = Vec::with_capacity(providers.len());
                for provider in providers {
                    let (persisted_replay_available, last_persisted_sequence) = {
                        let event_log = self.provider_events.lock().expect("provider event log");
                        (
                            event_log.has_provider_events(provider.runtime_id())?,
                            event_log.last_provider_event_sequence(provider.runtime_id())?,
                        )
                    };
                    if request.source == ProviderRuntimeStateSource::Persisted {
                        let persisted_snapshot = self
                            .provider_events
                            .lock()
                            .expect("provider event log")
                            .runtime_state_snapshot(Some(provider.runtime_id()))?;
                        provider_states.push(ProviderRuntimeProviderState {
                            provider,
                            runtime_id: provider.runtime_id().to_string(),
                            display_name: provider.display_name().to_string(),
                            source: ProviderRuntimeStateSource::Persisted,
                            persisted_replay_available,
                            last_persisted_sequence,
                            state: persisted_snapshot,
                        });
                        continue;
                    }
                    if !self.providers.has_state_source(provider) {
                        if requested_provider.is_some() {
                            return Err(WsDispatchError::BadRequest(format!(
                                "provider `{}` does not expose runtime state",
                                provider.runtime_id()
                            )));
                        }
                        continue;
                    }
                    provider_states.push(ProviderRuntimeProviderState {
                        provider,
                        runtime_id: provider.runtime_id().to_string(),
                        display_name: provider.display_name().to_string(),
                        source: ProviderRuntimeStateSource::Live,
                        persisted_replay_available,
                        last_persisted_sequence,
                        state: self.providers.runtime_state_snapshot(provider).await?,
                    });
                }
                Ok(serde_json::to_value(ProviderRuntimeStateGetResponse {
                    providers: provider_states,
                })?)
            }
            methods::PROVIDER_RUNTIME_LIFECYCLE => {
                let request = serde_json::from_value::<ProviderRuntimeLifecycleRequest>(payload)?;
                let provider =
                    ProviderKind::from_runtime_id(&request.provider).ok_or_else(|| {
                        WsDispatchError::BadRequest(format!(
                            "unknown provider `{}` for runtime lifecycle",
                            request.provider
                        ))
                    })?;
                let result = self
                    .providers
                    .lifecycle_action(
                        provider,
                        request.action,
                        Duration::from_millis(request.grace_ms),
                    )
                    .await?;
                Ok(serde_json::to_value(ProviderRuntimeLifecycleResponse {
                    provider,
                    runtime_id: provider.runtime_id().to_string(),
                    display_name: provider.display_name().to_string(),
                    result,
                })?)
            }
            methods::PROVIDER_RUNTIME_EVENTS_RECENT => {
                let request =
                    serde_json::from_value::<ProviderRuntimeRecentEventsRequest>(payload)?;
                let records = self
                    .provider_events
                    .lock()
                    .expect("provider event log")
                    .recent_or_after_sequence(
                        request.provider.as_deref(),
                        request.from_sequence_exclusive,
                        request.limit,
                    )?
                    .into_iter()
                    .map(|record| {
                        let event = ProviderRuntimeEvent::from_provider_event(
                            &record.provider,
                            record.event.clone(),
                        );
                        ProviderRuntimeEventRecord {
                            sequence: record.sequence,
                            provider: record.provider,
                            created_at: record.created_at,
                            projection_deltas: event.projection_deltas(),
                            event,
                            raw_event_summary: ProviderRuntimeRawEventSummary::from_event(
                                &record.event,
                            ),
                            raw_event: match request.raw_event_mode {
                                ProviderRuntimeRawEventMode::Compact => None,
                                ProviderRuntimeRawEventMode::Full => Some(record.event),
                            },
                        }
                    })
                    .collect();
                Ok(serde_json::to_value(ProviderRuntimeRecentEventsResponse {
                    records,
                })?)
            }
            methods::PROVIDER_RUNTIME_REQUEST => {
                let mut request = serde_json::from_value::<ProviderRuntimeRequest>(payload)?;
                let provider =
                    ProviderKind::from_runtime_id(&request.provider).ok_or_else(|| {
                        WsDispatchError::BadRequest(format!(
                            "unknown provider `{}` for runtime request",
                            request.provider
                        ))
                    })?;
                let adapter_profile = self.providers.adapter_profile(provider).ok_or(
                    ace_runtime::provider::ProviderRuntimeError::ProviderUnavailable { provider },
                )?;
                if let (ProviderKind::Codex, None, Some(operation)) =
                    (provider, request.method.as_ref(), request.operation)
                {
                    validate_provider_runtime_operation(operation, &adapter_profile)?;
                    if let Some(method) = codex_ws_method_for_adapter_operation(operation)? {
                        return self.dispatch_codex_method(method, request.params).await;
                    }
                }
                let method = resolve_provider_runtime_request_method(
                    request.method,
                    request.operation,
                    &adapter_profile,
                )?;
                if provider == ProviderKind::Codex {
                    request.params = user_initiated_codex_params(&method, request.params)?;
                }
                let response = self
                    .providers
                    .request(
                        provider,
                        ProviderRequest {
                            method,
                            params: request.params,
                            timeout: Duration::from_millis(request.timeout_ms),
                        },
                    )
                    .await?;
                Ok(response)
            }
            methods::PROVIDER_RUNTIME_SERVER_REQUESTS_LIST => {
                let request = serde_json::from_value::<ProviderServerRequestsListRequest>(payload)?;
                let status = request.status.map(|status| match status {
                    ProviderServerRequestStatusFilter::Pending => {
                        ProviderServerRequestStatus::Pending
                    }
                    ProviderServerRequestStatusFilter::Resolved => {
                        ProviderServerRequestStatus::Resolved
                    }
                });
                let requests = self
                    .provider_events
                    .lock()
                    .expect("provider event log")
                    .server_requests(
                        request.provider.as_deref(),
                        status,
                        provider_server_request_read_limit(&request),
                    )?
                    .into_iter()
                    .filter(|record| provider_server_request_matches_filters(record, &request))
                    .take(request.limit)
                    .map(provider_server_request_record_to_protocol)
                    .collect();
                Ok(serde_json::to_value(ProviderServerRequestsListResponse {
                    requests,
                })?)
            }
            methods::PROVIDER_RUNTIME_HOST_TOOLS_LIST => {
                Ok(serde_json::to_value(ProviderHostToolsListResponse {
                    tools: self.host_tools.descriptors(),
                })?)
            }
            methods::PROVIDER_RUNTIME_HOST_TOOL_INVOKE_SERVER_REQUEST => {
                let request =
                    serde_json::from_value::<ProviderHostToolInvokeServerRequest>(payload)?;
                let provider_kind =
                    ProviderKind::from_runtime_id(&request.provider).ok_or_else(|| {
                        WsDispatchError::UnknownMethod(format!(
                            "unknown provider `{}` for host tool server request",
                            request.provider
                        ))
                    })?;
                let decision_context = self.server_request_decision_context(
                    &request.provider,
                    &request.request_id,
                    request.audit,
                )?;
                let normalized_request = decision_context.request.as_ref().ok_or_else(|| {
                    WsDispatchError::BadRequest(format!(
                        "provider `{}` server request `{}` is not pending or has no normalized request",
                        request.provider, request.request_id
                    ))
                })?;
                let base_invocation =
                    host_tool_invocation_from_server_request(provider_kind, normalized_request)
                        .map_err(host_tool_dispatch_error)?;
                let invocation = match self
                    .host_tools
                    .invocation_from_server_request(provider_kind, normalized_request)
                {
                    Ok(invocation) => invocation,
                    Err(error) => {
                        return self
                            .respond_host_tool_error(
                                provider_kind,
                                request.provider,
                                request.request_id,
                                decision_context,
                                Some(&base_invocation),
                                error,
                            )
                            .await;
                    }
                };
                let result = match self.host_tools.invoke_invocation(invocation.clone()).await {
                    Ok(result) => result,
                    Err(error) => {
                        return self
                            .respond_host_tool_error(
                                provider_kind,
                                request.provider,
                                request.request_id,
                                decision_context,
                                Some(&invocation),
                                error,
                            )
                            .await;
                    }
                };
                self.providers
                    .respond_server_request_result(
                        provider_kind,
                        request.request_id.clone(),
                        result.output.clone(),
                    )
                    .await?;
                let audit = host_tool_audit(decision_context.audit, &invocation, &result)?;
                let audit_value = serde_json::to_value(&audit)?;
                let decision = ProviderServerRequestDecisionRecord {
                    outcome: "result".to_string(),
                    payload: result.output.clone(),
                    audit: audit_value.clone(),
                };
                self.provider_events
                    .lock()
                    .expect("provider event log")
                    .record_server_request_result(
                        &request.provider,
                        request.request_id.clone(),
                        result.output.clone(),
                        audit_value.clone(),
                    )?;
                self.append_and_publish_provider_events(
                    provider_kind,
                    vec![ProviderEvent::ServerRequestResolved {
                        request_id: request.request_id.clone(),
                        decision: NormalizedServerRequestDecision {
                            outcome: decision.outcome.clone(),
                            payload: decision.payload.clone(),
                            audit: audit_value,
                        },
                        request: decision_context.request.clone(),
                    }],
                )?;
                Ok(serde_json::to_value(
                    ProviderServerRequestDecisionResponse {
                        responded: true,
                        provider: request.provider,
                        request_id: request.request_id,
                        decision,
                        request: decision_context.request,
                    },
                )?)
            }
            methods::PROVIDER_RUNTIME_SERVER_REQUEST_RESULT => {
                let request = serde_json::from_value::<ProviderServerRequestResult>(payload)?;
                let provider_kind =
                    ProviderKind::from_runtime_id(&request.provider).ok_or_else(|| {
                        WsDispatchError::UnknownMethod(format!(
                            "unknown provider `{}` for server request result",
                            request.provider
                        ))
                    })?;
                let decision_context = self.server_request_decision_context(
                    &request.provider,
                    &request.request_id,
                    request.audit,
                )?;
                self.providers
                    .respond_server_request_result(
                        provider_kind,
                        request.request_id.clone(),
                        request.result.clone(),
                    )
                    .await?;
                let audit = serde_json::to_value(&decision_context.audit)?;
                let decision = ProviderServerRequestDecisionRecord {
                    outcome: "result".to_string(),
                    payload: request.result.clone(),
                    audit: audit.clone(),
                };
                self.provider_events
                    .lock()
                    .expect("provider event log")
                    .record_server_request_result(
                        &request.provider,
                        request.request_id.clone(),
                        request.result.clone(),
                        audit.clone(),
                    )?;
                self.append_and_publish_provider_events(
                    provider_kind,
                    vec![ProviderEvent::ServerRequestResolved {
                        request_id: request.request_id.clone(),
                        decision: NormalizedServerRequestDecision {
                            outcome: decision.outcome.clone(),
                            payload: decision.payload.clone(),
                            audit,
                        },
                        request: decision_context.request.clone(),
                    }],
                )?;
                Ok(serde_json::to_value(
                    ProviderServerRequestDecisionResponse {
                        responded: true,
                        provider: request.provider,
                        request_id: request.request_id,
                        decision,
                        request: decision_context.request,
                    },
                )?)
            }
            methods::PROVIDER_RUNTIME_SERVER_REQUEST_ERROR => {
                let request = serde_json::from_value::<ProviderServerRequestError>(payload)?;
                let provider_kind =
                    ProviderKind::from_runtime_id(&request.provider).ok_or_else(|| {
                        WsDispatchError::UnknownMethod(format!(
                            "unknown provider `{}` for server request error",
                            request.provider
                        ))
                    })?;
                let decision_context = self.server_request_decision_context(
                    &request.provider,
                    &request.request_id,
                    request.audit,
                )?;
                self.providers
                    .respond_server_request_error(
                        provider_kind,
                        request.request_id.clone(),
                        request.error.code,
                        request.error.message.clone(),
                    )
                    .await?;
                let error_payload = serde_json::to_value(request.error)?;
                let audit = serde_json::to_value(&decision_context.audit)?;
                let decision = ProviderServerRequestDecisionRecord {
                    outcome: "error".to_string(),
                    payload: error_payload.clone(),
                    audit: audit.clone(),
                };
                self.provider_events
                    .lock()
                    .expect("provider event log")
                    .record_server_request_error(
                        &request.provider,
                        request.request_id.clone(),
                        error_payload.clone(),
                        audit.clone(),
                    )?;
                self.append_and_publish_provider_events(
                    provider_kind,
                    vec![ProviderEvent::ServerRequestResolved {
                        request_id: request.request_id.clone(),
                        decision: NormalizedServerRequestDecision {
                            outcome: decision.outcome.clone(),
                            payload: decision.payload.clone(),
                            audit,
                        },
                        request: decision_context.request.clone(),
                    }],
                )?;
                Ok(serde_json::to_value(
                    ProviderServerRequestDecisionResponse {
                        responded: true,
                        provider: request.provider,
                        request_id: request.request_id,
                        decision,
                        request: decision_context.request,
                    },
                )?)
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }

    fn server_request_decision_context(
        &self,
        provider: &str,
        request_id: &str,
        audit: ProviderServerRequestAudit,
    ) -> Result<ServerRequestDecisionContext, WsDispatchError> {
        let request = self
            .provider_events
            .lock()
            .expect("provider event log")
            .server_request(provider, request_id)?
            .and_then(|record| record.request);
        let audit = enrich_server_request_audit(audit, request.as_ref());
        Ok(ServerRequestDecisionContext {
            request: request.map(Box::new),
            audit,
        })
    }

    async fn respond_host_tool_error(
        &self,
        provider_kind: ProviderKind,
        provider: String,
        request_id: String,
        decision_context: ServerRequestDecisionContext,
        invocation: Option<&HostToolInvocation>,
        error: HostToolError,
    ) -> Result<Value, WsDispatchError> {
        let error_message = error.to_string();
        let error_payload = json!({
            "code": host_tool_provider_error_code(&error),
            "message": error_message,
        });
        self.providers
            .respond_server_request_error(
                provider_kind,
                request_id.clone(),
                host_tool_provider_error_code(&error),
                error_message.clone(),
            )
            .await?;
        let audit = host_tool_error_audit(decision_context.audit, invocation, &error)?;
        let audit_value = serde_json::to_value(&audit)?;
        let decision = ProviderServerRequestDecisionRecord {
            outcome: "error".to_string(),
            payload: error_payload.clone(),
            audit: audit_value.clone(),
        };
        self.provider_events
            .lock()
            .expect("provider event log")
            .record_server_request_error(
                &provider,
                request_id.clone(),
                error_payload.clone(),
                audit_value.clone(),
            )?;
        self.append_and_publish_provider_events(
            provider_kind,
            vec![ProviderEvent::ServerRequestResolved {
                request_id: request_id.clone(),
                decision: NormalizedServerRequestDecision {
                    outcome: decision.outcome.clone(),
                    payload: decision.payload.clone(),
                    audit: audit_value,
                },
                request: decision_context.request.clone(),
            }],
        )?;
        Ok(serde_json::to_value(
            ProviderServerRequestDecisionResponse {
                responded: true,
                provider,
                request_id,
                decision,
                request: decision_context.request,
            },
        )?)
    }

    fn append_and_publish_provider_events(
        &self,
        provider_kind: ProviderKind,
        events: Vec<ProviderEvent>,
    ) -> Result<(), WsDispatchError> {
        if events.is_empty() {
            return Ok(());
        }

        let provider_name = provider_kind.runtime_id().to_string();
        let records = self
            .provider_events
            .lock()
            .expect("provider event log")
            .append_batch(&provider_name, &events)?;
        let last_persisted_sequence = records.last().map(|record| record.sequence);
        if let Some(sender) = self
            .provider_event_streams
            .lock()
            .expect("provider event streams")
            .get(&provider_kind)
        {
            let _ = sender.send(ProviderEventStreamMessage::Events {
                events,
                last_persisted_sequence,
            });
        }
        Ok(())
    }

    fn publish_codex_versioned_tool_event(
        &self,
        ws_method: &str,
        codex_method: &str,
        params: &Value,
        result: Option<&Value>,
        status: ToolRunStatus,
    ) -> Result<(), WsDispatchError> {
        let Some(tool) = semantic_tool_for_codex_versioned_request(
            ws_method,
            codex_method,
            params,
            result,
            status,
        ) else {
            return Ok(());
        };
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::SemanticTool {
                tool: Box::new(tool),
            }],
        )
    }

    fn publish_codex_thread_lifecycle_signal(
        &self,
        signal: CodexThreadLifecycleSignal,
    ) -> Result<(), WsDispatchError> {
        let raw_payload = json!({
            "threadId": signal.thread_id.clone(),
            "status": signal.status,
            "name": signal.name.clone(),
            "active": signal.active,
            "archived": signal.archived,
            "metadata": signal.metadata.clone(),
        });
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ThreadLifecycleChanged,
                    thread_id: Some(signal.thread_id),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some(signal.status.to_string()),
                    name: signal.name,
                    active: signal.active,
                    archived: signal.archived,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: signal.metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some("ace/thread_lifecycle".to_string()),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    fn publish_codex_turn_lifecycle_signal(
        &self,
        signal: CodexTurnLifecycleSignal,
    ) -> Result<(), WsDispatchError> {
        let mode = turn_mode_key(signal.mode);
        let metadata = json!({
            "action": signal.action,
            "mode": mode,
            "request": signal.request,
            "provider_response": signal.provider_response,
        });
        let raw_payload = metadata.clone();
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::TurnLifecycleChanged,
                    thread_id: Some(signal.thread_id),
                    turn_id: signal.turn_id,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some(signal.action.to_string()),
                    name: None,
                    active: Some(signal.active),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some(signal.method.to_string()),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    fn publish_codex_review_mode_signal(
        &self,
        signal: CodexReviewModeSignal,
    ) -> Result<(), WsDispatchError> {
        let metadata = json!({
            "request": signal.request,
            "provider_response": signal.provider_response,
        });
        let raw_payload = metadata.clone();
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ReviewModeUpdated,
                    thread_id: Some(signal.thread_id),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some(signal.status.to_string()),
                    name: None,
                    active: Some(signal.active),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some(signal.method.to_string()),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    fn publish_codex_subagent_action_signal(
        &self,
        signal: CodexSubagentActionSignal,
    ) -> Result<(), WsDispatchError> {
        let metadata = json!({
            "subagent_thread_id": signal.subagent_thread_id.clone(),
            "provider_response": signal.metadata.get("provider_response").cloned().unwrap_or(Value::Null),
        });
        let raw_payload = json!({
            "threadId": signal.parent_thread_id.clone(),
            "subagentThreadId": signal.subagent_thread_id.clone(),
            "action": signal.action,
            "prompt": signal.prompt.clone(),
            "metadata": metadata.clone(),
        });
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::SubagentAction,
                    thread_id: Some(signal.parent_thread_id),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: signal.prompt,
                    audio: None,
                    status: Some(signal.action.to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some(format!("ace/subagent/{}", signal.action)),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    fn publish_codex_handoff_signal(
        &self,
        signal: CodexHandoffSignal,
    ) -> Result<(), WsDispatchError> {
        let handoff = serde_json::to_value(&signal.handoff)?;
        let metadata = json!({
            "handoff": handoff,
            "provider_response": signal.provider_response,
        });
        let raw_payload = metadata.clone();
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::HandoffUpdated,
                    thread_id: Some(signal.handoff.source_thread_id),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("completed".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some(signal.method.to_string()),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    fn publish_codex_plan_implementation_signal(
        &self,
        signal: CodexPlanImplementationSignal,
    ) -> Result<(), WsDispatchError> {
        let implementation = serde_json::to_value(&signal.implementation)?;
        let metadata = json!({
            "plan_implementation": implementation,
        });
        let raw_payload = metadata.clone();
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::PlanImplementationUpdated,
                    thread_id: Some(signal.implementation.parent_thread_id),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: Some(signal.implementation.prompt),
                    audio: None,
                    status: Some(plan_implementation_mode_key(signal.implementation.mode)),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some(signal.method.to_string()),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    fn publish_codex_approval_retry_signal(
        &self,
        signal: CodexApprovalRetrySignal,
    ) -> Result<(), WsDispatchError> {
        let retry = serde_json::to_value(&signal.retry)?;
        let metadata = json!({
            "approval_retry": retry,
        });
        let raw_payload = metadata.clone();
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ApprovalRetryRecorded,
                    thread_id: Some(signal.retry.thread_id),
                    turn_id: None,
                    item_id: signal.retry.item_id,
                    message: signal.retry.reason.clone(),
                    from_model: None,
                    to_model: None,
                    reason: signal.retry.reason,
                    text: None,
                    audio: None,
                    status: Some(if signal.retry.approved {
                        "approved".to_string()
                    } else {
                        "rejected".to_string()
                    }),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some(signal.method.to_string()),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    fn publish_codex_goal_signal(&self, signal: CodexGoalSignal) -> Result<(), WsDispatchError> {
        let status = goal_status_key(signal.goal.status).to_string();
        let thread_id = signal.goal.thread_id.clone();
        let text = signal.goal.objective.clone();
        let goal = serde_json::to_value(&signal.goal)?;
        let metadata = json!({
            "goal": goal,
        });
        let raw_payload = metadata.clone();
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::GoalUpdated,
                    thread_id: Some(thread_id),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text,
                    audio: None,
                    status: Some(status),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some(signal.method.to_string()),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    fn publish_codex_fork_signal(&self, signal: CodexForkSignal) -> Result<(), WsDispatchError> {
        let thread_id = signal.fork.parent_thread_id.clone();
        let turn_id = signal.fork.turn_id.clone();
        let fork = serde_json::to_value(&signal.fork)?;
        let metadata = json!({
            "fork": fork,
            "ephemeral": signal.ephemeral,
            "provider_response": signal.provider_response,
        });
        let raw_payload = metadata.clone();
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ForkUpdated,
                    thread_id: Some(thread_id),
                    turn_id,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("created".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some(signal.method.to_string()),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    fn publish_codex_side_chat_signal(
        &self,
        signal: CodexSideChatSignal,
    ) -> Result<(), WsDispatchError> {
        let thread_id = signal.side_chat.thread_id.clone();
        let side_chat = serde_json::to_value(&signal.side_chat)?;
        let metadata = json!({
            "side_chat": side_chat,
            "provider_response": signal.provider_response,
        });
        let raw_payload = metadata.clone();
        self.append_and_publish_provider_events(
            ProviderKind::Codex,
            vec![ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::SideChatUpdated,
                    thread_id: Some(thread_id),
                    turn_id: signal.turn_id,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("created".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata,
                    provider: ProviderMetadata {
                        provider: ProviderKind::Codex.runtime_id().to_string(),
                        method: Some(signal.method.to_string()),
                        schema_version: None,
                        raw_payload,
                    },
                }),
            }],
        )
    }

    pub(super) async fn subscribe_provider_runtime_events(
        &self,
        payload: Value,
        outbound: Option<mpsc::Sender<String>>,
    ) -> Result<Value, WsDispatchError> {
        let request = serde_json::from_value::<ProviderRuntimeSubscribeRequest>(payload)?;
        let Some(provider_kind) = request
            .provider
            .as_deref()
            .map_or(Some(ProviderKind::Codex), ProviderKind::from_runtime_id)
        else {
            return Ok(serde_json::json!({ "subscribed": false }));
        };
        if !self.providers.has_event_source(provider_kind) {
            return Ok(serde_json::json!({
                "subscribed": false,
                "provider": provider_kind.runtime_id()
            }));
        }
        let Some(outbound) = outbound else {
            return Ok(serde_json::json!({ "subscribed": false }));
        };

        let provider_name = provider_kind.runtime_id().to_string();
        let response_provider = provider_name.clone();
        let raw_event_mode = request.raw_event_mode;
        let mut receiver = self.provider_event_receiver(provider_kind);
        let replay_records = if request.from_sequence_exclusive.is_some() {
            self.provider_events
                .lock()
                .expect("provider event log")
                .recent_or_after_sequence(
                    Some(provider_kind.runtime_id()),
                    request.from_sequence_exclusive,
                    request.replay_limit,
                )?
        } else {
            Vec::new()
        };
        tokio::spawn(async move {
            let replay_watermark = replay_records.last().map(|record| record.sequence);
            let replay_events = replay_records
                .into_iter()
                .map(|record| record.event)
                .collect::<Vec<_>>();
            if !replay_events.is_empty()
                && send_provider_runtime_event_batch(
                    &outbound,
                    &provider_name,
                    replay_events,
                    raw_event_mode,
                    replay_watermark,
                )
                .await
                .is_err()
            {
                return;
            }
            loop {
                let message = match receiver.recv().await {
                    Ok(message) => message,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        let events = vec![provider_stream_lag_event(&provider_name, skipped)];
                        if send_provider_runtime_event_batch(
                            &outbound,
                            &provider_name,
                            events,
                            raw_event_mode,
                            None,
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let (events, last_persisted_sequence) = match message {
                    ProviderEventStreamMessage::Events {
                        events,
                        last_persisted_sequence,
                    } => (events, last_persisted_sequence),
                    ProviderEventStreamMessage::Error { code, message } => {
                        let response = WsServerResponse {
                            version: PROTOCOL_VERSION,
                            request_id: String::new(),
                            payload: WsServerPayload::Error { code, message },
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
                if send_provider_runtime_event_batch(
                    &outbound,
                    &provider_name,
                    events,
                    raw_event_mode,
                    last_persisted_sequence,
                )
                .await
                .is_err()
                {
                    break;
                }
            }
        });
        Ok(serde_json::json!({ "subscribed": true, "provider": response_provider }))
    }

    fn provider_runtime_info(
        &self,
        descriptor: ace_runtime::provider::ProviderDescriptor,
    ) -> ProviderRuntimeProviderInfo {
        let provider = descriptor.kind;
        let adapter_profile = self
            .providers
            .adapter_profile(provider)
            .unwrap_or_else(|| ace_runtime::provider::provider_adapter_profile(&descriptor));
        let adapter_runtime = self
            .providers
            .adapter_runtime_report(provider)
            .unwrap_or_else(|| ace_runtime::provider::ProviderAdapterRuntimeReport {
                provider,
                satisfies_required_hooks: false,
                hooks: Vec::new(),
                missing_required_hooks: Vec::new(),
            });
        ProviderRuntimeProviderInfo {
            provider,
            runtime_id: provider.runtime_id().to_string(),
            display_name: provider.display_name().to_string(),
            supports_events: self.providers.has_event_source(provider),
            supports_server_request_responses: self
                .providers
                .has_server_request_responder(provider),
            contract: ace_runtime::provider::provider_contract_report(&descriptor),
            adapter_profile,
            adapter_runtime,
            descriptor,
        }
    }

    fn provider_runtime_filter(
        &self,
        provider: Option<String>,
        label: &str,
    ) -> Result<Vec<ProviderKind>, WsDispatchError> {
        match provider {
            Some(provider) => {
                let provider = ProviderKind::from_runtime_id(&provider).ok_or_else(|| {
                    WsDispatchError::BadRequest(format!(
                        "unknown provider `{provider}` for runtime {label}"
                    ))
                })?;
                Ok(vec![provider])
            }
            None => Ok(self
                .providers
                .descriptors()
                .into_iter()
                .map(|descriptor| descriptor.kind)
                .collect()),
        }
    }

    fn provider_event_receiver(
        &self,
        provider_kind: ProviderKind,
    ) -> broadcast::Receiver<ProviderEventStreamMessage> {
        let mut streams = self
            .provider_event_streams
            .lock()
            .expect("provider event streams");
        if let Some(sender) = streams.get(&provider_kind) {
            return sender.subscribe();
        }

        let (sender, receiver) = broadcast::channel(1024);
        streams.insert(provider_kind, sender.clone());
        drop(streams);

        let providers = self.providers.clone();
        let provider_events = Arc::clone(&self.provider_events);
        let provider_streams = Arc::clone(&self.provider_event_streams);
        let provider_name = provider_kind.runtime_id().to_string();
        tokio::spawn(async move {
            loop {
                let events = match providers.next_events(provider_kind).await {
                    Ok(Some(events)) => events,
                    Ok(None) => break,
                    Err(error) => {
                        let _ = sender.send(ProviderEventStreamMessage::Error {
                            code: provider_runtime_error_code(&error).to_string(),
                            message: error.to_string(),
                        });
                        break;
                    }
                };
                if events.is_empty() {
                    continue;
                }
                let append_result = provider_events
                    .lock()
                    .expect("provider event log")
                    .append_batch(&provider_name, &events);
                let records = match append_result {
                    Ok(records) => records,
                    Err(error) => {
                        let _ = sender.send(ProviderEventStreamMessage::Error {
                            code: "persistence_error".to_string(),
                            message: error.to_string(),
                        });
                        break;
                    }
                };
                let last_persisted_sequence = records.last().map(|record| record.sequence);
                let _ = sender.send(ProviderEventStreamMessage::Events {
                    events,
                    last_persisted_sequence,
                });
            }
            provider_streams
                .lock()
                .expect("provider event streams")
                .remove(&provider_kind);
        });
        receiver
    }
}

async fn send_provider_runtime_event_batch(
    outbound: &mpsc::Sender<String>,
    provider_name: &str,
    events: Vec<ProviderEvent>,
    raw_event_mode: ProviderRuntimeRawEventMode,
    last_persisted_sequence: Option<i64>,
) -> Result<(), mpsc::error::SendError<String>> {
    let batch = provider_runtime_event_batch(
        provider_name,
        events,
        raw_event_mode,
        last_persisted_sequence,
    );
    let response = WsServerResponse {
        version: PROTOCOL_VERSION,
        request_id: String::new(),
        payload: WsServerPayload::Event {
            topic: PROVIDER_RUNTIME_EVENT_TOPIC.to_string(),
            body: serde_json::to_value(batch).expect("serialize provider runtime websocket event"),
        },
    };
    let text =
        serde_json::to_string(&response).expect("serialize provider runtime websocket frame");
    outbound.send(text).await
}

fn provider_runtime_event_batch(
    provider_name: &str,
    events: Vec<ProviderEvent>,
    raw_event_mode: ProviderRuntimeRawEventMode,
    last_persisted_sequence: Option<i64>,
) -> ProviderRuntimeEventBatch {
    let runtime_events = events
        .iter()
        .cloned()
        .map(|event| ProviderRuntimeEvent::from_provider_event(provider_name, event))
        .collect::<Vec<_>>();
    let projection_deltas = projection_deltas_for_events(&runtime_events);
    let raw_event_summaries = events
        .iter()
        .map(ProviderRuntimeRawEventSummary::from_event)
        .collect::<Vec<_>>();
    ProviderRuntimeEventBatch {
        provider: provider_name.to_string(),
        last_persisted_sequence,
        events: runtime_events,
        projection_deltas,
        raw_event_summaries,
        raw_events: match raw_event_mode {
            ProviderRuntimeRawEventMode::Compact => None,
            ProviderRuntimeRawEventMode::Full => Some(events),
        },
    }
}

fn provider_stream_lag_event(provider_name: &str, skipped: u64) -> ProviderEvent {
    let message = format!("Provider runtime subscriber skipped {skipped} event batch(es)");
    let raw_payload = json!({
        "provider": provider_name,
        "skipped_event_batches": skipped,
    });
    ProviderEvent::RuntimeSignal {
        signal: Box::new(NormalizedRuntimeSignal {
            kind: RuntimeSignalKind::Warning,
            thread_id: None,
            turn_id: None,
            item_id: None,
            message: Some(message),
            from_model: None,
            to_model: None,
            reason: Some("provider_runtime_subscriber_lagged".to_string()),
            text: None,
            audio: None,
            status: Some("lagged".to_string()),
            name: None,
            active: None,
            archived: None,
            diff: None,
            files: None,
            process_id: None,
            exit_code: None,
            request_id: None,
            metadata: json!({
                "skipped_event_batches": skipped,
                "source": "provider_runtime_subscription",
            }),
            provider: ProviderMetadata {
                provider: provider_name.to_string(),
                method: Some("ace/provider_runtime/subscriber_lagged".to_string()),
                schema_version: None,
                raw_payload,
            },
        }),
    }
}

struct CodexThreadLifecycleSignal {
    thread_id: String,
    status: &'static str,
    name: Option<String>,
    active: Option<bool>,
    archived: Option<bool>,
    metadata: Value,
}

struct CodexTurnLifecycleSignal {
    thread_id: String,
    turn_id: Option<String>,
    action: &'static str,
    active: bool,
    mode: TurnMode,
    request: Value,
    provider_response: Value,
    method: &'static str,
}

struct CodexReviewModeSignal {
    thread_id: String,
    active: bool,
    status: &'static str,
    request: Value,
    provider_response: Value,
    method: &'static str,
}

struct CodexSubagentActionSignal {
    parent_thread_id: String,
    subagent_thread_id: String,
    action: &'static str,
    prompt: Option<String>,
    metadata: Value,
}

struct CodexHandoffSignal {
    handoff: HandoffPlan,
    method: &'static str,
    provider_response: Value,
}

struct CodexPlanImplementationSignal {
    implementation: PlanImplementationRecord,
    method: &'static str,
}

struct CodexApprovalRetrySignal {
    retry: ApprovalRetryRecord,
    method: &'static str,
}

struct CodexGoalSignal {
    goal: GoalState,
    method: &'static str,
}

struct CodexForkSignal {
    fork: ForkPoint,
    ephemeral: bool,
    method: &'static str,
    provider_response: Value,
}

struct CodexSideChatSignal {
    side_chat: SideChat,
    turn_id: Option<String>,
    method: &'static str,
    provider_response: Value,
}

fn goal_status_key(status: GoalStatus) -> &'static str {
    match status {
        GoalStatus::Active => "active",
        GoalStatus::Paused => "paused",
        GoalStatus::Blocked => "blocked",
        GoalStatus::UsageLimited => "usage_limited",
        GoalStatus::BudgetLimited => "budget_limited",
        GoalStatus::Complete => "complete",
        GoalStatus::Cleared => "cleared",
    }
}

fn turn_mode_key(mode: TurnMode) -> &'static str {
    match mode {
        TurnMode::Normal => "normal",
        TurnMode::Plan => "plan",
    }
}

fn extract_thread_id_from_value(value: &Value) -> Option<String> {
    value
        .pointer("/thread/id")
        .or_else(|| value.pointer("/thread/threadId"))
        .or_else(|| value.get("threadId"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn extract_turn_id_from_value(value: &Value) -> Option<String> {
    value
        .pointer("/turn/id")
        .or_else(|| value.pointer("/turn/turnId"))
        .or_else(|| value.get("turnId"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn plan_implementation_record_from_codex(
    request: &ace_codex::CodexPlanImplementation,
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
        cwd: request.cwd.clone(),
        plan: request.plan.clone(),
        sandbox_policy: request.sandbox_policy.clone().unwrap_or(Value::Null),
        approval_policy: request.approval_policy.clone().unwrap_or(Value::Null),
        approvals_reviewer: request.approvals_reviewer.clone(),
        provider_response,
    }
}

fn plan_implementation_mode_key(mode: PlanImplementationMode) -> String {
    match mode {
        PlanImplementationMode::ContinueInThread => "continue_in_thread",
        PlanImplementationMode::ForkForImplementation => "fork_for_implementation",
        PlanImplementationMode::SideImplementation => "side_implementation",
    }
    .to_string()
}

fn approval_retry_record_from_codex(
    request: ace_codex::CodexGuardianDeniedActionApproval,
    provider_response: Value,
) -> ApprovalRetryRecord {
    ApprovalRetryRecord {
        thread_id: request.thread_id,
        item_id: request.item_id,
        action_id: request.action_id,
        approved: request.approved,
        reason: request.reason,
        audit: request.audit,
        provider_response,
    }
}

fn validate_provider_runtime_operation(
    operation: ProviderAdapterOperation,
    adapter_profile: &ProviderAdapterProfile,
) -> Result<(), WsDispatchError> {
    match adapter_profile
        .resolve_request_operation(operation)
        .map_err(|error| WsDispatchError::BadRequest(error.to_string()))?
    {
        ProviderAdapterRequestResolution::Deferred => Err(WsDispatchError::BadRequest(format!(
            "provider `{}` adapter operation `{operation:?}` is intentionally deferred",
            adapter_profile.provider.runtime_id()
        ))),
        ProviderAdapterRequestResolution::EventStream => Err(WsDispatchError::BadRequest(format!(
            "provider `{}` adapter operation `{operation:?}` is event-stream driven; subscribe to provider runtime events",
            adapter_profile.provider.runtime_id()
        ))),
        ProviderAdapterRequestResolution::DirectProviderMethod { .. }
        | ProviderAdapterRequestResolution::TypedApi
        | ProviderAdapterRequestResolution::CompositeTypedApi { .. } => Ok(()),
    }
}

fn codex_ws_method_for_adapter_operation(
    operation: ProviderAdapterOperation,
) -> Result<Option<&'static str>, WsDispatchError> {
    let method = match operation {
        ProviderAdapterOperation::RawRequest => methods::CODEX_RAW_REQUEST,
        ProviderAdapterOperation::ThreadStart => methods::CODEX_THREAD_START,
        ProviderAdapterOperation::ThreadResume => methods::CODEX_THREAD_RESUME,
        ProviderAdapterOperation::ThreadRead => methods::CODEX_THREAD_READ,
        ProviderAdapterOperation::ThreadList => methods::CODEX_THREADS_LIST,
        ProviderAdapterOperation::ThreadLoadedList => methods::CODEX_THREADS_LOADED_LIST,
        ProviderAdapterOperation::ThreadArchive => methods::CODEX_THREAD_ARCHIVE,
        ProviderAdapterOperation::ThreadUnarchive => methods::CODEX_THREAD_UNARCHIVE,
        ProviderAdapterOperation::ThreadDelete => methods::CODEX_THREAD_DELETE,
        ProviderAdapterOperation::ThreadUnsubscribe => methods::CODEX_THREAD_UNSUBSCRIBE,
        ProviderAdapterOperation::ThreadSetName => methods::CODEX_THREAD_SET_NAME,
        ProviderAdapterOperation::ThreadUpdateMetadata => methods::CODEX_THREAD_UPDATE_METADATA,
        ProviderAdapterOperation::ThreadCompact => methods::CODEX_THREAD_COMPACT,
        ProviderAdapterOperation::ThreadRollback => methods::CODEX_THREAD_ROLLBACK,
        ProviderAdapterOperation::ThreadInjectItems => methods::CODEX_THREAD_INJECT_ITEMS,
        ProviderAdapterOperation::TurnStart => methods::CODEX_TURN_START,
        ProviderAdapterOperation::TurnSteer => methods::CODEX_TURN_STEER,
        ProviderAdapterOperation::TurnInterrupt => methods::CODEX_TURN_INTERRUPT,
        ProviderAdapterOperation::PlanStart => methods::CODEX_TURN_PLAN_START,
        ProviderAdapterOperation::PlanContinueInThread => methods::CODEX_PLAN_CONTINUE_IN_THREAD,
        ProviderAdapterOperation::PlanForkForImplementation => {
            methods::CODEX_PLAN_FORK_FOR_IMPLEMENTATION
        }
        ProviderAdapterOperation::PlanSideImplementation => methods::CODEX_PLAN_SIDE_IMPLEMENTATION,
        ProviderAdapterOperation::ForkThread => methods::CODEX_THREAD_FORK,
        ProviderAdapterOperation::SideChatStart => methods::CODEX_SIDE_CHAT_START,
        ProviderAdapterOperation::GoalSet => methods::CODEX_GOAL_SET,
        ProviderAdapterOperation::GoalGet => methods::CODEX_GOAL_GET,
        ProviderAdapterOperation::GoalClear => methods::CODEX_GOAL_CLEAR,
        ProviderAdapterOperation::GoalPause => methods::CODEX_GOAL_PAUSE,
        ProviderAdapterOperation::GoalResume => methods::CODEX_GOAL_RESUME,
        ProviderAdapterOperation::SubagentList => methods::CODEX_SUBAGENTS_LIST,
        ProviderAdapterOperation::SubagentRead => methods::CODEX_SUBAGENT_READ,
        ProviderAdapterOperation::SubagentSteer => methods::CODEX_SUBAGENT_STEER,
        ProviderAdapterOperation::SubagentStop => methods::CODEX_SUBAGENT_STOP,
        ProviderAdapterOperation::SubagentClose => methods::CODEX_SUBAGENT_CLOSE,
        ProviderAdapterOperation::HandoffToAgent => methods::CODEX_HANDOFF_TO_AGENT,
        ProviderAdapterOperation::HandoffToLocation => methods::CODEX_HANDOFF_TO_LOCATION,
        ProviderAdapterOperation::PermissionRequirementsRead => {
            methods::CODEX_CONFIG_REQUIREMENTS_READ
        }
        ProviderAdapterOperation::PermissionProfilesList => methods::CODEX_PERMISSION_PROFILES_LIST,
        ProviderAdapterOperation::PermissionPresetResolve => {
            methods::CODEX_PERMISSION_PRESET_RESOLVE
        }
        ProviderAdapterOperation::GuardianDeniedActionApprove => {
            methods::CODEX_THREAD_APPROVE_GUARDIAN_DENIED_ACTION
        }
        ProviderAdapterOperation::ReviewStart => methods::CODEX_REVIEW_START,
        ProviderAdapterOperation::ThreadShellCommand => methods::CODEX_THREAD_SHELL_COMMAND,
        ProviderAdapterOperation::CommandExec => methods::CODEX_COMMAND_EXEC,
        ProviderAdapterOperation::CommandWriteStdin => methods::CODEX_COMMAND_WRITE_STDIN,
        ProviderAdapterOperation::CommandResize => methods::CODEX_COMMAND_RESIZE,
        ProviderAdapterOperation::CommandTerminate => methods::CODEX_COMMAND_TERMINATE,
        ProviderAdapterOperation::ProcessList => methods::CODEX_PROCESS_LIST,
        ProviderAdapterOperation::ProcessClean => methods::CODEX_PROCESS_CLEAN,
        ProviderAdapterOperation::FsReadFile => methods::CODEX_FS_READ_FILE,
        ProviderAdapterOperation::FsWriteFile => methods::CODEX_FS_WRITE_FILE,
        ProviderAdapterOperation::FsReadDirectory => methods::CODEX_FS_READ_DIRECTORY,
        ProviderAdapterOperation::FsCreateDirectory => methods::CODEX_FS_CREATE_DIRECTORY,
        ProviderAdapterOperation::FsCopy => methods::CODEX_FS_COPY,
        ProviderAdapterOperation::FsRemove => methods::CODEX_FS_REMOVE,
        ProviderAdapterOperation::FsMetadata => methods::CODEX_FS_METADATA,
        ProviderAdapterOperation::FsWatch => methods::CODEX_FS_WATCH,
        ProviderAdapterOperation::FsUnwatch => methods::CODEX_FS_UNWATCH,
        ProviderAdapterOperation::McpStatus => methods::CODEX_MCP_STATUS,
        ProviderAdapterOperation::McpResourceRead => methods::CODEX_MCP_RESOURCE_READ,
        ProviderAdapterOperation::McpOauthLogin => methods::CODEX_MCP_OAUTH_LOGIN,
        ProviderAdapterOperation::McpToolCall => methods::CODEX_MCP_TOOL_CALL,
        ProviderAdapterOperation::SkillsList => methods::CODEX_SKILLS_LIST,
        ProviderAdapterOperation::SkillsRead => methods::CODEX_SKILLS_READ,
        ProviderAdapterOperation::SkillsInstall => methods::CODEX_SKILLS_INSTALL,
        ProviderAdapterOperation::SkillsConfigWrite => methods::CODEX_SKILLS_CONFIG_WRITE,
        ProviderAdapterOperation::SkillsExtraRootsSet => methods::CODEX_SKILLS_EXTRA_ROOTS_SET,
        ProviderAdapterOperation::PluginsInstalled => methods::CODEX_PLUGINS_INSTALLED,
        ProviderAdapterOperation::PluginsList => methods::CODEX_PLUGINS_LIST,
        ProviderAdapterOperation::PluginsRead => methods::CODEX_PLUGINS_READ,
        ProviderAdapterOperation::PluginsInstall => methods::CODEX_PLUGINS_INSTALL,
        ProviderAdapterOperation::PluginsUninstall => methods::CODEX_PLUGINS_UNINSTALL,
        ProviderAdapterOperation::PluginShareCheckout => methods::CODEX_PLUGIN_SHARE_CHECKOUT,
        ProviderAdapterOperation::PluginShareDelete => methods::CODEX_PLUGIN_SHARE_DELETE,
        ProviderAdapterOperation::PluginShareList => methods::CODEX_PLUGIN_SHARE_LIST,
        ProviderAdapterOperation::PluginShareSave => methods::CODEX_PLUGIN_SHARE_SAVE,
        ProviderAdapterOperation::PluginShareUpdateTargets => {
            methods::CODEX_PLUGIN_SHARE_UPDATE_TARGETS
        }
        ProviderAdapterOperation::AppsList => methods::CODEX_APPS_LIST,
        ProviderAdapterOperation::AppsConfigWrite => methods::CODEX_APPS_CONFIG_WRITE,
        ProviderAdapterOperation::AccountLoginStart => methods::CODEX_ACCOUNT_LOGIN_START,
        ProviderAdapterOperation::AccountLoginCancel => methods::CODEX_ACCOUNT_LOGIN_CANCEL,
        ProviderAdapterOperation::AccountLogout => methods::CODEX_ACCOUNT_LOGOUT,
        ProviderAdapterOperation::AccountRead => methods::CODEX_ACCOUNT_READ,
        ProviderAdapterOperation::AccountRateLimitResetCreditConsume => {
            methods::CODEX_ACCOUNT_RATE_LIMIT_RESET_CREDIT_CONSUME
        }
        ProviderAdapterOperation::AccountRateLimitsRead => methods::CODEX_ACCOUNT_RATE_LIMITS_READ,
        ProviderAdapterOperation::AccountUsageRead => methods::CODEX_ACCOUNT_USAGE_READ,
        ProviderAdapterOperation::AccountSendAddCreditsNudgeEmail => {
            methods::CODEX_ACCOUNT_SEND_ADD_CREDITS_NUDGE_EMAIL
        }
        ProviderAdapterOperation::WindowsSandboxReadiness => {
            methods::CODEX_WINDOWS_SANDBOX_READINESS
        }
        ProviderAdapterOperation::WindowsSandboxSetupStart => {
            methods::CODEX_WINDOWS_SANDBOX_SETUP_START
        }
        ProviderAdapterOperation::ConfigRead => methods::CODEX_CONFIG_READ,
        ProviderAdapterOperation::ConfigValueWrite => methods::CODEX_CONFIG_VALUE_WRITE,
        ProviderAdapterOperation::ConfigBatchWrite => methods::CODEX_CONFIG_BATCH_WRITE,
        ProviderAdapterOperation::ConfigMcpServerReload => methods::CODEX_CONFIG_MCP_SERVER_RELOAD,
        ProviderAdapterOperation::ExperimentalFeatureList => {
            methods::CODEX_EXPERIMENTAL_FEATURE_LIST
        }
        ProviderAdapterOperation::ExperimentalFeatureEnablementSet => {
            methods::CODEX_EXPERIMENTAL_FEATURE_ENABLEMENT_SET
        }
        ProviderAdapterOperation::ExternalAgentConfigDetect => {
            methods::CODEX_EXTERNAL_AGENT_CONFIG_DETECT
        }
        ProviderAdapterOperation::ExternalAgentConfigImport => {
            methods::CODEX_EXTERNAL_AGENT_CONFIG_IMPORT
        }
        ProviderAdapterOperation::FeedbackUpload => methods::CODEX_FEEDBACK_UPLOAD,
        ProviderAdapterOperation::FuzzyFileSearch => methods::CODEX_FUZZY_FILE_SEARCH,
        ProviderAdapterOperation::HooksList => methods::CODEX_HOOKS_LIST,
        ProviderAdapterOperation::MarketplaceAdd => methods::CODEX_MARKETPLACE_ADD,
        ProviderAdapterOperation::MarketplaceRemove => methods::CODEX_MARKETPLACE_REMOVE,
        ProviderAdapterOperation::MarketplaceUpgrade => methods::CODEX_MARKETPLACE_UPGRADE,
        ProviderAdapterOperation::ModelList => methods::CODEX_MODEL_LIST,
        ProviderAdapterOperation::ModelProviderCapabilitiesRead => {
            methods::CODEX_MODEL_PROVIDER_CAPABILITIES_READ
        }
        ProviderAdapterOperation::RemoteConnectionList => methods::CODEX_REMOTE_CONNECTION_LIST,
        ProviderAdapterOperation::RemoteHandoff => methods::CODEX_REMOTE_HANDOFF,
        ProviderAdapterOperation::RuntimeStatus
        | ProviderAdapterOperation::RuntimeLifecycle
        | ProviderAdapterOperation::ServerRequestRespond => return Ok(None),
        ProviderAdapterOperation::CloudThreadStart
        | ProviderAdapterOperation::CloudHandoff
        | ProviderAdapterOperation::ProviderEvents
        | ProviderAdapterOperation::SemanticTools => {
            return Err(WsDispatchError::BadRequest(format!(
                "Codex adapter operation `{operation:?}` is not invokable through provider_runtime.request"
            )));
        }
    };
    Ok(Some(method))
}

fn provider_runtime_operations_for_provider(
    provider: ProviderKind,
    adapter_profile: &ProviderAdapterProfile,
    status: Option<&ProviderDriverStatus>,
) -> Vec<ProviderRuntimeProviderOperation> {
    adapter_profile
        .operations
        .iter()
        .cloned()
        .map(|profile| {
            let operation = profile.operation;
            let runtime_request = if provider == ProviderKind::Codex {
                codex_runtime_request_for_operation(operation)
            } else {
                ProviderRuntimeOperationRequest::from_invocation(profile.invocation)
            };
            let gate_resolution = profile
                .runtime_gate
                .as_ref()
                .map(|gate| resolve_provider_operation_gate(gate, status));
            ProviderRuntimeProviderOperation::from_profile(profile)
                .with_runtime_request(runtime_request)
                .with_runtime_gate_resolution(gate_resolution)
        })
        .collect()
}

fn resolve_provider_operation_gate(
    gate: &ProviderAdapterOperationGate,
    status: Option<&ProviderDriverStatus>,
) -> ProviderRuntimeOperationGateResolution {
    let provider_methods = gate.provider_methods.clone();
    let Some(status) = status else {
        return ProviderRuntimeOperationGateResolution {
            status: ProviderRuntimeOperationGateStatus::Unknown,
            provider_methods,
            missing_provider_methods: Vec::new(),
            source: None,
            reason: "provider status unavailable; installed method support was not checked"
                .to_string(),
        };
    };
    let Some((source, supported_methods)) = supported_client_request_methods(&status.metadata)
    else {
        return ProviderRuntimeOperationGateResolution {
            status: ProviderRuntimeOperationGateStatus::Unknown,
            provider_methods,
            missing_provider_methods: Vec::new(),
            source: None,
            reason: "provider status did not report installed client request methods".to_string(),
        };
    };

    let missing_provider_methods = provider_methods
        .iter()
        .filter(|method| !supported_methods.contains(method.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let status = if missing_provider_methods.is_empty() {
        ProviderRuntimeOperationGateStatus::Available
    } else {
        ProviderRuntimeOperationGateStatus::Unavailable
    };
    let reason = if status == ProviderRuntimeOperationGateStatus::Available {
        "all gated provider methods are reported by the installed provider".to_string()
    } else {
        "one or more gated provider methods are missing from the installed provider".to_string()
    };

    ProviderRuntimeOperationGateResolution {
        status,
        provider_methods,
        missing_provider_methods,
        source: Some(source),
        reason,
    }
}

fn supported_client_request_methods(metadata: &Value) -> Option<(String, BTreeSet<String>)> {
    [
        (
            "supported_client_request_methods",
            "/supported_client_request_methods",
        ),
        (
            "installed_client_request_methods",
            "/installed_client_request_methods",
        ),
        ("client_request_methods", "/client_request_methods"),
        (
            "schema.client_request_methods",
            "/schema/client_request_methods",
        ),
        (
            "schema.clientRequestMethods",
            "/schema/clientRequestMethods",
        ),
        ("methods.client_request", "/methods/client_request"),
        ("methods.clientRequest", "/methods/clientRequest"),
    ]
    .into_iter()
    .find_map(|(source, pointer)| {
        let methods = method_set_from_value(metadata.pointer(pointer)?)?;
        Some((source.to_string(), methods))
    })
}

fn method_set_from_value(value: &Value) -> Option<BTreeSet<String>> {
    let methods = value
        .as_array()?
        .iter()
        .filter_map(|entry| {
            entry.as_str().map(ToString::to_string).or_else(|| {
                entry
                    .get("method")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
        })
        .collect::<BTreeSet<_>>();
    (!methods.is_empty()).then_some(methods)
}

fn codex_runtime_request_for_operation(
    operation: ProviderAdapterOperation,
) -> ProviderRuntimeOperationRequest {
    match codex_ws_method_for_adapter_operation(operation) {
        Ok(Some(_)) => ProviderRuntimeOperationRequest::operation(
            ProviderRuntimeOperationParams::AdapterNormalized,
        ),
        Ok(None) => ProviderRuntimeOperationRequest::unavailable(
            ProviderRuntimeOperationRequestMode::TypedApi,
            "use the dedicated provider runtime websocket method for this operation",
        ),
        Err(_) => match operation {
            ProviderAdapterOperation::ProviderEvents | ProviderAdapterOperation::SemanticTools => {
                ProviderRuntimeOperationRequest::unavailable(
                    ProviderRuntimeOperationRequestMode::EventStream,
                    "subscribe to provider runtime events for this operation",
                )
            }
            ProviderAdapterOperation::CloudThreadStart | ProviderAdapterOperation::CloudHandoff => {
                ProviderRuntimeOperationRequest::unavailable(
                    ProviderRuntimeOperationRequestMode::Deferred,
                    "this adapter operation is intentionally deferred",
                )
            }
            _ => ProviderRuntimeOperationRequest::unavailable(
                ProviderRuntimeOperationRequestMode::TypedApi,
                "use the provider typed API for this operation",
            ),
        },
    }
}

fn provider_runtime_error_code(
    error: &ace_runtime::provider::ProviderRuntimeError,
) -> &'static str {
    match error {
        ace_runtime::provider::ProviderRuntimeError::ProviderUnavailable { .. } => {
            "provider_unavailable"
        }
        ace_runtime::provider::ProviderRuntimeError::Driver(_) => "provider_request_failed",
    }
}

struct ServerRequestDecisionContext {
    request: Option<Box<NormalizedServerRequest>>,
    audit: ProviderServerRequestAudit,
}

fn provider_server_request_record_to_protocol(
    record: ace_persistence::ProviderServerRequestRecord,
) -> ProviderServerRequestRecord {
    ProviderServerRequestRecord {
        provider: record.provider,
        request_id: record.request_id,
        request: record.request,
        status: match record.status {
            ProviderServerRequestStatus::Pending => ProviderServerRequestStatusFilter::Pending,
            ProviderServerRequestStatus::Resolved => ProviderServerRequestStatusFilter::Resolved,
        },
        decision: record
            .decision
            .map(|decision| ProviderServerRequestDecisionRecord {
                outcome: decision.outcome,
                payload: decision.payload,
                audit: decision.audit,
            }),
        created_at: record.created_at,
        resolved_at: record.resolved_at,
    }
}

fn provider_server_request_matches_filters(
    record: &ace_persistence::ProviderServerRequestRecord,
    filter: &ProviderServerRequestsListRequest,
) -> bool {
    let Some(request) = record.request.as_ref() else {
        return filter.thread_id.is_none() && filter.scope.is_none() && filter.kind.is_none();
    };
    if let Some(thread_id) = filter.thread_id.as_deref()
        && request.thread_id.as_deref() != Some(thread_id)
    {
        return false;
    }
    if let Some(scope) = filter.scope.as_deref()
        && request.scope.as_deref() != Some(scope)
    {
        return false;
    }
    if let Some(kind) = filter.kind
        && request.kind != kind
    {
        return false;
    }
    true
}

fn provider_server_request_read_limit(filter: &ProviderServerRequestsListRequest) -> usize {
    if filter.limit == 0 {
        return 0;
    }
    if filter.thread_id.is_some() || filter.scope.is_some() || filter.kind.is_some() {
        1_000
    } else {
        filter.limit
    }
}

fn host_tool_dispatch_error(error: HostToolError) -> WsDispatchError {
    match error {
        HostToolError::UnsupportedServerRequest { .. }
        | HostToolError::MissingToolName
        | HostToolError::ArgumentsTooLarge { .. }
        | HostToolError::NotFound { .. }
        | HostToolError::EmptyName
        | HostToolError::DuplicateName { .. } => WsDispatchError::BadRequest(error.to_string()),
        HostToolError::Handler { .. } => WsDispatchError::BadRequest(error.to_string()),
    }
}

fn host_tool_audit(
    mut audit: ProviderServerRequestAudit,
    invocation: &HostToolInvocation,
    result: &HostToolResult,
) -> Result<ProviderServerRequestAudit, WsDispatchError> {
    let mut metadata = audit.metadata.as_object().cloned().unwrap_or_default();
    metadata.insert(
        "host_tool".to_string(),
        json!({
            "tool_name": invocation.tool_name,
            "descriptor_name": invocation.descriptor_name,
            "server_name": invocation.server_name,
            "provider": invocation.provider.runtime_id(),
            "result_metadata": result.metadata,
        }),
    );
    audit.metadata = Value::Object(metadata);
    Ok(audit)
}

fn host_tool_error_audit(
    mut audit: ProviderServerRequestAudit,
    invocation: Option<&HostToolInvocation>,
    error: &HostToolError,
) -> Result<ProviderServerRequestAudit, WsDispatchError> {
    let mut metadata = audit.metadata.as_object().cloned().unwrap_or_default();
    let invocation_metadata = invocation.map(|invocation| {
        json!({
            "tool_name": invocation.tool_name,
            "descriptor_name": invocation.descriptor_name,
            "server_name": invocation.server_name,
            "provider": invocation.provider.runtime_id(),
        })
    });
    metadata.insert(
        "host_tool".to_string(),
        json!({
            "invocation": invocation_metadata,
            "error": {
                "code": host_tool_provider_error_code(error),
                "message": error.to_string(),
                "kind": host_tool_error_kind(error),
            }
        }),
    );
    audit.metadata = Value::Object(metadata);
    Ok(audit)
}

fn host_tool_provider_error_code(error: &HostToolError) -> i64 {
    match error {
        HostToolError::UnsupportedServerRequest { .. } => -32010,
        HostToolError::MissingToolName => -32011,
        HostToolError::NotFound { .. } => -32012,
        HostToolError::ArgumentsTooLarge { .. } => -32013,
        HostToolError::EmptyName | HostToolError::DuplicateName { .. } => -32014,
        HostToolError::Handler { .. } => -32015,
    }
}

fn host_tool_error_kind(error: &HostToolError) -> &'static str {
    match error {
        HostToolError::UnsupportedServerRequest { .. } => "unsupported_server_request",
        HostToolError::MissingToolName => "missing_tool_name",
        HostToolError::NotFound { .. } => "tool_not_found",
        HostToolError::ArgumentsTooLarge { .. } => "arguments_too_large",
        HostToolError::EmptyName => "empty_name",
        HostToolError::DuplicateName { .. } => "duplicate_name",
        HostToolError::Handler { .. } => "handler_failed",
    }
}

fn enrich_server_request_audit(
    mut audit: ProviderServerRequestAudit,
    request: Option<&NormalizedServerRequest>,
) -> ProviderServerRequestAudit {
    let Some(request) = request else {
        return audit;
    };

    if audit.scope.is_none() {
        audit.scope.clone_from(&request.scope);
    }
    if audit.source_thread_id.is_none() {
        audit.source_thread_id.clone_from(&request.thread_id);
    }
    if audit.source_item_id.is_none() {
        audit.source_item_id.clone_from(&request.item_id);
    }
    if audit.prompt.is_none() {
        audit.prompt.clone_from(&request.prompt);
    }
    if audit.selected_policy.is_none() {
        audit.selected_policy.clone_from(&request.selected_policy);
    }

    let mut metadata = match audit.metadata {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        value => {
            let mut map = serde_json::Map::new();
            map.insert("client_metadata".to_string(), value);
            map
        }
    };
    metadata
        .entry("request_kind".to_string())
        .or_insert_with(|| serde_json::json!(request.kind));
    if let Some(turn_id) = &request.turn_id {
        metadata
            .entry("source_turn_id".to_string())
            .or_insert_with(|| serde_json::json!(turn_id));
    }
    if let Some(method) = &request.provider.method {
        metadata
            .entry("provider_method".to_string())
            .or_insert_with(|| serde_json::json!(method));
    }
    if !request.metadata.is_null() {
        metadata
            .entry("request_metadata".to_string())
            .or_insert_with(|| request.metadata.clone());
    }
    audit.metadata = Value::Object(metadata);
    audit
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HandoffTransferSummary {
    status: String,
    files: Vec<String>,
}

fn transfer_handoff_files(
    source_repo: &Path,
    destination_worktree: &Path,
) -> Result<HandoffTransferSummary, WsDispatchError> {
    if !source_repo.exists() {
        return Ok(HandoffTransferSummary {
            status: "source_unavailable".to_string(),
            files: Vec::new(),
        });
    }
    if !destination_worktree.exists() {
        return Ok(HandoffTransferSummary {
            status: "destination_unavailable".to_string(),
            files: Vec::new(),
        });
    }

    let source_root = source_repo
        .canonicalize()
        .map_err(|error| handoff_transfer_error("canonicalize source repository", error))?;
    let destination_root = destination_worktree
        .canonicalize()
        .map_err(|error| handoff_transfer_error("canonicalize destination worktree", error))?;

    let mut paths = changed_handoff_paths(&source_root)?;
    paths.extend(worktreeinclude_paths(&source_root)?);
    let mut copied = Vec::new();
    for relative in paths {
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            continue;
        }
        if relative.components().any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(|part| part == ".git")
        }) {
            continue;
        }
        let source = source_root.join(&relative);
        if !source.exists() {
            continue;
        }
        copy_handoff_path(&source_root, &destination_root, &relative)?;
        copied.push(relative.to_string_lossy().to_string());
    }

    Ok(HandoffTransferSummary {
        status: if copied.is_empty() {
            "no_files".to_string()
        } else {
            "files_transferred".to_string()
        },
        files: copied,
    })
}

fn changed_handoff_paths(source_root: &Path) -> Result<BTreeSet<PathBuf>, WsDispatchError> {
    let output = Command::new("git")
        .args(["status", "--porcelain", "-z"])
        .current_dir(source_root)
        .output()
        .map_err(|error| handoff_transfer_error("run git status", error))?;
    if !output.status.success() {
        return Err(WsDispatchError::BadRequest(format!(
            "handoff file transfer failed to read git status: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(parse_porcelain_status_paths(&output.stdout))
}

fn parse_porcelain_status_paths(raw: &[u8]) -> BTreeSet<PathBuf> {
    let mut paths = BTreeSet::new();
    let mut fields = raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    while let Some(record) = fields.next() {
        if record.len() < 4 {
            continue;
        }
        let status = &record[..2];
        let path = String::from_utf8_lossy(&record[3..]).to_string();
        if (status[0] == b'D' && status[1] == b' ') || (status[0] == b' ' && status[1] == b'D') {
            continue;
        }
        if status[0] == b'R' || status[0] == b'C' {
            if let Some(new_path) = fields.next() {
                paths.insert(PathBuf::from(String::from_utf8_lossy(new_path).to_string()));
            }
        } else {
            paths.insert(PathBuf::from(path));
        }
    }
    paths
}

fn worktreeinclude_paths(source_root: &Path) -> Result<BTreeSet<PathBuf>, WsDispatchError> {
    let include_path = source_root.join(".worktreeinclude");
    if !include_path.exists() {
        return Ok(BTreeSet::new());
    }
    let contents = std::fs::read_to_string(&include_path)
        .map_err(|error| handoff_transfer_error("read .worktreeinclude", error))?;
    Ok(contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(PathBuf::from)
        .collect())
}

fn copy_handoff_path(
    source_root: &Path,
    destination_root: &Path,
    relative: &Path,
) -> Result<(), WsDispatchError> {
    let source = source_root.join(relative);
    let destination = destination_root.join(relative);
    ensure_handoff_path_inside(source_root, &source, "source")?;
    if source.is_dir() {
        copy_handoff_directory(source_root, destination_root, relative)
    } else {
        copy_handoff_file(destination_root, &source, &destination)
    }
}

fn copy_handoff_directory(
    source_root: &Path,
    destination_root: &Path,
    relative: &Path,
) -> Result<(), WsDispatchError> {
    let source_dir = source_root.join(relative);
    for entry in std::fs::read_dir(&source_dir)
        .map_err(|error| handoff_transfer_error("read handoff directory", error))?
    {
        let entry = entry.map_err(|error| handoff_transfer_error("read handoff entry", error))?;
        let child_name = entry.file_name();
        if child_name.to_str() == Some(".git") {
            continue;
        }
        copy_handoff_path(source_root, destination_root, &relative.join(child_name))?;
    }
    Ok(())
}

fn copy_handoff_file(
    destination_root: &Path,
    source: &Path,
    destination: &Path,
) -> Result<(), WsDispatchError> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| handoff_transfer_error("create handoff destination", error))?;
    }
    ensure_handoff_path_inside(destination_root, destination, "destination")?;
    std::fs::copy(source, destination)
        .map_err(|error| handoff_transfer_error("copy handoff file", error))?;
    Ok(())
}

fn ensure_handoff_path_inside(
    root: &Path,
    path: &Path,
    label: &str,
) -> Result<(), WsDispatchError> {
    let candidate = if path.exists() {
        path.canonicalize()
            .map_err(|error| handoff_transfer_error("canonicalize handoff path", error))?
    } else {
        path.parent()
            .unwrap_or(root)
            .canonicalize()
            .map_err(|error| handoff_transfer_error("canonicalize handoff parent", error))?
            .join(path.file_name().unwrap_or_default())
    };
    if !candidate.starts_with(root) {
        return Err(WsDispatchError::BadRequest(format!(
            "unsafe handoff {label} path `{}` outside `{}`",
            candidate.display(),
            root.display()
        )));
    }
    Ok(())
}

fn handoff_transfer_error(action: &str, error: std::io::Error) -> WsDispatchError {
    WsDispatchError::BadRequest(format!("handoff file transfer failed to {action}: {error}"))
}

fn codex_versioned_app_server_request(
    ws_method: &str,
    payload: &Value,
) -> Result<Option<(&'static str, Value)>, WsDispatchError> {
    let request = match ws_method {
        methods::CODEX_REVIEW_START => Some((
            "review/start",
            typed_or_enveloped::<CodexReviewStartRequest>(payload)?,
        )),
        methods::CODEX_THREAD_SHELL_COMMAND => Some((
            "thread/shellCommand",
            user_initiated_raw_or_enveloped(payload)?,
        )),
        methods::CODEX_COMMAND_EXEC => Some((
            "command/exec",
            user_initiated_typed_or_enveloped::<CodexCommandExecRequest>(payload)?,
        )),
        methods::CODEX_COMMAND_WRITE_STDIN => Some((
            "command/exec/write",
            user_initiated_typed_or_enveloped::<CodexCommandWriteStdinRequest>(payload)?,
        )),
        methods::CODEX_COMMAND_RESIZE => Some((
            "command/exec/resize",
            user_initiated_typed_or_enveloped::<CodexCommandResizeRequest>(payload)?,
        )),
        methods::CODEX_COMMAND_TERMINATE => Some((
            "command/exec/terminate",
            user_initiated_typed_or_enveloped::<CodexCommandProcessRequest>(payload)?,
        )),
        methods::CODEX_PROCESS_LIST => Some((
            "process/list",
            user_initiated_typed_or_enveloped::<CodexProcessListRequest>(payload)?,
        )),
        methods::CODEX_PROCESS_CLEAN => Some((
            "process/clean",
            user_initiated_typed_or_enveloped::<CodexProcessCleanRequest>(payload)?,
        )),
        methods::CODEX_FS_READ_FILE => Some((
            "fs/readFile",
            typed_or_enveloped::<CodexFsReadFileRequest>(payload)?,
        )),
        methods::CODEX_FS_WRITE_FILE => Some((
            "fs/writeFile",
            typed_or_enveloped::<CodexFsWriteFileRequest>(payload)?,
        )),
        methods::CODEX_FS_READ_DIRECTORY => Some((
            "fs/readDirectory",
            typed_or_enveloped::<CodexFsReadDirectoryRequest>(payload)?,
        )),
        methods::CODEX_FS_CREATE_DIRECTORY => Some((
            "fs/createDirectory",
            typed_or_enveloped::<CodexFsPathRequest>(payload)?,
        )),
        methods::CODEX_FS_COPY => Some((
            "fs/copy",
            typed_or_enveloped::<CodexFsCopyRequest>(payload)?,
        )),
        methods::CODEX_FS_REMOVE => Some((
            "fs/remove",
            typed_or_enveloped::<CodexFsPathRequest>(payload)?,
        )),
        methods::CODEX_FS_METADATA => Some((
            "fs/getMetadata",
            typed_or_enveloped::<CodexFsPathRequest>(payload)?,
        )),
        methods::CODEX_FS_WATCH => Some((
            "fs/watch",
            typed_or_enveloped::<CodexFsPathRequest>(payload)?,
        )),
        methods::CODEX_FS_UNWATCH => Some((
            "fs/unwatch",
            typed_or_enveloped::<CodexFsPathRequest>(payload)?,
        )),
        methods::CODEX_MCP_STATUS => Some((
            "mcpServerStatus/list",
            typed_or_enveloped::<CodexMcpStatusRequest>(payload)?,
        )),
        methods::CODEX_MCP_RESOURCE_READ => Some((
            "mcpServer/resource/read",
            typed_or_enveloped::<CodexMcpResourceReadRequest>(payload)?,
        )),
        methods::CODEX_MCP_OAUTH_LOGIN => Some((
            "mcpServer/oauth/login",
            typed_or_enveloped::<CodexMcpOauthLoginRequest>(payload)?,
        )),
        methods::CODEX_MCP_TOOL_CALL => Some((
            "mcpServer/tool/call",
            typed_or_enveloped::<CodexMcpToolCallRequest>(payload)?,
        )),
        methods::CODEX_SKILLS_LIST => Some((
            "skills/list",
            typed_or_enveloped::<CodexNamedQueryRequest>(payload)?,
        )),
        methods::CODEX_SKILLS_READ => Some((
            "plugin/skill/read",
            typed_or_enveloped::<CodexSkillRequest>(payload)?,
        )),
        methods::CODEX_SKILLS_INSTALL => Some((
            "skills/install",
            typed_or_enveloped::<CodexSkillRequest>(payload)?,
        )),
        methods::CODEX_SKILLS_CONFIG_WRITE => Some((
            "skills/config/write",
            typed_or_enveloped::<CodexSkillsConfigWriteRequest>(payload)?,
        )),
        methods::CODEX_SKILLS_EXTRA_ROOTS_SET => Some((
            "skills/extraRoots/set",
            typed_or_enveloped::<CodexSkillsExtraRootsSetRequest>(payload)?,
        )),
        methods::CODEX_PLUGINS_INSTALLED => Some((
            "plugin/installed",
            typed_or_enveloped::<CodexNamedQueryRequest>(payload)?,
        )),
        methods::CODEX_PLUGINS_LIST => Some((
            "plugin/list",
            typed_or_enveloped::<CodexNamedQueryRequest>(payload)?,
        )),
        methods::CODEX_PLUGINS_READ => Some((
            "plugin/read",
            typed_or_enveloped::<CodexPluginRequest>(payload)?,
        )),
        methods::CODEX_PLUGINS_INSTALL => Some((
            "plugin/install",
            typed_or_enveloped::<CodexPluginRequest>(payload)?,
        )),
        methods::CODEX_PLUGINS_UNINSTALL => Some((
            "plugin/uninstall",
            typed_or_enveloped::<CodexPluginRequest>(payload)?,
        )),
        methods::CODEX_PLUGIN_SHARE_CHECKOUT => {
            Some(("plugin/share/checkout", raw_or_enveloped(payload)?))
        }
        methods::CODEX_PLUGIN_SHARE_DELETE => {
            Some(("plugin/share/delete", raw_or_enveloped(payload)?))
        }
        methods::CODEX_PLUGIN_SHARE_LIST => Some(("plugin/share/list", raw_or_enveloped(payload)?)),
        methods::CODEX_PLUGIN_SHARE_SAVE => Some(("plugin/share/save", raw_or_enveloped(payload)?)),
        methods::CODEX_PLUGIN_SHARE_UPDATE_TARGETS => {
            Some(("plugin/share/updateTargets", raw_or_enveloped(payload)?))
        }
        methods::CODEX_APPS_LIST => Some((
            "app/list",
            typed_or_enveloped::<CodexNamedQueryRequest>(payload)?,
        )),
        methods::CODEX_APPS_CONFIG_WRITE => Some((
            "apps/configWrite",
            typed_or_enveloped::<CodexAppConfigWriteRequest>(payload)?,
        )),
        methods::CODEX_REMOTE_CONNECTION_LIST => Some((
            "remote/connectionList",
            typed_or_enveloped::<CodexNamedQueryRequest>(payload)?,
        )),
        methods::CODEX_REMOTE_HANDOFF => Some((
            "remote/handoff",
            typed_or_enveloped::<CodexRemoteHandoffRequest>(payload)?,
        )),
        methods::CODEX_ACCOUNT_LOGIN_START => {
            Some(("account/login/start", raw_or_enveloped(payload)?))
        }
        methods::CODEX_ACCOUNT_LOGIN_CANCEL => {
            Some(("account/login/cancel", raw_or_enveloped(payload)?))
        }
        methods::CODEX_ACCOUNT_LOGOUT => Some(("account/logout", raw_or_enveloped(payload)?)),
        methods::CODEX_ACCOUNT_READ => Some(("account/read", raw_or_enveloped(payload)?)),
        methods::CODEX_ACCOUNT_RATE_LIMIT_RESET_CREDIT_CONSUME => Some((
            "account/rateLimitResetCredit/consume",
            raw_or_enveloped(payload)?,
        )),
        methods::CODEX_ACCOUNT_RATE_LIMITS_READ => {
            Some(("account/rateLimits/read", raw_or_enveloped(payload)?))
        }
        methods::CODEX_ACCOUNT_USAGE_READ => {
            Some(("account/usage/read", raw_or_enveloped(payload)?))
        }
        methods::CODEX_ACCOUNT_SEND_ADD_CREDITS_NUDGE_EMAIL => Some((
            "account/sendAddCreditsNudgeEmail",
            raw_or_enveloped(payload)?,
        )),
        methods::CODEX_WINDOWS_SANDBOX_READINESS => {
            Some(("windowsSandbox/readiness", raw_or_enveloped(payload)?))
        }
        methods::CODEX_WINDOWS_SANDBOX_SETUP_START => {
            Some(("windowsSandbox/setupStart", raw_or_enveloped(payload)?))
        }
        methods::CODEX_CONFIG_READ => Some(("config/read", raw_or_enveloped(payload)?)),
        methods::CODEX_CONFIG_VALUE_WRITE => {
            Some(("config/value/write", raw_or_enveloped(payload)?))
        }
        methods::CODEX_CONFIG_BATCH_WRITE => {
            Some(("config/batchWrite", raw_or_enveloped(payload)?))
        }
        methods::CODEX_CONFIG_MCP_SERVER_RELOAD => {
            Some(("config/mcpServer/reload", raw_or_enveloped(payload)?))
        }
        methods::CODEX_EXPERIMENTAL_FEATURE_LIST => {
            Some(("experimentalFeature/list", raw_or_enveloped(payload)?))
        }
        methods::CODEX_EXPERIMENTAL_FEATURE_ENABLEMENT_SET => Some((
            "experimentalFeature/enablement/set",
            raw_or_enveloped(payload)?,
        )),
        methods::CODEX_EXTERNAL_AGENT_CONFIG_DETECT => {
            Some(("externalAgentConfig/detect", raw_or_enveloped(payload)?))
        }
        methods::CODEX_EXTERNAL_AGENT_CONFIG_IMPORT => {
            Some(("externalAgentConfig/import", raw_or_enveloped(payload)?))
        }
        methods::CODEX_FEEDBACK_UPLOAD => Some(("feedback/upload", raw_or_enveloped(payload)?)),
        methods::CODEX_FUZZY_FILE_SEARCH => Some(("fuzzyFileSearch", raw_or_enveloped(payload)?)),
        methods::CODEX_HOOKS_LIST => Some(("hooks/list", raw_or_enveloped(payload)?)),
        methods::CODEX_MARKETPLACE_ADD => Some(("marketplace/add", raw_or_enveloped(payload)?)),
        methods::CODEX_MARKETPLACE_REMOVE => {
            Some(("marketplace/remove", raw_or_enveloped(payload)?))
        }
        methods::CODEX_MARKETPLACE_UPGRADE => {
            Some(("marketplace/upgrade", raw_or_enveloped(payload)?))
        }
        methods::CODEX_MODEL_LIST => Some(("model/list", raw_or_enveloped(payload)?)),
        methods::CODEX_MODEL_PROVIDER_CAPABILITIES_READ => Some((
            "modelProvider/capabilities/read",
            raw_or_enveloped(payload)?,
        )),
        _ => None,
    };
    Ok(request)
}

fn semantic_tool_for_codex_versioned_request(
    ws_method: &str,
    codex_method: &str,
    params: &Value,
    result: Option<&Value>,
    status: ToolRunStatus,
) -> Option<SemanticToolCall> {
    let transport = codex_versioned_tool_transport(codex_method)?;
    let mut provider = ProviderToolMetadata::new();
    provider.provider = Some(ProviderKind::Codex.runtime_id().to_string());
    provider.method = Some(codex_method.to_string());
    provider.thread_id = string_field(params, &["threadId", "thread_id"]);
    provider.item_id = string_field(
        params,
        &[
            "processId",
            "process_id",
            "path",
            "uri",
            "skill",
            "plugin",
            "shareId",
            "share_id",
            "app",
        ],
    );
    provider.server_name = string_field(params, &["server", "serverName", "server_name"]);
    provider.tool_name = Some(codex_versioned_tool_name(codex_method, params));
    provider.operation = Some(codex_versioned_tool_operation(codex_method));
    provider.raw_args = params.clone();
    provider.raw_result = result.cloned().unwrap_or(Value::Null);
    provider.raw_payload = json!({
        "ws_method": ws_method,
        "provider_method": codex_method,
        "params": params,
        "result": result.cloned().unwrap_or(Value::Null),
    });

    Some(normalize_tool_call(ToolNormalizationInput {
        transport,
        status,
        provider,
        item_type: Some(codex_versioned_tool_item_type(codex_method).to_string()),
    }))
}

fn codex_versioned_tool_transport(codex_method: &str) -> Option<ToolTransport> {
    match codex_method {
        "thread/shellCommand" | "command/exec" => Some(ToolTransport::Shell),
        "command/exec/write"
        | "command/exec/resize"
        | "command/exec/terminate"
        | "process/list"
        | "process/clean" => Some(ToolTransport::Process),
        "fs/readFile" | "fs/writeFile" | "fs/readDirectory" | "fs/createDirectory" | "fs/copy"
        | "fs/remove" | "fs/getMetadata" | "fs/watch" | "fs/unwatch" => {
            Some(ToolTransport::Filesystem)
        }
        "mcpServerStatus/list"
        | "mcpServer/resource/read"
        | "mcpServer/oauth/login"
        | "mcpServer/tool/call" => Some(ToolTransport::Mcp),
        "skills/list"
        | "plugin/skill/read"
        | "skills/install"
        | "skills/config/write"
        | "skills/extraRoots/set"
        | "plugin/installed"
        | "plugin/list"
        | "plugin/read"
        | "plugin/install"
        | "plugin/uninstall"
        | "plugin/share/checkout"
        | "plugin/share/delete"
        | "plugin/share/list"
        | "plugin/share/save"
        | "plugin/share/updateTargets"
        | "marketplace/add"
        | "marketplace/remove"
        | "marketplace/upgrade" => Some(ToolTransport::CodexBuiltin),
        "app/list" | "apps/configWrite" => Some(ToolTransport::AppConnector),
        _ => None,
    }
}

fn codex_versioned_tool_name(codex_method: &str, params: &Value) -> String {
    string_field(
        params,
        &[
            "tool", "command", "path", "uri", "skill", "plugin", "shareId", "share_id", "app",
        ],
    )
    .unwrap_or_else(|| codex_method.replace('/', "."))
}

fn codex_versioned_tool_operation(codex_method: &str) -> String {
    match codex_method {
        "thread/shellCommand" => "shell_command",
        "command/exec" => "command_exec",
        "command/exec/write" => "stdin_write",
        "command/exec/resize" => "terminal_resize",
        "command/exec/terminate" => "terminal_terminate",
        "process/list" => "process_list",
        "process/clean" => "process_clean",
        "fs/readFile" => "read_file",
        "fs/writeFile" => "write_file",
        "fs/readDirectory" => "read_directory",
        "fs/createDirectory" => "create_directory",
        "fs/copy" => "copy_file",
        "fs/remove" => "remove_file",
        "fs/getMetadata" => "file_metadata",
        "fs/watch" => "watch_file",
        "fs/unwatch" => "unwatch_file",
        "mcpServerStatus/list" => "mcp_status",
        "mcpServer/resource/read" => "mcp_resource_read",
        "mcpServer/oauth/login" => "mcp_oauth_login",
        "mcpServer/tool/call" => "mcp_tool_call",
        "skills/list" => "skills_list",
        "plugin/skill/read" => "skill_read",
        "skills/install" => "skill_install",
        "skills/config/write" => "skills_config_write",
        "skills/extraRoots/set" => "skills_extra_roots_set",
        "plugin/installed" => "plugin_installed",
        "plugin/list" => "plugin_list",
        "plugin/read" => "plugin_read",
        "plugin/install" => "plugin_install",
        "plugin/uninstall" => "plugin_uninstall",
        "plugin/share/checkout" => "plugin_share_checkout",
        "plugin/share/delete" => "plugin_share_delete",
        "plugin/share/list" => "plugin_share_list",
        "plugin/share/save" => "plugin_share_save",
        "plugin/share/updateTargets" => "plugin_share_update_targets",
        "marketplace/add" => "marketplace_add",
        "marketplace/remove" => "marketplace_remove",
        "marketplace/upgrade" => "marketplace_upgrade",
        "app/list" => "app_list",
        "apps/configWrite" => "apps_config_write",
        _ => codex_method,
    }
    .to_string()
}

fn codex_versioned_tool_item_type(codex_method: &str) -> &'static str {
    match codex_method {
        "thread/shellCommand"
        | "command/exec"
        | "command/exec/write"
        | "command/exec/resize"
        | "command/exec/terminate"
        | "process/list"
        | "process/clean" => "commandExecution",
        "fs/readFile" | "fs/readDirectory" | "fs/getMetadata" | "fs/watch" | "fs/unwatch" => {
            "fileRead"
        }
        "fs/writeFile" | "fs/createDirectory" | "fs/copy" | "fs/remove" => "fileChange",
        "mcpServerStatus/list"
        | "mcpServer/resource/read"
        | "mcpServer/oauth/login"
        | "mcpServer/tool/call" => "mcpToolCall",
        "skills/list"
        | "plugin/skill/read"
        | "skills/install"
        | "skills/config/write"
        | "skills/extraRoots/set" => "skill",
        "plugin/installed"
        | "plugin/list"
        | "plugin/read"
        | "plugin/install"
        | "plugin/uninstall"
        | "plugin/share/checkout"
        | "plugin/share/delete"
        | "plugin/share/list"
        | "plugin/share/save"
        | "plugin/share/updateTargets"
        | "marketplace/add"
        | "marketplace/remove"
        | "marketplace/upgrade" => "plugin",
        "app/list" | "apps/configWrite" => "appConnector",
        _ => "tool",
    }
}

fn string_field(value: &Value, fields: &[&str]) -> Option<String> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn resolve_provider_runtime_request_method(
    method: Option<String>,
    operation: Option<ProviderAdapterOperation>,
    adapter_profile: &ProviderAdapterProfile,
) -> Result<String, WsDispatchError> {
    if let Some(method) = method {
        return Ok(method);
    }

    let operation = operation.ok_or_else(|| {
        WsDispatchError::BadRequest(
            "provider runtime request requires either `method` or `operation`".to_string(),
        )
    })?;

    match adapter_profile
        .resolve_request_operation(operation)
        .map_err(|error| WsDispatchError::BadRequest(error.to_string()))?
    {
        ProviderAdapterRequestResolution::DirectProviderMethod { method } => Ok(method),
        ProviderAdapterRequestResolution::Deferred => Err(WsDispatchError::BadRequest(format!(
            "provider `{}` adapter operation `{operation:?}` is intentionally deferred",
            adapter_profile.provider.runtime_id()
        ))),
        ProviderAdapterRequestResolution::EventStream => Err(WsDispatchError::BadRequest(format!(
            "provider `{}` adapter operation `{operation:?}` is event-stream driven; subscribe to provider runtime events",
            adapter_profile.provider.runtime_id()
        ))),
        ProviderAdapterRequestResolution::TypedApi => Err(WsDispatchError::BadRequest(format!(
            "provider `{}` adapter operation `{operation:?}` has no direct provider method; use its typed API",
            adapter_profile.provider.runtime_id()
        ))),
        ProviderAdapterRequestResolution::CompositeTypedApi { methods } => {
            let methods = methods.join("+");
            Err(WsDispatchError::BadRequest(format!(
                "provider `{}` adapter operation `{operation:?}` maps to composite provider methods {methods}; use its typed API",
                adapter_profile.provider.runtime_id()
            )))
        }
    }
}

fn typed_or_enveloped<T>(payload: &Value) -> Result<Value, WsDispatchError>
where
    T: DeserializeOwned + Serialize,
{
    if payload.get("params").is_some() {
        return Ok(serde_json::from_value::<CodexVersionedRequest>(payload.clone())?.params);
    }
    Ok(serde_json::to_value(serde_json::from_value::<T>(
        payload.clone(),
    )?)?)
}

fn raw_or_enveloped(payload: &Value) -> Result<Value, WsDispatchError> {
    if payload.get("params").is_some() {
        return Ok(serde_json::from_value::<CodexVersionedRequest>(payload.clone())?.params);
    }
    Ok(payload.clone())
}

fn user_initiated_raw_or_enveloped(payload: &Value) -> Result<Value, WsDispatchError> {
    let mut params = raw_or_enveloped(payload)?;
    require_user_initiated(payload, &params)?;
    strip_user_initiated_marker(&mut params);
    Ok(params)
}

fn user_initiated_typed_or_enveloped<T>(payload: &Value) -> Result<Value, WsDispatchError>
where
    T: DeserializeOwned + Serialize,
{
    let mut params = if let Some(params) = payload.get("params") {
        params.clone()
    } else {
        payload.clone()
    };

    require_user_initiated(payload, &params)?;
    strip_user_initiated_marker(&mut params);
    Ok(serde_json::to_value(serde_json::from_value::<T>(params)?)?)
}

fn user_initiated_codex_params(method: &str, mut params: Value) -> Result<Value, WsDispatchError> {
    if codex_shell_process_method(method) {
        require_user_initiated(&Value::Null, &params)?;
        strip_user_initiated_marker(&mut params);
    }
    Ok(params)
}

fn codex_shell_process_method(method: &str) -> bool {
    matches!(
        method,
        "thread/shellCommand"
            | "command/exec"
            | "command/exec/write"
            | "command/exec/resize"
            | "command/exec/terminate"
            | "process/list"
            | "process/clean"
    )
}

fn require_user_initiated(payload: &Value, params: &Value) -> Result<(), WsDispatchError> {
    let user_initiated = bool_at(payload, "userInitiated")
        .or_else(|| bool_at(payload, "user_initiated"))
        .or_else(|| bool_at(params, "userInitiated"))
        .or_else(|| bool_at(params, "user_initiated"))
        .unwrap_or(false);
    if user_initiated {
        Ok(())
    } else {
        Err(WsDispatchError::BadRequest(
            "Codex shell/process methods require explicit userInitiated: true".to_string(),
        ))
    }
}

fn bool_at(value: &Value, key: &str) -> Option<bool> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_bool)
}

fn strip_user_initiated_marker(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("userInitiated");
        object.remove("user_initiated");
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
    use ace_core::ProviderCapability;
    use ace_git::{
        CommandOutput, CommandRequest, GitClient, GitToolError, GithubCliClient, ProcessRunner,
    };
    use ace_persistence::ProviderEventLogRepository;
    use ace_protocol::{
        PROTOCOL_VERSION,
        provider_runtime::PROVIDER_RUNTIME_EVENT_TOPIC,
        ws::{WsServerPayload, WsServerResponse, methods},
    };
    use ace_runtime::{
        host_tools::{
            HostToolDescriptor, HostToolError, HostToolHandler, HostToolInvocation,
            HostToolRegistry, HostToolResult,
        },
        provider::{
            NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedServerRequestDecision,
            NormalizedThreadItem, ProviderEvent, ProviderMetadata, RuntimeSignalKind,
            ServerRequestKind, ThreadItemKind, ThreadItemStatus,
        },
        tools::{
            ProviderToolMetadata, ToolActionKind, ToolNormalizationInput, ToolRunStatus,
            ToolSurface, ToolTransport, normalize_tool_call,
        },
    };
    use async_trait::async_trait;
    use rusqlite::Connection;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

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

    fn normalized_approval_request(request_id: &str) -> NormalizedServerRequest {
        NormalizedServerRequest {
            kind: ServerRequestKind::CommandApproval,
            request_id: request_id.to_string(),
            method: "command/approvalRequest".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("cmd-1".to_string()),
            scope: Some("command".to_string()),
            title: Some("Approve command".to_string()),
            prompt: Some("Run cargo test?".to_string()),
            selected_policy: Some("on-request".to_string()),
            metadata: json!({ "command": "cargo test" }),
            provider: ProviderMetadata {
                provider: "codex".to_string(),
                method: Some("command/approvalRequest".to_string()),
                schema_version: Some("test-v1".to_string()),
                raw_payload: json!({ "command": "cargo test" }),
            },
        }
    }

    struct RecordingHostTool {
        descriptor: HostToolDescriptor,
        invocations: Mutex<Vec<HostToolInvocation>>,
        result: Value,
        error: Option<String>,
    }

    #[async_trait]
    impl HostToolHandler for RecordingHostTool {
        fn descriptor(&self) -> HostToolDescriptor {
            self.descriptor.clone()
        }

        async fn invoke(
            &self,
            invocation: HostToolInvocation,
        ) -> Result<HostToolResult, HostToolError> {
            self.invocations
                .lock()
                .expect("host tool invocations")
                .push(invocation);
            if let Some(message) = &self.error {
                return Err(HostToolError::Handler {
                    message: message.clone(),
                });
            }
            Ok(HostToolResult {
                output: self.result.clone(),
                metadata: json!({ "bridge": "browser" }),
            })
        }
    }

    fn pending_codex_dynamic_tool_request() -> ProviderEvent {
        ProviderEvent::ServerRequest {
            request: Box::new(NormalizedServerRequest {
                kind: ServerRequestKind::DynamicToolCall,
                request_id: "42".to_string(),
                method: "dynamicTool/call".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("tool-1".to_string()),
                scope: Some("tool".to_string()),
                title: Some("Run dynamic tool".to_string()),
                prompt: Some("Open local app?".to_string()),
                selected_policy: Some("user".to_string()),
                metadata: json!({
                    "toolName": "ace_browser",
                    "arguments": {
                        "operation": "navigate_tab_url",
                        "url": "http://localhost:5173"
                    }
                }),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("dynamicTool/call".to_string()),
                    schema_version: Some("2026-01-01".to_string()),
                    raw_payload: json!({
                        "toolCallId": "tool-1",
                        "toolName": "ace_browser",
                        "arguments": {
                            "operation": "navigate_tab_url",
                            "url": "http://localhost:5173"
                        }
                    }),
                },
            }),
        }
    }

    #[derive(Debug)]
    struct ScriptedRunner {
        responses: std::sync::Mutex<std::collections::VecDeque<ace_git::Result<CommandOutput>>>,
        requests: std::sync::Mutex<Vec<CommandRequest>>,
    }

    impl ScriptedRunner {
        fn new(responses: Vec<ace_git::Result<CommandOutput>>) -> Self {
            Self {
                responses: std::sync::Mutex::new(responses.into()),
                requests: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<CommandRequest> {
            self.requests.lock().expect("requests").clone()
        }
    }

    #[async_trait]
    impl ProcessRunner for ScriptedRunner {
        async fn run(&self, request: CommandRequest) -> ace_git::Result<CommandOutput> {
            self.requests
                .lock()
                .expect("requests")
                .push(request.clone());
            self.responses
                .lock()
                .expect("responses")
                .pop_front()
                .unwrap_or_else(|| {
                    Err(GitToolError::Parse {
                        context: "codex ws scripted runner",
                        message: format!("unexpected command {:?}", request.args),
                    })
                })
        }
    }

    fn ok(stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status: 0,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    fn run_git(cwd: &std::path::Path, args: impl IntoIterator<Item = &'static str>) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn parses_handoff_porcelain_paths() {
        let paths = parse_porcelain_status_paths(
            b" M src/lib.rs\0?? notes.txt\0D  deleted.txt\0R  old.rs\0new.rs\0",
        );

        assert!(paths.contains(std::path::Path::new("src/lib.rs")));
        assert!(paths.contains(std::path::Path::new("notes.txt")));
        assert!(paths.contains(std::path::Path::new("new.rs")));
        assert!(!paths.contains(std::path::Path::new("deleted.txt")));
        assert!(!paths.contains(std::path::Path::new("old.rs")));
    }

    #[test]
    fn handoff_transfer_copies_changed_untracked_and_worktreeinclude_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        std::fs::create_dir_all(source.join("src")).expect("source dirs");
        std::fs::create_dir_all(source.join("secrets")).expect("secret dirs");
        std::fs::create_dir_all(&destination).expect("destination dir");
        run_git(temp.path(), ["init", "-b", "main", "source"]);
        run_git(&source, ["config", "user.email", "ace@example.test"]);
        run_git(&source, ["config", "user.name", "Ace Test"]);
        std::fs::write(source.join("src/lib.rs"), "pub fn old() {}\n").expect("write tracked");
        run_git(&source, ["add", "src/lib.rs"]);
        run_git(&source, ["commit", "-m", "initial"]);

        std::fs::write(source.join("src/lib.rs"), "pub fn new() {}\n").expect("modify tracked");
        std::fs::write(source.join("notes.txt"), "handoff notes\n").expect("write untracked");
        std::fs::write(source.join(".gitignore"), "secrets/\n").expect("write gitignore");
        std::fs::write(source.join(".worktreeinclude"), "secrets/token.txt\n").expect("include");
        std::fs::write(source.join("secrets/token.txt"), "secret\n").expect("write ignored");

        let summary = transfer_handoff_files(&source, &destination).expect("transfer");
        assert_eq!(summary.status, "files_transferred");
        assert!(summary.files.contains(&"src/lib.rs".to_string()));
        assert!(summary.files.contains(&"notes.txt".to_string()));
        assert!(summary.files.contains(&"secrets/token.txt".to_string()));
        assert_eq!(
            std::fs::read_to_string(destination.join("src/lib.rs")).expect("read tracked"),
            "pub fn new() {}\n"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("notes.txt")).expect("read untracked"),
            "handoff notes\n"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("secrets/token.txt")).expect("read ignored"),
            "secret\n"
        );
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

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "codex-plan-snapshot",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };
        let active_turns = body["providers"][0]["state"]["active_turns"]
            .as_array()
            .expect("active turns");
        assert_eq!(active_turns.len(), 1);
        assert_eq!(active_turns[0]["thread_id"], "thread-1");
        assert_eq!(active_turns[0]["turn_id"], "turn-1");
        assert_eq!(active_turns[0]["mode"], "plan");

        let interrupt = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "codex-interrupt",
                    "method": methods::CODEX_TURN_INTERRUPT,
                    "payload": { "thread_id": "thread-1" }
                })
                .to_string(),
            )
            .await;
        let interrupt: WsServerResponse = serde_json::from_str(&interrupt).expect("interrupt");
        assert!(matches!(interrupt.payload, WsServerPayload::Result { .. }));

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "codex-turn-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|record| {
            record["event"]["type"] == "runtime_signal"
                && record["event"]["signal"]["kind"] == "turn_lifecycle_changed"
                && record["projection_deltas"][0]["type"] == "active_turn_changed"
        }));
        assert_eq!(records[0]["event"]["signal"]["status"], "started");
        assert_eq!(records[0]["event"]["signal"]["active"], true);
        assert_eq!(records[0]["event"]["signal"]["metadata"]["mode"], "plan");
        assert_eq!(records[0]["projection_deltas"][0]["active"], true);
        assert_eq!(records[1]["event"]["signal"]["status"], "interrupted");
        assert_eq!(records[1]["event"]["signal"]["active"], false);
        assert_eq!(records[1]["projection_deltas"][0]["active"], false);
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["turn/start:thread-1", "turn/interrupt:thread-1"]
        );
    }

    #[tokio::test]
    async fn dispatches_codex_turn_steer_over_ws_rpc() {
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
                    "request_id": "codex-steer",
                    "method": methods::CODEX_TURN_STEER,
                    "payload": {
                        "thread_id": "thread-1",
                        "expected_turn_id": "turn-1",
                        "input": [{ "type": "text", "text": "also update docs" }],
                        "client_user_message_id": "user-message-1"
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");
        assert_eq!(response.version, PROTOCOL_VERSION);
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected turn steer result");
        };
        assert_eq!(body["turnId"], "turn-1");
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["turn/steer:thread-1:turn-1:1"]
        );
    }

    #[tokio::test]
    async fn dispatches_codex_plan_implementation_actions_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let base_payload = json!({
            "thread_id": "thread-1",
            "plan": { "markdown": "1. Edit\n2. Test" },
            "prompt": "implement this plan",
            "model": "gpt-5.5",
            "cwd": "/tmp/repo",
            "approval_policy": { "mode": "on-request" },
            "approvals_reviewer": "user"
        });

        for (index, method) in [
            methods::CODEX_PLAN_CONTINUE_IN_THREAD,
            methods::CODEX_PLAN_FORK_FOR_IMPLEMENTATION,
            methods::CODEX_PLAN_SIDE_IMPLEMENTATION,
        ]
        .iter()
        .enumerate()
        {
            let response = state
                .dispatch_text(
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "request_id": format!("plan-impl-{index}"),
                        "method": method,
                        "payload": base_payload
                    })
                    .to_string(),
                )
                .await;
            let response: WsServerResponse = serde_json::from_str(&response).expect("response");
            assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        }

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/inject_items:thread-1:1",
                "turn/start:thread-1",
                "thread/fork:thread-1:false",
                "thread/inject_items:fork-1:1",
                "turn/start:fork-1",
                "thread/fork:thread-1:true",
                "thread/inject_items:fork-1:1",
                "turn/start:fork-1",
            ]
        );

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "plan-impl-snapshot",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };
        let implementations = body["providers"][0]["state"]["plan_implementations"]
            .as_array()
            .expect("plan implementations");
        assert_eq!(implementations.len(), 3);
        assert_eq!(implementations[0]["mode"], "continue_in_thread");
        assert_eq!(implementations[0]["parent_thread_id"], "thread-1");
        assert_eq!(implementations[0]["target_thread_id"], "thread-1");
        assert_eq!(implementations[0]["plan"]["markdown"], "1. Edit\n2. Test");
        assert_eq!(implementations[0]["prompt"], "implement this plan");
        assert_eq!(implementations[0]["model"], "gpt-5.5");
        assert_eq!(implementations[0]["cwd"], "/tmp/repo");
        assert_eq!(implementations[0]["approval_policy"]["mode"], "on-request");
        assert_eq!(implementations[0]["approvals_reviewer"], "user");
        assert_eq!(implementations[0]["provider_response"]["forked"], false);
        assert_eq!(implementations[1]["mode"], "fork_for_implementation");
        assert_eq!(implementations[1]["target_thread_id"], "fork-1");
        assert_eq!(implementations[1]["provider_response"]["forked"], true);
        assert_eq!(implementations[2]["mode"], "side_implementation");
        assert_eq!(implementations[2]["target_thread_id"], "fork-1");
        assert_eq!(implementations[2]["provider_response"]["ephemeral"], true);

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "plan-impl-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 3);
        assert!(records.iter().all(|record| {
            record["event"]["type"] == "runtime_signal"
                && record["event"]["signal"]["kind"] == "plan_implementation_updated"
                && record["projection_deltas"][0]["type"] == "plan_implementation_updated"
        }));
        assert_eq!(
            records[0]["event"]["signal"]["status"],
            "continue_in_thread"
        );
        assert_eq!(
            records[0]["projection_deltas"][0]["implementation"]["target_thread_id"],
            "thread-1"
        );
        assert_eq!(
            records[1]["projection_deltas"][0]["implementation"]["mode"],
            "fork_for_implementation"
        );
        assert_eq!(
            records[1]["projection_deltas"][0]["implementation"]["provider_response"]["forked"],
            true
        );
        assert_eq!(
            records[2]["projection_deltas"][0]["implementation"]["mode"],
            "side_implementation"
        );
    }

    #[tokio::test]
    async fn dispatches_codex_fork_from_turn_and_side_chat_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        for (request_id, method, payload) in [
            (
                "fork-from-turn",
                methods::CODEX_THREAD_FORK,
                json!({
                    "thread_id": "thread-1",
                    "ephemeral": false,
                    "turn_id": "turn-2"
                }),
            ),
            (
                "side-chat",
                methods::CODEX_SIDE_CHAT_START,
                json!({
                    "thread_id": "thread-1",
                    "turn_id": "turn-3"
                }),
            ),
        ] {
            let response = state
                .dispatch_text(
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "request_id": request_id,
                        "method": method,
                        "payload": payload
                    })
                    .to_string(),
                )
                .await;
            let response: WsServerResponse = serde_json::from_str(&response).expect("response");
            assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        }

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/fork:thread-1:false",
                "thread/rollback:fork-1:turn-2",
                "thread/fork:thread-1:true",
                "thread/rollback:fork-1:turn-3",
            ]
        );

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "fork-side-chat-snapshot",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };
        let forks = body["providers"][0]["state"]["fork_points"]
            .as_array()
            .expect("forks");
        assert_eq!(forks.len(), 1);
        assert_eq!(forks[0]["parent_thread_id"], "thread-1");
        assert_eq!(forks[0]["child_thread_id"], "fork-1");
        assert_eq!(forks[0]["turn_id"], "turn-3");
        let side_chats = body["providers"][0]["state"]["side_chats"]
            .as_array()
            .expect("side chats");
        assert_eq!(side_chats.len(), 1);
        assert_eq!(side_chats[0]["parent_thread_id"], "thread-1");
        assert_eq!(side_chats[0]["thread_id"], "fork-1");
        assert_eq!(side_chats[0]["ephemeral"], true);

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "fork-side-chat-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 3);
        assert_eq!(records[0]["event"]["signal"]["kind"], "fork_updated");
        assert_eq!(records[0]["event"]["signal"]["turn_id"], "turn-2");
        assert_eq!(records[0]["projection_deltas"][0]["type"], "fork_updated");
        assert_eq!(
            records[0]["projection_deltas"][0]["fork"]["child_thread_id"],
            "fork-1"
        );
        assert_eq!(
            records[0]["projection_deltas"][1]["type"],
            "child_thread_upsert"
        );
        assert_eq!(records[1]["event"]["signal"]["kind"], "fork_updated");
        assert_eq!(records[1]["event"]["signal"]["turn_id"], "turn-3");
        assert_eq!(records[1]["projection_deltas"][0]["type"], "fork_updated");
        assert_eq!(records[2]["event"]["signal"]["kind"], "side_chat_updated");
        assert_eq!(
            records[2]["projection_deltas"][0]["type"],
            "side_chat_updated"
        );
        assert_eq!(
            records[2]["projection_deltas"][0]["side_chat"]["thread_id"],
            "fork-1"
        );
        assert_eq!(
            records[2]["projection_deltas"][1]["type"],
            "child_thread_upsert"
        );
        assert_eq!(records[2]["projection_deltas"][1]["role"], "side_chat");
    }

    #[tokio::test]
    async fn dispatches_codex_permission_methods_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let catalog = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "permission-catalog",
                    "method": methods::CODEX_PERMISSION_CATALOG,
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let catalog: WsServerResponse = serde_json::from_str(&catalog).expect("catalog response");
        let WsServerPayload::Result { body } = catalog.payload else {
            panic!("expected permission catalog result");
        };
        assert_eq!(
            body["available_presets"],
            json!(["strict", "auto", "auto_review"])
        );
        assert!(
            body["presets"]
                .as_array()
                .expect("preset entries")
                .iter()
                .any(|entry| entry["preset"] == "full_access"
                    && entry["available"] == false
                    && entry["unavailable_reason"] == "blocked_by_managed_deny_list")
        );
        assert!(
            body["presets"]
                .as_array()
                .expect("preset entries")
                .iter()
                .any(|entry| entry["preset"] == "auto_review"
                    && entry["permissions"]["approvals_reviewer"] == "auto_review")
        );

        let preset = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "permission-preset",
                    "method": methods::CODEX_PERMISSION_PRESET_RESOLVE,
                    "payload": { "preset": "auto_review" }
                })
                .to_string(),
            )
            .await;
        let preset: WsServerResponse = serde_json::from_str(&preset).expect("preset response");
        let WsServerPayload::Result { body } = preset.payload else {
            panic!("expected preset result");
        };
        assert_eq!(body["sandbox_policy"]["mode"], "workspace-write");
        assert_eq!(body["approval_policy"]["mode"], "on-request");
        assert_eq!(body["approvals_reviewer"], "auto_review");

        let denied_preset = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "permission-preset-denied",
                    "method": methods::CODEX_PERMISSION_PRESET_RESOLVE,
                    "payload": { "preset": "full_access" }
                })
                .to_string(),
            )
            .await;
        let denied_preset: WsServerResponse =
            serde_json::from_str(&denied_preset).expect("denied preset response");
        let WsServerPayload::Error { code, message } = denied_preset.payload else {
            panic!("expected denied preset error");
        };
        assert_eq!(code, "codex_permission_preset_unavailable");
        assert!(message.contains("full_access"));

        let inventory = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "codex-inventory",
                    "method": methods::CODEX_COMPATIBILITY_INVENTORY,
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let inventory: WsServerResponse =
            serde_json::from_str(&inventory).expect("inventory response");
        let WsServerPayload::Result { body } = inventory.payload else {
            panic!("expected inventory result");
        };
        assert!(
            body["methods"]
                .as_array()
                .expect("methods")
                .iter()
                .any(|method| method["method"] == "thread/start"
                    && method["support"] == "typed_supported"
                    && method["invocation"] == "typed_api"
                    && method["raw_request_allowed"] == true)
        );
        assert!(
            body["methods"]
                .as_array()
                .expect("methods")
                .iter()
                .any(|method| method["method"] == "command/exec"
                    && method["support"] == "version_gated"
                    && method["invocation"] == "raw_request"
                    && method["raw_request_allowed"] == true
                    && method["reason"]
                        .as_str()
                        .expect("command exec reason")
                        .contains("version-gated"))
        );
        assert!(
            body["methods"]
                .as_array()
                .expect("methods")
                .iter()
                .any(|method| method["method"] == "command/approvalRequest"
                    && method["invocation"] == "server_request_response"
                    && method["raw_request_allowed"] == false)
        );
        assert!(
            body["methods"]
                .as_array()
                .expect("methods")
                .iter()
                .any(|method| method["method"] == "cloud/handoff"
                    && method["invocation"] == "deferred"
                    && method["raw_request_allowed"] == false)
        );
        assert!(
            body["summary"]["total_methods"]
                .as_u64()
                .expect("total methods")
                > 0
        );
        assert!(
            body["summary"]["client_request_methods"]
                .as_u64()
                .expect("client methods")
                > 0
        );
        assert!(
            body["summary"]["intentionally_deferred_methods"]
                .as_u64()
                .expect("deferred methods")
                > 0
        );
        assert_eq!(
            body["raw_request_policy"]["allowed_direction"],
            "client_request"
        );
        assert_eq!(body["raw_request_policy"]["rejects_unknown_methods"], true);
        assert_eq!(
            body["raw_request_policy"]["rejects_non_client_request_directions"],
            true
        );
        assert!(
            body["raw_request_policy"]["allowed_supports"]
                .as_array()
                .expect("allowed supports")
                .contains(&json!("version_gated"))
        );
        assert!(
            body["raw_request_policy"]["rejected_supports"]
                .as_array()
                .expect("rejected supports")
                .contains(&json!("intentionally_deferred"))
        );
        assert_eq!(
            body["adapter_contract_coverage_summary"]["fully_covered"],
            true
        );
        assert!(
            body["adapter_contract_coverage_summary"]["total_operations"]
                .as_u64()
                .expect("coverage operations")
                > 0
        );
        assert_eq!(
            body["adapter_contract_coverage_summary"]["missing_method_operations"],
            0
        );
        assert_eq!(
            body["adapter_contract_coverage_summary"]["support_mismatch_operations"],
            0
        );
        assert!(
            body["adapter_contract_coverage"]
                .as_array()
                .expect("adapter contract coverage")
                .iter()
                .any(
                    |operation| operation["operation"] == "plan_fork_for_implementation"
                        && operation["fully_covered"] == true
                        && operation["provider_methods"]
                            .as_array()
                            .expect("provider methods")
                            .contains(&json!({
                                "method": "thread/fork",
                                "support": "typed_supported"
                            }))
                )
        );

        let retry = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "guardian-retry",
                    "method": methods::CODEX_THREAD_APPROVE_GUARDIAN_DENIED_ACTION,
                    "payload": {
                        "threadId": "thread-1",
                        "itemId": "item-1",
                        "actionId": "action-1",
                        "approved": true,
                        "reason": "retry after user approval",
                        "audit": { "selected_policy": "on-request" }
                    }
                })
                .to_string(),
            )
            .await;
        let retry: WsServerResponse = serde_json::from_str(&retry).expect("retry response");
        assert!(matches!(retry.payload, WsServerPayload::Result { .. }));

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "guardian-retry-snapshot",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };
        let retry_record = &body["providers"][0]["state"]["approval_retries"][0];
        assert_eq!(retry_record["thread_id"], "thread-1");
        assert_eq!(retry_record["item_id"], "item-1");
        assert_eq!(retry_record["action_id"], "action-1");
        assert_eq!(retry_record["approved"], true);
        assert_eq!(retry_record["reason"], "retry after user approval");
        assert_eq!(retry_record["audit"]["selected_policy"], "on-request");
        assert_eq!(retry_record["provider_response"]["approved"], true);

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "guardian-retry-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0]["event"]["signal"]["kind"],
            "approval_retry_recorded"
        );
        assert_eq!(
            records[0]["projection_deltas"][0]["type"],
            "approval_retry_recorded"
        );
        assert_eq!(
            records[0]["projection_deltas"][0]["retry"]["action_id"],
            "action-1"
        );
        assert_eq!(
            records[0]["projection_deltas"][0]["retry"]["audit"]["selected_policy"],
            "on-request"
        );
        assert_eq!(
            records[0]["projection_deltas"][0]["retry"]["provider_response"]["approved"],
            true
        );

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "configRequirements/read",
                "permissionProfile/list",
                "configRequirements/read",
                "permissionProfile/list",
                "configRequirements/read",
                "permissionProfile/list",
                "thread/approveGuardianDeniedAction:thread-1:action-1",
            ]
        );
    }

    #[tokio::test]
    async fn dispatches_codex_goal_methods_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let calls = [
            (
                methods::CODEX_GOAL_SET,
                json!({
                    "thread_id": "thread-1",
                    "objective": "finish adapter",
                    "token_budget": 12000
                }),
            ),
            (methods::CODEX_GOAL_GET, json!({ "thread_id": "thread-1" })),
            (
                methods::CODEX_GOAL_PAUSE,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_GOAL_RESUME,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_GOAL_CLEAR,
                json!({ "thread_id": "thread-1" }),
            ),
        ];

        for (index, (method, payload)) in calls.iter().enumerate() {
            let response = state
                .dispatch_text(
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "request_id": format!("goal-{index}"),
                        "method": method,
                        "payload": payload
                    })
                    .to_string(),
                )
                .await;
            let response: WsServerResponse = serde_json::from_str(&response).expect("response");
            assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        }

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

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "goal-snapshot",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };
        let goals = body["providers"][0]["state"]["goals"]
            .as_array()
            .expect("goals");
        assert_eq!(goals.len(), 1);
        assert_eq!(goals[0]["thread_id"], "thread-1");
        assert_eq!(goals[0]["status"], "cleared");
        assert_eq!(goals[0]["objective"], "finish adapter");
        assert_eq!(goals[0]["token_budget"], 12000);

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "goal-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 4);
        assert!(records.iter().all(|record| {
            record["event"]["type"] == "runtime_signal"
                && record["event"]["signal"]["kind"] == "goal_updated"
        }));
        assert_eq!(records[0]["event"]["signal"]["status"], "active");
        assert_eq!(records[0]["event"]["signal"]["text"], "finish adapter");
        assert_eq!(
            records[0]["event"]["signal"]["provider"]["method"],
            "ace/goal/set"
        );
        assert_eq!(records[0]["projection_deltas"][0]["type"], "goal_updated");
        assert_eq!(
            records[0]["projection_deltas"][0]["goal"]["objective"],
            "finish adapter"
        );
        assert_eq!(
            records[0]["projection_deltas"][0]["goal"]["token_budget"],
            12000
        );
        assert_eq!(records[1]["event"]["signal"]["status"], "paused");
        assert_eq!(records[1]["projection_deltas"][0]["type"], "goal_updated");
        assert_eq!(
            records[1]["projection_deltas"][0]["goal"]["status"],
            "paused"
        );
        assert_eq!(records[2]["event"]["signal"]["status"], "active");
        assert_eq!(records[2]["projection_deltas"][0]["type"], "goal_updated");
        assert_eq!(records[3]["event"]["signal"]["status"], "cleared");
        assert_eq!(records[3]["projection_deltas"][0]["type"], "goal_cleared");
        assert_eq!(records[3]["projection_deltas"][0]["thread_id"], "thread-1");
    }

    #[tokio::test]
    async fn dispatches_codex_subagent_and_handoff_methods_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let calls = [
            (
                methods::CODEX_SUBAGENTS_LIST,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_SUBAGENT_READ,
                json!({ "thread_id": "thread-1", "subagent_thread_id": "subagent-1" }),
            ),
            (
                methods::CODEX_SUBAGENT_STEER,
                json!({
                    "thread_id": "thread-1",
                    "subagent_thread_id": "subagent-1",
                    "prompt": "focus on tests"
                }),
            ),
            (
                methods::CODEX_SUBAGENT_STOP,
                json!({ "thread_id": "thread-1", "subagent_thread_id": "subagent-1" }),
            ),
            (
                methods::CODEX_SUBAGENT_CLOSE,
                json!({ "thread_id": "thread-1", "subagent_thread_id": "subagent-1" }),
            ),
            (
                methods::CODEX_HANDOFF_TO_AGENT,
                json!({
                    "thread_id": "thread-1",
                    "prompt": "take over implementation",
                    "agent_role": "implementer",
                    "nickname": "builder",
                    "model": "gpt-5.5",
                    "reasoning_effort": "high",
                    "sandbox_policy": { "mode": "workspace-write" },
                    "approval_policy": { "mode": "on-request" },
                    "approvals_reviewer": "user",
                    "skills": ["rust"],
                    "mcp_config": { "servers": [] }
                }),
            ),
        ];

        for (index, (method, payload)) in calls.iter().enumerate() {
            let response = state
                .dispatch_text(
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "request_id": format!("subagent-{index}"),
                        "method": method,
                        "payload": payload
                    })
                    .to_string(),
                )
                .await;
            let response: WsServerResponse = serde_json::from_str(&response).expect("response");
            assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        }

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

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "subagent-snapshot",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };
        let subagent_actions = body["providers"][0]["state"]["subagent_actions"]
            .as_array()
            .expect("subagent actions");
        assert_eq!(subagent_actions.len(), 3);
        assert_eq!(subagent_actions[0]["action"], "steer");
        assert_eq!(subagent_actions[0]["parent_thread_id"], "thread-1");
        assert_eq!(subagent_actions[0]["subagent_thread_id"], "subagent-1");
        assert_eq!(subagent_actions[0]["prompt"], "focus on tests");
        assert_eq!(subagent_actions[0]["provider_response"]["steered"], true);
        assert_eq!(subagent_actions[1]["action"], "stop");
        assert_eq!(subagent_actions[1]["provider_response"]["stopped"], true);
        assert_eq!(subagent_actions[2]["action"], "close");
        assert_eq!(subagent_actions[2]["provider_response"]["closed"], true);

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "subagent-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 4);
        assert!(records[..3].iter().all(|record| {
            record["event"]["type"] == "runtime_signal"
                && record["event"]["signal"]["kind"] == "subagent_action"
                && record["projection_deltas"][0]["type"] == "subagent_action_recorded"
        }));
        assert_eq!(records[0]["event"]["signal"]["status"], "steer");
        assert_eq!(records[0]["event"]["signal"]["text"], "focus on tests");
        assert_eq!(
            records[0]["projection_deltas"][0]["subagent_thread_id"],
            "subagent-1"
        );
        assert_eq!(records[0]["projection_deltas"][0]["action"], "steer");
        assert_eq!(
            records[0]["projection_deltas"][0]["prompt"],
            "focus on tests"
        );
        assert_eq!(
            records[0]["projection_deltas"][0]["metadata"]["provider_response"]["steered"],
            true
        );
        assert_eq!(records[1]["projection_deltas"][0]["action"], "stop");
        assert_eq!(
            records[1]["projection_deltas"][0]["metadata"]["provider_response"]["stopped"],
            true
        );
        assert_eq!(records[2]["projection_deltas"][0]["action"], "close");
        assert_eq!(
            records[2]["projection_deltas"][0]["metadata"]["provider_response"]["closed"],
            true
        );
        assert_eq!(records[3]["event"]["signal"]["kind"], "handoff_updated");
        assert_eq!(
            records[3]["projection_deltas"][0]["type"],
            "handoff_updated"
        );
        assert_eq!(
            records[3]["projection_deltas"][0]["handoff"]["source_thread_id"],
            "thread-1"
        );
        assert_eq!(
            records[3]["projection_deltas"][0]["handoff"]["target_thread_id"],
            "agent-thread-1"
        );
        assert_eq!(
            records[3]["projection_deltas"][0]["handoff"]["target_location"],
            "local"
        );
    }

    #[tokio::test]
    async fn dispatches_codex_handoff_to_worktree_over_ws_rpc() {
        let temp = tempfile::tempdir().expect("tempdir");
        let worktree_root = temp.path().join("worktrees");
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(ScriptedRunner::new(vec![
            Ok(ok("main||origin/main\nfeature/task||\n")),
            Ok(ok("/repo\n")),
            Ok(ok("true\n")),
            Ok(ok("")),
            Ok(ok("## feature/task-2\n")),
        ]));
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone()))
                .with_worktree_root(worktree_root.clone()),
            GithubService::new(GithubCliClient::with_runner(runner.clone())),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let turn = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "turn-start",
                    "method": methods::CODEX_TURN_START,
                    "payload": {
                        "thread_id": "thread-1",
                        "input": [{ "type": "text", "text": "work" }]
                    }
                })
                .to_string(),
            )
            .await;
        let turn: WsServerResponse = serde_json::from_str(&turn).expect("turn response");
        assert!(matches!(turn.payload, WsServerPayload::Result { .. }));

        let handoff = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "handoff-worktree",
                    "method": methods::CODEX_HANDOFF_TO_LOCATION,
                    "payload": {
                        "thread_id": "thread-1",
                        "repo_path": "/repo",
                        "target_location": "worktree",
                        "preferred_branch": "feature/task",
                        "start_point": "main"
                    }
                })
                .to_string(),
            )
            .await;
        let handoff: WsServerResponse = serde_json::from_str(&handoff).expect("handoff response");
        let WsServerPayload::Result { body } = handoff.payload else {
            panic!("expected handoff result");
        };
        let worktree_path = body["worktree_path"].as_str().expect("worktree path");
        assert!(worktree_path.starts_with(worktree_root.to_string_lossy().as_ref()));
        assert_eq!(body["worktree_branch"], "feature/task-2");
        assert_eq!(body["interrupted_active_turn"], true);
        assert_eq!(
            body["thread_metadata"]["handoff"]["worktree_branch"],
            "feature/task-2"
        );

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "turn/start:thread-1",
                "turn/interrupt:thread-1",
                "thread/metadata/update:thread-1",
            ]
        );

        let requests = runner.requests();
        assert_eq!(
            requests[0].args,
            vec![
                "branch",
                "--format=%(refname:short)|%(HEAD)|%(upstream:short)"
            ]
        );
        assert_eq!(
            requests[3].args[0..4],
            ["worktree", "add", "-b", "feature/task-2"]
        );

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "handoff-snapshot",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };
        let handoff = &body["providers"][0]["state"]["handoffs"][0];
        assert_eq!(handoff["source_thread_id"], "thread-1");
        assert_eq!(handoff["target_location"], "worktree");
        assert_eq!(handoff["status"], "completed");
        assert_eq!(handoff["target_thread_id"], "thread-1");
        assert_eq!(handoff["worktree_path"], worktree_path);
        assert_eq!(handoff["branch"], "feature/task-2");
        assert_eq!(handoff["repo_root"], "/repo");
        assert_eq!(handoff["start_point"], "main");
        assert_eq!(handoff["transfer_status"], "source_unavailable");
        assert_eq!(handoff["interrupted_active_turn"], true);

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "handoff-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 2);
        assert_eq!(
            records[0]["event"]["signal"]["kind"],
            "turn_lifecycle_changed"
        );
        assert_eq!(records[0]["event"]["signal"]["status"], "started");
        assert_eq!(
            records[0]["projection_deltas"][0]["type"],
            "active_turn_changed"
        );
        assert_eq!(records[0]["projection_deltas"][0]["active"], true);
        assert_eq!(records[1]["event"]["signal"]["kind"], "handoff_updated");
        assert_eq!(
            records[1]["projection_deltas"][0]["type"],
            "handoff_updated"
        );
        assert_eq!(
            records[1]["projection_deltas"][0]["handoff"]["worktree_path"],
            worktree_path
        );
        assert_eq!(
            records[1]["projection_deltas"][0]["handoff"]["branch"],
            "feature/task-2"
        );
        assert_eq!(
            records[1]["projection_deltas"][0]["handoff"]["interrupted_active_turn"],
            true
        );
    }

    #[tokio::test]
    async fn dispatches_codex_thread_lifecycle_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let calls = [
            (
                methods::CODEX_THREAD_START,
                json!({ "cwd": "/repo", "model": "gpt-5" }),
            ),
            (
                methods::CODEX_THREAD_RESUME,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_THREAD_READ,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_THREADS_LIST,
                json!({ "include_archived": true, "limit": 10 }),
            ),
            (methods::CODEX_THREADS_LOADED_LIST, json!({})),
            (
                methods::CODEX_THREAD_ARCHIVE,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_THREAD_UNARCHIVE,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_THREAD_DELETE,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_THREAD_UNSUBSCRIBE,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_THREAD_SET_NAME,
                json!({ "thread_id": "thread-1", "name": "Adapter work" }),
            ),
            (
                methods::CODEX_THREAD_UPDATE_METADATA,
                json!({ "thread_id": "thread-1", "metadata": { "project": "ace" } }),
            ),
            (
                methods::CODEX_THREAD_COMPACT,
                json!({ "thread_id": "thread-1" }),
            ),
            (
                methods::CODEX_THREAD_ROLLBACK,
                json!({ "thread_id": "thread-1", "turn_id": "turn-2" }),
            ),
            (
                methods::CODEX_THREAD_INJECT_ITEMS,
                json!({
                    "thread_id": "thread-1",
                    "items": [{ "type": "userMessage", "text": "accepted plan" }]
                }),
            ),
        ];

        for (index, (method, payload)) in calls.iter().enumerate() {
            let response = state
                .dispatch_text(
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "request_id": format!("thread-{index}"),
                        "method": method,
                        "payload": payload
                    })
                    .to_string(),
                )
                .await;
            let response: WsServerResponse = serde_json::from_str(&response).expect("response");
            assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        }

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/start",
                "thread/resume:thread-1",
                "thread/read:thread-1",
                "thread/list",
                "thread/loaded/list",
                "thread/archive:thread-1",
                "thread/unarchive:thread-1",
                "thread/delete:thread-1",
                "thread/unsubscribe:thread-1",
                "thread/name/set:thread-1:Adapter work",
                "thread/metadata/update:thread-1",
                "thread/compact/start:thread-1",
                "thread/rollback:thread-1:turn-2",
                "thread/inject_items:thread-1:1",
            ]
        );

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "thread-lifecycle-snapshot",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };
        let lifecycle = body["providers"][0]["state"]["thread_lifecycle"]
            .as_array()
            .expect("thread lifecycle");
        assert_eq!(lifecycle.len(), 11);
        assert_eq!(lifecycle[0]["action"], "start");
        assert_eq!(lifecycle[0]["thread_id"], "thread-1");
        assert_eq!(lifecycle[0]["request"]["cwd"], "/repo");
        assert_eq!(
            lifecycle[0]["provider_response"]["thread"]["id"],
            "thread-1"
        );
        assert_eq!(lifecycle[1]["action"], "resume");
        assert_eq!(lifecycle[1]["thread_id"], "thread-1");
        assert_eq!(
            lifecycle[1]["provider_response"]["thread"]["id"],
            "thread-1"
        );
        assert_eq!(lifecycle[2]["action"], "archive");
        assert_eq!(lifecycle[2]["provider_response"]["archived"], true);
        assert_eq!(lifecycle[6]["action"], "set_name");
        assert_eq!(lifecycle[6]["name"], "Adapter work");
        assert_eq!(lifecycle[6]["request"]["name"], "Adapter work");
        assert_eq!(lifecycle[7]["action"], "update_metadata");
        assert_eq!(lifecycle[7]["request"]["metadata"]["project"], "ace");
        assert_eq!(lifecycle[9]["action"], "rollback");
        assert_eq!(lifecycle[9]["turn_id"], "turn-2");
        assert_eq!(lifecycle[9]["provider_response"]["rolled_back"], true);
        assert_eq!(lifecycle[10]["action"], "inject_items");
        assert_eq!(lifecycle[10]["item_count"], 1);
        assert_eq!(
            lifecycle[10]["request"]["items"][0]["text"],
            "accepted plan"
        );
        assert_eq!(lifecycle[10]["provider_response"]["injected"], 1);

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "thread-lifecycle-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 20 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 11);
        assert!(records.iter().all(|record| {
            record["event"]["type"] == "runtime_signal"
                && record["event"]["signal"]["kind"] == "thread_lifecycle_changed"
                && record["projection_deltas"][0]["type"] == "thread_lifecycle_changed"
        }));
        assert_eq!(records[0]["event"]["signal"]["status"], "started");
        assert_eq!(records[0]["projection_deltas"][0]["active"], true);
        assert_eq!(records[1]["event"]["signal"]["status"], "resumed");
        assert_eq!(records[2]["event"]["signal"]["status"], "archived");
        assert_eq!(records[2]["projection_deltas"][0]["archived"], true);
        assert_eq!(records[6]["event"]["signal"]["status"], "renamed");
        assert_eq!(records[6]["projection_deltas"][0]["name"], "Adapter work");
        assert_eq!(
            records[7]["event"]["signal"]["metadata"]["thread_metadata"]["project"],
            "ace"
        );
        assert_eq!(
            records[9]["projection_deltas"][0]["metadata"]["turn_id"],
            "turn-2"
        );
        assert_eq!(records[10]["event"]["signal"]["metadata"]["item_count"], 1);
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
            ProviderEvent::ServerRequest {
                request: Box::new(NormalizedServerRequest {
                    kind: ServerRequestKind::CommandApproval,
                    request_id: "42".to_string(),
                    method: "command/approvalRequest".to_string(),
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: Some("item-1".to_string()),
                    scope: Some("command".to_string()),
                    title: Some("Approve command execution".to_string()),
                    prompt: Some("Run tests?".to_string()),
                    selected_policy: Some("on-request".to_string()),
                    metadata: json!({ "command": "cargo test" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("command/approvalRequest".to_string()),
                        schema_version: None,
                        raw_payload: json!({ "command": "cargo test" }),
                    },
                }),
            },
            ProviderEvent::RawNotification {
                method: "item/completed".to_string(),
                params: json!({ "item": { "id": "item-1" } }),
            },
            ProviderEvent::ThreadItem {
                item: Box::new(NormalizedThreadItem {
                    kind: ThreadItemKind::FileChange,
                    status: ThreadItemStatus::Updated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: Some("file-1".to_string()),
                    parent_thread_id: None,
                    child_thread_id: None,
                    sender: None,
                    role: None,
                    title: Some("Edited src/main.rs".to_string()),
                    text: None,
                    status_text: None,
                    model: None,
                    target: Some("src/main.rs".to_string()),
                    url: None,
                    files: Some(json!(["src/main.rs"])),
                    attachments: None,
                    diff: Some(json!("@@ -1 +1 @@")),
                    token_usage: None,
                    plan_questions: None,
                    plan_completion: None,
                    metadata: json!({
                        "diff": "@@ -1 +1 @@",
                        "files": ["src/main.rs"]
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("item/fileChange/patchUpdated".to_string()),
                        schema_version: None,
                        raw_payload: json!({
                            "item": {
                                "type": "fileChange",
                                "id": "file-1"
                            }
                        }),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(ace_runtime::provider::NormalizedRuntimeSignal {
                    kind: ace_runtime::provider::RuntimeSignalKind::Warning,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: Some("Context is almost full".to_string()),
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: None,
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "severity": "warning" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("warning".to_string()),
                        schema_version: None,
                        raw_payload: json!({
                            "threadId": "thread-1",
                            "turnId": "turn-1",
                            "message": "Context is almost full",
                            "severity": "warning"
                        }),
                    },
                }),
            },
            ProviderEvent::RawNotification {
                method: "warning".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "message": "Context is almost full"
                }),
            },
            ProviderEvent::Exited { code: Some(9) },
        ]);

        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));
        let (first_outbound_tx, mut first_outbound_rx) = tokio::sync::mpsc::channel::<String>(8);
        let (second_outbound_tx, mut second_outbound_rx) = tokio::sync::mpsc::channel::<String>(8);

        let subscribe = state
            .dispatch_text_with_events(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-events-first",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
                Some(first_outbound_tx),
            )
            .await;
        let subscribe: WsServerResponse = serde_json::from_str(&subscribe).expect("subscribe");
        assert!(matches!(subscribe.payload, WsServerPayload::Result { .. }));

        let second_subscribe = state
            .dispatch_text_with_events(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-events-second",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": {
                        "provider": "codex",
                        "raw_event_mode": "full"
                    }
                })
                .to_string(),
                Some(second_outbound_tx),
            )
            .await;
        let second_subscribe: WsServerResponse =
            serde_json::from_str(&second_subscribe).expect("second subscribe");
        assert!(matches!(
            second_subscribe.payload,
            WsServerPayload::Result { .. }
        ));

        let pushed =
            tokio::time::timeout(std::time::Duration::from_secs(1), first_outbound_rx.recv())
                .await
                .expect("provider runtime event timeout")
                .expect("provider runtime event");
        let second_pushed =
            tokio::time::timeout(std::time::Duration::from_secs(1), second_outbound_rx.recv())
                .await
                .expect("second provider runtime event timeout")
                .expect("second provider runtime event");
        let pushed: WsServerResponse = serde_json::from_str(&pushed).expect("pushed response");
        let second_pushed: WsServerResponse =
            serde_json::from_str(&second_pushed).expect("second pushed response");
        let WsServerPayload::Event { topic, body } = pushed.payload else {
            panic!("expected websocket event");
        };
        let WsServerPayload::Event {
            topic: second_topic,
            body: second_body,
        } = second_pushed.payload
        else {
            panic!("expected second websocket event");
        };
        assert_eq!(topic, PROVIDER_RUNTIME_EVENT_TOPIC);
        assert_eq!(second_topic, PROVIDER_RUNTIME_EVENT_TOPIC);
        assert_eq!(body["provider"], "codex");
        assert_eq!(second_body["provider"], "codex");
        assert!(
            body["last_persisted_sequence"]
                .as_i64()
                .is_some_and(|sequence| sequence > 0)
        );
        assert_eq!(
            second_body["last_persisted_sequence"],
            body["last_persisted_sequence"]
        );
        assert_eq!(second_body["events"], body["events"]);
        assert_eq!(second_body["projection_deltas"], body["projection_deltas"]);
        assert_eq!(body["events"][0]["type"], "tool_completed");
        assert_eq!(
            body["events"][0]["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );
        assert_eq!(body["events"][1]["type"], "server_request");
        assert_eq!(body["events"][1]["request"]["kind"], "command_approval");
        assert_eq!(body["events"][1]["request"]["prompt"], "Run tests?");
        assert_eq!(body["projection_deltas"][0]["type"], "tool_timeline_upsert");
        assert_eq!(
            body["projection_deltas"][0]["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );
        assert_eq!(body["projection_deltas"][1]["type"], "approval_upsert");
        assert_eq!(body["projection_deltas"][1]["request"]["request_id"], "42");
        assert_eq!(
            body["projection_deltas"][2]["type"],
            "raw_notification_observed"
        );
        assert_eq!(body["projection_deltas"][2]["method"], "item/completed");
        let deltas = body["projection_deltas"]
            .as_array()
            .expect("projection deltas");
        assert!(
            deltas
                .iter()
                .any(|delta| delta["type"] == "thread_item_upsert")
        );
        let details_delta = deltas
            .iter()
            .find(|delta| delta["type"] == "thread_item_details_updated")
            .expect("thread item details delta");
        assert_eq!(details_delta["target"], "src/main.rs");
        assert_eq!(details_delta["files"], json!(["src/main.rs"]));
        assert_eq!(details_delta["diff"], "@@ -1 +1 @@");
        let diff_delta = deltas
            .iter()
            .find(|delta| delta["type"] == "diff_updated")
            .expect("diff delta");
        assert_eq!(diff_delta["files"], json!(["src/main.rs"]));
        assert_eq!(diff_delta["diff"], "@@ -1 +1 @@");
        let warning_delta = deltas
            .iter()
            .find(|delta| delta["type"] == "warning_raised")
            .expect("warning delta");
        assert_eq!(warning_delta["message"], "Context is almost full");
        assert!(
            deltas
                .iter()
                .any(|delta| delta["type"] == "raw_notification_observed"
                    && delta["method"] == "warning")
        );
        let exited_delta = deltas
            .iter()
            .find(|delta| delta["type"] == "provider_exited")
            .expect("provider exited delta");
        assert_eq!(exited_delta["provider"], "codex");
        assert_eq!(exited_delta["code"], 9);
        assert!(
            deltas.iter().any(
                |delta| delta["type"] == "active_turns_cleared" && delta["provider"] == "codex"
            )
        );
        assert_eq!(body["events"][4]["type"], "runtime_signal");
        assert_eq!(body["events"][4]["signal"]["kind"], "warning");
        assert_eq!(body["events"][6]["type"], "exited");
        assert_eq!(body["events"][6]["code"], 9);
        assert_eq!(body["raw_events"], Value::Null);
        assert_eq!(
            body["raw_event_summaries"][2]["event_type"],
            "raw_notification"
        );
        assert_eq!(
            body["raw_event_summaries"][2]["provider_method"],
            "item/completed"
        );
        assert_eq!(second_body["raw_events"][2]["type"], "raw_notification");
        assert_eq!(second_body["raw_events"][2]["method"], "item/completed");

        let pending_requests = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-server-requests-pending",
                    "method": methods::PROVIDER_RUNTIME_SERVER_REQUESTS_LIST,
                    "payload": { "provider": "codex", "status": "pending", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let pending_requests: WsServerResponse =
            serde_json::from_str(&pending_requests).expect("pending requests response");
        let WsServerPayload::Result { body } = pending_requests.payload else {
            panic!("expected pending requests result");
        };
        assert_eq!(body["requests"].as_array().expect("requests").len(), 1);
        assert_eq!(body["requests"][0]["request_id"], "42");
        assert_eq!(body["requests"][0]["status"], "pending");
        assert_eq!(body["requests"][0]["request"]["prompt"], "Run tests?");

        let approval_result = state
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
                            "prompt": "Run tests?",
                            "selected_policy": "on-request",
                            "decided_by": "user",
                            "reason": "trusted command"
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let approval_result: WsServerResponse =
            serde_json::from_str(&approval_result).expect("approval result");
        assert!(matches!(
            approval_result.payload,
            WsServerPayload::Result { .. }
        ));

        let resolved_requests = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-server-requests-resolved",
                    "method": methods::PROVIDER_RUNTIME_SERVER_REQUESTS_LIST,
                    "payload": { "provider": "codex", "status": "resolved", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let resolved_requests: WsServerResponse =
            serde_json::from_str(&resolved_requests).expect("resolved requests response");
        let WsServerPayload::Result { body } = resolved_requests.payload else {
            panic!("expected resolved requests result");
        };
        assert_eq!(body["requests"].as_array().expect("requests").len(), 1);
        assert_eq!(body["requests"][0]["status"], "resolved");
        assert_eq!(body["requests"][0]["decision"]["outcome"], "result");
        assert_eq!(body["requests"][0]["decision"]["payload"]["approved"], true);
        assert_eq!(
            body["requests"][0]["decision"]["audit"]["source_thread_id"],
            "thread-1"
        );

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-events-recent",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 10 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent response");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent provider event result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 8);
        assert_eq!(records[0]["provider"], "codex");
        assert_eq!(records[0]["event"]["type"], "tool_completed");
        assert_eq!(
            records[0]["event"]["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );
        assert_eq!(
            records[0]["projection_deltas"][0]["type"],
            "tool_timeline_upsert"
        );
        assert_eq!(
            records[0]["projection_deltas"][0]["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );
        assert_eq!(records[0]["raw_event"], Value::Null);
        assert_eq!(
            records[0]["raw_event_summary"]["event_type"],
            "semantic_tool"
        );
        assert!(
            records[0]["raw_event_summary"]["raw_json_bytes"]
                .as_u64()
                .is_some_and(|bytes| bytes > 0)
        );
        assert_eq!(
            records[1]["projection_deltas"][0]["type"],
            "approval_upsert"
        );
        assert_eq!(
            records[1]["projection_deltas"][0]["request"]["request_id"],
            "42"
        );
        assert_eq!(
            records[2]["projection_deltas"][0]["type"],
            "raw_notification_observed"
        );
        assert_eq!(
            records[2]["projection_deltas"][0]["method"],
            "item/completed"
        );
        assert_eq!(
            records[2]["raw_event_summary"]["provider_method"],
            "item/completed"
        );
        let replay_cursor = records[1]["sequence"].as_i64().expect("replay cursor");
        let replay_after_cursor = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-events-after-cursor",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": {
                        "provider": "codex",
                        "from_sequence_exclusive": replay_cursor,
                        "limit": 3
                    }
                })
                .to_string(),
            )
            .await;
        let replay_after_cursor: WsServerResponse =
            serde_json::from_str(&replay_after_cursor).expect("cursor replay response");
        let WsServerPayload::Result { body } = replay_after_cursor.payload else {
            panic!("expected cursor replay result");
        };
        let replay_records = body["records"].as_array().expect("cursor replay records");
        assert_eq!(replay_records.len(), 3);
        assert!(
            replay_records
                .iter()
                .all(|record| record["sequence"].as_i64().expect("sequence") > replay_cursor)
        );
        assert_eq!(
            replay_records[0]["event"]["type"],
            records[2]["event"]["type"]
        );
        assert_eq!(
            replay_records[0]["projection_deltas"][0]["type"],
            "raw_notification_observed"
        );

        let recent_full = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-events-recent-full",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": {
                        "provider": "codex",
                        "limit": 10,
                        "raw_event_mode": "full"
                    }
                })
                .to_string(),
            )
            .await;
        let recent_full: WsServerResponse =
            serde_json::from_str(&recent_full).expect("recent full response");
        let WsServerPayload::Result { body } = recent_full.payload else {
            panic!("expected recent provider event full result");
        };
        let full_records = body["records"].as_array().expect("full records");
        assert_eq!(full_records[0]["raw_event"]["type"], "semantic_tool");
        assert_eq!(full_records[2]["raw_event"]["method"], "item/completed");
        assert_eq!(
            records[3]["projection_deltas"][0]["type"],
            "thread_item_upsert"
        );
        let replay_deltas = records[3]["projection_deltas"]
            .as_array()
            .expect("replay deltas");
        assert!(replay_deltas.iter().any(|delta| {
            delta["type"] == "thread_item_details_updated"
                && delta["target"] == "src/main.rs"
                && delta["files"] == json!(["src/main.rs"])
        }));
        assert!(replay_deltas.iter().any(|delta| {
            delta["type"] == "diff_updated" && delta["files"] == json!(["src/main.rs"])
        }));
        assert_eq!(records[4]["projection_deltas"][0]["type"], "warning_raised");
        assert_eq!(
            records[4]["projection_deltas"][0]["message"],
            "Context is almost full"
        );
        assert_eq!(records[4]["event"]["type"], "runtime_signal");
        assert_eq!(records[4]["event"]["signal"]["kind"], "warning");
        assert_eq!(
            records[5]["projection_deltas"][0]["type"],
            "raw_notification_observed"
        );
        assert_eq!(records[5]["projection_deltas"][0]["method"], "warning");
        assert_eq!(records[6]["event"]["type"], "exited");
        assert_eq!(records[6]["event"]["code"], 9);
        assert_eq!(
            records[6]["projection_deltas"][0]["type"],
            "provider_exited"
        );
        assert_eq!(records[6]["projection_deltas"][0]["provider"], "codex");
        assert_eq!(records[6]["projection_deltas"][0]["code"], 9);
        assert_eq!(
            records[6]["projection_deltas"][1]["type"],
            "active_turns_cleared"
        );
        assert_eq!(records[6]["projection_deltas"][1]["provider"], "codex");
        assert_eq!(records[7]["event"]["type"], "server_request_resolved");
        assert_eq!(records[7]["event"]["request_id"], "42");
        assert_eq!(records[7]["event"]["decision"]["outcome"], "result");
        assert_eq!(
            records[7]["projection_deltas"][0]["type"],
            "approval_resolved"
        );
        assert_eq!(
            records[7]["projection_deltas"][0]["decision"]["payload"]["approved"],
            true
        );
        assert_eq!(
            records[7]["projection_deltas"][0]["request"]["prompt"],
            "Run tests?"
        );

        let (replay_outbound_tx, mut replay_outbound_rx) = tokio::sync::mpsc::channel::<String>(2);
        let replay_subscription = state
            .dispatch_text_with_events(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-events-replay-subscribe",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": {
                        "provider": "codex",
                        "from_sequence_exclusive": replay_cursor,
                        "replay_limit": 3,
                        "raw_event_mode": "full"
                    }
                })
                .to_string(),
                Some(replay_outbound_tx),
            )
            .await;
        let replay_subscription: WsServerResponse =
            serde_json::from_str(&replay_subscription).expect("replay subscription response");
        assert!(matches!(
            replay_subscription.payload,
            WsServerPayload::Result { .. }
        ));
        let replay_pushed =
            tokio::time::timeout(std::time::Duration::from_secs(1), replay_outbound_rx.recv())
                .await
                .expect("provider runtime replay event timeout")
                .expect("provider runtime replay event");
        let replay_pushed: WsServerResponse =
            serde_json::from_str(&replay_pushed).expect("replay pushed response");
        let WsServerPayload::Event { topic, body } = replay_pushed.payload else {
            panic!("expected replay websocket event");
        };
        assert_eq!(topic, PROVIDER_RUNTIME_EVENT_TOPIC);
        assert_eq!(body["provider"], "codex");
        assert_eq!(body["events"].as_array().expect("events").len(), 3);
        assert_eq!(
            body["last_persisted_sequence"],
            replay_records[2]["sequence"]
        );
        assert_eq!(body["raw_events"][0]["type"], "raw_notification");

        let (ace_outbound_tx, _ace_outbound_rx) = tokio::sync::mpsc::channel::<String>(1);
        let ace_subscription = state
            .dispatch_text_with_events(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-events-ace",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": { "provider": "ace" }
                })
                .to_string(),
                Some(ace_outbound_tx),
            )
            .await;
        let ace_subscription: WsServerResponse =
            serde_json::from_str(&ace_subscription).expect("ace subscription response");
        let WsServerPayload::Result { body } = ace_subscription.payload else {
            panic!("expected ace provider event result");
        };
        assert_eq!(body["subscribed"], true);
        assert_eq!(body["provider"], "ace");
    }

    #[tokio::test]
    async fn provider_runtime_subscription_reports_lag_as_warning_event() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));

        let (provider_sender, _) = broadcast::channel(1);
        state
            .provider_event_streams
            .lock()
            .expect("provider event streams")
            .insert(ProviderKind::Codex, provider_sender.clone());

        let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::channel::<String>(1);
        let subscribe = state
            .dispatch_text_with_events(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-events-lag",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": {
                        "provider": "codex",
                        "raw_event_mode": "full"
                    }
                })
                .to_string(),
                Some(outbound_tx),
            )
            .await;
        let subscribe: WsServerResponse = serde_json::from_str(&subscribe).expect("subscribe");
        assert!(matches!(subscribe.payload, WsServerPayload::Result { .. }));

        provider_sender
            .send(ProviderEventStreamMessage::Events {
                events: vec![ProviderEvent::RawNotification {
                    method: "first".to_string(),
                    params: json!({}),
                }],
                last_persisted_sequence: None,
            })
            .expect("send first event");
        for index in 0..8 {
            provider_sender
                .send(ProviderEventStreamMessage::Events {
                    events: vec![ProviderEvent::RawNotification {
                        method: format!("overflow-{index}"),
                        params: json!({ "index": index }),
                    }],
                    last_persisted_sequence: None,
                })
                .expect("send overflow event");
        }

        let mut warning_body = None;
        for _ in 0..8 {
            let pushed =
                tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
                    .await
                    .expect("provider runtime lag event timeout")
                    .expect("provider runtime lag event");
            let pushed: WsServerResponse =
                serde_json::from_str(&pushed).expect("provider runtime response");
            let WsServerPayload::Event { topic, body } = pushed.payload else {
                panic!("expected provider runtime event");
            };
            assert_eq!(topic, PROVIDER_RUNTIME_EVENT_TOPIC);
            let has_lag_warning = body["events"]
                .as_array()
                .expect("events")
                .iter()
                .any(|event| {
                    event["type"] == "runtime_signal"
                        && event["signal"]["kind"] == "warning"
                        && event["signal"]["provider"]["method"]
                            == "ace/provider_runtime/subscriber_lagged"
                });
            if has_lag_warning {
                warning_body = Some(body);
                break;
            }
        }

        let warning_body = warning_body.expect("subscriber lag warning");
        assert_eq!(warning_body["provider"], "codex");
        assert_eq!(
            warning_body["projection_deltas"][0]["type"],
            "warning_raised"
        );
        assert_eq!(
            warning_body["raw_event_summaries"][0]["provider_method"],
            "ace/provider_runtime/subscriber_lagged"
        );
        assert_eq!(
            warning_body["raw_events"][0]["signal"]["metadata"]["source"],
            "provider_runtime_subscription"
        );
        assert!(
            warning_body["raw_events"][0]["signal"]["metadata"]["skipped_event_batches"]
                .as_u64()
                .expect("skipped event batches")
                > 0
        );
    }

    #[tokio::test]
    async fn provider_runtime_normalizes_ace_native_semantic_tool_events_over_ws() {
        let backend = Arc::new(FakeCodexBackend::default());
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
                    "request_id": "ace-provider-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": {
                        "provider": "ace",
                        "raw_event_mode": "full"
                    }
                })
                .to_string(),
                Some(outbound_tx),
            )
            .await;
        let subscribe: WsServerResponse = serde_json::from_str(&subscribe).expect("subscribe");
        let WsServerPayload::Result { body } = subscribe.payload else {
            panic!("expected subscribe result");
        };
        assert_eq!(body["subscribed"], true);
        assert_eq!(body["provider"], "ace");

        let emit = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "ace-semantic-tool-emit",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "ace",
                        "method": "ace.semantic_tool.normalize",
                        "params": {
                            "emit": true,
                            "input": {
                                "transport": "mcp",
                                "status": "completed",
                                "item_type": "mcpToolCall",
                                "provider": {
                                    "provider": "future-provider",
                                    "method": "tool/call",
                                    "item_id": "tool-1",
                                    "turn_id": "turn-1",
                                    "thread_id": "thread-1",
                                    "server_name": "browser",
                                    "tool_name": "playwright_locator_click",
                                    "operation": "playwright_locator_click",
                                    "raw_args": {
                                        "label": "Deploy",
                                        "selector": "#deploy"
                                    },
                                    "raw_result": { "ok": true },
                                    "raw_payload": {
                                        "providerSpecificEnvelope": true
                                    }
                                }
                            }
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let emit: WsServerResponse = serde_json::from_str(&emit).expect("emit response");
        let WsServerPayload::Result { body } = emit.payload else {
            panic!("expected emit result");
        };
        assert_eq!(body["accepted"], true);
        assert_eq!(body["emitted"], true);
        assert_eq!(body["event_count"], 1);
        assert_eq!(
            body["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );

        let pushed = tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
            .await
            .expect("ace provider runtime event timeout")
            .expect("ace provider runtime event");
        let pushed: WsServerResponse = serde_json::from_str(&pushed).expect("pushed response");
        let WsServerPayload::Event { topic, body } = pushed.payload else {
            panic!("expected websocket event");
        };

        assert_eq!(topic, PROVIDER_RUNTIME_EVENT_TOPIC);
        assert_eq!(body["provider"], "ace");
        assert_eq!(body["events"][0]["type"], "tool_completed");
        assert_eq!(
            body["events"][0]["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );
        assert_eq!(
            body["events"][0]["tool"]["provider"]["raw_args"],
            json!({ "label": "Deploy", "selector": "#deploy" })
        );
        assert_eq!(
            body["events"][0]["tool"]["provider"]["raw_payload"],
            json!({ "providerSpecificEnvelope": true })
        );
        assert_eq!(body["raw_events"][0]["type"], "semantic_tool");
        assert_eq!(
            body["projection_deltas"][0]["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );
    }

    #[tokio::test]
    async fn provider_runtime_normalizes_ace_native_server_requests_over_ws() {
        let backend = Arc::new(FakeCodexBackend::default());
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
                    "request_id": "ace-provider-server-requests",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": {
                        "provider": "ace",
                        "raw_event_mode": "full"
                    }
                })
                .to_string(),
                Some(outbound_tx),
            )
            .await;
        let subscribe: WsServerResponse = serde_json::from_str(&subscribe).expect("subscribe");
        let WsServerPayload::Result { body } = subscribe.payload else {
            panic!("expected subscribe result");
        };
        assert_eq!(body["subscribed"], true);

        let normalize = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "ace-server-request-normalize",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "ace",
                        "method": "ace.server_request.normalize",
                        "params": {
                            "provider": "future-provider",
                            "request_id": "approval-1",
                            "method": "fileChange/approvalRequest",
                            "emit": true,
                            "params": {
                                "threadId": "thread-1",
                                "turnId": "turn-1",
                                "itemId": "item-1",
                                "path": "src/lib.rs",
                                "diff": "@@ -1 +1 @@",
                                "prompt": "Approve edit?",
                                "approvalPolicy": "on-request"
                            }
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let normalize: WsServerResponse =
            serde_json::from_str(&normalize).expect("normalize response");
        let WsServerPayload::Result { body } = normalize.payload else {
            panic!("expected normalize result");
        };
        assert_eq!(body["accepted"], true);
        assert_eq!(body["emitted"], true);
        assert_eq!(body["request"]["kind"], "file_change_approval");
        assert_eq!(body["request"]["scope"], "filesystem");
        assert_eq!(body["request"]["prompt"], "Approve edit?");
        assert_eq!(body["request"]["provider"]["provider"], "future-provider");

        let pushed = tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
            .await
            .expect("ace provider server request event timeout")
            .expect("ace provider server request event");
        let pushed: WsServerResponse = serde_json::from_str(&pushed).expect("pushed response");
        let WsServerPayload::Event { topic, body } = pushed.payload else {
            panic!("expected websocket event");
        };
        assert_eq!(topic, PROVIDER_RUNTIME_EVENT_TOPIC);
        assert_eq!(body["provider"], "ace");
        assert_eq!(body["events"][0]["type"], "server_request");
        assert_eq!(body["events"][0]["request"]["kind"], "file_change_approval");
        assert_eq!(body["events"][0]["request"]["request_id"], "approval-1");
        assert_eq!(
            body["events"][0]["request"]["provider"]["raw_payload"]["diff"],
            "@@ -1 +1 @@"
        );
        assert_eq!(body["raw_events"][0]["type"], "server_request");
        assert_eq!(body["projection_deltas"][0]["type"], "approval_upsert");
        assert_eq!(
            body["projection_deltas"][0]["request"]["provider"]["provider"],
            "future-provider"
        );
    }

    #[tokio::test]
    async fn provider_runtime_normalizes_ace_native_thread_items_over_ws() {
        let backend = Arc::new(FakeCodexBackend::default());
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
                    "request_id": "ace-provider-thread-items",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": {
                        "provider": "ace",
                        "raw_event_mode": "full"
                    }
                })
                .to_string(),
                Some(outbound_tx),
            )
            .await;
        let subscribe: WsServerResponse = serde_json::from_str(&subscribe).expect("subscribe");
        let WsServerPayload::Result { body } = subscribe.payload else {
            panic!("expected subscribe result");
        };
        assert_eq!(body["subscribed"], true);

        let normalize = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "ace-thread-item-normalize",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "ace",
                        "method": "ace.thread_item.normalize",
                        "params": {
                            "provider": "future-provider",
                            "method": "item/agentMessage/delta",
                            "emit": true,
                            "params": {
                                "threadId": "thread-1",
                                "turnId": "turn-1",
                                "itemId": "agent-1",
                                "delta": "Working on it"
                            }
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let normalize: WsServerResponse =
            serde_json::from_str(&normalize).expect("normalize response");
        let WsServerPayload::Result { body } = normalize.payload else {
            panic!("expected normalize result");
        };
        assert_eq!(body["accepted"], true);
        assert_eq!(body["emitted"], true);
        assert_eq!(body["event_count"], 1);
        assert_eq!(body["item"]["kind"], "agentMessage");
        assert_eq!(body["item"]["status"], "updated");
        assert_eq!(body["item"]["text"], "Working on it");
        assert_eq!(body["item"]["provider"]["provider"], "future-provider");

        let pushed = tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
            .await
            .expect("ace provider thread item event timeout")
            .expect("ace provider thread item event");
        let pushed: WsServerResponse = serde_json::from_str(&pushed).expect("pushed response");
        let WsServerPayload::Event { topic, body } = pushed.payload else {
            panic!("expected websocket event");
        };
        assert_eq!(topic, PROVIDER_RUNTIME_EVENT_TOPIC);
        assert_eq!(body["provider"], "ace");
        assert_eq!(body["events"][0]["type"], "thread_item");
        assert_eq!(body["events"][0]["item"]["kind"], "agentMessage");
        assert_eq!(body["events"][0]["item"]["text"], "Working on it");
        assert_eq!(
            body["events"][0]["item"]["provider"]["raw_payload"]["threadId"],
            "thread-1"
        );
        assert_eq!(body["raw_events"][0]["type"], "thread_item");
        assert_eq!(body["projection_deltas"][0]["type"], "thread_item_upsert");
        assert_eq!(
            body["projection_deltas"][0]["item"]["provider"]["provider"],
            "future-provider"
        );
    }

    #[tokio::test]
    async fn provider_runtime_normalizes_ace_native_runtime_signals_over_ws() {
        let backend = Arc::new(FakeCodexBackend::default());
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
                    "request_id": "ace-provider-runtime-signals",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE,
                    "payload": {
                        "provider": "ace",
                        "raw_event_mode": "full"
                    }
                })
                .to_string(),
                Some(outbound_tx),
            )
            .await;
        let subscribe: WsServerResponse = serde_json::from_str(&subscribe).expect("subscribe");
        let WsServerPayload::Result { body } = subscribe.payload else {
            panic!("expected subscribe result");
        };
        assert_eq!(body["subscribed"], true);

        let normalize = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "ace-runtime-signal-normalize",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "ace",
                        "method": "ace.runtime_signal.normalize",
                        "params": {
                            "provider": "future-provider",
                            "method": "thread/name/updated",
                            "emit": true,
                            "params": {
                                "thread": {
                                    "id": "thread-1",
                                    "name": "Adapter parity"
                                },
                                "schemaVersion": "future-v1"
                            }
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let normalize: WsServerResponse =
            serde_json::from_str(&normalize).expect("normalize response");
        let WsServerPayload::Result { body } = normalize.payload else {
            panic!("expected normalize result");
        };
        assert_eq!(body["accepted"], true);
        assert_eq!(body["emitted"], true);
        assert_eq!(body["event_count"], 1);
        assert_eq!(body["signal"]["kind"], "thread_lifecycle_changed");
        assert_eq!(body["signal"]["thread_id"], "thread-1");
        assert_eq!(body["signal"]["status"], "renamed");
        assert_eq!(body["signal"]["name"], "Adapter parity");
        assert_eq!(body["signal"]["provider"]["provider"], "future-provider");

        let pushed = tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
            .await
            .expect("ace provider runtime signal event timeout")
            .expect("ace provider runtime signal event");
        let pushed: WsServerResponse = serde_json::from_str(&pushed).expect("pushed response");
        let WsServerPayload::Event { topic, body } = pushed.payload else {
            panic!("expected websocket event");
        };
        assert_eq!(topic, PROVIDER_RUNTIME_EVENT_TOPIC);
        assert_eq!(body["provider"], "ace");
        assert_eq!(body["events"][0]["type"], "runtime_signal");
        assert_eq!(
            body["events"][0]["signal"]["kind"],
            "thread_lifecycle_changed"
        );
        assert_eq!(
            body["events"][0]["signal"]["provider"]["raw_payload"]["schemaVersion"],
            "future-v1"
        );
        assert_eq!(body["raw_events"][0]["type"], "runtime_signal");
        assert_eq!(
            body["projection_deltas"][0]["type"],
            "thread_lifecycle_changed"
        );
        assert_eq!(body["projection_deltas"][0]["thread_id"], "thread-1");
        assert_eq!(body["projection_deltas"][0]["name"], "Adapter parity");
    }

    #[tokio::test]
    async fn provider_runtime_filters_pending_server_requests_for_inactive_thread_routing() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));

        let request = |request_id: &str,
                       kind: ServerRequestKind,
                       thread_id: &str,
                       item_id: &str,
                       scope: &str,
                       method: &str,
                       prompt: &str,
                       metadata: Value| {
            ProviderEvent::ServerRequest {
                request: Box::new(NormalizedServerRequest {
                    kind,
                    request_id: request_id.to_string(),
                    method: method.to_string(),
                    thread_id: Some(thread_id.to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: Some(item_id.to_string()),
                    scope: Some(scope.to_string()),
                    title: Some("Approval".to_string()),
                    prompt: Some(prompt.to_string()),
                    selected_policy: Some("on-request".to_string()),
                    metadata: metadata.clone(),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some(method.to_string()),
                        schema_version: None,
                        raw_payload: metadata,
                    },
                }),
            }
        };
        state
            .provider_events
            .lock()
            .expect("provider events")
            .append_batch(
                "codex",
                &[
                    request(
                        "1",
                        ServerRequestKind::CommandApproval,
                        "thread-active",
                        "cmd-1",
                        "command",
                        "command/approvalRequest",
                        "Run active command?",
                        json!({ "command": "cargo check" }),
                    ),
                    request(
                        "2",
                        ServerRequestKind::FileChangeApproval,
                        "thread-inactive",
                        "file-1",
                        "filesystem",
                        "fileChange/approvalRequest",
                        "Apply inactive patch?",
                        json!({ "path": "src/lib.rs" }),
                    ),
                    request(
                        "3",
                        ServerRequestKind::CommandApproval,
                        "thread-other",
                        "cmd-2",
                        "command",
                        "command/approvalRequest",
                        "Run other command?",
                        json!({ "command": "cargo test" }),
                    ),
                ],
            )
            .expect("append pending requests");

        let inactive_file = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "pending-inactive-file",
                    "method": methods::PROVIDER_RUNTIME_SERVER_REQUESTS_LIST,
                    "payload": {
                        "provider": "codex",
                        "status": "pending",
                        "thread_id": "thread-inactive",
                        "scope": "filesystem",
                        "kind": "file_change_approval",
                        "limit": 1
                    }
                })
                .to_string(),
            )
            .await;
        let inactive_file: WsServerResponse =
            serde_json::from_str(&inactive_file).expect("inactive file response");
        let WsServerPayload::Result { body } = inactive_file.payload else {
            panic!("expected inactive file result");
        };
        let requests = body["requests"].as_array().expect("requests");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["request_id"], "2");
        assert_eq!(requests[0]["request"]["thread_id"], "thread-inactive");
        assert_eq!(requests[0]["request"]["kind"], "file_change_approval");
        assert_eq!(requests[0]["request"]["scope"], "filesystem");

        let command_requests = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "pending-command-requests",
                    "method": methods::PROVIDER_RUNTIME_SERVER_REQUESTS_LIST,
                    "payload": {
                        "provider": "codex",
                        "status": "pending",
                        "scope": "command",
                        "kind": "command_approval",
                        "limit": 10
                    }
                })
                .to_string(),
            )
            .await;
        let command_requests: WsServerResponse =
            serde_json::from_str(&command_requests).expect("command requests response");
        let WsServerPayload::Result { body } = command_requests.payload else {
            panic!("expected command requests result");
        };
        let mut request_ids = body["requests"]
            .as_array()
            .expect("requests")
            .iter()
            .map(|request| request["request_id"].as_str().expect("request id"))
            .collect::<Vec<_>>();
        request_ids.sort_unstable();
        assert_eq!(request_ids, vec!["1", "3"]);

        let empty = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "pending-empty-thread",
                    "method": methods::PROVIDER_RUNTIME_SERVER_REQUESTS_LIST,
                    "payload": {
                        "provider": "codex",
                        "status": "pending",
                        "thread_id": "missing-thread",
                        "limit": 10
                    }
                })
                .to_string(),
            )
            .await;
        let empty: WsServerResponse = serde_json::from_str(&empty).expect("empty response");
        let WsServerPayload::Result { body } = empty.payload else {
            panic!("expected empty result");
        };
        assert_eq!(body["requests"].as_array().expect("requests").len(), 0);
    }

    #[tokio::test]
    async fn provider_runtime_lists_and_routes_registered_providers() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let list = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "providers-list",
                    "method": methods::PROVIDER_RUNTIME_PROVIDERS_LIST,
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let list: WsServerResponse = serde_json::from_str(&list).expect("list response");
        let WsServerPayload::Result { body } = list.payload else {
            panic!("expected provider list");
        };
        assert_eq!(body["providers"][0]["kind"], "Codex");
        assert!(
            body["providers"][0]["capabilities"]
                .as_array()
                .expect("capabilities")
                .iter()
                .any(|capability| capability["key"] == "provider.adapter_contract")
        );
        assert!(
            body["providers"][0]["capabilities"]
                .as_array()
                .expect("capabilities")
                .iter()
                .any(|capability| capability["key"] == "provider.runtime.raw_request")
        );
        assert!(
            body["providers"][0]["capabilities"]
                .as_array()
                .expect("capabilities")
                .iter()
                .any(|capability| capability["key"] == "codex.execution_location.local")
        );
        assert!(
            body["providers"][0]["capabilities"]
                .as_array()
                .expect("capabilities")
                .iter()
                .any(|capability| capability["key"] == "codex.execution_location.worktree")
        );
        assert!(
            body["providers"][0]["capabilities"]
                .as_array()
                .expect("capabilities")
                .iter()
                .all(|capability| capability["key"] != "codex.execution_location.cloud")
        );
        assert!(
            body["providers"].as_array().expect("providers").iter().any(
                |provider| provider["kind"] == "Ace"
                    && provider["capabilities"]
                        .as_array()
                        .expect("ace capabilities")
                        .iter()
                        .any(|capability| capability["key"] == "ace.provider_contract")
            )
        );
        let runtime = body["runtime"].as_array().expect("runtime providers");
        let codex_runtime = runtime
            .iter()
            .find(|provider| provider["runtime_id"] == "codex")
            .expect("codex runtime provider");
        assert_eq!(codex_runtime["provider"], "Codex");
        assert_eq!(codex_runtime["display_name"], "Codex");
        assert_eq!(codex_runtime["descriptor"]["kind"], "Codex");
        assert_eq!(codex_runtime["supports_events"], true);
        assert_eq!(codex_runtime["supports_server_request_responses"], true);
        assert_eq!(codex_runtime["contract"]["satisfies_required"], true);
        assert_eq!(codex_runtime["adapter_profile"]["provider"], "Codex");
        assert_eq!(codex_runtime["adapter_profile"]["contract_version"], 3);
        assert_eq!(codex_runtime["adapter_profile"]["websocket_first"], true);
        assert_eq!(
            codex_runtime["adapter_runtime"]["satisfies_required_hooks"],
            true
        );
        assert!(
            codex_runtime["adapter_runtime"]["missing_required_hooks"]
                .as_array()
                .expect("missing required hooks")
                .is_empty()
        );
        assert!(
            codex_runtime["adapter_profile"]["operations"]
                .as_array()
                .expect("adapter profile operations")
                .iter()
                .any(|operation| operation["operation"] == "thread_read"
                    && operation["invocation"] == "direct_provider_method")
        );

        let ace_runtime = runtime
            .iter()
            .find(|provider| provider["runtime_id"] == "ace")
            .expect("ace runtime provider");
        assert_eq!(ace_runtime["provider"], "Ace");
        assert_eq!(ace_runtime["display_name"], "Ace");
        assert_eq!(ace_runtime["descriptor"]["kind"], "Ace");
        assert_eq!(ace_runtime["supports_events"], true);
        assert_eq!(ace_runtime["supports_server_request_responses"], true);
        assert_eq!(ace_runtime["contract"]["satisfies_required"], true);
        assert_eq!(ace_runtime["adapter_profile"]["provider"], "Ace");
        assert_eq!(
            ace_runtime["adapter_profile"]["contract_report"]["satisfies_required"],
            true
        );
        assert_eq!(
            ace_runtime["adapter_runtime"]["satisfies_required_hooks"],
            true
        );
        assert!(
            ace_runtime["adapter_runtime"]["missing_required_hooks"]
                .as_array()
                .expect("ace missing hooks")
                .is_empty()
        );

        let routed = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-request",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "method": "thread/read",
                        "params": { "threadId": "thread-1" },
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let routed: WsServerResponse = serde_json::from_str(&routed).expect("routed response");
        assert!(matches!(routed.payload, WsServerPayload::Result { .. }));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["thread/read"]
        );

        let routed_operation = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-operation-request",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "operation": "thread_read",
                        "params": { "thread_id": "thread-2" },
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let routed_operation: WsServerResponse =
            serde_json::from_str(&routed_operation).expect("operation response");
        assert!(matches!(
            routed_operation.payload,
            WsServerPayload::Result { .. }
        ));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["thread/read", "thread/read:thread-2"]
        );

        let routed_fs_operation = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-fs-operation-request",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "operation": "fs_read_file",
                        "params": { "path": "src/lib.rs" },
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let routed_fs_operation: WsServerResponse =
            serde_json::from_str(&routed_fs_operation).expect("filesystem operation response");
        assert!(matches!(
            routed_fs_operation.payload,
            WsServerPayload::Result { .. }
        ));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["thread/read", "thread/read:thread-2", "fs/readFile"]
        );

        let composite_operation = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-composite-operation",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "operation": "plan_fork_for_implementation",
                        "params": {
                            "thread_id": "thread-2",
                            "plan": { "markdown": "Build the adapter router" },
                            "prompt": "implement it",
                            "model": "gpt-5.5"
                        },
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let composite_operation: WsServerResponse =
            serde_json::from_str(&composite_operation).expect("composite operation response");
        assert!(matches!(
            composite_operation.payload,
            WsServerPayload::Result { .. }
        ));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/read",
                "thread/read:thread-2",
                "fs/readFile",
                "thread/fork:thread-2:false",
                "thread/inject_items:fork-1:1",
                "turn/start:fork-1"
            ]
        );

        let deferred_operation = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-deferred-operation",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "operation": "cloud_handoff",
                        "params": {},
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let deferred_operation: WsServerResponse =
            serde_json::from_str(&deferred_operation).expect("deferred operation response");
        let WsServerPayload::Error { code, message } = deferred_operation.payload else {
            panic!("expected deferred operation error");
        };
        assert_eq!(code, "bad_request");
        assert!(message.contains("intentionally deferred"));

        let event_stream_operation = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-event-stream-operation",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "operation": "provider_events",
                        "params": {},
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let event_stream_operation: WsServerResponse =
            serde_json::from_str(&event_stream_operation).expect("event stream operation response");
        let WsServerPayload::Error { code, message } = event_stream_operation.payload else {
            panic!("expected event stream operation error");
        };
        assert_eq!(code, "bad_request");
        assert!(message.contains("event-stream driven"));

        let command_without_marker = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-command-missing-marker",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "method": "command/exec",
                        "params": { "command": "cargo test" },
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let command_without_marker: WsServerResponse =
            serde_json::from_str(&command_without_marker).expect("provider command marker error");
        let WsServerPayload::Error { code, message } = command_without_marker.payload else {
            panic!("expected provider command marker error");
        };
        assert_eq!(code, "bad_request");
        assert!(message.contains("userInitiated: true"));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/read",
                "thread/read:thread-2",
                "fs/readFile",
                "thread/fork:thread-2:false",
                "thread/inject_items:fork-1:1",
                "turn/start:fork-1"
            ]
        );

        let command_with_marker = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-command-with-marker",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "method": "command/exec",
                        "params": {
                            "userInitiated": true,
                            "command": "cargo test"
                        },
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let command_with_marker: WsServerResponse =
            serde_json::from_str(&command_with_marker).expect("provider command response");
        assert!(matches!(
            command_with_marker.payload,
            WsServerPayload::Result { .. }
        ));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/read",
                "thread/read:thread-2",
                "fs/readFile",
                "thread/fork:thread-2:false",
                "thread/inject_items:fork-1:1",
                "turn/start:fork-1",
                "command/exec"
            ]
        );

        let command_operation_with_marker = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-command-operation-with-marker",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "operation": "command_exec",
                        "params": {
                            "userInitiated": true,
                            "command": "cargo check"
                        },
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let command_operation_with_marker: WsServerResponse =
            serde_json::from_str(&command_operation_with_marker)
                .expect("provider command operation response");
        assert!(matches!(
            command_operation_with_marker.payload,
            WsServerPayload::Result { .. }
        ));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/read",
                "thread/read:thread-2",
                "fs/readFile",
                "thread/fork:thread-2:false",
                "thread/inject_items:fork-1:1",
                "turn/start:fork-1",
                "command/exec",
                "command/exec"
            ]
        );

        let deferred_codex = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-request-deferred",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "method": "cloud/handoff",
                        "params": {},
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let deferred_codex: WsServerResponse =
            serde_json::from_str(&deferred_codex).expect("deferred codex response");
        let WsServerPayload::Error { code, message } = deferred_codex.payload else {
            panic!("expected deferred codex error");
        };
        assert_eq!(code, "provider_request_failed");
        assert!(message.contains("intentionally deferred"));

        let unknown_codex = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-request-unknown-method",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "method": "command/approvalRequest",
                        "params": {},
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let unknown_codex: WsServerResponse =
            serde_json::from_str(&unknown_codex).expect("unknown codex response");
        let WsServerPayload::Error { code, message } = unknown_codex.payload else {
            panic!("expected unknown codex method error");
        };
        assert_eq!(code, "provider_request_failed");
        assert!(message.contains("unknown Codex client request method"));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "thread/read",
                "thread/read:thread-2",
                "fs/readFile",
                "thread/fork:thread-2:false",
                "thread/inject_items:fork-1:1",
                "turn/start:fork-1",
                "command/exec",
                "command/exec"
            ]
        );

        let ace = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "ace-provider-request",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "ace",
                        "method": "ace.contract",
                        "params": {},
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let ace: WsServerResponse = serde_json::from_str(&ace).expect("ace response");
        let WsServerPayload::Result { body } = ace.payload else {
            panic!("expected ace contract result");
        };
        assert_eq!(body["provider"], "ace");
        assert_eq!(
            body["provider_requirements"]["tools"],
            "map provider tool calls to SemanticToolCall when possible"
        );

        let unknown_provider = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "unknown-provider-request",
                    "method": methods::PROVIDER_RUNTIME_REQUEST,
                    "payload": {
                        "provider": "unknown-provider",
                        "method": "thread/read",
                        "params": {},
                        "timeout_ms": 1000
                    }
                })
                .to_string(),
            )
            .await;
        let unknown_provider: WsServerResponse =
            serde_json::from_str(&unknown_provider).expect("unknown provider response");
        let WsServerPayload::Error { code, .. } = unknown_provider.payload else {
            panic!("expected unknown provider error");
        };
        assert_eq!(code, "bad_request");

        let contract = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-contract",
                    "method": methods::PROVIDER_RUNTIME_CONTRACT,
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let contract: WsServerResponse =
            serde_json::from_str(&contract).expect("contract response");
        let WsServerPayload::Result { body } = contract.payload else {
            panic!("expected provider contract result");
        };
        assert_eq!(body["adapter_contract"]["version"], 3);
        assert_eq!(body["adapter_contract"]["websocket_first"], true);
        assert_eq!(
            body["adapter_contract"]["raw_payload"]["retention"],
            "preserve_provider_payloads"
        );
        assert_eq!(
            body["adapter_contract"]["raw_payload"]["preserve_provider_method"],
            true
        );
        assert_eq!(
            body["adapter_contract"]["raw_payload"]["preserve_provider_ids"],
            true
        );
        assert_eq!(
            body["adapter_contract"]["raw_payload"]["preserve_raw_args"],
            true
        );
        assert_eq!(
            body["adapter_contract"]["raw_payload"]["preserve_raw_result"],
            true
        );
        assert_eq!(
            body["adapter_contract"]["raw_payload"]["large_payload_strategy"],
            "store_once_reference_deltas"
        );
        assert!(
            body["adapter_contract"]["required_capabilities"]
                .as_array()
                .expect("required capabilities")
                .iter()
                .any(
                    |capability| capability["key"] == "provider.adapter_contract"
                        && capability["required"] == true
                )
        );
        let operations = body["adapter_contract"]["operations"]
            .as_array()
            .expect("adapter operations");
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "plan_fork_for_implementation"
                && operation["support"] == "required"
                && operation["provider_methods"]
                    .as_array()
                    .expect("provider methods")
                    .contains(&json!("thread/fork"))
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "subagent_steer"
                && operation["canonical_method"] == "subagent/steer"
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "handoff_to_location"
                && operation["category"] == "handoff"
                && operation["support"] == "required"
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "mcp_tool_call" && operation["support"] == "version_gated"
        }));
        let reports = body["reports"].as_array().expect("contract reports");
        assert!(reports.iter().any(|report| {
            report["provider"] == "Ace"
                && report["satisfies_required"] == true
                && report["missing_required"]
                    .as_array()
                    .expect("missing")
                    .is_empty()
        }));
        assert!(reports.iter().any(|report| {
            report["provider"] == "Codex"
                && report["satisfies_required"] == true
                && report["missing_required"]
                    .as_array()
                    .expect("missing")
                    .is_empty()
        }));
    }

    #[tokio::test]
    async fn provider_runtime_lists_adapter_operations_by_invocation_path() {
        let backend = Arc::new(FakeCodexBackend::default());
        *backend
            .supported_client_request_methods
            .lock()
            .expect("supported methods") = Some(vec![
            "thread/read".to_string(),
            "thread/fork".to_string(),
            "thread/inject_items".to_string(),
            "turn/start".to_string(),
            "command/exec".to_string(),
            "fs/readFile".to_string(),
            "skills/config/write".to_string(),
            "skills/extraRoots/set".to_string(),
            "plugin/installed".to_string(),
            "plugin/read".to_string(),
            "plugin/uninstall".to_string(),
            "plugin/share/save".to_string(),
            "account/read".to_string(),
            "config/value/write".to_string(),
            "fuzzyFileSearch".to_string(),
            "marketplace/upgrade".to_string(),
            "model/list".to_string(),
            "modelProvider/capabilities/read".to_string(),
        ]);
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));

        let list = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-operations",
                    "method": methods::PROVIDER_RUNTIME_OPERATIONS_LIST,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let list: WsServerResponse = serde_json::from_str(&list).expect("operations response");
        let WsServerPayload::Result { body } = list.payload else {
            panic!("expected provider operation list");
        };
        assert_eq!(body["adapter_contract"]["version"], 3);
        assert_eq!(
            body["providers"][0]["adapter_runtime"]["satisfies_required_hooks"],
            true
        );

        let providers = body["providers"].as_array().expect("providers");
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0]["runtime_id"], "codex");
        let operations = providers[0]["operations"].as_array().expect("operations");

        assert!(operations.iter().any(|operation| {
            operation["operation"] == "thread_read"
                && operation["invocation"] == "direct_provider_method"
                && operation["availability"] == "available"
                && operation.get("availability_reason").is_none()
                && operation["direct_invocation"] == true
                && operation["provider_methods"] == json!(["thread/read"])
                && operation["policy"]["read_only"] == true
                && operation["policy"]["approval_boundary"] == false
                && operation["runtime_request"]["invokable"] == true
                && operation["runtime_request"]["mode"] == "adapter_operation"
                && operation["runtime_request"]["params"] == "adapter_normalized"
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "thread_shell_command"
                && operation["policy"]["requires_user_initiation"] == true
                && operation["policy"]["escapes_thread_sandbox"] == true
                && operation["policy"]["approval_boundary"] == true
                && operation["policy"]["reason"]
                    .as_str()
                    .is_some_and(|reason| reason.contains("outside the thread sandbox"))
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "fs_write_file"
                && operation["policy"]["read_only"] == false
                && operation["policy"]["mutates_workspace"] == true
                && operation["policy"]["approval_boundary"] == true
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "plan_fork_for_implementation"
                && operation["invocation"] == "composite_typed_api"
                && operation["availability"] == "available"
                && operation["direct_invocation"] == false
                && operation["runtime_request"]["invokable"] == true
                && operation["runtime_request"]["mode"] == "adapter_operation"
                && operation["runtime_request"]["params"] == "adapter_normalized"
                && operation["provider_methods"]
                    .as_array()
                    .expect("provider methods")
                    .contains(&json!("thread/fork"))
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "command_exec"
                && operation["support"] == "version_gated"
                && operation["availability"] == "version_gated"
                && operation["runtime_gate"]["kind"] == "version_gated_provider_method"
                && operation["runtime_gate"]["provider_methods"] == json!(["command/exec"])
                && operation["runtime_gate_resolution"]["status"] == "available"
                && operation["runtime_gate_resolution"]["source"]
                    == "supported_client_request_methods"
                && operation["runtime_gate_resolution"]["missing_provider_methods"] == json!([])
                && operation["availability_reason"]
                    .as_str()
                    .expect("availability reason")
                    .contains("version-gated")
                && operation["runtime_request"]["invokable"] == true
                && operation["runtime_request"]["mode"] == "adapter_operation"
                && operation["runtime_request"]["params"] == "adapter_normalized"
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "thread_shell_command"
                && operation["support"] == "version_gated"
                && operation["availability"] == "version_gated"
                && operation["runtime_gate"]["kind"] == "version_gated_provider_method"
                && operation["runtime_gate"]["provider_methods"] == json!(["thread/shellCommand"])
                && operation["runtime_gate_resolution"]["status"] == "unavailable"
                && operation["runtime_gate_resolution"]["missing_provider_methods"]
                    == json!(["thread/shellCommand"])
                && operation["availability_reason"]
                    .as_str()
                    .expect("availability reason")
                    .contains("version-gated")
                && operation["provider_methods"] == json!(["thread/shellCommand"])
                && operation["runtime_request"]["invokable"] == true
                && operation["runtime_request"]["mode"] == "adapter_operation"
                && operation["runtime_request"]["params"] == "adapter_normalized"
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "fs_read_file"
                && operation["invocation"] == "direct_provider_method"
                && operation["support"] == "required"
                && operation["availability"] == "available"
                && operation["provider_methods"] == json!(["fs/readFile"])
                && operation["runtime_request"]["invokable"] == true
                && operation["runtime_request"]["mode"] == "adapter_operation"
                && operation["runtime_request"]["params"] == "adapter_normalized"
        }));
        for (operation, method, category, support, availability) in [
            (
                "skills_config_write",
                "skills/config/write",
                "skills",
                "version_gated",
                "version_gated",
            ),
            (
                "skills_extra_roots_set",
                "skills/extraRoots/set",
                "skills",
                "optional",
                "optional",
            ),
            (
                "plugins_installed",
                "plugin/installed",
                "plugins",
                "optional",
                "optional",
            ),
            (
                "plugins_read",
                "plugin/read",
                "plugins",
                "optional",
                "optional",
            ),
            (
                "plugins_uninstall",
                "plugin/uninstall",
                "plugins",
                "optional",
                "optional",
            ),
            (
                "plugin_share_save",
                "plugin/share/save",
                "plugins",
                "optional",
                "optional",
            ),
            (
                "account_read",
                "account/read",
                "account",
                "optional",
                "optional",
            ),
            (
                "config_value_write",
                "config/value/write",
                "config",
                "optional",
                "optional",
            ),
            (
                "fuzzy_file_search",
                "fuzzyFileSearch",
                "search",
                "optional",
                "optional",
            ),
            (
                "marketplace_upgrade",
                "marketplace/upgrade",
                "plugins",
                "optional",
                "optional",
            ),
            ("model_list", "model/list", "models", "optional", "optional"),
            (
                "model_provider_capabilities_read",
                "modelProvider/capabilities/read",
                "models",
                "optional",
                "optional",
            ),
        ] {
            assert!(
                operations.iter().any(|entry| {
                    entry["operation"] == operation
                        && entry["category"] == category
                        && entry["support"] == support
                        && entry["availability"] == availability
                        && entry
                            .get("runtime_gate")
                            .is_some_and(|gate| gate["provider_methods"] == json!([method]))
                        && entry.get("runtime_gate_resolution").is_some_and(|gate| {
                            gate["source"] == "supported_client_request_methods"
                        })
                        && entry["invocation"] == "direct_provider_method"
                        && entry["provider_methods"] == json!([method])
                        && entry["runtime_request"]["invokable"] == true
                        && entry["runtime_request"]["mode"] == "adapter_operation"
                        && entry["runtime_request"]["params"] == "adapter_normalized"
                }),
                "missing provider runtime operation {operation}"
            );
        }
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "provider_events"
                && operation["invocation"] == "event_stream"
                && operation["availability"] == "available"
                && operation["direct_invocation"] == false
                && operation["required_runtime_hooks"] == json!(["event_source"])
                && operation["runtime_request"]["invokable"] == false
                && operation["runtime_request"]["mode"] == "event_stream"
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "semantic_tools"
                && operation["invocation"] == "event_stream"
                && operation["required_runtime_hooks"] == json!(["event_source"])
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "server_request_respond"
                && operation["required_runtime_hooks"] == json!(["server_request_responder"])
        }));
        assert!(operations.iter().any(|operation| {
            operation["operation"] == "cloud_handoff"
                && operation["invocation"] == "deferred"
                && operation["support"] == "deferred"
                && operation["availability"] == "deferred"
                && operation["availability_reason"]
                    .as_str()
                    .expect("availability reason")
                    .contains("deferred")
                && operation["required_runtime_hooks"]
                    .as_array()
                    .expect("runtime hooks")
                    .is_empty()
                && operation["runtime_request"]["invokable"] == false
                && operation["runtime_request"]["mode"] == "deferred"
        }));
    }

    #[tokio::test]
    async fn provider_runtime_validates_adapter_descriptors_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));

        let capabilities = ace_runtime::provider::ace_provider_contract_requirements()
            .into_iter()
            .map(|requirement| {
                json!({
                    "key": requirement.key,
                    "version": requirement.min_version
                })
            })
            .collect::<Vec<_>>();

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-adapter-validate",
                    "method": methods::PROVIDER_RUNTIME_ADAPTER_VALIDATE,
                    "payload": {
                        "descriptor": {
                            "kind": "ClaudeCode",
                            "capabilities": capabilities
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse =
            serde_json::from_str(&response).expect("validation response");
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected validation result");
        };

        assert_eq!(body["descriptor"]["kind"], "ClaudeCode");
        assert_eq!(body["contract"]["satisfies_required"], true);
        assert_eq!(body["contract"]["missing_required"], json!([]));
        assert_eq!(body["adapter_profile"]["provider"], "ClaudeCode");
        assert_eq!(
            body["adapter_profile"]["raw_payload"]["large_payload_strategy"],
            "store_once_reference_deltas"
        );
        assert!(
            body["adapter_profile"]["operations"]
                .as_array()
                .expect("operations")
                .iter()
                .any(
                    |operation| operation["operation"] == "server_request_respond"
                        && operation["required_runtime_hooks"]
                            == json!(["server_request_responder"])
                )
        );
    }

    #[tokio::test]
    async fn provider_runtime_validation_reports_missing_capabilities_over_ws_rpc() {
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
                    "request_id": "provider-adapter-validate-missing",
                    "method": methods::PROVIDER_RUNTIME_ADAPTER_VALIDATE,
                    "payload": {
                        "descriptor": {
                            "kind": "ClaudeCode",
                            "capabilities": [
                                { "key": "provider.adapter_contract", "version": 1 }
                            ]
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse =
            serde_json::from_str(&response).expect("validation response");
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected validation result");
        };

        assert_eq!(body["contract"]["satisfies_required"], false);
        assert!(
            body["contract"]["missing_required"]
                .as_array()
                .expect("missing required")
                .contains(&json!("provider.semantic_tools"))
        );
        assert_eq!(body["adapter_profile"]["contract_report"], body["contract"]);
    }

    #[tokio::test]
    async fn provider_runtime_lists_provider_features() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));

        let list = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-features",
                    "method": methods::PROVIDER_RUNTIME_FEATURES_LIST,
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let list: WsServerResponse = serde_json::from_str(&list).expect("features response");
        let WsServerPayload::Result { body } = list.payload else {
            panic!("expected provider feature list");
        };

        let providers = body["providers"].as_array().expect("providers");
        let codex = providers
            .iter()
            .find(|provider| provider["runtime_id"] == "codex")
            .expect("codex features");
        assert!(
            codex["features"]
                .as_array()
                .expect("codex feature list")
                .iter()
                .any(|feature| feature["provider_method"] == "remote/handoff"
                    && feature["support"] == "version_gated"
                    && feature["category"] == "handoff")
        );
        assert!(
            codex["features"]
                .as_array()
                .expect("codex feature list")
                .iter()
                .any(|feature| feature["provider_method"] == "cloud/handoff"
                    && feature["support"] == "deferred"
                    && feature["category"] == "cloud")
        );
        assert!(
            codex["features"]
                .as_array()
                .expect("codex feature list")
                .iter()
                .any(|feature| feature["key"] == "codex.execution_location.local"
                    && feature["support"] == "native"
                    && feature["category"] == "handoff")
        );
        assert!(
            codex["features"]
                .as_array()
                .expect("codex feature list")
                .iter()
                .any(
                    |feature| feature["key"] == "codex.execution_location.worktree"
                        && feature["support"] == "native"
                        && feature["provider_method"] == "codex.handoff.to_location"
                )
        );
        assert!(
            codex["features"]
                .as_array()
                .expect("codex feature list")
                .iter()
                .any(
                    |feature| feature["key"] == "codex.execution_location.remote_host"
                        && feature["support"] == "version_gated"
                        && feature["category"] == "remote"
                )
        );
        assert!(
            codex["features"]
                .as_array()
                .expect("codex feature list")
                .iter()
                .any(|feature| feature["key"] == "codex.execution_location.cloud"
                    && feature["support"] == "deferred"
                    && feature["category"] == "cloud")
        );

        let ace = providers
            .iter()
            .find(|provider| provider["runtime_id"] == "ace")
            .expect("ace features");
        assert!(
            ace["features"]
                .as_array()
                .expect("ace feature list")
                .iter()
                .any(|feature| feature["key"] == "provider.semantic_tools"
                    && feature["support"] == "native"
                    && feature["category"] == "tools")
        );

        let codex_only = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "codex-features",
                    "method": methods::PROVIDER_RUNTIME_FEATURES_LIST,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let codex_only: WsServerResponse =
            serde_json::from_str(&codex_only).expect("filtered features response");
        let WsServerPayload::Result { body } = codex_only.payload else {
            panic!("expected filtered provider feature list");
        };
        assert_eq!(body["providers"].as_array().expect("providers").len(), 1);
        assert_eq!(body["providers"][0]["runtime_id"], "codex");
    }

    #[tokio::test]
    async fn provider_runtime_lists_provider_statuses() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));

        let statuses = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-statuses",
                    "method": methods::PROVIDER_RUNTIME_STATUS_LIST,
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let statuses: WsServerResponse =
            serde_json::from_str(&statuses).expect("statuses response");
        let WsServerPayload::Result { body } = statuses.payload else {
            panic!("expected provider status list");
        };
        let providers = body["providers"].as_array().expect("providers");
        let codex = providers
            .iter()
            .find(|provider| provider["runtime_id"] == "codex")
            .expect("codex status");
        assert_eq!(codex["status"]["health"], "running");
        assert_eq!(codex["status"]["transport"], "fake_stdio");
        assert_eq!(codex["status"]["version"], "fake-codex-1");
        assert_eq!(codex["status"]["initialized"], true);
        assert_eq!(codex["supports_events"], true);
        assert_eq!(codex["supports_server_request_responses"], true);
        assert_eq!(codex["adapter_profile"]["provider"], "Codex");
        assert_eq!(
            codex["adapter_profile"]["contract_report"]["satisfies_required"],
            true
        );
        assert!(
            codex["adapter_profile"]["operations"]
                .as_array()
                .expect("codex adapter operations")
                .iter()
                .any(|operation| operation["operation"] == "provider_events"
                    && operation["invocation"] == "event_stream")
        );
        assert_eq!(codex["adapter_runtime"]["satisfies_required_hooks"], true);

        let ace = providers
            .iter()
            .find(|provider| provider["runtime_id"] == "ace")
            .expect("ace status");
        assert_eq!(ace["status"]["health"], "ready");
        assert_eq!(ace["status"]["transport"], "in_process");
        assert_eq!(ace["status"]["initialized"], true);
        assert_eq!(ace["supports_events"], true);
        assert_eq!(ace["supports_server_request_responses"], true);
        assert_eq!(ace["adapter_profile"]["provider"], "Ace");
        assert_eq!(
            ace["adapter_profile"]["contract_report"]["satisfies_required"],
            true
        );
        assert_eq!(ace["adapter_runtime"]["satisfies_required_hooks"], true);

        let ace_only = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "ace-status",
                    "method": methods::PROVIDER_RUNTIME_STATUS_LIST,
                    "payload": { "provider": "ace" }
                })
                .to_string(),
            )
            .await;
        let ace_only: WsServerResponse =
            serde_json::from_str(&ace_only).expect("filtered status response");
        let WsServerPayload::Result { body } = ace_only.payload else {
            panic!("expected filtered provider status list");
        };
        assert_eq!(body["providers"].as_array().expect("providers").len(), 1);
        assert_eq!(body["providers"][0]["runtime_id"], "ace");
    }

    #[tokio::test]
    async fn provider_runtime_returns_codex_runtime_state_snapshot() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));

        for (request_id, method, payload) in [
            (
                "state-turn",
                methods::CODEX_TURN_START,
                json!({
                    "thread_id": "thread-1",
                    "input": [{ "type": "text", "text": "work" }]
                }),
            ),
            (
                "state-goal",
                methods::CODEX_GOAL_SET,
                json!({
                    "thread_id": "thread-1",
                    "objective": "finish provider adapter",
                    "token_budget": 2048
                }),
            ),
            (
                "state-fork",
                methods::CODEX_THREAD_FORK,
                json!({
                    "thread_id": "thread-1",
                    "turn_id": "turn-1",
                    "ephemeral": false
                }),
            ),
            (
                "state-side-chat",
                methods::CODEX_SIDE_CHAT_START,
                json!({
                    "thread_id": "thread-1",
                    "turn_id": "turn-1"
                }),
            ),
            (
                "state-handoff",
                methods::CODEX_HANDOFF_TO_AGENT,
                json!({
                    "thread_id": "thread-1",
                    "prompt": "continue implementation",
                    "agent_role": "implementer",
                    "nickname": "builder",
                    "model": "gpt-5.5",
                    "reasoning_effort": "high",
                    "sandbox_policy": { "mode": "workspace-write" },
                    "approval_policy": { "mode": "on-request" },
                    "skills": [],
                    "mcp_config": {}
                }),
            ),
        ] {
            let response = state
                .dispatch_text(
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "request_id": request_id,
                        "method": method,
                        "payload": payload
                    })
                    .to_string(),
                )
                .await;
            let response: WsServerResponse = serde_json::from_str(&response).expect("response");
            assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        }

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-state",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };

        assert_eq!(body["providers"][0]["runtime_id"], "codex");
        assert_eq!(body["providers"][0]["source"], "live");
        assert_eq!(body["providers"][0]["persisted_replay_available"], true);
        assert!(
            body["providers"][0]["last_persisted_sequence"]
                .as_i64()
                .is_some_and(|sequence| sequence > 0)
        );
        let snapshot_state = &body["providers"][0]["state"];
        assert_eq!(snapshot_state["active_turns"][0]["thread_id"], "thread-1");
        assert_eq!(snapshot_state["active_turns"][0]["turn_id"], "turn-1");
        assert_eq!(
            snapshot_state["goals"][0]["objective"],
            "finish provider adapter"
        );
        assert_eq!(snapshot_state["goals"][0]["token_budget"], 2048);
        assert_eq!(
            snapshot_state["fork_points"][0]["parent_thread_id"],
            "thread-1"
        );
        assert_eq!(
            snapshot_state["fork_points"][0]["child_thread_id"],
            "fork-1"
        );
        assert_eq!(snapshot_state["fork_points"][0]["turn_id"], "turn-1");
        assert_eq!(
            snapshot_state["side_chats"][0]["parent_thread_id"],
            "thread-1"
        );
        assert_eq!(snapshot_state["side_chats"][0]["thread_id"], "fork-1");
        assert_eq!(
            snapshot_state["handoffs"][0]["source_thread_id"],
            "thread-1"
        );
        assert_eq!(snapshot_state["handoffs"][0]["target_location"], "local");
        assert_eq!(
            snapshot_state["handoffs"][0]["target_thread_id"],
            "agent-thread-1"
        );
        let child_threads = snapshot_state["child_threads"]
            .as_array()
            .expect("child threads");
        assert_eq!(child_threads.len(), 3);
        assert!(child_threads.iter().any(|child| {
            child["parent_thread_id"] == "thread-1"
                && child["thread_id"] == "fork-1"
                && child["relationship"] == "fork"
        }));
        assert!(child_threads.iter().any(|child| {
            child["parent_thread_id"] == "thread-1"
                && child["thread_id"] == "fork-1"
                && child["relationship"] == "side_chat"
                && child["ephemeral"] == true
        }));
        assert!(child_threads.iter().any(|child| {
            child["parent_thread_id"] == "thread-1"
                && child["thread_id"] == "agent-thread-1"
                && child["relationship"] == "handoff"
                && child["status"] == "completed"
                && child["execution_location"] == "local"
        }));

        let all_states = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-state-all",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let all_states: WsServerResponse = serde_json::from_str(&all_states).expect("all states");
        let WsServerPayload::Result { body } = all_states.payload else {
            panic!("expected all state result");
        };
        let providers = body["providers"].as_array().expect("providers");
        assert_eq!(providers.len(), 2);
        assert!(
            providers
                .iter()
                .any(|provider| provider["runtime_id"] == "codex"
                    && provider["source"] == "live"
                    && provider["persisted_replay_available"] == true
                    && provider["last_persisted_sequence"].as_i64().is_some())
        );
        assert!(providers.iter().any(|provider| {
            provider["runtime_id"] == "ace"
                && provider["source"] == "live"
                && provider["persisted_replay_available"] == false
                && provider["last_persisted_sequence"] == Value::Null
                && provider["state"]["provider_states"][0]["status"] == "ready"
                && provider["state"]["provider_states"][0]["metadata"]["pending_server_requests"]
                    == 0
        }));

        let ace_snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-state-ace",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "ace" }
                })
                .to_string(),
            )
            .await;
        let ace_snapshot: WsServerResponse =
            serde_json::from_str(&ace_snapshot).expect("ace snapshot");
        let WsServerPayload::Result { body } = ace_snapshot.payload else {
            panic!("expected ace state result");
        };
        assert_eq!(body["providers"][0]["runtime_id"], "ace");
        assert_eq!(body["providers"][0]["source"], "live");
        assert_eq!(body["providers"][0]["persisted_replay_available"], false);
        assert_eq!(body["providers"][0]["last_persisted_sequence"], Value::Null);
        assert_eq!(
            body["providers"][0]["state"]["provider_states"][0]["name"],
            "Ace native provider"
        );
    }

    #[tokio::test]
    async fn provider_runtime_returns_persisted_runtime_state_snapshot() {
        let runner = Arc::new(FakeRunner);
        let mut event_log =
            ProviderEventLogRepository::from_connection(Connection::open_in_memory().expect("db"))
                .expect("event log");
        let mut tool_provider = ProviderToolMetadata::new();
        tool_provider.provider = Some("codex".to_string());
        tool_provider.method = Some("command/exec".to_string());
        tool_provider.item_id = Some("tool-1".to_string());
        tool_provider.thread_id = Some("thread-1".to_string());
        tool_provider.turn_id = Some("turn-1".to_string());
        tool_provider.tool_name = Some("shell".to_string());
        tool_provider.operation = Some("exec".to_string());
        tool_provider.raw_args = json!({ "command": "cargo test" });
        let started_tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Shell,
            status: ToolRunStatus::Started,
            provider: tool_provider.clone(),
            item_type: Some("commandExecution".to_string()),
        });
        let completed_tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Shell,
            status: ToolRunStatus::Completed,
            provider: tool_provider.clone(),
            item_type: Some("commandExecution".to_string()),
        });
        tool_provider.operation = Some("process/outputDelta".to_string());
        tool_provider.raw_args = json!({ "processId": "proc-1", "delta": "running tests\n" });
        tool_provider.raw_payload = json!({
            "item": {
                "id": "tool-1",
                "processId": "proc-1",
                "delta": "running tests\n"
            }
        });
        let output_tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Process,
            status: ToolRunStatus::Updated,
            provider: tool_provider,
            item_type: Some("commandExecution".to_string()),
        });
        event_log
            .append_batch(
                "codex",
                &[
                    ProviderEvent::ThreadItem {
                        item: Box::new(NormalizedThreadItem {
                            kind: ThreadItemKind::AgentMessage,
                            status: ThreadItemStatus::Updated,
                            thread_id: Some("thread-1".to_string()),
                            turn_id: Some("turn-1".to_string()),
                            item_id: Some("item-1".to_string()),
                            parent_thread_id: None,
                            child_thread_id: None,
                            sender: None,
                            role: None,
                            title: None,
                            text: Some("draft".to_string()),
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
                            metadata: json!({}),
                            provider: ProviderMetadata {
                                provider: "codex".to_string(),
                                method: Some("item/agentMessage/delta".to_string()),
                                schema_version: Some("test-v1".to_string()),
                                raw_payload: json!({
                                    "itemId": "item-1",
                                    "text": "draft"
                                }),
                            },
                        }),
                    },
                    ProviderEvent::ThreadItem {
                        item: Box::new(NormalizedThreadItem {
                            kind: ThreadItemKind::AgentMessage,
                            status: ThreadItemStatus::Completed,
                            thread_id: Some("thread-1".to_string()),
                            turn_id: Some("turn-1".to_string()),
                            item_id: Some("item-1".to_string()),
                            parent_thread_id: None,
                            child_thread_id: None,
                            sender: None,
                            role: None,
                            title: None,
                            text: Some("final".to_string()),
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
                            metadata: json!({}),
                            provider: ProviderMetadata {
                                provider: "codex".to_string(),
                                method: Some("item/completed".to_string()),
                                schema_version: Some("test-v1".to_string()),
                                raw_payload: json!({
                                    "itemId": "item-1",
                                    "text": "final"
                                }),
                            },
                        }),
                    },
                    ProviderEvent::ThreadItem {
                        item: Box::new(NormalizedThreadItem {
                            kind: ThreadItemKind::Plan,
                            status: ThreadItemStatus::Updated,
                            thread_id: Some("thread-1".to_string()),
                            turn_id: Some("turn-1".to_string()),
                            item_id: Some("plan-1".to_string()),
                            parent_thread_id: None,
                            child_thread_id: None,
                            sender: None,
                            role: None,
                            title: None,
                            text: Some("Plan text".to_string()),
                            status_text: None,
                            model: None,
                            target: None,
                            url: None,
                            files: None,
                            attachments: None,
                            diff: None,
                            token_usage: None,
                            plan_questions: Some(json!([{ "id": "repo" }])),
                            plan_completion: Some("complete".to_string()),
                            metadata: json!({}),
                            provider: ProviderMetadata {
                                provider: "codex".to_string(),
                                method: Some("item/plan/delta".to_string()),
                                schema_version: Some("test-v1".to_string()),
                                raw_payload: json!({ "itemId": "plan-1" }),
                            },
                        }),
                    },
                    ProviderEvent::SemanticTool {
                        tool: Box::new(started_tool),
                    },
                    ProviderEvent::SemanticTool {
                        tool: Box::new(output_tool),
                    },
                    ProviderEvent::RuntimeSignal {
                        signal: Box::new(NormalizedRuntimeSignal {
                            kind: RuntimeSignalKind::RealtimeTranscriptDelta,
                            thread_id: Some("thread-1".to_string()),
                            turn_id: Some("turn-1".to_string()),
                            item_id: None,
                            message: None,
                            from_model: None,
                            to_model: None,
                            reason: None,
                            text: Some("hello ".to_string()),
                            audio: None,
                            status: None,
                            name: None,
                            active: None,
                            archived: None,
                            diff: None,
                            files: None,
                            process_id: None,
                            exit_code: None,
                            request_id: None,
                            metadata: json!({ "delta": "hello " }),
                            provider: ProviderMetadata {
                                provider: "codex".to_string(),
                                method: Some("realtime/transcriptDelta".to_string()),
                                schema_version: None,
                                raw_payload: json!({ "delta": "hello " }),
                            },
                        }),
                    },
                    ProviderEvent::RuntimeSignal {
                        signal: Box::new(NormalizedRuntimeSignal {
                            kind: RuntimeSignalKind::RealtimeTranscriptDelta,
                            thread_id: Some("thread-1".to_string()),
                            turn_id: Some("turn-1".to_string()),
                            item_id: None,
                            message: None,
                            from_model: None,
                            to_model: None,
                            reason: None,
                            text: Some("world".to_string()),
                            audio: None,
                            status: None,
                            name: None,
                            active: None,
                            archived: None,
                            diff: None,
                            files: None,
                            process_id: None,
                            exit_code: None,
                            request_id: None,
                            metadata: json!({ "delta": "world" }),
                            provider: ProviderMetadata {
                                provider: "codex".to_string(),
                                method: Some("realtime/transcriptDelta".to_string()),
                                schema_version: None,
                                raw_payload: json!({ "delta": "world" }),
                            },
                        }),
                    },
                    ProviderEvent::RuntimeSignal {
                        signal: Box::new(NormalizedRuntimeSignal {
                            kind: RuntimeSignalKind::RealtimeAudioDelta,
                            thread_id: Some("thread-1".to_string()),
                            turn_id: Some("turn-1".to_string()),
                            item_id: None,
                            message: None,
                            from_model: None,
                            to_model: None,
                            reason: None,
                            text: None,
                            audio: Some("audio-1".to_string()),
                            status: None,
                            name: None,
                            active: None,
                            archived: None,
                            diff: None,
                            files: None,
                            process_id: None,
                            exit_code: None,
                            request_id: None,
                            metadata: json!({ "audio": "audio-1" }),
                            provider: ProviderMetadata {
                                provider: "codex".to_string(),
                                method: Some("realtime/audioDelta".to_string()),
                                schema_version: None,
                                raw_payload: json!({ "audio": "audio-1" }),
                            },
                        }),
                    },
                    ProviderEvent::SemanticTool {
                        tool: Box::new(completed_tool),
                    },
                    ProviderEvent::ServerRequest {
                        request: Box::new(normalized_approval_request("approval-1")),
                    },
                    ProviderEvent::ServerRequestResolved {
                        request_id: "approval-1".to_string(),
                        decision: NormalizedServerRequestDecision {
                            outcome: "result".to_string(),
                            payload: json!({ "approved": true }),
                            audit: json!({
                                "source_thread_id": "thread-1",
                                "selected_policy": "on-request"
                            }),
                        },
                        request: Some(Box::new(normalized_approval_request("approval-1"))),
                    },
                ],
            )
            .expect("append events");
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_provider_event_log(event_log);

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "provider-state-persisted",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": {
                        "provider": "codex",
                        "source": "persisted"
                    }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse =
            serde_json::from_str(&snapshot).expect("persisted snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected persisted state result");
        };

        assert_eq!(body["providers"][0]["runtime_id"], "codex");
        assert_eq!(body["providers"][0]["source"], "persisted");
        assert_eq!(body["providers"][0]["persisted_replay_available"], true);
        assert!(
            body["providers"][0]["last_persisted_sequence"]
                .as_i64()
                .is_some_and(|sequence| sequence > 0)
        );
        let snapshot_state = &body["providers"][0]["state"];
        assert_eq!(snapshot_state["thread_items"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot_state["thread_items"][0]["item_id"], "item-1");
        assert_eq!(snapshot_state["thread_items"][0]["text"], "final");
        assert_eq!(
            snapshot_state["thread_items"][0]["provider"]["raw_payload"]["text"],
            "final"
        );
        assert_eq!(snapshot_state["plan_sessions"][0]["item_id"], "plan-1");
        assert_eq!(
            snapshot_state["plan_sessions"][0]["questions"][0]["id"],
            "repo"
        );
        assert_eq!(snapshot_state["approvals"][0]["request_id"], "approval-1");
        assert_eq!(snapshot_state["approvals"][0]["status"], "resolved");
        assert_eq!(
            snapshot_state["approvals"][0]["decision"]["payload"]["approved"],
            true
        );
        assert_eq!(
            snapshot_state["approvals"][0]["decision"]["audit"]["selected_policy"],
            "on-request"
        );
        assert_eq!(
            snapshot_state["tool_timeline"][0]["provider"]["item_id"],
            "tool-1"
        );
        assert_eq!(
            snapshot_state["tool_timeline"][0]["display"]["status"],
            "completed"
        );
        assert_eq!(
            snapshot_state["tool_timeline"][0]["provider"]["raw_args"]["command"],
            "cargo test"
        );
        assert_eq!(snapshot_state["terminal_outputs"][0]["item_id"], "tool-1");
        assert_eq!(
            snapshot_state["terminal_outputs"][0]["process_id"],
            "proc-1"
        );
        assert_eq!(
            snapshot_state["terminal_outputs"][0]["text"],
            "running tests\n"
        );
        assert_eq!(
            snapshot_state["realtime_transcripts"][0]["text"],
            "hello world"
        );
        assert_eq!(snapshot_state["realtime_audio"][0]["chunks"][0], "audio-1");
    }

    #[tokio::test]
    async fn provider_runtime_runs_lifecycle_actions() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let start = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "codex-start",
                    "method": methods::PROVIDER_RUNTIME_LIFECYCLE,
                    "payload": {
                        "provider": "codex",
                        "action": "start",
                        "grace_ms": 25
                    }
                })
                .to_string(),
            )
            .await;
        let start: WsServerResponse = serde_json::from_str(&start).expect("start response");
        let WsServerPayload::Result { body } = start.payload else {
            panic!("expected lifecycle result");
        };
        assert_eq!(body["runtime_id"], "codex");
        assert_eq!(body["result"]["action"], "start");
        assert_eq!(body["result"]["status"]["health"], "running");
        assert_eq!(*backend.starts.lock().expect("starts"), 1);

        let restart = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "codex-restart",
                    "method": methods::PROVIDER_RUNTIME_LIFECYCLE,
                    "payload": {
                        "provider": "Codex",
                        "action": "restart",
                        "grace_ms": 50
                    }
                })
                .to_string(),
            )
            .await;
        let restart: WsServerResponse = serde_json::from_str(&restart).expect("restart response");
        assert!(matches!(restart.payload, WsServerPayload::Result { .. }));
        assert_eq!(
            backend.restarts.lock().expect("restarts").as_slice(),
            [Duration::from_millis(50)]
        );

        let ace = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "ace-shutdown",
                    "method": methods::PROVIDER_RUNTIME_LIFECYCLE,
                    "payload": {
                        "provider": "ace",
                        "action": "shutdown"
                    }
                })
                .to_string(),
            )
            .await;
        let ace: WsServerResponse = serde_json::from_str(&ace).expect("ace lifecycle response");
        let WsServerPayload::Result { body } = ace.payload else {
            panic!("expected ace lifecycle result");
        };
        assert_eq!(body["runtime_id"], "ace");
        assert_eq!(body["result"]["action"], "shutdown");
        assert_eq!(body["result"]["status"]["health"], "ready");
        assert_eq!(body["result"]["metadata"]["no_op"], true);
    }

    #[tokio::test]
    async fn dispatches_codex_version_gated_tool_surfaces_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let calls = [
            (
                methods::CODEX_REVIEW_START,
                json!({ "thread_id": "thread-1", "detached": true }),
            ),
            (
                methods::CODEX_THREAD_SHELL_COMMAND,
                json!({
                    "userInitiated": true,
                    "thread_id": "thread-1",
                    "command": "pwd"
                }),
            ),
            (
                methods::CODEX_COMMAND_EXEC,
                json!({
                    "userInitiated": true,
                    "command": "cargo test",
                    "thread_id": "thread-1",
                    "cwd": "/tmp"
                }),
            ),
            (
                methods::CODEX_COMMAND_WRITE_STDIN,
                json!({ "userInitiated": true, "process_id": "p1", "stdin": "q" }),
            ),
            (
                methods::CODEX_PROCESS_LIST,
                json!({ "userInitiated": true, "params": { "threadId": "thread-1" } }),
            ),
            (
                methods::CODEX_FS_READ_FILE,
                json!({ "path": "src/lib.rs", "encoding": "utf8" }),
            ),
            (
                methods::CODEX_FS_WRITE_FILE,
                json!({ "path": "src/lib.rs", "contents": "pub fn main() {}" }),
            ),
            (
                methods::CODEX_FS_READ_DIRECTORY,
                json!({ "path": "src", "recursive": true }),
            ),
            (
                methods::CODEX_FS_CREATE_DIRECTORY,
                json!({ "path": "src/generated" }),
            ),
            (
                methods::CODEX_FS_COPY,
                json!({ "from_path": "src/lib.rs", "to_path": "src/lib.copy.rs" }),
            ),
            (
                methods::CODEX_FS_REMOVE,
                json!({ "path": "src/lib.copy.rs" }),
            ),
            (methods::CODEX_FS_METADATA, json!({ "path": "src/lib.rs" })),
            (methods::CODEX_FS_WATCH, json!({ "path": "src" })),
            (methods::CODEX_FS_UNWATCH, json!({ "path": "src" })),
            (
                methods::CODEX_MCP_TOOL_CALL,
                json!({
                    "server": "github",
                    "tool": "list_issues",
                    "arguments": { "state": "open" }
                }),
            ),
            (methods::CODEX_SKILLS_INSTALL, json!({ "skill": "rust" })),
            (
                methods::CODEX_SKILLS_CONFIG_WRITE,
                json!({ "config": { "enabled": ["rust"] } }),
            ),
            (
                methods::CODEX_SKILLS_EXTRA_ROOTS_SET,
                json!({ "roots": ["/tmp/skills"] }),
            ),
            (methods::CODEX_PLUGINS_INSTALLED, json!({})),
            (methods::CODEX_PLUGINS_READ, json!({ "plugin": "browser" })),
            (
                methods::CODEX_PLUGINS_UNINSTALL,
                json!({ "plugin": "browser" }),
            ),
            (
                methods::CODEX_PLUGIN_SHARE_CHECKOUT,
                json!({ "shareId": "share-1" }),
            ),
            (
                methods::CODEX_PLUGIN_SHARE_DELETE,
                json!({ "shareId": "share-1" }),
            ),
            (methods::CODEX_PLUGIN_SHARE_LIST, json!({})),
            (
                methods::CODEX_PLUGIN_SHARE_SAVE,
                json!({ "plugin": "browser", "targets": ["team"] }),
            ),
            (
                methods::CODEX_PLUGIN_SHARE_UPDATE_TARGETS,
                json!({ "shareId": "share-1", "targets": ["team"] }),
            ),
            (
                methods::CODEX_APPS_CONFIG_WRITE,
                json!({ "app": "browser", "config": { "enabled": true } }),
            ),
            (methods::CODEX_REMOTE_CONNECTION_LIST, json!({})),
            (
                methods::CODEX_REMOTE_HANDOFF,
                json!({
                    "thread_id": "thread-1",
                    "host": "devbox",
                    "target_path": "/srv/ace",
                    "branch": "feature/remote"
                }),
            ),
            (
                methods::CODEX_ACCOUNT_LOGIN_START,
                json!({ "provider": "chatgpt" }),
            ),
            (
                methods::CODEX_ACCOUNT_LOGIN_CANCEL,
                json!({ "flowId": "flow-1" }),
            ),
            (
                methods::CODEX_ACCOUNT_LOGOUT,
                json!({ "accountId": "acct-1" }),
            ),
            (methods::CODEX_ACCOUNT_READ, json!({})),
            (
                methods::CODEX_ACCOUNT_RATE_LIMIT_RESET_CREDIT_CONSUME,
                json!({ "accountId": "acct-1", "source": "rate-limit-banner" }),
            ),
            (
                methods::CODEX_ACCOUNT_RATE_LIMITS_READ,
                json!({ "accountId": "acct-1" }),
            ),
            (
                methods::CODEX_ACCOUNT_USAGE_READ,
                json!({ "accountId": "acct-1" }),
            ),
            (
                methods::CODEX_ACCOUNT_SEND_ADD_CREDITS_NUDGE_EMAIL,
                json!({ "accountId": "acct-1" }),
            ),
            (methods::CODEX_WINDOWS_SANDBOX_READINESS, json!({})),
            (
                methods::CODEX_WINDOWS_SANDBOX_SETUP_START,
                json!({ "mode": "default" }),
            ),
            (methods::CODEX_CONFIG_READ, json!({})),
            (
                methods::CODEX_CONFIG_VALUE_WRITE,
                json!({ "key": "model", "value": "gpt-5" }),
            ),
            (
                methods::CODEX_CONFIG_BATCH_WRITE,
                json!({ "values": { "model": "gpt-5" } }),
            ),
            (
                methods::CODEX_CONFIG_MCP_SERVER_RELOAD,
                json!({ "server": "github" }),
            ),
            (methods::CODEX_EXPERIMENTAL_FEATURE_LIST, json!({})),
            (
                methods::CODEX_EXPERIMENTAL_FEATURE_ENABLEMENT_SET,
                json!({ "feature": "plan_mode", "enabled": true }),
            ),
            (
                methods::CODEX_EXTERNAL_AGENT_CONFIG_DETECT,
                json!({ "cwd": "/tmp/repo" }),
            ),
            (
                methods::CODEX_EXTERNAL_AGENT_CONFIG_IMPORT,
                json!({ "agent": "codex" }),
            ),
            (methods::CODEX_FEEDBACK_UPLOAD, json!({ "kind": "bug" })),
            (methods::CODEX_FUZZY_FILE_SEARCH, json!({ "query": "main" })),
            (methods::CODEX_HOOKS_LIST, json!({})),
            (
                methods::CODEX_MARKETPLACE_ADD,
                json!({ "plugin": "browser" }),
            ),
            (
                methods::CODEX_MARKETPLACE_REMOVE,
                json!({ "plugin": "browser" }),
            ),
            (
                methods::CODEX_MARKETPLACE_UPGRADE,
                json!({ "plugin": "browser" }),
            ),
            (methods::CODEX_MODEL_LIST, json!({ "provider": "openai" })),
            (
                methods::CODEX_MODEL_PROVIDER_CAPABILITIES_READ,
                json!({ "provider": "openai" }),
            ),
        ];

        for (index, (method, payload)) in calls.iter().enumerate() {
            let response = state
                .dispatch_text(
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "request_id": format!("versioned-{index}"),
                        "method": method,
                        "payload": payload
                    })
                    .to_string(),
                )
                .await;
            let response: WsServerResponse = serde_json::from_str(&response).expect("response");
            assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        }

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
                "review/start",
                "thread/shellCommand",
                "command/exec",
                "command/exec/write",
                "process/list",
                "fs/readFile",
                "fs/writeFile",
                "fs/readDirectory",
                "fs/createDirectory",
                "fs/copy",
                "fs/remove",
                "fs/getMetadata",
                "fs/watch",
                "fs/unwatch",
                "mcpServer/tool/call",
                "skills/install",
                "skills/config/write",
                "skills/extraRoots/set",
                "plugin/installed",
                "plugin/read",
                "plugin/uninstall",
                "plugin/share/checkout",
                "plugin/share/delete",
                "plugin/share/list",
                "plugin/share/save",
                "plugin/share/updateTargets",
                "apps/configWrite",
                "remote/connectionList",
                "remote/handoff",
                "account/login/start",
                "account/login/cancel",
                "account/logout",
                "account/read",
                "account/rateLimitResetCredit/consume",
                "account/rateLimits/read",
                "account/usage/read",
                "account/sendAddCreditsNudgeEmail",
                "windowsSandbox/readiness",
                "windowsSandbox/setupStart",
                "config/read",
                "config/value/write",
                "config/batchWrite",
                "config/mcpServer/reload",
                "experimentalFeature/list",
                "experimentalFeature/enablement/set",
                "externalAgentConfig/detect",
                "externalAgentConfig/import",
                "feedback/upload",
                "fuzzyFileSearch",
                "hooks/list",
                "marketplace/add",
                "marketplace/remove",
                "marketplace/upgrade",
                "model/list",
                "modelProvider/capabilities/read",
            ]
        );

        let snapshot = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "review-snapshot",
                    "method": methods::PROVIDER_RUNTIME_STATE_GET,
                    "payload": { "provider": "codex" }
                })
                .to_string(),
            )
            .await;
        let snapshot: WsServerResponse = serde_json::from_str(&snapshot).expect("snapshot");
        let WsServerPayload::Result { body } = snapshot.payload else {
            panic!("expected snapshot result");
        };
        let review_threads = body["providers"][0]["state"]["review_threads"]
            .as_array()
            .expect("review threads");
        assert_eq!(review_threads, &[json!("thread-1")]);
        assert_eq!(
            body["providers"][0]["state"]["remote_connections"][0]["host_id"],
            "devbox"
        );
        assert_eq!(
            body["providers"][0]["state"]["remote_connections"][0]["projects"][0]["path"],
            "/srv/ace"
        );
        assert_eq!(
            body["providers"][0]["state"]["handoffs"][0]["target_location"],
            "remote_host"
        );
        assert_eq!(
            body["providers"][0]["state"]["handoffs"][0]["remote_host"],
            "devbox"
        );
        assert_eq!(
            body["providers"][0]["state"]["handoffs"][0]["branch"],
            "feature/remote"
        );

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "review-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 128 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        let review_record = records
            .iter()
            .find(|record| record["event"]["signal"]["kind"] == "review_mode_updated")
            .expect("review mode event");
        assert_eq!(review_record["event"]["signal"]["status"], "entered");
        assert_eq!(review_record["event"]["signal"]["active"], true);
        assert_eq!(
            review_record["event"]["signal"]["metadata"]["request"]["detached"],
            true
        );
        assert_eq!(
            review_record["projection_deltas"][0]["type"],
            "review_mode_changed"
        );
        assert_eq!(
            review_record["projection_deltas"][0]["thread_id"],
            "thread-1"
        );
        assert_eq!(review_record["projection_deltas"][0]["active"], true);

        let invalid = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "versioned-invalid",
                    "method": methods::CODEX_MCP_RESOURCE_READ,
                    "payload": { "server": "docs" }
                })
                .to_string(),
            )
            .await;
        let invalid: WsServerResponse = serde_json::from_str(&invalid).expect("invalid response");
        assert!(matches!(invalid.payload, WsServerPayload::Error { .. }));
    }

    #[tokio::test]
    async fn version_gated_codex_tool_requests_emit_semantic_provider_events() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend));

        for (request_id, method, payload) in [
            (
                "codex-fs-read",
                methods::CODEX_FS_READ_FILE,
                json!({ "path": "src/lib.rs", "encoding": "utf8" }),
            ),
            (
                "codex-mcp-call",
                methods::CODEX_MCP_TOOL_CALL,
                json!({
                    "server": "linear",
                    "tool": "list_projects",
                    "arguments": { "team": "eng" }
                }),
            ),
            (
                "codex-skill-install",
                methods::CODEX_SKILLS_INSTALL,
                json!({ "skill": "rust" }),
            ),
            (
                "codex-plugin-read",
                methods::CODEX_PLUGINS_READ,
                json!({ "plugin": "browser" }),
            ),
            (
                "codex-app-config",
                methods::CODEX_APPS_CONFIG_WRITE,
                json!({ "app": "browser", "config": { "enabled": true } }),
            ),
        ] {
            let response = state
                .dispatch_text(
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "request_id": request_id,
                        "method": method,
                        "payload": payload
                    })
                    .to_string(),
                )
                .await;
            let response: WsServerResponse = serde_json::from_str(&response).expect("response");
            assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        }

        let recent = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "semantic-tool-events",
                    "method": methods::PROVIDER_RUNTIME_EVENTS_RECENT,
                    "payload": { "provider": "codex", "limit": 16 }
                })
                .to_string(),
            )
            .await;
        let recent: WsServerResponse = serde_json::from_str(&recent).expect("recent events");
        let WsServerPayload::Result { body } = recent.payload else {
            panic!("expected recent events result");
        };
        let records = body["records"].as_array().expect("records");
        assert_eq!(records.len(), 10);

        let file_completed = records
            .iter()
            .find(|record| {
                record["event"]["tool"]["display"]["status"] == "completed"
                    && record["event"]["tool"]["surface"] == "filesystem"
            })
            .expect("completed filesystem event");
        assert_eq!(file_completed["event"]["type"], "tool_completed");
        assert_eq!(file_completed["event"]["tool"]["action"], "file.read");
        assert_eq!(
            file_completed["event"]["tool"]["display"]["title"],
            "Read src/lib.rs"
        );
        assert_eq!(
            file_completed["event"]["tool"]["provider"]["raw_payload"]["provider_method"],
            "fs/readFile"
        );

        let mcp_started = records
            .iter()
            .find(|record| {
                record["event"]["tool"]["display"]["status"] == "started"
                    && record["event"]["tool"]["surface"] == "generic_mcp"
            })
            .expect("started mcp event");
        assert_eq!(mcp_started["event"]["tool"]["action"], "tool.run");
        assert_eq!(
            mcp_started["event"]["tool"]["display"]["title"],
            "Running linear.list_projects tool"
        );
        assert_ne!(mcp_started["event"]["tool"]["display"]["title"], "MCP tool");
        assert_eq!(
            mcp_started["event"]["tool"]["provider"]["server_name"],
            "linear"
        );
        assert_eq!(
            mcp_started["event"]["tool"]["provider"]["raw_args"]["arguments"]["team"],
            "eng"
        );

        let skill_completed = records
            .iter()
            .find(|record| {
                record["event"]["tool"]["display"]["status"] == "completed"
                    && record["event"]["tool"]["surface"] == "skill"
            })
            .expect("completed skill event");
        assert_eq!(skill_completed["event"]["tool"]["action"], "skill.install");
        assert_eq!(
            skill_completed["event"]["tool"]["display"]["title"],
            "Installed skill rust"
        );
        assert_eq!(
            skill_completed["event"]["tool"]["provider"]["raw_payload"]["provider_method"],
            "skills/install"
        );

        let plugin_completed = records
            .iter()
            .find(|record| {
                record["event"]["tool"]["display"]["status"] == "completed"
                    && record["event"]["tool"]["surface"] == "plugin"
            })
            .expect("completed plugin event");
        assert_eq!(plugin_completed["event"]["tool"]["action"], "plugin.read");
        assert_eq!(
            plugin_completed["event"]["tool"]["display"]["title"],
            "Read plugin browser"
        );

        let app_completed = records
            .iter()
            .find(|record| {
                record["event"]["tool"]["display"]["status"] == "completed"
                    && record["event"]["tool"]["surface"] == "app"
            })
            .expect("completed app event");
        assert_eq!(app_completed["event"]["tool"]["action"], "app.configure");
        assert_eq!(
            app_completed["event"]["tool"]["display"]["title"],
            "Configured app browser"
        );
    }

    #[test]
    fn codex_shell_methods_require_explicit_user_initiation_and_strip_marker() {
        let missing_marker = codex_versioned_app_server_request(
            methods::CODEX_COMMAND_EXEC,
            &json!({ "command": "cargo test" }),
        )
        .expect_err("missing user initiation");
        assert!(matches!(
            missing_marker,
            WsDispatchError::BadRequest(ref message)
                if message.contains("userInitiated: true")
        ));

        let missing_thread_shell_marker = codex_versioned_app_server_request(
            methods::CODEX_THREAD_SHELL_COMMAND,
            &json!({ "threadId": "thread-1", "command": "pwd" }),
        )
        .expect_err("missing thread shell user initiation");
        assert!(matches!(
            missing_thread_shell_marker,
            WsDispatchError::BadRequest(ref message)
                if message.contains("userInitiated: true")
        ));

        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_THREAD_SHELL_COMMAND,
            &json!({
                "params": {
                    "userInitiated": true,
                    "threadId": "thread-1",
                    "command": "pwd"
                }
            }),
        )
        .expect("user initiated thread shell")
        .expect("thread shell method");
        assert_eq!(method, "thread/shellCommand");
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["command"], "pwd");
        assert!(params.get("userInitiated").is_none());

        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_COMMAND_EXEC,
            &json!({
                "userInitiated": true,
                "command": "cargo test",
                "thread_id": "thread-1"
            }),
        )
        .expect("user initiated command")
        .expect("command method");
        assert_eq!(method, "command/exec");
        assert_eq!(params["command"], "cargo test");
        assert_eq!(params["threadId"], "thread-1");
        assert!(params.get("userInitiated").is_none());
        assert!(params.get("user_initiated").is_none());

        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_COMMAND_RESIZE,
            &json!({
                "params": {
                    "user_initiated": true,
                    "processId": "p1",
                    "cols": 120,
                    "rows": 40
                }
            }),
        )
        .expect("user initiated enveloped resize")
        .expect("resize method");
        assert_eq!(method, "command/exec/resize");
        assert_eq!(params["processId"], "p1");
        assert_eq!(params["cols"], 120);
        assert_eq!(params["rows"], 40);
        assert!(params.get("userInitiated").is_none());
        assert!(params.get("user_initiated").is_none());

        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_PROCESS_CLEAN,
            &json!({ "userInitiated": true, "params": { "threadId": "thread-1" } }),
        )
        .expect("user initiated process clean")
        .expect("process clean method");
        assert_eq!(method, "process/clean");
        assert_eq!(params["threadId"], "thread-1");
        assert!(params.get("userInitiated").is_none());

        let missing_raw_marker =
            user_initiated_codex_params("command/exec", json!({ "command": "cargo test" }))
                .expect_err("missing raw user initiation");
        assert!(matches!(
            missing_raw_marker,
            WsDispatchError::BadRequest(ref message)
                if message.contains("userInitiated: true")
        ));

        let raw_params = user_initiated_codex_params(
            "command/exec",
            json!({ "userInitiated": true, "command": "cargo test" }),
        )
        .expect("raw user initiated command");
        assert_eq!(raw_params["command"], "cargo test");
        assert!(raw_params.get("userInitiated").is_none());

        let normal_params =
            user_initiated_codex_params("thread/read", json!({ "threadId": "thread-1" }))
                .expect("non-shell request does not require marker");
        assert_eq!(normal_params["threadId"], "thread-1");
    }

    #[test]
    fn codex_raw_plugin_share_methods_preserve_payload_shape() {
        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_PLUGIN_SHARE_SAVE,
            &json!({ "plugin": "browser", "targets": ["team"] }),
        )
        .expect("raw share request")
        .expect("share method");
        assert_eq!(method, "plugin/share/save");
        assert_eq!(params["plugin"], "browser");
        assert_eq!(params["targets"][0], "team");

        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_PLUGIN_SHARE_UPDATE_TARGETS,
            &json!({ "params": { "shareId": "share-1", "targets": ["team"] } }),
        )
        .expect("enveloped raw share request")
        .expect("share update method");
        assert_eq!(method, "plugin/share/updateTargets");
        assert_eq!(params["shareId"], "share-1");
        assert_eq!(params["targets"][0], "team");
    }

    #[test]
    fn codex_raw_account_and_windows_methods_preserve_payload_shape() {
        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_ACCOUNT_LOGIN_START,
            &json!({ "provider": "chatgpt", "scopes": ["openid"] }),
        )
        .expect("account login start")
        .expect("account method");
        assert_eq!(method, "account/login/start");
        assert_eq!(params["provider"], "chatgpt");
        assert_eq!(params["scopes"][0], "openid");

        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_ACCOUNT_RATE_LIMIT_RESET_CREDIT_CONSUME,
            &json!({ "params": { "accountId": "acct-1", "source": "banner" } }),
        )
        .expect("rate-limit reset credit consume")
        .expect("account method");
        assert_eq!(method, "account/rateLimitResetCredit/consume");
        assert_eq!(params["accountId"], "acct-1");
        assert_eq!(params["source"], "banner");

        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_WINDOWS_SANDBOX_SETUP_START,
            &json!({ "params": { "mode": "default", "force": true } }),
        )
        .expect("windows setup")
        .expect("windows method");
        assert_eq!(method, "windowsSandbox/setupStart");
        assert_eq!(params["mode"], "default");
        assert_eq!(params["force"], true);
    }

    #[test]
    fn codex_raw_config_marketplace_and_search_methods_preserve_payload_shape() {
        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_CONFIG_VALUE_WRITE,
            &json!({ "key": "model", "value": "gpt-5" }),
        )
        .expect("config value write")
        .expect("config method");
        assert_eq!(method, "config/value/write");
        assert_eq!(params["key"], "model");
        assert_eq!(params["value"], "gpt-5");

        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_EXPERIMENTAL_FEATURE_ENABLEMENT_SET,
            &json!({ "params": { "feature": "plan_mode", "enabled": true } }),
        )
        .expect("feature enablement")
        .expect("feature method");
        assert_eq!(method, "experimentalFeature/enablement/set");
        assert_eq!(params["feature"], "plan_mode");
        assert_eq!(params["enabled"], true);

        let (method, params) = codex_versioned_app_server_request(
            methods::CODEX_FUZZY_FILE_SEARCH,
            &json!({ "query": "main" }),
        )
        .expect("fuzzy file search")
        .expect("search method");
        assert_eq!(method, "fuzzyFileSearch");
        assert_eq!(params["query"], "main");
    }

    #[tokio::test]
    async fn codex_raw_request_rejects_deferred_and_non_client_methods() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let allowed = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "raw-version-gated",
                    "method": methods::CODEX_RAW_REQUEST,
                    "payload": {
                        "method": "remote/connectionList",
                        "params": {}
                    }
                })
                .to_string(),
            )
            .await;
        let allowed: WsServerResponse = serde_json::from_str(&allowed).expect("allowed raw");
        assert!(matches!(allowed.payload, WsServerPayload::Result { .. }));

        let command_without_marker = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "raw-command-missing-marker",
                    "method": methods::CODEX_RAW_REQUEST,
                    "payload": {
                        "method": "command/exec",
                        "params": { "command": "cargo test" }
                    }
                })
                .to_string(),
            )
            .await;
        let command_without_marker: WsServerResponse =
            serde_json::from_str(&command_without_marker).expect("raw command missing marker");
        let WsServerPayload::Error { code, message } = command_without_marker.payload else {
            panic!("expected raw command marker error");
        };
        assert_eq!(code, "bad_request");
        assert!(message.contains("userInitiated: true"));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["remote/connectionList"]
        );

        let command_with_marker = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "raw-command-with-marker",
                    "method": methods::CODEX_RAW_REQUEST,
                    "payload": {
                        "method": "command/exec",
                        "params": {
                            "userInitiated": true,
                            "command": "cargo test"
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let command_with_marker: WsServerResponse =
            serde_json::from_str(&command_with_marker).expect("raw command with marker");
        assert!(matches!(
            command_with_marker.payload,
            WsServerPayload::Result { .. }
        ));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["remote/connectionList", "command/exec"]
        );

        let deferred = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "raw-deferred",
                    "method": methods::CODEX_RAW_REQUEST,
                    "payload": {
                        "method": "cloud/handoff",
                        "params": {}
                    }
                })
                .to_string(),
            )
            .await;
        let deferred: WsServerResponse = serde_json::from_str(&deferred).expect("deferred raw");
        let WsServerPayload::Error { code, message } = deferred.payload else {
            panic!("expected deferred raw error");
        };
        assert_eq!(code, "codex_deferred_method");
        assert!(message.contains("cloud/handoff"));

        let server_request_method = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "raw-server-request-method",
                    "method": methods::CODEX_RAW_REQUEST,
                    "payload": {
                        "method": "mcp/elicitation",
                        "params": {}
                    }
                })
                .to_string(),
            )
            .await;
        let server_request_method: WsServerResponse =
            serde_json::from_str(&server_request_method).expect("server request raw");
        let WsServerPayload::Error { code, message } = server_request_method.payload else {
            panic!("expected server request raw error");
        };
        assert_eq!(code, "codex_unknown_client_method");
        assert!(message.contains("mcp/elicitation"));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["remote/connectionList", "command/exec"]
        );
    }

    #[tokio::test]
    async fn provider_runtime_lists_registered_host_tools_over_ws_rpc() {
        let runner = Arc::new(FakeRunner);
        let mut descriptor = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        descriptor.aliases = vec!["ace_browser".to_string()];
        descriptor.actions = vec![ToolActionKind::BrowserNavigate];
        descriptor.capabilities = vec![ProviderCapability {
            key: "host_tool.browser.tabs".to_string(),
            version: 2,
        }];
        let mut host_tools = HostToolRegistry::new();
        host_tools
            .register(Arc::new(RecordingHostTool {
                descriptor,
                invocations: Mutex::new(Vec::new()),
                result: json!({ "ok": true }),
                error: None,
            }))
            .expect("register host tool");
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_host_tools(host_tools);

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "host-tools-list",
                    "method": methods::PROVIDER_RUNTIME_HOST_TOOLS_LIST,
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse =
            serde_json::from_str(&response).expect("host tools list response");
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected host tools list result");
        };
        assert_eq!(body["tools"][0]["name"], "browser.open");
        assert_eq!(body["tools"][0]["aliases"][0], "ace_browser");
        assert_eq!(body["tools"][0]["transport"], "browser_bridge");
        assert_eq!(body["tools"][0]["surface"], "browser");
        assert!(
            body["tools"][0]["capabilities"]
                .as_array()
                .expect("capabilities")
                .contains(&json!({
                    "key": "host_tool.browser.tabs",
                    "version": 2
                }))
        );
        assert!(
            body["tools"][0]["capabilities"]
                .as_array()
                .expect("capabilities")
                .contains(&json!({
                    "key": "host_tool.action.browser.navigate",
                    "version": 1
                }))
        );
    }

    #[tokio::test]
    async fn provider_runtime_invokes_host_tool_for_pending_codex_server_request() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let mut descriptor = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        descriptor.aliases = vec!["ace_browser".to_string()];
        descriptor.actions = vec![ToolActionKind::BrowserNavigate];
        let host_tool = Arc::new(RecordingHostTool {
            descriptor,
            invocations: Mutex::new(Vec::new()),
            result: json!({ "opened": true }),
            error: None,
        });
        let mut host_tools = HostToolRegistry::new();
        host_tools
            .register(host_tool.clone())
            .expect("register host tool");
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()))
        .with_host_tools(host_tools);
        state
            .provider_events
            .lock()
            .expect("provider events")
            .append_batch("codex", &[pending_codex_dynamic_tool_request()])
            .expect("append server request");

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "host-tool-invoke",
                    "method": methods::PROVIDER_RUNTIME_HOST_TOOL_INVOKE_SERVER_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "request_id": 42,
                        "audit": {
                            "decided_by": "user",
                            "reason": "approved in UI"
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse =
            serde_json::from_str(&response).expect("host tool invoke response");
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected host tool invoke result");
        };
        assert_eq!(body["responded"], true);
        assert_eq!(body["decision"]["outcome"], "result");
        assert_eq!(body["decision"]["payload"]["opened"], true);
        assert_eq!(
            body["decision"]["audit"]["metadata"]["host_tool"]["tool_name"],
            "ace_browser"
        );
        assert_eq!(
            body["decision"]["audit"]["metadata"]["host_tool"]["descriptor_name"],
            "browser.open"
        );
        assert_eq!(body["request"]["request_id"], "42");

        assert_eq!(
            backend
                .server_request_responses
                .lock()
                .expect("responses")
                .as_slice(),
            [ServerRequestResponse::Result {
                request_id: 42,
                result: json!({ "opened": true })
            }]
        );
        let invocations = host_tool.invocations.lock().expect("invocations");
        assert_eq!(invocations.len(), 1);
        assert_eq!(invocations[0].arguments["url"], "http://localhost:5173");

        let resolved = state
            .provider_events
            .lock()
            .expect("provider events")
            .server_requests(
                Some("codex"),
                Some(ProviderServerRequestStatus::Resolved),
                10,
            )
            .expect("resolved requests");
        assert_eq!(resolved.len(), 1);
        assert_eq!(
            resolved[0].decision.as_ref().expect("decision").payload["opened"],
            true
        );
    }

    #[tokio::test]
    async fn provider_runtime_records_missing_host_tool_as_provider_error() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));
        state
            .provider_events
            .lock()
            .expect("provider events")
            .append_batch("codex", &[pending_codex_dynamic_tool_request()])
            .expect("append server request");

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "host-tool-missing",
                    "method": methods::PROVIDER_RUNTIME_HOST_TOOL_INVOKE_SERVER_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "request_id": "42",
                        "audit": { "decided_by": "user" }
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse =
            serde_json::from_str(&response).expect("missing host tool response");
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected missing host tool decision response");
        };
        assert_eq!(body["responded"], true);
        assert_eq!(body["decision"]["outcome"], "error");
        assert_eq!(body["decision"]["payload"]["code"], -32012);
        assert!(
            body["decision"]["payload"]["message"]
                .as_str()
                .expect("message")
                .contains("ace_browser")
        );
        assert_eq!(
            body["decision"]["audit"]["metadata"]["host_tool"]["error"]["kind"],
            "tool_not_found"
        );
        assert_eq!(
            body["decision"]["audit"]["metadata"]["host_tool"]["invocation"]["tool_name"],
            "ace_browser"
        );
        assert_eq!(
            backend
                .server_request_responses
                .lock()
                .expect("responses")
                .as_slice(),
            [ServerRequestResponse::Error {
                request_id: 42,
                code: -32012,
                message: "host tool `ace_browser` is not registered".to_string()
            }]
        );
    }

    #[tokio::test]
    async fn provider_runtime_records_host_tool_handler_failure_as_provider_error() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let mut descriptor = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        descriptor.aliases = vec!["ace_browser".to_string()];
        descriptor.actions = vec![ToolActionKind::BrowserNavigate];
        let host_tool = Arc::new(RecordingHostTool {
            descriptor,
            invocations: Mutex::new(Vec::new()),
            result: Value::Null,
            error: Some("browser bridge disconnected".to_string()),
        });
        let mut host_tools = HostToolRegistry::new();
        host_tools
            .register(host_tool.clone())
            .expect("register host tool");
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()))
        .with_host_tools(host_tools);
        state
            .provider_events
            .lock()
            .expect("provider events")
            .append_batch("codex", &[pending_codex_dynamic_tool_request()])
            .expect("append server request");

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "host-tool-handler-error",
                    "method": methods::PROVIDER_RUNTIME_HOST_TOOL_INVOKE_SERVER_REQUEST,
                    "payload": {
                        "provider": "codex",
                        "request_id": "42",
                        "audit": { "decided_by": "user" }
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse =
            serde_json::from_str(&response).expect("handler failure response");
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected handler failure decision response");
        };
        assert_eq!(body["responded"], true);
        assert_eq!(body["decision"]["outcome"], "error");
        assert_eq!(body["decision"]["payload"]["code"], -32015);
        assert_eq!(
            body["decision"]["audit"]["metadata"]["host_tool"]["error"]["kind"],
            "handler_failed"
        );
        assert_eq!(
            body["decision"]["audit"]["metadata"]["host_tool"]["invocation"]["descriptor_name"],
            "browser.open"
        );
        assert_eq!(host_tool.invocations.lock().expect("invocations").len(), 1);
        assert_eq!(
            backend
                .server_request_responses
                .lock()
                .expect("responses")
                .as_slice(),
            [ServerRequestResponse::Error {
                request_id: 42,
                code: -32015,
                message: "host tool failed: browser bridge disconnected".to_string()
            }]
        );
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

        state
            .provider_events
            .lock()
            .expect("provider events")
            .append_batch(
                "codex",
                &[ProviderEvent::ServerRequest {
                    request: Box::new(NormalizedServerRequest {
                        kind: ServerRequestKind::CommandApproval,
                        request_id: "42".to_string(),
                        method: "command/approvalRequest".to_string(),
                        thread_id: Some("thread-1".to_string()),
                        turn_id: Some("turn-1".to_string()),
                        item_id: Some("item-1".to_string()),
                        scope: Some("command".to_string()),
                        title: Some("Approve command execution".to_string()),
                        prompt: Some("Run cargo test?".to_string()),
                        selected_policy: Some("on-request".to_string()),
                        metadata: json!({ "command": "cargo test" }),
                        provider: ProviderMetadata {
                            provider: "codex".to_string(),
                            method: Some("command/approvalRequest".to_string()),
                            schema_version: None,
                            raw_payload: json!({ "command": "cargo test" }),
                        },
                    }),
                }],
            )
            .expect("append pending request");

        let (provider_sender, mut provider_receiver) = broadcast::channel(8);
        state
            .provider_event_streams
            .lock()
            .expect("provider event streams")
            .insert(ProviderKind::Codex, provider_sender);

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
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected approval result response");
        };
        assert_eq!(body["responded"], true);
        assert_eq!(body["provider"], "codex");
        assert_eq!(body["request_id"], "42");
        assert_eq!(body["decision"]["outcome"], "result");
        assert_eq!(body["decision"]["payload"]["approved"], true);
        assert_eq!(body["decision"]["audit"]["scope"], "command");
        assert_eq!(body["decision"]["audit"]["source_thread_id"], "thread-1");
        assert_eq!(body["decision"]["audit"]["source_item_id"], "item-1");
        assert_eq!(body["decision"]["audit"]["prompt"], "Run cargo test?");
        assert_eq!(body["decision"]["audit"]["selected_policy"], "on-request");
        assert_eq!(body["decision"]["audit"]["metadata"]["risk"], "low");
        assert_eq!(body["request"]["request_id"], "42");
        assert_eq!(body["request"]["prompt"], "Run cargo test?");
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
        let ProviderEventStreamMessage::Events {
            events: pushed_events,
            last_persisted_sequence,
        } = provider_receiver.recv().await.expect("provider event push")
        else {
            panic!("expected pushed provider events");
        };
        assert!(last_persisted_sequence.is_some_and(|sequence| sequence > 0));
        assert_eq!(pushed_events.len(), 1);
        let ProviderEvent::ServerRequestResolved {
            request_id,
            decision,
            request,
        } = &pushed_events[0]
        else {
            panic!("expected server request resolved event");
        };
        assert_eq!(request_id, "42");
        assert_eq!(decision.outcome, "result");
        assert_eq!(decision.payload["approved"], true);
        assert_eq!(decision.audit["source_thread_id"], "thread-1");
        assert_eq!(
            request.as_ref().expect("request").prompt.as_deref(),
            Some("Run cargo test?")
        );

        let records = state
            .provider_events
            .lock()
            .expect("provider events")
            .server_requests(
                Some("codex"),
                Some(ProviderServerRequestStatus::Resolved),
                10,
            )
            .expect("resolved requests");
        assert_eq!(records.len(), 1);
        let decision = records[0].decision.as_ref().expect("decision");
        assert_eq!(decision.audit["scope"], "command");
        assert_eq!(decision.audit["source_thread_id"], "thread-1");
        assert_eq!(decision.audit["source_item_id"], "item-1");
        assert_eq!(decision.audit["prompt"], "Run cargo test?");
        assert_eq!(decision.audit["selected_policy"], "on-request");
        assert_eq!(decision.audit["metadata"]["risk"], "low");
        assert_eq!(
            decision.audit["metadata"]["provider_method"],
            "command/approvalRequest"
        );
        assert_eq!(
            decision.audit["metadata"]["request_metadata"]["command"],
            "cargo test"
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

        state
            .provider_events
            .lock()
            .expect("provider events")
            .append_batch(
                "codex",
                &[ProviderEvent::ServerRequest {
                    request: Box::new(NormalizedServerRequest {
                        kind: ServerRequestKind::FileChangeApproval,
                        request_id: "43".to_string(),
                        method: "fileChange/approvalRequest".to_string(),
                        thread_id: Some("thread-1".to_string()),
                        turn_id: Some("turn-2".to_string()),
                        item_id: Some("file-change-1".to_string()),
                        scope: Some("filesystem".to_string()),
                        title: Some("Approve file changes".to_string()),
                        prompt: Some("Write outside workspace?".to_string()),
                        selected_policy: Some("strict".to_string()),
                        metadata: json!({ "path": "/tmp/outside.txt" }),
                        provider: ProviderMetadata {
                            provider: "codex".to_string(),
                            method: Some("fileChange/approvalRequest".to_string()),
                            schema_version: None,
                            raw_payload: json!({ "path": "/tmp/outside.txt" }),
                        },
                    }),
                }],
            )
            .expect("append pending request");

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
                            "decided_by": "user",
                            "reason": "outside workspace"
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected approval error response");
        };
        assert_eq!(body["responded"], true);
        assert_eq!(body["provider"], "codex");
        assert_eq!(body["request_id"], "43");
        assert_eq!(body["decision"]["outcome"], "error");
        assert_eq!(body["decision"]["payload"]["code"], -32001);
        assert_eq!(body["decision"]["payload"]["message"], "denied");
        assert_eq!(body["decision"]["audit"]["scope"], "filesystem");
        assert_eq!(body["decision"]["audit"]["source_thread_id"], "thread-1");
        assert_eq!(body["decision"]["audit"]["source_item_id"], "file-change-1");
        assert_eq!(
            body["decision"]["audit"]["prompt"],
            "Write outside workspace?"
        );
        assert_eq!(body["decision"]["audit"]["selected_policy"], "strict");
        assert_eq!(body["request"]["request_id"], "43");
        assert_eq!(body["request"]["prompt"], "Write outside workspace?");
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
        let records = state
            .provider_events
            .lock()
            .expect("provider events")
            .server_requests(
                Some("codex"),
                Some(ProviderServerRequestStatus::Resolved),
                10,
            )
            .expect("resolved requests");
        assert_eq!(records.len(), 1);
        let decision = records[0].decision.as_ref().expect("decision");
        assert_eq!(decision.outcome, "error");
        assert_eq!(decision.audit["scope"], "filesystem");
        assert_eq!(decision.audit["source_thread_id"], "thread-1");
        assert_eq!(decision.audit["source_item_id"], "file-change-1");
        assert_eq!(decision.audit["prompt"], "Write outside workspace?");
        assert_eq!(decision.audit["selected_policy"], "strict");
        assert_eq!(
            decision.audit["metadata"]["provider_method"],
            "fileChange/approvalRequest"
        );
        assert_eq!(
            decision.audit["metadata"]["request_metadata"]["path"],
            "/tmp/outside.txt"
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
        assert_eq!(code, "provider_unavailable");
    }

    #[tokio::test]
    async fn dispatches_codex_lifecycle_methods_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        backend
            .stderr_tail
            .lock()
            .expect("stderr tail")
            .extend(["warn one".to_string(), "warn two".to_string()]);
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let stderr = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "stderr",
                    "method": methods::CODEX_STDERR_TAIL,
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let stderr: WsServerResponse = serde_json::from_str(&stderr).expect("stderr response");
        let WsServerPayload::Result { body } = stderr.payload else {
            panic!("expected stderr result");
        };
        assert_eq!(body["lines"], json!(["warn one", "warn two"]));

        let shutdown = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "shutdown",
                    "method": methods::CODEX_SHUTDOWN,
                    "payload": { "grace_ms": 25 }
                })
                .to_string(),
            )
            .await;
        let shutdown: WsServerResponse = serde_json::from_str(&shutdown).expect("shutdown");
        assert!(matches!(shutdown.payload, WsServerPayload::Result { .. }));

        let restart = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "restart",
                    "method": methods::CODEX_RESTART,
                    "payload": { "grace_ms": 50 }
                })
                .to_string(),
            )
            .await;
        let restart: WsServerResponse = serde_json::from_str(&restart).expect("restart");
        assert!(matches!(restart.payload, WsServerPayload::Result { .. }));
        assert_eq!(
            backend.shutdowns.lock().expect("shutdowns").as_slice(),
            [Duration::from_millis(25)]
        );
        assert_eq!(
            backend.restarts.lock().expect("restarts").as_slice(),
            [Duration::from_millis(50)]
        );
    }
}
