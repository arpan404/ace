use ace_core::{CheckpointSummary, Project, ProjectId, ReadModel, Thread, ThreadId};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub fn open_event_store(path: impl AsRef<std::path::Path>) -> Result<Connection, PersistenceError> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&connection)?;
    Ok(connection)
}

pub fn migrate(connection: &Connection) -> Result<(), PersistenceError> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projection_projects (
            project_id TEXT PRIMARY KEY,
            project_json TEXT NOT NULL,
            workspace_root TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_projects_workspace_active
        ON projection_projects(workspace_root)
        WHERE deleted_at IS NULL;

        CREATE TABLE IF NOT EXISTS projection_threads (
            thread_id TEXT PRIMARY KEY,
            thread_json TEXT NOT NULL,
            project_id TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_projection_threads_project
        ON projection_threads(project_id);

        CREATE TABLE IF NOT EXISTS projection_checkpoints (
            thread_id TEXT NOT NULL,
            checkpoint_turn_count INTEGER NOT NULL,
            checkpoint_json TEXT NOT NULL,
            PRIMARY KEY(thread_id, checkpoint_turn_count)
        );
        CREATE INDEX IF NOT EXISTS idx_projection_checkpoints_thread
        ON projection_checkpoints(thread_id, checkpoint_turn_count);
        ",
    )?;
    Ok(())
}

#[derive(Debug)]
pub struct ProjectionRepository {
    connection: Connection,
}

impl ProjectionRepository {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, PersistenceError> {
        Ok(Self {
            connection: open_event_store(path)?,
        })
    }

    pub fn from_connection(connection: Connection) -> Result<Self, PersistenceError> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&connection)?;
        Ok(Self { connection })
    }

    pub fn upsert_project(&self, project: &Project) -> Result<(), PersistenceError> {
        self.connection.execute(
            "INSERT INTO projection_projects(project_id, project_json, workspace_root, deleted_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id) DO UPDATE SET
               project_json = excluded.project_json,
               workspace_root = excluded.workspace_root,
               deleted_at = excluded.deleted_at",
            params![
                json(&project.id)?,
                json(project)?,
                project.workspace_root,
                project.deleted_at
            ],
        )?;
        Ok(())
    }

    pub fn get_project(&self, project_id: ProjectId) -> Result<Option<Project>, PersistenceError> {
        self.connection
            .query_row(
                "SELECT project_json FROM projection_projects WHERE project_id = ?1",
                [json(&project_id)?],
                |row| decode_json::<Project>(row.get::<_, String>(0)?),
            )
            .optional()
            .map_err(PersistenceError::from)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, PersistenceError> {
        let mut statement = self
            .connection
            .prepare("SELECT project_json FROM projection_projects ORDER BY project_id ASC")?;
        let rows =
            statement.query_map([], |row| decode_json::<Project>(row.get::<_, String>(0)?))?;
        rows.map(|row| row.map_err(PersistenceError::from))
            .collect()
    }

    pub fn upsert_thread(&self, thread: &Thread) -> Result<(), PersistenceError> {
        self.connection.execute(
            "INSERT INTO projection_threads(thread_id, thread_json, project_id, deleted_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(thread_id) DO UPDATE SET
               thread_json = excluded.thread_json,
               project_id = excluded.project_id,
               deleted_at = excluded.deleted_at",
            params![
                json(&thread.id)?,
                json(thread)?,
                json(&thread.project_id)?,
                thread.deleted_at
            ],
        )?;
        Ok(())
    }

    pub fn upsert_checkpoint(
        &self,
        checkpoint: &CheckpointSummary,
    ) -> Result<(), PersistenceError> {
        self.connection.execute(
            "INSERT INTO projection_checkpoints(thread_id, checkpoint_turn_count, checkpoint_json)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(thread_id, checkpoint_turn_count) DO UPDATE SET
               checkpoint_json = excluded.checkpoint_json",
            params![
                json(&checkpoint.thread_id)?,
                checkpoint.checkpoint_turn_count,
                json(checkpoint)?
            ],
        )?;
        Ok(())
    }

    pub fn delete_checkpoints_after(
        &self,
        thread_id: &ThreadId,
        turn_count: u64,
    ) -> Result<(), PersistenceError> {
        self.connection.execute(
            "DELETE FROM projection_checkpoints
             WHERE thread_id = ?1 AND checkpoint_turn_count > ?2",
            params![json(thread_id)?, turn_count],
        )?;
        Ok(())
    }

    pub fn read_model(&self) -> Result<ReadModel, PersistenceError> {
        let projects = self.list_projects()?;
        let mut thread_statement = self
            .connection
            .prepare("SELECT thread_json FROM projection_threads ORDER BY thread_id ASC")?;
        let threads = thread_statement
            .query_map([], |row| decode_json::<Thread>(row.get::<_, String>(0)?))?
            .map(|row| row.map_err(PersistenceError::from))
            .collect::<Result<Vec<_>, _>>()?;
        let mut checkpoint_statement = self.connection.prepare(
            "SELECT checkpoint_json FROM projection_checkpoints
             ORDER BY thread_id ASC, checkpoint_turn_count ASC",
        )?;
        let checkpoints = checkpoint_statement
            .query_map([], |row| {
                decode_json::<CheckpointSummary>(row.get::<_, String>(0)?)
            })?
            .map(|row| row.map_err(PersistenceError::from))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ReadModel {
            projects,
            threads,
            checkpoints,
        })
    }
}

fn json<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    serde_json::to_string(value)
}

fn decode_json<T: serde::de::DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_str(&value)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_core::{
        CheckpointDiffSource, CheckpointFile, CheckpointRef, CheckpointStatus, ProjectId, TurnId,
    };

    #[test]
    fn persists_projection_read_model() {
        let repo = ProjectionRepository::from_connection(Connection::open_in_memory().expect("db"))
            .expect("repo");
        let project_id = ProjectId::new();
        let thread_id = ThreadId("thread".to_string());
        repo.upsert_project(&Project {
            id: project_id,
            title: "Project".to_string(),
            workspace_root: "/tmp/project".to_string(),
            default_model_selection: None,
            scripts: Vec::new(),
            icon: None,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
            archived_at: None,
            deleted_at: None,
        })
        .expect("project");
        repo.upsert_thread(&Thread {
            id: thread_id.clone(),
            project_id,
            worktree_path: None,
            active_turn_id: None,
            deleted_at: None,
        })
        .expect("thread");
        repo.upsert_checkpoint(&CheckpointSummary {
            thread_id: thread_id.clone(),
            turn_id: TurnId("turn".to_string()),
            checkpoint_turn_count: 1,
            checkpoint_ref: CheckpointRef("refs/ace/checkpoints/t/turn/1".to_string()),
            status: CheckpointStatus::Ready,
            source: CheckpointDiffSource::GitCheckpoint,
            files: vec![CheckpointFile {
                path: "README.md".to_string(),
                additions: 1,
                deletions: 0,
            }],
            assistant_message_id: None,
            completed_at: "now".to_string(),
        })
        .expect("checkpoint");
        let model = repo.read_model().expect("read model");
        assert_eq!(model.projects.len(), 1);
        assert_eq!(model.threads.len(), 1);
        assert_eq!(model.checkpoints.len(), 1);
        repo.delete_checkpoints_after(&thread_id, 0)
            .expect("delete");
        assert!(
            repo.read_model()
                .expect("read model")
                .checkpoints
                .is_empty()
        );
    }
}
