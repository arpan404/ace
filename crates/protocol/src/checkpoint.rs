use ace_core::ThreadId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointTurnDiffRequest {
    pub cwd: String,
    pub thread_id: ThreadId,
    pub from_turn_count: u64,
    pub to_turn_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointFullThreadDiffRequest {
    pub cwd: String,
    pub thread_id: ThreadId,
    pub to_turn_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointDiffResponse {
    pub thread_id: ThreadId,
    pub from_turn_count: u64,
    pub to_turn_count: u64,
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointRequestRevertRequest {
    pub thread_id: ThreadId,
    pub turn_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointRequestRevertResponse {
    pub thread_id: ThreadId,
    pub turn_count: u64,
    pub requested: bool,
}
