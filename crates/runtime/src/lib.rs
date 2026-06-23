use ace_core::{Command, CommandId};
use thiserror::Error;
use tokio::sync::mpsc;

pub mod host_tools;
pub mod models;
pub mod native_provider;
pub mod runtime_signals;
pub mod server_requests;
pub mod thread_items;
pub mod threads;
pub mod tools;

#[derive(Debug, Clone)]
pub struct RuntimeCommand {
    pub id: CommandId,
    pub command: Command,
}

#[derive(Debug, Clone)]
pub struct RuntimeHandle {
    commands: mpsc::Sender<RuntimeCommand>,
}

impl RuntimeHandle {
    #[must_use]
    pub fn new(commands: mpsc::Sender<RuntimeCommand>) -> Self {
        Self { commands }
    }

    pub async fn submit(&self, command: Command) -> Result<CommandId, RuntimeError> {
        let id = CommandId::new();
        self.commands
            .send(RuntimeCommand { id, command })
            .await
            .map_err(|_| RuntimeError::Stopped)?;
        Ok(id)
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("runtime is stopped")]
    Stopped,
}

pub mod provider {
    use crate::{
        threads::{AgentRuntimeSnapshot, ExecutionLocation},
        tools::{SemanticToolCall, ToolActionKind, ToolSurface, ToolTransport},
    };
    use ace_core::{ProviderCapability, ProviderKind};
    use async_trait::async_trait;
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use std::{
        collections::{BTreeMap, HashMap, HashSet},
        sync::Arc,
        time::Duration,
    };

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderDescriptor {
        pub kind: ProviderKind,
        pub capabilities: Vec<ProviderCapability>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderContractRequirement {
        pub key: String,
        pub min_version: u32,
        pub required: bool,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderContractRequirementStatus {
        pub key: String,
        pub min_version: u32,
        pub required: bool,
        pub available_version: Option<u32>,
        pub satisfied: bool,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderContractReport {
        pub provider: ProviderKind,
        pub satisfies_required: bool,
        pub requirements: Vec<ProviderContractRequirementStatus>,
        pub capabilities: Vec<ProviderCapability>,
        pub missing_required: Vec<String>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct ProviderAdapterContract {
        pub version: u32,
        pub websocket_first: bool,
        pub raw_payload_policy: String,
        pub raw_payload: ProviderRawPayloadPolicy,
        pub required_capabilities: Vec<ProviderContractRequirement>,
        pub feature_families: Vec<ProviderAdapterFeatureFamily>,
        pub operations: Vec<ProviderAdapterOperationSpec>,
        pub normalized_thread_item_kinds: Vec<ThreadItemKind>,
        pub normalized_server_request_kinds: Vec<ServerRequestKind>,
        pub runtime_signal_kinds: Vec<RuntimeSignalKind>,
        pub provider_event_types: Vec<String>,
        pub tool_transports: Vec<ToolTransport>,
        pub tool_surfaces: Vec<ToolSurface>,
        pub tool_action_kinds: Vec<ToolActionKind>,
        pub execution_locations: Vec<ExecutionLocation>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterFeatureFamily {
        pub category: ProviderFeatureCategory,
        pub total_operations: usize,
        pub required_operations: usize,
        pub optional_operations: usize,
        pub version_gated_operations: usize,
        pub deferred_operations: usize,
        #[serde(default)]
        pub operations: Vec<ProviderAdapterOperation>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderRawPayloadRetention {
        PreserveProviderPayloads,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderLargePayloadStrategy {
        StoreOnceReferenceDeltas,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderRawPayloadPolicy {
        pub retention: ProviderRawPayloadRetention,
        pub preserve_provider_method: bool,
        pub preserve_provider_ids: bool,
        pub preserve_schema_version: bool,
        pub preserve_raw_args: bool,
        pub preserve_raw_result: bool,
        pub inspector_only_by_default: bool,
        pub large_payload_strategy: ProviderLargePayloadStrategy,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderAdapterOperationSupport {
        Required,
        Optional,
        VersionGated,
        Deferred,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderAdapterOperation {
        RuntimeStatus,
        RuntimeLifecycle,
        ProviderMethodsList,
        RawRequest,
        ThreadStart,
        ThreadResume,
        ThreadRead,
        ThreadList,
        ThreadLoadedList,
        ThreadArchive,
        ThreadUnarchive,
        ThreadDelete,
        ThreadUnsubscribe,
        ThreadSetName,
        ThreadUpdateMetadata,
        ThreadCompact,
        ThreadRollback,
        ThreadInjectItems,
        TurnStart,
        TurnSteer,
        TurnInterrupt,
        PlanStart,
        PlanContinueInThread,
        PlanForkForImplementation,
        PlanSideImplementation,
        ForkThread,
        SideChatStart,
        GoalSet,
        GoalGet,
        GoalClear,
        GoalPause,
        GoalResume,
        SubagentList,
        SubagentRead,
        SubagentSteer,
        SubagentStop,
        SubagentClose,
        HandoffToAgent,
        HandoffToLocation,
        PermissionRequirementsRead,
        PermissionProfilesList,
        PermissionPresetResolve,
        GuardianDeniedActionApprove,
        ServerRequestRespond,
        ReviewStart,
        ThreadShellCommand,
        CommandExec,
        CommandWriteStdin,
        CommandResize,
        CommandTerminate,
        ProcessList,
        ProcessClean,
        ProcessSpawn,
        ProcessWriteStdin,
        ProcessResizePty,
        ProcessKill,
        BackgroundTerminalsList,
        BackgroundTerminalsClean,
        BackgroundTerminalTerminate,
        FsReadFile,
        FsWriteFile,
        FsReadDirectory,
        FsCreateDirectory,
        FsCopy,
        FsRemove,
        FsMetadata,
        FsWatch,
        FsUnwatch,
        McpStatus,
        McpResourceRead,
        McpOauthLogin,
        McpToolCall,
        SkillsList,
        SkillsRead,
        SkillsInstall,
        SkillsConfigWrite,
        SkillsExtraRootsSet,
        PluginsInstalled,
        PluginsList,
        PluginsRead,
        PluginsInstall,
        PluginsUninstall,
        PluginShareCheckout,
        PluginShareDelete,
        PluginShareList,
        PluginShareSave,
        PluginShareUpdateTargets,
        AppsList,
        AppsConfigWrite,
        AccountLoginStart,
        AccountLoginCancel,
        AccountLogout,
        AccountRead,
        AccountRateLimitResetCreditConsume,
        AccountRateLimitsRead,
        AccountUsageRead,
        AccountSendAddCreditsNudgeEmail,
        WindowsSandboxReadiness,
        WindowsSandboxSetupStart,
        ConfigRead,
        ConfigValueWrite,
        ConfigBatchWrite,
        ConfigMcpServerReload,
        CollaborationModeList,
        ExperimentalFeatureList,
        ExperimentalFeatureEnablementSet,
        EnvironmentAdd,
        ExternalAgentConfigDetect,
        ExternalAgentConfigImport,
        FeedbackUpload,
        FuzzyFileSearch,
        FuzzyFileSearchSessionStart,
        FuzzyFileSearchSessionStop,
        FuzzyFileSearchSessionUpdate,
        HooksList,
        RemoteControlClientList,
        RemoteControlClientRevoke,
        RemoteControlDisable,
        RemoteControlEnable,
        RemoteControlPairingStart,
        RemoteControlPairingStatus,
        RemoteControlStatusRead,
        ThreadDecrementElicitation,
        ThreadIncrementElicitation,
        ThreadMemoryModeSet,
        ThreadRealtimeAppendAudio,
        ThreadRealtimeAppendSpeech,
        ThreadRealtimeAppendText,
        ThreadRealtimeListVoices,
        ThreadRealtimeStart,
        ThreadRealtimeStop,
        ThreadSearch,
        ThreadSettingsUpdate,
        ThreadTurnsItemsList,
        ThreadTurnsList,
        MemoryReset,
        MarketplaceAdd,
        MarketplaceRemove,
        MarketplaceUpgrade,
        BrowserBridgeContract,
        ComputerBridgeContract,
        ModelList,
        ModelProviderCapabilitiesRead,
        RemoteConnectionList,
        RemoteHandoff,
        CloudThreadStart,
        CloudHandoff,
        ProviderEvents,
        ToolEventNormalize,
        ServerRequestNormalize,
        ThreadItemNormalize,
        RuntimeSignalNormalize,
        SemanticTools,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterOperationSpec {
        pub operation: ProviderAdapterOperation,
        pub category: ProviderFeatureCategory,
        pub support: ProviderAdapterOperationSupport,
        pub policy: ProviderAdapterOperationPolicy,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub canonical_method: Option<String>,
        #[serde(default)]
        pub provider_methods: Vec<String>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderAdapterOperationGateKind {
        OptionalProviderMethod,
        VersionGatedProviderMethod,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterOperationGate {
        pub kind: ProviderAdapterOperationGateKind,
        #[serde(default)]
        pub provider_methods: Vec<String>,
        pub reason: String,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterOperationPolicy {
        pub read_only: bool,
        pub mutates_workspace: bool,
        pub mutates_provider_state: bool,
        pub external_side_effects: bool,
        pub requires_user_initiation: bool,
        pub approval_boundary: bool,
        pub escapes_thread_sandbox: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub reason: Option<String>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderAdapterInvocationKind {
        DirectProviderMethod,
        TypedApi,
        CompositeTypedApi,
        HostToolContract,
        EventStream,
        Deferred,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderAdapterOperationAvailability {
        Available,
        Optional,
        VersionGated,
        Deferred,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterOperationProfile {
        pub operation: ProviderAdapterOperation,
        pub category: ProviderFeatureCategory,
        pub support: ProviderAdapterOperationSupport,
        pub availability: ProviderAdapterOperationAvailability,
        pub policy: ProviderAdapterOperationPolicy,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub runtime_gate: Option<ProviderAdapterOperationGate>,
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
    }

    impl ProviderAdapterOperationProfile {
        #[must_use]
        pub fn from_spec(spec: &ProviderAdapterOperationSpec) -> Self {
            let invocation = provider_adapter_invocation_kind(spec);
            Self {
                operation: spec.operation,
                category: spec.category,
                support: spec.support,
                availability: provider_adapter_operation_availability(spec),
                policy: spec.policy.clone(),
                runtime_gate: provider_adapter_operation_gate(spec),
                availability_reason: provider_adapter_operation_availability_reason(spec),
                canonical_method: spec.canonical_method.clone(),
                provider_methods: spec.provider_methods.clone(),
                direct_invocation: invocation
                    == ProviderAdapterInvocationKind::DirectProviderMethod,
                invocation,
                required_runtime_hooks: provider_adapter_operation_required_hooks(spec),
            }
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterProfile {
        pub provider: ProviderKind,
        pub descriptor: ProviderDescriptor,
        pub contract_report: ProviderContractReport,
        pub contract_version: u32,
        pub websocket_first: bool,
        pub raw_payload_policy: String,
        pub raw_payload: ProviderRawPayloadPolicy,
        pub operations: Vec<ProviderAdapterOperationProfile>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum ProviderAdapterRequestResolution {
        DirectProviderMethod { method: String },
        TypedApi,
        CompositeTypedApi { methods: Vec<String> },
        HostToolContract,
        EventStream,
        Deferred,
    }

    #[derive(Debug, thiserror::Error)]
    pub enum ProviderAdapterRequestResolutionError {
        #[error("provider `{provider:?}` does not advertise adapter operation `{operation:?}`")]
        OperationNotAdvertised {
            provider: ProviderKind,
            operation: ProviderAdapterOperation,
        },
        #[error(
            "provider `{provider:?}` advertises adapter operation `{operation:?}` as direct but did not expose exactly one provider method"
        )]
        MissingDirectProviderMethod {
            provider: ProviderKind,
            operation: ProviderAdapterOperation,
        },
    }

    impl ProviderAdapterProfile {
        #[must_use]
        pub fn operation(
            &self,
            operation: ProviderAdapterOperation,
        ) -> Option<&ProviderAdapterOperationProfile> {
            self.operations
                .iter()
                .find(|profile| profile.operation == operation)
        }

        pub fn resolve_request_operation(
            &self,
            operation: ProviderAdapterOperation,
        ) -> Result<ProviderAdapterRequestResolution, ProviderAdapterRequestResolutionError>
        {
            let profile = self.operation(operation).ok_or(
                ProviderAdapterRequestResolutionError::OperationNotAdvertised {
                    provider: self.provider,
                    operation,
                },
            )?;
            match profile.invocation {
                ProviderAdapterInvocationKind::DirectProviderMethod => self
                    .direct_provider_method(operation)
                    .map(
                        |method| ProviderAdapterRequestResolution::DirectProviderMethod {
                            method: method.to_string(),
                        },
                    )
                    .ok_or(
                        ProviderAdapterRequestResolutionError::MissingDirectProviderMethod {
                            provider: self.provider,
                            operation,
                        },
                    ),
                ProviderAdapterInvocationKind::TypedApi => {
                    Ok(ProviderAdapterRequestResolution::TypedApi)
                }
                ProviderAdapterInvocationKind::CompositeTypedApi => {
                    Ok(ProviderAdapterRequestResolution::CompositeTypedApi {
                        methods: profile.provider_methods.clone(),
                    })
                }
                ProviderAdapterInvocationKind::HostToolContract => {
                    Ok(ProviderAdapterRequestResolution::HostToolContract)
                }
                ProviderAdapterInvocationKind::EventStream => {
                    Ok(ProviderAdapterRequestResolution::EventStream)
                }
                ProviderAdapterInvocationKind::Deferred => {
                    Ok(ProviderAdapterRequestResolution::Deferred)
                }
            }
        }

        #[must_use]
        pub fn direct_provider_method(&self, operation: ProviderAdapterOperation) -> Option<&str> {
            let profile = self.operation(operation)?;
            if profile.direct_invocation {
                profile.provider_methods.first().map(String::as_str)
            } else {
                None
            }
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderAdapterRuntimeHook {
        EventSource,
        HostToolRegistry,
        ServerRequestResponder,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterRuntimeHookStatus {
        pub hook: ProviderAdapterRuntimeHook,
        pub required: bool,
        pub available: bool,
        #[serde(default)]
        pub operations: Vec<ProviderAdapterOperation>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterRuntimeReport {
        pub provider: ProviderKind,
        pub satisfies_required_hooks: bool,
        pub hooks: Vec<ProviderAdapterRuntimeHookStatus>,
        #[serde(default)]
        pub feature_families: Vec<ProviderAdapterFeatureFamilyRuntime>,
        pub missing_required_hooks: Vec<ProviderAdapterRuntimeHook>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterFeatureFamilyRuntime {
        pub category: ProviderFeatureCategory,
        pub total_operations: usize,
        pub hook_ready_operations: usize,
        pub hook_blocked_operations: usize,
        #[serde(default)]
        pub required_hooks: Vec<ProviderAdapterRuntimeHook>,
        #[serde(default)]
        pub missing_hooks: Vec<ProviderAdapterRuntimeHook>,
        #[serde(default)]
        pub operations: Vec<ProviderAdapterOperation>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderFeatureDirection {
        ClientRequest,
        ClientNotification,
        ServerNotification,
        ServerRequest,
        Internal,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderFeatureSupport {
        Native,
        Typed,
        Raw,
        VersionGated,
        Deferred,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderFeatureCategory {
        Threads,
        Turns,
        Plans,
        Goals,
        Subagents,
        Handoff,
        Permissions,
        Tools,
        Mcp,
        Skills,
        Plugins,
        Apps,
        Account,
        Config,
        Models,
        Search,
        Remote,
        Cloud,
        Events,
        ServerRequests,
        Diagnostics,
        Native,
        Unknown,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderFeature {
        pub key: String,
        pub display_name: String,
        pub category: ProviderFeatureCategory,
        pub support: ProviderFeatureSupport,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub direction: Option<ProviderFeatureDirection>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub provider_method: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub capability: Option<ProviderCapability>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderRuntimeHealth {
        Ready,
        Starting,
        Running,
        Stopped,
        Unavailable,
        Degraded,
        Unknown,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct ProviderDriverStatus {
        pub health: ProviderRuntimeHealth,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub transport: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub version: Option<String>,
        pub initialized: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub last_error: Option<String>,
        #[serde(default)]
        pub metadata: Value,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ProviderLifecycleAction {
        Start,
        Restart,
        Shutdown,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct ProviderLifecycleResult {
        pub action: ProviderLifecycleAction,
        pub status: ProviderDriverStatus,
        #[serde(default)]
        pub metadata: Value,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderRequest {
        pub method: String,
        #[serde(default)]
        pub params: Value,
        pub timeout: Duration,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum ThreadItemKind {
        UserMessage,
        HookPrompt,
        AgentMessage,
        Plan,
        Reasoning,
        CommandExecution,
        FileChange,
        McpToolCall,
        DynamicToolCall,
        CollabAgentToolCall,
        SubAgentActivity,
        WebSearch,
        ImageView,
        ImageGeneration,
        EnteredReviewMode,
        ExitedReviewMode,
        ContextCompaction,
        Unknown,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ThreadItemStatus {
        Started,
        Updated,
        Completed,
        Failed,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ServerRequestKind {
        CommandApproval,
        FileChangeApproval,
        ToolUserInput,
        McpElicitation,
        PermissionApproval,
        DynamicToolCall,
        AccountTokenRefresh,
        Attestation,
        ApplyPatchApproval,
        ExecApproval,
        Unknown,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct ProviderMetadata {
        pub provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub method: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub schema_version: Option<String>,
        #[serde(default)]
        pub raw_payload: Value,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct NormalizedThreadItem {
        pub kind: ThreadItemKind,
        pub status: ThreadItemStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub parent_thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub child_thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub sender: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub role: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub status_text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub files: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub attachments: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub diff: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub token_usage: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub plan_questions: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub plan_completion: Option<String>,
        #[serde(default)]
        pub metadata: Value,
        pub provider: ProviderMetadata,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct NormalizedServerRequest {
        pub kind: ServerRequestKind,
        pub request_id: String,
        pub method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub scope: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub selected_policy: Option<String>,
        #[serde(default)]
        pub detail: ServerRequestDetail,
        #[serde(default)]
        pub metadata: Value,
        pub provider: ProviderMetadata,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
    pub struct ServerRequestDetail {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub command: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub argv: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub paths: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub diff: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub patch: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub tool_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub server_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub operation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub permission: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub resource: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub choices: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub schema: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub arguments: Option<Value>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct NormalizedServerRequestDecision {
        pub outcome: String,
        #[serde(default)]
        pub payload: Value,
        #[serde(default)]
        pub audit: Value,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum RuntimeSignalKind {
        Warning,
        ModelRerouted,
        RealtimeTranscriptDelta,
        RealtimeAudioDelta,
        ThreadLifecycleChanged,
        ThreadSettingsUpdated,
        ThreadTokenUsageUpdated,
        TurnDiffUpdated,
        ProcessExited,
        ServerRequestResolved,
        ProviderStateUpdated,
        TurnLifecycleChanged,
        RealtimeSessionUpdated,
        TurnModerationUpdated,
        AutoApprovalReviewUpdated,
        ReviewModeUpdated,
        SubagentAction,
        HandoffUpdated,
        PlanImplementationUpdated,
        ApprovalRetryRecorded,
        GoalUpdated,
        ForkUpdated,
        SideChatUpdated,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct NormalizedRuntimeSignal {
        pub kind: RuntimeSignalKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub from_model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub to_model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub audio: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub active: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub archived: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub diff: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub files: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub process_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub exit_code: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub request_id: Option<String>,
        #[serde(default)]
        pub metadata: Value,
        pub provider: ProviderMetadata,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ProviderEvent {
        RawNotification {
            method: String,
            #[serde(default)]
            params: Value,
        },
        RawServerRequest {
            id: String,
            method: String,
            #[serde(default)]
            params: Value,
        },
        SemanticTool {
            tool: Box<SemanticToolCall>,
        },
        ThreadItem {
            item: Box<NormalizedThreadItem>,
        },
        ServerRequest {
            request: Box<NormalizedServerRequest>,
        },
        ServerRequestResolved {
            request_id: String,
            decision: NormalizedServerRequestDecision,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            request: Option<Box<NormalizedServerRequest>>,
        },
        RuntimeSignal {
            signal: Box<NormalizedRuntimeSignal>,
        },
        StderrLine {
            line: String,
        },
        Exited {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            code: Option<i32>,
        },
    }

    #[async_trait]
    pub trait ProviderDriver: Send + Sync + 'static {
        fn descriptor(&self) -> ProviderDescriptor;

        fn adapter_profile(&self) -> ProviderAdapterProfile {
            provider_adapter_profile(&self.descriptor())
        }

        fn features(&self) -> Vec<ProviderFeature> {
            self.descriptor()
                .capabilities
                .into_iter()
                .map(|capability| ProviderFeature {
                    key: capability.key.clone(),
                    display_name: capability.key.replace(['.', '_'], " "),
                    category: ProviderFeatureCategory::Native,
                    support: ProviderFeatureSupport::Native,
                    direction: Some(ProviderFeatureDirection::Internal),
                    provider_method: None,
                    capability: Some(capability),
                })
                .collect()
        }

        async fn status(&self) -> ProviderDriverStatus {
            ProviderDriverStatus {
                health: ProviderRuntimeHealth::Ready,
                transport: None,
                version: None,
                initialized: true,
                last_error: None,
                metadata: Value::Null,
            }
        }

        async fn lifecycle_action(
            &self,
            action: ProviderLifecycleAction,
            _grace: Duration,
        ) -> Result<ProviderLifecycleResult, ProviderDriverError> {
            Err(ProviderDriverError::LifecycleUnsupported {
                provider: format!("{:?}", self.descriptor().kind),
                action,
            })
        }

        async fn request(&self, request: ProviderRequest) -> Result<Value, ProviderDriverError>;
    }

    #[async_trait]
    pub trait ProviderEventSource: Send + Sync + 'static {
        async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>, ProviderDriverError>;
    }

    #[async_trait]
    pub trait ProviderServerRequestResponder: Send + Sync + 'static {
        async fn respond_server_request_result(
            &self,
            request_id: String,
            result: Value,
        ) -> Result<(), ProviderDriverError>;

        async fn respond_server_request_error(
            &self,
            request_id: String,
            code: i64,
            message: String,
        ) -> Result<(), ProviderDriverError>;
    }

    #[async_trait]
    pub trait ProviderStateSource: Send + Sync + 'static {
        async fn runtime_state_snapshot(&self)
        -> Result<AgentRuntimeSnapshot, ProviderDriverError>;
    }

    pub type DynProviderDriver = Arc<dyn ProviderDriver>;
    pub type DynProviderEventSource = Arc<dyn ProviderEventSource>;
    pub type DynProviderServerRequestResponder = Arc<dyn ProviderServerRequestResponder>;
    pub type DynProviderStateSource = Arc<dyn ProviderStateSource>;

    #[derive(Default, Clone)]
    pub struct ProviderRegistry {
        drivers: HashMap<ProviderKind, DynProviderDriver>,
        event_sources: HashMap<ProviderKind, DynProviderEventSource>,
        server_request_responders: HashMap<ProviderKind, DynProviderServerRequestResponder>,
        state_sources: HashMap<ProviderKind, DynProviderStateSource>,
        host_tool_registries: HashSet<ProviderKind>,
    }

    #[must_use]
    pub fn ace_provider_contract_requirements() -> Vec<ProviderContractRequirement> {
        vec![
            ProviderContractRequirement {
                key: "provider.adapter_contract".to_string(),
                min_version: 1,
                required: true,
            },
            ProviderContractRequirement {
                key: "provider.normalized_events".to_string(),
                min_version: 1,
                required: true,
            },
            ProviderContractRequirement {
                key: "provider.semantic_tools".to_string(),
                min_version: 1,
                required: true,
            },
            ProviderContractRequirement {
                key: "provider.normalized_server_requests".to_string(),
                min_version: 1,
                required: true,
            },
            ProviderContractRequirement {
                key: "provider.runtime.raw_request".to_string(),
                min_version: 1,
                required: false,
            },
        ]
    }

    #[must_use]
    pub fn ace_provider_adapter_operations() -> Vec<ProviderAdapterOperationSpec> {
        use ProviderAdapterOperation as Operation;
        use ProviderAdapterOperationSupport::{Deferred, Optional, Required, VersionGated};
        use ProviderFeatureCategory as Category;

        [
            op(Operation::RuntimeStatus, Category::Native, Required, None),
            op(
                Operation::RuntimeLifecycle,
                Category::Native,
                Required,
                None,
            ),
            op(
                Operation::ProviderMethodsList,
                Category::Native,
                Required,
                None,
            ),
            op(Operation::RawRequest, Category::Native, Optional, None),
            op(
                Operation::ThreadStart,
                Category::Threads,
                Required,
                Some("thread/start"),
            ),
            op(
                Operation::ThreadResume,
                Category::Threads,
                Required,
                Some("thread/resume"),
            ),
            op(
                Operation::ThreadRead,
                Category::Threads,
                Required,
                Some("thread/read"),
            ),
            op(
                Operation::ThreadList,
                Category::Threads,
                Required,
                Some("thread/list"),
            ),
            op(
                Operation::ThreadLoadedList,
                Category::Threads,
                Optional,
                Some("thread/loaded/list"),
            ),
            op(
                Operation::ThreadArchive,
                Category::Threads,
                Required,
                Some("thread/archive"),
            ),
            op(
                Operation::ThreadUnarchive,
                Category::Threads,
                Required,
                Some("thread/unarchive"),
            ),
            op(
                Operation::ThreadDelete,
                Category::Threads,
                Required,
                Some("thread/delete"),
            ),
            op(
                Operation::ThreadUnsubscribe,
                Category::Threads,
                Optional,
                Some("thread/unsubscribe"),
            ),
            op(
                Operation::ThreadSetName,
                Category::Threads,
                Required,
                Some("thread/name/set"),
            ),
            op(
                Operation::ThreadUpdateMetadata,
                Category::Threads,
                Required,
                Some("thread/metadata/update"),
            ),
            op(
                Operation::ThreadCompact,
                Category::Threads,
                Required,
                Some("thread/compact/start"),
            ),
            op(
                Operation::ThreadRollback,
                Category::Threads,
                Required,
                Some("thread/rollback"),
            ),
            op(
                Operation::ThreadInjectItems,
                Category::Threads,
                Required,
                Some("thread/inject_items"),
            ),
            op(
                Operation::TurnStart,
                Category::Turns,
                Required,
                Some("turn/start"),
            ),
            op(
                Operation::TurnSteer,
                Category::Turns,
                Required,
                Some("turn/steer"),
            ),
            op(
                Operation::TurnInterrupt,
                Category::Turns,
                Required,
                Some("turn/interrupt"),
            ),
            op(
                Operation::PlanStart,
                Category::Plans,
                Required,
                Some("turn/start"),
            ),
            op(
                Operation::PlanContinueInThread,
                Category::Plans,
                Required,
                Some("thread/inject_items+turn/start"),
            ),
            op(
                Operation::PlanForkForImplementation,
                Category::Plans,
                Required,
                Some("thread/fork+thread/inject_items+turn/start"),
            ),
            op(
                Operation::PlanSideImplementation,
                Category::Plans,
                Required,
                Some("thread/fork+thread/inject_items+turn/start"),
            ),
            op(
                Operation::ForkThread,
                Category::Threads,
                Required,
                Some("thread/fork"),
            ),
            op(
                Operation::SideChatStart,
                Category::Threads,
                Required,
                Some("thread/fork"),
            ),
            op(
                Operation::GoalSet,
                Category::Goals,
                Required,
                Some("thread/goal/set"),
            ),
            op(
                Operation::GoalGet,
                Category::Goals,
                Required,
                Some("thread/goal/get"),
            ),
            op(
                Operation::GoalClear,
                Category::Goals,
                Required,
                Some("thread/goal/clear"),
            ),
            op(
                Operation::GoalPause,
                Category::Goals,
                Required,
                Some("thread/goal/set"),
            ),
            op(
                Operation::GoalResume,
                Category::Goals,
                Required,
                Some("thread/goal/set"),
            ),
            op(
                Operation::SubagentList,
                Category::Subagents,
                Required,
                Some("subagent/list"),
            ),
            op(
                Operation::SubagentRead,
                Category::Subagents,
                Required,
                Some("subagent/read"),
            ),
            op(
                Operation::SubagentSteer,
                Category::Subagents,
                Required,
                Some("subagent/steer"),
            ),
            op(
                Operation::SubagentStop,
                Category::Subagents,
                Required,
                Some("subagent/stop"),
            ),
            op(
                Operation::SubagentClose,
                Category::Subagents,
                Required,
                Some("subagent/close"),
            ),
            op(
                Operation::HandoffToAgent,
                Category::Handoff,
                Required,
                Some("thread/handoffToAgent"),
            ),
            op(
                Operation::HandoffToLocation,
                Category::Handoff,
                Required,
                None,
            ),
            op(
                Operation::PermissionRequirementsRead,
                Category::Permissions,
                Required,
                Some("configRequirements/read"),
            ),
            op(
                Operation::PermissionProfilesList,
                Category::Permissions,
                Required,
                Some("permissionProfile/list"),
            ),
            op(
                Operation::PermissionPresetResolve,
                Category::Permissions,
                Required,
                Some("configRequirements/read+permissionProfile/list"),
            ),
            op(
                Operation::GuardianDeniedActionApprove,
                Category::Permissions,
                Required,
                Some("thread/approveGuardianDeniedAction"),
            ),
            op(
                Operation::ServerRequestRespond,
                Category::ServerRequests,
                Required,
                None,
            ),
            op(
                Operation::ReviewStart,
                Category::Tools,
                VersionGated,
                Some("review/start"),
            ),
            op(
                Operation::ThreadShellCommand,
                Category::Tools,
                VersionGated,
                Some("thread/shellCommand"),
            ),
            op(
                Operation::CommandExec,
                Category::Tools,
                VersionGated,
                Some("command/exec"),
            ),
            op(
                Operation::CommandWriteStdin,
                Category::Tools,
                VersionGated,
                Some("command/exec/write"),
            ),
            op(
                Operation::CommandResize,
                Category::Tools,
                VersionGated,
                Some("command/exec/resize"),
            ),
            op(
                Operation::CommandTerminate,
                Category::Tools,
                VersionGated,
                Some("command/exec/terminate"),
            ),
            op(
                Operation::ProcessList,
                Category::Tools,
                VersionGated,
                Some("process/list"),
            ),
            op(
                Operation::ProcessClean,
                Category::Tools,
                VersionGated,
                Some("process/clean"),
            ),
            op(
                Operation::ProcessSpawn,
                Category::Tools,
                VersionGated,
                Some("process/spawn"),
            ),
            op(
                Operation::ProcessWriteStdin,
                Category::Tools,
                VersionGated,
                Some("process/writeStdin"),
            ),
            op(
                Operation::ProcessResizePty,
                Category::Tools,
                VersionGated,
                Some("process/resizePty"),
            ),
            op(
                Operation::ProcessKill,
                Category::Tools,
                VersionGated,
                Some("process/kill"),
            ),
            op(
                Operation::BackgroundTerminalsList,
                Category::Tools,
                VersionGated,
                Some("thread/backgroundTerminals/list"),
            ),
            op(
                Operation::BackgroundTerminalsClean,
                Category::Tools,
                VersionGated,
                Some("thread/backgroundTerminals/clean"),
            ),
            op(
                Operation::BackgroundTerminalTerminate,
                Category::Tools,
                VersionGated,
                Some("thread/backgroundTerminals/terminate"),
            ),
            op(
                Operation::FsReadFile,
                Category::Tools,
                Required,
                Some("fs/readFile"),
            ),
            op(
                Operation::FsWriteFile,
                Category::Tools,
                Required,
                Some("fs/writeFile"),
            ),
            op(
                Operation::FsReadDirectory,
                Category::Tools,
                Required,
                Some("fs/readDirectory"),
            ),
            op(
                Operation::FsCreateDirectory,
                Category::Tools,
                Required,
                Some("fs/createDirectory"),
            ),
            op(
                Operation::FsCopy,
                Category::Tools,
                Required,
                Some("fs/copy"),
            ),
            op(
                Operation::FsRemove,
                Category::Tools,
                Required,
                Some("fs/remove"),
            ),
            op(
                Operation::FsMetadata,
                Category::Tools,
                Required,
                Some("fs/getMetadata"),
            ),
            op(
                Operation::FsWatch,
                Category::Tools,
                Required,
                Some("fs/watch"),
            ),
            op(
                Operation::FsUnwatch,
                Category::Tools,
                Required,
                Some("fs/unwatch"),
            ),
            op(
                Operation::McpStatus,
                Category::Mcp,
                VersionGated,
                Some("mcpServerStatus/list"),
            ),
            op(
                Operation::McpResourceRead,
                Category::Mcp,
                VersionGated,
                Some("mcpServer/resource/read"),
            ),
            op(
                Operation::McpOauthLogin,
                Category::Mcp,
                VersionGated,
                Some("mcpServer/oauth/login"),
            ),
            op(
                Operation::McpToolCall,
                Category::Mcp,
                VersionGated,
                Some("mcpServer/tool/call"),
            ),
            op(
                Operation::SkillsList,
                Category::Skills,
                VersionGated,
                Some("skills/list"),
            ),
            op(
                Operation::SkillsRead,
                Category::Skills,
                VersionGated,
                Some("plugin/skill/read"),
            ),
            op(
                Operation::SkillsInstall,
                Category::Skills,
                VersionGated,
                Some("skills/install"),
            ),
            op(
                Operation::SkillsConfigWrite,
                Category::Skills,
                VersionGated,
                Some("skills/config/write"),
            ),
            op(
                Operation::SkillsExtraRootsSet,
                Category::Skills,
                Optional,
                Some("skills/extraRoots/set"),
            ),
            op(
                Operation::PluginsInstalled,
                Category::Plugins,
                Optional,
                Some("plugin/installed"),
            ),
            op(
                Operation::PluginsList,
                Category::Plugins,
                VersionGated,
                Some("plugin/list"),
            ),
            op(
                Operation::PluginsRead,
                Category::Plugins,
                Optional,
                Some("plugin/read"),
            ),
            op(
                Operation::PluginsInstall,
                Category::Plugins,
                VersionGated,
                Some("plugin/install"),
            ),
            op(
                Operation::PluginsUninstall,
                Category::Plugins,
                Optional,
                Some("plugin/uninstall"),
            ),
            op(
                Operation::PluginShareCheckout,
                Category::Plugins,
                Optional,
                Some("plugin/share/checkout"),
            ),
            op(
                Operation::PluginShareDelete,
                Category::Plugins,
                Optional,
                Some("plugin/share/delete"),
            ),
            op(
                Operation::PluginShareList,
                Category::Plugins,
                Optional,
                Some("plugin/share/list"),
            ),
            op(
                Operation::PluginShareSave,
                Category::Plugins,
                Optional,
                Some("plugin/share/save"),
            ),
            op(
                Operation::PluginShareUpdateTargets,
                Category::Plugins,
                Optional,
                Some("plugin/share/updateTargets"),
            ),
            op(
                Operation::AppsList,
                Category::Apps,
                VersionGated,
                Some("app/list"),
            ),
            op(
                Operation::AppsConfigWrite,
                Category::Apps,
                VersionGated,
                Some("apps/configWrite"),
            ),
            op(
                Operation::AccountLoginStart,
                Category::Account,
                Optional,
                Some("account/login/start"),
            ),
            op(
                Operation::AccountLoginCancel,
                Category::Account,
                Optional,
                Some("account/login/cancel"),
            ),
            op(
                Operation::AccountLogout,
                Category::Account,
                Optional,
                Some("account/logout"),
            ),
            op(
                Operation::AccountRead,
                Category::Account,
                Optional,
                Some("account/read"),
            ),
            op(
                Operation::AccountRateLimitResetCreditConsume,
                Category::Account,
                Optional,
                Some("account/rateLimitResetCredit/consume"),
            ),
            op(
                Operation::AccountRateLimitsRead,
                Category::Account,
                Optional,
                Some("account/rateLimits/read"),
            ),
            op(
                Operation::AccountUsageRead,
                Category::Account,
                Optional,
                Some("account/usage/read"),
            ),
            op(
                Operation::AccountSendAddCreditsNudgeEmail,
                Category::Account,
                Optional,
                Some("account/sendAddCreditsNudgeEmail"),
            ),
            op(
                Operation::WindowsSandboxReadiness,
                Category::Config,
                Optional,
                Some("windowsSandbox/readiness"),
            ),
            op(
                Operation::WindowsSandboxSetupStart,
                Category::Config,
                Optional,
                Some("windowsSandbox/setupStart"),
            ),
            op(
                Operation::ConfigRead,
                Category::Config,
                Optional,
                Some("config/read"),
            ),
            op(
                Operation::ConfigValueWrite,
                Category::Config,
                Optional,
                Some("config/value/write"),
            ),
            op(
                Operation::ConfigBatchWrite,
                Category::Config,
                Optional,
                Some("config/batchWrite"),
            ),
            op(
                Operation::ConfigMcpServerReload,
                Category::Config,
                Optional,
                Some("config/mcpServer/reload"),
            ),
            op(
                Operation::CollaborationModeList,
                Category::Events,
                VersionGated,
                Some("collaborationMode/list"),
            ),
            op(
                Operation::ExperimentalFeatureList,
                Category::Config,
                Optional,
                Some("experimentalFeature/list"),
            ),
            op(
                Operation::ExperimentalFeatureEnablementSet,
                Category::Config,
                Optional,
                Some("experimentalFeature/enablement/set"),
            ),
            op(
                Operation::EnvironmentAdd,
                Category::Tools,
                VersionGated,
                Some("environment/add"),
            ),
            op(
                Operation::ExternalAgentConfigDetect,
                Category::Config,
                Optional,
                Some("externalAgentConfig/detect"),
            ),
            op(
                Operation::ExternalAgentConfigImport,
                Category::Config,
                Optional,
                Some("externalAgentConfig/import"),
            ),
            op(
                Operation::FeedbackUpload,
                Category::Diagnostics,
                Optional,
                Some("feedback/upload"),
            ),
            op(
                Operation::FuzzyFileSearch,
                Category::Search,
                Optional,
                Some("fuzzyFileSearch"),
            ),
            op(
                Operation::FuzzyFileSearchSessionStart,
                Category::Search,
                VersionGated,
                Some("fuzzyFileSearch/sessionStart"),
            ),
            op(
                Operation::FuzzyFileSearchSessionStop,
                Category::Search,
                VersionGated,
                Some("fuzzyFileSearch/sessionStop"),
            ),
            op(
                Operation::FuzzyFileSearchSessionUpdate,
                Category::Search,
                VersionGated,
                Some("fuzzyFileSearch/sessionUpdate"),
            ),
            op(
                Operation::HooksList,
                Category::Config,
                Optional,
                Some("hooks/list"),
            ),
            op(
                Operation::RemoteControlClientList,
                Category::Remote,
                VersionGated,
                Some("remoteControl/client/list"),
            ),
            op(
                Operation::RemoteControlClientRevoke,
                Category::Remote,
                VersionGated,
                Some("remoteControl/client/revoke"),
            ),
            op(
                Operation::RemoteControlDisable,
                Category::Remote,
                VersionGated,
                Some("remoteControl/disable"),
            ),
            op(
                Operation::RemoteControlEnable,
                Category::Remote,
                VersionGated,
                Some("remoteControl/enable"),
            ),
            op(
                Operation::RemoteControlPairingStart,
                Category::Remote,
                VersionGated,
                Some("remoteControl/pairing/start"),
            ),
            op(
                Operation::RemoteControlPairingStatus,
                Category::Remote,
                VersionGated,
                Some("remoteControl/pairing/status"),
            ),
            op(
                Operation::RemoteControlStatusRead,
                Category::Remote,
                VersionGated,
                Some("remoteControl/status/read"),
            ),
            op(
                Operation::ThreadDecrementElicitation,
                Category::Turns,
                VersionGated,
                Some("thread/decrement_elicitation"),
            ),
            op(
                Operation::ThreadIncrementElicitation,
                Category::Turns,
                VersionGated,
                Some("thread/increment_elicitation"),
            ),
            op(
                Operation::ThreadMemoryModeSet,
                Category::Threads,
                VersionGated,
                Some("thread/memoryMode/set"),
            ),
            op(
                Operation::ThreadRealtimeAppendAudio,
                Category::Turns,
                VersionGated,
                Some("thread/realtime/appendAudio"),
            ),
            op(
                Operation::ThreadRealtimeAppendSpeech,
                Category::Turns,
                VersionGated,
                Some("thread/realtime/appendSpeech"),
            ),
            op(
                Operation::ThreadRealtimeAppendText,
                Category::Turns,
                VersionGated,
                Some("thread/realtime/appendText"),
            ),
            op(
                Operation::ThreadRealtimeListVoices,
                Category::Turns,
                VersionGated,
                Some("thread/realtime/listVoices"),
            ),
            op(
                Operation::ThreadRealtimeStart,
                Category::Turns,
                VersionGated,
                Some("thread/realtime/start"),
            ),
            op(
                Operation::ThreadRealtimeStop,
                Category::Turns,
                VersionGated,
                Some("thread/realtime/stop"),
            ),
            op(
                Operation::ThreadSearch,
                Category::Search,
                VersionGated,
                Some("thread/search"),
            ),
            op(
                Operation::ThreadSettingsUpdate,
                Category::Threads,
                VersionGated,
                Some("thread/settings/update"),
            ),
            op(
                Operation::ThreadTurnsItemsList,
                Category::Turns,
                VersionGated,
                Some("thread/turns/items/list"),
            ),
            op(
                Operation::ThreadTurnsList,
                Category::Turns,
                VersionGated,
                Some("thread/turns/list"),
            ),
            op(
                Operation::MemoryReset,
                Category::Tools,
                VersionGated,
                Some("memory/reset"),
            ),
            op(
                Operation::MarketplaceAdd,
                Category::Plugins,
                Optional,
                Some("marketplace/add"),
            ),
            op(
                Operation::MarketplaceRemove,
                Category::Plugins,
                Optional,
                Some("marketplace/remove"),
            ),
            op(
                Operation::MarketplaceUpgrade,
                Category::Plugins,
                Optional,
                Some("marketplace/upgrade"),
            ),
            op(
                Operation::BrowserBridgeContract,
                Category::Tools,
                Required,
                None,
            ),
            op(
                Operation::ComputerBridgeContract,
                Category::Tools,
                Required,
                None,
            ),
            op(
                Operation::ModelList,
                Category::Models,
                Optional,
                Some("model/list"),
            ),
            op(
                Operation::ModelProviderCapabilitiesRead,
                Category::Models,
                Optional,
                Some("modelProvider/capabilities/read"),
            ),
            op(
                Operation::RemoteConnectionList,
                Category::Remote,
                VersionGated,
                Some("remote/connectionList"),
            ),
            op(
                Operation::RemoteHandoff,
                Category::Remote,
                VersionGated,
                Some("remote/handoff"),
            ),
            op(
                Operation::CloudThreadStart,
                Category::Cloud,
                Deferred,
                Some("cloud/threadStart"),
            ),
            op(
                Operation::CloudHandoff,
                Category::Cloud,
                Deferred,
                Some("cloud/handoff"),
            ),
            op(Operation::ProviderEvents, Category::Events, Required, None),
            op(
                Operation::ToolEventNormalize,
                Category::Tools,
                Required,
                None,
            ),
            op(
                Operation::ServerRequestNormalize,
                Category::ServerRequests,
                Required,
                None,
            ),
            op(
                Operation::ThreadItemNormalize,
                Category::Events,
                Required,
                None,
            ),
            op(
                Operation::RuntimeSignalNormalize,
                Category::Events,
                Required,
                None,
            ),
            op(Operation::SemanticTools, Category::Tools, Required, None),
        ]
        .into()
    }

    fn op(
        operation: ProviderAdapterOperation,
        category: ProviderFeatureCategory,
        support: ProviderAdapterOperationSupport,
        canonical_method: Option<&str>,
    ) -> ProviderAdapterOperationSpec {
        ProviderAdapterOperationSpec {
            operation,
            category,
            support,
            policy: provider_adapter_operation_policy(operation),
            canonical_method: canonical_method.map(ToString::to_string),
            provider_methods: canonical_method
                .map(|method| method.split('+').map(ToString::to_string).collect())
                .unwrap_or_default(),
        }
    }

    #[must_use]
    pub fn provider_adapter_operation_policy(
        operation: ProviderAdapterOperation,
    ) -> ProviderAdapterOperationPolicy {
        let mut policy = ProviderAdapterOperationPolicy {
            read_only: true,
            mutates_workspace: false,
            mutates_provider_state: false,
            external_side_effects: false,
            requires_user_initiation: false,
            approval_boundary: false,
            escapes_thread_sandbox: false,
            reason: None,
        };

        match operation {
            ProviderAdapterOperation::RuntimeLifecycle
            | ProviderAdapterOperation::RawRequest
            | ProviderAdapterOperation::ThreadStart
            | ProviderAdapterOperation::ThreadResume
            | ProviderAdapterOperation::ThreadArchive
            | ProviderAdapterOperation::ThreadUnarchive
            | ProviderAdapterOperation::ThreadDelete
            | ProviderAdapterOperation::ThreadUnsubscribe
            | ProviderAdapterOperation::ThreadSetName
            | ProviderAdapterOperation::ThreadUpdateMetadata
            | ProviderAdapterOperation::ThreadCompact
            | ProviderAdapterOperation::ThreadRollback
            | ProviderAdapterOperation::ThreadInjectItems
            | ProviderAdapterOperation::TurnStart
            | ProviderAdapterOperation::TurnSteer
            | ProviderAdapterOperation::TurnInterrupt
            | ProviderAdapterOperation::PlanStart
            | ProviderAdapterOperation::PlanContinueInThread
            | ProviderAdapterOperation::PlanForkForImplementation
            | ProviderAdapterOperation::PlanSideImplementation
            | ProviderAdapterOperation::ForkThread
            | ProviderAdapterOperation::SideChatStart
            | ProviderAdapterOperation::GoalSet
            | ProviderAdapterOperation::GoalClear
            | ProviderAdapterOperation::GoalPause
            | ProviderAdapterOperation::GoalResume
            | ProviderAdapterOperation::SubagentSteer
            | ProviderAdapterOperation::SubagentStop
            | ProviderAdapterOperation::SubagentClose
            | ProviderAdapterOperation::HandoffToAgent
            | ProviderAdapterOperation::GuardianDeniedActionApprove
            | ProviderAdapterOperation::ServerRequestRespond
            | ProviderAdapterOperation::ReviewStart
            | ProviderAdapterOperation::ProcessSpawn
            | ProviderAdapterOperation::ProcessWriteStdin
            | ProviderAdapterOperation::ProcessResizePty
            | ProviderAdapterOperation::ProcessKill
            | ProviderAdapterOperation::BackgroundTerminalsClean
            | ProviderAdapterOperation::BackgroundTerminalTerminate
            | ProviderAdapterOperation::FsWatch
            | ProviderAdapterOperation::FsUnwatch
            | ProviderAdapterOperation::McpOauthLogin
            | ProviderAdapterOperation::SkillsInstall
            | ProviderAdapterOperation::SkillsConfigWrite
            | ProviderAdapterOperation::SkillsExtraRootsSet
            | ProviderAdapterOperation::PluginsInstall
            | ProviderAdapterOperation::PluginsUninstall
            | ProviderAdapterOperation::PluginShareCheckout
            | ProviderAdapterOperation::PluginShareDelete
            | ProviderAdapterOperation::PluginShareSave
            | ProviderAdapterOperation::PluginShareUpdateTargets
            | ProviderAdapterOperation::AppsConfigWrite
            | ProviderAdapterOperation::AccountLoginStart
            | ProviderAdapterOperation::AccountLoginCancel
            | ProviderAdapterOperation::AccountLogout
            | ProviderAdapterOperation::ConfigValueWrite
            | ProviderAdapterOperation::ConfigBatchWrite
            | ProviderAdapterOperation::ConfigMcpServerReload
            | ProviderAdapterOperation::ExperimentalFeatureEnablementSet
            | ProviderAdapterOperation::EnvironmentAdd
            | ProviderAdapterOperation::ExternalAgentConfigImport
            | ProviderAdapterOperation::FeedbackUpload
            | ProviderAdapterOperation::FuzzyFileSearchSessionStart
            | ProviderAdapterOperation::FuzzyFileSearchSessionStop
            | ProviderAdapterOperation::FuzzyFileSearchSessionUpdate
            | ProviderAdapterOperation::HandoffToLocation
            | ProviderAdapterOperation::RemoteControlClientRevoke
            | ProviderAdapterOperation::RemoteControlDisable
            | ProviderAdapterOperation::RemoteControlEnable
            | ProviderAdapterOperation::RemoteControlPairingStart
            | ProviderAdapterOperation::ThreadDecrementElicitation
            | ProviderAdapterOperation::ThreadIncrementElicitation
            | ProviderAdapterOperation::ThreadMemoryModeSet
            | ProviderAdapterOperation::ThreadRealtimeAppendAudio
            | ProviderAdapterOperation::ThreadRealtimeAppendSpeech
            | ProviderAdapterOperation::ThreadRealtimeAppendText
            | ProviderAdapterOperation::ThreadRealtimeListVoices
            | ProviderAdapterOperation::ThreadRealtimeStart
            | ProviderAdapterOperation::ThreadRealtimeStop
            | ProviderAdapterOperation::ThreadSettingsUpdate
            | ProviderAdapterOperation::MemoryReset
            | ProviderAdapterOperation::WindowsSandboxSetupStart
            | ProviderAdapterOperation::MarketplaceAdd
            | ProviderAdapterOperation::MarketplaceRemove
            | ProviderAdapterOperation::MarketplaceUpgrade
            | ProviderAdapterOperation::RemoteHandoff
            | ProviderAdapterOperation::CloudThreadStart
            | ProviderAdapterOperation::CloudHandoff => {
                policy.read_only = false;
                policy.mutates_provider_state = true;
            }
            _ => {}
        }

        match operation {
            ProviderAdapterOperation::HandoffToLocation
            | ProviderAdapterOperation::ThreadShellCommand
            | ProviderAdapterOperation::CommandExec
            | ProviderAdapterOperation::CommandWriteStdin
            | ProviderAdapterOperation::CommandResize
            | ProviderAdapterOperation::CommandTerminate
            | ProviderAdapterOperation::ProcessSpawn
            | ProviderAdapterOperation::ProcessWriteStdin
            | ProviderAdapterOperation::ProcessResizePty
            | ProviderAdapterOperation::ProcessKill
            | ProviderAdapterOperation::FsWriteFile
            | ProviderAdapterOperation::FsCreateDirectory
            | ProviderAdapterOperation::FsCopy
            | ProviderAdapterOperation::FsRemove => {
                policy.read_only = false;
                policy.mutates_workspace = true;
            }
            _ => {}
        }

        match operation {
            ProviderAdapterOperation::ThreadShellCommand
            | ProviderAdapterOperation::CommandExec
            | ProviderAdapterOperation::CommandWriteStdin
            | ProviderAdapterOperation::CommandResize
            | ProviderAdapterOperation::CommandTerminate
            | ProviderAdapterOperation::ProcessSpawn
            | ProviderAdapterOperation::ProcessWriteStdin
            | ProviderAdapterOperation::ProcessResizePty
            | ProviderAdapterOperation::ProcessKill
            | ProviderAdapterOperation::BackgroundTerminalsClean
            | ProviderAdapterOperation::BackgroundTerminalTerminate
            | ProviderAdapterOperation::McpOauthLogin
            | ProviderAdapterOperation::McpToolCall
            | ProviderAdapterOperation::SkillsInstall
            | ProviderAdapterOperation::SkillsConfigWrite
            | ProviderAdapterOperation::SkillsExtraRootsSet
            | ProviderAdapterOperation::PluginsInstall
            | ProviderAdapterOperation::PluginsUninstall
            | ProviderAdapterOperation::PluginShareCheckout
            | ProviderAdapterOperation::PluginShareDelete
            | ProviderAdapterOperation::PluginShareSave
            | ProviderAdapterOperation::PluginShareUpdateTargets
            | ProviderAdapterOperation::AppsConfigWrite
            | ProviderAdapterOperation::AccountLoginStart
            | ProviderAdapterOperation::AccountLogout
            | ProviderAdapterOperation::AccountRateLimitResetCreditConsume
            | ProviderAdapterOperation::AccountSendAddCreditsNudgeEmail
            | ProviderAdapterOperation::WindowsSandboxSetupStart
            | ProviderAdapterOperation::EnvironmentAdd
            | ProviderAdapterOperation::MemoryReset
            | ProviderAdapterOperation::RemoteControlClientRevoke
            | ProviderAdapterOperation::RemoteControlDisable
            | ProviderAdapterOperation::RemoteControlEnable
            | ProviderAdapterOperation::RemoteControlPairingStart
            | ProviderAdapterOperation::ThreadRealtimeAppendAudio
            | ProviderAdapterOperation::ThreadRealtimeAppendSpeech
            | ProviderAdapterOperation::ThreadRealtimeAppendText
            | ProviderAdapterOperation::ThreadRealtimeListVoices
            | ProviderAdapterOperation::ThreadRealtimeStart
            | ProviderAdapterOperation::ThreadRealtimeStop
            | ProviderAdapterOperation::MarketplaceAdd
            | ProviderAdapterOperation::MarketplaceRemove
            | ProviderAdapterOperation::MarketplaceUpgrade
            | ProviderAdapterOperation::RemoteHandoff
            | ProviderAdapterOperation::CloudThreadStart
            | ProviderAdapterOperation::CloudHandoff
            | ProviderAdapterOperation::BrowserBridgeContract
            | ProviderAdapterOperation::ComputerBridgeContract => {
                policy.read_only = false;
                policy.external_side_effects = true;
            }
            _ => {}
        }

        match operation {
            ProviderAdapterOperation::ThreadShellCommand
            | ProviderAdapterOperation::CommandExec
            | ProviderAdapterOperation::ProcessSpawn
            | ProviderAdapterOperation::FsWriteFile
            | ProviderAdapterOperation::FsCreateDirectory
            | ProviderAdapterOperation::FsCopy
            | ProviderAdapterOperation::FsRemove
            | ProviderAdapterOperation::McpToolCall
            | ProviderAdapterOperation::RawRequest
            | ProviderAdapterOperation::ServerRequestRespond
            | ProviderAdapterOperation::BrowserBridgeContract
            | ProviderAdapterOperation::ComputerBridgeContract => {
                policy.approval_boundary = true;
            }
            _ => {}
        }

        match operation {
            ProviderAdapterOperation::ThreadShellCommand => {
                policy.requires_user_initiation = true;
                policy.escapes_thread_sandbox = true;
                policy.reason = Some(
                    "thread shell commands are explicit user actions and run outside the thread sandbox"
                        .to_string(),
                );
            }
            ProviderAdapterOperation::RawRequest => {
                policy.reason = Some(
                    "raw provider requests bypass normalized operation policy and must be separately authorized"
                        .to_string(),
                );
            }
            _ => {}
        }

        policy
    }

    #[must_use]
    pub fn ace_provider_adapter_contract() -> ProviderAdapterContract {
        let operations = ace_provider_adapter_operations();
        ProviderAdapterContract {
            version: 9,
            websocket_first: true,
            raw_payload_policy: "preserve_provider_payloads".to_string(),
            raw_payload: ace_provider_raw_payload_policy(),
            required_capabilities: ace_provider_contract_requirements(),
            feature_families: provider_adapter_feature_families(&operations),
            operations,
            normalized_thread_item_kinds: vec![
                ThreadItemKind::UserMessage,
                ThreadItemKind::HookPrompt,
                ThreadItemKind::AgentMessage,
                ThreadItemKind::Plan,
                ThreadItemKind::Reasoning,
                ThreadItemKind::CommandExecution,
                ThreadItemKind::FileChange,
                ThreadItemKind::McpToolCall,
                ThreadItemKind::DynamicToolCall,
                ThreadItemKind::CollabAgentToolCall,
                ThreadItemKind::SubAgentActivity,
                ThreadItemKind::WebSearch,
                ThreadItemKind::ImageView,
                ThreadItemKind::ImageGeneration,
                ThreadItemKind::EnteredReviewMode,
                ThreadItemKind::ExitedReviewMode,
                ThreadItemKind::ContextCompaction,
                ThreadItemKind::Unknown,
            ],
            normalized_server_request_kinds: vec![
                ServerRequestKind::CommandApproval,
                ServerRequestKind::FileChangeApproval,
                ServerRequestKind::ToolUserInput,
                ServerRequestKind::McpElicitation,
                ServerRequestKind::PermissionApproval,
                ServerRequestKind::DynamicToolCall,
                ServerRequestKind::AccountTokenRefresh,
                ServerRequestKind::Attestation,
                ServerRequestKind::ApplyPatchApproval,
                ServerRequestKind::ExecApproval,
                ServerRequestKind::Unknown,
            ],
            runtime_signal_kinds: vec![
                RuntimeSignalKind::Warning,
                RuntimeSignalKind::ModelRerouted,
                RuntimeSignalKind::RealtimeTranscriptDelta,
                RuntimeSignalKind::RealtimeAudioDelta,
                RuntimeSignalKind::ThreadLifecycleChanged,
                RuntimeSignalKind::ThreadSettingsUpdated,
                RuntimeSignalKind::ThreadTokenUsageUpdated,
                RuntimeSignalKind::TurnDiffUpdated,
                RuntimeSignalKind::ProcessExited,
                RuntimeSignalKind::ServerRequestResolved,
                RuntimeSignalKind::ProviderStateUpdated,
                RuntimeSignalKind::TurnLifecycleChanged,
                RuntimeSignalKind::RealtimeSessionUpdated,
                RuntimeSignalKind::TurnModerationUpdated,
                RuntimeSignalKind::AutoApprovalReviewUpdated,
                RuntimeSignalKind::ReviewModeUpdated,
                RuntimeSignalKind::SubagentAction,
                RuntimeSignalKind::HandoffUpdated,
                RuntimeSignalKind::PlanImplementationUpdated,
                RuntimeSignalKind::ApprovalRetryRecorded,
                RuntimeSignalKind::GoalUpdated,
                RuntimeSignalKind::ForkUpdated,
                RuntimeSignalKind::SideChatUpdated,
            ],
            provider_event_types: vec![
                "raw_notification".to_string(),
                "raw_server_request".to_string(),
                "semantic_tool".to_string(),
                "thread_item".to_string(),
                "server_request".to_string(),
                "server_request_resolved".to_string(),
                "runtime_signal".to_string(),
                "stderr_line".to_string(),
                "exited".to_string(),
            ],
            tool_transports: vec![
                ToolTransport::CodexBuiltin,
                ToolTransport::CodexDynamic,
                ToolTransport::DynamicTool,
                ToolTransport::Mcp,
                ToolTransport::AppConnector,
                ToolTransport::BrowserBridge,
                ToolTransport::ComputerBridge,
                ToolTransport::Shell,
                ToolTransport::Filesystem,
                ToolTransport::Process,
            ],
            tool_surfaces: vec![
                ToolSurface::Browser,
                ToolSurface::Computer,
                ToolSurface::Terminal,
                ToolSurface::Filesystem,
                ToolSurface::Git,
                ToolSurface::Github,
                ToolSurface::WebSearch,
                ToolSurface::Image,
                ToolSurface::Subagent,
                ToolSurface::Plan,
                ToolSurface::Realtime,
                ToolSurface::Handoff,
                ToolSurface::Review,
                ToolSurface::Skill,
                ToolSurface::Plugin,
                ToolSurface::App,
                ToolSurface::GenericMcp,
                ToolSurface::Unknown,
            ],
            tool_action_kinds: vec![
                ToolActionKind::BrowserClick,
                ToolActionKind::BrowserType,
                ToolActionKind::BrowserNavigate,
                ToolActionKind::BrowserScreenshot,
                ToolActionKind::BrowserInspect,
                ToolActionKind::BrowserLogs,
                ToolActionKind::BrowserTab,
                ToolActionKind::BrowserConsole,
                ToolActionKind::BrowserScroll,
                ToolActionKind::BrowserKey,
                ToolActionKind::BrowserClipboard,
                ToolActionKind::BrowserWait,
                ToolActionKind::BrowserViewport,
                ToolActionKind::BrowserZoom,
                ToolActionKind::ComputerClick,
                ToolActionKind::ComputerType,
                ToolActionKind::ComputerScroll,
                ToolActionKind::ComputerKey,
                ToolActionKind::ComputerScreenshot,
                ToolActionKind::ComputerApp,
                ToolActionKind::TerminalRun,
                ToolActionKind::TerminalWrite,
                ToolActionKind::TerminalResize,
                ToolActionKind::TerminalTerminate,
                ToolActionKind::TerminalOutput,
                ToolActionKind::FileRead,
                ToolActionKind::FileEdit,
                ToolActionKind::FilePatch,
                ToolActionKind::FileSearch,
                ToolActionKind::GitCommit,
                ToolActionKind::GitPush,
                ToolActionKind::GithubIssue,
                ToolActionKind::GithubPullRequest,
                ToolActionKind::GithubCheck,
                ToolActionKind::GithubCommit,
                ToolActionKind::GithubSearch,
                ToolActionKind::WebSearch,
                ToolActionKind::ImageView,
                ToolActionKind::ImageGenerate,
                ToolActionKind::SubagentSpawn,
                ToolActionKind::SubagentSteer,
                ToolActionKind::SubagentStop,
                ToolActionKind::PlanContinue,
                ToolActionKind::PlanFork,
                ToolActionKind::PlanSideImplementation,
                ToolActionKind::RealtimeStart,
                ToolActionKind::RealtimeStop,
                ToolActionKind::RealtimeAppendText,
                ToolActionKind::RealtimeAppendSpeech,
                ToolActionKind::RealtimeAppendAudio,
                ToolActionKind::RealtimeListVoices,
                ToolActionKind::HandoffAgent,
                ToolActionKind::HandoffLocation,
                ToolActionKind::ReviewStart,
                ToolActionKind::SkillList,
                ToolActionKind::SkillRead,
                ToolActionKind::SkillInstall,
                ToolActionKind::SkillConfigure,
                ToolActionKind::PluginList,
                ToolActionKind::PluginRead,
                ToolActionKind::PluginInstall,
                ToolActionKind::PluginUninstall,
                ToolActionKind::PluginShare,
                ToolActionKind::PluginMarketplaceAdd,
                ToolActionKind::PluginMarketplaceRemove,
                ToolActionKind::PluginMarketplaceUpgrade,
                ToolActionKind::AppList,
                ToolActionKind::AppConfigure,
                ToolActionKind::ToolRun,
            ],
            execution_locations: vec![
                ExecutionLocation::Local,
                ExecutionLocation::Worktree,
                ExecutionLocation::RemoteHost,
                ExecutionLocation::Cloud,
            ],
        }
    }

    #[must_use]
    pub fn provider_adapter_feature_families(
        operations: &[ProviderAdapterOperationSpec],
    ) -> Vec<ProviderAdapterFeatureFamily> {
        let mut families = BTreeMap::<ProviderFeatureCategory, ProviderAdapterFeatureFamily>::new();
        for operation in operations {
            let family = families.entry(operation.category).or_insert_with(|| {
                ProviderAdapterFeatureFamily {
                    category: operation.category,
                    total_operations: 0,
                    required_operations: 0,
                    optional_operations: 0,
                    version_gated_operations: 0,
                    deferred_operations: 0,
                    operations: Vec::new(),
                }
            });
            family.total_operations += 1;
            family.operations.push(operation.operation);
            match operation.support {
                ProviderAdapterOperationSupport::Required => family.required_operations += 1,
                ProviderAdapterOperationSupport::Optional => family.optional_operations += 1,
                ProviderAdapterOperationSupport::VersionGated => {
                    family.version_gated_operations += 1;
                }
                ProviderAdapterOperationSupport::Deferred => family.deferred_operations += 1,
            }
        }
        families.into_values().collect()
    }

    #[must_use]
    pub fn ace_provider_raw_payload_policy() -> ProviderRawPayloadPolicy {
        ProviderRawPayloadPolicy {
            retention: ProviderRawPayloadRetention::PreserveProviderPayloads,
            preserve_provider_method: true,
            preserve_provider_ids: true,
            preserve_schema_version: true,
            preserve_raw_args: true,
            preserve_raw_result: true,
            inspector_only_by_default: true,
            large_payload_strategy: ProviderLargePayloadStrategy::StoreOnceReferenceDeltas,
        }
    }

    #[must_use]
    pub fn provider_contract_report(descriptor: &ProviderDescriptor) -> ProviderContractReport {
        let requirements = ace_provider_contract_requirements()
            .into_iter()
            .map(|requirement| {
                let available_version = descriptor
                    .capabilities
                    .iter()
                    .find(|capability| capability.key == requirement.key)
                    .map(|capability| capability.version);
                let satisfied = available_version
                    .map(|version| version >= requirement.min_version)
                    .unwrap_or(false);
                ProviderContractRequirementStatus {
                    key: requirement.key,
                    min_version: requirement.min_version,
                    required: requirement.required,
                    available_version,
                    satisfied,
                }
            })
            .collect::<Vec<_>>();
        let missing_required = requirements
            .iter()
            .filter(|requirement| requirement.required && !requirement.satisfied)
            .map(|requirement| requirement.key.clone())
            .collect::<Vec<_>>();
        ProviderContractReport {
            provider: descriptor.kind,
            satisfies_required: missing_required.is_empty(),
            requirements,
            capabilities: descriptor.capabilities.clone(),
            missing_required,
        }
    }

    #[must_use]
    pub fn provider_adapter_invocation_kind(
        spec: &ProviderAdapterOperationSpec,
    ) -> ProviderAdapterInvocationKind {
        if spec.support == ProviderAdapterOperationSupport::Deferred {
            return ProviderAdapterInvocationKind::Deferred;
        }

        match spec.operation {
            ProviderAdapterOperation::BrowserBridgeContract
            | ProviderAdapterOperation::ComputerBridgeContract => {
                ProviderAdapterInvocationKind::HostToolContract
            }
            ProviderAdapterOperation::ProviderEvents
            | ProviderAdapterOperation::ToolEventNormalize
            | ProviderAdapterOperation::ServerRequestNormalize
            | ProviderAdapterOperation::ThreadItemNormalize
            | ProviderAdapterOperation::RuntimeSignalNormalize
            | ProviderAdapterOperation::SemanticTools => ProviderAdapterInvocationKind::EventStream,
            _ => match spec.provider_methods.len() {
                0 => ProviderAdapterInvocationKind::TypedApi,
                1 => ProviderAdapterInvocationKind::DirectProviderMethod,
                _ => ProviderAdapterInvocationKind::CompositeTypedApi,
            },
        }
    }

    #[must_use]
    pub fn provider_adapter_operation_availability(
        spec: &ProviderAdapterOperationSpec,
    ) -> ProviderAdapterOperationAvailability {
        match spec.support {
            ProviderAdapterOperationSupport::Required => {
                ProviderAdapterOperationAvailability::Available
            }
            ProviderAdapterOperationSupport::Optional => {
                ProviderAdapterOperationAvailability::Optional
            }
            ProviderAdapterOperationSupport::VersionGated => {
                ProviderAdapterOperationAvailability::VersionGated
            }
            ProviderAdapterOperationSupport::Deferred => {
                ProviderAdapterOperationAvailability::Deferred
            }
        }
    }

    #[must_use]
    pub fn provider_adapter_operation_availability_reason(
        spec: &ProviderAdapterOperationSpec,
    ) -> Option<String> {
        match spec.support {
            ProviderAdapterOperationSupport::Required => None,
            ProviderAdapterOperationSupport::Optional => {
                Some("optional operation; provider may expose it when supported".to_string())
            }
            ProviderAdapterOperationSupport::VersionGated => Some(
                "version-gated operation; verify installed provider support before use".to_string(),
            ),
            ProviderAdapterOperationSupport::Deferred => {
                Some("intentionally deferred in the current adapter contract".to_string())
            }
        }
    }

    #[must_use]
    pub fn provider_adapter_operation_gate(
        spec: &ProviderAdapterOperationSpec,
    ) -> Option<ProviderAdapterOperationGate> {
        match spec.support {
            ProviderAdapterOperationSupport::Required | ProviderAdapterOperationSupport::Deferred => {
                None
            }
            ProviderAdapterOperationSupport::Optional => Some(ProviderAdapterOperationGate {
                kind: ProviderAdapterOperationGateKind::OptionalProviderMethod,
                provider_methods: spec.provider_methods.clone(),
                reason: "optional provider method; check installed provider support before showing as guaranteed"
                    .to_string(),
            }),
            ProviderAdapterOperationSupport::VersionGated => Some(ProviderAdapterOperationGate {
                kind: ProviderAdapterOperationGateKind::VersionGatedProviderMethod,
                provider_methods: spec.provider_methods.clone(),
                reason:
                    "version-gated provider method; check installed provider support before invoking"
                        .to_string(),
            }),
        }
    }

    #[must_use]
    pub fn provider_adapter_operation_required_hooks(
        spec: &ProviderAdapterOperationSpec,
    ) -> Vec<ProviderAdapterRuntimeHook> {
        if spec.support == ProviderAdapterOperationSupport::Deferred {
            return Vec::new();
        }

        match spec.operation {
            ProviderAdapterOperation::ProviderEvents
            | ProviderAdapterOperation::ToolEventNormalize
            | ProviderAdapterOperation::ServerRequestNormalize
            | ProviderAdapterOperation::ThreadItemNormalize
            | ProviderAdapterOperation::RuntimeSignalNormalize
            | ProviderAdapterOperation::SemanticTools => {
                vec![ProviderAdapterRuntimeHook::EventSource]
            }
            ProviderAdapterOperation::BrowserBridgeContract
            | ProviderAdapterOperation::ComputerBridgeContract => {
                vec![ProviderAdapterRuntimeHook::HostToolRegistry]
            }
            ProviderAdapterOperation::ServerRequestRespond => {
                vec![ProviderAdapterRuntimeHook::ServerRequestResponder]
            }
            _ => Vec::new(),
        }
    }

    #[must_use]
    pub fn provider_adapter_profile(descriptor: &ProviderDescriptor) -> ProviderAdapterProfile {
        let contract = ace_provider_adapter_contract();
        ProviderAdapterProfile {
            provider: descriptor.kind,
            descriptor: descriptor.clone(),
            contract_report: provider_contract_report(descriptor),
            contract_version: contract.version,
            websocket_first: contract.websocket_first,
            raw_payload_policy: contract.raw_payload_policy,
            raw_payload: contract.raw_payload,
            operations: contract
                .operations
                .iter()
                .map(ProviderAdapterOperationProfile::from_spec)
                .collect(),
        }
    }

    fn required_hook_operations(
        profile: &ProviderAdapterProfile,
        hook: ProviderAdapterRuntimeHook,
    ) -> Vec<ProviderAdapterOperation> {
        profile
            .operations
            .iter()
            .filter(|operation| operation.support == ProviderAdapterOperationSupport::Required)
            .filter_map(|operation| {
                if operation.required_runtime_hooks.contains(&hook) {
                    Some(operation.operation)
                } else {
                    None
                }
            })
            .collect()
    }

    fn provider_adapter_family_runtime(
        profile: &ProviderAdapterProfile,
        hooks: &[ProviderAdapterRuntimeHookStatus],
    ) -> Vec<ProviderAdapterFeatureFamilyRuntime> {
        let mut families =
            BTreeMap::<ProviderFeatureCategory, ProviderAdapterFeatureFamilyRuntime>::new();
        for operation in &profile.operations {
            let family = families.entry(operation.category).or_insert_with(|| {
                ProviderAdapterFeatureFamilyRuntime {
                    category: operation.category,
                    total_operations: 0,
                    hook_ready_operations: 0,
                    hook_blocked_operations: 0,
                    required_hooks: Vec::new(),
                    missing_hooks: Vec::new(),
                    operations: Vec::new(),
                }
            });
            family.total_operations += 1;
            family.operations.push(operation.operation);
            merge_hooks(
                &mut family.required_hooks,
                &operation.required_runtime_hooks,
            );
            let missing = operation
                .required_runtime_hooks
                .iter()
                .copied()
                .filter(|hook| !hook_is_available(hooks, *hook))
                .collect::<Vec<_>>();
            if missing.is_empty() {
                family.hook_ready_operations += 1;
            } else {
                family.hook_blocked_operations += 1;
                merge_hooks(&mut family.missing_hooks, &missing);
            }
        }
        families.into_values().collect()
    }

    fn hook_is_available(
        hooks: &[ProviderAdapterRuntimeHookStatus],
        target: ProviderAdapterRuntimeHook,
    ) -> bool {
        hooks
            .iter()
            .find(|hook| hook.hook == target)
            .is_some_and(|hook| hook.available)
    }

    fn merge_hooks(
        target: &mut Vec<ProviderAdapterRuntimeHook>,
        hooks: &[ProviderAdapterRuntimeHook],
    ) {
        for hook in hooks {
            if !target.contains(hook) {
                target.push(*hook);
            }
        }
    }

    impl ProviderRegistry {
        #[must_use]
        pub fn new() -> Self {
            Self::default()
        }

        #[must_use]
        pub fn with_driver(mut self, driver: DynProviderDriver) -> Self {
            self.register(driver);
            self
        }

        #[must_use]
        pub fn with_event_source(
            mut self,
            provider: ProviderKind,
            source: DynProviderEventSource,
        ) -> Self {
            self.register_event_source(provider, source);
            self
        }

        #[must_use]
        pub fn with_server_request_responder(
            mut self,
            provider: ProviderKind,
            responder: DynProviderServerRequestResponder,
        ) -> Self {
            self.register_server_request_responder(provider, responder);
            self
        }

        #[must_use]
        pub fn with_state_source(
            mut self,
            provider: ProviderKind,
            source: DynProviderStateSource,
        ) -> Self {
            self.register_state_source(provider, source);
            self
        }

        #[must_use]
        pub fn with_host_tool_registry(mut self, provider: ProviderKind) -> Self {
            self.register_host_tool_registry(provider);
            self
        }

        pub fn register(&mut self, driver: DynProviderDriver) {
            let kind = driver.descriptor().kind;
            self.drivers.insert(kind, driver);
        }

        pub fn register_event_source(
            &mut self,
            provider: ProviderKind,
            source: DynProviderEventSource,
        ) {
            self.event_sources.insert(provider, source);
        }

        pub fn register_server_request_responder(
            &mut self,
            provider: ProviderKind,
            responder: DynProviderServerRequestResponder,
        ) {
            self.server_request_responders.insert(provider, responder);
        }

        pub fn register_state_source(
            &mut self,
            provider: ProviderKind,
            source: DynProviderStateSource,
        ) {
            self.state_sources.insert(provider, source);
        }

        pub fn register_host_tool_registry(&mut self, provider: ProviderKind) {
            self.host_tool_registries.insert(provider);
        }

        #[must_use]
        pub fn get(&self, kind: ProviderKind) -> Option<DynProviderDriver> {
            self.drivers.get(&kind).cloned()
        }

        #[must_use]
        pub fn has_event_source(&self, kind: ProviderKind) -> bool {
            self.event_sources.contains_key(&kind)
        }

        #[must_use]
        pub fn has_server_request_responder(&self, kind: ProviderKind) -> bool {
            self.server_request_responders.contains_key(&kind)
        }

        #[must_use]
        pub fn has_state_source(&self, kind: ProviderKind) -> bool {
            self.state_sources.contains_key(&kind)
        }

        #[must_use]
        pub fn has_host_tool_registry(&self, kind: ProviderKind) -> bool {
            self.host_tool_registries.contains(&kind)
        }

        #[must_use]
        pub fn descriptors(&self) -> Vec<ProviderDescriptor> {
            let mut descriptors = self
                .drivers
                .values()
                .map(|driver| driver.descriptor())
                .collect::<Vec<_>>();
            descriptors.sort_by_key(|descriptor| descriptor.kind);
            descriptors
        }

        #[must_use]
        pub fn contract_reports(&self) -> Vec<ProviderContractReport> {
            self.descriptors()
                .iter()
                .map(provider_contract_report)
                .collect()
        }

        #[must_use]
        pub fn adapter_profiles(&self) -> Vec<ProviderAdapterProfile> {
            let mut profiles = self
                .drivers
                .values()
                .map(|driver| driver.adapter_profile())
                .collect::<Vec<_>>();
            profiles.sort_by_key(|profile| profile.provider);
            profiles
        }

        #[must_use]
        pub fn adapter_profile(&self, kind: ProviderKind) -> Option<ProviderAdapterProfile> {
            self.drivers
                .get(&kind)
                .map(|driver| driver.adapter_profile())
        }

        #[must_use]
        pub fn adapter_runtime_report(
            &self,
            kind: ProviderKind,
        ) -> Option<ProviderAdapterRuntimeReport> {
            let profile = self.adapter_profile(kind)?;
            let event_operations =
                required_hook_operations(&profile, ProviderAdapterRuntimeHook::EventSource);
            let server_request_operations = required_hook_operations(
                &profile,
                ProviderAdapterRuntimeHook::ServerRequestResponder,
            );
            let host_tool_operations =
                required_hook_operations(&profile, ProviderAdapterRuntimeHook::HostToolRegistry);
            let event_available = self.has_event_source(kind);
            let responder_available = self.has_server_request_responder(kind);
            let host_tool_available = self.has_host_tool_registry(kind);
            let hooks = vec![
                ProviderAdapterRuntimeHookStatus {
                    hook: ProviderAdapterRuntimeHook::EventSource,
                    required: !event_operations.is_empty(),
                    available: event_available,
                    operations: event_operations,
                },
                ProviderAdapterRuntimeHookStatus {
                    hook: ProviderAdapterRuntimeHook::ServerRequestResponder,
                    required: !server_request_operations.is_empty(),
                    available: responder_available,
                    operations: server_request_operations,
                },
                ProviderAdapterRuntimeHookStatus {
                    hook: ProviderAdapterRuntimeHook::HostToolRegistry,
                    required: !host_tool_operations.is_empty(),
                    available: host_tool_available,
                    operations: host_tool_operations,
                },
            ];
            let missing_required_hooks = hooks
                .iter()
                .filter(|hook| hook.required && !hook.available)
                .map(|hook| hook.hook)
                .collect::<Vec<_>>();
            Some(ProviderAdapterRuntimeReport {
                provider: kind,
                satisfies_required_hooks: missing_required_hooks.is_empty(),
                feature_families: provider_adapter_family_runtime(&profile, &hooks),
                hooks,
                missing_required_hooks,
            })
        }

        #[must_use]
        pub fn adapter_runtime_reports(&self) -> Vec<ProviderAdapterRuntimeReport> {
            let mut reports = self
                .drivers
                .keys()
                .filter_map(|provider| self.adapter_runtime_report(*provider))
                .collect::<Vec<_>>();
            reports.sort_by_key(|report| report.provider);
            reports
        }

        #[must_use]
        pub fn features(&self, kind: ProviderKind) -> Option<Vec<ProviderFeature>> {
            self.drivers.get(&kind).map(|driver| driver.features())
        }

        pub async fn status(
            &self,
            kind: ProviderKind,
        ) -> Result<ProviderDriverStatus, ProviderRuntimeError> {
            let driver = self
                .get(kind)
                .ok_or(ProviderRuntimeError::ProviderUnavailable { provider: kind })?;
            Ok(driver.status().await)
        }

        pub async fn lifecycle_action(
            &self,
            kind: ProviderKind,
            action: ProviderLifecycleAction,
            grace: Duration,
        ) -> Result<ProviderLifecycleResult, ProviderRuntimeError> {
            let driver = self
                .get(kind)
                .ok_or(ProviderRuntimeError::ProviderUnavailable { provider: kind })?;
            driver
                .lifecycle_action(action, grace)
                .await
                .map_err(Into::into)
        }

        pub async fn request(
            &self,
            kind: ProviderKind,
            request: ProviderRequest,
        ) -> Result<Value, ProviderRuntimeError> {
            let driver = self
                .get(kind)
                .ok_or(ProviderRuntimeError::ProviderUnavailable { provider: kind })?;
            driver.request(request).await.map_err(Into::into)
        }

        pub async fn next_events(
            &self,
            kind: ProviderKind,
        ) -> Result<Option<Vec<ProviderEvent>>, ProviderRuntimeError> {
            let source = self
                .event_sources
                .get(&kind)
                .ok_or(ProviderRuntimeError::ProviderUnavailable { provider: kind })?;
            source.next_events().await.map_err(Into::into)
        }

        pub async fn respond_server_request_result(
            &self,
            kind: ProviderKind,
            request_id: String,
            result: Value,
        ) -> Result<(), ProviderRuntimeError> {
            let responder = self
                .server_request_responders
                .get(&kind)
                .ok_or(ProviderRuntimeError::ProviderUnavailable { provider: kind })?;
            responder
                .respond_server_request_result(request_id, result)
                .await
                .map_err(Into::into)
        }

        pub async fn respond_server_request_error(
            &self,
            kind: ProviderKind,
            request_id: String,
            code: i64,
            message: String,
        ) -> Result<(), ProviderRuntimeError> {
            let responder = self
                .server_request_responders
                .get(&kind)
                .ok_or(ProviderRuntimeError::ProviderUnavailable { provider: kind })?;
            responder
                .respond_server_request_error(request_id, code, message)
                .await
                .map_err(Into::into)
        }

        pub async fn runtime_state_snapshot(
            &self,
            kind: ProviderKind,
        ) -> Result<AgentRuntimeSnapshot, ProviderRuntimeError> {
            let source = self
                .state_sources
                .get(&kind)
                .ok_or(ProviderRuntimeError::ProviderUnavailable { provider: kind })?;
            source.runtime_state_snapshot().await.map_err(Into::into)
        }
    }

    #[derive(Debug, thiserror::Error)]
    pub enum ProviderDriverError {
        #[error("provider `{provider}` request `{method}` failed: {message}")]
        RequestFailed {
            provider: String,
            method: String,
            message: String,
        },
        #[error("provider `{provider}` does not support lifecycle action `{action:?}`")]
        LifecycleUnsupported {
            provider: String,
            action: ProviderLifecycleAction,
        },
    }

    #[derive(Debug, thiserror::Error)]
    pub enum ProviderRuntimeError {
        #[error("provider `{provider:?}` is not registered")]
        ProviderUnavailable { provider: ProviderKind },
        #[error(transparent)]
        Driver(#[from] ProviderDriverError),
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use async_trait::async_trait;
        use serde_json::json;
        use std::sync::Mutex;

        struct FakeProviderDriver {
            descriptor: ProviderDescriptor,
            requests: Mutex<Vec<ProviderRequest>>,
        }

        #[async_trait]
        impl ProviderDriver for FakeProviderDriver {
            fn descriptor(&self) -> ProviderDescriptor {
                self.descriptor.clone()
            }

            async fn request(
                &self,
                request: ProviderRequest,
            ) -> Result<Value, ProviderDriverError> {
                self.requests.lock().expect("requests").push(request);
                Ok(json!({ "ok": true }))
            }
        }

        struct FakeProviderEventSource {
            events: Mutex<Vec<ProviderEvent>>,
        }

        #[async_trait]
        impl ProviderEventSource for FakeProviderEventSource {
            async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>, ProviderDriverError> {
                let mut events = self.events.lock().expect("events");
                if events.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(std::mem::take(&mut events)))
                }
            }
        }

        #[derive(Debug, Clone, PartialEq)]
        enum FakeServerRequestDecision {
            Result {
                request_id: String,
                result: Value,
            },
            Error {
                request_id: String,
                code: i64,
                message: String,
            },
        }

        struct FakeServerRequestResponder {
            decisions: Mutex<Vec<FakeServerRequestDecision>>,
        }

        #[async_trait]
        impl ProviderServerRequestResponder for FakeServerRequestResponder {
            async fn respond_server_request_result(
                &self,
                request_id: String,
                result: Value,
            ) -> Result<(), ProviderDriverError> {
                self.decisions
                    .lock()
                    .expect("decisions")
                    .push(FakeServerRequestDecision::Result { request_id, result });
                Ok(())
            }

            async fn respond_server_request_error(
                &self,
                request_id: String,
                code: i64,
                message: String,
            ) -> Result<(), ProviderDriverError> {
                self.decisions
                    .lock()
                    .expect("decisions")
                    .push(FakeServerRequestDecision::Error {
                        request_id,
                        code,
                        message,
                    });
                Ok(())
            }
        }

        struct FakeProviderStateSource {
            snapshot: AgentRuntimeSnapshot,
        }

        #[async_trait]
        impl ProviderStateSource for FakeProviderStateSource {
            async fn runtime_state_snapshot(
                &self,
            ) -> Result<AgentRuntimeSnapshot, ProviderDriverError> {
                Ok(self.snapshot.clone())
            }
        }

        #[tokio::test]
        async fn registry_routes_requests_by_provider_kind() {
            let driver = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::Codex,
                    capabilities: vec![ProviderCapability {
                        key: "codex.app_server".to_string(),
                        version: 1,
                    }],
                },
                requests: Mutex::new(Vec::new()),
            });
            let registry = ProviderRegistry::new().with_driver(driver.clone());

            let response = registry
                .request(
                    ProviderKind::Codex,
                    ProviderRequest {
                        method: "thread/read".to_string(),
                        params: json!({ "threadId": "thread-1" }),
                        timeout: Duration::from_secs(1),
                    },
                )
                .await
                .expect("request");

            assert_eq!(response["ok"], true);
            assert_eq!(
                driver.requests.lock().expect("requests")[0].method,
                "thread/read"
            );
        }

        #[test]
        fn registry_reports_sorted_provider_descriptors() {
            let codex = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::Codex,
                    capabilities: vec![ProviderCapability {
                        key: "codex.app_server".to_string(),
                        version: 1,
                    }],
                },
                requests: Mutex::new(Vec::new()),
            });
            let claude = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::ClaudeCode,
                    capabilities: vec![ProviderCapability {
                        key: "claude_code.cli".to_string(),
                        version: 1,
                    }],
                },
                requests: Mutex::new(Vec::new()),
            });

            let mut registry = ProviderRegistry::new();
            registry.register(claude);
            registry.register(codex);

            let descriptors = registry.descriptors();
            assert_eq!(descriptors[0].kind, ProviderKind::Codex);
            assert_eq!(descriptors[1].kind, ProviderKind::ClaudeCode);
        }

        #[test]
        fn contract_report_marks_missing_required_capabilities() {
            let descriptor = ProviderDescriptor {
                kind: ProviderKind::ClaudeCode,
                capabilities: vec![ProviderCapability {
                    key: "provider.semantic_tools".to_string(),
                    version: 1,
                }],
            };

            let report = provider_contract_report(&descriptor);
            assert!(!report.satisfies_required);
            assert_eq!(
                report.missing_required,
                vec![
                    "provider.adapter_contract".to_string(),
                    "provider.normalized_events".to_string(),
                    "provider.normalized_server_requests".to_string(),
                ]
            );
            assert!(
                report
                    .requirements
                    .iter()
                    .any(|requirement| requirement.key == "provider.semantic_tools"
                        && requirement.satisfied)
            );
        }

        #[test]
        fn registry_reports_provider_contract_statuses() {
            let driver = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::Ace,
                    capabilities: ace_provider_contract_requirements()
                        .into_iter()
                        .filter(|requirement| requirement.required)
                        .map(|requirement| ProviderCapability {
                            key: requirement.key,
                            version: requirement.min_version,
                        })
                        .collect(),
                },
                requests: Mutex::new(Vec::new()),
            });
            let registry = ProviderRegistry::new().with_driver(driver);

            let reports = registry.contract_reports();
            assert_eq!(reports.len(), 1);
            assert_eq!(reports[0].provider, ProviderKind::Ace);
            assert!(reports[0].satisfies_required);
            assert!(reports[0].missing_required.is_empty());
        }

        #[test]
        fn registry_reports_provider_adapter_profiles() {
            let codex = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::Codex,
                    capabilities: ace_provider_contract_requirements()
                        .into_iter()
                        .filter(|requirement| requirement.required)
                        .map(|requirement| ProviderCapability {
                            key: requirement.key,
                            version: requirement.min_version,
                        })
                        .collect(),
                },
                requests: Mutex::new(Vec::new()),
            });
            let ace = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::Ace,
                    capabilities: vec![ProviderCapability {
                        key: "provider.semantic_tools".to_string(),
                        version: 1,
                    }],
                },
                requests: Mutex::new(Vec::new()),
            });
            let registry = ProviderRegistry::new().with_driver(codex).with_driver(ace);

            let profiles = registry.adapter_profiles();
            assert_eq!(profiles.len(), 2);
            let codex_profile = profiles
                .iter()
                .find(|profile| profile.provider == ProviderKind::Codex)
                .expect("codex profile");
            assert_eq!(codex_profile.contract_version, 9);
            assert!(codex_profile.websocket_first);
            assert_eq!(
                codex_profile.raw_payload.retention,
                ProviderRawPayloadRetention::PreserveProviderPayloads
            );
            assert!(codex_profile.raw_payload.preserve_provider_ids);
            assert_eq!(
                codex_profile.raw_payload.large_payload_strategy,
                ProviderLargePayloadStrategy::StoreOnceReferenceDeltas
            );
            assert!(codex_profile.contract_report.satisfies_required);
            assert!(
                registry
                    .adapter_profile(ProviderKind::Ace)
                    .expect("ace profile")
                    .contract_report
                    .missing_required
                    .contains(&"provider.adapter_contract".to_string())
            );
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::ThreadRead
                    && operation.invocation == ProviderAdapterInvocationKind::DirectProviderMethod
                    && operation.direct_invocation
                    && operation.availability == ProviderAdapterOperationAvailability::Available
                    && operation.availability_reason.is_none()
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::ProviderMethodsList
                    && operation.invocation == ProviderAdapterInvocationKind::TypedApi
                    && operation.category == ProviderFeatureCategory::Native
                    && operation.availability == ProviderAdapterOperationAvailability::Available
                    && operation.policy.read_only
                    && operation.provider_methods.is_empty()
                    && operation.required_runtime_hooks.is_empty()
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::RawRequest
                    && operation.availability == ProviderAdapterOperationAvailability::Optional
                    && !operation.policy.read_only
                    && operation.policy.approval_boundary
                    && operation.runtime_gate.as_ref().is_some_and(|gate| {
                        gate.kind == ProviderAdapterOperationGateKind::OptionalProviderMethod
                    })
                    && operation
                        .availability_reason
                        .as_deref()
                        .is_some_and(|reason| reason.contains("optional"))
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::PlanForkForImplementation
                    && operation.invocation == ProviderAdapterInvocationKind::CompositeTypedApi
                    && !operation.direct_invocation
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::ProviderEvents
                    && operation.invocation == ProviderAdapterInvocationKind::EventStream
                    && operation.required_runtime_hooks
                        == vec![ProviderAdapterRuntimeHook::EventSource]
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::SemanticTools
                    && operation.invocation == ProviderAdapterInvocationKind::EventStream
                    && operation.required_runtime_hooks
                        == vec![ProviderAdapterRuntimeHook::EventSource]
            }));
            for normalization_operation in [
                ProviderAdapterOperation::ToolEventNormalize,
                ProviderAdapterOperation::ServerRequestNormalize,
                ProviderAdapterOperation::ThreadItemNormalize,
                ProviderAdapterOperation::RuntimeSignalNormalize,
            ] {
                assert!(
                    codex_profile.operations.iter().any(|operation| {
                        operation.operation == normalization_operation
                            && operation.invocation == ProviderAdapterInvocationKind::EventStream
                            && operation.required_runtime_hooks
                                == vec![ProviderAdapterRuntimeHook::EventSource]
                    }),
                    "adapter profile should expose {normalization_operation:?}"
                );
            }
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::ServerRequestRespond
                    && operation.required_runtime_hooks
                        == vec![ProviderAdapterRuntimeHook::ServerRequestResponder]
            }));
            for bridge_operation in [
                ProviderAdapterOperation::BrowserBridgeContract,
                ProviderAdapterOperation::ComputerBridgeContract,
            ] {
                let operation = codex_profile
                    .operations
                    .iter()
                    .find(|operation| operation.operation == bridge_operation)
                    .expect("bridge contract operation");
                assert_eq!(operation.category, ProviderFeatureCategory::Tools);
                assert_eq!(
                    operation.invocation,
                    ProviderAdapterInvocationKind::HostToolContract
                );
                assert_eq!(
                    operation.availability,
                    ProviderAdapterOperationAvailability::Available
                );
                assert!(!operation.policy.read_only);
                assert!(operation.policy.external_side_effects);
                assert!(operation.policy.approval_boundary);
                assert_eq!(
                    operation.required_runtime_hooks,
                    vec![ProviderAdapterRuntimeHook::HostToolRegistry]
                );
                assert_eq!(
                    codex_profile
                        .resolve_request_operation(bridge_operation)
                        .expect("bridge contract resolution"),
                    ProviderAdapterRequestResolution::HostToolContract
                );
            }
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::CloudHandoff
                    && operation.invocation == ProviderAdapterInvocationKind::Deferred
                    && operation.availability == ProviderAdapterOperationAvailability::Deferred
                    && operation
                        .availability_reason
                        .as_deref()
                        .is_some_and(|reason| reason.contains("deferred"))
                    && operation.required_runtime_hooks.is_empty()
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::CommandExec
                    && operation.availability == ProviderAdapterOperationAvailability::VersionGated
                    && operation.policy.mutates_workspace
                    && operation.policy.external_side_effects
                    && operation.policy.approval_boundary
                    && operation.runtime_gate.as_ref().is_some_and(|gate| {
                        gate.kind == ProviderAdapterOperationGateKind::VersionGatedProviderMethod
                            && gate.provider_methods == vec!["command/exec".to_string()]
                    })
                    && operation
                        .availability_reason
                        .as_deref()
                        .is_some_and(|reason| reason.contains("version-gated"))
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::ProcessSpawn
                    && operation.availability == ProviderAdapterOperationAvailability::VersionGated
                    && operation.policy.mutates_workspace
                    && operation.policy.external_side_effects
                    && operation.policy.approval_boundary
                    && operation.runtime_gate.as_ref().is_some_and(|gate| {
                        gate.kind == ProviderAdapterOperationGateKind::VersionGatedProviderMethod
                            && gate.provider_methods == vec!["process/spawn".to_string()]
                    })
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::ThreadRealtimeAppendAudio
                    && operation.category == ProviderFeatureCategory::Turns
                    && operation.availability == ProviderAdapterOperationAvailability::VersionGated
                    && operation.policy.mutates_provider_state
                    && operation.policy.external_side_effects
                    && operation.provider_methods == vec!["thread/realtime/appendAudio".to_string()]
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::RemoteControlPairingStart
                    && operation.category == ProviderFeatureCategory::Remote
                    && operation.availability == ProviderAdapterOperationAvailability::VersionGated
                    && operation.policy.mutates_provider_state
                    && operation.policy.external_side_effects
                    && operation.provider_methods == vec!["remoteControl/pairing/start".to_string()]
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::ThreadShellCommand
                    && operation.policy.requires_user_initiation
                    && operation.policy.escapes_thread_sandbox
                    && operation.policy.mutates_workspace
                    && operation.policy.approval_boundary
                    && operation
                        .policy
                        .reason
                        .as_deref()
                        .is_some_and(|reason| reason.contains("outside the thread sandbox"))
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::FsReadFile
                    && operation.policy.read_only
                    && !operation.policy.mutates_workspace
                    && !operation.policy.approval_boundary
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::FsWriteFile
                    && !operation.policy.read_only
                    && operation.policy.mutates_workspace
                    && operation.policy.approval_boundary
            }));
            assert!(codex_profile.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::SkillsInstall
                    && !operation.policy.read_only
                    && operation.policy.mutates_provider_state
                    && operation.policy.external_side_effects
                    && operation.runtime_gate.as_ref().is_some_and(|gate| {
                        gate.kind == ProviderAdapterOperationGateKind::VersionGatedProviderMethod
                            && gate.provider_methods == vec!["skills/install".to_string()]
                    })
            }));
            let expected_version_gated_contracts = [
                (
                    ProviderAdapterOperation::ThreadShellCommand,
                    "thread/shellCommand",
                    ProviderFeatureCategory::Tools,
                ),
                (
                    ProviderAdapterOperation::ProcessSpawn,
                    "process/spawn",
                    ProviderFeatureCategory::Tools,
                ),
                (
                    ProviderAdapterOperation::FuzzyFileSearchSessionStart,
                    "fuzzyFileSearch/sessionStart",
                    ProviderFeatureCategory::Search,
                ),
                (
                    ProviderAdapterOperation::CollaborationModeList,
                    "collaborationMode/list",
                    ProviderFeatureCategory::Events,
                ),
                (
                    ProviderAdapterOperation::EnvironmentAdd,
                    "environment/add",
                    ProviderFeatureCategory::Tools,
                ),
                (
                    ProviderAdapterOperation::MemoryReset,
                    "memory/reset",
                    ProviderFeatureCategory::Tools,
                ),
                (
                    ProviderAdapterOperation::ThreadTurnsItemsList,
                    "thread/turns/items/list",
                    ProviderFeatureCategory::Turns,
                ),
                (
                    ProviderAdapterOperation::SkillsConfigWrite,
                    "skills/config/write",
                    ProviderFeatureCategory::Skills,
                ),
                (
                    ProviderAdapterOperation::AppsConfigWrite,
                    "apps/configWrite",
                    ProviderFeatureCategory::Apps,
                ),
            ];
            for (operation, method, category) in expected_version_gated_contracts {
                let profile = codex_profile
                    .operation(operation)
                    .unwrap_or_else(|| panic!("missing adapter operation {operation:?}"));
                assert_eq!(profile.category, category);
                assert_eq!(
                    profile.availability,
                    ProviderAdapterOperationAvailability::VersionGated
                );
                assert_eq!(profile.canonical_method.as_deref(), Some(method));
                assert_eq!(profile.provider_methods, vec![method.to_string()]);
                assert!(profile.direct_invocation);
                assert_eq!(
                    profile.invocation,
                    ProviderAdapterInvocationKind::DirectProviderMethod
                );
            }
            let expected_optional_contracts = [
                (
                    ProviderAdapterOperation::SkillsExtraRootsSet,
                    "skills/extraRoots/set",
                    ProviderFeatureCategory::Skills,
                ),
                (
                    ProviderAdapterOperation::PluginsInstalled,
                    "plugin/installed",
                    ProviderFeatureCategory::Plugins,
                ),
                (
                    ProviderAdapterOperation::PluginsRead,
                    "plugin/read",
                    ProviderFeatureCategory::Plugins,
                ),
                (
                    ProviderAdapterOperation::PluginsUninstall,
                    "plugin/uninstall",
                    ProviderFeatureCategory::Plugins,
                ),
                (
                    ProviderAdapterOperation::PluginShareSave,
                    "plugin/share/save",
                    ProviderFeatureCategory::Plugins,
                ),
                (
                    ProviderAdapterOperation::AccountRead,
                    "account/read",
                    ProviderFeatureCategory::Account,
                ),
                (
                    ProviderAdapterOperation::ConfigValueWrite,
                    "config/value/write",
                    ProviderFeatureCategory::Config,
                ),
                (
                    ProviderAdapterOperation::FuzzyFileSearch,
                    "fuzzyFileSearch",
                    ProviderFeatureCategory::Search,
                ),
                (
                    ProviderAdapterOperation::MarketplaceUpgrade,
                    "marketplace/upgrade",
                    ProviderFeatureCategory::Plugins,
                ),
                (
                    ProviderAdapterOperation::ModelList,
                    "model/list",
                    ProviderFeatureCategory::Models,
                ),
                (
                    ProviderAdapterOperation::ModelProviderCapabilitiesRead,
                    "modelProvider/capabilities/read",
                    ProviderFeatureCategory::Models,
                ),
            ];
            for (operation, method, category) in expected_optional_contracts {
                let profile = codex_profile
                    .operation(operation)
                    .unwrap_or_else(|| panic!("missing adapter operation {operation:?}"));
                assert_eq!(profile.category, category);
                assert_eq!(
                    profile.availability,
                    ProviderAdapterOperationAvailability::Optional
                );
                assert_eq!(profile.canonical_method.as_deref(), Some(method));
                assert_eq!(profile.provider_methods, vec![method.to_string()]);
                assert!(profile.direct_invocation);
                assert_eq!(
                    profile.invocation,
                    ProviderAdapterInvocationKind::DirectProviderMethod
                );
            }
            assert_eq!(
                codex_profile.direct_provider_method(ProviderAdapterOperation::ThreadRead),
                Some("thread/read")
            );
            assert_eq!(
                codex_profile
                    .resolve_request_operation(ProviderAdapterOperation::ThreadRead)
                    .expect("thread read resolution"),
                ProviderAdapterRequestResolution::DirectProviderMethod {
                    method: "thread/read".to_string()
                }
            );
            assert_eq!(
                codex_profile
                    .operation(ProviderAdapterOperation::PlanForkForImplementation)
                    .map(|operation| operation.invocation),
                Some(ProviderAdapterInvocationKind::CompositeTypedApi)
            );
            assert_eq!(
                codex_profile
                    .resolve_request_operation(ProviderAdapterOperation::PlanForkForImplementation)
                    .expect("plan fork resolution"),
                ProviderAdapterRequestResolution::CompositeTypedApi {
                    methods: vec![
                        "thread/fork".to_string(),
                        "thread/inject_items".to_string(),
                        "turn/start".to_string(),
                    ]
                }
            );
            assert_eq!(
                codex_profile
                    .direct_provider_method(ProviderAdapterOperation::PlanForkForImplementation),
                None
            );
            assert_eq!(
                codex_profile
                    .resolve_request_operation(ProviderAdapterOperation::ProviderEvents)
                    .expect("events resolution"),
                ProviderAdapterRequestResolution::EventStream
            );
            assert_eq!(
                codex_profile
                    .resolve_request_operation(ProviderAdapterOperation::CloudHandoff)
                    .expect("cloud handoff resolution"),
                ProviderAdapterRequestResolution::Deferred
            );
            let codex_runtime = registry
                .adapter_runtime_report(ProviderKind::Codex)
                .expect("codex runtime wiring");
            assert!(!codex_runtime.satisfies_required_hooks);
            assert_eq!(
                codex_runtime.missing_required_hooks,
                vec![
                    ProviderAdapterRuntimeHook::EventSource,
                    ProviderAdapterRuntimeHook::ServerRequestResponder,
                    ProviderAdapterRuntimeHook::HostToolRegistry,
                ]
            );
            let event_source_hook = codex_runtime
                .hooks
                .iter()
                .find(|hook| {
                    hook.hook == ProviderAdapterRuntimeHook::EventSource
                        && hook.required
                        && !hook.available
                })
                .expect("missing event source hook");
            assert!(
                event_source_hook
                    .operations
                    .contains(&ProviderAdapterOperation::ProviderEvents)
            );
            assert!(
                event_source_hook
                    .operations
                    .contains(&ProviderAdapterOperation::SemanticTools)
            );
            let tools_family = codex_runtime
                .feature_families
                .iter()
                .find(|family| family.category == ProviderFeatureCategory::Tools)
                .expect("tools runtime family");
            assert!(tools_family.total_operations > 0);
            assert!(tools_family.hook_blocked_operations > 0);
            assert!(
                tools_family
                    .missing_hooks
                    .contains(&ProviderAdapterRuntimeHook::HostToolRegistry)
            );
            assert!(
                tools_family
                    .operations
                    .contains(&ProviderAdapterOperation::BrowserBridgeContract)
            );
            let events_family = codex_runtime
                .feature_families
                .iter()
                .find(|family| family.category == ProviderFeatureCategory::Events)
                .expect("events runtime family");
            assert!(
                events_family
                    .missing_hooks
                    .contains(&ProviderAdapterRuntimeHook::EventSource)
            );
        }

        #[test]
        fn registry_reports_satisfied_provider_adapter_runtime_hooks() {
            let codex = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::Codex,
                    capabilities: ace_provider_contract_requirements()
                        .into_iter()
                        .filter(|requirement| requirement.required)
                        .map(|requirement| ProviderCapability {
                            key: requirement.key,
                            version: requirement.min_version,
                        })
                        .collect(),
                },
                requests: Mutex::new(Vec::new()),
            });
            let source = Arc::new(FakeProviderEventSource {
                events: Mutex::new(Vec::new()),
            });
            let responder = Arc::new(FakeServerRequestResponder {
                decisions: Mutex::new(Vec::new()),
            });
            let registry = ProviderRegistry::new()
                .with_driver(codex)
                .with_event_source(ProviderKind::Codex, source)
                .with_server_request_responder(ProviderKind::Codex, responder)
                .with_host_tool_registry(ProviderKind::Codex);

            let report = registry
                .adapter_runtime_report(ProviderKind::Codex)
                .expect("codex runtime wiring");
            assert!(report.satisfies_required_hooks);
            assert!(report.missing_required_hooks.is_empty());
            assert!(report.hooks.iter().any(|hook| {
                hook.hook == ProviderAdapterRuntimeHook::ServerRequestResponder
                    && hook.required
                    && hook.available
                    && hook.operations == vec![ProviderAdapterOperation::ServerRequestRespond]
            }));
            assert!(report.hooks.iter().any(|hook| {
                hook.hook == ProviderAdapterRuntimeHook::HostToolRegistry
                    && hook.required
                    && hook.available
                    && hook.operations
                        == vec![
                            ProviderAdapterOperation::BrowserBridgeContract,
                            ProviderAdapterOperation::ComputerBridgeContract,
                        ]
            }));
            let tools_family = report
                .feature_families
                .iter()
                .find(|family| family.category == ProviderFeatureCategory::Tools)
                .expect("tools runtime family");
            assert_eq!(tools_family.hook_blocked_operations, 0);
            assert_eq!(tools_family.missing_hooks, Vec::new());
            assert_eq!(
                report
                    .feature_families
                    .iter()
                    .map(|family| family.total_operations)
                    .sum::<usize>(),
                ace_provider_adapter_contract().operations.len()
            );
            assert_eq!(registry.adapter_runtime_reports().len(), 1);
        }

        #[tokio::test]
        async fn registry_routes_runtime_state_snapshots_by_provider_kind() {
            let source = Arc::new(FakeProviderStateSource {
                snapshot: AgentRuntimeSnapshot {
                    provider_states: vec![crate::threads::ProviderStateRecord {
                        provider: "ace".to_string(),
                        status: "ready".to_string(),
                        message: None,
                        name: Some("Ace".to_string()),
                        metadata: json!({ "pending_server_requests": 0 }),
                    }],
                    ..AgentRuntimeSnapshot::default()
                },
            });
            let registry = ProviderRegistry::new().with_state_source(ProviderKind::Ace, source);

            assert!(registry.has_state_source(ProviderKind::Ace));
            let snapshot = registry
                .runtime_state_snapshot(ProviderKind::Ace)
                .await
                .expect("runtime state");
            assert_eq!(snapshot.provider_states[0].provider, "ace");
            assert_eq!(snapshot.provider_states[0].status, "ready");
            assert!(matches!(
                registry
                    .runtime_state_snapshot(ProviderKind::Codex)
                    .await
                    .expect_err("missing state source"),
                ProviderRuntimeError::ProviderUnavailable {
                    provider: ProviderKind::Codex
                }
            ));
        }

        #[test]
        fn adapter_profile_reports_resolution_errors_for_invalid_operation_metadata() {
            let empty_profile = ProviderAdapterProfile {
                provider: ProviderKind::ClaudeCode,
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::ClaudeCode,
                    capabilities: Vec::new(),
                },
                contract_report: provider_contract_report(&ProviderDescriptor {
                    kind: ProviderKind::ClaudeCode,
                    capabilities: Vec::new(),
                }),
                contract_version: 1,
                websocket_first: true,
                raw_payload_policy: "preserve_provider_payloads".to_string(),
                raw_payload: ace_provider_raw_payload_policy(),
                operations: Vec::new(),
            };
            assert!(matches!(
                empty_profile
                    .resolve_request_operation(ProviderAdapterOperation::ThreadRead)
                    .expect_err("missing operation"),
                ProviderAdapterRequestResolutionError::OperationNotAdvertised {
                    provider: ProviderKind::ClaudeCode,
                    operation: ProviderAdapterOperation::ThreadRead
                }
            ));

            let malformed_profile = ProviderAdapterProfile {
                operations: vec![ProviderAdapterOperationProfile {
                    operation: ProviderAdapterOperation::ThreadRead,
                    category: ProviderFeatureCategory::Threads,
                    support: ProviderAdapterOperationSupport::Required,
                    availability: ProviderAdapterOperationAvailability::Available,
                    policy: provider_adapter_operation_policy(ProviderAdapterOperation::ThreadRead),
                    runtime_gate: None,
                    availability_reason: None,
                    canonical_method: Some("thread/read".to_string()),
                    provider_methods: Vec::new(),
                    invocation: ProviderAdapterInvocationKind::DirectProviderMethod,
                    direct_invocation: true,
                    required_runtime_hooks: Vec::new(),
                }],
                ..empty_profile
            };
            assert!(matches!(
                malformed_profile
                    .resolve_request_operation(ProviderAdapterOperation::ThreadRead)
                    .expect_err("missing direct method"),
                ProviderAdapterRequestResolutionError::MissingDirectProviderMethod {
                    provider: ProviderKind::ClaudeCode,
                    operation: ProviderAdapterOperation::ThreadRead
                }
            ));
        }

        #[test]
        fn adapter_contract_lists_required_normalized_surfaces() {
            let contract = ace_provider_adapter_contract();

            assert_eq!(contract.version, 9);
            assert!(contract.websocket_first);
            assert_eq!(contract.raw_payload_policy, "preserve_provider_payloads");
            assert_eq!(
                contract.raw_payload,
                ProviderRawPayloadPolicy {
                    retention: ProviderRawPayloadRetention::PreserveProviderPayloads,
                    preserve_provider_method: true,
                    preserve_provider_ids: true,
                    preserve_schema_version: true,
                    preserve_raw_args: true,
                    preserve_raw_result: true,
                    inspector_only_by_default: true,
                    large_payload_strategy: ProviderLargePayloadStrategy::StoreOnceReferenceDeltas,
                }
            );
            assert!(
                contract
                    .required_capabilities
                    .iter()
                    .any(|capability| capability.key == "provider.normalized_events"
                        && capability.required)
            );
            assert!(
                contract
                    .required_capabilities
                    .iter()
                    .any(|capability| capability.key == "provider.adapter_contract"
                        && capability.required)
            );
            let family = |category| {
                contract
                    .feature_families
                    .iter()
                    .find(|family| family.category == category)
                    .unwrap_or_else(|| panic!("missing provider feature family {category:?}"))
            };
            assert!(family(ProviderFeatureCategory::Threads).required_operations > 0);
            assert!(family(ProviderFeatureCategory::Plans).required_operations > 0);
            assert!(family(ProviderFeatureCategory::Subagents).required_operations > 0);
            assert!(family(ProviderFeatureCategory::Handoff).required_operations > 0);
            assert!(family(ProviderFeatureCategory::Mcp).version_gated_operations > 0);
            assert!(family(ProviderFeatureCategory::Skills).version_gated_operations > 0);
            assert!(family(ProviderFeatureCategory::Plugins).optional_operations > 0);
            assert!(family(ProviderFeatureCategory::Apps).version_gated_operations > 0);
            assert!(family(ProviderFeatureCategory::Tools).required_operations > 0);
            assert_eq!(
                contract
                    .feature_families
                    .iter()
                    .map(|family| family.total_operations)
                    .sum::<usize>(),
                contract.operations.len()
            );
            assert!(
                family(ProviderFeatureCategory::Tools)
                    .operations
                    .contains(&ProviderAdapterOperation::BrowserBridgeContract)
            );
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::PlanForkForImplementation
                    && operation.support == ProviderAdapterOperationSupport::Required
                    && operation
                        .provider_methods
                        .contains(&"thread/fork".to_string())
            }));
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::SideChatStart
                    && operation.support == ProviderAdapterOperationSupport::Required
            }));
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::SubagentSteer
                    && operation.canonical_method.as_deref() == Some("subagent/steer")
            }));
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::HandoffToLocation
                    && operation.category == ProviderFeatureCategory::Handoff
            }));
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::McpToolCall
                    && operation.support == ProviderAdapterOperationSupport::VersionGated
                    && operation.policy.approval_boundary
                    && operation.policy.external_side_effects
            }));
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::FsReadFile
                    && operation.support == ProviderAdapterOperationSupport::Required
                    && operation.canonical_method.as_deref() == Some("fs/readFile")
                    && operation.policy.read_only
            }));
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::FsWatch
                    && operation.support == ProviderAdapterOperationSupport::Required
                    && operation.canonical_method.as_deref() == Some("fs/watch")
                    && operation.policy.mutates_provider_state
            }));
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::ThreadShellCommand
                    && operation.policy.requires_user_initiation
                    && operation.policy.escapes_thread_sandbox
            }));
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::CloudHandoff
                    && operation.support == ProviderAdapterOperationSupport::Deferred
            }));
            for normalization_operation in [
                ProviderAdapterOperation::ToolEventNormalize,
                ProviderAdapterOperation::ServerRequestNormalize,
                ProviderAdapterOperation::ThreadItemNormalize,
                ProviderAdapterOperation::RuntimeSignalNormalize,
            ] {
                let operation = contract
                    .operations
                    .iter()
                    .find(|operation| operation.operation == normalization_operation)
                    .expect("normalization contract operation");
                assert_eq!(operation.support, ProviderAdapterOperationSupport::Required);
                assert!(operation.canonical_method.is_none());
                assert!(operation.provider_methods.is_empty());
                assert!(operation.policy.read_only);
            }
            for bridge_operation in [
                ProviderAdapterOperation::BrowserBridgeContract,
                ProviderAdapterOperation::ComputerBridgeContract,
            ] {
                let operation = contract
                    .operations
                    .iter()
                    .find(|operation| operation.operation == bridge_operation)
                    .expect("bridge contract operation");
                assert_eq!(operation.category, ProviderFeatureCategory::Tools);
                assert_eq!(operation.support, ProviderAdapterOperationSupport::Required);
                assert!(operation.policy.external_side_effects);
                assert!(operation.policy.approval_boundary);
                assert!(operation.canonical_method.is_none());
                assert!(operation.provider_methods.is_empty());
            }
            assert!(
                contract
                    .normalized_thread_item_kinds
                    .contains(&ThreadItemKind::Plan)
            );
            assert!(
                contract
                    .normalized_thread_item_kinds
                    .contains(&ThreadItemKind::SubAgentActivity)
            );
            assert!(
                contract
                    .normalized_server_request_kinds
                    .contains(&ServerRequestKind::McpElicitation)
            );
            assert!(
                contract
                    .provider_event_types
                    .contains(&"server_request_resolved".to_string())
            );
            assert!(
                contract
                    .tool_surfaces
                    .contains(&crate::tools::ToolSurface::Browser)
            );
            for surface in [
                crate::tools::ToolSurface::Plan,
                crate::tools::ToolSurface::Handoff,
                crate::tools::ToolSurface::Review,
            ] {
                assert!(
                    contract.tool_surfaces.contains(&surface),
                    "contract should advertise {surface:?} semantic tool surface"
                );
            }
            assert!(
                contract
                    .tool_action_kinds
                    .contains(&crate::tools::ToolActionKind::BrowserZoom)
            );
            for action in [
                crate::tools::ToolActionKind::PlanContinue,
                crate::tools::ToolActionKind::PlanFork,
                crate::tools::ToolActionKind::PlanSideImplementation,
                crate::tools::ToolActionKind::HandoffAgent,
                crate::tools::ToolActionKind::HandoffLocation,
                crate::tools::ToolActionKind::ReviewStart,
                crate::tools::ToolActionKind::FileSearch,
                crate::tools::ToolActionKind::PluginMarketplaceAdd,
                crate::tools::ToolActionKind::PluginMarketplaceRemove,
                crate::tools::ToolActionKind::PluginMarketplaceUpgrade,
            ] {
                assert!(
                    contract.tool_action_kinds.contains(&action),
                    "contract should advertise {action:?} semantic tool action"
                );
            }
            assert!(
                contract
                    .tool_action_kinds
                    .contains(&crate::tools::ToolActionKind::TerminalOutput)
            );
            assert!(
                contract
                    .tool_transports
                    .contains(&crate::tools::ToolTransport::Mcp)
            );
            assert!(
                contract
                    .execution_locations
                    .contains(&crate::threads::ExecutionLocation::Worktree)
            );
        }

        #[tokio::test]
        async fn registry_reports_provider_status() {
            let driver = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::Codex,
                    capabilities: vec![ProviderCapability {
                        key: "provider.normalized_events".to_string(),
                        version: 1,
                    }],
                },
                requests: Mutex::new(Vec::new()),
            });
            let registry = ProviderRegistry::new().with_driver(driver);

            let status = registry
                .status(ProviderKind::Codex)
                .await
                .expect("provider status");

            assert_eq!(status.health, ProviderRuntimeHealth::Ready);
            assert!(status.initialized);
        }

        #[tokio::test]
        async fn registry_routes_provider_lifecycle_actions() {
            let driver = Arc::new(crate::native_provider::AceNativeProvider::new());
            let registry = ProviderRegistry::new().with_driver(driver);

            let result = registry
                .lifecycle_action(
                    ProviderKind::Ace,
                    ProviderLifecycleAction::Restart,
                    Duration::from_millis(10),
                )
                .await
                .expect("lifecycle");

            assert_eq!(result.action, ProviderLifecycleAction::Restart);
            assert_eq!(result.status.health, ProviderRuntimeHealth::Ready);
            assert_eq!(result.metadata["no_op"], true);
        }

        #[tokio::test]
        async fn registry_rejects_unregistered_provider() {
            let error = ProviderRegistry::new()
                .request(
                    ProviderKind::Cursor,
                    ProviderRequest {
                        method: "thread/read".to_string(),
                        params: json!({}),
                        timeout: Duration::from_secs(1),
                    },
                )
                .await
                .expect_err("unregistered provider");

            assert!(matches!(
                error,
                ProviderRuntimeError::ProviderUnavailable {
                    provider: ProviderKind::Cursor
                }
            ));
        }

        #[tokio::test]
        async fn registry_routes_provider_event_sources_by_kind() {
            let source = Arc::new(FakeProviderEventSource {
                events: Mutex::new(vec![ProviderEvent::StderrLine {
                    line: "ready".to_string(),
                }]),
            });
            let registry =
                ProviderRegistry::new().with_event_source(ProviderKind::Codex, source.clone());

            assert!(registry.has_event_source(ProviderKind::Codex));
            let events = registry
                .next_events(ProviderKind::Codex)
                .await
                .expect("events")
                .expect("event batch");
            assert_eq!(
                events,
                vec![ProviderEvent::StderrLine {
                    line: "ready".to_string()
                }]
            );
            assert!(
                registry
                    .next_events(ProviderKind::Codex)
                    .await
                    .expect("no events")
                    .is_none()
            );
        }

        #[tokio::test]
        async fn registry_rejects_unregistered_provider_event_source() {
            let error = ProviderRegistry::new()
                .next_events(ProviderKind::Cursor)
                .await
                .expect_err("unregistered provider event source");

            assert!(matches!(
                error,
                ProviderRuntimeError::ProviderUnavailable {
                    provider: ProviderKind::Cursor
                }
            ));
        }

        #[tokio::test]
        async fn registry_routes_provider_server_request_responses_by_kind() {
            let responder = Arc::new(FakeServerRequestResponder {
                decisions: Mutex::new(Vec::new()),
            });
            let registry = ProviderRegistry::new()
                .with_server_request_responder(ProviderKind::Codex, responder.clone());

            assert!(registry.has_server_request_responder(ProviderKind::Codex));
            registry
                .respond_server_request_result(
                    ProviderKind::Codex,
                    "42".to_string(),
                    json!({ "approved": true }),
                )
                .await
                .expect("result");
            registry
                .respond_server_request_error(
                    ProviderKind::Codex,
                    "43".to_string(),
                    -32000,
                    "denied".to_string(),
                )
                .await
                .expect("error");

            assert_eq!(
                responder.decisions.lock().expect("decisions").as_slice(),
                [
                    FakeServerRequestDecision::Result {
                        request_id: "42".to_string(),
                        result: json!({ "approved": true }),
                    },
                    FakeServerRequestDecision::Error {
                        request_id: "43".to_string(),
                        code: -32000,
                        message: "denied".to_string(),
                    },
                ]
            );
        }

        #[tokio::test]
        async fn registry_rejects_unregistered_provider_server_request_responder() {
            let error = ProviderRegistry::new()
                .respond_server_request_result(ProviderKind::Cursor, "42".to_string(), json!({}))
                .await
                .expect_err("unregistered provider server request responder");

            assert!(matches!(
                error,
                ProviderRuntimeError::ProviderUnavailable {
                    provider: ProviderKind::Cursor
                }
            ));
        }
    }
}
