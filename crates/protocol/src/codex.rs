use ace_codex::{CodexThreadStart, CodexTurnStart};
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexThreadForkRequest {
    pub thread_id: String,
    #[serde(default)]
    pub ephemeral: bool,
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
