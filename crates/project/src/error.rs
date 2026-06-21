use crate::constants::PROJECT_READ_FILE_MAX_BYTES;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("project title cannot be empty")]
    EmptyTitle,
    #[error("workspace root does not exist: {0}")]
    WorkspaceMissing(PathBuf),
    #[error("workspace root is not a directory: {0}")]
    WorkspaceNotDirectory(PathBuf),
    #[error("workspace path must stay within the project root")]
    PathOutsideRoot,
    #[error("entry already exists: {0}")]
    EntryAlreadyExists(String),
    #[error("entry does not exist: {0}")]
    EntryMissing(String),
    #[error("only regular text files are supported")]
    UnsupportedFile,
    #[error("files larger than {PROJECT_READ_FILE_MAX_BYTES} bytes are not opened")]
    FileTooLarge,
    #[error("the file changed on disk after it was opened")]
    VersionConflict {
        current_contents: Option<String>,
        current_version: Option<String>,
        expected_version: String,
    },
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ProjectError>;
