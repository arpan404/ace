use ace_core::{ModelSelection, Project, ProjectIcon, ProjectScript, ProviderKind, ThreadId};
use ace_runtime::chat::{ThreadStatus, ThreadSummary};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AceDbSnapshot {
    pub projects: Vec<Project>,
    pub threads: Vec<ThreadSummary>,
}

#[derive(Debug, Error)]
pub enum AceDbError {
    #[error("could not find ~/.ace userdata state.sqlite")]
    MissingDb,
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub fn load_default_ace_db() -> Result<AceDbSnapshot, AceDbError> {
    let path = default_ace_db_path().ok_or(AceDbError::MissingDb)?;
    load_ace_db(path)
}

pub fn load_ace_db(path: impl AsRef<Path>) -> Result<AceDbSnapshot, AceDbError> {
    let connection = Connection::open(path)?;
    Ok(AceDbSnapshot {
        projects: load_projects(&connection)?,
        threads: load_threads(&connection)?,
    })
}

fn default_ace_db_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("ACE_DB") {
        return Some(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    [
        home.join(".ace/dev/userdata/state.sqlite"),
        home.join(".ace/userdata/state.sqlite"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

fn load_projects(connection: &Connection) -> Result<Vec<Project>, AceDbError> {
    let mut statement = connection.prepare(
        "SELECT project_id, title, workspace_root, scripts_json, created_at, updated_at,
                deleted_at, default_model_selection_json, icon_json, archived_at
         FROM projection_projects
         WHERE deleted_at IS NULL
         ORDER BY updated_at DESC, project_id ASC",
    )?;
    let mut rows = statement.query([])?;
    let mut projects = Vec::new();
    while let Some(row) = rows.next()? {
        projects.push(Project {
            id: parse_json_string(row.get::<_, String>(0)?)?,
            title: row.get(1)?,
            workspace_root: row.get(2)?,
            scripts: parse_optional_json::<Vec<ProjectScript>>(row.get(3)?)?.unwrap_or_default(),
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
            deleted_at: row.get(6)?,
            default_model_selection: row
                .get::<_, Option<String>>(7)?
                .map(parse_json)
                .transpose()?,
            icon: row
                .get::<_, Option<String>>(8)?
                .map(parse_json::<ProjectIcon>)
                .transpose()?,
            archived_at: row.get(9)?,
        });
    }
    Ok(projects)
}

fn load_threads(connection: &Connection) -> Result<Vec<ThreadSummary>, AceDbError> {
    let mut statement = connection.prepare(
        "SELECT t.thread_id, t.project_id, t.title, t.branch, t.worktree_path, t.updated_at,
                t.archived_at, t.model_selection_json,
                s.status, s.provider_name, s.provider_thread_id,
                (SELECT text FROM projection_thread_messages m
                 WHERE m.thread_id = t.thread_id
                 ORDER BY m.created_at DESC, m.sequence DESC, m.message_id DESC
                 LIMIT 1) AS latest_message_preview,
                (SELECT COUNT(*) FROM projection_pending_approvals a
                 WHERE a.thread_id = t.thread_id AND a.status = 'pending') AS pending_approvals,
                EXISTS(SELECT 1 FROM projection_thread_proposed_plans p
                       WHERE p.thread_id = t.thread_id AND p.implemented_at IS NULL) AS has_actionable_plan
         FROM projection_threads t
         LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
         WHERE t.deleted_at IS NULL
         ORDER BY t.updated_at DESC, t.thread_id ASC",
    )?;
    let mut rows = statement.query([])?;
    let mut threads = Vec::new();
    while let Some(row) = rows.next()? {
        let archived_at = row.get::<_, Option<String>>(6)?;
        let provider = row
            .get::<_, Option<String>>(9)?
            .as_deref()
            .and_then(ProviderKind::from_runtime_id)
            .unwrap_or(ProviderKind::Codex);
        let model_selection = row
            .get::<_, Option<String>>(7)?
            .and_then(|json| parse_json::<ModelSelection>(json).ok());
        threads.push(ThreadSummary {
            id: ThreadId(row.get(0)?),
            project_id: parse_json_string(row.get::<_, String>(1)?)?,
            title: row.get(2)?,
            branch: row.get(3)?,
            worktree_path: row.get(4)?,
            latest_activity_at: row.get(5)?,
            archived: archived_at.is_some(),
            status: thread_status(
                row.get::<_, Option<String>>(8)?.as_deref(),
                archived_at.is_some(),
            ),
            provider,
            model: model_selection.map(|selection| selection.model),
            provider_thread_id: row.get(10)?,
            latest_message_preview: row.get(11)?,
            pending_approvals: row.get::<_, i64>(12)? as usize,
            pending_user_inputs: 0,
            has_actionable_plan: row.get::<_, bool>(13)?,
            pinned: false,
            unseen_completion: false,
        });
    }
    Ok(threads)
}

fn parse_json<T: serde::de::DeserializeOwned>(json: String) -> Result<T, serde_json::Error> {
    serde_json::from_str(&json)
}

fn parse_optional_json<T: serde::de::DeserializeOwned>(
    json: String,
) -> Result<Option<T>, serde_json::Error> {
    if json.trim().is_empty() {
        Ok(None)
    } else {
        serde_json::from_str(&json).map(Some)
    }
}

fn parse_json_string<T: serde::de::DeserializeOwned>(
    value: String,
) -> Result<T, serde_json::Error> {
    serde_json::from_value(serde_json::Value::String(value))
}

fn thread_status(status: Option<&str>, archived: bool) -> ThreadStatus {
    if archived {
        return ThreadStatus::Archived;
    }
    match status {
        Some("running" | "streaming") => ThreadStatus::Working,
        Some("connecting" | "starting") => ThreadStatus::Connecting,
        Some("waiting_for_approval") => ThreadStatus::PendingApproval,
        Some("waiting_for_user") => ThreadStatus::AwaitingInput,
        Some("error" | "failed") => ThreadStatus::Error,
        Some("completed") => ThreadStatus::Completed,
        _ => ThreadStatus::Idle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_projects_and_threads_from_ace_db() {
        let path =
            std::env::temp_dir().join(format!("ace-db-loader-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let connection = Connection::open(&path).expect("open temp db");
        connection
            .execute_batch(
                r#"
                CREATE TABLE projection_projects (
                    project_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    workspace_root TEXT NOT NULL,
                    scripts_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    default_model_selection_json TEXT,
                    icon_json TEXT,
                    archived_at TEXT
                );
                CREATE TABLE projection_threads (
                    thread_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    branch TEXT,
                    worktree_path TEXT,
                    updated_at TEXT NOT NULL,
                    archived_at TEXT,
                    deleted_at TEXT,
                    model_selection_json TEXT
                );
                CREATE TABLE projection_thread_sessions (
                    thread_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    provider_name TEXT,
                    provider_thread_id TEXT
                );
                CREATE TABLE projection_thread_messages (
                    message_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    sequence INTEGER
                );
                CREATE TABLE projection_pending_approvals (
                    request_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    status TEXT NOT NULL
                );
                CREATE TABLE projection_thread_proposed_plans (
                    plan_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    implemented_at TEXT
                );
                INSERT INTO projection_projects VALUES (
                    'd1a23fea-9b28-49b6-ae3f-77b00ff0365c', 'server', '/repo', '[]',
                    '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', NULL,
                    '{"provider":"codex","model":"gpt-5.4"}', NULL, NULL
                );
                INSERT INTO projection_threads VALUES (
                    'thread-1', 'd1a23fea-9b28-49b6-ae3f-77b00ff0365c', 'Build it',
                    'main', NULL, '2026-01-03T00:00:00Z', NULL, NULL,
                    '{"provider":"codex","model":"gpt-5.4"}'
                );
                INSERT INTO projection_thread_sessions VALUES ('thread-1', 'running', 'codex', 'provider-thread-1');
                INSERT INTO projection_thread_messages VALUES ('message-1', 'thread-1', 'Latest', '2026-01-03T00:00:00Z', 1);
                INSERT INTO projection_pending_approvals VALUES ('approval-1', 'thread-1', 'pending');
                INSERT INTO projection_thread_proposed_plans VALUES ('plan-1', 'thread-1', NULL);
                "#,
            )
            .expect("schema");
        drop(connection);

        let snapshot = load_ace_db(&path).expect("load snapshot");
        let _ = std::fs::remove_file(&path);

        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(snapshot.projects[0].title, "server");
        assert_eq!(snapshot.threads.len(), 1);
        assert_eq!(snapshot.threads[0].status, ThreadStatus::Working);
        assert_eq!(
            snapshot.threads[0].latest_message_preview.as_deref(),
            Some("Latest")
        );
        assert_eq!(snapshot.threads[0].pending_approvals, 1);
        assert!(snapshot.threads[0].has_actionable_plan);
    }
}
