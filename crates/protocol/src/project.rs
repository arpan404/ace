use ace_core::{ModelSelection, Project, ProjectIcon, ProjectId, ProjectScript, ThreadId};
use ace_project::{ProjectEntryKind, UpdateProject};
use ace_runtime::chat::{ChatMessageProjection, ThreadSummary};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectListRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSnapshotRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSnapshotResponse {
    pub projects: Vec<Project>,
    pub threads: Vec<ThreadSummary>,
    pub thread_counts: HashMap<ProjectId, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectThreadsRequest {
    pub project_id: ProjectId,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadMessagesRequest {
    pub thread_id: ThreadId,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadMessagesResponse {
    pub messages: Vec<ChatMessageProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectAddRequest {
    pub workspace_root: String,
    pub title: Option<String>,
    pub default_model_selection: Option<ModelSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectUpdateRequest {
    pub project_id: ProjectId,
    pub title: Option<String>,
    pub workspace_root: Option<String>,
    pub default_model_selection: Option<Option<ModelSelection>>,
    pub scripts: Option<Vec<ProjectScript>>,
    pub icon: Option<Option<ProjectIcon>>,
    pub archived_at: Option<Option<String>>,
}

impl From<ProjectUpdateRequest> for UpdateProject {
    fn from(value: ProjectUpdateRequest) -> Self {
        Self {
            title: value.title,
            workspace_root: value.workspace_root,
            default_model_selection: value.default_model_selection,
            scripts: value.scripts,
            icon: value.icon,
            archived_at: value.archived_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectDeleteRequest {
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectCwdRequest {
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSearchEntriesRequest {
    pub cwd: String,
    pub query: String,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntryPathRequest {
    pub cwd: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectCreateEntryRequest {
    pub cwd: String,
    pub relative_path: String,
    pub kind: ProjectEntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRenameEntryRequest {
    pub cwd: String,
    pub relative_path: String,
    pub next_relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectWriteFileRequest {
    pub cwd: String,
    pub relative_path: String,
    pub contents: String,
    pub expected_version: Option<String>,
    pub overwrite: Option<bool>,
}
