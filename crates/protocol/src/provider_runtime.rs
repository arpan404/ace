use ace_core::ProviderKind;
use ace_runtime::{
    host_tools::HostToolDescriptor,
    provider::{
        NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedThreadItem,
        ProviderAdapterContract, ProviderAdapterInvocationKind, ProviderAdapterOperation,
        ProviderAdapterOperationAvailability, ProviderAdapterOperationGate,
        ProviderAdapterOperationPolicy, ProviderAdapterOperationProfile,
        ProviderAdapterOperationSpec, ProviderAdapterOperationSupport, ProviderAdapterProfile,
        ProviderAdapterRuntimeHook, ProviderAdapterRuntimeReport, ProviderContractReport,
        ProviderDescriptor, ProviderDriverStatus, ProviderEvent, ProviderFeature,
        ProviderFeatureCategory, ProviderLifecycleAction, ProviderLifecycleResult,
        RuntimeSignalKind, ServerRequestKind, ThreadItemKind, ThreadItemStatus,
    },
    threads::{
        AgentRuntimeSnapshot, ApprovalRetryRecord, ForkPoint, GoalState, GoalStatus, HandoffPlan,
        PlanImplementationRecord, SideChat,
    },
    tools::{SemanticToolCall, ToolRunStatus},
};
use serde::{Deserialize, Deserializer, Serialize};

pub const PROVIDER_RUNTIME_EVENT_TOPIC: &str = "provider_runtime.event";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeSubscribeRequest {
    pub provider: Option<String>,
    #[serde(default = "default_raw_event_mode")]
    pub raw_event_mode: ProviderRuntimeRawEventMode,
}

fn default_recent_events_limit() -> usize {
    100
}

fn default_raw_event_mode() -> ProviderRuntimeRawEventMode {
    ProviderRuntimeRawEventMode::Compact
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeRawEventMode {
    #[default]
    Compact,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeRecentEventsRequest {
    pub provider: Option<String>,
    #[serde(default = "default_recent_events_limit")]
    pub limit: usize,
    #[serde(default = "default_raw_event_mode")]
    pub raw_event_mode: ProviderRuntimeRawEventMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeRawEventSummary {
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub raw_json_bytes: usize,
}

impl ProviderRuntimeRawEventSummary {
    #[must_use]
    pub fn from_event(event: &ProviderEvent) -> Self {
        let raw_json_bytes = serde_json::to_vec(event).map_or(0, |bytes| bytes.len());
        match event {
            ProviderEvent::RawNotification { method, .. } => Self {
                event_type: "raw_notification".to_string(),
                provider_method: Some(method.clone()),
                thread_id: None,
                turn_id: None,
                item_id: None,
                request_id: None,
                raw_json_bytes,
            },
            ProviderEvent::RawServerRequest { id, method, .. } => Self {
                event_type: "raw_server_request".to_string(),
                provider_method: Some(method.clone()),
                thread_id: None,
                turn_id: None,
                item_id: None,
                request_id: Some(id.clone()),
                raw_json_bytes,
            },
            ProviderEvent::SemanticTool { tool } => Self {
                event_type: "semantic_tool".to_string(),
                provider_method: tool.provider.method.clone(),
                thread_id: tool.provider.thread_id.clone(),
                turn_id: tool.provider.turn_id.clone(),
                item_id: tool.provider.item_id.clone(),
                request_id: None,
                raw_json_bytes,
            },
            ProviderEvent::ThreadItem { item } => Self {
                event_type: "thread_item".to_string(),
                provider_method: item.provider.method.clone(),
                thread_id: item.thread_id.clone(),
                turn_id: item.turn_id.clone(),
                item_id: item.item_id.clone(),
                request_id: None,
                raw_json_bytes,
            },
            ProviderEvent::ServerRequest { request } => Self {
                event_type: "server_request".to_string(),
                provider_method: Some(request.method.clone()),
                thread_id: request.thread_id.clone(),
                turn_id: request.turn_id.clone(),
                item_id: request.item_id.clone(),
                request_id: Some(request.request_id.clone()),
                raw_json_bytes,
            },
            ProviderEvent::ServerRequestResolved {
                request_id,
                request,
                ..
            } => Self {
                event_type: "server_request_resolved".to_string(),
                provider_method: request.as_ref().map(|request| request.method.clone()),
                thread_id: request
                    .as_ref()
                    .and_then(|request| request.thread_id.clone()),
                turn_id: request.as_ref().and_then(|request| request.turn_id.clone()),
                item_id: request.as_ref().and_then(|request| request.item_id.clone()),
                request_id: Some(request_id.clone()),
                raw_json_bytes,
            },
            ProviderEvent::RuntimeSignal { signal } => Self {
                event_type: "runtime_signal".to_string(),
                provider_method: signal.provider.method.clone(),
                thread_id: signal.thread_id.clone(),
                turn_id: signal.turn_id.clone(),
                item_id: signal.item_id.clone(),
                request_id: signal.request_id.clone(),
                raw_json_bytes,
            },
            ProviderEvent::StderrLine { .. } => Self {
                event_type: "stderr_line".to_string(),
                provider_method: None,
                thread_id: None,
                turn_id: None,
                item_id: None,
                request_id: None,
                raw_json_bytes,
            },
            ProviderEvent::Exited { .. } => Self {
                event_type: "exited".to_string(),
                provider_method: None,
                thread_id: None,
                turn_id: None,
                item_id: None,
                request_id: None,
                raw_json_bytes,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeEventRecord {
    pub sequence: i64,
    pub provider: String,
    pub created_at: String,
    pub event: ProviderRuntimeEvent,
    #[serde(default)]
    pub projection_deltas: Vec<ProviderRuntimeProjectionDelta>,
    pub raw_event_summary: ProviderRuntimeRawEventSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_event: Option<ProviderEvent>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeAdapterValidateRequest {
    pub descriptor: ProviderDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeAdapterValidateResponse {
    pub descriptor: ProviderDescriptor,
    pub contract: ProviderContractReport,
    pub adapter_profile: ProviderAdapterProfile,
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
    pub availability: ProviderAdapterOperationAvailability,
    pub policy: ProviderAdapterOperationPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_gate: Option<ProviderAdapterOperationGate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_gate_resolution: Option<ProviderRuntimeOperationGateResolution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub availability_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_method: Option<String>,
    #[serde(default)]
    pub provider_methods: Vec<String>,
    pub invocation: ProviderAdapterInvocationKind,
    pub direct_invocation: bool,
    #[serde(default)]
    pub required_runtime_hooks: Vec<ProviderAdapterRuntimeHook>,
    pub runtime_request: ProviderRuntimeOperationRequest,
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
            availability: profile.availability,
            policy: profile.policy,
            runtime_gate: profile.runtime_gate,
            runtime_gate_resolution: None,
            availability_reason: profile.availability_reason,
            canonical_method: profile.canonical_method,
            provider_methods: profile.provider_methods,
            direct_invocation: profile.direct_invocation,
            invocation: profile.invocation,
            required_runtime_hooks: profile.required_runtime_hooks,
            runtime_request: ProviderRuntimeOperationRequest::from_invocation(profile.invocation),
        }
    }

    #[must_use]
    pub fn with_runtime_request(
        mut self,
        runtime_request: ProviderRuntimeOperationRequest,
    ) -> Self {
        self.runtime_request = runtime_request;
        self
    }

    #[must_use]
    pub fn with_runtime_gate_resolution(
        mut self,
        resolution: Option<ProviderRuntimeOperationGateResolution>,
    ) -> Self {
        self.runtime_gate_resolution = resolution;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeOperationGateStatus {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeOperationGateResolution {
    pub status: ProviderRuntimeOperationGateStatus,
    #[serde(default)]
    pub provider_methods: Vec<String>,
    #[serde(default)]
    pub missing_provider_methods: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeOperationRequest {
    pub invokable: bool,
    pub mode: ProviderRuntimeOperationRequestMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<ProviderRuntimeOperationParams>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ProviderRuntimeOperationRequest {
    #[must_use]
    pub fn operation(params: ProviderRuntimeOperationParams) -> Self {
        Self {
            invokable: true,
            mode: ProviderRuntimeOperationRequestMode::AdapterOperation,
            params: Some(params),
            reason: None,
        }
    }

    #[must_use]
    pub fn provider_method(params: ProviderRuntimeOperationParams) -> Self {
        Self {
            invokable: true,
            mode: ProviderRuntimeOperationRequestMode::ProviderMethod,
            params: Some(params),
            reason: None,
        }
    }

    #[must_use]
    pub fn unavailable(
        mode: ProviderRuntimeOperationRequestMode,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            invokable: false,
            mode,
            params: None,
            reason: Some(reason.into()),
        }
    }

    #[must_use]
    pub fn from_invocation(invocation: ProviderAdapterInvocationKind) -> Self {
        match invocation {
            ProviderAdapterInvocationKind::DirectProviderMethod => {
                Self::provider_method(ProviderRuntimeOperationParams::ProviderNative)
            }
            ProviderAdapterInvocationKind::TypedApi => Self::unavailable(
                ProviderRuntimeOperationRequestMode::TypedApi,
                "use the provider typed API for this operation",
            ),
            ProviderAdapterInvocationKind::CompositeTypedApi => Self::unavailable(
                ProviderRuntimeOperationRequestMode::TypedApi,
                "use the provider typed API because this operation maps to multiple provider calls",
            ),
            ProviderAdapterInvocationKind::EventStream => Self::unavailable(
                ProviderRuntimeOperationRequestMode::EventStream,
                "subscribe to provider runtime events for this operation",
            ),
            ProviderAdapterInvocationKind::Deferred => Self::unavailable(
                ProviderRuntimeOperationRequestMode::Deferred,
                "this adapter operation is intentionally deferred",
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeOperationRequestMode {
    AdapterOperation,
    ProviderMethod,
    TypedApi,
    EventStream,
    Deferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeOperationParams {
    AdapterNormalized,
    ProviderNative,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderHostToolsListResponse {
    pub tools: Vec<HostToolDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderHostToolInvokeServerRequest {
    pub provider: String,
    #[serde(deserialize_with = "deserialize_server_request_id")]
    pub request_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ServerRequestKind>,
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
pub struct ProviderServerRequestDecisionResponse {
    pub responded: bool,
    pub provider: String,
    pub request_id: String,
    pub decision: ProviderServerRequestDecisionRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<Box<NormalizedServerRequest>>,
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
    #[serde(default)]
    pub raw_event_summaries: Vec<ProviderRuntimeRawEventSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_events: Option<Vec<ProviderEvent>>,
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
    ThreadItemDetailsUpdated {
        provider: String,
        kind: ThreadItemKind,
        status: ThreadItemStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status_text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        files: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_usage: Option<serde_json::Value>,
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
    GoalUpdated {
        provider: String,
        goal: GoalState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    GoalCleared {
        provider: String,
        thread_id: String,
    },
    ForkUpdated {
        provider: String,
        fork: ForkPoint,
    },
    SideChatUpdated {
        provider: String,
        side_chat: SideChat,
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
    ThreadLifecycleChanged {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        archived: Option<bool>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    ThreadSettingsUpdated {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        settings: serde_json::Value,
    },
    ThreadTokenUsageUpdated {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        token_usage: serde_json::Value,
    },
    TurnDiffUpdated {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        files: serde_json::Value,
    },
    ProcessExited {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        process_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    ServerRequestResolvedObserved {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    ProviderStateUpdated {
        provider: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    RealtimeSessionUpdated {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    TurnModerationUpdated {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        status: String,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    AutoApprovalReviewUpdated {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    SubagentActionRecorded {
        provider: String,
        parent_thread_id: String,
        subagent_thread_id: String,
        action: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    HandoffUpdated {
        provider: String,
        handoff: HandoffPlan,
    },
    PlanImplementationUpdated {
        provider: String,
        implementation: PlanImplementationRecord,
    },
    ApprovalRetryRecorded {
        provider: String,
        retry: ApprovalRetryRecord,
    },
    ActiveTurnChanged {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        active: bool,
    },
    ActiveTurnsCleared {
        provider: String,
    },
    StderrAppended {
        provider: String,
        line: String,
    },
    ProviderExited {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
    },
}

impl ProviderRuntimeEvent {
    #[must_use]
    pub fn tool(tool: SemanticToolCall) -> Self {
        match tool.display.status {
            ace_runtime::tools::ToolRunStatus::Started => Self::ToolStarted {
                tool: Box::new(tool),
            },
            ace_runtime::tools::ToolRunStatus::Updated => {
                if let Some(delta) = tool_output_delta_text(&tool) {
                    Self::ToolOutputDelta {
                        tool: Box::new(tool),
                        delta,
                    }
                } else {
                    Self::ToolUpdated {
                        tool: Box::new(tool),
                    }
                }
            }
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
            ProviderEvent::Exited { code } => Self::Exited {
                provider: provider.to_string(),
                code,
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
            | Self::ToolCompleted { tool }
            | Self::ToolFailed { tool, .. }
            | Self::ToolApprovalRequested { tool } => {
                vec![ProviderRuntimeProjectionDelta::ToolTimelineUpsert { tool: tool.clone() }]
            }
            Self::ToolOutputDelta { tool, delta } => {
                let mut deltas =
                    vec![ProviderRuntimeProjectionDelta::ToolTimelineUpsert { tool: tool.clone() }];
                match tool.surface {
                    ace_runtime::tools::ToolSurface::Terminal => {
                        deltas.push(ProviderRuntimeProjectionDelta::TerminalOutputAppended {
                            provider: tool
                                .provider
                                .provider
                                .clone()
                                .unwrap_or_else(|| "unknown".to_string()),
                            thread_id: tool.provider.thread_id.clone(),
                            turn_id: tool.provider.turn_id.clone(),
                            item_id: tool.provider.item_id.clone(),
                            text: delta.clone(),
                        });
                    }
                    ace_runtime::tools::ToolSurface::Filesystem => {
                        deltas.push(ProviderRuntimeProjectionDelta::DiffUpdated {
                            provider: tool
                                .provider
                                .provider
                                .clone()
                                .unwrap_or_else(|| "unknown".to_string()),
                            thread_id: tool.provider.thread_id.clone(),
                            turn_id: tool.provider.turn_id.clone(),
                            item_id: tool.provider.item_id.clone(),
                            status: ThreadItemStatus::Updated,
                            diff: Some(delta.clone()),
                            files: tool
                                .provider
                                .raw_args
                                .get("files")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        });
                    }
                    _ => {}
                }
                deltas
            }
            Self::ThreadItem { item } => {
                let mut deltas =
                    vec![ProviderRuntimeProjectionDelta::ThreadItemUpsert { item: item.clone() }];
                if thread_item_has_details(item) {
                    deltas.push(ProviderRuntimeProjectionDelta::ThreadItemDetailsUpdated {
                        provider: item.provider.provider.clone(),
                        kind: item.kind,
                        status: item.status,
                        thread_id: item.thread_id.clone(),
                        turn_id: item.turn_id.clone(),
                        item_id: item.item_id.clone(),
                        status_text: item.status_text.clone(),
                        model: item.model.clone(),
                        target: item.target.clone(),
                        url: item.url.clone(),
                        files: item.files.clone(),
                        diff: item.diff.clone(),
                        token_usage: item.token_usage.clone(),
                    });
                }
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
                            diff: item
                                .diff
                                .as_ref()
                                .and_then(|diff| diff.as_str().map(ToString::to_string))
                                .or_else(|| string_at(&item.metadata, &["diff"]))
                                .or_else(|| item.text.clone()),
                            files: item
                                .files
                                .clone()
                                .or_else(|| item.metadata.get("files").cloned())
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
                if method == "thread/goal/updated"
                    && let Some(goal) = goal_state_from_notification(params)
                {
                    deltas.push(ProviderRuntimeProjectionDelta::GoalUpdated {
                        provider: provider.clone(),
                        goal,
                        turn_id: string_at(params, &["turnId", "turn_id"]),
                    });
                }
                if method == "thread/goal/cleared"
                    && let Some(thread_id) = string_at(params, &["threadId", "thread_id"])
                {
                    deltas.push(ProviderRuntimeProjectionDelta::GoalCleared {
                        provider: provider.clone(),
                        thread_id,
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
            Self::Exited { provider, code } => vec![
                ProviderRuntimeProjectionDelta::ProviderExited {
                    provider: provider.clone(),
                    code: *code,
                },
                ProviderRuntimeProjectionDelta::ActiveTurnsCleared {
                    provider: provider.clone(),
                },
            ],
        }
    }
}

fn thread_item_has_details(item: &NormalizedThreadItem) -> bool {
    item.status_text.is_some()
        || item.model.is_some()
        || item.target.is_some()
        || item.url.is_some()
        || item.files.is_some()
        || item.diff.is_some()
        || item.token_usage.is_some()
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

fn tool_output_delta_text(tool: &SemanticToolCall) -> Option<String> {
    string_at(
        &tool.provider.raw_args,
        &["delta", "text", "output", "stdout", "stderr", "chunk"],
    )
    .or_else(|| {
        string_at(
            &tool.provider.raw_payload,
            &["delta", "text", "output", "stdout", "stderr", "chunk"],
        )
    })
    .or_else(|| {
        tool.provider.raw_payload.get("item").and_then(|item| {
            string_at(
                item,
                &["delta", "text", "output", "stdout", "stderr", "chunk"],
            )
        })
    })
    .filter(|delta| !delta.is_empty())
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
        RuntimeSignalKind::ThreadLifecycleChanged => {
            vec![ProviderRuntimeProjectionDelta::ThreadLifecycleChanged {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                status: signal.status.clone(),
                name: signal.name.clone(),
                active: signal.active,
                archived: signal.archived,
                metadata: signal.metadata.clone(),
            }]
        }
        RuntimeSignalKind::ThreadSettingsUpdated => {
            vec![ProviderRuntimeProjectionDelta::ThreadSettingsUpdated {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                settings: signal
                    .metadata
                    .get("settings")
                    .cloned()
                    .unwrap_or_else(|| signal.metadata.clone()),
            }]
        }
        RuntimeSignalKind::ThreadTokenUsageUpdated => {
            vec![ProviderRuntimeProjectionDelta::ThreadTokenUsageUpdated {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                token_usage: signal
                    .metadata
                    .get("tokenUsage")
                    .or_else(|| signal.metadata.get("token_usage"))
                    .cloned()
                    .unwrap_or_else(|| signal.metadata.clone()),
            }]
        }
        RuntimeSignalKind::TurnDiffUpdated => {
            vec![ProviderRuntimeProjectionDelta::TurnDiffUpdated {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                turn_id: signal.turn_id.clone(),
                diff: signal.diff.clone(),
                files: signal.files.clone().unwrap_or(serde_json::Value::Null),
            }]
        }
        RuntimeSignalKind::ProcessExited => {
            vec![ProviderRuntimeProjectionDelta::ProcessExited {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                turn_id: signal.turn_id.clone(),
                process_id: signal.process_id.clone(),
                exit_code: signal.exit_code,
                metadata: signal.metadata.clone(),
            }]
        }
        RuntimeSignalKind::ServerRequestResolved => {
            vec![
                ProviderRuntimeProjectionDelta::ServerRequestResolvedObserved {
                    provider: signal.provider.provider.clone(),
                    thread_id: signal.thread_id.clone(),
                    turn_id: signal.turn_id.clone(),
                    request_id: signal.request_id.clone(),
                    status: signal.status.clone(),
                    metadata: signal.metadata.clone(),
                },
            ]
        }
        RuntimeSignalKind::ProviderStateUpdated => {
            vec![ProviderRuntimeProjectionDelta::ProviderStateUpdated {
                provider: signal.provider.provider.clone(),
                status: signal
                    .status
                    .clone()
                    .unwrap_or_else(|| "provider_state_updated".to_string()),
                message: signal.message.clone(),
                name: signal.name.clone(),
                metadata: signal.metadata.clone(),
            }]
        }
        RuntimeSignalKind::TurnLifecycleChanged => {
            let active = signal.active.or_else(|| {
                signal
                    .status
                    .as_deref()
                    .and_then(active_turn_for_signal_status)
            });
            active
                .map(|active| {
                    vec![ProviderRuntimeProjectionDelta::ActiveTurnChanged {
                        provider: signal.provider.provider.clone(),
                        thread_id: signal.thread_id.clone(),
                        turn_id: signal.turn_id.clone(),
                        active,
                    }]
                })
                .unwrap_or_default()
        }
        RuntimeSignalKind::RealtimeSessionUpdated => {
            vec![ProviderRuntimeProjectionDelta::RealtimeSessionUpdated {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                turn_id: signal.turn_id.clone(),
                status: signal
                    .status
                    .clone()
                    .unwrap_or_else(|| "realtime_session_updated".to_string()),
                message: signal.message.clone(),
                metadata: signal.metadata.clone(),
            }]
        }
        RuntimeSignalKind::TurnModerationUpdated => {
            vec![ProviderRuntimeProjectionDelta::TurnModerationUpdated {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                turn_id: signal.turn_id.clone(),
                status: signal
                    .status
                    .clone()
                    .unwrap_or_else(|| "moderation_metadata_updated".to_string()),
                metadata: signal.metadata.clone(),
            }]
        }
        RuntimeSignalKind::AutoApprovalReviewUpdated => {
            vec![ProviderRuntimeProjectionDelta::AutoApprovalReviewUpdated {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                turn_id: signal.turn_id.clone(),
                item_id: signal.item_id.clone(),
                status: signal
                    .status
                    .clone()
                    .unwrap_or_else(|| "auto_approval_review_updated".to_string()),
                message: signal.message.clone(),
                metadata: signal.metadata.clone(),
            }]
        }
        RuntimeSignalKind::ReviewModeUpdated => {
            let Some(thread_id) = signal.thread_id.clone() else {
                return Vec::new();
            };
            let active = signal.active.or_else(|| {
                signal
                    .status
                    .as_deref()
                    .and_then(review_active_from_signal_status)
            });
            active
                .map(|active| {
                    vec![ProviderRuntimeProjectionDelta::ReviewModeChanged {
                        provider: signal.provider.provider.clone(),
                        thread_id,
                        active,
                        item_id: signal.item_id.clone(),
                    }]
                })
                .unwrap_or_default()
        }
        RuntimeSignalKind::SubagentAction => {
            let Some(parent_thread_id) = signal.thread_id.clone() else {
                return Vec::new();
            };
            let Some(subagent_thread_id) = signal
                .metadata
                .get("subagent_thread_id")
                .or_else(|| signal.metadata.get("subagentThreadId"))
                .and_then(serde_json::Value::as_str)
                .map(ToString::to_string)
            else {
                return Vec::new();
            };
            vec![ProviderRuntimeProjectionDelta::SubagentActionRecorded {
                provider: signal.provider.provider.clone(),
                parent_thread_id,
                subagent_thread_id,
                action: signal
                    .status
                    .clone()
                    .unwrap_or_else(|| "subagent_action".to_string()),
                prompt: signal.text.clone(),
                metadata: signal.metadata.clone(),
            }]
        }
        RuntimeSignalKind::HandoffUpdated => {
            let value = signal
                .metadata
                .get("handoff")
                .cloned()
                .unwrap_or_else(|| signal.metadata.clone());
            let Ok(handoff) = serde_json::from_value::<HandoffPlan>(value) else {
                return Vec::new();
            };
            vec![ProviderRuntimeProjectionDelta::HandoffUpdated {
                provider: signal.provider.provider.clone(),
                handoff,
            }]
        }
        RuntimeSignalKind::PlanImplementationUpdated => {
            let value = signal
                .metadata
                .get("plan_implementation")
                .cloned()
                .unwrap_or_else(|| signal.metadata.clone());
            let Ok(implementation) = serde_json::from_value::<PlanImplementationRecord>(value)
            else {
                return Vec::new();
            };
            vec![ProviderRuntimeProjectionDelta::PlanImplementationUpdated {
                provider: signal.provider.provider.clone(),
                implementation,
            }]
        }
        RuntimeSignalKind::ApprovalRetryRecorded => {
            let value = signal
                .metadata
                .get("approval_retry")
                .cloned()
                .unwrap_or_else(|| signal.metadata.clone());
            let Ok(retry) = serde_json::from_value::<ApprovalRetryRecord>(value) else {
                return Vec::new();
            };
            vec![ProviderRuntimeProjectionDelta::ApprovalRetryRecorded {
                provider: signal.provider.provider.clone(),
                retry,
            }]
        }
        RuntimeSignalKind::GoalUpdated => {
            let Some(goal) = goal_state_from_runtime_signal(signal) else {
                return Vec::new();
            };
            if goal.status == GoalStatus::Cleared {
                return vec![ProviderRuntimeProjectionDelta::GoalCleared {
                    provider: signal.provider.provider.clone(),
                    thread_id: goal.thread_id,
                }];
            }
            vec![ProviderRuntimeProjectionDelta::GoalUpdated {
                provider: signal.provider.provider.clone(),
                goal,
                turn_id: signal.turn_id.clone(),
            }]
        }
        RuntimeSignalKind::ForkUpdated => {
            let Some(fork) = fork_from_runtime_signal(signal) else {
                return Vec::new();
            };
            vec![
                ProviderRuntimeProjectionDelta::ForkUpdated {
                    provider: signal.provider.provider.clone(),
                    fork: fork.clone(),
                },
                ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                    provider: signal.provider.provider.clone(),
                    parent_thread_id: fork.parent_thread_id,
                    child_thread_id: fork.child_thread_id,
                    item_id: signal.item_id.clone(),
                    role: None,
                    nickname: None,
                    status: ThreadItemStatus::Completed,
                },
            ]
        }
        RuntimeSignalKind::SideChatUpdated => {
            let Some(side_chat) = side_chat_from_runtime_signal(signal) else {
                return Vec::new();
            };
            vec![
                ProviderRuntimeProjectionDelta::SideChatUpdated {
                    provider: signal.provider.provider.clone(),
                    side_chat: side_chat.clone(),
                },
                ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                    provider: signal.provider.provider.clone(),
                    parent_thread_id: side_chat.parent_thread_id,
                    child_thread_id: side_chat.thread_id,
                    item_id: signal.item_id.clone(),
                    role: Some("side_chat".to_string()),
                    nickname: None,
                    status: ThreadItemStatus::Completed,
                },
            ]
        }
    }
}

fn active_turn_for_method(method: &str) -> Option<bool> {
    match method {
        "turn/started" | "turn/startedStreaming" => Some(true),
        "turn/completed" | "turn/failed" | "turn/interrupted" | "turn/cancelled" => Some(false),
        _ => None,
    }
}

fn active_turn_for_signal_status(status: &str) -> Option<bool> {
    match status {
        "started" | "started_streaming" => Some(true),
        "completed" | "failed" | "interrupted" | "cancelled" => Some(false),
        _ => None,
    }
}

fn review_active_from_signal_status(status: &str) -> Option<bool> {
    match status {
        "entered" | "started" | "active" => Some(true),
        "exited" | "completed" | "inactive" => Some(false),
        _ => None,
    }
}

fn goal_state_from_notification(value: &serde_json::Value) -> Option<GoalState> {
    let goal = value.get("goal")?;
    let thread_id = string_at(goal, &["threadId", "thread_id"])
        .or_else(|| string_at(value, &["threadId", "thread_id"]))?;
    Some(GoalState {
        thread_id,
        status: goal_status(goal.get("status")?.as_str()?),
        objective: string_at(goal, &["objective"]),
        token_budget: u64_at(goal, &["tokenBudget", "token_budget"]),
        tokens_used: u64_at(goal, &["tokensUsed", "tokens_used"]),
        time_used_seconds: u64_at(goal, &["timeUsedSeconds", "time_used_seconds"]),
    })
}

fn goal_state_from_runtime_signal(signal: &NormalizedRuntimeSignal) -> Option<GoalState> {
    let value = signal
        .metadata
        .get("goal")
        .cloned()
        .unwrap_or_else(|| signal.metadata.clone());
    if let Ok(goal) = serde_json::from_value::<GoalState>(value.clone()) {
        return Some(goal);
    }
    goal_state_from_notification(&serde_json::json!({ "goal": value }))
        .or_else(|| goal_state_from_notification(&value))
}

fn fork_from_runtime_signal(signal: &NormalizedRuntimeSignal) -> Option<ForkPoint> {
    let value = signal
        .metadata
        .get("fork")
        .cloned()
        .unwrap_or_else(|| signal.metadata.clone());
    serde_json::from_value(value).ok()
}

fn side_chat_from_runtime_signal(signal: &NormalizedRuntimeSignal) -> Option<SideChat> {
    let value = signal
        .metadata
        .get("side_chat")
        .cloned()
        .or_else(|| signal.metadata.get("sideChat").cloned())
        .unwrap_or_else(|| signal.metadata.clone());
    serde_json::from_value(value).ok()
}

fn goal_status(status: &str) -> GoalStatus {
    match status {
        "paused" => GoalStatus::Paused,
        "blocked" => GoalStatus::Blocked,
        "usageLimited" | "usage_limited" => GoalStatus::UsageLimited,
        "budgetLimited" | "budget_limited" => GoalStatus::BudgetLimited,
        "complete" => GoalStatus::Complete,
        "cleared" => GoalStatus::Cleared,
        _ => GoalStatus::Active,
    }
}

fn string_at(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(ToString::to_string)
}

fn u64_at(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_u64))
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
        ProviderEvent, ProviderFeatureCategory, ProviderMetadata, RuntimeSignalKind,
        ServerRequestKind, ThreadItemKind, ThreadItemStatus,
    };
    use ace_runtime::threads::GoalStatus;
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
    fn provider_runtime_recent_events_use_compact_raw_payloads_by_default() {
        let request = serde_json::from_value::<ProviderRuntimeRecentEventsRequest>(json!({
            "provider": "codex"
        }))
        .expect("recent request");
        assert_eq!(request.raw_event_mode, ProviderRuntimeRawEventMode::Compact);
        let subscribe = serde_json::from_value::<ProviderRuntimeSubscribeRequest>(json!({
            "provider": "codex"
        }))
        .expect("subscribe request");
        assert_eq!(
            subscribe.raw_event_mode,
            ProviderRuntimeRawEventMode::Compact
        );

        let full_request = serde_json::from_value::<ProviderRuntimeRecentEventsRequest>(json!({
            "provider": "codex",
            "raw_event_mode": "full"
        }))
        .expect("recent full request");
        assert_eq!(
            full_request.raw_event_mode,
            ProviderRuntimeRawEventMode::Full
        );
        let full_subscribe = serde_json::from_value::<ProviderRuntimeSubscribeRequest>(json!({
            "provider": "codex",
            "raw_event_mode": "full"
        }))
        .expect("subscribe full request");
        assert_eq!(
            full_subscribe.raw_event_mode,
            ProviderRuntimeRawEventMode::Full
        );

        let event = ProviderEvent::RawNotification {
            method: "item/completed".to_string(),
            params: json!({ "threadId": "thread-1", "itemId": "item-1" }),
        };
        let summary = ProviderRuntimeRawEventSummary::from_event(&event);
        assert_eq!(summary.event_type, "raw_notification");
        assert_eq!(summary.provider_method.as_deref(), Some("item/completed"));
        assert!(summary.raw_json_bytes > 0);

        let compact_record = ProviderRuntimeEventRecord {
            sequence: 1,
            provider: "codex".to_string(),
            created_at: "2026-06-22T00:00:00Z".to_string(),
            event: ProviderRuntimeEvent::from_provider_event("codex", event.clone()),
            projection_deltas: Vec::new(),
            raw_event_summary: summary,
            raw_event: None,
        };
        let encoded = serde_json::to_value(&compact_record).expect("compact record");
        assert!(encoded.get("raw_event").is_none());
        assert_eq!(
            encoded["raw_event_summary"]["provider_method"],
            "item/completed"
        );

        let full_record = ProviderRuntimeEventRecord {
            raw_event: Some(event.clone()),
            ..compact_record
        };
        let encoded = serde_json::to_value(&full_record).expect("full record");
        assert_eq!(encoded["raw_event"]["type"], "raw_notification");

        let compact_batch = ProviderRuntimeEventBatch {
            provider: "codex".to_string(),
            events: vec![ProviderRuntimeEvent::from_provider_event(
                "codex",
                event.clone(),
            )],
            projection_deltas: Vec::new(),
            raw_event_summaries: vec![ProviderRuntimeRawEventSummary::from_event(&event)],
            raw_events: None,
        };
        let encoded = serde_json::to_value(&compact_batch).expect("compact batch");
        assert!(encoded.get("raw_events").is_none());
        assert_eq!(
            encoded["raw_event_summaries"][0]["provider_method"],
            "item/completed"
        );

        let full_batch = ProviderRuntimeEventBatch {
            raw_events: Some(vec![event]),
            ..compact_batch
        };
        let encoded = serde_json::to_value(&full_batch).expect("full batch");
        assert_eq!(encoded["raw_events"][0]["type"], "raw_notification");
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
        assert_eq!(
            direct.availability,
            ProviderAdapterOperationAvailability::Available
        );
        assert_eq!(direct.availability_reason, None);
        assert!(direct.direct_invocation);
        assert_eq!(direct.provider_methods, ["thread/read"]);
        assert!(direct.runtime_request.invokable);
        assert_eq!(
            direct.runtime_request.mode,
            ProviderRuntimeOperationRequestMode::ProviderMethod
        );
        assert_eq!(
            direct.runtime_request.params,
            Some(ProviderRuntimeOperationParams::ProviderNative)
        );
        assert!(direct.required_runtime_hooks.is_empty());

        let composite = operation(ProviderAdapterOperation::PlanForkForImplementation);
        assert_eq!(
            composite.invocation,
            ProviderAdapterInvocationKind::CompositeTypedApi
        );
        assert_eq!(
            composite.availability,
            ProviderAdapterOperationAvailability::Available
        );
        assert!(!composite.direct_invocation);
        assert_eq!(composite.category, ProviderFeatureCategory::Plans);
        assert!(!composite.runtime_request.invokable);
        assert_eq!(
            composite.runtime_request.mode,
            ProviderRuntimeOperationRequestMode::TypedApi
        );

        let event_stream = operation(ProviderAdapterOperation::ProviderEvents);
        assert_eq!(
            event_stream.invocation,
            ProviderAdapterInvocationKind::EventStream
        );
        assert_eq!(
            event_stream.availability,
            ProviderAdapterOperationAvailability::Available
        );
        assert!(!event_stream.direct_invocation);
        assert!(!event_stream.runtime_request.invokable);
        assert_eq!(
            event_stream.runtime_request.mode,
            ProviderRuntimeOperationRequestMode::EventStream
        );
        assert_eq!(
            event_stream.required_runtime_hooks,
            vec![ProviderAdapterRuntimeHook::EventSource]
        );

        let server_request = operation(ProviderAdapterOperation::ServerRequestRespond);
        assert_eq!(
            server_request.required_runtime_hooks,
            vec![ProviderAdapterRuntimeHook::ServerRequestResponder]
        );

        let version_gated = operation(ProviderAdapterOperation::CommandExec);
        assert_eq!(
            version_gated.availability,
            ProviderAdapterOperationAvailability::VersionGated
        );
        assert!(
            version_gated
                .availability_reason
                .as_deref()
                .expect("version gated reason")
                .contains("version-gated")
        );

        let deferred = operation(ProviderAdapterOperation::CloudHandoff);
        assert_eq!(deferred.invocation, ProviderAdapterInvocationKind::Deferred);
        assert_eq!(deferred.support, ProviderAdapterOperationSupport::Deferred);
        assert_eq!(
            deferred.availability,
            ProviderAdapterOperationAvailability::Deferred
        );
        assert!(
            deferred
                .availability_reason
                .as_deref()
                .expect("deferred reason")
                .contains("deferred")
        );
        assert!(!deferred.runtime_request.invokable);
        assert_eq!(
            deferred.runtime_request.mode,
            ProviderRuntimeOperationRequestMode::Deferred
        );
        assert!(deferred.required_runtime_hooks.is_empty());
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
    fn server_request_list_filters_accept_thread_scope_and_kind() {
        let request = serde_json::from_value::<ProviderServerRequestsListRequest>(json!({
            "provider": "codex",
            "status": "pending",
            "thread_id": "thread-2",
            "scope": "filesystem",
            "kind": "file_change_approval",
            "limit": 25
        }))
        .expect("list request");

        assert_eq!(request.provider.as_deref(), Some("codex"));
        assert_eq!(
            request.status,
            Some(ProviderServerRequestStatusFilter::Pending)
        );
        assert_eq!(request.thread_id.as_deref(), Some("thread-2"));
        assert_eq!(request.scope.as_deref(), Some("filesystem"));
        assert_eq!(request.kind, Some(ServerRequestKind::FileChangeApproval));
        assert_eq!(request.limit, 25);

        let encoded = serde_json::to_value(request).expect("encode request");
        assert_eq!(encoded["kind"], "file_change_approval");
        assert_eq!(encoded["thread_id"], "thread-2");
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
    fn provider_runtime_event_uses_tool_output_delta_for_terminal_streams() {
        let mut provider = ProviderToolMetadata::new();
        provider.provider = Some("codex".to_string());
        provider.method = Some("item/commandExecution/outputDelta".to_string());
        provider.thread_id = Some("thread-1".to_string());
        provider.turn_id = Some("turn-1".to_string());
        provider.item_id = Some("cmd-1".to_string());
        provider.tool_name = Some("shell".to_string());
        provider.operation = Some("process/outputDelta".to_string());
        provider.raw_args = json!({ "processId": "proc-1", "delta": "running tests\n" });
        let tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Process,
            status: ToolRunStatus::Updated,
            provider,
            item_type: Some("commandExecution".to_string()),
        });

        let event = ProviderRuntimeEvent::tool(tool);
        let encoded = serde_json::to_value(&event).expect("encode");
        assert_eq!(encoded["type"], "tool_output_delta");
        assert_eq!(encoded["delta"], "running tests\n");
        assert_eq!(
            encoded["tool"]["display"]["title"],
            "Reading terminal output from proc-1"
        );

        let deltas = event.projection_deltas();
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ToolTimelineUpsert { tool }
                if tool.provider.item_id.as_deref() == Some("cmd-1")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::TerminalOutputAppended {
                provider,
                thread_id,
                turn_id,
                item_id,
                text,
            } if provider == "codex"
                && thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && item_id.as_deref() == Some("cmd-1")
                && text == "running tests\n"
        )));
    }

    #[test]
    fn codex_output_delta_provider_event_becomes_runtime_tool_output_delta() {
        let events =
            ace_codex::normalize_codex_inbound_event(&ace_codex::CodexInboundEvent::Notification {
                method: "process/outputDelta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "cmd-1",
                    "item": {
                        "id": "cmd-1",
                        "type": "commandExecution",
                        "processId": "proc-1",
                        "delta": "cargo test output"
                    }
                }),
            });
        let tool_event = events
            .into_iter()
            .find(|event| matches!(event, ProviderEvent::SemanticTool { .. }))
            .expect("semantic tool event");
        let runtime_event = ProviderRuntimeEvent::from_provider_event("codex", tool_event);
        let encoded = serde_json::to_value(&runtime_event).expect("runtime event");
        assert_eq!(encoded["type"], "tool_output_delta");
        assert_eq!(encoded["delta"], "cargo test output");
        assert_eq!(encoded["tool"]["surface"], "terminal");

        assert!(
            runtime_event
                .projection_deltas()
                .iter()
                .any(|delta| matches!(
                    delta,
                    ProviderRuntimeProjectionDelta::TerminalOutputAppended {
                        item_id,
                        text,
                        ..
                    } if item_id.as_deref() == Some("cmd-1") && text == "cargo test output"
                ))
        );
    }

    #[test]
    fn provider_runtime_event_projects_file_tool_output_delta_as_diff_update() {
        let mut provider = ProviderToolMetadata::new();
        provider.provider = Some("codex".to_string());
        provider.method = Some("item/fileChange/patchUpdated".to_string());
        provider.thread_id = Some("thread-1".to_string());
        provider.turn_id = Some("turn-1".to_string());
        provider.item_id = Some("file-1".to_string());
        provider.tool_name = Some("apply_patch".to_string());
        provider.operation = Some("apply_patch".to_string());
        provider.raw_args = json!({
            "delta": "@@ -1 +1 @@\n-old\n+new\n",
            "files": ["src/lib.rs"]
        });
        let tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Filesystem,
            status: ToolRunStatus::Updated,
            provider,
            item_type: Some("fileChange".to_string()),
        });

        let event = ProviderRuntimeEvent::tool(tool);
        let encoded = serde_json::to_value(&event).expect("encode");
        assert_eq!(encoded["type"], "tool_output_delta");
        assert_eq!(encoded["delta"], "@@ -1 +1 @@\n-old\n+new\n");

        let deltas = event.projection_deltas();
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::DiffUpdated {
                provider,
                item_id,
                diff,
                files,
                ..
            } if provider == "codex"
                && item_id.as_deref() == Some("file-1")
                && diff.as_deref() == Some("@@ -1 +1 @@\n-old\n+new\n")
                && files == &json!(["src/lib.rs"])
        )));
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
                    status_text: None,
                    model: None,
                    target: None,
                    url: None,
                    files: None,
                    diff: None,
                    token_usage: None,
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
                    status_text: None,
                    model: None,
                    target: None,
                    url: None,
                    files: None,
                    diff: None,
                    token_usage: None,
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
                status_text: Some("started".to_string()),
                model: None,
                target: None,
                url: None,
                files: None,
                diff: None,
                token_usage: None,
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
                status_text: None,
                model: None,
                target: None,
                url: None,
                files: None,
                diff: None,
                token_usage: None,
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
                status_text: None,
                model: None,
                target: Some("src/main.rs".to_string()),
                url: None,
                files: Some(json!(["src/main.rs"])),
                diff: Some(json!("@@ -1 +1 @@")),
                token_usage: None,
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
                status_text: Some("running".to_string()),
                model: None,
                target: Some("cargo test".to_string()),
                url: None,
                files: None,
                diff: None,
                token_usage: None,
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
            ProviderRuntimeProjectionDelta::ThreadItemDetailsUpdated {
                kind: ThreadItemKind::SubAgentActivity,
                item_id,
                status_text,
                ..
            } if item_id.as_deref() == Some("subagent-item-1")
                && status_text.as_deref() == Some("started")
        )));
        let file_details = deltas
            .iter()
            .find(|delta| {
                matches!(
                    delta,
                    ProviderRuntimeProjectionDelta::ThreadItemDetailsUpdated {
                        item_id,
                        ..
                    } if item_id.as_deref() == Some("file-1")
                )
            })
            .expect("file details delta");
        let encoded_file_details = serde_json::to_value(file_details).expect("encode details");
        assert_eq!(encoded_file_details["type"], "thread_item_details_updated");
        assert_eq!(encoded_file_details["kind"], "fileChange");
        assert_eq!(encoded_file_details["target"], "src/main.rs");
        assert_eq!(encoded_file_details["files"], json!(["src/main.rs"]));
        assert_eq!(encoded_file_details["diff"], "@@ -1 +1 @@");
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ThreadItemDetailsUpdated {
                kind: ThreadItemKind::CommandExecution,
                item_id,
                status_text,
                target,
                ..
            } if item_id.as_deref() == Some("cmd-1")
                && status_text.as_deref() == Some("running")
                && target.as_deref() == Some("cargo test")
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
    fn provider_runtime_events_project_fork_and_side_chat_signals() {
        let events = [
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RuntimeSignal {
                    signal: Box::new(NormalizedRuntimeSignal {
                        kind: RuntimeSignalKind::ForkUpdated,
                        thread_id: Some("parent-1".to_string()),
                        turn_id: Some("turn-2".to_string()),
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
                        metadata: json!({
                            "fork": {
                                "parent_thread_id": "parent-1",
                                "child_thread_id": "child-1",
                                "turn_id": "turn-2"
                            }
                        }),
                        provider: provider_metadata("ace/thread/fork"),
                    }),
                },
            ),
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RuntimeSignal {
                    signal: Box::new(NormalizedRuntimeSignal {
                        kind: RuntimeSignalKind::SideChatUpdated,
                        thread_id: Some("child-1".to_string()),
                        turn_id: Some("turn-2".to_string()),
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
                        metadata: json!({
                            "side_chat": {
                                "parent_thread_id": "parent-1",
                                "thread_id": "child-1",
                                "ephemeral": true
                            }
                        }),
                        provider: provider_metadata("ace/side_chat/start"),
                    }),
                },
            ),
        ];

        let deltas = projection_deltas_for_events(&events);

        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ForkUpdated {
                provider,
                fork,
            } if provider == "codex"
                && fork.parent_thread_id == "parent-1"
                && fork.child_thread_id == "child-1"
                && fork.turn_id.as_deref() == Some("turn-2")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::SideChatUpdated {
                provider,
                side_chat,
            } if provider == "codex"
                && side_chat.parent_thread_id == "parent-1"
                && side_chat.thread_id == "child-1"
                && side_chat.ephemeral
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                provider,
                parent_thread_id,
                child_thread_id,
                role,
                ..
            } if provider == "codex"
                && parent_thread_id == "parent-1"
                && child_thread_id == "child-1"
                && role.is_none()
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                provider,
                parent_thread_id,
                child_thread_id,
                role,
                ..
            } if provider == "codex"
                && parent_thread_id == "parent-1"
                && child_thread_id == "child-1"
                && role.as_deref() == Some("side_chat")
        )));
    }

    #[test]
    fn provider_runtime_events_project_turn_lifecycle_signals() {
        let events = [
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RuntimeSignal {
                    signal: Box::new(NormalizedRuntimeSignal {
                        kind: RuntimeSignalKind::TurnLifecycleChanged,
                        thread_id: Some("thread-1".to_string()),
                        turn_id: Some("turn-1".to_string()),
                        item_id: None,
                        message: None,
                        from_model: None,
                        to_model: None,
                        reason: None,
                        text: None,
                        audio: None,
                        status: Some("started".to_string()),
                        name: None,
                        active: Some(true),
                        archived: None,
                        diff: None,
                        files: None,
                        process_id: None,
                        exit_code: None,
                        request_id: None,
                        metadata: json!({ "mode": "normal" }),
                        provider: provider_metadata("ace/turn/start"),
                    }),
                },
            ),
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RuntimeSignal {
                    signal: Box::new(NormalizedRuntimeSignal {
                        kind: RuntimeSignalKind::TurnLifecycleChanged,
                        thread_id: Some("thread-1".to_string()),
                        turn_id: Some("turn-1".to_string()),
                        item_id: None,
                        message: None,
                        from_model: None,
                        to_model: None,
                        reason: None,
                        text: None,
                        audio: None,
                        status: Some("interrupted".to_string()),
                        name: None,
                        active: Some(false),
                        archived: None,
                        diff: None,
                        files: None,
                        process_id: None,
                        exit_code: None,
                        request_id: None,
                        metadata: json!({ "mode": "normal" }),
                        provider: provider_metadata("ace/turn/interrupted"),
                    }),
                },
            ),
        ];

        let deltas = projection_deltas_for_events(&events);

        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ActiveTurnChanged {
                provider,
                thread_id,
                turn_id,
                active: true,
            } if provider == "codex"
                && thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ActiveTurnChanged {
                provider,
                thread_id,
                turn_id,
                active: false,
            } if provider == "codex"
                && thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
        )));
    }

    #[test]
    fn provider_runtime_events_project_review_mode_signals() {
        let events = [
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RuntimeSignal {
                    signal: Box::new(NormalizedRuntimeSignal {
                        kind: RuntimeSignalKind::ReviewModeUpdated,
                        thread_id: Some("thread-1".to_string()),
                        turn_id: None,
                        item_id: Some("review-1".to_string()),
                        message: None,
                        from_model: None,
                        to_model: None,
                        reason: None,
                        text: None,
                        audio: None,
                        status: Some("entered".to_string()),
                        name: None,
                        active: Some(true),
                        archived: None,
                        diff: None,
                        files: None,
                        process_id: None,
                        exit_code: None,
                        request_id: None,
                        metadata: json!({ "detached": true }),
                        provider: provider_metadata("ace/review/start"),
                    }),
                },
            ),
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RuntimeSignal {
                    signal: Box::new(NormalizedRuntimeSignal {
                        kind: RuntimeSignalKind::ReviewModeUpdated,
                        thread_id: Some("thread-1".to_string()),
                        turn_id: None,
                        item_id: Some("review-1".to_string()),
                        message: None,
                        from_model: None,
                        to_model: None,
                        reason: None,
                        text: None,
                        audio: None,
                        status: Some("exited".to_string()),
                        name: None,
                        active: Some(false),
                        archived: None,
                        diff: None,
                        files: None,
                        process_id: None,
                        exit_code: None,
                        request_id: None,
                        metadata: json!({}),
                        provider: provider_metadata("ace/review/exit"),
                    }),
                },
            ),
        ];

        let deltas = projection_deltas_for_events(&events);

        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ReviewModeChanged {
                provider,
                thread_id,
                active: true,
                item_id,
            } if provider == "codex"
                && thread_id == "thread-1"
                && item_id.as_deref() == Some("review-1")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ReviewModeChanged {
                provider,
                thread_id,
                active: false,
                item_id,
            } if provider == "codex"
                && thread_id == "thread-1"
                && item_id.as_deref() == Some("review-1")
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
                    provider: provider_metadata("warning"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ModelRerouted,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: Some("gpt-5".to_string()),
                    to_model: Some("gpt-5-mini".to_string()),
                    reason: Some("capacity".to_string()),
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
                    metadata: json!({}),
                    provider: provider_metadata("model/rerouted"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::RealtimeTranscriptDelta,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: Some("hello".to_string()),
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
                    metadata: json!({}),
                    provider: provider_metadata("realtime/transcriptDelta"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
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
                    audio: Some("AAAA".to_string()),
                    status: None,
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({}),
                    provider: provider_metadata("realtime/audioDelta"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::RealtimeSessionUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: Some("Realtime session failed".to_string()),
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("error".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "error": "Realtime session failed" }),
                    provider: provider_metadata("thread/realtime/error"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::TurnModerationUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("moderation_metadata_updated".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "flagged": false }),
                    provider: provider_metadata("turn/moderationMetadata"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::AutoApprovalReviewUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: Some("review-1".to_string()),
                    message: Some("Command approved".to_string()),
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("approved".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "decision": "approved" }),
                    provider: provider_metadata("item/autoApprovalReview/completed"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::SubagentAction,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: Some("focus on tests".to_string()),
                    audio: None,
                    status: Some("steer".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "subagent_thread_id": "subagent-1",
                        "provider_response": { "steered": true }
                    }),
                    provider: provider_metadata("subagent/steer"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::HandoffUpdated,
                    thread_id: Some("thread-1".to_string()),
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
                    metadata: json!({
                        "handoff": {
                            "source_thread_id": "thread-1",
                            "target_location": "worktree",
                            "status": "completed",
                            "target_thread_id": "thread-1",
                            "repo_root": "/repo",
                            "worktree_path": "/worktrees/repo-feature",
                            "branch": "feature/task",
                            "start_point": "main",
                            "transfer_status": "metadata_updated",
                            "interrupted_active_turn": true,
                            "metadata": { "handoff": { "worktree_branch": "feature/task" } }
                        }
                    }),
                    provider: provider_metadata("handoff/worktree"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::PlanImplementationUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("fork_for_implementation".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "plan_implementation": {
                            "parent_thread_id": "thread-1",
                            "target_thread_id": "fork-1",
                            "mode": "fork_for_implementation",
                            "prompt": "implement this plan",
                            "model": "gpt-5.5",
                            "cwd": "/repo",
                            "plan": { "markdown": "1. Edit\n2. Test" },
                            "sandbox_policy": { "mode": "workspace-write" },
                            "approval_policy": { "mode": "on-request" },
                            "approvals_reviewer": "user",
                            "provider_response": { "forked": true }
                        }
                    }),
                    provider: provider_metadata("plan/implementation"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ApprovalRetryRecorded,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: Some("item-1".to_string()),
                    message: Some("retry after user approval".to_string()),
                    from_model: None,
                    to_model: None,
                    reason: Some("retry after user approval".to_string()),
                    text: None,
                    audio: None,
                    status: Some("approved".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "approval_retry": {
                            "thread_id": "thread-1",
                            "item_id": "item-1",
                            "action_id": "action-1",
                            "approved": true,
                            "reason": "retry after user approval",
                            "audit": { "selected_policy": "on-request" },
                            "provider_response": { "approved": true }
                        }
                    }),
                    provider: provider_metadata("approval/retry"),
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
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::RealtimeSessionUpdated {
                thread_id,
                turn_id,
                status,
                message,
                metadata,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && status == "error"
                && message.as_deref() == Some("Realtime session failed")
                && metadata["error"] == "Realtime session failed"
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::TurnModerationUpdated {
                thread_id,
                turn_id,
                status,
                metadata,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && status == "moderation_metadata_updated"
                && metadata["flagged"] == false
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::AutoApprovalReviewUpdated {
                thread_id,
                turn_id,
                item_id,
                status,
                message,
                metadata,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && item_id.as_deref() == Some("review-1")
                && status == "approved"
                && message.as_deref() == Some("Command approved")
                && metadata["decision"] == "approved"
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::SubagentActionRecorded {
                parent_thread_id,
                subagent_thread_id,
                action,
                prompt,
                metadata,
                ..
            } if parent_thread_id == "thread-1"
                && subagent_thread_id == "subagent-1"
                && action == "steer"
                && prompt.as_deref() == Some("focus on tests")
                && metadata["provider_response"]["steered"] == true
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::HandoffUpdated { handoff, .. }
                if handoff.source_thread_id == "thread-1"
                    && handoff.target_location == ace_runtime::threads::ExecutionLocation::Worktree
                    && handoff.status == ace_runtime::threads::HandoffStatus::Completed
                    && handoff.branch.as_deref() == Some("feature/task")
                    && handoff.interrupted_active_turn == Some(true)
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::PlanImplementationUpdated { implementation, .. }
                if implementation.parent_thread_id == "thread-1"
                    && implementation.target_thread_id == "fork-1"
                    && implementation.mode == ace_runtime::threads::PlanImplementationMode::ForkForImplementation
                    && implementation.prompt == "implement this plan"
                    && implementation.provider_response["forked"] == true
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ApprovalRetryRecorded { retry, .. }
                if retry.thread_id == "thread-1"
                    && retry.item_id.as_deref() == Some("item-1")
                    && retry.action_id.as_deref() == Some("action-1")
                    && retry.approved
                    && retry.audit["selected_policy"] == "on-request"
                    && retry.provider_response["approved"] == true
        )));
        assert!(deltas.iter().all(|delta| !matches!(
            delta,
            ProviderRuntimeProjectionDelta::RawNotificationObserved { .. }
        )));
    }

    #[test]
    fn provider_runtime_events_project_lifecycle_diff_and_process_signals() {
        let events = [
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ThreadLifecycleChanged,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("running".to_string()),
                    name: Some("Adapter parity".to_string()),
                    active: Some(true),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "status": "running" }),
                    provider: provider_metadata("thread/status/changed"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ThreadTokenUsageUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("token_usage_updated".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "tokenUsage": { "total": 128 } }),
                    provider: provider_metadata("thread/tokenUsage/updated"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::TurnDiffUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: None,
                    name: None,
                    active: None,
                    archived: None,
                    diff: Some("@@ -1 +1 @@".to_string()),
                    files: Some(json!([{ "path": "src/lib.rs" }])),
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({}),
                    provider: provider_metadata("turn/diff/updated"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ProcessExited,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
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
                    process_id: Some("proc-1".to_string()),
                    exit_code: Some(2),
                    request_id: None,
                    metadata: json!({ "processId": "proc-1", "exitCode": 2 }),
                    provider: provider_metadata("process/exited"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ServerRequestResolved,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("approved".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: Some("req-1".to_string()),
                    metadata: json!({ "requestId": "req-1", "status": "approved" }),
                    provider: provider_metadata("serverRequest/resolved"),
                }),
            },
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ProviderStateUpdated,
                    thread_id: None,
                    turn_id: None,
                    item_id: None,
                    message: Some("Signed in".to_string()),
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("account_updated".to_string()),
                    name: Some("work".to_string()),
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "account": "work", "email": "user@example.com" }),
                    provider: provider_metadata("account/updated"),
                }),
            },
        ];
        let deltas = projection_deltas_for_events(&events);

        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ThreadLifecycleChanged {
                thread_id,
                status,
                name,
                active,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && status.as_deref() == Some("running")
                && name.as_deref() == Some("Adapter parity")
                && *active == Some(true)
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ThreadTokenUsageUpdated {
                thread_id,
                token_usage,
                ..
            } if thread_id.as_deref() == Some("thread-1") && token_usage["total"] == 128
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::TurnDiffUpdated {
                thread_id,
                turn_id,
                diff,
                files,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && diff.as_deref() == Some("@@ -1 +1 @@")
                && files[0]["path"] == "src/lib.rs"
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ProcessExited {
                process_id,
                exit_code,
                ..
            } if process_id.as_deref() == Some("proc-1") && *exit_code == Some(2)
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ServerRequestResolvedObserved {
                request_id,
                status,
                ..
            } if request_id.as_deref() == Some("req-1") && status.as_deref() == Some("approved")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ProviderStateUpdated {
                provider,
                status,
                message,
                name,
                metadata,
            } if provider == "codex"
                && status == "account_updated"
                && message.as_deref() == Some("Signed in")
                && name.as_deref() == Some("work")
                && metadata["email"] == "user@example.com"
        )));
    }

    #[test]
    fn provider_runtime_events_project_goal_notifications() {
        let events = [
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RawNotification {
                    method: "thread/goal/updated".to_string(),
                    params: json!({
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "goal": {
                            "threadId": "thread-1",
                            "objective": "finish adapter parity",
                            "status": "usageLimited",
                            "tokenBudget": 5000,
                            "tokensUsed": 5100,
                            "timeUsedSeconds": 30
                        }
                    }),
                },
            ),
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RawNotification {
                    method: "thread/goal/cleared".to_string(),
                    params: json!({ "threadId": "thread-1" }),
                },
            ),
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RuntimeSignal {
                    signal: Box::new(NormalizedRuntimeSignal {
                        kind: RuntimeSignalKind::GoalUpdated,
                        thread_id: Some("thread-2".to_string()),
                        turn_id: Some("turn-2".to_string()),
                        item_id: None,
                        message: None,
                        from_model: None,
                        to_model: None,
                        reason: None,
                        text: None,
                        audio: None,
                        status: Some("paused".to_string()),
                        name: None,
                        active: None,
                        archived: None,
                        diff: None,
                        files: None,
                        process_id: None,
                        exit_code: None,
                        request_id: None,
                        metadata: json!({
                            "goal": {
                                "thread_id": "thread-2",
                                "status": "paused"
                            }
                        }),
                        provider: ProviderMetadata {
                            provider: "codex".to_string(),
                            method: Some("ace/goal/pause".to_string()),
                            schema_version: None,
                            raw_payload: json!({}),
                        },
                    }),
                },
            ),
            ProviderRuntimeEvent::from_provider_event(
                "codex",
                ProviderEvent::RuntimeSignal {
                    signal: Box::new(NormalizedRuntimeSignal {
                        kind: RuntimeSignalKind::GoalUpdated,
                        thread_id: Some("thread-2".to_string()),
                        turn_id: None,
                        item_id: None,
                        message: None,
                        from_model: None,
                        to_model: None,
                        reason: None,
                        text: None,
                        audio: None,
                        status: Some("cleared".to_string()),
                        name: None,
                        active: None,
                        archived: None,
                        diff: None,
                        files: None,
                        process_id: None,
                        exit_code: None,
                        request_id: None,
                        metadata: json!({
                            "goal": {
                                "thread_id": "thread-2",
                                "status": "cleared"
                            }
                        }),
                        provider: ProviderMetadata {
                            provider: "codex".to_string(),
                            method: Some("ace/goal/clear".to_string()),
                            schema_version: None,
                            raw_payload: json!({}),
                        },
                    }),
                },
            ),
        ];
        let deltas = projection_deltas_for_events(&events);

        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::GoalUpdated {
                provider,
                goal,
                turn_id,
            } if provider == "codex"
                && goal.thread_id == "thread-1"
                && goal.status == GoalStatus::UsageLimited
                && goal.objective.as_deref() == Some("finish adapter parity")
                && goal.tokens_used == Some(5100)
                && turn_id.as_deref() == Some("turn-1")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::GoalCleared {
                provider,
                thread_id,
            } if provider == "codex" && thread_id == "thread-1"
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::GoalUpdated {
                provider,
                goal,
                turn_id,
            } if provider == "codex"
                && goal.thread_id == "thread-2"
                && goal.status == GoalStatus::Paused
                && turn_id.as_deref() == Some("turn-2")
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::GoalCleared {
                provider,
                thread_id,
            } if provider == "codex" && thread_id == "thread-2"
        )));
    }

    #[test]
    fn provider_runtime_event_preserves_provider_exit_code() {
        let event = ProviderRuntimeEvent::from_provider_event(
            "codex",
            ProviderEvent::Exited { code: Some(7) },
        );
        let encoded = serde_json::to_value(&event).expect("event json");

        assert_eq!(encoded["type"], "exited");
        assert_eq!(encoded["provider"], "codex");
        assert_eq!(encoded["code"], 7);
        assert_eq!(
            event.projection_deltas(),
            vec![
                ProviderRuntimeProjectionDelta::ProviderExited {
                    provider: "codex".to_string(),
                    code: Some(7),
                },
                ProviderRuntimeProjectionDelta::ActiveTurnsCleared {
                    provider: "codex".to_string(),
                },
            ]
        );
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
