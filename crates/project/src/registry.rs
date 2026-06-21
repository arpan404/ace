use crate::{
    AddProject, AddProjectResult, AddProjectStatus, ProjectError, ProjectSummary,
    RemoveProjectResult, Result, UpdateProject, WorkspaceService, path_utils::now_iso,
};
use ace_core::{Project, ProjectId};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::path::Path;

#[derive(Debug)]
pub struct ProjectRegistry {
    connection: Connection,
}

impl ProjectRegistry {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn from_connection(connection: Connection) -> Result<Self> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS projects (
                project_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                workspace_root TEXT NOT NULL,
                default_model_selection_json TEXT,
                scripts_json TEXT NOT NULL,
                icon_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived_at TEXT,
                deleted_at TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_active
            ON projects(workspace_root)
            WHERE deleted_at IS NULL;
            ",
        )?;
        Ok(Self { connection })
    }

    pub fn list(&self) -> Result<Vec<ProjectSummary>> {
        let mut statement = self.connection.prepare(
            "SELECT project_id, title, workspace_root, default_model_selection_json, scripts_json,
                    icon_json, created_at, updated_at, archived_at, deleted_at
             FROM projects
             ORDER BY created_at ASC, project_id ASC",
        )?;
        let rows = statement.query_map([], decode_project_row)?;
        rows.map(|row| {
            row.map(|project| summarize(project, 0))
                .map_err(ProjectError::from)
        })
        .collect()
    }

    pub fn add(&self, input: AddProject) -> Result<AddProjectResult> {
        let workspace_root =
            WorkspaceService::normalize_workspace_root(input.workspace_root, false)?
                .to_string_lossy()
                .to_string();
        if let Some(existing) = self.find_active_by_workspace_root(&workspace_root)? {
            return Ok(AddProjectResult {
                status: AddProjectStatus::Existing,
                project: summarize(existing, 0),
            });
        }
        let title = match input.title {
            Some(title) if !title.trim().is_empty() => title.trim().to_string(),
            Some(_) => return Err(ProjectError::EmptyTitle),
            None => Path::new(&workspace_root)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Project")
                .to_string(),
        };
        let now = now_iso();
        let project = Project {
            id: ProjectId::new(),
            title,
            workspace_root,
            default_model_selection: input.default_model_selection,
            scripts: Vec::new(),
            icon: None,
            created_at: now.clone(),
            updated_at: now,
            archived_at: None,
            deleted_at: None,
        };
        self.upsert_project(&project)?;
        Ok(AddProjectResult {
            status: AddProjectStatus::Created,
            project: summarize(project, 0),
        })
    }

    pub fn update(&self, project_id: ProjectId, patch: UpdateProject) -> Result<ProjectSummary> {
        let mut project = self
            .get_project(project_id)?
            .ok_or_else(|| ProjectError::EntryMissing("project".to_string()))?;
        if let Some(title) = patch.title {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                return Err(ProjectError::EmptyTitle);
            }
            project.title = trimmed.to_string();
        }
        if let Some(workspace_root) = patch.workspace_root {
            project.workspace_root =
                WorkspaceService::normalize_workspace_root(workspace_root, false)?
                    .to_string_lossy()
                    .to_string();
        }
        if let Some(default_model_selection) = patch.default_model_selection {
            project.default_model_selection = default_model_selection;
        }
        if let Some(scripts) = patch.scripts {
            project.scripts = scripts;
        }
        if let Some(icon) = patch.icon {
            project.icon = icon;
        }
        if let Some(archived_at) = patch.archived_at {
            project.archived_at = archived_at;
        }
        project.updated_at = now_iso();
        self.upsert_project(&project)?;
        Ok(summarize(project, 0))
    }

    pub fn delete(&self, project_id: ProjectId) -> Result<RemoveProjectResult> {
        let mut project = self
            .get_project(project_id)?
            .ok_or_else(|| ProjectError::EntryMissing("project".to_string()))?;
        project.deleted_at = Some(now_iso());
        project.updated_at = project.deleted_at.clone().unwrap_or_else(now_iso);
        self.upsert_project(&project)?;
        Ok(RemoveProjectResult {
            project: summarize(project, 0),
        })
    }

    fn find_active_by_workspace_root(&self, workspace_root: &str) -> Result<Option<Project>> {
        self.connection
            .query_row(
                "SELECT project_id, title, workspace_root, default_model_selection_json, scripts_json,
                        icon_json, created_at, updated_at, archived_at, deleted_at
                 FROM projects
                 WHERE workspace_root = ?1 AND deleted_at IS NULL",
                [workspace_root],
                decode_project_row,
            )
            .optional()
            .map_err(ProjectError::from)
    }

    fn get_project(&self, project_id: ProjectId) -> Result<Option<Project>> {
        self.connection
            .query_row(
                "SELECT project_id, title, workspace_root, default_model_selection_json, scripts_json,
                        icon_json, created_at, updated_at, archived_at, deleted_at
                 FROM projects
                 WHERE project_id = ?1",
                [serde_json::to_string(&project_id)?],
                decode_project_row,
            )
            .optional()
            .map_err(ProjectError::from)
    }

    fn upsert_project(&self, project: &Project) -> Result<()> {
        self.connection.execute(
            "INSERT INTO projects (
                project_id, title, workspace_root, default_model_selection_json, scripts_json,
                icon_json, created_at, updated_at, archived_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(project_id) DO UPDATE SET
                title = excluded.title,
                workspace_root = excluded.workspace_root,
                default_model_selection_json = excluded.default_model_selection_json,
                scripts_json = excluded.scripts_json,
                icon_json = excluded.icon_json,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                archived_at = excluded.archived_at,
                deleted_at = excluded.deleted_at",
            params![
                serde_json::to_string(&project.id)?,
                project.title,
                project.workspace_root,
                optional_json(&project.default_model_selection)?,
                serde_json::to_string(&project.scripts)?,
                optional_json(&project.icon)?,
                project.created_at,
                project.updated_at,
                project.archived_at,
                project.deleted_at
            ],
        )?;
        Ok(())
    }
}

fn decode_project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    let id_json: String = row.get(0)?;
    let model_json: Option<String> = row.get(3)?;
    let scripts_json: String = row.get(4)?;
    let icon_json: Option<String> = row.get(5)?;
    Ok(Project {
        id: serde_json::from_str(&id_json).map_err(json_to_sql)?,
        title: row.get(1)?,
        workspace_root: row.get(2)?,
        default_model_selection: model_json
            .map(|value| serde_json::from_str(&value).map_err(json_to_sql))
            .transpose()?,
        scripts: serde_json::from_str(&scripts_json).map_err(json_to_sql)?,
        icon: icon_json
            .map(|value| serde_json::from_str(&value).map_err(json_to_sql))
            .transpose()?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        archived_at: row.get(8)?,
        deleted_at: row.get(9)?,
    })
}

fn json_to_sql(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

fn optional_json<T: Serialize>(value: &Option<T>) -> Result<Option<String>> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(ProjectError::from)
}

fn summarize(project: Project, active_thread_count: u64) -> ProjectSummary {
    ProjectSummary {
        id: project.id,
        title: project.title,
        workspace_root: project.workspace_root,
        default_model_selection: project.default_model_selection,
        scripts: project.scripts,
        icon: project.icon,
        created_at: project.created_at,
        updated_at: project.updated_at,
        archived_at: project.archived_at,
        deleted_at: project.deleted_at,
        active_thread_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_adds_projects_idempotently() {
        let temp = tempfile::tempdir().expect("tempdir");
        let registry = ProjectRegistry::from_connection(Connection::open_in_memory().expect("db"))
            .expect("registry");
        let first = registry
            .add(AddProject {
                workspace_root: temp.path().to_string_lossy().to_string(),
                title: None,
                default_model_selection: None,
            })
            .expect("add");
        let second = registry
            .add(AddProject {
                workspace_root: temp.path().to_string_lossy().to_string(),
                title: None,
                default_model_selection: None,
            })
            .expect("add existing");
        assert_eq!(first.project.id, second.project.id);
        assert_eq!(registry.list().expect("list").len(), 1);
    }
}
