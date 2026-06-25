use crate::{
    PersistenceError,
    json::{decode_json, json},
    migration::{migrate, open_event_store},
};
use ace_core::{CheckpointSummary, Project, ProjectId, ReadModel, Thread, ThreadId};
use ace_runtime::chat::{ComposerDraft, SidebarMetadata, ThreadDraft};
use rusqlite::{Connection, OptionalExtension, params};

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

    pub fn upsert_composer_draft(&self, draft: &ComposerDraft) -> Result<(), PersistenceError> {
        self.connection.execute(
            "INSERT INTO composer_drafts(thread_id, draft_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(thread_id) DO UPDATE SET
               draft_json = excluded.draft_json,
               updated_at = excluded.updated_at",
            params![json(&draft.thread_id)?, json(draft)?, draft.updated_at],
        )?;
        Ok(())
    }

    pub fn get_composer_draft(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<ComposerDraft>, PersistenceError> {
        self.connection
            .query_row(
                "SELECT draft_json FROM composer_drafts WHERE thread_id = ?1",
                [json(thread_id)?],
                |row| decode_json::<ComposerDraft>(row.get::<_, String>(0)?),
            )
            .optional()
            .map_err(PersistenceError::from)
    }

    pub fn list_composer_drafts(&self) -> Result<Vec<ComposerDraft>, PersistenceError> {
        let mut statement = self
            .connection
            .prepare("SELECT draft_json FROM composer_drafts ORDER BY updated_at DESC")?;
        let rows = statement.query_map([], |row| {
            decode_json::<ComposerDraft>(row.get::<_, String>(0)?)
        })?;
        rows.map(|row| row.map_err(PersistenceError::from))
            .collect()
    }

    pub fn upsert_thread_draft(&self, draft: &ThreadDraft) -> Result<(), PersistenceError> {
        self.connection.execute(
            "INSERT INTO thread_drafts(thread_id, project_id, draft_json, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(thread_id) DO UPDATE SET
               project_id = excluded.project_id,
               draft_json = excluded.draft_json,
               created_at = excluded.created_at",
            params![
                json(&draft.thread_id)?,
                json(&draft.project_id)?,
                json(draft)?,
                draft.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_project_thread_draft(
        &self,
        project_id: ProjectId,
    ) -> Result<Option<ThreadDraft>, PersistenceError> {
        self.connection
            .query_row(
                "SELECT draft_json FROM thread_drafts WHERE project_id = ?1",
                [json(&project_id)?],
                |row| decode_json::<ThreadDraft>(row.get::<_, String>(0)?),
            )
            .optional()
            .map_err(PersistenceError::from)
    }

    pub fn upsert_sidebar_metadata(
        &self,
        metadata: &SidebarMetadata,
    ) -> Result<(), PersistenceError> {
        self.connection.execute(
            "INSERT INTO sidebar_metadata(id, metadata_json)
             VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET metadata_json = excluded.metadata_json",
            [json(metadata)?],
        )?;
        Ok(())
    }

    pub fn get_sidebar_metadata(&self) -> Result<SidebarMetadata, PersistenceError> {
        self.connection
            .query_row(
                "SELECT metadata_json FROM sidebar_metadata WHERE id = 1",
                [],
                |row| decode_json::<SidebarMetadata>(row.get::<_, String>(0)?),
            )
            .optional()
            .map(|metadata| metadata.unwrap_or_default())
            .map_err(PersistenceError::from)
    }
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

    #[test]
    fn persists_chat_drafts_and_sidebar_metadata() {
        let repo = ProjectionRepository::from_connection(Connection::open_in_memory().expect("db"))
            .expect("repo");
        let project_id = ProjectId::new();
        let thread_id = ThreadId::new();
        let composer = ComposerDraft::empty(thread_id.clone(), "2026-01-01T00:00:00Z");
        repo.upsert_composer_draft(&composer).expect("composer");
        assert_eq!(
            repo.get_composer_draft(&thread_id)
                .expect("load composer")
                .as_ref()
                .map(|draft| &draft.thread_id),
            Some(&thread_id)
        );

        let thread_draft = ThreadDraft {
            thread_id: thread_id.clone(),
            project_id,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            runtime_mode: ace_runtime::chat::RuntimeMode::Normal,
            interaction_mode: ace_runtime::chat::InteractionMode::Chat,
            branch: None,
            worktree_path: None,
            env_mode: ace_runtime::threads::ExecutionLocation::Local,
        };
        repo.upsert_thread_draft(&thread_draft)
            .expect("thread draft");
        assert_eq!(
            repo.get_project_thread_draft(project_id)
                .expect("load thread draft")
                .as_ref()
                .map(|draft| &draft.thread_id),
            Some(&thread_id)
        );

        let mut metadata = SidebarMetadata {
            active_thread_id: Some(thread_id.clone()),
            ..SidebarMetadata::default()
        };
        metadata.pinned_thread_ids.insert(thread_id.clone());
        repo.upsert_sidebar_metadata(&metadata)
            .expect("sidebar metadata");
        let loaded = repo.get_sidebar_metadata().expect("load metadata");
        assert_eq!(loaded.active_thread_id, Some(thread_id.clone()));
        assert!(loaded.pinned_thread_ids.contains(&thread_id));
    }
}
