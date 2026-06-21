use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitApiError {
    #[error("repo_path must not be empty")]
    EmptyRepoPath,
    #[error("git workflow requires github client support")]
    WorkflowUnavailable,
    #[error("git worktree management requires an app worktree root")]
    WorktreeUnavailable,
    #[error("{0}")]
    Tooling(#[from] ace_git::GitToolError),
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    message: String,
}

impl IntoResponse for GitApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self {
            Self::EmptyRepoPath
            | Self::WorkflowUnavailable
            | Self::WorktreeUnavailable
            | Self::Tooling(ace_git::GitToolError::UnsafeBranchName(_))
            | Self::Tooling(ace_git::GitToolError::UnsafeWorktreePath { .. })
            | Self::Tooling(ace_git::GitToolError::EmptyCommitMessage)
            | Self::Tooling(ace_git::GitToolError::EmptyPathspec)
            | Self::Tooling(ace_git::GitToolError::DefaultBranchDenied(_)) => {
                StatusCode::BAD_REQUEST
            }
            Self::Tooling(ace_git::GitToolError::MissingBinary(_)) => StatusCode::FAILED_DEPENDENCY,
            Self::Tooling(_) => StatusCode::BAD_GATEWAY,
        };
        (
            status,
            Json(ErrorResponse {
                message: self.to_string(),
            }),
        )
            .into_response()
    }
}
