use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub type IsoDateTime = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CommandId(Uuid);

impl CommandId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
}

impl Default for CommandId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EventId(Uuid);

impl EventId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
}

impl Default for EventId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderKind {
    Codex,
    ClaudeCode,
    Cursor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProjectId(Uuid);

impl ProjectId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
}

impl Default for ProjectId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ThreadId(pub String);

impl ThreadId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7().to_string())
    }
}

impl Default for ThreadId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TurnId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MessageId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CheckpointRef(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectScript {
    pub id: String,
    pub label: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectIcon {
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Thread {
    pub id: ThreadId,
    pub project_id: ProjectId,
    pub worktree_path: Option<String>,
    pub active_turn_id: Option<TurnId>,
    pub deleted_at: Option<IsoDateTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CheckpointStatus {
    Ready,
    Missing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CheckpointDiffSource {
    GitCheckpoint,
    ProviderReconstructed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointSummary {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub checkpoint_turn_count: u64,
    pub checkpoint_ref: CheckpointRef,
    pub status: CheckpointStatus,
    pub source: CheckpointDiffSource,
    pub files: Vec<CheckpointFile>,
    pub assistant_message_id: Option<MessageId>,
    pub completed_at: IsoDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ReadModel {
    pub projects: Vec<Project>,
    pub threads: Vec<Thread>,
    pub checkpoints: Vec<CheckpointSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCapability {
    pub key: String,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Command {
    StartProviderSession {
        provider: ProviderKind,
    },
    StopProviderSession {
        session_id: String,
    },
    ProjectCreate {
        project: Project,
    },
    ProjectUpdate {
        project: Project,
    },
    ProjectDelete {
        project_id: ProjectId,
        deleted_at: IsoDateTime,
    },
    ThreadCheckpointRevertRequested {
        thread_id: ThreadId,
        turn_count: u64,
    },
    ThreadTurnDiffComplete {
        checkpoint: CheckpointSummary,
    },
    ThreadRevertComplete {
        thread_id: ThreadId,
        turn_count: u64,
        created_at: IsoDateTime,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DomainEvent {
    ProviderSessionStarting {
        event_id: EventId,
        provider: ProviderKind,
    },
    ProviderSessionStopped {
        event_id: EventId,
        session_id: String,
    },
    ProjectCreated {
        event_id: EventId,
        project: Project,
    },
    ProjectUpdated {
        event_id: EventId,
        project: Project,
    },
    ProjectDeleted {
        event_id: EventId,
        project_id: ProjectId,
        deleted_at: IsoDateTime,
    },
    ThreadCheckpointRevertRequested {
        event_id: EventId,
        thread_id: ThreadId,
        turn_count: u64,
    },
    ThreadTurnDiffCompleted {
        event_id: EventId,
        checkpoint: CheckpointSummary,
    },
    ThreadReverted {
        event_id: EventId,
        thread_id: ThreadId,
        turn_count: u64,
        created_at: IsoDateTime,
    },
}

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("invalid command: {0}")]
    InvalidCommand(String),
}
