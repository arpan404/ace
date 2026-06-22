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
