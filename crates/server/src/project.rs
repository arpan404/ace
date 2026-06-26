use ace_fs::AppDirs;
use ace_project::{
    AddProject, AddProjectResult, ProjectCreateEntryResult, ProjectDeleteEntryResult,
    ProjectEntriesResult, ProjectError, ProjectFaviconResult, ProjectReadFileResult,
    ProjectRegistry, ProjectRenameEntryResult, ProjectSummary, ProjectWriteFileResult,
    RemoveProjectResult, WorkspaceService,
};
use ace_protocol::project::{
    ProjectAddRequest, ProjectCreateEntryRequest, ProjectCwdRequest, ProjectDeleteRequest,
    ProjectEntryPathRequest, ProjectRenameEntryRequest, ProjectSearchEntriesRequest,
    ProjectUpdateRequest, ProjectWriteFileRequest,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProjectApiError {
    #[error("project service unavailable: {0}")]
    Unavailable(String),
    #[error("{0}")]
    Project(#[from] ProjectError),
    #[error("workspace cache lock is poisoned")]
    LockPoisoned,
}

#[derive(Clone)]
pub struct ProjectService {
    registry: Arc<Mutex<ProjectRegistry>>,
    workspace: Arc<Mutex<WorkspaceService>>,
}

impl ProjectService {
    pub fn production() -> Result<Self, ProjectApiError> {
        let paths =
            AppDirs::resolve().map_err(|error| ProjectApiError::Unavailable(error.to_string()))?;
        Self::open(paths.state_dir.join("projects.sqlite3"))
    }

    pub fn open(path: PathBuf) -> Result<Self, ProjectApiError> {
        Ok(Self {
            registry: Arc::new(Mutex::new(ProjectRegistry::open(path)?)),
            workspace: Arc::new(Mutex::new(WorkspaceService::new())),
        })
    }

    pub fn memory() -> Result<Self, ProjectApiError> {
        let connection = rusqlite::Connection::open_in_memory()
            .map_err(|error| ProjectApiError::Project(ProjectError::Sql(error)))?;
        Ok(Self::with_registry(ProjectRegistry::from_connection(
            connection,
        )?))
    }

    pub fn with_registry(registry: ProjectRegistry) -> Self {
        Self {
            registry: Arc::new(Mutex::new(registry)),
            workspace: Arc::new(Mutex::new(WorkspaceService::new())),
        }
    }

    pub async fn list(&self) -> Result<Vec<ProjectSummary>, ProjectApiError> {
        Ok(self.registry()?.list()?)
    }

    pub async fn add(
        &self,
        request: ProjectAddRequest,
    ) -> Result<AddProjectResult, ProjectApiError> {
        Ok(self.registry()?.add(AddProject {
            workspace_root: request.workspace_root,
            title: request.title,
            default_model_selection: request.default_model_selection,
        })?)
    }

    pub async fn update(
        &self,
        request: ProjectUpdateRequest,
    ) -> Result<ProjectSummary, ProjectApiError> {
        Ok(self
            .registry()?
            .update(request.project_id, request.into())?)
    }

    pub async fn delete(
        &self,
        request: ProjectDeleteRequest,
    ) -> Result<RemoveProjectResult, ProjectApiError> {
        Ok(self.registry()?.delete(request.project_id)?)
    }

    pub async fn search_entries(
        &self,
        request: ProjectSearchEntriesRequest,
    ) -> Result<ProjectEntriesResult, ProjectApiError> {
        Ok(self
            .workspace()?
            .search_entries(request.cwd, &request.query, request.limit)?)
    }

    pub async fn list_tree(
        &self,
        request: ProjectCwdRequest,
    ) -> Result<ProjectEntriesResult, ProjectApiError> {
        Ok(self.workspace()?.list_tree(request.cwd)?)
    }

    pub async fn resolve_favicon(
        &self,
        request: ProjectCwdRequest,
    ) -> Result<ProjectFaviconResult, ProjectApiError> {
        Ok(self.workspace()?.resolve_favicon(request.cwd)?)
    }

    pub async fn create_entry(
        &self,
        request: ProjectCreateEntryRequest,
    ) -> Result<ProjectCreateEntryResult, ProjectApiError> {
        Ok(self
            .workspace()?
            .create_entry(request.cwd, &request.relative_path, request.kind)?)
    }

    pub async fn delete_entry(
        &self,
        request: ProjectEntryPathRequest,
    ) -> Result<ProjectDeleteEntryResult, ProjectApiError> {
        Ok(self
            .workspace()?
            .delete_entry(request.cwd, &request.relative_path)?)
    }

    pub async fn read_file(
        &self,
        request: ProjectEntryPathRequest,
    ) -> Result<ProjectReadFileResult, ProjectApiError> {
        Ok(self
            .workspace()?
            .read_file(request.cwd, &request.relative_path)?)
    }

    pub async fn rename_entry(
        &self,
        request: ProjectRenameEntryRequest,
    ) -> Result<ProjectRenameEntryResult, ProjectApiError> {
        Ok(self.workspace()?.rename_entry(
            request.cwd,
            &request.relative_path,
            &request.next_relative_path,
        )?)
    }

    pub async fn write_file(
        &self,
        request: ProjectWriteFileRequest,
    ) -> Result<ProjectWriteFileResult, ProjectApiError> {
        Ok(self.workspace()?.write_file(
            request.cwd,
            &request.relative_path,
            &request.contents,
            request.expected_version.as_deref(),
            request.overwrite.unwrap_or(false),
        )?)
    }

    fn workspace(&self) -> Result<std::sync::MutexGuard<'_, WorkspaceService>, ProjectApiError> {
        self.workspace
            .lock()
            .map_err(|_| ProjectApiError::LockPoisoned)
    }

    fn registry(&self) -> Result<std::sync::MutexGuard<'_, ProjectRegistry>, ProjectApiError> {
        self.registry
            .lock()
            .map_err(|_| ProjectApiError::LockPoisoned)
    }
}
