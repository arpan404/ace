use crate::ws::{ProviderEventStreamMessage, WsApiState, WsDispatchError};
use ace_core::ProviderKind;
use ace_git::ProcessRunner;
use ace_persistence::ProviderServerRequestStatus;
use ace_protocol::{
    PROTOCOL_VERSION,
    codex::{
        CodexCompatibilityInventoryResponse, CodexGoalSetRequest,
        CodexGuardianDeniedActionApprovalRequest, CodexHandoffLocation, CodexHandoffToAgentRequest,
        CodexHandoffToLocationRequest, CodexHandoffToLocationResponse,
        CodexPermissionPresetRequest, CodexPlanImplementationRequest, CodexPlanTurnStartRequest,
        CodexRawRequest, CodexShutdownRequest, CodexStderrTailResponse, CodexSubagentSteerRequest,
        CodexSubagentThreadRpcRequest, CodexThreadForkRequest, CodexThreadIdRequest,
        CodexThreadInjectItemsRequest, CodexThreadRollbackRequest, CodexThreadSetNameRequest,
        CodexThreadStartRequest, CodexThreadUpdateMetadataRequest, CodexThreadsListRequest,
        CodexTurnStartRequest, CodexVersionedRequest,
    },
    git::GitWorktreeCreateRequest,
    provider_runtime::{
        PROVIDER_RUNTIME_EVENT_TOPIC, ProviderRuntimeContractReport, ProviderRuntimeEvent,
        ProviderRuntimeEventBatch, ProviderRuntimeEventRecord, ProviderRuntimeProviderInfo,
        ProviderRuntimeProvidersList, ProviderRuntimeRecentEventsRequest,
        ProviderRuntimeRecentEventsResponse, ProviderRuntimeRequest,
        ProviderRuntimeSubscribeRequest, ProviderServerRequestDecisionRecord,
        ProviderServerRequestError, ProviderServerRequestRecord, ProviderServerRequestResult,
        ProviderServerRequestStatusFilter, ProviderServerRequestsListRequest,
        ProviderServerRequestsListResponse,
    },
    ws::{WsServerPayload, WsServerResponse, methods},
};
use ace_runtime::provider::ProviderRequest;
use ace_runtime::threads::ExecutionLocation;
use ace_terminal::PtyAdapter;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::sync::{broadcast, mpsc};

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_codex_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        if let Some(codex_method) = codex_versioned_app_server_method(method) {
            let request = serde_json::from_value::<CodexVersionedRequest>(payload)?;
            return self
                .codex
                .raw_request(codex_method.to_string(), request.params)
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
                let response = self
                    .providers
                    .request(
                        request.provider,
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
                self.providers
                    .respond_server_request_result(
                        provider_kind,
                        request.request_id.to_string(),
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
                        serde_json::to_value(request.audit)?,
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
                self.providers
                    .respond_server_request_error(
                        provider_kind,
                        request.request_id.to_string(),
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
                        serde_json::to_value(request.audit)?,
                    )?;
                Ok(serde_json::json!({ "responded": true }))
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
                let batch = ProviderRuntimeEventBatch {
                    provider: provider_name.clone(),
                    events: events
                        .iter()
                        .cloned()
                        .map(|event| {
                            ProviderRuntimeEvent::from_provider_event(&provider_name, event)
                        })
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

fn codex_versioned_app_server_method(ws_method: &str) -> Option<&'static str> {
    match ws_method {
        methods::CODEX_REVIEW_START => Some("review/start"),
        methods::CODEX_COMMAND_EXEC => Some("command/exec"),
        methods::CODEX_COMMAND_WRITE_STDIN => Some("command/writeStdin"),
        methods::CODEX_COMMAND_RESIZE => Some("command/resize"),
        methods::CODEX_COMMAND_TERMINATE => Some("command/terminate"),
        methods::CODEX_PROCESS_LIST => Some("process/list"),
        methods::CODEX_PROCESS_CLEAN => Some("process/clean"),
        methods::CODEX_MCP_STATUS => Some("mcp/status"),
        methods::CODEX_MCP_RESOURCE_READ => Some("mcp/resourceRead"),
        methods::CODEX_MCP_OAUTH_LOGIN => Some("mcp/oauthLogin"),
        methods::CODEX_MCP_TOOL_CALL => Some("mcp/toolCall"),
        methods::CODEX_SKILLS_LIST => Some("skills/list"),
        methods::CODEX_SKILLS_READ => Some("skills/read"),
        methods::CODEX_SKILLS_INSTALL => Some("skills/install"),
        methods::CODEX_PLUGINS_LIST => Some("plugins/list"),
        methods::CODEX_PLUGINS_INSTALL => Some("plugins/install"),
        methods::CODEX_APPS_LIST => Some("apps/list"),
        methods::CODEX_APPS_CONFIG_WRITE => Some("apps/configWrite"),
        methods::CODEX_REMOTE_CONNECTION_LIST => Some("remote/connectionList"),
        methods::CODEX_REMOTE_HANDOFF => Some("remote/handoff"),
        _ => None,
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
        provider::{NormalizedServerRequest, ProviderEvent, ProviderMetadata, ServerRequestKind},
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
        assert_eq!(records.len(), 3);
        assert_eq!(records[0]["provider"], "codex");
        assert_eq!(records[0]["event"]["type"], "tool_completed");
        assert_eq!(
            records[0]["event"]["tool"]["display"]["title"],
            "Clicked Deploy in Browser"
        );
        assert_eq!(records[0]["raw_event"]["type"], "semantic_tool");
        assert_eq!(records[2]["raw_event"]["method"], "item/completed");

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
                        "provider": "Codex",
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
                        "provider": "Ace",
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
                json!({ "params": { "threadId": "thread-1" } }),
            ),
            (
                methods::CODEX_COMMAND_EXEC,
                json!({ "params": { "command": "cargo test" } }),
            ),
            (
                methods::CODEX_COMMAND_WRITE_STDIN,
                json!({ "params": { "processId": "p1", "stdin": "q" } }),
            ),
            (
                methods::CODEX_PROCESS_LIST,
                json!({ "params": { "threadId": "thread-1" } }),
            ),
            (
                methods::CODEX_MCP_TOOL_CALL,
                json!({ "params": { "server": "github", "tool": "list_issues" } }),
            ),
            (
                methods::CODEX_SKILLS_INSTALL,
                json!({ "params": { "skill": "rust" } }),
            ),
            (
                methods::CODEX_APPS_CONFIG_WRITE,
                json!({ "params": { "app": "browser", "config": {} } }),
            ),
            (
                methods::CODEX_REMOTE_HANDOFF,
                json!({ "params": { "threadId": "thread-1", "host": "devbox" } }),
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
