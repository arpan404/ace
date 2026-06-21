use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GithubApiError {
    #[error("repo_path must not be empty")]
    EmptyRepoPath,
    #[error("{0}")]
    Tooling(#[from] ace_git::GitToolError),
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    message: String,
}

impl IntoResponse for GithubApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self {
            Self::EmptyRepoPath => StatusCode::BAD_REQUEST,
            Self::Tooling(ace_git::GitToolError::GithubUnauthenticated) => StatusCode::UNAUTHORIZED,
            Self::Tooling(ace_git::GitToolError::NotGithubRepository) => StatusCode::BAD_REQUEST,
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
