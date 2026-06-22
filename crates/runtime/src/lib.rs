use ace_core::{Command, CommandId};
use thiserror::Error;
use tokio::sync::mpsc;

pub mod native_provider;
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
        threads::ExecutionLocation,
        tools::{SemanticToolCall, ToolSurface, ToolTransport},
    };
    use ace_core::{ProviderCapability, ProviderKind};
    use async_trait::async_trait;
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use std::{collections::HashMap, sync::Arc, time::Duration};

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
        pub required_capabilities: Vec<ProviderContractRequirement>,
        pub operations: Vec<ProviderAdapterOperationSpec>,
        pub normalized_thread_item_kinds: Vec<ThreadItemKind>,
        pub normalized_server_request_kinds: Vec<ServerRequestKind>,
        pub runtime_signal_kinds: Vec<RuntimeSignalKind>,
        pub provider_event_types: Vec<String>,
        pub tool_transports: Vec<ToolTransport>,
        pub tool_surfaces: Vec<ToolSurface>,
        pub execution_locations: Vec<ExecutionLocation>,
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
        CommandExec,
        CommandWriteStdin,
        CommandResize,
        CommandTerminate,
        ProcessList,
        ProcessClean,
        McpStatus,
        McpResourceRead,
        McpOauthLogin,
        McpToolCall,
        SkillsList,
        SkillsRead,
        SkillsInstall,
        PluginsList,
        PluginsInstall,
        AppsList,
        AppsConfigWrite,
        RemoteConnectionList,
        RemoteHandoff,
        CloudThreadStart,
        CloudHandoff,
        ProviderEvents,
        SemanticTools,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderAdapterOperationSpec {
        pub operation: ProviderAdapterOperation,
        pub category: ProviderFeatureCategory,
        pub support: ProviderAdapterOperationSupport,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub canonical_method: Option<String>,
        #[serde(default)]
        pub provider_methods: Vec<String>,
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

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
        pub metadata: Value,
        pub provider: ProviderMetadata,
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
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct NormalizedRuntimeSignal {
        pub kind: RuntimeSignalKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub turn_id: Option<String>,
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
        Exited,
    }

    #[async_trait]
    pub trait ProviderDriver: Send + Sync + 'static {
        fn descriptor(&self) -> ProviderDescriptor;

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

    pub type DynProviderDriver = Arc<dyn ProviderDriver>;
    pub type DynProviderEventSource = Arc<dyn ProviderEventSource>;
    pub type DynProviderServerRequestResponder = Arc<dyn ProviderServerRequestResponder>;

    #[derive(Default, Clone)]
    pub struct ProviderRegistry {
        drivers: HashMap<ProviderKind, DynProviderDriver>,
        event_sources: HashMap<ProviderKind, DynProviderEventSource>,
        server_request_responders: HashMap<ProviderKind, DynProviderServerRequestResponder>,
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
                Some("thread/loadedList"),
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
                Some("thread/setName"),
            ),
            op(
                Operation::ThreadUpdateMetadata,
                Category::Threads,
                Required,
                Some("thread/updateMetadata"),
            ),
            op(
                Operation::ThreadCompact,
                Category::Threads,
                Required,
                Some("thread/compact"),
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
                Some("thread/injectItems"),
            ),
            op(
                Operation::TurnStart,
                Category::Turns,
                Required,
                Some("turn/start"),
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
                Some("thread/injectItems+turn/start"),
            ),
            op(
                Operation::PlanForkForImplementation,
                Category::Plans,
                Required,
                Some("thread/fork+thread/injectItems+turn/start"),
            ),
            op(
                Operation::PlanSideImplementation,
                Category::Plans,
                Required,
                Some("thread/fork+thread/injectItems+turn/start"),
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
                Some("goal/set"),
            ),
            op(
                Operation::GoalGet,
                Category::Goals,
                Required,
                Some("goal/get"),
            ),
            op(
                Operation::GoalClear,
                Category::Goals,
                Required,
                Some("goal/clear"),
            ),
            op(
                Operation::GoalPause,
                Category::Goals,
                Required,
                Some("goal/pause"),
            ),
            op(
                Operation::GoalResume,
                Category::Goals,
                Required,
                Some("goal/resume"),
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
                Operation::CommandExec,
                Category::Tools,
                VersionGated,
                Some("command/exec"),
            ),
            op(
                Operation::CommandWriteStdin,
                Category::Tools,
                VersionGated,
                Some("command/writeStdin"),
            ),
            op(
                Operation::CommandResize,
                Category::Tools,
                VersionGated,
                Some("command/resize"),
            ),
            op(
                Operation::CommandTerminate,
                Category::Tools,
                VersionGated,
                Some("command/terminate"),
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
                Operation::McpStatus,
                Category::Mcp,
                VersionGated,
                Some("mcp/status"),
            ),
            op(
                Operation::McpResourceRead,
                Category::Mcp,
                VersionGated,
                Some("mcp/resourceRead"),
            ),
            op(
                Operation::McpOauthLogin,
                Category::Mcp,
                VersionGated,
                Some("mcp/oauthLogin"),
            ),
            op(
                Operation::McpToolCall,
                Category::Mcp,
                VersionGated,
                Some("mcp/toolCall"),
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
                Some("skills/read"),
            ),
            op(
                Operation::SkillsInstall,
                Category::Skills,
                VersionGated,
                Some("skills/install"),
            ),
            op(
                Operation::PluginsList,
                Category::Plugins,
                VersionGated,
                Some("plugins/list"),
            ),
            op(
                Operation::PluginsInstall,
                Category::Plugins,
                VersionGated,
                Some("plugins/install"),
            ),
            op(
                Operation::AppsList,
                Category::Apps,
                VersionGated,
                Some("apps/list"),
            ),
            op(
                Operation::AppsConfigWrite,
                Category::Apps,
                VersionGated,
                Some("apps/configWrite"),
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
            canonical_method: canonical_method.map(ToString::to_string),
            provider_methods: canonical_method
                .map(|method| method.split('+').map(ToString::to_string).collect())
                .unwrap_or_default(),
        }
    }

    #[must_use]
    pub fn ace_provider_adapter_contract() -> ProviderAdapterContract {
        ProviderAdapterContract {
            version: 1,
            websocket_first: true,
            raw_payload_policy: "preserve_provider_payloads".to_string(),
            required_capabilities: ace_provider_contract_requirements(),
            operations: ace_provider_adapter_operations(),
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
                ToolSurface::App,
                ToolSurface::GenericMcp,
                ToolSurface::Unknown,
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
        fn adapter_contract_lists_required_normalized_surfaces() {
            let contract = ace_provider_adapter_contract();

            assert_eq!(contract.version, 1);
            assert!(contract.websocket_first);
            assert_eq!(contract.raw_payload_policy, "preserve_provider_payloads");
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
            }));
            assert!(contract.operations.iter().any(|operation| {
                operation.operation == ProviderAdapterOperation::CloudHandoff
                    && operation.support == ProviderAdapterOperationSupport::Deferred
            }));
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
