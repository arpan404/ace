use crate::backend::{
    BackendError, BackendHostClient, ProjectsAdd, ProjectsDelete, ProjectsProjectThreads,
    ProjectsSnapshot, ProjectsThreadMessages,
};
use ace_core::{Project, ProjectId, ThreadId};
use ace_project::ProjectSummary;
use ace_protocol::{
    git::{
        GitChangedFilesRequest, GitCommitRequest, GitDiffRequest, GitPushRequest, GitStageRequest,
        GitUnstageRequest,
    },
    project::{
        ProjectAddRequest, ProjectDeleteRequest, ProjectSnapshotRequest, ProjectThreadsRequest,
        ThreadMessagesRequest,
    },
    provider_runtime::{
        ProviderRuntimeEvent, ProviderRuntimeEventBatch, ProviderRuntimeProvidersList,
        ProviderRuntimeRawEventMode, ProviderRuntimeRecentEventsRequest,
        ProviderRuntimeRecentEventsResponse, ProviderRuntimeSlashCommandsListRequest,
        ProviderRuntimeSlashCommandsListResponse, ProviderRuntimeStateGetRequest,
        ProviderRuntimeStateGetResponse, ProviderRuntimeStatusListRequest,
        ProviderRuntimeStatusListResponse,
    },
    terminal::{
        DEFAULT_TERMINAL_ID, SequencedTerminalEvent, TerminalEvent, TerminalOpenRequest,
        TerminalSessionSnapshot, TerminalSessionStatus, TerminalWriteRequest,
    },
    ws::methods,
};
use ace_runtime::{
    chat::{
        ChatMessageProjection, ChatMessageRole, ChatProjection, ComposerDraft, CreationContext,
        InteractionMode, RuntimeMode, SidebarMetadata, SidebarProjection, ThreadDraft,
        ThreadStatus, ThreadSummary, build_chat_projection, build_sidebar_projection,
        resolve_thread_creation_options,
    },
    provider::{ProviderRuntimeHealth, ThreadItemKind, ThreadItemStatus},
    threads::{AgentRuntimeSnapshot, ExecutionLocation},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

const DEFAULT_CODEX_MODEL: &str = "gpt-5.3-codex";
const INITIAL_PROJECT_THREAD_LIMIT: usize = 5;
const PROJECT_THREAD_PAGE_SIZE: usize = 5;
const DEFAULT_TERMINAL_COLS: u16 = 120;
const DEFAULT_TERMINAL_ROWS: u16 = 32;
const DESKTOP_TERMINAL_HISTORY_LIMIT: usize = 128 * 1024;
const DESKTOP_DIFF_PREVIEW_LIMIT: usize = 96 * 1024;

#[derive(Debug, Clone)]
pub struct DesktopStore {
    host: Option<BackendHostClient>,
    projects: Vec<Project>,
    threads: Vec<ThreadSummary>,
    thread_drafts: HashMap<ThreadId, ThreadDraft>,
    project_drafts: HashMap<ProjectId, ThreadId>,
    composer_drafts: HashMap<ThreadId, ComposerDraft>,
    persisted_messages: HashMap<ThreadId, Vec<ChatMessageProjection>>,
    terminal_sessions: HashMap<TerminalKey, TerminalSessionProjection>,
    terminal_inputs: HashMap<ThreadId, String>,
    terminal_errors: HashMap<ThreadId, String>,
    review_snapshots: HashMap<ProjectId, ReviewProjection>,
    provider_registry: ProviderRegistryProjection,
    runtime_status: RuntimeStatusProjection,
    plugin_registry: ToolRegistryProjection,
    skill_registry: ToolRegistryProjection,
    pinned_items: Vec<PinnedTimelineItem>,
    highlighted_items: Vec<HighlightedTimelineItem>,
    todos: Vec<TodoItem>,
    thread_counts: HashMap<ProjectId, usize>,
    project_thread_limits: HashMap<ProjectId, usize>,
    metadata: SidebarMetadata,
    runtime: AgentRuntimeSnapshot,
    now_counter: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopProjection {
    pub sidebar: SidebarProjection,
    pub chat: ChatProjection,
    pub host: HostProjection,
    pub services: ServiceReadiness,
    pub terminal: TerminalProjection,
    pub review: ReviewProjection,
    pub sources: SourcesProjection,
    pub providers: ProviderRegistryProjection,
    pub runtime_status: RuntimeStatusProjection,
    pub plugins: ToolRegistryProjection,
    pub skills: ToolRegistryProjection,
    pub annotations: ThreadAnnotationsProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostProjection {
    pub id: String,
    pub label: String,
    pub endpoint: Option<String>,
}

impl Default for HostProjection {
    fn default() -> Self {
        Self {
            id: "disconnected".to_string(),
            label: "No host".to_string(),
            endpoint: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceReadiness {
    pub host_connected: bool,
    pub terminal: ServiceStatus,
    pub diff_review: ServiceStatus,
    pub browser: ServiceStatus,
    pub editor: ServiceStatus,
    pub summary: ServiceStatus,
    pub providers: ServiceStatus,
    pub plugins: ServiceStatus,
    pub skills: ServiceStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceStatus {
    Ready,
    Missing { reason: &'static str },
}

impl ServiceStatus {
    #[must_use]
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready)
    }

    #[must_use]
    pub fn missing_reason(&self) -> Option<&'static str> {
        match self {
            Self::Ready => None,
            Self::Missing { reason } => Some(reason),
        }
    }
}

impl ServiceReadiness {
    #[must_use]
    pub fn offline() -> Self {
        let reason = "Connect to a local or remote host runtime to enable this service.";
        Self {
            host_connected: false,
            terminal: ServiceStatus::Missing { reason },
            diff_review: ServiceStatus::Missing { reason },
            browser: ServiceStatus::Missing { reason },
            editor: ServiceStatus::Missing { reason },
            summary: ServiceStatus::Ready,
            providers: ServiceStatus::Missing { reason },
            plugins: ServiceStatus::Missing { reason },
            skills: ServiceStatus::Missing { reason },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerPayload {
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalProjection {
    pub active_thread_id: Option<ThreadId>,
    pub session: Option<TerminalSessionProjection>,
    pub input: String,
    pub error: Option<String>,
    pub can_send: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSessionProjection {
    pub thread_id: String,
    pub terminal_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub status: TerminalSessionStatus,
    pub pid: Option<u32>,
    pub history: String,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
    pub cols: u16,
    pub rows: u16,
    pub updated_at: String,
    pub next_sequence: u64,
    pub truncated_before_sequence: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReviewProjection {
    pub repo_path: Option<String>,
    pub files: Vec<ReviewFileProjection>,
    pub diff_preview: String,
    pub diff_truncated: bool,
    pub total_additions: u32,
    pub total_deletions: u32,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewFileProjection {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourcesProjection {
    pub items: Vec<SourceItemProjection>,
    pub changed_files: usize,
    pub terminal_sessions: usize,
    pub context_items: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceItemProjection {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub added_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderRegistryProjection {
    pub providers: Vec<ProviderSummaryProjection>,
    pub total_slash_commands: usize,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeStatusProjection {
    pub providers: usize,
    pub threads: usize,
    pub active_threads: usize,
    pub active_turns: usize,
    pub handoffs: usize,
    pub pending_approvals: usize,
    pub warnings: usize,
    pub remote_connections: usize,
    pub remote_host_connections: usize,
    pub connected_remote_connections: usize,
    pub disconnected_remote_connections: usize,
    pub remote_connections_with_projects: usize,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSummaryProjection {
    pub runtime_id: String,
    pub display_name: String,
    pub ready: bool,
    pub selectable: bool,
    pub health: String,
    pub slash_commands: usize,
    pub missing: Vec<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolRegistryProjection {
    pub entries: Vec<ToolRegistryEntryProjection>,
    pub source: &'static str,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRegistryEntryProjection {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
    pub status: String,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadAnnotationsProjection {
    pub pinned_items: Vec<PinnedTimelineItem>,
    pub highlighted_items: Vec<HighlightedTimelineItem>,
    pub todos: Vec<TodoItem>,
    pub open_todo_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedTimelineItem {
    pub id: String,
    pub thread_id: ThreadId,
    pub message_id: String,
    pub display_title: String,
    pub display_excerpt: String,
    pub pinned_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HighlightedTimelineItem {
    pub id: String,
    pub thread_id: ThreadId,
    pub message_id: String,
    pub display_title: String,
    pub display_excerpt: String,
    pub highlighted_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub thread_id: ThreadId,
    pub source_message_id: Option<String>,
    pub title: String,
    pub status: TodoStatus,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Open,
    InProgress,
    Blocked,
    Done,
    Canceled,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadAnnotationsSnapshot {
    #[serde(default)]
    pub pinned_items: Vec<PinnedTimelineItem>,
    #[serde(default)]
    pub highlighted_items: Vec<HighlightedTimelineItem>,
    #[serde(default)]
    pub todos: Vec<TodoItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TerminalKey {
    thread_id: String,
    terminal_id: String,
}

impl TerminalKey {
    fn default_for_thread(thread_id: &ThreadId) -> Self {
        Self {
            thread_id: thread_id.0.clone(),
            terminal_id: DEFAULT_TERMINAL_ID.to_string(),
        }
    }
}

impl DesktopStore {
    #[must_use]
    pub fn new() -> Self {
        Self {
            host: None,
            projects: Vec::new(),
            threads: Vec::new(),
            thread_drafts: HashMap::new(),
            project_drafts: HashMap::new(),
            composer_drafts: HashMap::new(),
            persisted_messages: HashMap::new(),
            terminal_sessions: HashMap::new(),
            terminal_inputs: HashMap::new(),
            terminal_errors: HashMap::new(),
            review_snapshots: HashMap::new(),
            provider_registry: ProviderRegistryProjection::default(),
            runtime_status: RuntimeStatusProjection::default(),
            plugin_registry: ToolRegistryProjection {
                source: "plugin/installed",
                ..ToolRegistryProjection::default()
            },
            skill_registry: ToolRegistryProjection {
                source: "skills/list",
                ..ToolRegistryProjection::default()
            },
            pinned_items: Vec::new(),
            highlighted_items: Vec::new(),
            todos: Vec::new(),
            thread_counts: HashMap::new(),
            project_thread_limits: HashMap::new(),
            metadata: SidebarMetadata::default(),
            runtime: AgentRuntimeSnapshot::default(),
            now_counter: now_millis(),
        }
    }

    pub fn load_from_host(host: &BackendHostClient) -> Result<Self, BackendError> {
        let snapshot = host.request::<ProjectsSnapshot>(&ProjectSnapshotRequest {})?;
        let mut store = Self::new();
        store.host = Some(host.clone());
        store.replace_snapshot(snapshot.projects, snapshot.threads, snapshot.thread_counts);
        Ok(store)
    }

    pub fn replace_snapshot(
        &mut self,
        projects: Vec<Project>,
        threads: Vec<ThreadSummary>,
        thread_counts: HashMap<ProjectId, usize>,
    ) {
        self.projects = projects;
        self.threads = threads;
        self.thread_counts = thread_counts;
        self.project_thread_limits.clear();
        for project in &self.projects {
            let loaded = self
                .threads
                .iter()
                .filter(|thread| thread.project_id == project.id)
                .count();
            let total = *self.thread_counts.entry(project.id).or_insert(loaded);
            self.project_thread_limits.insert(
                project.id,
                loaded.min(total.min(INITIAL_PROJECT_THREAD_LIMIT)),
            );
        }
        self.thread_drafts.clear();
        self.project_drafts.clear();
        self.composer_drafts.clear();
        self.persisted_messages.clear();
        self.metadata.active_thread_id = self
            .threads
            .iter()
            .find(|thread| !thread.archived)
            .map(|thread| thread.id.clone());
    }

    #[must_use]
    pub fn projection(&self) -> DesktopProjection {
        let sidebar_threads = self.visible_sidebar_threads();
        let mut sidebar =
            build_sidebar_projection(&self.projects, &sidebar_threads, &self.metadata);
        sidebar.total_thread_count = 0;
        for group in &mut sidebar.projects {
            group.project.thread_count = self
                .thread_counts
                .get(&group.project.id)
                .copied()
                .unwrap_or(group.threads.len());
            sidebar.total_thread_count += group.project.thread_count;
            for thread in &mut group.threads {
                thread.latest_message_preview = None;
            }
        }
        let active_thread = self.active_thread().cloned();
        let composer = self
            .metadata
            .active_thread_id
            .as_ref()
            .and_then(|id| self.composer_drafts.get(id))
            .cloned();
        let mut chat = build_chat_projection(active_thread, composer, &self.runtime);
        if chat.messages.is_empty()
            && let Some(thread_id) = chat.active_thread.as_ref().map(|thread| &thread.id)
        {
            chat.messages = self
                .persisted_messages
                .get(thread_id)
                .cloned()
                .unwrap_or_default();
        }
        DesktopProjection {
            sidebar,
            chat,
            host: self.host_projection(),
            services: self.service_readiness(),
            terminal: self.terminal_projection(),
            review: self.review_projection(),
            sources: self.sources_projection(),
            providers: self.provider_registry.clone(),
            runtime_status: self.runtime_status.clone(),
            plugins: self.plugin_registry.clone(),
            skills: self.skill_registry.clone(),
            annotations: self.annotations_projection(),
        }
    }

    #[must_use]
    pub fn host_projection(&self) -> HostProjection {
        self.host
            .as_ref()
            .map_or_else(HostProjection::default, |host| {
                let endpoint = host.endpoint();
                HostProjection {
                    id: host.id().as_str().to_string(),
                    label: host.label().to_string(),
                    endpoint: Some(format!(
                        "{}:{}{}",
                        endpoint.host, endpoint.port, endpoint.path
                    )),
                }
            })
    }

    #[must_use]
    pub fn service_readiness(&self) -> ServiceReadiness {
        if self.host.is_none() {
            return ServiceReadiness::offline();
        }

        ServiceReadiness {
            host_connected: true,
            terminal: ServiceStatus::Ready,
            diff_review: ServiceStatus::Ready,
            browser: ServiceStatus::Missing {
                reason: "Browser sessions need a host-driven Chromium frame service.",
            },
            editor: ServiceStatus::Missing {
                reason: "Editor buffers need a GPUI buffer surface wired to the editor RPC service.",
            },
            summary: ServiceStatus::Ready,
            providers: ServiceStatus::Ready,
            plugins: ServiceStatus::Ready,
            skills: ServiceStatus::Ready,
        }
    }

    #[must_use]
    pub fn terminal_projection(&self) -> TerminalProjection {
        let active_thread_id = self.metadata.active_thread_id.clone();
        let session = active_thread_id
            .as_ref()
            .and_then(|thread_id| {
                self.terminal_sessions
                    .get(&TerminalKey::default_for_thread(thread_id))
            })
            .cloned();
        let input = active_thread_id
            .as_ref()
            .and_then(|thread_id| self.terminal_inputs.get(thread_id))
            .cloned()
            .unwrap_or_default();
        let error = active_thread_id
            .as_ref()
            .and_then(|thread_id| self.terminal_errors.get(thread_id))
            .cloned();
        let can_send = active_thread_id.is_some()
            && session
                .as_ref()
                .is_some_and(|session| session.status == TerminalSessionStatus::Running)
            && !input.trim().is_empty();

        TerminalProjection {
            active_thread_id,
            session,
            input,
            error,
            can_send,
        }
    }

    #[must_use]
    pub fn review_projection(&self) -> ReviewProjection {
        let Some(thread) = self.active_thread() else {
            return ReviewProjection::default();
        };
        self.review_snapshots
            .get(&thread.project_id)
            .cloned()
            .unwrap_or_else(|| ReviewProjection {
                repo_path: self.review_repo_path(thread),
                ..ReviewProjection::default()
            })
    }

    #[must_use]
    pub fn sources_projection(&self) -> SourcesProjection {
        let review = self.review_projection();
        let terminal = self.terminal_projection();
        let annotations = self.annotations_projection();
        let mut items = Vec::new();

        for file in &review.files {
            let stat = match (file.additions, file.deletions) {
                (Some(additions), Some(deletions)) => format!("+{additions} -{deletions}"),
                _ => "diff stat unavailable".to_string(),
            };
            items.push(SourceItemProjection {
                id: format!("file:{}", file.path),
                kind: "file".to_string(),
                title: file.path.clone(),
                detail: format!("{} · {stat}", file.status),
                added_at: review.updated_at.clone().unwrap_or_default(),
            });
        }

        if let Some(session) = terminal.session.as_ref() {
            items.push(SourceItemProjection {
                id: format!("terminal:{}:{}", session.thread_id, session.terminal_id),
                kind: "terminal".to_string(),
                title: "Terminal session".to_string(),
                detail: format!("{} · {}", short_status(&session.status), session.cwd),
                added_at: session.updated_at.clone(),
            });
        }

        for item in &annotations.pinned_items {
            items.push(SourceItemProjection {
                id: format!("pin:{}", item.id),
                kind: "pinned".to_string(),
                title: item.display_title.clone(),
                detail: item.display_excerpt.clone(),
                added_at: item.pinned_at.clone(),
            });
        }

        for item in &annotations.highlighted_items {
            items.push(SourceItemProjection {
                id: format!("highlight:{}", item.id),
                kind: "highlight".to_string(),
                title: item.display_title.clone(),
                detail: item.display_excerpt.clone(),
                added_at: item.highlighted_at.clone(),
            });
        }

        for todo in &annotations.todos {
            items.push(SourceItemProjection {
                id: format!("todo:{}", todo.id),
                kind: "todo".to_string(),
                title: todo.title.clone(),
                detail: format!("{:?}", todo.status),
                added_at: todo.created_at.clone(),
            });
        }

        SourcesProjection {
            changed_files: review.files.len(),
            terminal_sessions: usize::from(terminal.session.is_some()),
            context_items: annotations.pinned_items.len()
                + annotations.highlighted_items.len()
                + annotations.todos.len(),
            items,
        }
    }

    #[must_use]
    pub fn annotations_snapshot(&self) -> ThreadAnnotationsSnapshot {
        ThreadAnnotationsSnapshot {
            pinned_items: self.pinned_items.clone(),
            highlighted_items: self.highlighted_items.clone(),
            todos: self.todos.clone(),
        }
    }

    pub fn restore_annotations(&mut self, snapshot: ThreadAnnotationsSnapshot) {
        self.pinned_items = snapshot.pinned_items;
        self.highlighted_items = snapshot.highlighted_items;
        self.todos = snapshot.todos;
    }

    #[must_use]
    pub fn annotations_projection(&self) -> ThreadAnnotationsProjection {
        let Some(thread_id) = self.metadata.active_thread_id.as_ref() else {
            return ThreadAnnotationsProjection::default();
        };
        let pinned_items = self
            .pinned_items
            .iter()
            .filter(|item| &item.thread_id == thread_id)
            .cloned()
            .collect::<Vec<_>>();
        let highlighted_items = self
            .highlighted_items
            .iter()
            .filter(|item| &item.thread_id == thread_id)
            .cloned()
            .collect::<Vec<_>>();
        let todos = self
            .todos
            .iter()
            .filter(|todo| &todo.thread_id == thread_id)
            .cloned()
            .collect::<Vec<_>>();
        let open_todo_count = todos
            .iter()
            .filter(|todo| {
                matches!(
                    todo.status,
                    TodoStatus::Open | TodoStatus::InProgress | TodoStatus::Blocked
                )
            })
            .count();

        ThreadAnnotationsProjection {
            pinned_items,
            highlighted_items,
            todos,
            open_todo_count,
        }
    }

    pub fn pin_latest_timeline_item(&mut self) {
        let Some((thread_id, message)) = self.latest_active_message() else {
            return;
        };
        self.pin_timeline_item(thread_id, &message.id);
    }

    pub fn pin_timeline_item(&mut self, thread_id: ThreadId, message_id: &str) {
        let Some(message) = self.message_for_thread(&thread_id, message_id) else {
            return;
        };
        if self
            .pinned_items
            .iter()
            .any(|item| item.thread_id == thread_id && item.message_id == message.id)
        {
            return;
        }
        let now = self.next_timestamp();
        let excerpt = message_excerpt(&message);
        self.pinned_items.push(PinnedTimelineItem {
            id: format!("pin-{now}-{}", message.id),
            thread_id,
            message_id: message.id.clone(),
            display_title: message
                .title
                .clone()
                .unwrap_or_else(|| "Pinned item".to_string()),
            display_excerpt: excerpt,
            pinned_at: now,
        });
    }

    pub fn toggle_highlight_latest_timeline_item(&mut self) {
        let Some((thread_id, message)) = self.latest_active_message() else {
            return;
        };
        self.toggle_highlight_timeline_item(thread_id, &message.id);
    }

    pub fn toggle_highlight_timeline_item(&mut self, thread_id: ThreadId, message_id: &str) {
        let Some(message) = self.message_for_thread(&thread_id, message_id) else {
            return;
        };
        if let Some(index) = self
            .highlighted_items
            .iter()
            .position(|item| item.thread_id == thread_id && item.message_id == message.id)
        {
            self.highlighted_items.remove(index);
            return;
        }

        let now = self.next_timestamp();
        let excerpt = message_excerpt(&message);
        if excerpt.is_empty() {
            return;
        }
        self.highlighted_items.push(HighlightedTimelineItem {
            id: format!("highlight-{now}-{}", message.id),
            thread_id,
            message_id: message.id.clone(),
            display_title: message
                .title
                .clone()
                .unwrap_or_else(|| "Highlighted item".to_string()),
            display_excerpt: excerpt,
            highlighted_at: now,
        });
    }

    pub fn create_todo_from_latest_timeline_item(&mut self) {
        let Some((thread_id, message)) = self.latest_active_message() else {
            return;
        };
        self.create_todo_from_timeline_item(thread_id, &message.id);
    }

    pub fn create_todo_from_timeline_item(&mut self, thread_id: ThreadId, message_id: &str) {
        let Some(message) = self.message_for_thread(&thread_id, message_id) else {
            return;
        };
        let title = message_excerpt(&message);
        if title.is_empty() {
            return;
        }
        let now = self.next_timestamp();
        self.todos.push(TodoItem {
            id: format!("todo-{now}-{}", message.id),
            thread_id,
            source_message_id: Some(message.id.clone()),
            title,
            status: TodoStatus::Open,
            created_at: now.clone(),
            updated_at: now,
            completed_at: None,
        });
    }

    pub fn toggle_first_open_todo(&mut self) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let now = self.next_timestamp();
        if let Some(todo) = self.todos.iter_mut().find(|todo| {
            todo.thread_id == thread_id
                && matches!(
                    todo.status,
                    TodoStatus::Open | TodoStatus::InProgress | TodoStatus::Blocked
                )
        }) {
            todo.status = TodoStatus::Done;
            todo.updated_at = now.clone();
            todo.completed_at = Some(now);
        }
    }

    pub fn update_todo_status(&mut self, todo_id: &str, status: TodoStatus) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let now = self.next_timestamp();
        if let Some(todo) = self
            .todos
            .iter_mut()
            .find(|todo| todo.thread_id == thread_id && todo.id == todo_id)
        {
            todo.status = status;
            todo.updated_at = now.clone();
            todo.completed_at = (status == TodoStatus::Done).then_some(now);
        }
    }

    pub fn refresh_active_review(&mut self, host: Option<&BackendHostClient>) {
        let Some(thread) = self.active_thread().cloned() else {
            return;
        };
        let Some(repo_path) = self.review_repo_path(&thread) else {
            self.review_snapshots.insert(
                thread.project_id,
                ReviewProjection {
                    error: Some("No project workspace is available for this thread.".to_string()),
                    ..ReviewProjection::default()
                },
            );
            return;
        };

        let host = self.host.clone().or_else(|| host.cloned());
        let Some(host) = host else {
            self.review_snapshots.insert(
                thread.project_id,
                ReviewProjection {
                    repo_path: Some(repo_path),
                    error: Some(
                        "Connect to a host runtime before refreshing Git review.".to_string(),
                    ),
                    ..ReviewProjection::default()
                },
            );
            return;
        };

        let files_response = host.call::<_, serde_json::Value>(
            methods::GIT_CHANGED_FILES,
            &GitChangedFilesRequest {
                repo_path: repo_path.clone(),
                staged: false,
                include_untracked: true,
            },
        );
        let diff_response = host.call::<_, serde_json::Value>(
            methods::GIT_DIFF,
            &GitDiffRequest {
                repo_path: repo_path.clone(),
            },
        );

        let projection = match (files_response, diff_response) {
            (Ok(files), Ok(diff)) => {
                let files = parse_review_files(files);
                let diff = diff
                    .get("diff")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let (diff_preview, diff_truncated) = truncate_diff_preview(diff);
                let total_additions = files.iter().filter_map(|file| file.additions).sum();
                let total_deletions = files.iter().filter_map(|file| file.deletions).sum();
                ReviewProjection {
                    repo_path: Some(repo_path),
                    files,
                    diff_preview,
                    diff_truncated,
                    total_additions,
                    total_deletions,
                    error: None,
                    updated_at: Some(self.next_timestamp()),
                }
            }
            (Err(error), _) | (_, Err(error)) => ReviewProjection {
                repo_path: Some(repo_path),
                error: Some(format!("Failed to refresh Git review: {error}")),
                ..ReviewProjection::default()
            },
        };
        self.review_snapshots.insert(thread.project_id, projection);
    }

    pub fn refresh_provider_registry(&mut self, host: Option<&BackendHostClient>) {
        let Some(host) = self.host.clone().or_else(|| host.cloned()) else {
            let error =
                "Connect to a local or remote host runtime to inspect provider runtime state."
                    .to_string();
            self.provider_registry = ProviderRegistryProjection {
                error: Some(
                    "Connect to a local or remote host runtime to inspect providers.".to_string(),
                ),
                ..ProviderRegistryProjection::default()
            };
            self.runtime_status = RuntimeStatusProjection {
                error: Some(error),
                updated_at: Some(self.next_timestamp()),
                ..RuntimeStatusProjection::default()
            };
            return;
        };

        let now = self.next_timestamp();
        let providers_response = match host.call::<_, ProviderRuntimeProvidersList>(
            methods::PROVIDER_RUNTIME_PROVIDERS_LIST,
            &serde_json::Value::Null,
        ) {
            Ok(response) => response,
            Err(error) => {
                self.provider_registry = ProviderRegistryProjection {
                    error: Some(format!("Provider registry unavailable: {error}")),
                    updated_at: Some(now),
                    ..ProviderRegistryProjection::default()
                };
                self.runtime_status = RuntimeStatusProjection {
                    error: Some(format!("Provider runtime state unavailable: {error}")),
                    updated_at: self.provider_registry.updated_at.clone(),
                    ..RuntimeStatusProjection::default()
                };
                return;
            }
        };

        let mut partial_errors = Vec::new();
        let status_response = match host.call::<_, ProviderRuntimeStatusListResponse>(
            methods::PROVIDER_RUNTIME_STATUS_LIST,
            &ProviderRuntimeStatusListRequest::default(),
        ) {
            Ok(response) => Some(response),
            Err(error) => {
                partial_errors.push(format!("status unavailable: {error}"));
                None
            }
        };
        let state_response = match host.call::<_, ProviderRuntimeStateGetResponse>(
            methods::PROVIDER_RUNTIME_STATE_GET,
            &ProviderRuntimeStateGetRequest::default(),
        ) {
            Ok(response) => Some(response),
            Err(error) => {
                partial_errors.push(format!("runtime state unavailable: {error}"));
                self.runtime_status = RuntimeStatusProjection {
                    providers: providers_response.runtime.len(),
                    error: Some(format!("Provider runtime state unavailable: {error}")),
                    updated_at: Some(now.clone()),
                    ..RuntimeStatusProjection::default()
                };
                None
            }
        };
        let slash_response = match host.call::<_, ProviderRuntimeSlashCommandsListResponse>(
            methods::PROVIDER_RUNTIME_SLASH_COMMANDS_LIST,
            &ProviderRuntimeSlashCommandsListRequest::default(),
        ) {
            Ok(response) => Some(response),
            Err(error) => {
                partial_errors.push(format!("slash commands unavailable: {error}"));
                None
            }
        };

        let providers = providers_response
            .runtime
            .iter()
            .map(|provider| {
                let status = status_response.as_ref().and_then(|response| {
                    response
                        .providers
                        .iter()
                        .find(|status| status.runtime_id == provider.runtime_id)
                });
                let slash_commands = slash_response
                    .as_ref()
                    .and_then(|response| {
                        response
                            .providers
                            .iter()
                            .find(|commands| commands.runtime_id == provider.runtime_id)
                    })
                    .map_or(0, |commands| commands.commands.len());
                let readiness = status.map_or(&provider.readiness, |status| &status.readiness);
                let mut missing = readiness.missing_required_capabilities.clone();
                missing.extend(
                    readiness
                        .missing_required_hooks
                        .iter()
                        .map(|hook| format!("{hook:?}")),
                );

                ProviderSummaryProjection {
                    runtime_id: provider.runtime_id.clone(),
                    display_name: provider.display_name.clone(),
                    ready: status.map_or(provider.readiness.ready, |status| status.summary.ready),
                    selectable: provider.summary.selectable,
                    health: status.map_or_else(
                        || {
                            if provider.readiness.ready {
                                "ready".to_string()
                            } else {
                                "unavailable".to_string()
                            }
                        },
                        |status| provider_health_label(status.summary.health).to_string(),
                    ),
                    slash_commands,
                    missing,
                    last_error: status.and_then(|status| status.summary.last_error.clone()),
                }
            })
            .collect::<Vec<_>>();
        let total_slash_commands = providers
            .iter()
            .map(|provider| provider.slash_commands)
            .sum();

        self.provider_registry = ProviderRegistryProjection {
            providers,
            total_slash_commands,
            error: (!partial_errors.is_empty()).then(|| partial_errors.join("; ")),
            updated_at: Some(now),
        };
        if let Some(response) = state_response {
            self.runtime_status = runtime_status_projection_from_state(
                &response,
                providers_response.runtime.len(),
                self.provider_registry
                    .updated_at
                    .clone()
                    .unwrap_or_default(),
            );
        }
    }

    pub fn refresh_plugin_registry(&mut self, host: Option<&BackendHostClient>) {
        self.plugin_registry = self.refresh_tool_registry(
            host,
            methods::CODEX_PLUGINS_INSTALLED,
            "plugin/installed",
            "Plugin registry",
            RegistrySurface::Plugin,
        );
    }

    pub fn refresh_skill_registry(&mut self, host: Option<&BackendHostClient>) {
        self.skill_registry = self.refresh_tool_registry(
            host,
            methods::CODEX_SKILLS_LIST,
            "skills/list",
            "Skill registry",
            RegistrySurface::Skill,
        );
    }

    pub fn refresh_developer_registries(&mut self, host: Option<&BackendHostClient>) {
        self.refresh_provider_registry(host);
        self.refresh_plugin_registry(host);
        self.refresh_skill_registry(host);
    }

    fn refresh_tool_registry(
        &mut self,
        host: Option<&BackendHostClient>,
        method: &'static str,
        source: &'static str,
        label: &'static str,
        surface: RegistrySurface,
    ) -> ToolRegistryProjection {
        let Some(host) = self.host.clone().or_else(|| host.cloned()) else {
            return ToolRegistryProjection {
                source,
                error: Some(format!(
                    "Connect to a local or remote host runtime to inspect {label}."
                )),
                updated_at: Some(self.next_timestamp()),
                ..ToolRegistryProjection::default()
            };
        };

        let now = self.next_timestamp();
        match host.call::<_, serde_json::Value>(method, &serde_json::json!({})) {
            Ok(value) => ToolRegistryProjection {
                entries: parse_tool_registry_entries(value, surface),
                source,
                error: None,
                updated_at: Some(now),
            },
            Err(error) => ToolRegistryProjection {
                source,
                error: Some(format!("{label} unavailable via {source}: {error}")),
                updated_at: Some(now),
                ..ToolRegistryProjection::default()
            },
        }
    }

    pub fn stage_active_review_all(&mut self, host: Option<&BackendHostClient>) {
        self.run_active_review_git_action(host, "stage all", |host, repo_path| {
            host.call::<_, serde_json::Value>(
                methods::GIT_STAGE,
                &GitStageRequest {
                    repo_path,
                    paths: Vec::new(),
                    all: true,
                },
            )
        });
    }

    pub fn unstage_active_review_all(&mut self, host: Option<&BackendHostClient>) {
        self.run_active_review_git_action(host, "unstage all", |host, repo_path| {
            host.call::<_, serde_json::Value>(
                methods::GIT_UNSTAGE,
                &GitUnstageRequest {
                    repo_path,
                    paths: Vec::new(),
                    all: true,
                },
            )
        });
    }

    pub fn stage_active_review_file(&mut self, host: Option<&BackendHostClient>, path: String) {
        self.run_active_review_git_action(host, "stage file", |host, repo_path| {
            host.call::<_, serde_json::Value>(
                methods::GIT_STAGE,
                &GitStageRequest {
                    repo_path,
                    paths: vec![path],
                    all: false,
                },
            )
        });
    }

    pub fn unstage_active_review_file(&mut self, host: Option<&BackendHostClient>, path: String) {
        self.run_active_review_git_action(host, "unstage file", |host, repo_path| {
            host.call::<_, serde_json::Value>(
                methods::GIT_UNSTAGE,
                &GitUnstageRequest {
                    repo_path,
                    paths: vec![path],
                    all: false,
                },
            )
        });
    }

    pub fn commit_active_review(&mut self, host: Option<&BackendHostClient>) {
        let message = generated_review_commit_message(&self.review_projection());
        self.run_active_review_git_action(host, "commit staged changes", |host, repo_path| {
            host.call::<_, serde_json::Value>(
                methods::GIT_COMMIT,
                &GitCommitRequest { repo_path, message },
            )
        });
    }

    pub fn push_active_review(&mut self, host: Option<&BackendHostClient>) {
        self.run_active_review_git_action(host, "push branch", |host, repo_path| {
            host.call::<_, serde_json::Value>(
                methods::GIT_PUSH,
                &GitPushRequest {
                    repo_path,
                    set_upstream: true,
                },
            )
        });
    }

    pub fn ensure_active_terminal(&mut self, host: Option<&BackendHostClient>) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let key = TerminalKey::default_for_thread(&thread_id);
        if self
            .terminal_sessions
            .get(&key)
            .is_some_and(|session| session.status == TerminalSessionStatus::Running)
        {
            return;
        }

        let Some(cwd) = self.active_terminal_cwd(&thread_id) else {
            self.terminal_errors.insert(
                thread_id,
                "No project workspace is available for this thread.".to_string(),
            );
            return;
        };

        let host = self.host.clone().or_else(|| host.cloned());
        let Some(host) = host else {
            self.terminal_errors.insert(
                thread_id,
                "Connect to a host runtime before opening a terminal.".to_string(),
            );
            return;
        };

        let request = TerminalOpenRequest {
            thread_id: key.thread_id.clone(),
            terminal_id: key.terminal_id.clone(),
            cwd,
            cols: Some(DEFAULT_TERMINAL_COLS),
            rows: Some(DEFAULT_TERMINAL_ROWS),
            env: None,
        };
        match host.call::<_, TerminalSessionSnapshot>(methods::TERMINAL_OPEN, &request) {
            Ok(snapshot) => {
                self.terminal_errors.remove(&thread_id);
                self.upsert_terminal_snapshot(snapshot);
            }
            Err(error) => {
                self.terminal_errors
                    .insert(thread_id, format!("Failed to open terminal: {error}"));
            }
        }
    }

    pub fn push_active_terminal_input(&mut self, input: &str) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        self.terminal_inputs
            .entry(thread_id)
            .or_default()
            .push_str(input);
    }

    pub fn pop_active_terminal_input(&mut self) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        if let Some(input) = self.terminal_inputs.get_mut(&thread_id) {
            input.pop();
        }
    }

    pub fn send_active_terminal_input(&mut self, host: Option<&BackendHostClient>) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let input = self
            .terminal_inputs
            .get(&thread_id)
            .cloned()
            .unwrap_or_default();
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return;
        }

        self.ensure_active_terminal(host);
        let host = self.host.clone().or_else(|| host.cloned());
        let Some(host) = host else {
            self.terminal_errors.insert(
                thread_id,
                "Connect to a host runtime before writing to a terminal.".to_string(),
            );
            return;
        };

        let key = TerminalKey::default_for_thread(&thread_id);
        let request = TerminalWriteRequest {
            thread_id: key.thread_id,
            terminal_id: key.terminal_id,
            data: format!("{trimmed}\n"),
        };
        match host.call::<_, ()>(methods::TERMINAL_WRITE, &request) {
            Ok(()) => {
                self.terminal_inputs.remove(&thread_id);
                self.terminal_errors.remove(&thread_id);
            }
            Err(error) => {
                self.terminal_errors
                    .insert(thread_id, format!("Failed to write to terminal: {error}"));
            }
        }
    }

    pub fn apply_terminal_event(&mut self, event: SequencedTerminalEvent) {
        match event.event {
            TerminalEvent::Started { snapshot, .. } | TerminalEvent::Restarted { snapshot, .. } => {
                self.upsert_terminal_snapshot(snapshot);
            }
            TerminalEvent::Output {
                thread_id,
                terminal_id,
                data,
                ..
            } => {
                let session = self
                    .terminal_sessions
                    .entry(TerminalKey {
                        thread_id: thread_id.clone(),
                        terminal_id: terminal_id.clone(),
                    })
                    .or_insert_with(|| {
                        TerminalSessionProjection::placeholder(thread_id, terminal_id)
                    });
                append_terminal_history(&mut session.history, &data);
                session.next_sequence = event.sequence.saturating_add(1);
            }
            TerminalEvent::Title {
                thread_id,
                terminal_id,
                title,
                ..
            } => {
                if let Some(session) = self.terminal_sessions.get_mut(&TerminalKey {
                    thread_id,
                    terminal_id,
                }) {
                    session.title = title;
                    session.next_sequence = event.sequence.saturating_add(1);
                }
            }
            TerminalEvent::Exited {
                thread_id,
                terminal_id,
                exit_code,
                exit_signal,
                ..
            } => {
                if let Some(session) = self.terminal_sessions.get_mut(&TerminalKey {
                    thread_id,
                    terminal_id,
                }) {
                    session.status = TerminalSessionStatus::Exited;
                    session.pid = None;
                    session.exit_code = exit_code;
                    session.exit_signal = exit_signal;
                    session.next_sequence = event.sequence.saturating_add(1);
                }
            }
            TerminalEvent::Error {
                thread_id,
                terminal_id,
                message,
                ..
            } => {
                if let Some(session) = self.terminal_sessions.get_mut(&TerminalKey {
                    thread_id: thread_id.clone(),
                    terminal_id,
                }) {
                    session.status = TerminalSessionStatus::Error;
                    session.pid = None;
                    session.next_sequence = event.sequence.saturating_add(1);
                }
                self.terminal_errors.insert(ThreadId(thread_id), message);
            }
            TerminalEvent::Cleared {
                thread_id,
                terminal_id,
                ..
            } => {
                if let Some(session) = self.terminal_sessions.get_mut(&TerminalKey {
                    thread_id,
                    terminal_id,
                }) {
                    session.history.clear();
                    session.next_sequence = event.sequence.saturating_add(1);
                }
            }
            TerminalEvent::Activity { .. } => {}
            TerminalEvent::ReplayGap {
                thread_id,
                requested_after,
                earliest_available,
                ..
            } => {
                if let Some(thread_id) = thread_id {
                    self.terminal_errors.insert(
                        ThreadId(thread_id),
                        format!(
                            "Terminal event replay skipped from sequence {requested_after} to {earliest_available}."
                        ),
                    );
                }
            }
        }
    }

    pub fn new_thread(&mut self, project_id: ProjectId) -> ThreadId {
        if let Some(existing) = self.project_drafts.get(&project_id).cloned() {
            self.open_thread(existing.clone());
            return existing;
        }

        let active = self.active_thread();
        let active_draft = self
            .metadata
            .active_thread_id
            .as_ref()
            .and_then(|id| self.thread_drafts.get(id))
            .cloned();
        let options = resolve_thread_creation_options(
            project_id,
            active,
            &CreationContext {
                active_thread_id: self.metadata.active_thread_id.clone(),
                active_draft,
                default_env_mode: ExecutionLocation::Local,
            },
        );

        let thread_id = ThreadId::new();
        let created_at = self.next_timestamp();
        let draft = ThreadDraft {
            thread_id: thread_id.clone(),
            project_id,
            created_at: created_at.clone(),
            runtime_mode: options.runtime_mode,
            interaction_mode: options.interaction_mode,
            branch: options.branch.clone(),
            worktree_path: options.worktree_path.clone(),
            env_mode: options.env_mode,
        };
        let thread = ThreadSummary {
            id: thread_id.clone(),
            provider_thread_id: None,
            project_id,
            title: "New chat".to_string(),
            status: ThreadStatus::Draft,
            provider: ace_core::ProviderKind::Codex,
            model: Some(DEFAULT_CODEX_MODEL.to_string()),
            pinned: false,
            archived: false,
            unseen_completion: false,
            latest_activity_at: created_at.clone(),
            latest_message_preview: None,
            pending_approvals: 0,
            pending_user_inputs: 0,
            has_actionable_plan: false,
            branch: options.branch,
            worktree_path: options.worktree_path,
        };
        self.thread_drafts.insert(thread_id.clone(), draft);
        self.project_drafts.insert(project_id, thread_id.clone());
        self.composer_drafts.insert(
            thread_id.clone(),
            ComposerDraft::empty(thread_id.clone(), created_at),
        );
        self.threads.push(thread);
        *self.thread_counts.entry(project_id).or_insert(0) += 1;
        self.project_thread_limits
            .entry(project_id)
            .and_modify(|limit| *limit = (*limit + 1).max(INITIAL_PROJECT_THREAD_LIMIT))
            .or_insert(INITIAL_PROJECT_THREAD_LIMIT);
        self.open_thread(thread_id.clone());
        thread_id
    }

    pub fn new_thread_for_first_project(&mut self) {
        if let Some(project_id) = self.projects.first().map(|project| project.id) {
            self.new_thread(project_id);
        }
    }

    pub fn open_thread(&mut self, thread_id: ThreadId) {
        self.hydrate_thread_messages(&thread_id);
        self.metadata.active_thread_id = Some(thread_id.clone());
        self.metadata.unseen_completed_thread_ids.remove(&thread_id);
    }

    pub fn send_message(&mut self, thread_id: ThreadId, payload: ComposerPayload) {
        let now = self.next_timestamp();
        let trimmed = payload.prompt.trim();
        if trimmed.is_empty() {
            return;
        }

        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id && !thread.archived)
        {
            thread.status = if self.host.is_some() {
                ThreadStatus::Working
            } else {
                ThreadStatus::Completed
            };
            thread.latest_activity_at = now.clone();
            thread.latest_message_preview = Some(trimmed.to_string());
            if thread.title == "New chat" {
                thread.title = title_from_prompt(trimmed);
            }
        }

        self.persisted_messages
            .entry(thread_id.clone())
            .or_default()
            .push(chat_message(
                format!("{now}-user"),
                ChatMessageRole::User,
                trimmed.to_string(),
            ));

        let turn_result = self.start_backend_turn(&thread_id, trimmed);
        match turn_result {
            Ok(()) => self.append_recent_provider_messages(&thread_id),
            Err(message) => {
                self.mark_thread_status(&thread_id, ThreadStatus::Error);
                self.persisted_messages
                    .entry(thread_id.clone())
                    .or_default()
                    .push(chat_message(
                        format!("{now}-error"),
                        ChatMessageRole::Assistant,
                        message,
                    ));
            }
        }

        self.project_drafts.retain(|_, id| id != &thread_id);
        self.thread_drafts.remove(&thread_id);
        self.composer_drafts.insert(
            thread_id.clone(),
            ComposerDraft {
                thread_id,
                prompt: String::new(),
                model_selection: Default::default(),
                runtime_mode: RuntimeMode::Normal,
                interaction_mode: InteractionMode::Chat,
                image_paths: Vec::new(),
                terminal_contexts: Vec::new(),
                updated_at: now,
            },
        );
    }

    fn start_backend_turn(&mut self, thread_id: &ThreadId, prompt: &str) -> Result<(), String> {
        let Some(host) = self.host.clone() else {
            return Ok(());
        };
        let provider_thread_id = self.ensure_provider_thread(&host, thread_id)?;
        let payload = serde_json::json!({
            "thread_id": provider_thread_id,
            "input": [{ "type": "text", "text": prompt }],
            "model": DEFAULT_CODEX_MODEL,
        });
        host.call::<_, serde_json::Value>(methods::CODEX_TURN_START, &payload)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn ensure_provider_thread(
        &mut self,
        host: &BackendHostClient,
        thread_id: &ThreadId,
    ) -> Result<String, String> {
        if let Some(provider_thread_id) = self
            .threads
            .iter()
            .find(|thread| thread.id == *thread_id)
            .and_then(|thread| thread.provider_thread_id.clone())
        {
            return Ok(provider_thread_id);
        }

        let cwd = self
            .threads
            .iter()
            .find(|thread| thread.id == *thread_id)
            .and_then(|thread| {
                self.projects
                    .iter()
                    .find(|project| project.id == thread.project_id)
                    .map(|project| project.workspace_root.clone())
            });
        let response = host
            .call::<_, serde_json::Value>(
                methods::CODEX_THREAD_START,
                &serde_json::json!({
                    "cwd": cwd,
                    "model": DEFAULT_CODEX_MODEL,
                }),
            )
            .map_err(|error| error.to_string())?;
        let provider_thread_id = extract_thread_id(&response)
            .ok_or_else(|| "codex thread start response did not include thread id".to_string())?;
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == *thread_id)
        {
            thread.provider_thread_id = Some(provider_thread_id.clone());
        }
        Ok(provider_thread_id)
    }

    fn append_recent_provider_messages(&mut self, thread_id: &ThreadId) {
        let Some(host) = &self.host else {
            let now = self.next_timestamp();
            self.persisted_messages
                .entry(thread_id.clone())
                .or_default()
                .push(chat_message(
                    format!("{now}-assistant"),
                    ChatMessageRole::Assistant,
                    "Message received. Provider runtime is not connected in this build."
                        .to_string(),
                ));
            return;
        };
        let request = ProviderRuntimeRecentEventsRequest {
            provider: None,
            from_sequence_exclusive: None,
            limit: 100,
            raw_event_mode: ProviderRuntimeRawEventMode::Compact,
        };
        let Ok(response) = host.call::<_, ProviderRuntimeRecentEventsResponse>(
            methods::PROVIDER_RUNTIME_EVENTS_RECENT,
            &request,
        ) else {
            return;
        };
        for record in response.records {
            self.apply_provider_runtime_event(record.event, Some(record.sequence));
        }
    }

    pub fn apply_provider_runtime_event_batch(&mut self, batch: ProviderRuntimeEventBatch) {
        for event in batch.events {
            self.apply_provider_runtime_event(event, batch.last_persisted_sequence);
        }
    }

    fn apply_provider_runtime_event(&mut self, event: ProviderRuntimeEvent, sequence: Option<i64>) {
        let ProviderRuntimeEvent::ThreadItem { item } = event else {
            return;
        };
        let Some(thread_id) = item
            .thread_id
            .as_deref()
            .and_then(|id| self.local_thread_id_for_provider(id))
        else {
            return;
        };
        if item.kind == ThreadItemKind::UserMessage {
            return;
        }
        let Some(text) = item.text.clone().filter(|text| !text.trim().is_empty()) else {
            return;
        };
        let id = item
            .item_id
            .clone()
            .unwrap_or_else(|| format!("provider-{}", sequence.unwrap_or_default()));
        let messages = self
            .persisted_messages
            .entry(thread_id.clone())
            .or_default();
        if let Some(message) = messages.iter_mut().find(|message| message.id == id) {
            message.text = Some(text);
            message.status = item.status;
            return;
        }
        messages.push(ChatMessageProjection {
            id,
            role: chat_role_from_thread_item(item.kind),
            status: item.status,
            title: item.title.clone(),
            text: Some(text),
        });
        self.mark_thread_status(&thread_id, ThreadStatus::Working);
    }

    fn local_thread_id_for_provider(&self, id: &str) -> Option<ThreadId> {
        self.threads
            .iter()
            .find(|thread| thread.id.0 == id || thread.provider_thread_id.as_deref() == Some(id))
            .map(|thread| thread.id.clone())
    }

    fn mark_thread_status(&mut self, thread_id: &ThreadId, status: ThreadStatus) {
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == *thread_id)
        {
            thread.status = status;
        }
    }

    pub fn push_active_composer_input(&mut self, input: &str) {
        let Some(thread_id) = self.ensure_active_thread() else {
            return;
        };
        let now = self.next_timestamp();
        let draft = self
            .composer_drafts
            .entry(thread_id.clone())
            .or_insert_with(|| ComposerDraft::empty(thread_id.clone(), now.clone()));
        draft.prompt.push_str(input);
        draft.updated_at = now;
    }

    pub fn pop_active_composer_input(&mut self) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let now = self.next_timestamp();
        if let Some(draft) = self.composer_drafts.get_mut(&thread_id) {
            draft.prompt.pop();
            draft.updated_at = now;
        }
    }

    fn ensure_active_thread(&mut self) -> Option<ThreadId> {
        if let Some(thread_id) = self.metadata.active_thread_id.clone() {
            return Some(thread_id);
        }
        let project_id = self.projects.first().map(|project| project.id)?;
        Some(self.new_thread(project_id))
    }

    pub fn send_active_composer(&mut self) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let prompt = self
            .composer_drafts
            .get(&thread_id)
            .map(|draft| draft.prompt.clone())
            .unwrap_or_else(|| "Continue".to_string());
        self.send_message(thread_id, ComposerPayload { prompt });
    }

    pub fn interrupt_turn(&mut self, thread_id: ThreadId) {
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
        {
            thread.status = ThreadStatus::Idle;
            thread.latest_message_preview = Some("Interrupted".to_string());
        }
    }

    pub fn interrupt_active_turn(&mut self) {
        if let Some(thread_id) = self.metadata.active_thread_id.clone() {
            self.interrupt_turn(thread_id);
        }
    }

    #[allow(dead_code)]
    pub fn rename_thread(&mut self, thread_id: ThreadId, name: String) {
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
        {
            thread.title = name;
        }
    }

    pub fn archive_thread(&mut self, thread_id: ThreadId) {
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
        {
            thread.archived = true;
            thread.status = ThreadStatus::Archived;
        }
        self.metadata.archived_thread_ids.insert(thread_id.clone());
        if self.metadata.active_thread_id.as_ref() == Some(&thread_id) {
            self.metadata.active_thread_id = self
                .threads
                .iter()
                .find(|thread| !thread.archived)
                .map(|thread| thread.id.clone());
        }
    }

    pub fn archive_active_thread(&mut self) {
        if let Some(thread_id) = self.metadata.active_thread_id.clone() {
            self.archive_thread(thread_id);
        }
    }

    #[allow(dead_code)]
    pub fn delete_thread(&mut self, thread_id: ThreadId) {
        self.threads.retain(|thread| thread.id != thread_id);
        self.composer_drafts.remove(&thread_id);
        self.persisted_messages.remove(&thread_id);
        self.thread_drafts.remove(&thread_id);
        self.project_drafts.retain(|_, id| id != &thread_id);
        self.metadata.pinned_thread_ids.remove(&thread_id);
        self.metadata.archived_thread_ids.remove(&thread_id);
        if self.metadata.active_thread_id.as_ref() == Some(&thread_id) {
            self.metadata.active_thread_id = self.threads.first().map(|thread| thread.id.clone());
        }
    }

    pub fn pin_thread(&mut self, thread_id: ThreadId, pinned: bool) {
        if pinned {
            self.metadata.pinned_thread_ids.insert(thread_id.clone());
        } else {
            self.metadata.pinned_thread_ids.remove(&thread_id);
        }
        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
        {
            thread.pinned = pinned;
        }
    }

    pub fn toggle_pin_active_thread(&mut self) {
        if let Some(thread_id) = self.metadata.active_thread_id.clone() {
            let pinned = !self.metadata.pinned_thread_ids.contains(&thread_id);
            self.pin_thread(thread_id, pinned);
        }
    }

    pub fn add_project(&mut self, path: String) -> ProjectId {
        if let Some(existing) = self
            .projects
            .iter()
            .find(|project| project.workspace_root == path && project.deleted_at.is_none())
        {
            return existing.id;
        }

        let project_id = ProjectId::new();
        let name = path
            .rsplit('/')
            .find(|segment| !segment.is_empty())
            .unwrap_or("Project")
            .to_string();
        let now = self.next_timestamp();
        self.projects.push(Project {
            id: project_id,
            title: name,
            workspace_root: path,
            default_model_selection: None,
            scripts: Vec::new(),
            icon: None,
            created_at: now.clone(),
            updated_at: now,
            archived_at: None,
            deleted_at: None,
        });
        self.thread_counts.insert(project_id, 0);
        self.project_thread_limits
            .insert(project_id, INITIAL_PROJECT_THREAD_LIMIT);
        project_id
    }

    pub fn add_current_directory_project(
        &mut self,
        host: Option<&BackendHostClient>,
    ) -> Option<ProjectId> {
        let path = std::env::current_dir()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());
        let project_id = if let Some(host) = host {
            match host.request::<ProjectsAdd>(&ProjectAddRequest {
                workspace_root: path,
                title: None,
                default_model_selection: None,
            }) {
                Ok(result) => {
                    let project_id = result.project.id;
                    self.upsert_project(result.project);
                    project_id
                }
                Err(error) => {
                    tracing::warn!(%error, "failed to add project through backend host");
                    return None;
                }
            }
        } else {
            self.add_project(path)
        };
        self.new_thread(project_id);
        Some(project_id)
    }

    #[allow(dead_code)]
    pub fn rename_project(&mut self, project_id: ProjectId, name: String) {
        if let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.title = name;
        }
    }

    pub fn archive_or_delete_project(
        &mut self,
        project_id: ProjectId,
        host: Option<&BackendHostClient>,
    ) {
        if let Some(host) = host
            && let Err(error) = host.request::<ProjectsDelete>(&ProjectDeleteRequest { project_id })
        {
            tracing::warn!(%error, "failed to delete project through backend host");
            return;
        }
        let now = self.next_timestamp();
        if let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.archived_at = Some(now);
        }
        self.threads
            .retain(|thread| thread.project_id != project_id);
        self.thread_counts.remove(&project_id);
        self.project_thread_limits.remove(&project_id);
        self.project_drafts.remove(&project_id);
        self.thread_drafts
            .retain(|_, draft| draft.project_id != project_id);
        self.composer_drafts
            .retain(|thread_id, _| self.threads.iter().any(|thread| &thread.id == thread_id));
        self.persisted_messages
            .retain(|thread_id, _| self.threads.iter().any(|thread| &thread.id == thread_id));
        if self
            .metadata
            .active_thread_id
            .as_ref()
            .is_some_and(|active| !self.threads.iter().any(|thread| &thread.id == active))
        {
            self.metadata.active_thread_id = self.threads.first().map(|thread| thread.id.clone());
        }
    }

    pub fn show_more_project_threads(&mut self, project_id: ProjectId) {
        let loaded = self
            .project_thread_limits
            .get(&project_id)
            .copied()
            .unwrap_or_else(|| self.loaded_project_thread_count(project_id));
        let total = self
            .thread_counts
            .get(&project_id)
            .copied()
            .unwrap_or(loaded);
        if loaded < total {
            self.load_project_threads(project_id, (loaded + PROJECT_THREAD_PAGE_SIZE).min(total));
        }
    }

    pub fn show_less_project_threads(&mut self, project_id: ProjectId) {
        self.load_project_threads(project_id, INITIAL_PROJECT_THREAD_LIMIT);
    }

    fn loaded_project_thread_count(&self, project_id: ProjectId) -> usize {
        self.threads
            .iter()
            .filter(|thread| thread.project_id == project_id)
            .count()
    }

    fn visible_sidebar_threads(&self) -> Vec<ThreadSummary> {
        let mut remaining = self.project_thread_limits.clone();
        let capacity = remaining
            .values()
            .copied()
            .sum::<usize>()
            .min(self.threads.len());
        let mut threads = Vec::with_capacity(capacity);
        for thread in &self.threads {
            let Some(limit) = remaining.get_mut(&thread.project_id) else {
                continue;
            };
            if *limit == 0 {
                continue;
            }
            threads.push(thread.clone());
            *limit -= 1;
        }
        threads
    }

    fn load_project_threads(&mut self, project_id: ProjectId, limit: usize) {
        let Some(host) = &self.host else {
            self.project_thread_limits.insert(project_id, limit);
            return;
        };
        match host.request::<ProjectsProjectThreads>(&ProjectThreadsRequest { project_id, limit }) {
            Ok(mut threads) => {
                self.threads
                    .retain(|thread| thread.project_id != project_id);
                self.threads.append(&mut threads);
                self.project_thread_limits.insert(project_id, limit);
            }
            Err(error) => tracing::warn!(%error, "failed to load project threads from backend"),
        }
    }

    fn hydrate_thread_messages(&mut self, thread_id: &ThreadId) {
        if self.persisted_messages.contains_key(thread_id) {
            return;
        }
        let Some(host) = &self.host else {
            return;
        };
        match host.request::<ProjectsThreadMessages>(&ThreadMessagesRequest {
            thread_id: thread_id.clone(),
            limit: 200,
        }) {
            Ok(response) => {
                self.persisted_messages
                    .insert(thread_id.clone(), response.messages);
            }
            Err(error) => tracing::warn!(%error, "failed to hydrate thread messages from backend"),
        }
    }

    fn active_thread(&self) -> Option<&ThreadSummary> {
        self.metadata
            .active_thread_id
            .as_ref()
            .and_then(|active| self.threads.iter().find(|thread| &thread.id == active))
    }

    fn run_active_review_git_action<F>(
        &mut self,
        host: Option<&BackendHostClient>,
        label: &'static str,
        action: F,
    ) where
        F: FnOnce(&BackendHostClient, String) -> Result<serde_json::Value, BackendError>,
    {
        let Some(thread) = self.active_thread().cloned() else {
            return;
        };
        let Some(repo_path) = self.review_repo_path(&thread) else {
            self.review_snapshots.insert(
                thread.project_id,
                ReviewProjection {
                    error: Some("No project workspace is available for this thread.".to_string()),
                    ..ReviewProjection::default()
                },
            );
            return;
        };
        let Some(host) = self.host.clone().or_else(|| host.cloned()) else {
            self.review_snapshots.insert(
                thread.project_id,
                ReviewProjection {
                    repo_path: Some(repo_path),
                    error: Some(format!("Connect to a host runtime before running {label}.")),
                    ..ReviewProjection::default()
                },
            );
            return;
        };

        match action(&host, repo_path.clone()) {
            Ok(_) => self.refresh_active_review(Some(&host)),
            Err(error) => {
                self.review_snapshots.insert(
                    thread.project_id,
                    ReviewProjection {
                        repo_path: Some(repo_path),
                        error: Some(format!("Failed to {label}: {error}")),
                        ..ReviewProjection::default()
                    },
                );
            }
        }
    }

    fn latest_active_message(&self) -> Option<(ThreadId, ChatMessageProjection)> {
        let thread_id = self.metadata.active_thread_id.clone()?;
        let message = self
            .persisted_messages
            .get(&thread_id)
            .and_then(|messages| messages.last())
            .cloned()
            .or_else(|| {
                self.runtime
                    .thread_items
                    .iter()
                    .rev()
                    .find(|item| {
                        item.thread_id.as_deref() == Some(thread_id.0.as_str())
                            || item.thread_id.is_none()
                    })
                    .map(|item| ChatMessageProjection {
                        id: item
                            .item_id
                            .clone()
                            .unwrap_or_else(|| thread_item_fallback_id(item.kind)),
                        role: chat_role_from_thread_item(item.kind),
                        status: item.status,
                        title: item.title.clone(),
                        text: item.text.clone(),
                    })
            })?;
        Some((thread_id, message))
    }

    fn message_for_thread(
        &self,
        thread_id: &ThreadId,
        message_id: &str,
    ) -> Option<ChatMessageProjection> {
        self.persisted_messages
            .get(thread_id)
            .and_then(|messages| messages.iter().find(|message| message.id == message_id))
            .cloned()
            .or_else(|| {
                self.runtime
                    .thread_items
                    .iter()
                    .rev()
                    .find(|item| {
                        let fallback;
                        let id = if let Some(id) = item.item_id.as_deref() {
                            id
                        } else {
                            fallback = thread_item_fallback_id(item.kind);
                            fallback.as_str()
                        };
                        id == message_id
                            && (item.thread_id.as_deref() == Some(thread_id.0.as_str())
                                || item.thread_id.is_none())
                    })
                    .map(|item| ChatMessageProjection {
                        id: item
                            .item_id
                            .clone()
                            .unwrap_or_else(|| thread_item_fallback_id(item.kind)),
                        role: chat_role_from_thread_item(item.kind),
                        status: item.status,
                        title: item.title.clone(),
                        text: item.text.clone(),
                    })
            })
    }

    fn active_terminal_cwd(&self, thread_id: &ThreadId) -> Option<String> {
        let thread = self.threads.iter().find(|thread| &thread.id == thread_id)?;
        thread.worktree_path.clone().or_else(|| {
            self.projects
                .iter()
                .find(|project| project.id == thread.project_id)
                .map(|project| project.workspace_root.clone())
        })
    }

    fn review_repo_path(&self, thread: &ThreadSummary) -> Option<String> {
        thread.worktree_path.clone().or_else(|| {
            self.projects
                .iter()
                .find(|project| project.id == thread.project_id)
                .map(|project| project.workspace_root.clone())
        })
    }

    fn upsert_terminal_snapshot(&mut self, snapshot: TerminalSessionSnapshot) {
        let key = TerminalKey {
            thread_id: snapshot.thread_id.clone(),
            terminal_id: snapshot.terminal_id.clone(),
        };
        let thread_id = ThreadId(snapshot.thread_id.clone());
        self.terminal_errors.remove(&thread_id);
        self.terminal_sessions
            .insert(key, TerminalSessionProjection::from_snapshot(snapshot));
    }

    fn next_timestamp(&mut self) -> String {
        let value = timestamp(self.now_counter);
        self.now_counter += 1;
        value
    }
}

impl DesktopStore {
    fn upsert_project(&mut self, project: ProjectSummary) {
        let project = project_from_summary(project);
        if let Some(existing) = self
            .projects
            .iter_mut()
            .find(|existing| existing.id == project.id)
        {
            *existing = project;
        } else {
            self.thread_counts.entry(project.id).or_insert(0);
            self.project_thread_limits
                .entry(project.id)
                .or_insert(INITIAL_PROJECT_THREAD_LIMIT);
            self.projects.push(project);
        }
    }
}

impl TerminalSessionProjection {
    fn from_snapshot(snapshot: TerminalSessionSnapshot) -> Self {
        let mut history = snapshot.history;
        trim_terminal_history(&mut history);
        Self {
            thread_id: snapshot.thread_id,
            terminal_id: snapshot.terminal_id,
            cwd: snapshot.cwd,
            title: snapshot.title,
            status: snapshot.status,
            pid: snapshot.pid,
            history,
            exit_code: snapshot.exit_code,
            exit_signal: snapshot.exit_signal,
            cols: snapshot.cols,
            rows: snapshot.rows,
            updated_at: snapshot.updated_at,
            next_sequence: snapshot.next_sequence,
            truncated_before_sequence: snapshot.truncated_before_sequence,
        }
    }

    fn placeholder(thread_id: String, terminal_id: String) -> Self {
        Self {
            thread_id,
            terminal_id,
            cwd: String::new(),
            title: None,
            status: TerminalSessionStatus::Running,
            pid: None,
            history: String::new(),
            exit_code: None,
            exit_signal: None,
            cols: DEFAULT_TERMINAL_COLS,
            rows: DEFAULT_TERMINAL_ROWS,
            updated_at: String::new(),
            next_sequence: 0,
            truncated_before_sequence: None,
        }
    }
}

fn project_from_summary(value: ProjectSummary) -> Project {
    Project {
        id: value.id,
        title: value.title,
        workspace_root: value.workspace_root,
        default_model_selection: value.default_model_selection,
        scripts: value.scripts,
        icon: value.icon,
        created_at: value.created_at,
        updated_at: value.updated_at,
        archived_at: value.archived_at,
        deleted_at: value.deleted_at,
    }
}

fn extract_thread_id(value: &serde_json::Value) -> Option<String> {
    value
        .pointer("/thread/id")
        .or_else(|| value.pointer("/thread/threadId"))
        .or_else(|| value.get("threadId"))
        .or_else(|| value.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

fn chat_role_from_thread_item(kind: ThreadItemKind) -> ChatMessageRole {
    match kind {
        ThreadItemKind::UserMessage => ChatMessageRole::User,
        ThreadItemKind::AgentMessage | ThreadItemKind::Reasoning => ChatMessageRole::Assistant,
        ThreadItemKind::Plan => ChatMessageRole::Plan,
        ThreadItemKind::CommandExecution
        | ThreadItemKind::FileChange
        | ThreadItemKind::McpToolCall
        | ThreadItemKind::DynamicToolCall
        | ThreadItemKind::CollabAgentToolCall
        | ThreadItemKind::WebSearch
        | ThreadItemKind::ImageView
        | ThreadItemKind::ImageGeneration => ChatMessageRole::Tool,
        ThreadItemKind::HookPrompt
        | ThreadItemKind::SubAgentActivity
        | ThreadItemKind::EnteredReviewMode
        | ThreadItemKind::ExitedReviewMode
        | ThreadItemKind::ContextCompaction
        | ThreadItemKind::Unknown => ChatMessageRole::Activity,
    }
}

fn thread_item_fallback_id(kind: ThreadItemKind) -> String {
    format!("thread-item:{kind:?}")
}

fn chat_message(id: String, role: ChatMessageRole, text: String) -> ChatMessageProjection {
    ChatMessageProjection {
        id,
        role,
        status: ThreadItemStatus::Completed,
        title: None,
        text: Some(text),
    }
}

fn provider_health_label(health: ProviderRuntimeHealth) -> &'static str {
    match health {
        ProviderRuntimeHealth::Ready => "ready",
        ProviderRuntimeHealth::Starting => "starting",
        ProviderRuntimeHealth::Running => "running",
        ProviderRuntimeHealth::Stopped => "stopped",
        ProviderRuntimeHealth::Unavailable => "unavailable",
        ProviderRuntimeHealth::Degraded => "degraded",
        ProviderRuntimeHealth::Unknown => "unknown",
    }
}

fn runtime_status_projection_from_state(
    response: &ProviderRuntimeStateGetResponse,
    provider_count: usize,
    updated_at: String,
) -> RuntimeStatusProjection {
    let mut projection = RuntimeStatusProjection {
        providers: response.providers.len().max(provider_count),
        updated_at: Some(updated_at),
        ..RuntimeStatusProjection::default()
    };

    for provider in &response.providers {
        let summary = &provider.summary;
        projection.threads += summary.threads;
        projection.active_threads += summary.active_threads;
        projection.active_turns += summary.active_turns;
        projection.handoffs += summary.handoffs;
        projection.pending_approvals += summary.pending_approvals;
        projection.warnings += summary.warnings;
        projection.remote_connections += summary.remote_connections;
        projection.remote_host_connections += summary.remote_host_connections;
        projection.connected_remote_connections += summary.connected_remote_connections;
        projection.disconnected_remote_connections += summary.disconnected_remote_connections;
        projection.remote_connections_with_projects += summary.remote_connections_with_projects;
    }

    projection
}

fn short_status(status: &TerminalSessionStatus) -> &'static str {
    match status {
        TerminalSessionStatus::Starting => "starting",
        TerminalSessionStatus::Running => "running",
        TerminalSessionStatus::Exited => "exited",
        TerminalSessionStatus::Error => "error",
    }
}

fn title_from_prompt(prompt: &str) -> String {
    let mut title = prompt
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ");
    if title.len() > 54 {
        title.truncate(54);
    }
    title
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_millis() as u64
}

fn timestamp(value: u64) -> String {
    value.to_string()
}

fn append_terminal_history(history: &mut String, data: &str) {
    history.push_str(data);
    trim_terminal_history(history);
}

fn trim_terminal_history(history: &mut String) {
    if history.len() <= DESKTOP_TERMINAL_HISTORY_LIMIT {
        return;
    }

    let trim_to = history.len() - DESKTOP_TERMINAL_HISTORY_LIMIT;
    let split = history[trim_to..]
        .find('\n')
        .map(|offset| trim_to + offset + 1)
        .unwrap_or(trim_to);
    history.drain(..split);
}

fn parse_review_files(value: serde_json::Value) -> Vec<ReviewFileProjection> {
    value
        .as_array()
        .map(|files| {
            files
                .iter()
                .filter_map(|file| {
                    let path = file.get("path")?.as_str()?.to_string();
                    Some(ReviewFileProjection {
                        path,
                        original_path: file
                            .get("original_path")
                            .and_then(serde_json::Value::as_str)
                            .map(ToString::to_string),
                        status: file
                            .get("status")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown")
                            .to_string(),
                        additions: file
                            .get("additions")
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|value| u32::try_from(value).ok()),
                        deletions: file
                            .get("deletions")
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|value| u32::try_from(value).ok()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy)]
enum RegistrySurface {
    Plugin,
    Skill,
}

fn parse_tool_registry_entries(
    value: serde_json::Value,
    surface: RegistrySurface,
) -> Vec<ToolRegistryEntryProjection> {
    let mut entries = Vec::new();
    collect_tool_registry_entries(&value, surface, &mut entries);
    let mut unique = Vec::new();
    for entry in entries {
        if !unique
            .iter()
            .any(|existing: &ToolRegistryEntryProjection| existing.id == entry.id)
        {
            unique.push(entry);
        }
    }
    unique
}

fn collect_tool_registry_entries(
    value: &serde_json::Value,
    surface: RegistrySurface,
    entries: &mut Vec<ToolRegistryEntryProjection>,
) {
    match value {
        serde_json::Value::Array(items) => {
            entries.extend(
                items
                    .iter()
                    .filter_map(|item| parse_tool_registry_entry(item, surface, None)),
            );
        }
        serde_json::Value::Object(object) => {
            for key in registry_list_keys(surface) {
                if let Some(nested) = object.get(*key) {
                    collect_tool_registry_entries(nested, surface, entries);
                    return;
                }
            }
            if let Some(entry) = parse_tool_registry_entry(value, surface, None) {
                entries.push(entry);
                return;
            }
            entries.extend(object.iter().filter_map(|(key, nested)| {
                parse_tool_registry_entry(nested, surface, Some(key.as_str()))
            }));
        }
        serde_json::Value::String(name) => {
            entries.push(simple_tool_registry_entry(name, surface));
        }
        _ => {}
    }
}

fn registry_list_keys(surface: RegistrySurface) -> &'static [&'static str] {
    match surface {
        RegistrySurface::Plugin => &[
            "plugins",
            "installed_plugins",
            "installedPlugins",
            "installed",
            "items",
            "entries",
            "results",
        ],
        RegistrySurface::Skill => &[
            "skills",
            "installed_skills",
            "installedSkills",
            "items",
            "entries",
            "results",
        ],
    }
}

fn parse_tool_registry_entry(
    value: &serde_json::Value,
    surface: RegistrySurface,
    fallback_id: Option<&str>,
) -> Option<ToolRegistryEntryProjection> {
    match value {
        serde_json::Value::String(name) => Some(simple_tool_registry_entry(name, surface)),
        serde_json::Value::Object(object) => {
            let name = string_field(
                object,
                match surface {
                    RegistrySurface::Plugin => &[
                        "display_name",
                        "displayName",
                        "name",
                        "title",
                        "plugin",
                        "id",
                    ],
                    RegistrySurface::Skill => &[
                        "display_name",
                        "displayName",
                        "name",
                        "title",
                        "skill",
                        "id",
                    ],
                },
            )
            .or_else(|| fallback_id.map(ToString::to_string))?;
            let id = string_field(object, &["id", "slug", "key"])
                .or_else(|| fallback_id.map(ToString::to_string))
                .unwrap_or_else(|| name.clone());
            let enabled = object.get("enabled").and_then(serde_json::Value::as_bool);
            let status =
                string_field(object, &["status", "state", "health"]).unwrap_or_else(|| {
                    enabled.map_or_else(
                        || "available".to_string(),
                        |enabled| {
                            if enabled {
                                "enabled".to_string()
                            } else {
                                "disabled".to_string()
                            }
                        },
                    )
                });

            Some(ToolRegistryEntryProjection {
                id,
                name,
                description: string_field(object, &["description", "summary"]),
                version: string_field(object, &["version"]),
                source: string_field(object, &["source", "origin"]),
                status,
                enabled,
            })
        }
        _ => None,
    }
}

fn simple_tool_registry_entry(
    name: &str,
    _surface: RegistrySurface,
) -> ToolRegistryEntryProjection {
    ToolRegistryEntryProjection {
        id: name.to_string(),
        name: name.to_string(),
        description: None,
        version: None,
        source: None,
        status: "available".to_string(),
        enabled: None,
    }
}

fn string_field(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
        .map(ToString::to_string)
}

fn truncate_diff_preview(diff: &str) -> (String, bool) {
    if diff.len() <= DESKTOP_DIFF_PREVIEW_LIMIT {
        return (diff.to_string(), false);
    }

    let mut end = DESKTOP_DIFF_PREVIEW_LIMIT;
    while !diff.is_char_boundary(end) {
        end -= 1;
    }
    (diff[..end].to_string(), true)
}

fn generated_review_commit_message(review: &ReviewProjection) -> String {
    match review.files.as_slice() {
        [] => "Update project".to_string(),
        [file] => format!("Update {}", file.path),
        files => format!("Update {} files", files.len()),
    }
}

fn message_excerpt(message: &ChatMessageProjection) -> String {
    let raw = message
        .text
        .as_deref()
        .or(message.title.as_deref())
        .unwrap_or_default()
        .trim();
    if raw.len() <= 160 {
        return raw.to_string();
    }

    let mut end = 160;
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &raw[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_thread_reuses_existing_project_draft() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let first = store.new_thread(project_id);
        let second = store.new_thread(project_id);
        assert_eq!(first, second);
        assert_eq!(store.project_drafts.get(&project_id), Some(&first));
    }

    #[test]
    fn first_send_promotes_draft_thread() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Port the project sidebar".to_string(),
            },
        );
        let thread = store
            .threads
            .iter()
            .find(|thread| thread.id == thread_id)
            .expect("thread");
        assert_eq!(thread.status, ThreadStatus::Completed);
        assert!(thread.provider_thread_id.is_none());
        assert!(!store.project_drafts.contains_key(&project_id));
        assert!(!store.thread_drafts.contains_key(&thread_id));
    }

    #[test]
    fn pin_and_archive_update_sidebar_projection() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let active = store.new_thread(project_id);
        store.pin_thread(active.clone(), true);
        assert!(store.metadata.pinned_thread_ids.contains(&active));
        store.archive_thread(active.clone());
        assert!(store.metadata.archived_thread_ids.contains(&active));
        assert_ne!(store.metadata.active_thread_id, Some(active));
    }

    #[test]
    fn add_project_deduplicates_workspace_root() {
        let mut store = DesktopStore::new();
        let first = store.add_project("/tmp/project".to_string());
        let second = store.add_project("/tmp/project".to_string());
        assert_eq!(first, second);
        assert_eq!(store.projects.len(), 1);
    }

    #[test]
    fn tool_registry_parser_reads_common_shapes() {
        let plugins = parse_tool_registry_entries(
            serde_json::json!({
                "installedPlugins": [
                    {
                        "id": "browser",
                        "displayName": "Browser",
                        "description": "Chromium control",
                        "version": "1.2.3",
                        "source": "builtin",
                        "enabled": true
                    },
                    "browser"
                ]
            }),
            RegistrySurface::Plugin,
        );
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "browser");
        assert_eq!(plugins[0].name, "Browser");
        assert_eq!(plugins[0].status, "enabled");

        let skills = parse_tool_registry_entries(
            serde_json::json!({
                "rust": {
                    "description": "Rust workflow context",
                    "state": "installed"
                }
            }),
            RegistrySurface::Skill,
        );
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "rust");
        assert_eq!(skills[0].name, "rust");
        assert_eq!(skills[0].status, "installed");
    }

    #[test]
    fn runtime_status_projection_aggregates_provider_state() {
        let response = ProviderRuntimeStateGetResponse {
            providers: vec![
                ace_protocol::provider_runtime::ProviderRuntimeProviderState {
                    provider: ace_core::ProviderKind::Codex,
                    runtime_id: "codex".to_string(),
                    display_name: "Codex".to_string(),
                    source: ace_protocol::provider_runtime::ProviderRuntimeStateSource::Live,
                    persisted_replay_available: false,
                    last_persisted_sequence: None,
                    summary: ace_protocol::provider_runtime::ProviderRuntimeStateSummary {
                        threads: 8,
                        active_threads: 3,
                        active_turns: 2,
                        handoffs: 4,
                        pending_approvals: 1,
                        warnings: 5,
                        remote_connections: 6,
                        remote_host_connections: 2,
                        connected_remote_connections: 3,
                        disconnected_remote_connections: 1,
                        remote_connections_with_projects: 4,
                        ..ace_protocol::provider_runtime::ProviderRuntimeStateSummary::default()
                    },
                    state: AgentRuntimeSnapshot::default(),
                },
            ],
        };

        let projection = runtime_status_projection_from_state(&response, 2, "updated".to_string());

        assert_eq!(projection.providers, 2);
        assert_eq!(projection.threads, 8);
        assert_eq!(projection.active_threads, 3);
        assert_eq!(projection.active_turns, 2);
        assert_eq!(projection.handoffs, 4);
        assert_eq!(projection.pending_approvals, 1);
        assert_eq!(projection.remote_connections, 6);
        assert_eq!(projection.remote_host_connections, 2);
        assert_eq!(projection.connected_remote_connections, 3);
        assert_eq!(projection.disconnected_remote_connections, 1);
        assert_eq!(projection.remote_connections_with_projects, 4);
        assert_eq!(projection.updated_at.as_deref(), Some("updated"));
    }

    #[test]
    fn service_readiness_marks_host_services_missing_without_backend() {
        let store = DesktopStore::new();
        let services = store.service_readiness();

        assert!(!services.host_connected);
        assert!(!services.terminal.is_ready());
        assert!(!services.diff_review.is_ready());
        assert!(!services.browser.is_ready());
        assert!(services.summary.is_ready());
    }

    #[test]
    fn terminal_events_update_active_projection() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        let snapshot = TerminalSessionSnapshot {
            thread_id: thread_id.0.clone(),
            terminal_id: DEFAULT_TERMINAL_ID.to_string(),
            cwd: "/tmp/project".to_string(),
            title: None,
            status: TerminalSessionStatus::Running,
            pid: Some(42),
            history: String::new(),
            exit_code: None,
            exit_signal: None,
            cols: 120,
            rows: 32,
            updated_at: "now".to_string(),
            next_sequence: 2,
            truncated_before_sequence: None,
        };
        store.apply_terminal_event(SequencedTerminalEvent {
            sequence: 1,
            event: TerminalEvent::Started {
                thread_id: thread_id.0.clone(),
                terminal_id: DEFAULT_TERMINAL_ID.to_string(),
                created_at: "now".to_string(),
                snapshot,
            },
        });
        store.apply_terminal_event(SequencedTerminalEvent {
            sequence: 2,
            event: TerminalEvent::Output {
                thread_id: thread_id.0.clone(),
                terminal_id: DEFAULT_TERMINAL_ID.to_string(),
                created_at: "now".to_string(),
                data: "hello\n".to_string(),
            },
        });

        let terminal = store.projection().terminal;
        let session = terminal.session.expect("terminal session");
        assert_eq!(session.status, TerminalSessionStatus::Running);
        assert_eq!(session.pid, Some(42));
        assert_eq!(session.history, "hello\n");
        assert_eq!(session.next_sequence, 3);
    }

    #[test]
    fn sources_projection_reads_review_terminal_and_annotations() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.review_snapshots.insert(
            project_id,
            ReviewProjection {
                repo_path: Some("/tmp/project".to_string()),
                files: vec![ReviewFileProjection {
                    path: "src/lib.rs".to_string(),
                    original_path: None,
                    status: "modified".to_string(),
                    additions: Some(2),
                    deletions: Some(1),
                }],
                diff_preview: String::new(),
                diff_truncated: false,
                total_additions: 2,
                total_deletions: 1,
                error: None,
                updated_at: Some("reviewed".to_string()),
            },
        );
        store.apply_terminal_event(SequencedTerminalEvent {
            sequence: 1,
            event: TerminalEvent::Started {
                thread_id: thread_id.0.clone(),
                terminal_id: DEFAULT_TERMINAL_ID.to_string(),
                created_at: "now".to_string(),
                snapshot: TerminalSessionSnapshot {
                    thread_id: thread_id.0.clone(),
                    terminal_id: DEFAULT_TERMINAL_ID.to_string(),
                    cwd: "/tmp/project".to_string(),
                    title: None,
                    status: TerminalSessionStatus::Running,
                    pid: Some(42),
                    history: String::new(),
                    exit_code: None,
                    exit_signal: None,
                    cols: 120,
                    rows: 32,
                    updated_at: "terminal".to_string(),
                    next_sequence: 2,
                    truncated_before_sequence: None,
                },
            },
        });
        store.send_message(
            thread_id,
            ComposerPayload {
                prompt: "Keep this context".to_string(),
            },
        );
        store.pin_latest_timeline_item();

        let sources = store.projection().sources;
        assert_eq!(sources.changed_files, 1);
        assert_eq!(sources.terminal_sessions, 1);
        assert_eq!(sources.context_items, 1);
        assert!(sources.items.iter().any(|item| item.kind == "file"));
        assert!(sources.items.iter().any(|item| item.kind == "terminal"));
        assert!(sources.items.iter().any(|item| item.kind == "pinned"));
    }

    #[test]
    fn review_file_parser_reads_git_changed_file_json() {
        let files = parse_review_files(serde_json::json!([
            {
                "path": "src/lib.rs",
                "original_path": null,
                "status": "modified",
                "additions": 3,
                "deletions": 1
            },
            {
                "path": "new.rs",
                "original_path": "old.rs",
                "status": "renamed",
                "additions": null,
                "deletions": null
            }
        ]));

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/lib.rs");
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].additions, Some(3));
        assert_eq!(files[0].deletions, Some(1));
        assert_eq!(files[1].original_path.as_deref(), Some("old.rs"));
    }

    #[test]
    fn generated_review_commit_message_describes_changed_files() {
        let empty = ReviewProjection::default();
        assert_eq!(generated_review_commit_message(&empty), "Update project");

        let single = ReviewProjection {
            files: vec![ReviewFileProjection {
                path: "src/lib.rs".to_string(),
                original_path: None,
                status: "modified".to_string(),
                additions: Some(1),
                deletions: Some(0),
            }],
            ..ReviewProjection::default()
        };
        assert_eq!(
            generated_review_commit_message(&single),
            "Update src/lib.rs"
        );

        let many = ReviewProjection {
            files: vec![
                ReviewFileProjection {
                    path: "src/lib.rs".to_string(),
                    original_path: None,
                    status: "modified".to_string(),
                    additions: Some(1),
                    deletions: Some(0),
                },
                ReviewFileProjection {
                    path: "src/main.rs".to_string(),
                    original_path: None,
                    status: "modified".to_string(),
                    additions: Some(2),
                    deletions: Some(1),
                },
            ],
            ..ReviewProjection::default()
        };
        assert_eq!(generated_review_commit_message(&many), "Update 2 files");
    }

    #[test]
    fn diff_preview_truncates_on_utf8_boundary() {
        let diff = format!("{}é", "a".repeat(DESKTOP_DIFF_PREVIEW_LIMIT));
        let (preview, truncated) = truncate_diff_preview(&diff);

        assert!(truncated);
        assert!(preview.len() <= DESKTOP_DIFF_PREVIEW_LIMIT);
        assert!(std::str::from_utf8(preview.as_bytes()).is_ok());
    }

    #[test]
    fn annotations_create_from_latest_message_and_restore() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Capture the deployment follow-up".to_string(),
            },
        );
        let first_message_id = store.projection().chat.messages[0].id.clone();
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Second message should stay latest".to_string(),
            },
        );

        store.pin_timeline_item(thread_id.clone(), &first_message_id);
        store.toggle_highlight_timeline_item(thread_id.clone(), &first_message_id);
        store.create_todo_from_timeline_item(thread_id.clone(), &first_message_id);
        let projection = store.projection().annotations;
        assert_eq!(projection.pinned_items.len(), 1);
        assert_eq!(projection.highlighted_items.len(), 1);
        assert_eq!(projection.todos.len(), 1);
        assert_eq!(projection.open_todo_count, 1);
        assert_eq!(projection.pinned_items[0].message_id, first_message_id);
        let todo_id = projection.todos[0].id.clone();

        store.update_todo_status(&todo_id, TodoStatus::InProgress);
        let projection = store.projection().annotations;
        assert_eq!(projection.todos[0].status, TodoStatus::InProgress);
        assert_eq!(projection.open_todo_count, 1);
        assert!(projection.todos[0].completed_at.is_none());

        store.update_todo_status(&todo_id, TodoStatus::Done);
        let projection = store.projection().annotations;
        assert_eq!(projection.todos[0].status, TodoStatus::Done);
        assert_eq!(projection.open_todo_count, 0);
        assert!(projection.todos[0].completed_at.is_some());

        store.update_todo_status(&todo_id, TodoStatus::Open);
        let projection = store.projection().annotations;
        assert_eq!(projection.todos[0].status, TodoStatus::Open);
        assert_eq!(projection.open_todo_count, 1);
        assert!(projection.todos[0].completed_at.is_none());

        store.toggle_highlight_timeline_item(thread_id.clone(), &first_message_id);
        assert!(store.projection().annotations.highlighted_items.is_empty());
        store.toggle_highlight_timeline_item(thread_id.clone(), &first_message_id);

        store.toggle_first_open_todo();
        let snapshot = store.annotations_snapshot();
        let mut restored = DesktopStore::new();
        restored.add_project("/tmp/project".to_string());
        restored.open_thread(thread_id);
        restored.restore_annotations(snapshot);
        let projection = restored.projection().annotations;
        assert_eq!(projection.pinned_items.len(), 1);
        assert_eq!(projection.highlighted_items.len(), 1);
        assert_eq!(projection.todos[0].status, TodoStatus::Done);
    }

    #[test]
    fn archiving_project_removes_its_threads_from_sidebar() {
        let mut store = DesktopStore::new();
        let first_project = store.add_project("/tmp/first".to_string());
        let second_project = store.add_project("/tmp/second".to_string());
        let archived_thread = store.new_thread(first_project);
        let remaining_thread = store.new_thread(second_project);

        store.archive_or_delete_project(first_project, None);

        let projection = store.projection();
        assert!(
            !store
                .threads
                .iter()
                .any(|thread| thread.id == archived_thread)
        );
        assert!(
            store
                .threads
                .iter()
                .any(|thread| thread.id == remaining_thread)
        );
        assert_eq!(projection.sidebar.total_thread_count, 1);
        assert_eq!(
            projection.sidebar.active_thread_id.as_ref(),
            Some(&remaining_thread)
        );
    }

    #[test]
    fn sending_active_composer_projects_local_messages() {
        let mut store = DesktopStore::new();
        store.add_project("/tmp/project".to_string());
        store.push_active_composer_input("hello");

        let projection = store.projection();
        assert_eq!(projection.chat.composer.unwrap().prompt, "hello");

        store.send_active_composer();
        let messages = store.projection().chat.messages;
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, ChatMessageRole::User);
        assert_eq!(messages[0].text.as_deref(), Some("hello"));
        assert_eq!(messages[1].role, ChatMessageRole::Assistant);
    }

    #[test]
    fn sidebar_projection_pages_loaded_threads() {
        let project_id = ProjectId::new();
        let project = Project {
            id: project_id,
            title: "Project".to_string(),
            workspace_root: "/tmp/project".to_string(),
            default_model_selection: None,
            scripts: Vec::new(),
            icon: None,
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            archived_at: None,
            deleted_at: None,
        };
        let threads = (0..12)
            .map(|index| ThreadSummary {
                id: ThreadId::new(),
                provider_thread_id: None,
                project_id,
                title: format!("Thread {index}"),
                status: ThreadStatus::Idle,
                provider: ace_core::ProviderKind::Codex,
                model: None,
                pinned: false,
                archived: false,
                unseen_completion: false,
                latest_activity_at: index.to_string(),
                latest_message_preview: None,
                pending_approvals: 0,
                pending_user_inputs: 0,
                has_actionable_plan: false,
                branch: None,
                worktree_path: None,
            })
            .collect::<Vec<_>>();

        let mut store = DesktopStore::new();
        store.replace_snapshot(
            vec![project],
            threads,
            HashMap::from([(project_id, 12usize)]),
        );
        assert_eq!(store.projection().sidebar.projects[0].threads.len(), 5);

        store.show_more_project_threads(project_id);
        assert_eq!(store.projection().sidebar.projects[0].threads.len(), 10);

        store.show_less_project_threads(project_id);
        assert_eq!(store.projection().sidebar.projects[0].threads.len(), 5);
    }
}
