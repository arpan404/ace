use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexGoalSet {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub objective: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "token_budget")]
    pub token_budget: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexGoalThread {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
}
