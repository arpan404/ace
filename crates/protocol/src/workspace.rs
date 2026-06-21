pub use ace_workspace::{WorkspaceEdit, WorkspaceEditResult, WorkspaceFileEvent};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceApplyEditRequest {
    pub workspace_root: PathBuf,
    pub edit: WorkspaceEdit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceFileEventsSubscribeRequest {
    pub workspace_root: PathBuf,
}
