use crate::constants::PROJECT_READ_FILE_MAX_BYTES;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace root does not exist: {0}")]
    WorkspaceMissing(PathBuf),
    #[error("workspace root is not a directory: {0}")]
    WorkspaceNotDirectory(PathBuf),
    #[error("workspace path must stay within the workspace root")]
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
    #[error("buffer is not open: {0}")]
    BufferNotOpen(String),
    #[error("buffer version mismatch for {path}: expected {expected}, got {actual}")]
    BufferVersionMismatch {
        path: String,
        expected: i32,
        actual: i32,
    },
    #[error("invalid text position")]
    InvalidPosition,
    #[error("invalid workspace edit: {0}")]
    InvalidEdit(String),
    #[error("file watch error: {0}")]
    Watch(#[from] notify::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, WorkspaceError>;
