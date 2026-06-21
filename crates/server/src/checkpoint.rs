use ace_checkpoint::{
    CheckpointError, CheckpointStore, DeleteCheckpointRefsInput, DiffCheckpointsInput,
    RestoreCheckpointInput, checkpoint_ref_for_thread_turn,
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
    #[error("cwd must not be empty")]
    EmptyCwd,
    #[error("{0}")]
    Checkpoint(#[from] CheckpointError),
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
        if request.cwd.trim().is_empty() {
            return Err(CheckpointApiError::EmptyCwd);
        }

        let cwd = PathBuf::from(&request.cwd);
        let target_ref = checkpoint_ref_for_thread_turn(&request.thread_id, request.turn_count);
        let restored = self
            .store
            .restore_checkpoint(RestoreCheckpointInput {
                cwd: cwd.clone(),
                checkpoint_ref: target_ref,
                fallback_to_head: request.turn_count == 0,
            })
            .await?;

        let mut deleted_stale_refs = 0;
        if restored
            && let Some(current_turn_count) = request.current_turn_count
            && current_turn_count > request.turn_count
        {
            let checkpoint_refs = ((request.turn_count + 1)..=current_turn_count)
                .map(|turn_count| checkpoint_ref_for_thread_turn(&request.thread_id, turn_count))
                .collect::<Vec<_>>();
            deleted_stale_refs = checkpoint_refs.len() as u64;
            self.store
                .delete_checkpoint_refs(DeleteCheckpointRefsInput {
                    cwd,
                    checkpoint_refs,
                })
                .await?;
        }

        Ok(CheckpointRequestRevertResponse {
            thread_id: request.thread_id,
            turn_count: request.turn_count,
            restored,
            deleted_stale_refs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_checkpoint::{CaptureCheckpointInput, checkpoint_ref_for_thread_turn};
    use ace_core::ThreadId;
    use std::{path::Path, process::Command};

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    }

    fn init_repo() -> tempfile::TempDir {
        let temp = tempfile::tempdir().expect("tempdir");
        git(temp.path(), &["init"]);
        git(temp.path(), &["config", "user.email", "test@example.com"]);
        git(temp.path(), &["config", "user.name", "Test"]);
        std::fs::write(temp.path().join("README.md"), "initial\n").expect("write");
        git(temp.path(), &["add", "."]);
        git(temp.path(), &["commit", "-m", "initial"]);
        temp
    }

    #[tokio::test]
    async fn request_revert_restores_checkpoint_and_deletes_stale_refs() {
        let repo = init_repo();
        let service = CheckpointService::production();
        let store = CheckpointStore::new();
        let thread_id = ThreadId("thread-revert".to_string());

        store
            .capture_checkpoint(CaptureCheckpointInput {
                cwd: repo.path().to_path_buf(),
                checkpoint_ref: checkpoint_ref_for_thread_turn(&thread_id, 0),
            })
            .await
            .expect("baseline");
        std::fs::write(repo.path().join("README.md"), "turn 1\n").expect("write");
        store
            .capture_checkpoint(CaptureCheckpointInput {
                cwd: repo.path().to_path_buf(),
                checkpoint_ref: checkpoint_ref_for_thread_turn(&thread_id, 1),
            })
            .await
            .expect("turn 1");
        std::fs::write(repo.path().join("README.md"), "turn 2\n").expect("write");
        store
            .capture_checkpoint(CaptureCheckpointInput {
                cwd: repo.path().to_path_buf(),
                checkpoint_ref: checkpoint_ref_for_thread_turn(&thread_id, 2),
            })
            .await
            .expect("turn 2");

        let response = service
            .request_revert(CheckpointRequestRevertRequest {
                cwd: repo.path().to_string_lossy().to_string(),
                thread_id: thread_id.clone(),
                turn_count: 1,
                current_turn_count: Some(2),
            })
            .await
            .expect("revert");

        assert!(response.restored);
        assert_eq!(response.deleted_stale_refs, 1);
        assert_eq!(
            std::fs::read_to_string(repo.path().join("README.md")).expect("read"),
            "turn 1\n"
        );
        assert!(
            !store
                .has_checkpoint_ref(repo.path(), &checkpoint_ref_for_thread_turn(&thread_id, 2))
                .await
                .expect("has ref")
        );
    }
}
