use crate::ws::{ProviderEventStreamMessage, WsApiState, WsDispatchError};
use ace_core::ProviderKind;
use ace_git::ProcessRunner;
use ace_persistence::ProviderServerRequestStatus;
use ace_protocol::{
    PROTOCOL_VERSION,
    codex::{
        CodexAppConfigWriteRequest, CodexCommandExecRequest, CodexCommandProcessRequest,
        CodexCommandResizeRequest, CodexCommandWriteStdinRequest,
        CodexCompatibilityInventoryResponse, CodexGoalSetRequest,
        CodexGuardianDeniedActionApprovalRequest, CodexHandoffLocation, CodexHandoffToAgentRequest,
        CodexHandoffToLocationRequest, CodexHandoffToLocationResponse, CodexMcpOauthLoginRequest,
        CodexMcpResourceReadRequest, CodexMcpStatusRequest, CodexMcpToolCallRequest,
        CodexNamedQueryRequest, CodexPermissionPresetRequest, CodexPlanImplementationRequest,
        CodexPlanTurnStartRequest, CodexPluginRequest, CodexProcessCleanRequest,
        CodexProcessListRequest, CodexRawRequest, CodexRemoteHandoffRequest,
        CodexReviewStartRequest, CodexShutdownRequest, CodexSkillRequest, CodexStderrTailResponse,
        CodexSubagentSteerRequest, CodexSubagentThreadRpcRequest, CodexThreadForkRequest,
        CodexThreadIdRequest, CodexThreadInjectItemsRequest, CodexThreadRollbackRequest,
        CodexThreadSetNameRequest, CodexThreadStartRequest, CodexThreadUpdateMetadataRequest,
        CodexThreadsListRequest, CodexTurnStartRequest, CodexVersionedRequest,
    },
    git::GitWorktreeCreateRequest,
    provider_runtime::{
        PROVIDER_RUNTIME_EVENT_TOPIC, ProviderRuntimeContractReport, ProviderRuntimeEvent,
        ProviderRuntimeEventBatch, ProviderRuntimeEventRecord, ProviderRuntimeFeaturesListRequest,
        ProviderRuntimeFeaturesListResponse, ProviderRuntimeLifecycleRequest,
        ProviderRuntimeLifecycleResponse, ProviderRuntimeProviderFeatures,
        ProviderRuntimeProviderInfo, ProviderRuntimeProviderState, ProviderRuntimeProviderStatus,
        ProviderRuntimeProvidersList, ProviderRuntimeRecentEventsRequest,
        ProviderRuntimeRecentEventsResponse, ProviderRuntimeRequest,
        ProviderRuntimeStateGetRequest, ProviderRuntimeStateGetResponse,
        ProviderRuntimeStatusListRequest, ProviderRuntimeStatusListResponse,
        ProviderRuntimeSubscribeRequest, ProviderServerRequestAudit,
        ProviderServerRequestDecisionRecord, ProviderServerRequestError,
        ProviderServerRequestRecord, ProviderServerRequestResult,
        ProviderServerRequestStatusFilter, ProviderServerRequestsListRequest,
        ProviderServerRequestsListResponse, projection_deltas_for_events,
    },
    ws::{WsServerPayload, WsServerResponse, methods},
};
use ace_runtime::provider::{NormalizedServerRequest, ProviderRequest};
use ace_runtime::threads::ExecutionLocation;
use ace_terminal::PtyAdapter;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::sync::{broadcast, mpsc};

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_codex_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        if let Some((codex_method, params)) = codex_versioned_app_server_request(method, &payload)?
        {
            return self
                .codex
                .raw_request(codex_method.to_string(), params)
                .await
                .map_err(Into::into);
        }

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
                            .fork_thread(request.thread_id, request.ephemeral, request.turn_id)
                            .await
                    },
                )
                .await
            }
            methods::CODEX_SIDE_CHAT_START => {
                self.codex_json::<CodexThreadForkRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .start_side_chat(request.thread_id, request.turn_id)
                            .await
                    },
                )
                .await
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
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.archive_thread(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_THREAD_UNARCHIVE => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.unarchive_thread(request.thread_id).await
                    },
                )
                .await
            }
            methods::CODEX_THREAD_DELETE => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.delete_thread(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_THREAD_UNSUBSCRIBE => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.unsubscribe_thread(request.thread_id).await
                    },
                )
                .await
            }
            methods::CODEX_THREAD_SET_NAME => {
                self.codex_json::<CodexThreadSetNameRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .set_thread_name(request.thread_id, request.name)
                            .await
                    },
                )
                .await
            }
            methods::CODEX_THREAD_UPDATE_METADATA => {
                self.codex_json::<CodexThreadUpdateMetadataRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .update_thread_metadata(request.thread_id, request.metadata)
                            .await
                    },
                )
                .await
            }
            methods::CODEX_THREAD_COMPACT => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.compact_thread(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_THREAD_ROLLBACK => {
                self.codex_json::<CodexThreadRollbackRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .rollback_thread(request.thread_id, request.turn_id)
                            .await
                    },
                )
                .await
            }
            methods::CODEX_THREAD_INJECT_ITEMS => {
                self.codex_json::<CodexThreadInjectItemsRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .inject_thread_items(request.thread_id, request.items)
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
            methods::CODEX_PLAN_CONTINUE_IN_THREAD => {
                self.codex_json::<CodexPlanImplementationRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.continue_plan_in_thread(request.params).await
                    },
                )
                .await
            }
            methods::CODEX_PLAN_FORK_FOR_IMPLEMENTATION => {
                self.codex_json::<CodexPlanImplementationRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.fork_plan_for_implementation(request.params).await
                    },
                )
                .await
            }
            methods::CODEX_PLAN_SIDE_IMPLEMENTATION => {
                self.codex_json::<CodexPlanImplementationRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.side_implementation(request.params).await
                    },
                )
                .await
            }
            methods::CODEX_CONFIG_REQUIREMENTS_READ => {
                let response = self.codex.config_requirements_read().await?;
                Ok(response)
            }
            methods::CODEX_COMPATIBILITY_INVENTORY => {
                Ok(serde_json::to_value(CodexCompatibilityInventoryResponse {
                    methods: ace_codex::codex_method_inventory()
                        .iter()
                        .copied()
                        .map(Into::into)
                        .collect(),
                })?)
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
                Ok(serde_json::to_value(request.preset.turn_permissions())?)
            }
            methods::CODEX_THREAD_APPROVE_GUARDIAN_DENIED_ACTION => {
                self.codex_json::<CodexGuardianDeniedActionApprovalRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .approve_guardian_denied_action(request.params)
                            .await
                    },
                )
                .await
            }
            methods::CODEX_GOAL_SET => {
                self.codex_json::<CodexGoalSetRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.goal_set(request.params).await },
                )
                .await
            }
            methods::CODEX_GOAL_GET => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.goal_get(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_GOAL_CLEAR => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.goal_clear(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_GOAL_PAUSE => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.goal_pause(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_GOAL_RESUME => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.goal_resume(request.thread_id).await },
                )
                .await
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
                self.codex_json::<CodexSubagentSteerRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.subagent_steer(request.params).await },
                )
                .await
            }
            methods::CODEX_SUBAGENT_STOP => {
                self.codex_json::<CodexSubagentThreadRpcRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .subagent_stop(
                                request.params.thread_id,
                                request.params.subagent_thread_id,
                            )
                            .await
                    },
                )
                .await
            }
            methods::CODEX_SUBAGENT_CLOSE => {
                self.codex_json::<CodexSubagentThreadRpcRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .subagent_close(
                                request.params.thread_id,
                                request.params.subagent_thread_id,
                            )
                            .await
                    },
                )
                .await
            }
            methods::CODEX_HANDOFF_TO_AGENT => {
                self.codex_json::<CodexHandoffToAgentRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.handoff_to_agent(request.params).await },
                )
                .await
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
                start_point: request.start_point,
            })
            .await?;

        let worktree_path = worktree.path.to_string_lossy().to_string();
        let repo_root = worktree.repo_root.to_string_lossy().to_string();
        let metadata = serde_json::json!({
            "execution_location": "worktree",
            "handoff": {
                "source_thread_id": request.thread_id,
                "worktree_path": worktree_path,
                "worktree_branch": worktree.branch,
                "repo_root": repo_root,
            }
        });
        self.codex
            .update_thread_metadata(request.thread_id.clone(), metadata.clone())
            .await?;
        self.codex
            .record_handoff_to_location(
                request.thread_id.clone(),
                ExecutionLocation::Worktree,
                Some(request.thread_id.clone()),
            )
            .await;

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
                    reports: self.providers.contract_reports(),
                })?)
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
                    match provider {
                        ProviderKind::Codex => {
                            provider_states.push(ProviderRuntimeProviderState {
                                provider,
                                runtime_id: provider.runtime_id().to_string(),
                                display_name: provider.display_name().to_string(),
                                state: self.codex.runtime_state_snapshot().await,
                            });
                        }
                        _ => {
                            if requested_provider.is_some() {
                                return Err(WsDispatchError::BadRequest(format!(
                                    "provider `{}` does not expose runtime state",
                                    provider.runtime_id()
                                )));
                            }
                        }
                    }
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
                    .recent(request.provider.as_deref(), request.limit)?
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
                            raw_event: record.event,
                        }
                    })
                    .collect();
                Ok(serde_json::to_value(ProviderRuntimeRecentEventsResponse {
                    records,
                })?)
            }
            methods::PROVIDER_RUNTIME_REQUEST => {
                let request = serde_json::from_value::<ProviderRuntimeRequest>(payload)?;
                let provider =
                    ProviderKind::from_runtime_id(&request.provider).ok_or_else(|| {
                        WsDispatchError::BadRequest(format!(
                            "unknown provider `{}` for runtime request",
                            request.provider
                        ))
                    })?;
                let response = self
                    .providers
                    .request(
                        provider,
                        ProviderRequest {
                            method: request.method,
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
                    .server_requests(request.provider.as_deref(), status, request.limit)?
                    .into_iter()
                    .map(provider_server_request_record_to_protocol)
                    .collect();
                Ok(serde_json::to_value(ProviderServerRequestsListResponse {
                    requests,
                })?)
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
                let audit = self.enriched_server_request_audit(
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
                self.provider_events
                    .lock()
                    .expect("provider event log")
                    .record_server_request_result(
                        &request.provider,
                        request.request_id,
                        request.result,
                        serde_json::to_value(audit)?,
                    )?;
                Ok(serde_json::json!({ "responded": true }))
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
                let audit = self.enriched_server_request_audit(
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
                self.provider_events
                    .lock()
                    .expect("provider event log")
                    .record_server_request_error(
                        &request.provider,
                        request.request_id,
                        serde_json::to_value(request.error)?,
                        serde_json::to_value(audit)?,
                    )?;
                Ok(serde_json::json!({ "responded": true }))
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }

    fn enriched_server_request_audit(
        &self,
        provider: &str,
        request_id: &str,
        audit: ProviderServerRequestAudit,
    ) -> Result<ProviderServerRequestAudit, WsDispatchError> {
        let request = self
            .provider_events
            .lock()
            .expect("provider event log")
            .server_request(provider, request_id)?
            .and_then(|record| record.request);
        Ok(enrich_server_request_audit(audit, request.as_ref()))
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
        let mut receiver = self.provider_event_receiver(provider_kind);
        tokio::spawn(async move {
            loop {
                let message = match receiver.recv().await {
                    Ok(message) => message,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let events = match message {
                    ProviderEventStreamMessage::Events(events) => events,
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
                let runtime_events = events
                    .iter()
                    .cloned()
                    .map(|event| ProviderRuntimeEvent::from_provider_event(&provider_name, event))
                    .collect::<Vec<_>>();
                let projection_deltas = projection_deltas_for_events(&runtime_events);
                let batch = ProviderRuntimeEventBatch {
                    provider: provider_name.clone(),
                    events: runtime_events,
                    projection_deltas,
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
        Ok(serde_json::json!({ "subscribed": true, "provider": response_provider }))
    }

    fn provider_runtime_info(
        &self,
        descriptor: ace_runtime::provider::ProviderDescriptor,
    ) -> ProviderRuntimeProviderInfo {
        let provider = descriptor.kind;
        ProviderRuntimeProviderInfo {
            provider,
            runtime_id: provider.runtime_id().to_string(),
            display_name: provider.display_name().to_string(),
            supports_events: self.providers.has_event_source(provider),
            supports_server_request_responses: self
                .providers
                .has_server_request_responder(provider),
            contract: ace_runtime::provider::provider_contract_report(&descriptor),
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
                if let Err(error) = append_result {
                    let _ = sender.send(ProviderEventStreamMessage::Error {
                        code: "persistence_error".to_string(),
                        message: error.to_string(),
                    });
                    break;
                }
                let _ = sender.send(ProviderEventStreamMessage::Events(events));
            }
            provider_streams
                .lock()
                .expect("provider event streams")
                .remove(&provider_kind);
        });
        receiver
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

fn codex_versioned_app_server_request(
    ws_method: &str,
    payload: &Value,
) -> Result<Option<(&'static str, Value)>, WsDispatchError> {
    let request = match ws_method {
        methods::CODEX_REVIEW_START => Some((
            "review/start",
            typed_or_enveloped::<CodexReviewStartRequest>(payload)?,
        )),
        methods::CODEX_COMMAND_EXEC => Some((
            "command/exec",
            typed_or_enveloped::<CodexCommandExecRequest>(payload)?,
        )),
        methods::CODEX_COMMAND_WRITE_STDIN => Some((
            "command/writeStdin",
            typed_or_enveloped::<CodexCommandWriteStdinRequest>(payload)?,
        )),
        methods::CODEX_COMMAND_RESIZE => Some((
            "command/resize",
            typed_or_enveloped::<CodexCommandResizeRequest>(payload)?,
        )),
        methods::CODEX_COMMAND_TERMINATE => Some((
            "command/terminate",
            typed_or_enveloped::<CodexCommandProcessRequest>(payload)?,
        )),
        methods::CODEX_PROCESS_LIST => Some((
            "process/list",
            typed_or_enveloped::<CodexProcessListRequest>(payload)?,
        )),
        methods::CODEX_PROCESS_CLEAN => Some((
            "process/clean",
            typed_or_enveloped::<CodexProcessCleanRequest>(payload)?,
        )),
        methods::CODEX_MCP_STATUS => Some((
            "mcp/status",
            typed_or_enveloped::<CodexMcpStatusRequest>(payload)?,
        )),
        methods::CODEX_MCP_RESOURCE_READ => Some((
            "mcp/resourceRead",
            typed_or_enveloped::<CodexMcpResourceReadRequest>(payload)?,
        )),
        methods::CODEX_MCP_OAUTH_LOGIN => Some((
            "mcp/oauthLogin",
            typed_or_enveloped::<CodexMcpOauthLoginRequest>(payload)?,
        )),
        methods::CODEX_MCP_TOOL_CALL => Some((
            "mcp/toolCall",
            typed_or_enveloped::<CodexMcpToolCallRequest>(payload)?,
        )),
        methods::CODEX_SKILLS_LIST => Some((
            "skills/list",
            typed_or_enveloped::<CodexNamedQueryRequest>(payload)?,
        )),
        methods::CODEX_SKILLS_READ => Some((
            "skills/read",
            typed_or_enveloped::<CodexSkillRequest>(payload)?,
        )),
        methods::CODEX_SKILLS_INSTALL => Some((
            "skills/install",
            typed_or_enveloped::<CodexSkillRequest>(payload)?,
        )),
        methods::CODEX_PLUGINS_LIST => Some((
            "plugins/list",
            typed_or_enveloped::<CodexNamedQueryRequest>(payload)?,
        )),
        methods::CODEX_PLUGINS_INSTALL => Some((
            "plugins/install",
            typed_or_enveloped::<CodexPluginRequest>(payload)?,
        )),
        methods::CODEX_APPS_LIST => Some((
            "apps/list",
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
        _ => None,
    };
    Ok(request)
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
        provider::{
            NormalizedServerRequest, NormalizedThreadItem, ProviderEvent, ProviderMetadata,
            ServerRequestKind, ThreadItemKind, ThreadItemStatus,
        },
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
                "thread/injectItems:thread-1:1",
                "turn/start:thread-1",
                "thread/fork:thread-1:false",
                "thread/injectItems:fork-1:1",
                "turn/start:fork-1",
                "thread/fork:thread-1:true",
                "thread/injectItems:fork-1:1",
                "turn/start:fork-1",
            ]
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

        let preset = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "permission-preset",
                    "method": methods::CODEX_PERMISSION_PRESET_RESOLVE,
                    "payload": { "preset": "full_access" }
                })
                .to_string(),
            )
            .await;
        let preset: WsServerResponse = serde_json::from_str(&preset).expect("preset response");
        let WsServerPayload::Result { body } = preset.payload else {
            panic!("expected preset result");
        };
        assert_eq!(body["sandbox_policy"]["mode"], "danger-full-access");
        assert_eq!(body["approval_policy"]["mode"], "never");

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
                    && method["support"] == "typed_supported")
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

        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            [
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
                "goal/set:thread-1",
                "goal/get:thread-1",
                "goal/pause:thread-1",
                "goal/resume:thread-1",
                "goal/clear:thread-1",
            ]
        );
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
                "thread/updateMetadata:thread-1",
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
                "thread/read:thread-1",
                "thread/list",
                "thread/loadedList",
                "thread/archive:thread-1",
                "thread/unarchive:thread-1",
                "thread/delete:thread-1",
                "thread/unsubscribe:thread-1",
                "thread/setName:thread-1:Adapter work",
                "thread/updateMetadata:thread-1",
                "thread/compact:thread-1",
                "thread/rollback:thread-1:turn-2",
                "thread/injectItems:thread-1:1",
            ]
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
            ProviderEvent::RawNotification {
                method: "warning".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "message": "Context is almost full"
                }),
            },
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
                    "payload": { "provider": "codex" }
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
        assert_eq!(second_body, body);
        assert_eq!(body["provider"], "codex");
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
        assert_eq!(body["projection_deltas"][3]["type"], "thread_item_upsert");
        assert_eq!(body["projection_deltas"][4]["type"], "diff_updated");
        assert_eq!(
            body["projection_deltas"][4]["files"],
            json!(["src/main.rs"])
        );
        assert_eq!(body["projection_deltas"][4]["diff"], "@@ -1 +1 @@");
        assert_eq!(
            body["projection_deltas"][5]["type"],
            "raw_notification_observed"
        );
        assert_eq!(body["projection_deltas"][5]["method"], "warning");
        assert_eq!(body["projection_deltas"][6]["type"], "warning_raised");
        assert_eq!(
            body["projection_deltas"][6]["message"],
            "Context is almost full"
        );
        assert_eq!(body["raw_events"][2]["type"], "raw_notification");
        assert_eq!(body["raw_events"][2]["method"], "item/completed");

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
        assert_eq!(records.len(), 5);
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
        assert_eq!(records[0]["raw_event"]["type"], "semantic_tool");
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
        assert_eq!(records[2]["raw_event"]["method"], "item/completed");
        assert_eq!(
            records[3]["projection_deltas"][0]["type"],
            "thread_item_upsert"
        );
        assert_eq!(records[3]["projection_deltas"][1]["type"], "diff_updated");
        assert_eq!(
            records[3]["projection_deltas"][1]["files"],
            json!(["src/main.rs"])
        );
        assert_eq!(
            records[4]["projection_deltas"][0]["type"],
            "raw_notification_observed"
        );
        assert_eq!(records[4]["projection_deltas"][1]["type"], "warning_raised");
        assert_eq!(
            records[4]["projection_deltas"][1]["message"],
            "Context is almost full"
        );

        let (ace_outbound_tx, _ace_outbound_rx) = tokio::sync::mpsc::channel::<String>(1);
        let unsupported = state
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
        let unsupported: WsServerResponse =
            serde_json::from_str(&unsupported).expect("unsupported response");
        let WsServerPayload::Result { body } = unsupported.payload else {
            panic!("expected unsupported provider event result");
        };
        assert_eq!(body["subscribed"], false);
        assert_eq!(body["provider"], "ace");
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
                .any(|capability| capability["key"] == "provider.runtime.raw_request")
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

        let ace_runtime = runtime
            .iter()
            .find(|provider| provider["runtime_id"] == "ace")
            .expect("ace runtime provider");
        assert_eq!(ace_runtime["provider"], "Ace");
        assert_eq!(ace_runtime["display_name"], "Ace");
        assert_eq!(ace_runtime["descriptor"]["kind"], "Ace");
        assert_eq!(ace_runtime["supports_events"], false);
        assert_eq!(ace_runtime["supports_server_request_responses"], false);
        assert_eq!(ace_runtime["contract"]["satisfies_required"], true);

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

        let ace = providers
            .iter()
            .find(|provider| provider["runtime_id"] == "ace")
            .expect("ace status");
        assert_eq!(ace["status"]["health"], "ready");
        assert_eq!(ace["status"]["transport"], "in_process");
        assert_eq!(ace["status"]["initialized"], true);
        assert_eq!(ace["supports_events"], false);
        assert_eq!(ace["supports_server_request_responses"], false);

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
        assert_eq!(body["providers"].as_array().expect("providers").len(), 1);
        assert_eq!(body["providers"][0]["runtime_id"], "codex");
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
                methods::CODEX_COMMAND_EXEC,
                json!({ "command": "cargo test", "thread_id": "thread-1", "cwd": "/tmp" }),
            ),
            (
                methods::CODEX_COMMAND_WRITE_STDIN,
                json!({ "process_id": "p1", "stdin": "q" }),
            ),
            (
                methods::CODEX_PROCESS_LIST,
                json!({ "params": { "threadId": "thread-1" } }),
            ),
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
                methods::CODEX_APPS_CONFIG_WRITE,
                json!({ "app": "browser", "config": { "enabled": true } }),
            ),
            (
                methods::CODEX_REMOTE_HANDOFF,
                json!({ "thread_id": "thread-1", "host": "devbox" }),
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
                "command/exec",
                "command/writeStdin",
                "process/list",
                "mcp/toolCall",
                "skills/install",
                "apps/configWrite",
                "remote/handoff",
            ]
        );

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
