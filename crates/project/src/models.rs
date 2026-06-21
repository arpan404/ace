use ace_core::{IsoDateTime, ModelSelection, ProjectIcon, ProjectId, ProjectScript};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: ProjectId,
    pub title: String,
    pub workspace_root: String,
    pub default_model_selection: Option<ModelSelection>,
    pub scripts: Vec<ProjectScript>,
    pub icon: Option<ProjectIcon>,
    pub created_at: IsoDateTime,
    pub updated_at: IsoDateTime,
    pub archived_at: Option<IsoDateTime>,
    pub deleted_at: Option<IsoDateTime>,
    pub active_thread_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddProject {
    pub workspace_root: String,
    pub title: Option<String>,
    pub default_model_selection: Option<ModelSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddProjectResult {
    pub status: AddProjectStatus,
    pub project: ProjectSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddProjectStatus {
    Created,
    Existing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct UpdateProject {
    pub title: Option<String>,
    pub workspace_root: Option<String>,
    pub default_model_selection: Option<Option<ModelSelection>>,
    pub scripts: Option<Vec<ProjectScript>>,
    pub icon: Option<Option<ProjectIcon>>,
    pub archived_at: Option<Option<IsoDateTime>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveProjectResult {
    pub project: ProjectSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub path: String,
    pub kind: ProjectEntryKind,
    pub parent_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntriesResult {
    pub entries: Vec<ProjectEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectReadFileResult {
    pub relative_path: String,
    pub contents: String,
    pub size_bytes: u64,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectWriteFileResult {
    pub relative_path: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectCreateEntryResult {
    pub kind: ProjectEntryKind,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRenameEntryResult {
    pub previous_relative_path: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectDeleteEntryResult {
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectFaviconResult {
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPath {
    pub(crate) absolute_path: PathBuf,
    pub(crate) relative_path: String,
}

impl ResolvedPath {
    #[must_use]
    pub fn absolute_path(&self) -> &Path {
        &self.absolute_path
    }

    #[must_use]
    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }
}

#[derive(Debug, Clone)]
pub(crate) struct WorkspaceIndex {
    pub(crate) entries: Vec<ProjectEntry>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ReadCacheEntry {
    pub(crate) fingerprint: String,
    pub(crate) result: ProjectReadFileResult,
}
