use ace_codex::{
    CodexGoalSet, CodexGuardianDeniedActionApproval, CodexHandoffToAgent, CodexMethodDirection,
    CodexMethodSpec, CodexMethodSupport, CodexPermissionPreset, CodexPlanImplementation,
    CodexSubagentSteer, CodexSubagentThreadRequest, CodexThreadStart, CodexTurnStart,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexRawRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CodexVersionedRequest {
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexReviewStartRequest {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCommandExecRequest {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "thread_id")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub env: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCommandProcessRequest {
    #[serde(alias = "process_id")]
    pub process_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCommandWriteStdinRequest {
    #[serde(alias = "process_id")]
    pub process_id: String,
    pub stdin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCommandResizeRequest {
    #[serde(alias = "process_id")]
    pub process_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "thread_id")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessCleanRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "thread_id")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpStatusRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpResourceReadRequest {
    pub server: String,
    pub uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpOauthLoginRequest {
    pub server: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpToolCallRequest {
    pub server: String,
    pub tool: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexNamedQueryRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSkillRequest {
    pub skill: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginRequest {
    pub plugin: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppConfigWriteRequest {
    pub app: String,
    #[serde(default)]
    pub config: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRemoteHandoffRequest {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexThreadStartRequest {
    #[serde(flatten)]
    pub params: CodexThreadStart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexThreadIdRequest {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CodexThreadsListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexThreadForkRequest {
    pub thread_id: String,
    #[serde(default)]
    pub ephemeral: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexThreadSetNameRequest {
    pub thread_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexThreadUpdateMetadataRequest {
    pub thread_id: String,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexThreadRollbackRequest {
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexThreadInjectItemsRequest {
    pub thread_id: String,
    #[serde(default)]
    pub items: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexTurnStartRequest {
    #[serde(flatten)]
    pub params: CodexTurnStart,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexPlanTurnStartRequest {
    pub thread_id: String,
    pub prompt: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexPlanImplementationRequest {
    #[serde(flatten)]
    pub params: CodexPlanImplementation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexPermissionPresetRequest {
    pub preset: CodexPermissionPreset,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexGuardianDeniedActionApprovalRequest {
    #[serde(flatten)]
    pub params: CodexGuardianDeniedActionApproval,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexGoalSetRequest {
    #[serde(flatten)]
    pub params: CodexGoalSet,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexSubagentThreadRpcRequest {
    #[serde(flatten)]
    pub params: CodexSubagentThreadRequest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexSubagentSteerRequest {
    #[serde(flatten)]
    pub params: CodexSubagentSteer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexHandoffToAgentRequest {
    #[serde(flatten)]
    pub params: CodexHandoffToAgent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexHandoffLocation {
    Local,
    Worktree,
    RemoteHost,
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexHandoffToLocationRequest {
    pub thread_id: String,
    pub repo_path: String,
    pub target_location: CodexHandoffLocation,
    pub preferred_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexHandoffToLocationResponse {
    pub source_thread_id: String,
    pub target_location: CodexHandoffLocation,
    pub target_thread_id: Option<String>,
    pub worktree_path: String,
    pub worktree_branch: String,
    pub repo_root: String,
    pub interrupted_active_turn: bool,
    #[serde(default)]
    pub thread_metadata: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexShutdownRequest {
    #[serde(default = "default_shutdown_grace_ms")]
    pub grace_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexStderrTailResponse {
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexCompatibilityMethod {
    pub method: String,
    pub direction: CodexMethodDirection,
    pub support: CodexMethodSupport,
}

impl From<CodexMethodSpec> for CodexCompatibilityMethod {
    fn from(spec: CodexMethodSpec) -> Self {
        Self {
            method: spec.method.to_string(),
            direction: spec.direction,
            support: spec.support,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexCompatibilityInventoryResponse {
    pub methods: Vec<CodexCompatibilityMethod>,
}

fn default_shutdown_grace_ms() -> u64 {
    1_000
}
