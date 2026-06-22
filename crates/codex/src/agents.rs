use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSubagentThreadRequest {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    #[serde(alias = "subagent_thread_id")]
    pub subagent_thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSubagentSteer {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    #[serde(alias = "subagent_thread_id")]
    pub subagent_thread_id: String,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHandoffToAgent {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "agent_role")]
    pub agent_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "reasoning_effort")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "sandbox_policy")]
    pub sandbox_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "approval_policy")]
    pub approval_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "approvals_reviewer")]
    pub approvals_reviewer: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    #[serde(alias = "mcp_config")]
    pub mcp_config: Value,
}
