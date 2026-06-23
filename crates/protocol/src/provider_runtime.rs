use ace_core::ProviderKind;
use ace_provider_commands::ProviderSlashCommand;
use ace_runtime::{
    host_tools::HostToolDescriptor,
    models::{ProviderModelCatalog, ProviderModelProviderCapabilities},
    provider::{
        NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedThreadItem,
        ProviderAdapterContract, ProviderAdapterInvocationKind, ProviderAdapterOperation,
        ProviderAdapterOperationAvailability, ProviderAdapterOperationGate,
        ProviderAdapterOperationPolicy, ProviderAdapterOperationProfile,
        ProviderAdapterOperationSpec, ProviderAdapterOperationSupport, ProviderAdapterProfile,
        ProviderAdapterRuntimeHook, ProviderAdapterRuntimeReport, ProviderContractReport,
        ProviderDescriptor, ProviderDriverStatus, ProviderEvent, ProviderFeature,
        ProviderFeatureCategory, ProviderLifecycleAction, ProviderLifecycleResult,
        ProviderRuntimeHealth, RuntimeSignalKind, ServerRequestKind, ThreadItemKind,
        ThreadItemStatus,
    },
    threads::{
        AgentRuntimeSnapshot, ApprovalRetryRecord, ChildThreadRelationship, ExecutionLocation,
        ForkPoint, GoalState, GoalStatus, HandoffPlan, HandoffStatus, PlanImplementationRecord,
        RemoteConnectionRecord, SideChat,
    },
    tools::{SemanticToolCall, ToolActionKind, ToolRunStatus, ToolSurface},
};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const PROVIDER_RUNTIME_EVENT_TOPIC: &str = "provider_runtime.event";
pub const PROVIDER_RUNTIME_MAX_EVENT_BATCH_SIZE: usize = 512;
pub const PROVIDER_RUNTIME_MAX_EVENTS_REPLAY_LIMIT: usize = 1_000;
pub const PROVIDER_RUNTIME_MAX_SERVER_REQUESTS_LIMIT: usize = 1_000;
pub const PROVIDER_RUNTIME_MAX_REQUEST_RESOLVE_BATCH_SIZE: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeSubscribeRequest {
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_sequence_exclusive: Option<i64>,
    #[serde(default = "default_recent_events_limit")]
    pub replay_limit: usize,
    #[serde(default = "default_raw_event_mode")]
    pub raw_event_mode: ProviderRuntimeRawEventMode,
}

fn default_recent_events_limit() -> usize {
    100
}

#[must_use]
pub fn capped_provider_runtime_events_limit(limit: usize) -> usize {
    usize::min(limit, PROVIDER_RUNTIME_MAX_EVENTS_REPLAY_LIMIT)
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_sequence_exclusive: Option<i64>,
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
    pub requested_limit: usize,
    pub effective_limit: usize,
    pub max_limit: usize,
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
pub struct ProviderRuntimeRequestResolveRequest {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<ProviderAdapterOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeRequestResolveBatchRequest {
    pub provider: String,
    #[serde(default)]
    pub requests: Vec<ProviderRuntimeRequestResolveBatchItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeRequestResolveBatchItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<ProviderAdapterOperation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeRequestResolveResponse {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<ProviderAdapterOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typed_ws_method: Option<String>,
    pub runtime_request: ProviderRuntimeOperationRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_profile: Option<ProviderRuntimeProviderOperation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeRequestResolveBatchItemResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub resolution: ProviderRuntimeRequestResolveResponse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeRequestResolveBatchResponse {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub requested_count: usize,
    pub max_requests: usize,
    pub responses: Vec<ProviderRuntimeRequestResolveBatchItemResponse>,
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
    pub summary: ProviderRuntimeProviderInfoSummary,
    pub readiness: ProviderRuntimeAdapterReadiness,
    pub supports_events: bool,
    pub supports_server_request_responses: bool,
    pub contract: ProviderContractReport,
    pub adapter_profile: ProviderAdapterProfile,
    pub adapter_runtime: ProviderAdapterRuntimeReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderInfoSummary {
    pub contract_satisfied: bool,
    pub runtime_hooks_satisfied: bool,
    pub selectable: bool,
    pub supports_events: bool,
    pub supports_server_request_responses: bool,
    pub supports_state_snapshots: bool,
    pub supports_host_tools: bool,
    pub runtime_ready_feature_families: usize,
    pub runtime_blocked_feature_families: usize,
    pub required_operations: usize,
    pub optional_operations: usize,
    pub version_gated_operations: usize,
    pub deferred_operations: usize,
    #[serde(default)]
    pub missing_required_capabilities: Vec<String>,
    #[serde(default)]
    pub missing_required_hooks: Vec<String>,
    #[serde(default)]
    pub native_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderRuntimeProviderSurfaceSupport {
    pub events: bool,
    pub server_request_responses: bool,
    pub state_snapshots: bool,
    pub host_tools: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeAdapterReadiness {
    pub ready: bool,
    pub contract_satisfied: bool,
    pub runtime_hooks_satisfied: bool,
    #[serde(default)]
    pub missing_required_capabilities: Vec<String>,
    #[serde(default)]
    pub missing_required_hooks: Vec<ProviderAdapterRuntimeHook>,
    #[serde(default)]
    pub feature_families: Vec<ProviderRuntimeFeatureFamilyReadiness>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeFeatureFamilyReadiness {
    pub category: ProviderFeatureCategory,
    pub ready: bool,
    pub total_operations: usize,
    pub hook_ready_operations: usize,
    pub hook_blocked_operations: usize,
    pub required_operations: usize,
    pub required_blocked_operations: usize,
    #[serde(default)]
    pub required_hooks: Vec<ProviderAdapterRuntimeHook>,
    #[serde(default)]
    pub missing_hooks: Vec<ProviderAdapterRuntimeHook>,
    #[serde(default)]
    pub operations: Vec<ProviderAdapterOperation>,
}

impl ProviderRuntimeAdapterReadiness {
    #[must_use]
    pub fn from_parts(
        contract: &ProviderContractReport,
        adapter_profile: &ProviderAdapterProfile,
        adapter_runtime: &ProviderAdapterRuntimeReport,
    ) -> Self {
        let feature_families = adapter_runtime
            .feature_families
            .iter()
            .map(|family| {
                let required_operations = family
                    .operations
                    .iter()
                    .filter(|operation| {
                        adapter_profile
                            .operation(**operation)
                            .is_some_and(|profile| {
                                profile.support == ProviderAdapterOperationSupport::Required
                            })
                    })
                    .count();
                let required_blocked_operations = if family.hook_blocked_operations == 0 {
                    0
                } else {
                    required_operations
                };
                ProviderRuntimeFeatureFamilyReadiness {
                    category: family.category,
                    ready: family.hook_blocked_operations == 0,
                    total_operations: family.total_operations,
                    hook_ready_operations: family.hook_ready_operations,
                    hook_blocked_operations: family.hook_blocked_operations,
                    required_operations,
                    required_blocked_operations,
                    required_hooks: family.required_hooks.clone(),
                    missing_hooks: family.missing_hooks.clone(),
                    operations: family.operations.clone(),
                }
            })
            .collect();

        Self {
            ready: contract.satisfies_required && adapter_runtime.satisfies_required_hooks,
            contract_satisfied: contract.satisfies_required,
            runtime_hooks_satisfied: adapter_runtime.satisfies_required_hooks,
            missing_required_capabilities: contract.missing_required.clone(),
            missing_required_hooks: adapter_runtime.missing_required_hooks.clone(),
            feature_families,
        }
    }
}

impl ProviderRuntimeProviderInfoSummary {
    #[must_use]
    pub fn from_parts(
        descriptor: &ProviderDescriptor,
        contract: &ProviderContractReport,
        adapter_profile: &ProviderAdapterProfile,
        adapter_runtime: &ProviderAdapterRuntimeReport,
        support: ProviderRuntimeProviderSurfaceSupport,
    ) -> Self {
        let mut required_operations = 0;
        let mut optional_operations = 0;
        let mut version_gated_operations = 0;
        let mut deferred_operations = 0;

        for operation in &adapter_profile.operations {
            match operation.support {
                ProviderAdapterOperationSupport::Required => required_operations += 1,
                ProviderAdapterOperationSupport::Optional => optional_operations += 1,
                ProviderAdapterOperationSupport::VersionGated => version_gated_operations += 1,
                ProviderAdapterOperationSupport::Deferred => deferred_operations += 1,
            }
        }

        Self {
            contract_satisfied: contract.satisfies_required,
            runtime_hooks_satisfied: adapter_runtime.satisfies_required_hooks,
            selectable: contract.satisfies_required && adapter_runtime.satisfies_required_hooks,
            supports_events: support.events,
            supports_server_request_responses: support.server_request_responses,
            supports_state_snapshots: support.state_snapshots,
            supports_host_tools: support.host_tools,
            runtime_ready_feature_families: adapter_runtime
                .feature_families
                .iter()
                .filter(|family| family.hook_blocked_operations == 0)
                .count(),
            runtime_blocked_feature_families: adapter_runtime
                .feature_families
                .iter()
                .filter(|family| family.hook_blocked_operations > 0)
                .count(),
            required_operations,
            optional_operations,
            version_gated_operations,
            deferred_operations,
            missing_required_capabilities: contract.missing_required.clone(),
            missing_required_hooks: adapter_runtime
                .missing_required_hooks
                .iter()
                .map(enum_key)
                .collect(),
            native_capabilities: descriptor
                .capabilities
                .iter()
                .map(|capability| capability.key.clone())
                .collect(),
        }
    }
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
    pub policy_summary: ProviderRuntimeOperationPolicySummary,
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
    #[serde(default)]
    pub missing_runtime_hooks: Vec<ProviderAdapterRuntimeHook>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typed_ws_method: Option<String>,
    pub runtime_request: ProviderRuntimeOperationRequest,
}

impl ProviderRuntimeProviderOperation {
    pub fn from_spec(spec: &ProviderAdapterOperationSpec) -> Self {
        Self::from_profile(ProviderAdapterOperationProfile::from_spec(spec))
    }

    pub fn from_profile(profile: ProviderAdapterOperationProfile) -> Self {
        let policy_summary = ProviderRuntimeOperationPolicySummary::from_policy(&profile.policy);
        Self {
            operation: profile.operation,
            category: profile.category,
            support: profile.support,
            availability: profile.availability,
            policy: profile.policy,
            policy_summary,
            runtime_gate: profile.runtime_gate,
            runtime_gate_resolution: None,
            availability_reason: profile.availability_reason,
            canonical_method: profile.canonical_method,
            provider_methods: profile.provider_methods,
            direct_invocation: profile.direct_invocation,
            invocation: profile.invocation,
            required_runtime_hooks: profile.required_runtime_hooks,
            missing_runtime_hooks: Vec::new(),
            typed_ws_method: None,
            runtime_request: ProviderRuntimeOperationRequest::from_invocation(profile.invocation),
        }
    }

    #[must_use]
    pub fn with_missing_runtime_hooks(
        mut self,
        missing_hooks: Vec<ProviderAdapterRuntimeHook>,
    ) -> Self {
        self.missing_runtime_hooks = missing_hooks;
        self
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

    #[must_use]
    pub fn with_typed_ws_method(mut self, method: Option<String>) -> Self {
        self.typed_ws_method = method;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeOperationPolicySummary {
    pub key: String,
    pub title: String,
    pub description: String,
    pub approval_required: bool,
    #[serde(default)]
    pub badges: Vec<String>,
}

impl ProviderRuntimeOperationPolicySummary {
    #[must_use]
    pub fn from_policy(policy: &ProviderAdapterOperationPolicy) -> Self {
        let (key, title, description) = if policy.escapes_thread_sandbox {
            (
                "sandbox_escape",
                "Runs outside sandbox",
                "Requires an explicit user action because it escapes the active thread sandbox.",
            )
        } else if policy.approval_boundary
            && policy.mutates_workspace
            && policy.external_side_effects
        {
            (
                "approval_external_workspace",
                "Approval, workspace, and external effects",
                "Can change workspace files and cause external side effects, so approval handling is required.",
            )
        } else if policy.approval_boundary && policy.mutates_workspace {
            (
                "approval_workspace",
                "Workspace approval required",
                "Can change workspace files and crosses an approval boundary.",
            )
        } else if policy.approval_boundary && policy.external_side_effects {
            (
                "approval_external",
                "External approval required",
                "Can cause external side effects and crosses an approval boundary.",
            )
        } else if policy.approval_boundary {
            (
                "approval_required",
                "Approval required",
                "Crosses a provider approval boundary before it can run.",
            )
        } else if policy.external_side_effects {
            (
                "external_side_effect",
                "External side effect",
                "Can affect external state outside the local workspace.",
            )
        } else if policy.mutates_workspace {
            (
                "workspace_write",
                "Workspace write",
                "Can change files or process state in the workspace.",
            )
        } else if policy.mutates_provider_state {
            (
                "provider_state",
                "Provider state change",
                "Can change provider-side state without changing workspace files.",
            )
        } else {
            (
                "read_only",
                "Read only",
                "Does not mutate workspace or provider state.",
            )
        };

        let mut badges = Vec::new();
        if policy.read_only {
            badges.push("read_only".to_string());
        }
        if policy.mutates_workspace {
            badges.push("workspace".to_string());
        }
        if policy.mutates_provider_state {
            badges.push("provider_state".to_string());
        }
        if policy.external_side_effects {
            badges.push("external".to_string());
        }
        if policy.approval_boundary {
            badges.push("approval".to_string());
        }
        if policy.requires_user_initiation {
            badges.push("user_initiated".to_string());
        }
        if policy.escapes_thread_sandbox {
            badges.push("sandbox_escape".to_string());
        }

        Self {
            key: key.to_string(),
            title: title.to_string(),
            description: policy
                .reason
                .clone()
                .unwrap_or_else(|| description.to_string()),
            approval_required: policy.approval_boundary,
            badges,
        }
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
            ProviderAdapterInvocationKind::HostToolContract => Self::unavailable(
                ProviderRuntimeOperationRequestMode::HostTool,
                "use provider runtime host-tool APIs and server-request routing for this operation",
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
    HostTool,
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
    pub summary: ProviderRuntimeOperationSummary,
    pub operations: Vec<ProviderRuntimeProviderOperation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeOperationsListResponse {
    pub adapter_contract: ProviderAdapterContract,
    pub providers: Vec<ProviderRuntimeProviderOperations>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeOperationCount {
    pub key: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeOperationSummary {
    pub total: usize,
    pub invokable: usize,
    pub unavailable: usize,
    pub direct_invocation: usize,
    pub gated: usize,
    pub gate_available: usize,
    pub gate_unavailable: usize,
    pub gate_unknown: usize,
    #[serde(default)]
    pub missing_provider_methods: Vec<String>,
    #[serde(default)]
    pub missing_runtime_hooks: Vec<String>,
    #[serde(default)]
    pub by_category: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_support: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_availability: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_request_mode: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_policy: Vec<ProviderRuntimeOperationCount>,
}

impl ProviderRuntimeOperationSummary {
    #[must_use]
    pub fn from_operations(operations: &[ProviderRuntimeProviderOperation]) -> Self {
        let mut by_category = BTreeMap::new();
        let mut by_support = BTreeMap::new();
        let mut by_availability = BTreeMap::new();
        let mut by_request_mode = BTreeMap::new();
        let mut by_policy = BTreeMap::new();
        let mut missing_provider_methods = BTreeSet::new();
        let mut missing_runtime_hooks = BTreeSet::new();
        let mut summary = Self {
            total: operations.len(),
            ..Self::default()
        };

        for operation in operations {
            increment_count(&mut by_category, enum_key(&operation.category));
            increment_count(&mut by_support, enum_key(&operation.support));
            increment_count(&mut by_availability, enum_key(&operation.availability));
            increment_count(
                &mut by_request_mode,
                enum_key(&operation.runtime_request.mode),
            );
            increment_count(&mut by_policy, operation.policy_summary.key.clone());

            if operation.runtime_request.invokable {
                summary.invokable += 1;
            }
            if operation.direct_invocation {
                summary.direct_invocation += 1;
            }
            if operation.runtime_gate.is_some() {
                summary.gated += 1;
            }
            if let Some(resolution) = &operation.runtime_gate_resolution {
                match resolution.status {
                    ProviderRuntimeOperationGateStatus::Available => summary.gate_available += 1,
                    ProviderRuntimeOperationGateStatus::Unavailable => {
                        summary.gate_unavailable += 1;
                    }
                    ProviderRuntimeOperationGateStatus::Unknown => summary.gate_unknown += 1,
                }
                missing_provider_methods
                    .extend(resolution.missing_provider_methods.iter().cloned());
            }
            missing_runtime_hooks.extend(operation.missing_runtime_hooks.iter().map(enum_key));
        }

        summary.unavailable = summary.total.saturating_sub(summary.invokable);
        summary.missing_provider_methods = missing_provider_methods.into_iter().collect();
        summary.missing_runtime_hooks = missing_runtime_hooks.into_iter().collect();
        summary.by_category = operation_counts(by_category);
        summary.by_support = operation_counts(by_support);
        summary.by_availability = operation_counts(by_availability);
        summary.by_request_mode = operation_counts(by_request_mode);
        summary.by_policy = operation_counts(by_policy);
        summary
    }
}

fn enum_key(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn increment_count(counts: &mut BTreeMap<String, usize>, key: String) {
    *counts.entry(key).or_default() += 1;
}

fn operation_counts(counts: BTreeMap<String, usize>) -> Vec<ProviderRuntimeOperationCount> {
    counts
        .into_iter()
        .map(|(key, count)| ProviderRuntimeOperationCount { key, count })
        .collect()
}

fn tool_renderable_asset_metadata(tool: &SemanticToolCall) -> Option<&serde_json::Value> {
    tool.display
        .technical_metadata
        .get("renderable_asset")
        .filter(|asset| asset.is_object())
}

fn normalize_remote_connection_status(status: &str) -> String {
    let normalized = status
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_");
    match normalized.as_str() {
        "connect" | "connected" | "online" | "ready" => normalized,
        "disconnect" | "disconnected" | "offline" => normalized,
        "available" => "online".to_string(),
        "unavailable" => "offline".to_string(),
        _ => normalized,
    }
}

fn has_remote_projects(projects: &serde_json::Value) -> bool {
    match projects {
        serde_json::Value::Array(projects) => !projects.is_empty(),
        serde_json::Value::Object(project) => !project.is_empty(),
        _ => false,
    }
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
    pub summary: ProviderRuntimeProviderStatusSummary,
    pub readiness: ProviderRuntimeAdapterReadiness,
    pub supports_events: bool,
    pub supports_server_request_responses: bool,
    pub contract: ProviderContractReport,
    pub adapter_profile: ProviderAdapterProfile,
    pub adapter_runtime: ProviderAdapterRuntimeReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderStatusSummary {
    pub health: ProviderRuntimeHealth,
    pub ready: bool,
    pub initialized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub supports_events: bool,
    pub supports_server_request_responses: bool,
    pub contract_satisfied: bool,
    pub runtime_hooks_satisfied: bool,
    pub runtime_ready_feature_families: usize,
    pub runtime_blocked_feature_families: usize,
    #[serde(default)]
    pub missing_required_capabilities: Vec<String>,
    #[serde(default)]
    pub missing_required_hooks: Vec<String>,
    pub advertised_client_request_methods: usize,
    pub version_gated_client_request_methods: usize,
    pub deferred_client_request_methods: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method_inventory_source: Option<String>,
}

impl ProviderRuntimeProviderStatusSummary {
    #[must_use]
    pub fn from_status(
        status: &ProviderDriverStatus,
        supports_events: bool,
        supports_server_request_responses: bool,
        contract: &ProviderContractReport,
        adapter_runtime: &ProviderAdapterRuntimeReport,
    ) -> Self {
        Self {
            health: status.health,
            ready: matches!(
                status.health,
                ProviderRuntimeHealth::Ready | ProviderRuntimeHealth::Running
            ) && status.initialized
                && contract.satisfies_required
                && adapter_runtime.satisfies_required_hooks,
            initialized: status.initialized,
            transport: status.transport.clone(),
            version: status.version.clone(),
            last_error: status.last_error.clone(),
            supports_events,
            supports_server_request_responses,
            contract_satisfied: contract.satisfies_required,
            runtime_hooks_satisfied: adapter_runtime.satisfies_required_hooks,
            runtime_ready_feature_families: adapter_runtime
                .feature_families
                .iter()
                .filter(|family| family.hook_blocked_operations == 0)
                .count(),
            runtime_blocked_feature_families: adapter_runtime
                .feature_families
                .iter()
                .filter(|family| family.hook_blocked_operations > 0)
                .count(),
            missing_required_capabilities: contract.missing_required.clone(),
            missing_required_hooks: adapter_runtime
                .missing_required_hooks
                .iter()
                .map(enum_key)
                .collect(),
            advertised_client_request_methods: client_request_methods_count(&status.metadata),
            version_gated_client_request_methods: metadata_array_count(
                &status.metadata,
                &[
                    "/method_inventory/version_gated_client_request_methods",
                    "/version_gated_client_request_methods",
                ],
            ),
            deferred_client_request_methods: metadata_array_count(
                &status.metadata,
                &[
                    "/method_inventory/deferred_client_request_methods",
                    "/deferred_client_request_methods",
                ],
            ),
            method_inventory_source: string_pointer(
                &status.metadata,
                &[
                    "/method_inventory/source",
                    "/installed_client_request_methods_source",
                    "/client_request_methods_source",
                ],
            ),
        }
    }
}

fn client_request_methods_count(metadata: &serde_json::Value) -> usize {
    metadata_array_count(
        metadata,
        &[
            "/supported_client_request_methods",
            "/installed_client_request_methods",
            "/client_request_methods",
            "/schema/client_request_methods",
            "/schema/clientRequestMethods",
            "/methods/client_request",
            "/methods/clientRequest",
            "/method_inventory/client_request_methods",
        ],
    )
}

fn metadata_array_count(metadata: &serde_json::Value, pointers: &[&str]) -> usize {
    pointers
        .iter()
        .find_map(|pointer| metadata.pointer(pointer)?.as_array().map(Vec::len))
        .unwrap_or_default()
}

fn string_pointer(metadata: &serde_json::Value, pointers: &[&str]) -> Option<String> {
    pointers
        .iter()
        .find_map(|pointer| metadata.pointer(pointer)?.as_str().map(ToString::to_string))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeStatusListResponse {
    pub providers: Vec<ProviderRuntimeProviderStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeStateGetRequest {
    pub provider: Option<String>,
    #[serde(default)]
    pub source: ProviderRuntimeStateSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRuntimeStateSource {
    #[default]
    Live,
    Persisted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderState {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub source: ProviderRuntimeStateSource,
    pub persisted_replay_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_persisted_sequence: Option<i64>,
    pub summary: ProviderRuntimeStateSummary,
    pub state: AgentRuntimeSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeStateGetResponse {
    pub providers: Vec<ProviderRuntimeProviderState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeStateSummary {
    pub threads: usize,
    pub active_threads: usize,
    pub archived_threads: usize,
    pub active_turns: usize,
    pub plan_sessions: usize,
    pub active_plan_sessions: usize,
    pub completed_plan_sessions: usize,
    pub rejected_plan_sessions: usize,
    pub implementing_plan_sessions: usize,
    pub goals: usize,
    pub active_goals: usize,
    pub paused_goals: usize,
    pub blocked_goals: usize,
    pub usage_limited_goals: usize,
    pub budget_limited_goals: usize,
    pub complete_goals: usize,
    pub cleared_goals: usize,
    pub goals_with_token_budget: usize,
    pub goal_token_budget_total: u64,
    pub goal_tokens_used_total: u64,
    pub goal_time_used_seconds_total: u64,
    pub goals_over_token_budget: usize,
    pub child_threads: usize,
    pub active_child_threads: usize,
    pub ephemeral_child_threads: usize,
    pub persistent_child_threads: usize,
    pub fork_points: usize,
    pub side_chats: usize,
    pub ephemeral_side_chats: usize,
    pub persistent_side_chats: usize,
    pub subagents: usize,
    pub handoffs: usize,
    pub interrupted_handoffs: usize,
    pub approval_retries: usize,
    pub plan_implementations: usize,
    pub thread_lifecycle: usize,
    pub subagent_actions: usize,
    pub thread_items: usize,
    pub tool_timeline: usize,
    pub renderable_tool_assets: usize,
    pub image_tool_assets: usize,
    pub proxy_required_tool_assets: usize,
    pub github_proxy_required_tool_assets: usize,
    pub approvals: usize,
    pub pending_approvals: usize,
    pub resolved_approvals: usize,
    pub review_threads: usize,
    pub turn_diffs: usize,
    pub terminal_outputs: usize,
    pub truncated_terminal_outputs: usize,
    pub terminal_truncated_bytes: usize,
    pub process_exits: usize,
    pub warnings: usize,
    pub model_reroutes: usize,
    pub provider_states: usize,
    pub remote_connections: usize,
    pub remote_host_connections: usize,
    pub connected_remote_connections: usize,
    pub disconnected_remote_connections: usize,
    pub remote_connections_with_projects: usize,
    pub realtime_sessions: usize,
    pub realtime_transcripts: usize,
    pub truncated_realtime_transcripts: usize,
    pub realtime_transcript_truncated_bytes: usize,
    pub realtime_audio: usize,
    pub truncated_realtime_audio: usize,
    pub realtime_audio_truncated_chunks: usize,
    pub turn_moderation: usize,
    pub auto_approval_reviews: usize,
    #[serde(default)]
    pub by_execution_location: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_active_turn_mode: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_plan_status: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_goal_status: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_handoff_status: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_handoff_location: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_child_relationship: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_child_status: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_plan_implementation_mode: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_thread_item_kind: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_thread_item_status: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_tool_status: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_approval_status: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_thread_lifecycle_action: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_subagent_action: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_remote_connection_status: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_remote_connection_location: Vec<ProviderRuntimeOperationCount>,
}

impl ProviderRuntimeStateSummary {
    #[must_use]
    pub fn from_snapshot(snapshot: &AgentRuntimeSnapshot) -> Self {
        let mut by_execution_location = BTreeMap::new();
        let mut by_active_turn_mode = BTreeMap::new();
        let mut by_plan_status = BTreeMap::new();
        let mut by_goal_status = BTreeMap::new();
        let mut by_handoff_status = BTreeMap::new();
        let mut by_handoff_location = BTreeMap::new();
        let mut by_child_relationship = BTreeMap::new();
        let mut by_child_status = BTreeMap::new();
        let mut by_plan_implementation_mode = BTreeMap::new();
        let mut by_thread_item_kind = BTreeMap::new();
        let mut by_thread_item_status = BTreeMap::new();
        let mut by_tool_status = BTreeMap::new();
        let mut by_approval_status = BTreeMap::new();
        let mut by_thread_lifecycle_action = BTreeMap::new();
        let mut by_subagent_action = BTreeMap::new();
        let mut by_remote_connection_status = BTreeMap::new();
        let mut by_remote_connection_location = BTreeMap::new();
        let mut summary = Self {
            threads: snapshot.threads.len(),
            active_threads: snapshot
                .threads
                .iter()
                .filter(|thread| thread.active == Some(true))
                .count(),
            archived_threads: snapshot
                .threads
                .iter()
                .filter(|thread| thread.archived == Some(true))
                .count(),
            active_turns: snapshot.active_turns.len(),
            plan_sessions: snapshot.plan_sessions.len(),
            goals: snapshot.goals.len(),
            child_threads: snapshot.child_threads.len(),
            fork_points: snapshot.fork_points.len(),
            side_chats: snapshot.side_chats.len(),
            subagents: snapshot.subagents.len(),
            handoffs: snapshot.handoffs.len(),
            interrupted_handoffs: snapshot
                .handoffs
                .iter()
                .filter(|handoff| handoff.interrupted_active_turn == Some(true))
                .count(),
            approval_retries: snapshot.approval_retries.len(),
            plan_implementations: snapshot.plan_implementations.len(),
            thread_lifecycle: snapshot.thread_lifecycle.len(),
            subagent_actions: snapshot.subagent_actions.len(),
            thread_items: snapshot.thread_items.len(),
            tool_timeline: snapshot.tool_timeline.len(),
            approvals: snapshot.approvals.len(),
            review_threads: snapshot.review_threads.len(),
            turn_diffs: snapshot.turn_diffs.len(),
            terminal_outputs: snapshot.terminal_outputs.len(),
            truncated_terminal_outputs: snapshot
                .terminal_outputs
                .iter()
                .filter(|output| output.truncated_bytes > 0)
                .count(),
            terminal_truncated_bytes: snapshot
                .terminal_outputs
                .iter()
                .map(|output| output.truncated_bytes)
                .sum(),
            process_exits: snapshot.process_exits.len(),
            warnings: snapshot.warnings.len(),
            model_reroutes: snapshot.model_reroutes.len(),
            provider_states: snapshot.provider_states.len(),
            remote_connections: snapshot.remote_connections.len(),
            realtime_sessions: snapshot.realtime_sessions.len(),
            realtime_transcripts: snapshot.realtime_transcripts.len(),
            truncated_realtime_transcripts: snapshot
                .realtime_transcripts
                .iter()
                .filter(|transcript| transcript.truncated_bytes > 0)
                .count(),
            realtime_transcript_truncated_bytes: snapshot
                .realtime_transcripts
                .iter()
                .map(|transcript| transcript.truncated_bytes)
                .sum(),
            realtime_audio: snapshot.realtime_audio.len(),
            truncated_realtime_audio: snapshot
                .realtime_audio
                .iter()
                .filter(|audio| audio.truncated_chunks > 0)
                .count(),
            realtime_audio_truncated_chunks: snapshot
                .realtime_audio
                .iter()
                .map(|audio| audio.truncated_chunks)
                .sum(),
            turn_moderation: snapshot.turn_moderation.len(),
            auto_approval_reviews: snapshot.auto_approval_reviews.len(),
            ..Self::default()
        };

        for thread in &snapshot.threads {
            increment_count(
                &mut by_execution_location,
                enum_key(&thread.execution_location),
            );
        }
        for turn in &snapshot.active_turns {
            increment_count(&mut by_active_turn_mode, enum_key(&turn.mode));
        }
        for plan in &snapshot.plan_sessions {
            increment_count(&mut by_plan_status, enum_key(&plan.status));
            match plan.status {
                ace_runtime::threads::PlanSessionStatus::Active => {
                    summary.active_plan_sessions += 1;
                }
                ace_runtime::threads::PlanSessionStatus::Completed => {
                    summary.completed_plan_sessions += 1;
                }
                ace_runtime::threads::PlanSessionStatus::Rejected => {
                    summary.rejected_plan_sessions += 1;
                }
                ace_runtime::threads::PlanSessionStatus::Implementing => {
                    summary.implementing_plan_sessions += 1;
                }
            }
        }
        for goal in &snapshot.goals {
            increment_count(&mut by_goal_status, enum_key(&goal.status));
            match goal.status {
                GoalStatus::Active => summary.active_goals += 1,
                GoalStatus::Paused => summary.paused_goals += 1,
                GoalStatus::Blocked => summary.blocked_goals += 1,
                GoalStatus::UsageLimited => summary.usage_limited_goals += 1,
                GoalStatus::BudgetLimited => summary.budget_limited_goals += 1,
                GoalStatus::Complete => summary.complete_goals += 1,
                GoalStatus::Cleared => summary.cleared_goals += 1,
            }
            if let Some(token_budget) = goal.token_budget {
                summary.goals_with_token_budget += 1;
                summary.goal_token_budget_total =
                    summary.goal_token_budget_total.saturating_add(token_budget);
                if goal
                    .tokens_used
                    .is_some_and(|tokens_used| tokens_used > token_budget)
                {
                    summary.goals_over_token_budget += 1;
                }
            }
            if let Some(tokens_used) = goal.tokens_used {
                summary.goal_tokens_used_total =
                    summary.goal_tokens_used_total.saturating_add(tokens_used);
            }
            if let Some(time_used_seconds) = goal.time_used_seconds {
                summary.goal_time_used_seconds_total = summary
                    .goal_time_used_seconds_total
                    .saturating_add(time_used_seconds);
            }
        }
        for handoff in &snapshot.handoffs {
            increment_count(&mut by_handoff_status, enum_key(&handoff.status));
            increment_count(&mut by_handoff_location, enum_key(&handoff.target_location));
        }
        for child in &snapshot.child_threads {
            increment_count(&mut by_child_relationship, enum_key(&child.relationship));
            if let Some(status) = child.status.as_deref() {
                increment_count(&mut by_child_status, status.to_string());
            }
            match child.ephemeral {
                Some(true) => summary.ephemeral_child_threads += 1,
                Some(false) => summary.persistent_child_threads += 1,
                None => {}
            }
            if child
                .status
                .as_deref()
                .is_some_and(|status| matches!(status, "active" | "running" | "started"))
            {
                summary.active_child_threads += 1;
            }
        }
        for side_chat in &snapshot.side_chats {
            if side_chat.ephemeral {
                summary.ephemeral_side_chats += 1;
            } else {
                summary.persistent_side_chats += 1;
            }
        }
        for implementation in &snapshot.plan_implementations {
            increment_count(
                &mut by_plan_implementation_mode,
                enum_key(&implementation.mode),
            );
        }
        for item in &snapshot.thread_items {
            increment_count(&mut by_thread_item_kind, enum_key(&item.kind));
            increment_count(&mut by_thread_item_status, enum_key(&item.status));
        }
        for tool in &snapshot.tool_timeline {
            increment_count(&mut by_tool_status, enum_key(&tool.display.status));
            if let Some(asset) = tool_renderable_asset_metadata(tool) {
                summary.renderable_tool_assets += 1;
                if asset
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|kind| kind == "image")
                {
                    summary.image_tool_assets += 1;
                }
                if asset
                    .get("proxy_required")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    summary.proxy_required_tool_assets += 1;
                    if asset
                        .get("proxy_method")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|method| method == "github.image.proxy")
                    {
                        summary.github_proxy_required_tool_assets += 1;
                    }
                }
            }
        }
        for approval in &snapshot.approvals {
            increment_count(&mut by_approval_status, enum_key(&approval.status));
            match approval.status {
                ace_runtime::threads::ApprovalStatus::Pending => summary.pending_approvals += 1,
                ace_runtime::threads::ApprovalStatus::Resolved => summary.resolved_approvals += 1,
            }
        }
        for lifecycle in &snapshot.thread_lifecycle {
            increment_count(&mut by_thread_lifecycle_action, enum_key(&lifecycle.action));
        }
        for action in &snapshot.subagent_actions {
            increment_count(&mut by_subagent_action, enum_key(&action.action));
        }
        for connection in &snapshot.remote_connections {
            increment_count(
                &mut by_remote_connection_location,
                enum_key(&connection.execution_location),
            );
            if connection.execution_location == ExecutionLocation::RemoteHost {
                summary.remote_host_connections += 1;
            }
            if has_remote_projects(&connection.projects) {
                summary.remote_connections_with_projects += 1;
            }
            if let Some(status) = connection.status.as_deref() {
                let status_key = normalize_remote_connection_status(status);
                increment_count(&mut by_remote_connection_status, status_key.clone());
                match status_key.as_str() {
                    "connected" | "online" | "ready" => summary.connected_remote_connections += 1,
                    "disconnected" | "offline" => summary.disconnected_remote_connections += 1,
                    _ => {}
                }
            }
        }

        summary.by_execution_location = operation_counts(by_execution_location);
        summary.by_active_turn_mode = operation_counts(by_active_turn_mode);
        summary.by_plan_status = operation_counts(by_plan_status);
        summary.by_goal_status = operation_counts(by_goal_status);
        summary.by_handoff_status = operation_counts(by_handoff_status);
        summary.by_handoff_location = operation_counts(by_handoff_location);
        summary.by_child_relationship = operation_counts(by_child_relationship);
        summary.by_child_status = operation_counts(by_child_status);
        summary.by_plan_implementation_mode = operation_counts(by_plan_implementation_mode);
        summary.by_thread_item_kind = operation_counts(by_thread_item_kind);
        summary.by_thread_item_status = operation_counts(by_thread_item_status);
        summary.by_tool_status = operation_counts(by_tool_status);
        summary.by_approval_status = operation_counts(by_approval_status);
        summary.by_thread_lifecycle_action = operation_counts(by_thread_lifecycle_action);
        summary.by_subagent_action = operation_counts(by_subagent_action);
        summary.by_remote_connection_status = operation_counts(by_remote_connection_status);
        summary.by_remote_connection_location = operation_counts(by_remote_connection_location);
        summary
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeModelsListRequest {
    pub provider: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default = "default_provider_request_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeModelsListResponse {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub catalog: ProviderModelCatalog,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeModelProviderCapabilitiesReadRequest {
    pub provider: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default = "default_provider_request_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeModelProviderCapabilitiesReadResponse {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    pub capabilities: ProviderModelProviderCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderRuntimeSlashCommandsListRequest {
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_home_dir_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_manifest_dir_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents_home: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeProviderSlashCommands {
    pub provider: ProviderKind,
    pub runtime_id: String,
    pub display_name: String,
    #[serde(default)]
    pub commands: Vec<ProviderSlashCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRuntimeSlashCommandsListResponse {
    pub providers: Vec<ProviderRuntimeProviderSlashCommands>,
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
    pub source_turn_id: Option<String>,
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

fn provider_server_request_audit_from_value(
    value: serde_json::Value,
) -> ProviderServerRequestAudit {
    if value.is_null() {
        return ProviderServerRequestAudit::default();
    }
    serde_json::from_value(value.clone()).unwrap_or_else(|_| ProviderServerRequestAudit {
        metadata: value,
        ..ProviderServerRequestAudit::default()
    })
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
    #[serde(default)]
    pub bridges: Vec<ProviderHostToolBridgeSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderHostToolBridgeStatus {
    Connected,
    Unavailable,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderHostToolBridgeSummary {
    pub surface: ToolSurface,
    pub status: ProviderHostToolBridgeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descriptor_name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub actions: Vec<ToolActionKind>,
    #[serde(default)]
    pub capability_keys: Vec<String>,
}

impl ProviderHostToolBridgeSummary {
    #[must_use]
    pub fn from_host_tools(tools: &[HostToolDescriptor]) -> Vec<Self> {
        [ToolSurface::Browser, ToolSurface::Computer]
            .into_iter()
            .map(|surface| Self::from_surface(tools, surface))
            .collect()
    }

    #[must_use]
    pub fn from_surface(tools: &[HostToolDescriptor], surface: ToolSurface) -> Self {
        let descriptor = tools
            .iter()
            .find(|tool| tool.surface == surface && is_bridge_descriptor(tool));
        let Some(descriptor) = descriptor else {
            return Self {
                surface,
                status: ProviderHostToolBridgeStatus::Missing,
                descriptor_name: None,
                aliases: Vec::new(),
                actions: Vec::new(),
                capability_keys: Vec::new(),
            };
        };
        let capability_keys = descriptor
            .capabilities
            .iter()
            .map(|capability| capability.key.clone())
            .collect::<Vec<_>>();
        let status = if capability_keys
            .iter()
            .any(|key| key == "host_tool.bridge.status.unavailable")
        {
            ProviderHostToolBridgeStatus::Unavailable
        } else {
            ProviderHostToolBridgeStatus::Connected
        };
        Self {
            surface,
            status,
            descriptor_name: Some(descriptor.name.clone()),
            aliases: descriptor.aliases.clone(),
            actions: descriptor.actions.clone(),
            capability_keys,
        }
    }
}

fn is_bridge_descriptor(tool: &HostToolDescriptor) -> bool {
    tool.name.ends_with(".bridge")
        || tool
            .capabilities
            .iter()
            .any(|capability| capability.key.starts_with("host_tool.bridge.status."))
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

#[must_use]
pub fn capped_provider_server_requests_limit(limit: usize) -> usize {
    usize::min(limit, PROVIDER_RUNTIME_MAX_SERVER_REQUESTS_LIMIT)
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
    pub audit: ProviderServerRequestAudit,
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
    pub requested_limit: usize,
    pub effective_limit: usize,
    pub read_limit: usize,
    pub max_limit: usize,
    pub summary: ProviderServerRequestsSummary,
    pub requests: Vec<ProviderServerRequestRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderServerRequestsSummary {
    pub total: usize,
    pub pending: usize,
    pub resolved: usize,
    pub resolved_with_complete_audit: usize,
    pub resolved_missing_audit_context: usize,
    #[serde(default)]
    pub by_provider: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_kind: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_scope: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_selected_policy: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_decision_outcome: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_decider: Vec<ProviderRuntimeOperationCount>,
    #[serde(default)]
    pub by_missing_audit_field: Vec<ProviderRuntimeOperationCount>,
}

impl ProviderServerRequestsSummary {
    #[must_use]
    pub fn from_records(records: &[ProviderServerRequestRecord]) -> Self {
        let mut by_provider = BTreeMap::new();
        let mut by_kind = BTreeMap::new();
        let mut by_scope = BTreeMap::new();
        let mut by_selected_policy = BTreeMap::new();
        let mut by_decision_outcome = BTreeMap::new();
        let mut by_decider = BTreeMap::new();
        let mut by_missing_audit_field = BTreeMap::new();
        let mut summary = Self {
            total: records.len(),
            ..Self::default()
        };

        for record in records {
            increment_count(&mut by_provider, record.provider.clone());
            match record.status {
                ProviderServerRequestStatusFilter::Pending => summary.pending += 1,
                ProviderServerRequestStatusFilter::Resolved => summary.resolved += 1,
            }
            if let Some(request) = &record.request {
                increment_count(&mut by_kind, enum_key(&request.kind));
                if let Some(scope) = &request.scope {
                    increment_count(&mut by_scope, scope.clone());
                }
            }
            if let Some(policy) = selected_policy_for_server_request_record(record) {
                increment_count(&mut by_selected_policy, policy);
            }
            if let Some(decision) = &record.decision {
                increment_count(&mut by_decision_outcome, decision.outcome.clone());
                if let Some(decider) = &decision.audit.decided_by {
                    increment_count(&mut by_decider, decider.clone());
                }
                let missing_fields = missing_audit_context_fields(&decision.audit);
                if missing_fields.is_empty() {
                    summary.resolved_with_complete_audit += 1;
                } else {
                    summary.resolved_missing_audit_context += 1;
                    for field in missing_fields {
                        increment_count(&mut by_missing_audit_field, field.to_string());
                    }
                }
            }
        }

        summary.by_provider = operation_counts(by_provider);
        summary.by_kind = operation_counts(by_kind);
        summary.by_scope = operation_counts(by_scope);
        summary.by_selected_policy = operation_counts(by_selected_policy);
        summary.by_decision_outcome = operation_counts(by_decision_outcome);
        summary.by_decider = operation_counts(by_decider);
        summary.by_missing_audit_field = operation_counts(by_missing_audit_field);
        summary
    }
}

fn missing_audit_context_fields(audit: &ProviderServerRequestAudit) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if audit.scope.as_deref().is_none_or(str::is_empty) {
        missing.push("scope");
    }
    if audit.source_thread_id.as_deref().is_none_or(str::is_empty) {
        missing.push("source_thread_id");
    }
    if audit.source_item_id.as_deref().is_none_or(str::is_empty) {
        missing.push("source_item_id");
    }
    if audit.prompt.as_deref().is_none_or(str::is_empty) {
        missing.push("prompt");
    }
    if audit.selected_policy.as_deref().is_none_or(str::is_empty) {
        missing.push("selected_policy");
    }
    if audit.metadata.is_null() {
        missing.push("metadata");
    }
    missing
}

fn selected_policy_for_server_request_record(
    record: &ProviderServerRequestRecord,
) -> Option<String> {
    record
        .request
        .as_ref()
        .and_then(|request| request.selected_policy.clone())
        .or_else(|| {
            record
                .decision
                .as_ref()
                .and_then(|decision| decision.audit.selected_policy.clone())
        })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRuntimeEventBatch {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_persisted_sequence: Option<i64>,
    pub max_batch_size: usize,
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
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
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
        attachments: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_usage: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan_questions: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan_completion: Option<String>,
        #[serde(default, skip_serializing_if = "box_json_value_is_null")]
        metadata: Box<serde_json::Value>,
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
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status_text: Option<String>,
        #[serde(default, skip_serializing_if = "box_json_value_is_null")]
        metadata: Box<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<Box<ace_runtime::provider::ProviderMetadata>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        questions: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completion: Option<String>,
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
        relationship: ChildThreadRelationship,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nickname: Option<String>,
        status: ThreadItemStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status_text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_location: Option<ExecutionLocation>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ephemeral: Option<bool>,
        #[serde(default, skip_serializing_if = "box_json_value_is_null")]
        metadata: Box<serde_json::Value>,
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
    RemoteConnectionUpdated {
        provider: String,
        connection: RemoteConnectionRecord,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decision: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        action_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selected_policy: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decided_by: Option<String>,
        #[serde(default)]
        retryable: bool,
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
        decision: Box<ProviderServerRequestDecisionRecord>,
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
                decision: Box::new(ProviderServerRequestDecisionRecord {
                    outcome: decision.outcome,
                    payload: decision.payload,
                    audit: provider_server_request_audit_from_value(decision.audit),
                }),
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
            | Self::ToolApprovalRequested { tool } => projection_deltas_for_tool(tool, None),
            Self::ToolOutputDelta { tool, delta } => {
                projection_deltas_for_tool(tool, Some(delta.clone()))
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
                        title: item.title.clone(),
                        text: item.text.clone(),
                        status_text: item.status_text.clone(),
                        model: item.model.clone(),
                        target: item.target.clone(),
                        url: item.url.clone(),
                        files: item.files.clone(),
                        attachments: item.attachments.clone(),
                        diff: item.diff.clone(),
                        token_usage: item.token_usage.clone(),
                        plan_questions: item.plan_questions.clone(),
                        plan_completion: item.plan_completion.clone(),
                        metadata: Box::new(item.metadata.clone()),
                    });
                }
                if item.kind == ThreadItemKind::Plan {
                    deltas.push(ProviderRuntimeProjectionDelta::PlanUpdated {
                        provider: item.provider.provider.clone(),
                        thread_id: item.thread_id.clone(),
                        turn_id: item.turn_id.clone(),
                        item_id: item.item_id.clone(),
                        status: item.status,
                        title: item.title.clone(),
                        text: item.text.clone(),
                        status_text: item.status_text.clone(),
                        metadata: Box::new(item.metadata.clone()),
                        provider_metadata: Some(Box::new(item.provider.clone())),
                        questions: item.plan_questions.clone(),
                        completion: item.plan_completion.clone(),
                    });
                }
                if matches!(
                    item.kind,
                    ThreadItemKind::SubAgentActivity
                        | ThreadItemKind::CollabAgentToolCall
                        | ThreadItemKind::EnteredReviewMode
                ) && let (Some(parent_thread_id), Some(child_thread_id)) = (
                    item.parent_thread_id
                        .as_deref()
                        .or(item.thread_id.as_deref()),
                    item.child_thread_id.as_deref(),
                ) {
                    let relationship = if item.kind == ThreadItemKind::EnteredReviewMode {
                        ChildThreadRelationship::Review
                    } else {
                        ChildThreadRelationship::Subagent
                    };
                    deltas.push(ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                        provider: item.provider.provider.clone(),
                        parent_thread_id: parent_thread_id.to_string(),
                        child_thread_id: child_thread_id.to_string(),
                        relationship,
                        turn_id: item.turn_id.clone(),
                        item_id: item.item_id.clone(),
                        role: item.role.clone(),
                        nickname: item.sender.clone(),
                        status: item.status,
                        status_text: item.status_text.clone(),
                        execution_location: None,
                        ephemeral: None,
                        metadata: Box::new(item.metadata.clone()),
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
                    decision: decision.as_ref().clone(),
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
    item.title.is_some()
        || item.text.is_some()
        || item.status_text.is_some()
        || item.model.is_some()
        || item.target.is_some()
        || item.url.is_some()
        || item.files.is_some()
        || item.attachments.is_some()
        || item.diff.is_some()
        || item.token_usage.is_some()
        || item.plan_questions.is_some()
        || item.plan_completion.is_some()
        || has_meaningful_metadata(&item.metadata)
}

fn has_meaningful_metadata(metadata: &serde_json::Value) -> bool {
    match metadata {
        serde_json::Value::Null => false,
        serde_json::Value::Object(object) => !object.is_empty(),
        _ => true,
    }
}

fn box_json_value_is_null(value: &serde_json::Value) -> bool {
    value.is_null()
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

fn projection_deltas_for_tool(
    tool: &SemanticToolCall,
    explicit_delta: Option<String>,
) -> Vec<ProviderRuntimeProjectionDelta> {
    let mut deltas = vec![ProviderRuntimeProjectionDelta::ToolTimelineUpsert {
        tool: Box::new(tool.clone()),
    }];
    let Some(delta) = explicit_delta
        .or_else(|| tool_output_delta_text(tool))
        .filter(|delta| !delta.is_empty())
    else {
        return deltas;
    };
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
                text: delta,
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
                status: tool_status_to_thread_item_status(tool.display.status),
                diff: Some(delta),
                files: tool
                    .provider
                    .raw_args
                    .get("files")
                    .or_else(|| tool.provider.raw_payload.get("files"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            });
        }
        _ => {}
    }
    deltas
}

fn tool_status_to_thread_item_status(status: ToolRunStatus) -> ThreadItemStatus {
    match status {
        ToolRunStatus::Started => ThreadItemStatus::Started,
        ToolRunStatus::Updated | ToolRunStatus::ApprovalRequested => ThreadItemStatus::Updated,
        ToolRunStatus::Completed => ThreadItemStatus::Completed,
        ToolRunStatus::Failed => ThreadItemStatus::Failed,
    }
}

fn thread_item_status_from_handoff_status(status: HandoffStatus) -> ThreadItemStatus {
    match status {
        HandoffStatus::Requested | HandoffStatus::Interrupted | HandoffStatus::Transferring => {
            ThreadItemStatus::Updated
        }
        HandoffStatus::Completed => ThreadItemStatus::Completed,
        HandoffStatus::Failed => ThreadItemStatus::Failed,
    }
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
            let mut deltas = vec![ProviderRuntimeProjectionDelta::ProviderStateUpdated {
                provider: signal.provider.provider.clone(),
                status: signal
                    .status
                    .clone()
                    .unwrap_or_else(|| "provider_state_updated".to_string()),
                message: signal.message.clone(),
                name: signal.name.clone(),
                metadata: signal.metadata.clone(),
            }];
            if let Some(connection) = remote_connection_from_signal(signal) {
                deltas.push(ProviderRuntimeProjectionDelta::RemoteConnectionUpdated {
                    provider: signal.provider.provider.clone(),
                    connection,
                });
            }
            deltas
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
            let status = signal
                .status
                .clone()
                .unwrap_or_else(|| "auto_approval_review_updated".to_string());
            let decision = auto_approval_review_decision(Some(status.as_str()), &signal.metadata);
            let action_id = string_at(&signal.metadata, &["action_id", "actionId"]);
            let retryable = bool_at(&signal.metadata, &["retryable"]).unwrap_or_else(|| {
                action_id.is_some()
                    || decision
                        .as_deref()
                        .is_some_and(|decision| decision == "denied")
            });
            vec![ProviderRuntimeProjectionDelta::AutoApprovalReviewUpdated {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                turn_id: signal.turn_id.clone(),
                item_id: signal.item_id.clone(),
                status,
                message: signal.message.clone(),
                decision,
                action_id,
                request_id: signal
                    .request_id
                    .clone()
                    .or_else(|| string_at(&signal.metadata, &["request_id", "requestId"])),
                selected_policy: string_at(
                    &signal.metadata,
                    &[
                        "selected_policy",
                        "selectedPolicy",
                        "approval_policy",
                        "approvalPolicy",
                    ],
                ),
                decided_by: string_at(&signal.metadata, &["decided_by", "decidedBy"]),
                retryable,
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
            let mut deltas = vec![ProviderRuntimeProjectionDelta::HandoffUpdated {
                provider: signal.provider.provider.clone(),
                handoff: handoff.clone(),
            }];
            if let Some(child_thread_id) = handoff.target_thread_id.clone() {
                deltas.push(ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                    provider: signal.provider.provider.clone(),
                    parent_thread_id: handoff.source_thread_id.clone(),
                    child_thread_id,
                    relationship: ChildThreadRelationship::Handoff,
                    turn_id: signal.turn_id.clone(),
                    item_id: signal.item_id.clone(),
                    role: Some("handoff".to_string()),
                    nickname: None,
                    status: thread_item_status_from_handoff_status(handoff.status),
                    status_text: handoff
                        .transfer_status
                        .clone()
                        .or_else(|| signal.status.clone()),
                    execution_location: Some(handoff.target_location),
                    ephemeral: None,
                    metadata: Box::new(handoff.metadata.clone()),
                });
            }
            deltas
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
                    parent_thread_id: fork.parent_thread_id.clone(),
                    child_thread_id: fork.child_thread_id.clone(),
                    relationship: ChildThreadRelationship::Fork,
                    turn_id: fork.turn_id.clone().or_else(|| signal.turn_id.clone()),
                    item_id: signal.item_id.clone(),
                    role: None,
                    nickname: None,
                    status: ThreadItemStatus::Completed,
                    status_text: signal.status.clone(),
                    execution_location: None,
                    ephemeral: None,
                    metadata: Box::new(signal.metadata.clone()),
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
                    parent_thread_id: side_chat.parent_thread_id.clone(),
                    child_thread_id: side_chat.thread_id.clone(),
                    relationship: ChildThreadRelationship::SideChat,
                    turn_id: signal.turn_id.clone(),
                    item_id: signal.item_id.clone(),
                    role: Some("side_chat".to_string()),
                    nickname: None,
                    status: ThreadItemStatus::Completed,
                    status_text: signal.status.clone(),
                    execution_location: None,
                    ephemeral: Some(side_chat.ephemeral),
                    metadata: Box::new(signal.metadata.clone()),
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

fn remote_connection_from_signal(
    signal: &NormalizedRuntimeSignal,
) -> Option<RemoteConnectionRecord> {
    if signal.provider.method.as_deref() != Some("remoteControl/status/changed") {
        return None;
    }
    let payload = &signal.provider.raw_payload;
    let host = string_at(
        payload,
        &["host", "hostname", "hostName", "sshHost", "alias"],
    );
    let display_name = signal
        .name
        .clone()
        .or_else(|| string_at(payload, &["displayName", "display_name", "name", "title"]));
    let host_id = string_at(
        payload,
        &["id", "hostId", "host_id", "connectionId", "deviceId"],
    )
    .or_else(|| host.clone())
    .or_else(|| display_name.clone())
    .unwrap_or_else(|| "remote_control".to_string());

    Some(RemoteConnectionRecord {
        provider: signal.provider.provider.clone(),
        host_id,
        host,
        display_name,
        status: signal.status.clone(),
        execution_location: execution_location_from_remote_payload(payload),
        projects: payload
            .get("projects")
            .or_else(|| payload.get("savedProjects"))
            .or_else(|| payload.get("saved_projects"))
            .or_else(|| payload.get("repositories"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        metadata: signal.metadata.clone(),
    })
}

fn execution_location_from_remote_payload(value: &serde_json::Value) -> ExecutionLocation {
    match string_at(
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

fn bool_at(value: &serde_json::Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_bool))
}

fn auto_approval_review_decision(
    status: Option<&str>,
    metadata: &serde_json::Value,
) -> Option<String> {
    [
        string_at(metadata, &["decision"]),
        string_at(metadata, &["outcome"]),
        string_at(metadata, &["result"]),
        status.map(str::to_string),
    ]
    .into_iter()
    .flatten()
    .map(|decision| decision.trim().to_string())
    .find(|decision| !decision.is_empty())
    .map(|decision| normalize_auto_approval_decision(&decision))
}

fn normalize_auto_approval_decision(decision: &str) -> String {
    let normalized = decision.trim().to_ascii_lowercase().replace('-', "_");
    if matches!(
        normalized.as_str(),
        "approved" | "allow" | "allowed" | "accepted" | "pass" | "passed"
    ) {
        "approved".to_string()
    } else if matches!(
        normalized.as_str(),
        "denied" | "deny" | "rejected" | "reject" | "blocked" | "failed" | "disallowed"
    ) {
        "denied".to_string()
    } else {
        normalized
    }
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
    use ace_runtime::threads::{
        AgentRuntimeSnapshot, AgentThread, ChildThreadRecord, ChildThreadRelationship,
        ExecutionLocation, GoalState, GoalStatus, HandoffPlan, HandoffStatus,
        PlanImplementationMode, PlanImplementationRecord, PlanSession, PlanSessionStatus,
        RealtimeAudioRecord, RealtimeTranscriptRecord, SubagentActionKind, SubagentActionRecord,
        RemoteConnectionRecord, TerminalOutputRecord, ThreadLifecycleActionKind,
        ThreadLifecycleRecord, Turn, TurnMode,
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

        let resolve = serde_json::from_value::<ProviderRuntimeRequestResolveRequest>(json!({
            "provider": "codex",
            "operation": "thread_read"
        }))
        .expect("resolve request");
        assert_eq!(resolve.provider, "codex");
        assert_eq!(resolve.method, None);
        assert_eq!(
            resolve.operation,
            Some(ProviderAdapterOperation::ThreadRead)
        );

        let response = ProviderRuntimeRequestResolveResponse {
            provider: ProviderKind::Codex,
            runtime_id: "codex".to_string(),
            display_name: "Codex".to_string(),
            requested_method: None,
            operation: Some(ProviderAdapterOperation::ThreadRead),
            provider_method: Some("thread/read".to_string()),
            typed_ws_method: None,
            runtime_request: ProviderRuntimeOperationRequest::operation(
                ProviderRuntimeOperationParams::AdapterNormalized,
            ),
            operation_profile: None,
        };
        let encoded = serde_json::to_value(&response).expect("resolve response");
        assert_eq!(encoded["runtime_id"], "codex");
        assert_eq!(encoded["provider_method"], "thread/read");
        assert_eq!(encoded["runtime_request"]["mode"], "adapter_operation");

        let batch = serde_json::from_value::<ProviderRuntimeRequestResolveBatchRequest>(json!({
            "provider": "codex",
            "requests": [
                { "request_id": "read", "operation": "thread_read" },
                { "request_id": "raw", "method": "remote/connectionList" }
            ]
        }))
        .expect("batch resolve request");
        assert_eq!(batch.provider, "codex");
        assert_eq!(batch.requests.len(), 2);
        assert_eq!(batch.requests[0].request_id.as_deref(), Some("read"));
        assert_eq!(
            batch.requests[0].operation,
            Some(ProviderAdapterOperation::ThreadRead)
        );

        let batch_response = ProviderRuntimeRequestResolveBatchResponse {
            provider: ProviderKind::Codex,
            runtime_id: "codex".to_string(),
            display_name: "Codex".to_string(),
            requested_count: 2,
            max_requests: PROVIDER_RUNTIME_MAX_REQUEST_RESOLVE_BATCH_SIZE,
            responses: vec![ProviderRuntimeRequestResolveBatchItemResponse {
                request_id: Some("read".to_string()),
                resolution: response,
            }],
        };
        let encoded = serde_json::to_value(&batch_response).expect("batch resolve response");
        assert_eq!(encoded["responses"][0]["request_id"], "read");
        assert_eq!(
            encoded["responses"][0]["resolution"]["runtime_request"]["params"],
            "adapter_normalized"
        );
    }

    #[test]
    fn provider_runtime_recent_events_use_compact_raw_payloads_by_default() {
        let request = serde_json::from_value::<ProviderRuntimeRecentEventsRequest>(json!({
            "provider": "codex"
        }))
        .expect("recent request");
        assert_eq!(request.raw_event_mode, ProviderRuntimeRawEventMode::Compact);
        assert_eq!(request.limit, default_recent_events_limit());
        assert_eq!(
            capped_provider_runtime_events_limit(usize::MAX),
            PROVIDER_RUNTIME_MAX_EVENTS_REPLAY_LIMIT
        );
        let subscribe = serde_json::from_value::<ProviderRuntimeSubscribeRequest>(json!({
            "provider": "codex"
        }))
        .expect("subscribe request");
        assert_eq!(
            subscribe.raw_event_mode,
            ProviderRuntimeRawEventMode::Compact
        );
        assert_eq!(subscribe.replay_limit, default_recent_events_limit());

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
            last_persisted_sequence: Some(1),
            max_batch_size: PROVIDER_RUNTIME_MAX_EVENT_BATCH_SIZE,
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
        assert_eq!(encoded["last_persisted_sequence"], 1);
        assert_eq!(
            encoded["max_batch_size"],
            PROVIDER_RUNTIME_MAX_EVENT_BATCH_SIZE
        );
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

        let response = ProviderRuntimeRecentEventsResponse {
            requested_limit: usize::MAX,
            effective_limit: capped_provider_runtime_events_limit(usize::MAX),
            max_limit: PROVIDER_RUNTIME_MAX_EVENTS_REPLAY_LIMIT,
            records: vec![full_record],
        };
        let encoded = serde_json::to_value(&response).expect("recent response");
        assert_eq!(encoded["requested_limit"], usize::MAX);
        assert_eq!(
            encoded["effective_limit"],
            PROVIDER_RUNTIME_MAX_EVENTS_REPLAY_LIMIT
        );
        assert_eq!(
            encoded["max_limit"],
            PROVIDER_RUNTIME_MAX_EVENTS_REPLAY_LIMIT
        );
        assert_eq!(
            encoded["records"][0]["raw_event"]["type"],
            "raw_notification"
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
        assert_eq!(direct.policy_summary.key, "read_only");
        assert_eq!(direct.policy_summary.title, "Read only");
        assert!(!direct.policy_summary.approval_required);
        assert_eq!(direct.policy_summary.badges, vec!["read_only"]);
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

        for normalization_operation in [
            ProviderAdapterOperation::ToolEventNormalize,
            ProviderAdapterOperation::ServerRequestNormalize,
            ProviderAdapterOperation::ThreadItemNormalize,
            ProviderAdapterOperation::RuntimeSignalNormalize,
        ] {
            let operation = operation(normalization_operation);
            assert_eq!(
                operation.invocation,
                ProviderAdapterInvocationKind::EventStream
            );
            assert_eq!(
                operation.availability,
                ProviderAdapterOperationAvailability::Available
            );
            assert!(!operation.direct_invocation);
            assert!(operation.provider_methods.is_empty());
            assert!(!operation.runtime_request.invokable);
            assert_eq!(
                operation.runtime_request.mode,
                ProviderRuntimeOperationRequestMode::EventStream
            );
            assert_eq!(
                operation.required_runtime_hooks,
                vec![ProviderAdapterRuntimeHook::EventSource]
            );
        }

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
        assert_eq!(
            version_gated.policy_summary.key,
            "approval_external_workspace"
        );
        assert!(version_gated.policy_summary.approval_required);
        assert!(
            version_gated
                .policy_summary
                .badges
                .contains(&"workspace".to_string())
        );
        assert!(
            version_gated
                .policy_summary
                .badges
                .contains(&"external".to_string())
        );
        assert!(
            version_gated
                .policy_summary
                .badges
                .contains(&"approval".to_string())
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

        let browser_bridge = operation(ProviderAdapterOperation::BrowserBridgeContract);
        assert_eq!(
            browser_bridge.invocation,
            ProviderAdapterInvocationKind::HostToolContract
        );
        assert_eq!(browser_bridge.category, ProviderFeatureCategory::Tools);
        assert_eq!(
            browser_bridge.availability,
            ProviderAdapterOperationAvailability::Available
        );
        assert_eq!(
            browser_bridge.required_runtime_hooks,
            vec![ProviderAdapterRuntimeHook::HostToolRegistry]
        );
        assert_eq!(browser_bridge.policy_summary.key, "approval_external");
        assert!(!browser_bridge.runtime_request.invokable);
        assert_eq!(
            browser_bridge.runtime_request.mode,
            ProviderRuntimeOperationRequestMode::HostTool
        );
    }

    #[test]
    fn provider_runtime_operation_summary_counts_gate_and_request_state() {
        let contract = ace_runtime::provider::ace_provider_adapter_contract();
        let operation = |target| {
            contract
                .operations
                .iter()
                .find(|operation| operation.operation == target)
                .map(ProviderRuntimeProviderOperation::from_spec)
                .expect("operation")
        };

        let mut direct = operation(ProviderAdapterOperation::ThreadRead);
        direct.runtime_request = ProviderRuntimeOperationRequest::operation(
            ProviderRuntimeOperationParams::AdapterNormalized,
        );

        let mut unavailable_gated = operation(ProviderAdapterOperation::ThreadShellCommand);
        unavailable_gated.runtime_gate_resolution = Some(ProviderRuntimeOperationGateResolution {
            status: ProviderRuntimeOperationGateStatus::Unavailable,
            provider_methods: vec!["thread/shellCommand".to_string()],
            missing_provider_methods: vec!["thread/shellCommand".to_string()],
            source: Some("supported_client_request_methods".to_string()),
            reason: "missing provider method".to_string(),
        });
        unavailable_gated.runtime_request = ProviderRuntimeOperationRequest::unavailable(
            ProviderRuntimeOperationRequestMode::AdapterOperation,
            "missing provider method",
        );
        unavailable_gated.missing_runtime_hooks =
            vec![ProviderAdapterRuntimeHook::HostToolRegistry];

        let event_stream = operation(ProviderAdapterOperation::ProviderEvents);
        let summary = ProviderRuntimeOperationSummary::from_operations(&[
            direct,
            unavailable_gated,
            event_stream,
        ]);
        let count = |counts: &[ProviderRuntimeOperationCount], key: &str| {
            counts
                .iter()
                .find(|count| count.key == key)
                .map(|count| count.count)
                .unwrap_or_default()
        };

        assert_eq!(summary.total, 3);
        assert_eq!(summary.invokable, 1);
        assert_eq!(summary.unavailable, 2);
        assert_eq!(summary.direct_invocation, 2);
        assert_eq!(summary.gated, 1);
        assert_eq!(summary.gate_available, 0);
        assert_eq!(summary.gate_unavailable, 1);
        assert_eq!(summary.gate_unknown, 0);
        assert_eq!(summary.missing_provider_methods, ["thread/shellCommand"]);
        assert_eq!(summary.missing_runtime_hooks, ["host_tool_registry"]);
        assert_eq!(count(&summary.by_category, "threads"), 1);
        assert_eq!(count(&summary.by_category, "tools"), 1);
        assert_eq!(count(&summary.by_category, "events"), 1);
        assert_eq!(count(&summary.by_support, "required"), 2);
        assert_eq!(count(&summary.by_support, "version_gated"), 1);
        assert_eq!(count(&summary.by_availability, "available"), 2);
        assert_eq!(count(&summary.by_availability, "version_gated"), 1);
        assert_eq!(count(&summary.by_request_mode, "adapter_operation"), 2);
        assert_eq!(count(&summary.by_request_mode, "event_stream"), 1);
        assert_eq!(count(&summary.by_policy, "read_only"), 2);
        assert_eq!(count(&summary.by_policy, "sandbox_escape"), 1);
    }

    #[test]
    fn provider_runtime_provider_info_summary_counts_contract_surfaces() {
        let descriptor = ace_runtime::provider::ProviderDescriptor {
            kind: ProviderKind::Cursor,
            capabilities: vec![ace_core::ProviderCapability {
                key: "provider.adapter_contract".to_string(),
                version: 1,
            }],
        };
        let contract = ace_runtime::provider::ProviderContractReport {
            provider: ProviderKind::Cursor,
            satisfies_required: false,
            requirements: Vec::new(),
            capabilities: descriptor.capabilities.clone(),
            missing_required: vec!["provider.normalized_events".to_string()],
        };
        let adapter_profile = ace_runtime::provider::provider_adapter_profile(&descriptor);
        let adapter_runtime = ace_runtime::provider::ProviderAdapterRuntimeReport {
            provider: ProviderKind::Cursor,
            satisfies_required_hooks: false,
            hooks: Vec::new(),
            feature_families: vec![
                ace_runtime::provider::ProviderAdapterFeatureFamilyRuntime {
                    category: ProviderFeatureCategory::Threads,
                    total_operations: 3,
                    hook_ready_operations: 3,
                    hook_blocked_operations: 0,
                    required_hooks: Vec::new(),
                    missing_hooks: Vec::new(),
                    operations: Vec::new(),
                },
                ace_runtime::provider::ProviderAdapterFeatureFamilyRuntime {
                    category: ProviderFeatureCategory::Events,
                    total_operations: 2,
                    hook_ready_operations: 0,
                    hook_blocked_operations: 2,
                    required_hooks: vec![ProviderAdapterRuntimeHook::EventSource],
                    missing_hooks: vec![ProviderAdapterRuntimeHook::EventSource],
                    operations: Vec::new(),
                },
            ],
            missing_required_hooks: vec![ProviderAdapterRuntimeHook::EventSource],
        };

        let summary = ProviderRuntimeProviderInfoSummary::from_parts(
            &descriptor,
            &contract,
            &adapter_profile,
            &adapter_runtime,
            ProviderRuntimeProviderSurfaceSupport {
                events: true,
                server_request_responses: false,
                state_snapshots: true,
                host_tools: false,
            },
        );
        assert!(!summary.selectable);
        assert!(!summary.contract_satisfied);
        assert!(!summary.runtime_hooks_satisfied);
        assert!(summary.supports_events);
        assert!(!summary.supports_server_request_responses);
        assert!(summary.supports_state_snapshots);
        assert!(!summary.supports_host_tools);
        assert_eq!(summary.runtime_ready_feature_families, 1);
        assert_eq!(summary.runtime_blocked_feature_families, 1);
        assert!(summary.required_operations > 0);
        assert!(summary.optional_operations > 0);
        assert!(summary.version_gated_operations > 0);
        assert!(summary.deferred_operations > 0);
        assert_eq!(
            summary.missing_required_capabilities,
            ["provider.normalized_events"]
        );
        assert_eq!(summary.missing_required_hooks, ["event_source"]);
        assert_eq!(summary.native_capabilities, ["provider.adapter_contract"]);
    }

    #[test]
    fn provider_runtime_status_summary_normalizes_health_and_inventory() {
        let status = ace_runtime::provider::ProviderDriverStatus {
            health: ProviderRuntimeHealth::Running,
            transport: Some("stdio".to_string()),
            version: Some("1.2.3".to_string()),
            initialized: true,
            last_error: None,
            metadata: json!({
                "method_inventory": {
                    "source": "generated_schema",
                    "client_request_methods": ["thread/read", "turn/start"],
                    "version_gated_client_request_methods": ["process/spawn"],
                    "deferred_client_request_methods": ["cloud/handoff"]
                }
            }),
        };
        let contract = ace_runtime::provider::ProviderContractReport {
            provider: ProviderKind::Codex,
            satisfies_required: true,
            requirements: Vec::new(),
            capabilities: Vec::new(),
            missing_required: Vec::new(),
        };
        let runtime = ace_runtime::provider::ProviderAdapterRuntimeReport {
            provider: ProviderKind::Codex,
            satisfies_required_hooks: true,
            hooks: Vec::new(),
            feature_families: vec![ace_runtime::provider::ProviderAdapterFeatureFamilyRuntime {
                category: ProviderFeatureCategory::Threads,
                total_operations: 3,
                hook_ready_operations: 3,
                hook_blocked_operations: 0,
                required_hooks: Vec::new(),
                missing_hooks: Vec::new(),
                operations: Vec::new(),
            }],
            missing_required_hooks: Vec::new(),
        };

        let summary = ProviderRuntimeProviderStatusSummary::from_status(
            &status, true, true, &contract, &runtime,
        );
        assert_eq!(summary.health, ProviderRuntimeHealth::Running);
        assert!(summary.ready);
        assert!(summary.initialized);
        assert_eq!(summary.transport.as_deref(), Some("stdio"));
        assert_eq!(summary.version.as_deref(), Some("1.2.3"));
        assert_eq!(
            summary.method_inventory_source.as_deref(),
            Some("generated_schema")
        );
        assert_eq!(summary.advertised_client_request_methods, 2);
        assert_eq!(summary.version_gated_client_request_methods, 1);
        assert_eq!(summary.deferred_client_request_methods, 1);
        assert_eq!(summary.runtime_ready_feature_families, 1);
        assert_eq!(summary.runtime_blocked_feature_families, 0);

        let degraded_contract = ace_runtime::provider::ProviderContractReport {
            satisfies_required: false,
            missing_required: vec!["provider.normalized_events".to_string()],
            ..contract
        };
        let degraded_runtime = ace_runtime::provider::ProviderAdapterRuntimeReport {
            satisfies_required_hooks: false,
            missing_required_hooks: vec![ProviderAdapterRuntimeHook::EventSource],
            feature_families: Vec::new(),
            ..runtime
        };
        let degraded = ProviderRuntimeProviderStatusSummary::from_status(
            &status,
            false,
            false,
            &degraded_contract,
            &degraded_runtime,
        );
        assert!(!degraded.ready);
        assert!(!degraded.supports_events);
        assert!(!degraded.supports_server_request_responses);
        assert_eq!(
            degraded.missing_required_capabilities,
            ["provider.normalized_events"]
        );
        assert_eq!(degraded.missing_required_hooks, ["event_source"]);
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
        assert_eq!(
            capped_provider_server_requests_limit(usize::MAX),
            PROVIDER_RUNTIME_MAX_SERVER_REQUESTS_LIMIT
        );

        let encoded = serde_json::to_value(request).expect("encode request");
        assert_eq!(encoded["kind"], "file_change_approval");
        assert_eq!(encoded["thread_id"], "thread-2");

        let records = vec![
            ProviderServerRequestRecord {
                provider: "codex".to_string(),
                request_id: "approval-1".to_string(),
                request: Some(NormalizedServerRequest {
                    kind: ServerRequestKind::FileChangeApproval,
                    request_id: "approval-1".to_string(),
                    method: "fileChange/approvalRequest".to_string(),
                    thread_id: Some("thread-2".to_string()),
                    turn_id: None,
                    item_id: None,
                    scope: Some("filesystem".to_string()),
                    title: Some("Approve file changes".to_string()),
                    prompt: Some("Apply patch?".to_string()),
                    selected_policy: Some("on-request".to_string()),
                    detail: Default::default(),
                    metadata: json!({ "path": "src/lib.rs" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("fileChange/approvalRequest".to_string()),
                        schema_version: None,
                        raw_payload: json!({ "path": "src/lib.rs" }),
                    },
                }),
                status: ProviderServerRequestStatusFilter::Pending,
                decision: None,
                created_at: "2026-06-24T00:00:00Z".to_string(),
                resolved_at: None,
            },
            ProviderServerRequestRecord {
                provider: "codex".to_string(),
                request_id: "approval-2".to_string(),
                request: Some(NormalizedServerRequest {
                    kind: ServerRequestKind::CommandApproval,
                    request_id: "approval-2".to_string(),
                    method: "command/approvalRequest".to_string(),
                    thread_id: Some("thread-2".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: Some("item-1".to_string()),
                    scope: Some("command".to_string()),
                    title: Some("Approve command".to_string()),
                    prompt: Some("Run tests?".to_string()),
                    selected_policy: Some("on-request".to_string()),
                    detail: Default::default(),
                    metadata: json!({ "command": "cargo test" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("command/approvalRequest".to_string()),
                        schema_version: None,
                        raw_payload: json!({ "command": "cargo test" }),
                    },
                }),
                status: ProviderServerRequestStatusFilter::Resolved,
                decision: Some(ProviderServerRequestDecisionRecord {
                    outcome: "result".to_string(),
                    payload: json!({ "approved": true }),
                    audit: ProviderServerRequestAudit {
                        selected_policy: Some("on-request".to_string()),
                        decided_by: Some("user".to_string()),
                        ..ProviderServerRequestAudit::default()
                    },
                }),
                created_at: "2026-06-24T00:01:00Z".to_string(),
                resolved_at: Some("2026-06-24T00:02:00Z".to_string()),
            },
            ProviderServerRequestRecord {
                provider: "codex".to_string(),
                request_id: "approval-3".to_string(),
                request: None,
                status: ProviderServerRequestStatusFilter::Resolved,
                decision: Some(ProviderServerRequestDecisionRecord {
                    outcome: "error".to_string(),
                    payload: json!({ "message": "auto-review denied" }),
                    audit: ProviderServerRequestAudit {
                        selected_policy: Some("auto-review".to_string()),
                        decided_by: Some("auto_review".to_string()),
                        ..ProviderServerRequestAudit::default()
                    },
                }),
                created_at: "2026-06-24T00:03:00Z".to_string(),
                resolved_at: Some("2026-06-24T00:04:00Z".to_string()),
            },
        ];
        let response = ProviderServerRequestsListResponse {
            requested_limit: usize::MAX,
            effective_limit: capped_provider_server_requests_limit(usize::MAX),
            read_limit: PROVIDER_RUNTIME_MAX_SERVER_REQUESTS_LIMIT,
            max_limit: PROVIDER_RUNTIME_MAX_SERVER_REQUESTS_LIMIT,
            summary: ProviderServerRequestsSummary::from_records(&records),
            requests: records,
        };
        let encoded = serde_json::to_value(response).expect("encode response");
        assert_eq!(encoded["requested_limit"], usize::MAX);
        assert_eq!(
            encoded["effective_limit"],
            PROVIDER_RUNTIME_MAX_SERVER_REQUESTS_LIMIT
        );
        assert_eq!(
            encoded["read_limit"],
            PROVIDER_RUNTIME_MAX_SERVER_REQUESTS_LIMIT
        );
        assert_eq!(
            encoded["max_limit"],
            PROVIDER_RUNTIME_MAX_SERVER_REQUESTS_LIMIT
        );
        assert_eq!(encoded["summary"]["total"], 3);
        assert_eq!(encoded["summary"]["pending"], 1);
        assert_eq!(encoded["summary"]["resolved"], 2);
        assert_eq!(encoded["summary"]["resolved_with_complete_audit"], 0);
        assert_eq!(encoded["summary"]["resolved_missing_audit_context"], 2);
        assert_eq!(encoded["summary"]["by_provider"][0]["key"], "codex");
        assert_eq!(encoded["summary"]["by_kind"][0]["key"], "command_approval");
        assert_eq!(encoded["summary"]["by_kind"][0]["count"], 1);
        assert_eq!(
            encoded["summary"]["by_kind"][1]["key"],
            "file_change_approval"
        );
        assert_eq!(encoded["summary"]["by_scope"][0]["key"], "command");
        assert_eq!(encoded["summary"]["by_scope"][1]["key"], "filesystem");
        assert_eq!(
            encoded["summary"]["by_selected_policy"][0]["key"],
            "auto-review"
        );
        assert_eq!(encoded["summary"]["by_selected_policy"][0]["count"], 1);
        assert_eq!(
            encoded["summary"]["by_selected_policy"][1]["key"],
            "on-request"
        );
        assert_eq!(encoded["summary"]["by_selected_policy"][1]["count"], 2);
        assert_eq!(encoded["summary"]["by_decision_outcome"][0]["key"], "error");
        assert_eq!(encoded["summary"]["by_decision_outcome"][0]["count"], 1);
        assert_eq!(
            encoded["summary"]["by_decision_outcome"][1]["key"],
            "result"
        );
        assert_eq!(encoded["summary"]["by_decider"][0]["key"], "auto_review");
        assert_eq!(encoded["summary"]["by_decider"][1]["key"], "user");
        assert!(
            encoded["summary"]["by_missing_audit_field"]
                .as_array()
                .expect("missing audit fields")
                .iter()
                .any(|field| field["key"] == "scope" && field["count"] == 2)
        );
        assert!(
            encoded["summary"]["by_missing_audit_field"]
                .as_array()
                .expect("missing audit fields")
                .iter()
                .any(|field| field["key"] == "metadata" && field["count"] == 2)
        );
    }

    #[test]
    fn provider_runtime_state_summary_counts_projection_buckets() {
        let mut provider = ProviderToolMetadata::new();
        provider.provider = Some("codex".to_string());
        provider.method = Some("tool/call".to_string());
        provider.tool_name = Some("shell".to_string());
        provider.operation = Some("command/exec".to_string());
        provider.raw_args = json!({ "command": "cargo test" });
        let tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Process,
            status: ToolRunStatus::ApprovalRequested,
            provider,
            item_type: Some("commandExecution".to_string()),
        });
        let mut image_provider = ProviderToolMetadata::new();
        image_provider.provider = Some("codex".to_string());
        image_provider.method = Some("item/imageView".to_string());
        image_provider.raw_result = json!({
            "url": "https://private-user-images.githubusercontent.com/1/example.png"
        });
        let image_tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::CodexBuiltin,
            status: ToolRunStatus::Completed,
            provider: image_provider,
            item_type: Some("imageView".to_string()),
        });

        let snapshot = AgentRuntimeSnapshot {
            threads: vec![
                AgentThread {
                    thread_id: "thread-1".to_string(),
                    provider: "codex".to_string(),
                    execution_location: ExecutionLocation::Local,
                    name: Some("Main".to_string()),
                    active: Some(true),
                    archived: Some(false),
                    active_turn: None,
                    plan_session: None,
                    settings: json!(null),
                    token_usage: json!(null),
                    metadata: json!({}),
                },
                AgentThread {
                    thread_id: "thread-2".to_string(),
                    provider: "codex".to_string(),
                    execution_location: ExecutionLocation::Worktree,
                    name: None,
                    active: Some(false),
                    archived: Some(true),
                    active_turn: None,
                    plan_session: None,
                    settings: json!(null),
                    token_usage: json!(null),
                    metadata: json!({}),
                },
            ],
            child_threads: vec![ChildThreadRecord {
                provider: "codex".to_string(),
                parent_thread_id: "thread-1".to_string(),
                thread_id: "child-1".to_string(),
                relationship: ChildThreadRelationship::Subagent,
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                role: Some("reviewer".to_string()),
                nickname: Some("Review".to_string()),
                status: Some("running".to_string()),
                execution_location: Some(ExecutionLocation::Worktree),
                ephemeral: Some(false),
                metadata: json!({ "status": "started" }),
            }],
            active_turns: vec![Turn {
                thread_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                mode: TurnMode::Plan,
                active: true,
            }],
            plan_sessions: vec![PlanSession {
                thread_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("plan-1".to_string()),
                status: PlanSessionStatus::Implementing,
                title: Some("Plan".to_string()),
                text: Some("Plan".to_string()),
                status_text: None,
                questions: None,
                completion: None,
                metadata: json!({}),
                provider: None,
            }],
            goals: vec![GoalState {
                thread_id: "thread-1".to_string(),
                status: GoalStatus::Paused,
                objective: Some("Ship".to_string()),
                token_budget: Some(100),
                tokens_used: Some(10),
                time_used_seconds: Some(5),
            }],
            handoffs: vec![HandoffPlan {
                source_thread_id: "thread-1".to_string(),
                target_location: ExecutionLocation::Worktree,
                status: HandoffStatus::Transferring,
                target_thread_id: Some("thread-2".to_string()),
                repo_root: None,
                worktree_path: None,
                branch: Some("feature/runtime".to_string()),
                start_point: None,
                checkpoint_ref: None,
                remote_host: None,
                transfer_status: Some("copying".to_string()),
                interrupted_active_turn: Some(true),
                metadata: json!({}),
            }],
            thread_lifecycle: vec![ThreadLifecycleRecord {
                thread_id: "thread-1".to_string(),
                action: ThreadLifecycleActionKind::Rollback,
                turn_id: Some("turn-1".to_string()),
                name: None,
                item_count: None,
                request: json!({}),
                provider_response: json!({}),
            }],
            subagent_actions: vec![SubagentActionRecord {
                parent_thread_id: "thread-1".to_string(),
                subagent_thread_id: "child-1".to_string(),
                action: SubagentActionKind::Steer,
                prompt: Some("Focus on tests".to_string()),
                provider_response: json!({}),
            }],
            plan_implementations: vec![PlanImplementationRecord {
                parent_thread_id: "thread-1".to_string(),
                target_thread_id: "child-1".to_string(),
                mode: PlanImplementationMode::ForkForImplementation,
                prompt: "Implement this plan".to_string(),
                model: Some("gpt-5".to_string()),
                reasoning_effort: Some("high".to_string()),
                cwd: Some("/repo".to_string()),
                plan: json!({ "item_id": "plan-1" }),
                sandbox_policy: json!({ "mode": "workspace-write" }),
                approval_policy: json!({ "mode": "on-request" }),
                approvals_reviewer: Some("user".to_string()),
                provider_response: json!({ "forked": true }),
            }],
            tool_timeline: vec![tool, image_tool],
            terminal_outputs: vec![
                TerminalOutputRecord {
                    provider: "codex".to_string(),
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: Some("cmd-1".to_string()),
                    process_id: Some("proc-1".to_string()),
                    text: "kept output".to_string(),
                    truncated_bytes: 8,
                },
                TerminalOutputRecord {
                    provider: "codex".to_string(),
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: Some("cmd-2".to_string()),
                    process_id: Some("proc-2".to_string()),
                    text: "short output".to_string(),
                    truncated_bytes: 0,
                },
            ],
            realtime_transcripts: vec![RealtimeTranscriptRecord {
                provider: "codex".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                text: "partial transcript".to_string(),
                truncated_bytes: 13,
            }],
            realtime_audio: vec![RealtimeAudioRecord {
                provider: "codex".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                chunks: vec!["audio-final".to_string()],
                truncated_chunks: 3,
            }],
            thread_items: vec![
                NormalizedThreadItem {
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
                    text: Some("Implement".to_string()),
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
                    provider: provider_metadata("item/plan/delta"),
                },
                NormalizedThreadItem {
                    kind: ThreadItemKind::CommandExecution,
                    status: ThreadItemStatus::Completed,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: Some("cmd-1".to_string()),
                    parent_thread_id: None,
                    child_thread_id: None,
                    sender: None,
                    role: None,
                    title: Some("Ran cargo test".to_string()),
                    text: None,
                    status_text: None,
                    model: None,
                    target: Some("cargo test".to_string()),
                    url: None,
                    files: None,
                    attachments: None,
                    diff: None,
                    token_usage: None,
                    plan_questions: None,
                    plan_completion: None,
                    metadata: json!({}),
                    provider: provider_metadata("item/completed"),
                },
            ],
            ..AgentRuntimeSnapshot::default()
        };

        let summary = ProviderRuntimeStateSummary::from_snapshot(&snapshot);
        let count = |bucket: &[ProviderRuntimeOperationCount], key: &str| {
            bucket
                .iter()
                .find(|entry| entry.key == key)
                .map_or(0, |entry| entry.count)
        };

        assert_eq!(summary.threads, 2);
        assert_eq!(summary.active_threads, 1);
        assert_eq!(summary.archived_threads, 1);
        assert_eq!(summary.active_turns, 1);
        assert_eq!(summary.active_plan_sessions, 0);
        assert_eq!(summary.completed_plan_sessions, 0);
        assert_eq!(summary.rejected_plan_sessions, 0);
        assert_eq!(summary.implementing_plan_sessions, 1);
        assert_eq!(summary.goals, 1);
        assert_eq!(summary.active_goals, 0);
        assert_eq!(summary.paused_goals, 1);
        assert_eq!(summary.blocked_goals, 0);
        assert_eq!(summary.usage_limited_goals, 0);
        assert_eq!(summary.budget_limited_goals, 0);
        assert_eq!(summary.complete_goals, 0);
        assert_eq!(summary.cleared_goals, 0);
        assert_eq!(summary.goals_with_token_budget, 1);
        assert_eq!(summary.goal_token_budget_total, 100);
        assert_eq!(summary.goal_tokens_used_total, 10);
        assert_eq!(summary.goal_time_used_seconds_total, 5);
        assert_eq!(summary.goals_over_token_budget, 0);
        assert_eq!(summary.child_threads, 1);
        assert_eq!(summary.active_child_threads, 1);
        assert_eq!(summary.ephemeral_child_threads, 0);
        assert_eq!(summary.persistent_child_threads, 1);
        assert_eq!(summary.ephemeral_side_chats, 0);
        assert_eq!(summary.persistent_side_chats, 0);
        assert_eq!(summary.interrupted_handoffs, 1);
        assert_eq!(summary.plan_implementations, 1);
        assert_eq!(summary.terminal_outputs, 2);
        assert_eq!(summary.truncated_terminal_outputs, 1);
        assert_eq!(summary.terminal_truncated_bytes, 8);
        assert_eq!(summary.realtime_transcripts, 1);
        assert_eq!(summary.truncated_realtime_transcripts, 1);
        assert_eq!(summary.realtime_transcript_truncated_bytes, 13);
        assert_eq!(summary.realtime_audio, 1);
        assert_eq!(summary.truncated_realtime_audio, 1);
        assert_eq!(summary.realtime_audio_truncated_chunks, 3);
        assert_eq!(summary.thread_lifecycle, 1);
        assert_eq!(summary.subagent_actions, 1);
        assert_eq!(summary.tool_timeline, 2);
        assert_eq!(summary.renderable_tool_assets, 1);
        assert_eq!(summary.image_tool_assets, 1);
        assert_eq!(summary.proxy_required_tool_assets, 1);
        assert_eq!(summary.github_proxy_required_tool_assets, 1);
        assert_eq!(count(&summary.by_execution_location, "local"), 1);
        assert_eq!(count(&summary.by_execution_location, "worktree"), 1);
        assert_eq!(count(&summary.by_active_turn_mode, "plan"), 1);
        assert_eq!(count(&summary.by_plan_status, "implementing"), 1);
        assert_eq!(count(&summary.by_goal_status, "paused"), 1);
        assert_eq!(count(&summary.by_handoff_status, "transferring"), 1);
        assert_eq!(count(&summary.by_handoff_location, "worktree"), 1);
        assert_eq!(count(&summary.by_child_relationship, "subagent"), 1);
        assert_eq!(count(&summary.by_child_status, "running"), 1);
        assert_eq!(
            count(
                &summary.by_plan_implementation_mode,
                "fork_for_implementation"
            ),
            1
        );
        assert_eq!(count(&summary.by_thread_item_kind, "plan"), 1);
        assert_eq!(count(&summary.by_thread_item_kind, "commandExecution"), 1);
        assert_eq!(count(&summary.by_thread_item_status, "updated"), 1);
        assert_eq!(count(&summary.by_thread_item_status, "completed"), 1);
        assert_eq!(count(&summary.by_tool_status, "approval_requested"), 1);
        assert_eq!(count(&summary.by_tool_status, "completed"), 1);
        assert_eq!(count(&summary.by_thread_lifecycle_action, "rollback"), 1);
        assert_eq!(count(&summary.by_subagent_action, "steer"), 1);
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
    fn completed_terminal_tool_with_output_still_projects_terminal_delta() {
        let mut provider = ProviderToolMetadata::new();
        provider.provider = Some("codex".to_string());
        provider.method = Some("item/commandExecution/outputDelta".to_string());
        provider.thread_id = Some("thread-1".to_string());
        provider.turn_id = Some("turn-1".to_string());
        provider.item_id = Some("cmd-1".to_string());
        provider.tool_name = Some("shell".to_string());
        provider.operation = Some("process/outputDelta".to_string());
        provider.raw_args = json!({ "processId": "proc-1", "stdout": "final output\n" });
        let tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Process,
            status: ToolRunStatus::Completed,
            provider,
            item_type: Some("commandExecution".to_string()),
        });

        let event = ProviderRuntimeEvent::tool(tool);
        assert!(matches!(event, ProviderRuntimeEvent::ToolCompleted { .. }));
        let deltas = event.projection_deltas();
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
                && text == "final output\n"
        )));
    }

    #[test]
    fn completed_filesystem_tool_with_patch_still_projects_diff_delta() {
        let mut provider = ProviderToolMetadata::new();
        provider.provider = Some("codex".to_string());
        provider.method = Some("item/fileChange/patchUpdated".to_string());
        provider.thread_id = Some("thread-1".to_string());
        provider.turn_id = Some("turn-1".to_string());
        provider.item_id = Some("file-1".to_string());
        provider.tool_name = Some("apply_patch".to_string());
        provider.operation = Some("apply_patch".to_string());
        provider.raw_args = json!({ "delta": "@@ -1 +1 @@\n-old\n+new\n" });
        provider.raw_payload = json!({ "files": ["src/lib.rs"] });
        let tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Filesystem,
            status: ToolRunStatus::Completed,
            provider,
            item_type: Some("fileChange".to_string()),
        });

        let event = ProviderRuntimeEvent::tool(tool);
        assert!(matches!(event, ProviderRuntimeEvent::ToolCompleted { .. }));
        let deltas = event.projection_deltas();
        let diff = deltas
            .iter()
            .find_map(|delta| match delta {
                ProviderRuntimeProjectionDelta::DiffUpdated {
                    status,
                    diff,
                    files,
                    ..
                } => Some((status, diff, files)),
                _ => None,
            })
            .expect("diff delta");
        assert_eq!(*diff.0, ThreadItemStatus::Completed);
        assert_eq!(diff.1.as_deref(), Some("@@ -1 +1 @@\n-old\n+new\n"));
        assert_eq!(diff.2, &json!(["src/lib.rs"]));
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
                    attachments: None,
                    diff: None,
                    token_usage: None,
                    plan_questions: None,
                    plan_completion: None,
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
                    detail: Default::default(),
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
            detail: Default::default(),
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
                        "source_turn_id": "turn-1",
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
            encoded_delta["decision"]["audit"]["source_turn_id"],
            "turn-1"
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
                    attachments: None,
                    diff: None,
                    token_usage: None,
                    plan_questions: Some(json!([
                        {
                            "id": "confirm",
                            "question": "Implement now?"
                        }
                    ])),
                    plan_completion: Some("complete".to_string()),
                    metadata: json!({ "mode": "plan" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("item/plan/delta".to_string()),
                        schema_version: None,
                        raw_payload: json!({ "itemType": "plan" }),
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
                title,
                text,
                status_text,
                metadata,
                provider_metadata,
                questions,
                completion,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && item_id.as_deref() == Some("plan-1")
                && title.as_deref() == Some("Plan")
                && text.as_deref() == Some("Implement adapter")
                && status_text.is_none()
                && metadata["mode"] == "plan"
                && provider_metadata.as_ref().is_some_and(|metadata| {
                    metadata.raw_payload["itemType"] == "plan"
                })
                && questions.as_ref().is_some_and(|questions| {
                    questions[0]["question"] == "Implement now?"
                })
                && completion.as_deref() == Some("complete")
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
                attachments: None,
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
                metadata: json!({ "status": "started" }),
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
                attachments: None,
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
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
                attachments: Some(json!([
                    {
                        "kind": "image",
                        "url": "codex://attachment/diff-context.png"
                    }
                ])),
                diff: Some(json!("@@ -1 +1 @@")),
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
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
                attachments: None,
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
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
                relationship,
                turn_id,
                status_text,
                metadata,
                role,
                nickname,
                ..
            } if parent_thread_id == "parent-1"
                && child_thread_id == "child-1"
                && *relationship == ChildThreadRelationship::Subagent
                && turn_id.as_deref() == Some("turn-1")
                && status_text.as_deref() == Some("started")
                && metadata["status"] == "started"
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
        assert_eq!(encoded_file_details["title"], "Edited src/main.rs");
        assert_eq!(encoded_file_details["target"], "src/main.rs");
        assert_eq!(encoded_file_details["files"], json!(["src/main.rs"]));
        assert_eq!(
            encoded_file_details["attachments"][0]["url"],
            "codex://attachment/diff-context.png"
        );
        assert_eq!(encoded_file_details["diff"], "@@ -1 +1 @@");
        assert_eq!(encoded_file_details["metadata"]["diff"], "@@ -1 +1 @@");
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ThreadItemDetailsUpdated {
                kind: ThreadItemKind::CommandExecution,
                item_id,
                title,
                text,
                status_text,
                target,
                metadata,
                ..
            } if item_id.as_deref() == Some("cmd-1")
                && title.as_deref() == Some("cargo test")
                && text.as_deref() == Some("running 1 test\n")
                && status_text.as_deref() == Some("running")
                && target.as_deref() == Some("cargo test")
                && metadata["command"] == "cargo test"
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
                relationship,
                turn_id,
                role,
                status_text,
                metadata,
                ..
            } if provider == "codex"
                && parent_thread_id == "parent-1"
                && child_thread_id == "child-1"
                && *relationship == ChildThreadRelationship::Fork
                && turn_id.as_deref() == Some("turn-2")
                && role.is_none()
                && status_text.as_deref() == Some("created")
                && metadata["fork"]["child_thread_id"] == "child-1"
        )));
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                provider,
                parent_thread_id,
                child_thread_id,
                relationship,
                turn_id,
                role,
                status_text,
                ephemeral,
                metadata,
                ..
            } if provider == "codex"
                && parent_thread_id == "parent-1"
                && child_thread_id == "child-1"
                && *relationship == ChildThreadRelationship::SideChat
                && turn_id.as_deref() == Some("turn-2")
                && role.as_deref() == Some("side_chat")
                && status_text.as_deref() == Some("created")
                && *ephemeral == Some(true)
                && metadata["side_chat"]["ephemeral"] == true
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
                    message: Some("Command needs approval".to_string()),
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("denied".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: Some("approval-1".to_string()),
                    metadata: json!({
                        "decision": "denied",
                        "actionId": "action-1",
                        "requestId": "approval-1",
                        "selectedPolicy": "on-request",
                        "decidedBy": "auto_review"
                    }),
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
                            "target_thread_id": "thread-2",
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
                decision,
                action_id,
                request_id,
                selected_policy,
                decided_by,
                retryable,
                metadata,
                ..
            } if thread_id.as_deref() == Some("thread-1")
                && turn_id.as_deref() == Some("turn-1")
                && item_id.as_deref() == Some("review-1")
                && status == "denied"
                && message.as_deref() == Some("Command needs approval")
                && decision.as_deref() == Some("denied")
                && action_id.as_deref() == Some("action-1")
                && request_id.as_deref() == Some("approval-1")
                && selected_policy.as_deref() == Some("on-request")
                && decided_by.as_deref() == Some("auto_review")
                && *retryable
                && metadata["decision"] == "denied"
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
            ProviderRuntimeProjectionDelta::ChildThreadUpsert {
                provider,
                parent_thread_id,
                child_thread_id,
                relationship,
                role,
                status,
                status_text,
                execution_location,
                metadata,
                ..
            } if provider == "codex"
                && parent_thread_id == "thread-1"
                && child_thread_id == "thread-2"
                && *relationship == ChildThreadRelationship::Handoff
                && role.as_deref() == Some("handoff")
                && *status == ThreadItemStatus::Completed
                && status_text.as_deref() == Some("metadata_updated")
                && *execution_location == Some(ExecutionLocation::Worktree)
                && metadata["handoff"]["worktree_branch"] == "feature/task"
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
            ProviderRuntimeEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ProviderStateUpdated,
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
                    metadata: json!({
                        "hostId": "devbox",
                        "host": "devbox.example.com",
                        "displayName": "Devbox",
                        "status": "connected",
                        "projects": [{ "path": "/srv/ace" }]
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("remoteControl/status/changed".to_string()),
                        schema_version: None,
                        raw_payload: json!({
                            "hostId": "devbox",
                            "host": "devbox.example.com",
                            "displayName": "Devbox",
                            "status": "connected",
                            "projects": [{ "path": "/srv/ace" }]
                        }),
                    },
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
        assert!(deltas.iter().any(|delta| matches!(
            delta,
            ProviderRuntimeProjectionDelta::RemoteConnectionUpdated {
                provider,
                connection,
            } if provider == "codex"
                && connection.host_id == "devbox"
                && connection.host.as_deref() == Some("devbox.example.com")
                && connection.status.as_deref() == Some("connected")
                && connection.execution_location == ExecutionLocation::RemoteHost
                && connection.projects[0]["path"] == "/srv/ace"
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
