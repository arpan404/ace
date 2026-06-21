mod constants;
mod error;
mod icons;
mod models;
mod path_utils;
mod registry;
mod search;
mod workspace;

pub use error::{ProjectError, Result};
pub use models::{
    AddProject, AddProjectResult, AddProjectStatus, ProjectCreateEntryResult,
    ProjectDeleteEntryResult, ProjectEntriesResult, ProjectEntry, ProjectEntryKind,
    ProjectFaviconResult, ProjectReadFileResult, ProjectRenameEntryResult, ProjectSummary,
    ProjectWriteFileResult, RemoveProjectResult, ResolvedPath, UpdateProject,
};
pub use registry::ProjectRegistry;
pub use workspace::WorkspaceService;
