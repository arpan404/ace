use ace_checkpoint::{
    CheckpointError, CheckpointStore, DiffCheckpointsInput, checkpoint_ref_for_thread_turn,
};
use ace_git::{ProcessRunner, TokioProcessRunner};
use ace_protocol::checkpoint::{
    CheckpointDiffResponse, CheckpointFullThreadDiffRequest, CheckpointRequestRevertRequest,
    CheckpointRequestRevertResponse, CheckpointTurnDiffRequest,
};
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CheckpointApiError {
    #[error("{0}")]
    Checkpoint(#[from] CheckpointError),
    #[error("checkpoint revert requires runtime provider integration")]
    RevertUnavailable,
}

#[derive(Clone)]
pub struct CheckpointService<R: ProcessRunner = TokioProcessRunner> {
    store: CheckpointStore<R>,
}

impl CheckpointService<TokioProcessRunner> {
    #[must_use]
    pub fn production() -> Self {
        Self {
            store: CheckpointStore::new(),
        }
    }
}

impl<R: ProcessRunner> CheckpointService<R> {
    #[must_use]
    pub fn new(store: CheckpointStore<R>) -> Self {
        Self { store }
    }

    pub async fn turn_diff(
        &self,
        request: CheckpointTurnDiffRequest,
    ) -> Result<CheckpointDiffResponse, CheckpointApiError> {
        let diff = self
            .store
            .diff_checkpoints(DiffCheckpointsInput {
                cwd: PathBuf::from(&request.cwd),
                from_checkpoint_ref: checkpoint_ref_for_thread_turn(
                    &request.thread_id,
                    request.from_turn_count,
                ),
                to_checkpoint_ref: checkpoint_ref_for_thread_turn(
                    &request.thread_id,
                    request.to_turn_count,
                ),
                fallback_from_to_head: false,
            })
            .await?;
        Ok(CheckpointDiffResponse {
            thread_id: request.thread_id,
            from_turn_count: request.from_turn_count,
            to_turn_count: request.to_turn_count,
            diff,
        })
    }

    pub async fn full_thread_diff(
        &self,
        request: CheckpointFullThreadDiffRequest,
    ) -> Result<CheckpointDiffResponse, CheckpointApiError> {
        self.turn_diff(CheckpointTurnDiffRequest {
            cwd: request.cwd,
            thread_id: request.thread_id,
            from_turn_count: 0,
            to_turn_count: request.to_turn_count,
        })
        .await
    }

    pub async fn request_revert(
        &self,
        request: CheckpointRequestRevertRequest,
    ) -> Result<CheckpointRequestRevertResponse, CheckpointApiError> {
        Err(CheckpointApiError::RevertUnavailable).map(|()| CheckpointRequestRevertResponse {
            thread_id: request.thread_id,
            turn_count: request.turn_count,
            requested: true,
        })
    }
}
