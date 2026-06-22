use ace_core::ProviderKind;
use ace_runtime::{
    provider::{
        NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedThreadItem,
        ProviderAdapterContract, ProviderAdapterInvocationKind, ProviderAdapterOperation,
        ProviderAdapterOperationProfile, ProviderAdapterOperationSpec,
        ProviderAdapterOperationSupport, ProviderAdapterProfile, ProviderAdapterRuntimeReport,
        ProviderContractReport, ProviderDescriptor, ProviderDriverStatus, ProviderEvent,
        ProviderFeature, ProviderFeatureCategory, ProviderLifecycleAction, ProviderLifecycleResult,
        RuntimeSignalKind, ThreadItemKind, ThreadItemStatus,
    },
    threads::AgentRuntimeSnapshot,
    tools::{SemanticToolCall, ToolRunStatus},
};
use serde::{Deserialize, Deserializer, Serialize};

pub const PROVIDER_RUNTIME_EVENT_TOPIC: &str = "provider_runtime.event";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeSubscribeRequest {
    pub provider: Option<String>,
}

fn default_recent_events_limit() -> usize {
    100
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeRecentEventsRequest {
    pub provider: Option<String>,
    #[serde(default = "default_recent_events_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeEventRecord {
    pub sequence: i64,
    pub provider: String,
    pub created_at: String,
    pub event: ProviderRuntimeEvent,
    #[serde(default)]
    pub projection_deltas: Vec<ProviderRuntimeProjectionDelta>,
    pub raw_event: ProviderEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeRecentEventsResponse {
    pub records: Vec<ProviderRuntimeEventRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeRequest {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<ProviderAdapterOperation>,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default = "default_provider_request_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeProvidersList {
    pub providers: Vec<ProviderDescriptor>,
    #[serde(default)]
    pub runtime: Vec<ProviderRuntimeProviderInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderInfo {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub descriptor: ProviderDescriptor,
    pub supports_events: bool,
    pub supports_server_request_responses: bool,
    pub contract: ProviderContractReport,
    pub adapter_profile: ProviderAdapterProfile,
    pub adapter_runtime: ProviderAdapterRuntimeReport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeContractReport {
    pub adapter_contract: ProviderAdapterContract,
    pub reports: Vec<ProviderContractReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeOperationsListRequest {
    pub provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderOperation {
    pub operation: ProviderAdapterOperation,
    pub category: ProviderFeatureCategory,
    pub support: ProviderAdapterOperationSupport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_method: Option<String>,
    #[serde(default)]
    pub provider_methods: Vec<String>,
    pub invocation: ProviderAdapterInvocationKind,
    pub direct_invocation: bool,
}

impl ProviderRuntimeProviderOperation {
    pub fn from_spec(spec: &ProviderAdapterOperationSpec) -> Self {
        Self::from_profile(ProviderAdapterOperationProfile::from_spec(spec))
    }

    pub fn from_profile(profile: ProviderAdapterOperationProfile) -> Self {
        Self {
            operation: profile.operation,
            category: profile.category,
            support: profile.support,
            canonical_method: profile.canonical_method,
            provider_methods: profile.provider_methods,
            direct_invocation: profile.direct_invocation,
            invocation: profile.invocation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderOperations {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub adapter_profile: ProviderAdapterProfile,
    pub adapter_runtime: ProviderAdapterRuntimeReport,
    pub operations: Vec<ProviderRuntimeProviderOperation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeOperationsListResponse {
    pub adapter_contract: ProviderAdapterContract,
    pub providers: Vec<ProviderRuntimeProviderOperations>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeFeaturesListRequest {
    pub provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderFeatures {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub features: Vec<ProviderFeature>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeFeaturesListResponse {
    pub providers: Vec<ProviderRuntimeProviderFeatures>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeStatusListRequest {
    pub provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderStatus {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub status: ProviderDriverStatus,
    pub supports_events: bool,
    pub supports_server_request_responses: bool,
    pub contract: ProviderContractReport,
    pub adapter_profile: ProviderAdapterProfile,
    pub adapter_runtime: ProviderAdapterRuntimeReport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeStatusListResponse {
    pub providers: Vec<ProviderRuntimeProviderStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeStateGetRequest {
    pub provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderState {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub state: AgentRuntimeSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeStateGetResponse {
    pub providers: Vec<ProviderRuntimeProviderState>,
}

fn default_provider_lifecycle_grace_ms() -> u64 {
    5_000
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeLifecycleRequest {
    pub provider: String,
    pub action: ProviderLifecycleAction,
    #[serde(default = "default_provider_lifecycle_grace_ms")]
    pub grace_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeLifecycleResponse {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub result: ProviderLifecycleResult,
}

fn default_provider_request_timeout_ms() -> u64 {
    30_000
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ProviderServerRequestAudit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderServerRequestResult {
    pub provider: String,
    #[serde(deserialize_with = "deserialize_server_request_id")]
    pub request_id: String,
    #[serde(default)]
    pub result: serde_json::Value,
    #[serde(default)]
    pub audit: ProviderServerRequestAudit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderServerRequestErrorInfo {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderServerRequestError {
    pub provider: String,
    #[serde(deserialize_with = "deserialize_server_request_id")]
    pub request_id: String,
    pub error: ProviderServerRequestErrorInfo,
    #[serde(default)]
    pub audit: ProviderServerRequestAudit,
}

fn deserialize_server_request_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    struct ServerRequestIdVisitor;

    impl serde::de::Visitor<'_> for ServerRequestIdVisitor {
        type Value = String;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a provider server request id as a string or integer")
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(value.to_string())
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(value)
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(value.to_string())
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(value.to_string())
        }
    }

    deserializer.deserialize_any(ServerRequestIdVisitor)
}

fn default_server_requests_limit() -> usize {
    100
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderServerRequestStatusFilter {
    Pending,
    Resolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderServerRequestsListRequest {
    pub provider: Option<String>,
    pub status: Option<ProviderServerRequestStatusFilter>,
    #[serde(default = "default_server_requests_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderServerRequestDecisionRecord {
    pub outcome: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub audit: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderServerRequestRecord {
    pub provider: String,
    pub request_id: String,
    pub request: Option<NormalizedServerRequest>,
    pub status: ProviderServerRequestStatusFilter,
    pub decision: Option<ProviderServerRequestDecisionRecord>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderServerRequestsListResponse {
    pub requests: Vec<ProviderServerRequestRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeEventBatch {
    pub provider: String,
    pub events: Vec<ProviderRuntimeEvent>,
    #[serde(default)]
    pub projection_deltas: Vec<ProviderRuntimeProjectionDelta>,
    pub raw_events: Vec<ProviderEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderRuntimeProjectionDelta {
    ToolTimelineUpsert {
        tool: Box<SemanticToolCall>,
    },
    ApprovalUpsert {
        request: Box<NormalizedServerRequest>,
    },
    ApprovalResolved {
        provider: String,
        request_id: String,
        decision: ProviderServerRequestDecisionRecord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request: Option<Box<NormalizedServerRequest>>,
    },
    ThreadItemUpsert {
        item: Box<NormalizedThreadItem>,
    },
    PlanUpdated {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        status: ThreadItemStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    ChildThreadUpsert {
        provider: String,
        parent_thread_id: String,
        child_thread_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nickname: Option<String>,
        status: ThreadItemStatus,
    },
    ReviewModeChanged {
        provider: String,
        thread_id: String,
        active: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
    },
    DiffUpdated {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        status: ThreadItemStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        files: serde_json::Value,
    },
    TerminalOutputAppended {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        text: String,
    },
    WarningRaised {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        message: String,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    ModelRerouted {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to_model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    RealtimeTranscriptDelta {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        text: String,
    },
    RealtimeAudioDelta {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        audio: String,
    },
    ActiveTurnChanged {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        active: bool,
    },
    StderrAppended {
        provider: String,
        line: String,
    },
    ProviderExited {
        provider: String,
    },
    RawNotificationObserved {
        provider: String,
        method: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderRuntimeEvent {
    ToolStarted {
        tool: Box<SemanticToolCall>,
    },
    ToolUpdated {
        tool: Box<SemanticToolCall>,
    },
    ToolOutputDelta {
        tool: Box<SemanticToolCall>,
        delta: String,
    },
    ToolCompleted {
        tool: Box<SemanticToolCall>,
    },
    ToolFailed {
        tool: Box<SemanticToolCall>,
        message: String,
    },
    ToolApprovalRequested {
        tool: Box<SemanticToolCall>,
    },
    ThreadItem {
        item: Box<NormalizedThreadItem>,
    },
    ServerRequest {
        request: Box<NormalizedServerRequest>,
    },
    ServerRequestResolved {
        provider: String,
        request_id: String,
        decision: ProviderServerRequestDecisionRecord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request: Option<Box<NormalizedServerRequest>>,
    },
    RuntimeSignal {
        signal: Box<NormalizedRuntimeSignal>,
    },
    RawNotification {
        provider: String,
        method: String,
        #[serde(default)]
        params: serde_json::Value,
    },
    RawServerRequest {
        provider: String,
        id: String,
        method: String,
        #[serde(default)]
        params: serde_json::Value,
    },
    StderrLine {
        provider: String,
        line: String,
    },
    Exited {
        provider: String,
    },
}

impl ProviderRuntimeEvent {
    #[must_use]
    pub fn tool(tool: SemanticToolCall) -> Self {
        match tool.display.status {
            ace_runtime::tools::ToolRunStatus::Started => Self::ToolStarted {
                tool: Box::new(tool),
            },
            ace_runtime::tools::ToolRunStatus::Updated => Self::ToolUpdated {
                tool: Box::new(tool),
            },
            ace_runtime::tools::ToolRunStatus::Completed => Self::ToolCompleted {
                tool: Box::new(tool),
            },
            ace_runtime::tools::ToolRunStatus::Failed => Self::ToolFailed {
                tool: Box::new(tool),
                message: "tool failed".to_string(),
            },
            ace_runtime::tools::ToolRunStatus::ApprovalRequested => Self::ToolApprovalRequested {
                tool: Box::new(tool),
            },
        }
    }

    #[must_use]
    pub fn from_provider_event(provider: &str, event: ProviderEvent) -> Self {
        match event {
            ProviderEvent::SemanticTool { tool } => Self::tool(*tool),
            ProviderEvent::ThreadItem { item } => Self::ThreadItem { item },
            ProviderEvent::ServerRequest { request } => Self::ServerRequest { request },
            ProviderEvent::ServerRequestResolved {
                request_id,
                decision,
                request,
            } => Self::ServerRequestResolved {
                provider: provider.to_string(),
                request_id,
                decision: ProviderServerRequestDecisionRecord {
                    outcome: decision.outcome,
                    payload: decision.payload,
                    audit: decision.audit,
                },
                request,
            },
            ProviderEvent::RuntimeSignal { signal } => Self::RuntimeSignal { signal },
            ProviderEvent::RawNotification { method, params } => Self::RawNotification {
                provider: provider.to_string(),
                method,
                params,
            },
            ProviderEvent::RawServerRequest { id, method, params } => Self::RawServerRequest {
                provider: provider.to_string(),
                id,
                method,
                params,
            },
            ProviderEvent::StderrLine { line } => Self::StderrLine {
                provider: provider.to_string(),
                line,
            },
            ProviderEvent::Exited => Self::Exited {
                provider: provider.to_string(),
            },
        }
    }

    #[must_use]
    pub fn status(&self) -> Option<ToolRunStatus> {
        match self {
            Self::ToolStarted { tool }
            | Self::ToolUpdated { tool }
            | Self::ToolOutputDelta { tool, .. }
            | Self::ToolCompleted { tool }
            | Self::ToolFailed { tool, .. }
            | Self::ToolApprovalRequested { tool } => Some(tool.display.status),
            Self::ThreadItem { .. }
            | Self::ServerRequest { .. }
            | Self::ServerRequestResolved { .. }
            | Self::RuntimeSignal { .. } => None,
            Self::RawNotification { .. }
            | Self::RawServerRequest { .. }
            | Self::StderrLine { .. }
            | Self::Exited { .. } => None,
        }
    }

    #[must_use]
    pub fn projection_deltas(&self) -> Vec<ProviderRuntimeProjectionDelta> {
        match self {
            Self::ToolStarted { tool }
            | Self::ToolUpdated { tool }
            | Self::ToolOutputDelta { tool, .. }
            | Self::ToolCompleted { tool }
            | Self::ToolFailed { tool, .. }
            | Self::ToolApprovalRequested { tool } => {
                vec![ProviderRuntimeProjectionDelta::ToolTimelineUpsert { tool: tool.clone() }]
            }
            Self::ThreadItem { item } => {
                let mut deltas =
                    vec![ProviderRuntimeProjectionDelta::ThreadItemUpsert { item: item.clone() }];
                if item.kind == ThreadItemKind::Plan {
                    deltas.push(ProviderRuntimeProjectionDelta::PlanUpdated {
                        provider: item.provider.provider.clone(),
                        thread_id: item.thread_id.clone(),
                        turn_id: item.turn_id.clone(),
                        item_id: item.item_id.clone(),
                        status: item.status,
                        text: item.text.clone(),
                    });
                }
                if matches!(
                    item.kind,
                    ThreadItemKind::SubAgentActivity | ThreadItemKind::CollabAgentToolCall
                ) && let (Some(parent_thread_id), Some(child_thread_id)) = (
                    item.parent_thread_id
                        .as_deref()
                        .or(item.thread_id.as_deref()),
                    item.child_thread_id.as_deref(),
                ) {
                    deltas.push(ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                        provider: item.provider.provider.clone(),
                        parent_thread_id: parent_thread_id.to_string(),
                        child_thread_id: child_thread_id.to_string(),
                        item_id: item.item_id.clone(),
                        role: item.role.clone(),
                        nickname: item.sender.clone(),
                        status: item.status,
                    });
                }
                match item.kind {
                    ThreadItemKind::EnteredReviewMode | ThreadItemKind::ExitedReviewMode => {
                        if let Some(thread_id) = item.thread_id.as_deref() {
                            deltas.push(ProviderRuntimeProjectionDelta::ReviewModeChanged {
                                provider: item.provider.provider.clone(),
                                thread_id: thread_id.to_string(),
                                active: item.kind == ThreadItemKind::EnteredReviewMode,
                                item_id: item.item_id.clone(),
                            });
                        }
                    }
                    ThreadItemKind::FileChange => {
                        deltas.push(ProviderRuntimeProjectionDelta::DiffUpdated {
                            provider: item.provider.provider.clone(),
                            thread_id: item.thread_id.clone(),
                            turn_id: item.turn_id.clone(),
                            item_id: item.item_id.clone(),
                            status: item.status,
                            diff: string_at(&item.metadata, &["diff"])
                                .or_else(|| item.text.clone()),
                            files: item
                                .metadata
                                .get("files")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        });
                    }
                    ThreadItemKind::CommandExecution => {
                        if let Some(text) = item.text.clone().filter(|text| !text.is_empty()) {
                            deltas.push(ProviderRuntimeProjectionDelta::TerminalOutputAppended {
                                provider: item.provider.provider.clone(),
                                thread_id: item.thread_id.clone(),
                                turn_id: item.turn_id.clone(),
                                item_id: item.item_id.clone(),
                                text,
                            });
                        }
                    }
                    _ => {}
                }
                deltas
            }
            Self::ServerRequest { request } => {
                vec![ProviderRuntimeProjectionDelta::ApprovalUpsert {
                    request: request.clone(),
                }]
            }
            Self::ServerRequestResolved {
                provider,
                request_id,
                decision,
                request,
            } => {
                vec![ProviderRuntimeProjectionDelta::ApprovalResolved {
                    provider: provider.clone(),
                    request_id: request_id.clone(),
                    decision: decision.clone(),
                    request: request.clone(),
                }]
            }
            Self::RuntimeSignal { signal } => projection_deltas_for_runtime_signal(signal),
            Self::RawNotification {
                provider,
                method,
                params,
            } => {
                let mut deltas = vec![ProviderRuntimeProjectionDelta::RawNotificationObserved {
                    provider: provider.clone(),
                    method: method.clone(),
                }];
                if let Some(active) = active_turn_for_method(method) {
                    deltas.push(ProviderRuntimeProjectionDelta::ActiveTurnChanged {
                        provider: provider.clone(),
                        thread_id: nested_string_at(
                            params,
                            &["threadId", "thread_id"],
                            "/thread",
                            &["id", "threadId", "thread_id"],
                        ),
                        turn_id: nested_string_at(
                            params,
                            &["turnId", "turn_id"],
                            "/turn",
                            &["id", "turnId", "turn_id"],
                        ),
                        active,
                    });
                }
                deltas
            }
            Self::RawServerRequest {
                provider, method, ..
            } => {
                vec![ProviderRuntimeProjectionDelta::RawNotificationObserved {
                    provider: provider.clone(),
                    method: method.clone(),
                }]
            }
            Self::StderrLine { provider, line } => {
                vec![ProviderRuntimeProjectionDelta::StderrAppended {
                    provider: provider.clone(),
                    line: line.clone(),
                }]
            }
            Self::Exited { provider } => {
                vec![ProviderRuntimeProjectionDelta::ProviderExited {
                    provider: provider.clone(),
                }]
            }
        }
    }
}

#[must_use]
pub fn projection_deltas_for_events(
    events: &[ProviderRuntimeEvent],
) -> Vec<ProviderRuntimeProjectionDelta> {
    events
        .iter()
        .flat_map(ProviderRuntimeEvent::projection_deltas)
        .collect()
}

fn projection_deltas_for_runtime_signal(
    signal: &NormalizedRuntimeSignal,
) -> Vec<ProviderRuntimeProjectionDelta> {
    match signal.kind {
        RuntimeSignalKind::Warning => signal
            .message
            .as_ref()
            .map(|message| {
                vec![ProviderRuntimeProjectionDelta::WarningRaised {
                    provider: signal.provider.provider.clone(),
                    thread_id: signal.thread_id.clone(),
                    turn_id: signal.turn_id.clone(),
                    message: message.clone(),
                    metadata: signal.metadata.clone(),
                }]
            })
            .unwrap_or_default(),
        RuntimeSignalKind::ModelRerouted => {
            vec![ProviderRuntimeProjectionDelta::ModelRerouted {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                turn_id: signal.turn_id.clone(),
                from_model: signal.from_model.clone(),
                to_model: signal.to_model.clone(),
                reason: signal.reason.clone(),
            }]
        }
        RuntimeSignalKind::RealtimeTranscriptDelta => signal
            .text
            .as_ref()
            .map(|text| {
                vec![ProviderRuntimeProjectionDelta::RealtimeTranscriptDelta {
                    provider: signal.provider.provider.clone(),
                    thread_id: signal.thread_id.clone(),
                    turn_id: signal.turn_id.clone(),
                    text: text.clone(),
                }]
            })
            .unwrap_or_default(),
        RuntimeSignalKind::RealtimeAudioDelta => signal
            .audio
            .as_ref()
            .map(|audio| {
                vec![ProviderRuntimeProjectionDelta::RealtimeAudioDelta {
                    provider: signal.provider.provider.clone(),
                    thread_id: signal.thread_id.clone(),
                    turn_id: signal.turn_id.clone(),
                    audio: audio.clone(),
                }]
            })
            .unwrap_or_default(),
    }
}

fn active_turn_for_method(method: &str) -> Option<bool> {
    match method {
        "turn/started" | "turn/startedStreaming" => Some(true),
        "turn/completed" | "turn/failed" | "turn/interrupted" | "turn/cancelled" => Some(false),
        _ => None,
    }
}

fn string_at(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(ToString::to_string)
}

fn nested_string_at(
    value: &serde_json::Value,
    keys: &[&str],
    nested_pointer: &str,
    nested_keys: &[&str],
) -> Option<String> {
    string_at(value, keys).or_else(|| {
        value
            .pointer(nested_pointer)
            .and_then(|nested| string_at(nested, nested_keys))
    })
}

#[cfg(test)]
mod tests {
    use ace_runtime::provider::{
        NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedServerRequestDecision,
        NormalizedThreadItem, ProviderAdapterOperation, ProviderAdapterOperationSupport,
        ProviderFeatureCategory, ProviderMetadata, RuntimeSignalKind, ServerRequestKind,
        ThreadItemKind, ThreadItemStatus,
    };
    use ace_runtime::tools::{
        ProviderToolMetadata, ToolNormalizationInput, ToolRunStatus, ToolTransport,
        normalize_tool_call,
    };
    use serde_json::json;

    use super::*;

    #[test]
    fn provider_runtime_request_accepts_method_or_adapter_operation() {
        let by_method = serde_json::from_value::<ProviderRuntimeRequest>(json!({
            "provider": "codex",
            "method": "thread/read",
            "params": { "threadId": "thread-1" }
        }))
        .expect("method request");
        assert_eq!(by_method.method.as_deref(), Some("thread/read"));
        assert_eq!(by_method.operation, None);

        let by_operation = serde_json::from_value::<ProviderRuntimeRequest>(json!({
            "provider": "codex",
            "operation": "thread_read",
            "params": { "threadId": "thread-1" }
        }))
        .expect("operation request");
        assert_eq!(by_operation.method, None);
        assert_eq!(
            by_operation.operation,
            Some(ProviderAdapterOperation::ThreadRead)
        );
    }

    #[test]
    fn provider_runtime_operation_classifies_invocation_paths() {
        let contract = ace_runtime::provider::ace_provider_adapter_contract();
        let operation = |target| {
            contract
                .operations
                .iter()
                .find(|operation| operation.operation == target)
                .map(ProviderRuntimeProviderOperation::from_spec)
                .expect("operation")
        };

        let direct = operation(ProviderAdapterOperation::ThreadRead);
        assert_eq!(
            direct.invocation,
            ProviderAdapterInvocationKind::DirectProviderMethod
        );
        assert!(direct.direct_invocation);
        assert_eq!(direct.provider_methods, ["thread/read"]);

        let composite = operation(ProviderAdapterOperation::PlanForkForImplementation);
        assert_eq!(
            composite.invocation,
            ProviderAdapterInvocationKind::CompositeTypedApi
        );
        assert!(!composite.direct_invocation);
        assert_eq!(composite.category, ProviderFeatureCategory::Plans);

        let event_stream = operation(ProviderAdapterOperation::ProviderEvents);
        assert_eq!(
            event_stream.invocation,
            ProviderAdapterInvocationKind::EventStream
        );
        assert!(!event_stream.direct_invocation);

        let deferred = operation(ProviderAdapterOperation::CloudHandoff);
        assert_eq!(deferred.invocation, ProviderAdapterInvocationKind::Deferred);
        assert_eq!(deferred.support, ProviderAdapterOperationSupport::Deferred);
    }

    #[test]
    fn server_request_response_ids_accept_numbers_and_strings() {
        let numeric = serde_json::from_value::<ProviderServerRequestResult>(json!({
            "provider": "codex",
            "request_id": 42,
            "result": { "approved": true }
        }))
        .expect("numeric request id");
        assert_eq!(numeric.request_id, "42");

        let string = serde_json::from_value::<ProviderServerRequestError>(json!({
            "provider": "custom",
            "request_id": "request-alpha",
            "error": { "code": -32000, "message": "denied" }
        }))
        .expect("string request id");
        assert_eq!(string.request_id, "request-alpha");
    }

    #[test]
    fn provider_runtime_event_uses_semantic_tool_shape() {
        let mut provider = ProviderToolMetadata::new();
        provider.tool_name = Some("ace_browser".to_string());
        provider.operation = Some("cua_click".to_string());
        provider.raw_args = json!({ "operation": "cua_click", "label": "Run" });
        let tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Mcp,
            status: ToolRunStatus::Completed,
            provider,
            item_type: Some("mcpToolCall".to_string()),
        });

        let event = ProviderRuntimeEvent::tool(tool);
        let encoded = serde_json::to_value(event).expect("encode");
        assert_eq!(encoded["type"], "tool_completed");
        assert_eq!(encoded["tool"]["surface"], "browser");
        assert_eq!(encoded["tool"]["action"], "browser.click");
        assert_eq!(
            encoded["tool"]["display"]["title"],
            "Clicked Run in Browser"
        );
    }

    #[test]
    fn provider_runtime_event_uses_normalized_thread_item_shape() {
        let event = ProviderRuntimeEvent::from_provider_event(
            "codex",
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
                    title: Some("Plan".to_string()),
                    text: Some("Inspect first".to_string()),
                    metadata: json!({ "phase": "planning" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("item/plan/delta".to_string()),
                        schema_version: Some("1".to_string()),
                        raw_payload: json!({ "delta": "Inspect first" }),
                    },
                }),
            },
        );
        let encoded = serde_json::to_value(event).expect("encode");
        assert_eq!(encoded["type"], "thread_item");
        assert_eq!(encoded["item"]["kind"], "plan");
        assert_eq!(encoded["item"]["status"], "updated");
        assert_eq!(encoded["item"]["text"], "Inspect first");
        assert_eq!(encoded["item"]["provider"]["method"], "item/plan/delta");
        assert_eq!(
            encoded["item"]["provider"]["raw_payload"]["delta"],
            "Inspect first"
        );
    }

    #[test]
    fn provider_runtime_event_uses_normalized_server_request_shape() {
        let event = ProviderRuntimeEvent::from_provider_event(
            "codex",
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
        );
        let encoded = serde_json::to_value(event).expect("encode");
        assert_eq!(encoded["type"], "server_request");
        assert_eq!(encoded["request"]["kind"], "command_approval");
        assert_eq!(encoded["request"]["request_id"], "42");
        assert_eq!(encoded["request"]["scope"], "command");
        assert_eq!(encoded["request"]["prompt"], "Run tests?");
        assert_eq!(encoded["request"]["metadata"]["command"], "cargo test");
        assert_eq!(
            encoded["request"]["provider"]["raw_payload"]["command"],
            "cargo test"
        );
    }

    #[test]
    fn provider_runtime_event_projects_server_request_resolution() {
        let request = NormalizedServerRequest {
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
        };
        let event = ProviderRuntimeEvent::from_provider_event(
            "codex",
            ProviderEvent::ServerRequestResolved {
                request_id: "42".to_string(),
                decision: NormalizedServerRequestDecision {
                    outcome: "result".to_string(),
                    payload: json!({ "approved": true }),
                    audit: json!({
                        "scope": "command",
                        "source_thread_id": "thread-1",
                        "decided_by": "user"
                    }),
                },
                request: Some(Box::new(request)),
            },
        );
        let encoded = serde_json::to_value(&event).expect("encode event");
        assert_eq!(encoded["type"], "server_request_resolved");
        assert_eq!(encoded["provider"], "codex");
        assert_eq!(encoded["request_id"], "42");
        assert_eq!(encoded["decision"]["outcome"], "result");
        assert_eq!(encoded["decision"]["payload"]["approved"], true);
        assert_eq!(encoded["request"]["prompt"], "Run tests?");

        let deltas = event.projection_deltas();
        let encoded_delta = serde_json::to_value(&deltas[0]).expect("encode delta");
        assert_eq!(encoded_delta["type"], "approval_resolved");
        assert_eq!(encoded_delta["provider"], "codex");
        assert_eq!(encoded_delta["request_id"], "42");
        assert_eq!(
            encoded_delta["decision"]["audit"]["source_thread_id"],
            "thread-1"
        );
        assert_eq!(
            encoded_delta["request"]["metadata"]["command"],
            "cargo test"
        );
    }

    #[test]
    fn provider_runtime_events_project_plan_tool_approval_and_turn_state() {
        let plan = ProviderRuntimeEvent::from_provider_event(
            "codex",
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
                    title: Some("Plan".to_string()),
                    text: Some("Implement adapter".to_string()),
                    metadata: json!({}),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("item/plan/delta".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
        );
        let started = ProviderRuntimeEvent::RawNotification {
            provider: "codex".to_string(),
            method: "turn/started".to_string(),
            params: json!({
                "thread": { "id": "thread-1" },
                "turn": { "id": "turn-1" }
            }),
        };
        let deltas = projection_deltas_for_events(&[plan, started]);

        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ThreadItemUpsert { item }
                if item.kind == ThreadItemKind::Plan
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::PlanUpdated {
                thread_id,
                turn_id,
                item_id,
                text,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && item_id.as_deref() == Some("plan-1")
                && text.as_deref() == Some("Implement adapter")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ActiveTurnChanged {
                thread_id,
                turn_id,
                active: true,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
        )));
    }

    #[test]
    fn provider_runtime_events_project_child_review_diff_and_terminal_state() {
        let events = vec![
            thread_item_event(NormalizedThreadItem {
                kind: ThreadItemKind::SubAgentActivity,
                status: ThreadItemStatus::Started,
                thread_id: Some("parent-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("subagent-item-1".to_string()),
                parent_thread_id: Some("parent-1".to_string()),
                child_thread_id: Some("child-1".to_string()),
                sender: Some("Reviewer".to_string()),
                role: Some("reviewer".to_string()),
                title: Some("Reviewer started".to_string()),
                text: None,
                metadata: json!({}),
                provider: provider_metadata("item/subAgentActivity/delta"),
            }),
            thread_item_event(NormalizedThreadItem {
                kind: ThreadItemKind::EnteredReviewMode,
                status: ThreadItemStatus::Completed,
                thread_id: Some("parent-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("review-1".to_string()),
                parent_thread_id: None,
                child_thread_id: None,
                sender: None,
                role: None,
                title: Some("Entered review mode".to_string()),
                text: None,
                metadata: json!({}),
                provider: provider_metadata("item/completed"),
            }),
            thread_item_event(NormalizedThreadItem {
                kind: ThreadItemKind::FileChange,
                status: ThreadItemStatus::Updated,
                thread_id: Some("parent-1".to_string()),
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
                provider: provider_metadata("item/fileChange/patchUpdated"),
            }),
            thread_item_event(NormalizedThreadItem {
                kind: ThreadItemKind::CommandExecution,
                status: ThreadItemStatus::Updated,
                thread_id: Some("parent-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("cmd-1".to_string()),
                parent_thread_id: None,
                child_thread_id: None,
                sender: None,
                role: None,
                title: Some("cargo test".to_string()),
                text: Some("running 1 test\n".to_string()),
                metadata: json!({ "command": "cargo test" }),
                provider: provider_metadata("item/commandExecution/outputDelta"),
            }),
        ];

        let deltas = projection_deltas_for_events(&events);

        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                parent_thread_id,
                child_thread_id,
                role,
                nickname,
                ..
            } if parent_thread_id == "parent-1"
                && child_thread_id == "child-1"
                && role.as_deref() == Some("reviewer")
                && nickname.as_deref() == Some("Reviewer")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ReviewModeChanged {
                thread_id,
                active: true,
                item_id,
                ..
            } if thread_id == "parent-1" && item_id.as_deref() == Some("review-1")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::DiffUpdated {
                item_id,
                diff,
                files,
                ..
            } if item_id.as_deref() == Some("file-1")
                && diff.as_deref() == Some("@@ -1 +1 @@")
                && files == &json!(["src/main.rs"])
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::TerminalOutputAppended {
                item_id,
                text,
                ..
            } if item_id.as_deref() == Some("cmd-1") && text == "running 1 test\n"
        )));
    }

    #[test]
    fn provider_runtime_events_project_runtime_warning_reroute_and_realtime_state() {
        let events = [
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::Warning,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    message: Some("Context is almost full".to_string()),
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    metadata: json!({ "severity": "warning" }),
                    provider: provider_metadata("warning"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ModelRerouted,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    message: None,
                    from_model: Some("gpt-5".to_string()),
                    to_model: Some("gpt-5-mini".to_string()),
                    reason: Some("capacity".to_string()),
                    text: None,
                    audio: None,
                    metadata: json!({}),
                    provider: provider_metadata("model/rerouted"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::RealtimeTranscriptDelta,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: Some("hello".to_string()),
                    audio: None,
                    metadata: json!({}),
                    provider: provider_metadata("realtime/transcriptDelta"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::RealtimeAudioDelta,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: Some("AAAA".to_string()),
                    metadata: json!({}),
                    provider: provider_metadata("realtime/audioDelta"),
                }),
            },
        ];
        let deltas = projection_deltas_for_events(&events);

        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::WarningRaised {
                thread_id,
                turn_id,
                message,
                metadata,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && message == "Context is almost full"
                && metadata["severity"] == "warning"
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ModelRerouted {
                thread_id,
                turn_id,
                from_model,
                to_model,
                reason,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && from_model.as_deref() == Some("gpt-5")
                && to_model.as_deref() == Some("gpt-5-mini")
                && reason.as_deref() == Some("capacity")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::RealtimeTranscriptDelta {
                thread_id,
                turn_id,
                text,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && text == "hello"
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::RealtimeAudioDelta {
                thread_id,
                turn_id,
                audio,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && audio == "AAAA"
        )));
        assert!(deltas.iter().all(|delta| !matches!(
            delta,
            ProviderRuntimeProjectionDelta::RawNotificationObserved { .. }
        )));
    }

    fn thread_item_event(item: NormalizedThreadItem) -> ProviderRuntimeEvent {
        ProviderRuntimeEvent::from_provider_event(
            "codex",
            ProviderEvent::ThreadItem {
                item: Box::new(item),
            },
        )
    }

    fn provider_metadata(method: &str) -> ProviderMetadata {
        ProviderMetadata {
            provider: "codex".to_string(),
            method: Some(method.to_string()),
            schema_version: None,
            raw_payload: json!({}),
        }
    }
}
