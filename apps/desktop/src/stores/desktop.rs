use crate::backend::{
    BackendError, BackendHostClient, ProjectsAdd, ProjectsDelete, ProjectsProjectThreads,
    ProjectsSnapshot, ProjectsThreadMessages,
};
use ace_core::{ModelSelection, Project, ProjectId, ProjectScript, ProviderKind, ThreadId};
use ace_project::ProjectSummary;
use ace_protocol::{
    git::{
        GitChangedFilesRequest, GitCommitRequest, GitDiffRequest, GitPushRequest, GitStageRequest,
        GitUnstageRequest, GitWorktreeCreateRequest, GitWorktreeRemoveRequest, GitWorktreesRequest,
    },
    project::{
        ProjectAddRequest, ProjectDeleteRequest, ProjectSnapshotRequest, ProjectThreadsRequest,
        ProjectUpdateRequest, ThreadMessagesRequest,
    },
    provider_runtime::{
        ProviderHostToolBridgeStatus, ProviderHostToolsListResponse, ProviderRuntimeEvent,
        ProviderRuntimeEventBatch, ProviderRuntimeModelsListRequest,
        ProviderRuntimeModelsListResponse, ProviderRuntimeProviderInfo,
        ProviderRuntimeProvidersList, ProviderRuntimeRawEventMode,
        ProviderRuntimeRecentEventsRequest, ProviderRuntimeRecentEventsResponse,
        ProviderRuntimeSlashCommandsListRequest, ProviderRuntimeSlashCommandsListResponse,
        ProviderRuntimeStateGetRequest, ProviderRuntimeStateGetResponse,
        ProviderRuntimeStatusListRequest, ProviderRuntimeStatusListResponse,
        ProviderServerRequestAudit, ProviderServerRequestError, ProviderServerRequestErrorInfo,
        ProviderServerRequestResult,
    },
    terminal::{
        DEFAULT_TERMINAL_ID, SequencedTerminalEvent, TerminalEvent, TerminalOpenRequest,
        TerminalSessionSnapshot, TerminalSessionStatus, TerminalWriteRequest,
    },
    ws::methods,
};
use ace_runtime::{
    chat::{
        ChatMessageProjection, ChatMessageRole, ChatProjection, ComposerContextKind, ComposerDraft,
        ComposerHostSelection, ComposerPermissionMode, ComposerTrait, CreationContext,
        InteractionMode, ProviderModelSelection, ReasoningEffort, RuntimeMode, SidebarMetadata,
        SidebarProjection, ThreadDraft, ThreadStatus, ThreadSummary, build_chat_projection,
        build_sidebar_projection, resolve_thread_creation_options,
    },
    provider::{
        NormalizedServerRequest, ProviderRuntimeHealth, ServerRequestKind, ThreadItemKind,
        ThreadItemStatus,
    },
    threads::{
        AgentRuntimeSnapshot, ApprovalRecord, ApprovalStatus, ExecutionLocation, GoalStatus,
        HandoffStatus, PlanSessionStatus, RemoteConnectionRecord, SubagentActionKind, TurnMode,
    },
    tools::{SemanticToolCall, ToolRunStatus, ToolSurface},
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
const MAX_BROWSER_ACTIVITIES: usize = 32;

#[derive(Debug, Clone)]
pub struct DesktopStore {
    host: Option<BackendHostClient>,
    projects: Vec<Project>,
    threads: Vec<ThreadSummary>,
    thread_drafts: HashMap<ThreadId, ThreadDraft>,
    project_drafts: HashMap<ProjectId, ThreadId>,
    composer_drafts: HashMap<ThreadId, ComposerDraft>,
    composer_histories: HashMap<ThreadId, Vec<String>>,
    composer_history_positions: HashMap<ThreadId, usize>,
    composer_history_scratch: HashMap<ThreadId, String>,
    persisted_messages: HashMap<ThreadId, Vec<ChatMessageProjection>>,
    terminal_sessions: HashMap<TerminalKey, TerminalSessionProjection>,
    terminal_inputs: HashMap<ThreadId, String>,
    terminal_errors: HashMap<ThreadId, String>,
    review_snapshots: HashMap<ProjectId, ReviewProjection>,
    worktree_snapshots: HashMap<ProjectId, WorktreeProjection>,
    provider_registry: ProviderRegistryProjection,
    runtime_status: RuntimeStatusProjection,
    approval_registry: ApprovalRegistryProjection,
    model_registry: ModelRegistryProjection,
    plugin_registry: ToolRegistryProjection,
    skill_registry: ToolRegistryProjection,
    browser: BrowserProjection,
    browser_activities: Vec<BrowserActivityProjection>,
    artifacts: Vec<ArtifactItemProjection>,
    pinned_items: Vec<PinnedTimelineItem>,
    highlighted_items: Vec<HighlightedTimelineItem>,
    todos: Vec<TodoItem>,
    review_comments: Vec<ReviewCommentItem>,
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
    pub search: SearchProjection,
    pub host: HostProjection,
    pub host_options: Vec<HostOptionProjection>,
    pub active_project_default_model: Option<String>,
    pub services: ServiceReadiness,
    pub terminal: TerminalProjection,
    pub editor: EditorProjection,
    pub review: ReviewProjection,
    pub worktrees: WorktreeProjection,
    pub sources: SourcesProjection,
    pub providers: ProviderRegistryProjection,
    pub runtime_status: RuntimeStatusProjection,
    pub approvals: ApprovalRegistryProjection,
    pub run: RunProjection,
    pub models: ModelRegistryProjection,
    pub plugins: ToolRegistryProjection,
    pub skills: ToolRegistryProjection,
    pub browser: BrowserProjection,
    pub composer_commands: Vec<ComposerCommandProjection>,
    pub summary: SummaryProjection,
    pub annotations: ThreadAnnotationsProjection,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchProjection {
    pub messages: Vec<MessageSearchResultProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageSearchResultProjection {
    pub thread_id: ThreadId,
    pub message_id: String,
    pub thread_title: String,
    pub project_name: String,
    pub role: ChatMessageRole,
    pub excerpt: String,
    pub updated_at: String,
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
pub struct HostOptionProjection {
    pub provider: String,
    pub host_id: String,
    pub label: String,
    pub detail: String,
    pub status: String,
    pub connected: bool,
    pub execution_location: ExecutionLocation,
    pub project_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceReadiness {
    pub host_connected: bool,
    pub terminal: ServiceStatus,
    pub diff_review: ServiceStatus,
    pub worktrees: ServiceStatus,
    pub approvals: ServiceStatus,
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
            worktrees: ServiceStatus::Missing { reason },
            approvals: ServiceStatus::Missing { reason },
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
pub struct EditorProjection {
    pub active_thread_id: Option<ThreadId>,
    pub workspace_root: Option<String>,
    pub candidate_files: Vec<EditorFileProjection>,
    pub can_sync_buffers: bool,
    pub diagnostics_topic: &'static str,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorFileProjection {
    pub path: String,
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrowserProjection {
    pub bridge: Option<BrowserBridgeProjection>,
    pub activities: Vec<BrowserActivityProjection>,
    pub previews: Vec<BrowserPreviewProjection>,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserPreviewProjection {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub location: String,
    pub mime_type: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserActivityProjection {
    pub id: String,
    pub thread_id: ThreadId,
    pub title: String,
    pub detail: String,
    pub target: Option<String>,
    pub status: String,
    pub turn_id: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserBridgeProjection {
    pub status: String,
    pub descriptor_name: Option<String>,
    pub aliases: Vec<String>,
    pub actions: Vec<String>,
    pub capability_keys: Vec<String>,
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
pub struct WorktreeProjection {
    pub repo_path: Option<String>,
    pub entries: Vec<WorktreeEntryProjection>,
    pub error: Option<String>,
    pub updated_at: Option<String>,
    pub last_created_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntryProjection {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub active_thread: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourcesProjection {
    pub items: Vec<SourceItemProjection>,
    pub changed_files: usize,
    pub terminal_sessions: usize,
    pub context_items: usize,
    pub artifacts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceItemProjection {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub added_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactItemProjection {
    pub id: String,
    pub thread_id: ThreadId,
    pub message_id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub url: Option<String>,
    pub path: Option<String>,
    pub mime_type: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SummaryProjection {
    pub current_goal: Option<String>,
    pub current_status: String,
    pub run_status: Option<String>,
    pub composer_status: Option<String>,
    pub runtime_relationships: Vec<String>,
    pub runtime_signals: Vec<String>,
    pub plan: Vec<String>,
    pub todos: Vec<String>,
    pub pinned_context: Vec<String>,
    pub highlighted_context: Vec<String>,
    pub files_changed: Vec<String>,
    pub commands_run: Vec<String>,
    pub browser_pages: Vec<String>,
    pub artifacts: Vec<String>,
    pub decisions: Vec<String>,
    pub blockers: Vec<String>,
    pub next_action: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderRegistryProjection {
    pub providers: Vec<ProviderSummaryProjection>,
    pub commands: Vec<ProviderSlashCommandProjection>,
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunProjection {
    pub active: bool,
    pub status_label: String,
    pub mode_label: String,
    pub provider_label: String,
    pub model_label: String,
    pub turn_id: Option<String>,
    pub plan_status: Option<String>,
    pub pending_approvals: usize,
    pub pending_user_inputs: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApprovalRegistryProjection {
    pub pending: Vec<ApprovalItemProjection>,
    pub resolved: usize,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalItemProjection {
    pub provider: String,
    pub request_id: String,
    pub title: String,
    pub prompt: String,
    pub kind: String,
    pub method: String,
    pub scope: Option<String>,
    pub selected_policy: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelRegistryProjection {
    pub providers: Vec<ModelProviderProjection>,
    pub total_models: usize,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelProviderProjection {
    pub runtime_id: String,
    pub display_name: String,
    pub provider: String,
    pub models: Vec<ModelProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelProjection {
    pub id: String,
    pub display_name: String,
    pub provider: Option<String>,
    pub family: Option<String>,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub supports_reasoning: bool,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub supports_attachments: bool,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSlashCommandProjection {
    pub provider: String,
    pub name: String,
    pub description: String,
    pub prompt_prefix: Option<String>,
    pub input_hint: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerCommandProjection {
    pub token: String,
    pub source: ComposerCommandSource,
    pub name: String,
    pub description: String,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerCommandSource {
    ProviderSlash,
    Skill,
    Plugin,
}

impl ComposerCommandSource {
    fn label(self) -> &'static str {
        match self {
            Self::ProviderSlash => "Provider slash command",
            Self::Skill => "Skill",
            Self::Plugin => "Plugin",
        }
    }
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
    pub disabled_reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadAnnotationsProjection {
    pub pinned_items: Vec<PinnedTimelineItem>,
    pub highlighted_items: Vec<HighlightedTimelineItem>,
    pub todos: Vec<TodoItem>,
    pub review_comments: Vec<ReviewCommentItem>,
    pub open_todo_count: usize,
    pub open_review_comment_count: usize,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: TodoStatus,
    #[serde(default)]
    pub priority: TodoPriority,
    #[serde(default)]
    pub created_by: TodoCreatedBy,
    #[serde(default)]
    pub assigned_to: TodoAssignee,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    #[serde(default)]
    pub related_files: Vec<String>,
    #[serde(default)]
    pub related_tool_events: Vec<String>,
    #[serde(default)]
    pub related_diff_comments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewCommentItem {
    pub id: String,
    pub thread_id: ThreadId,
    pub project_id: ProjectId,
    pub file_path: String,
    pub line: Option<u32>,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub resolved: bool,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoPriority {
    Low,
    #[default]
    Normal,
    High,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoCreatedBy {
    User,
    Assistant,
    #[default]
    System,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoAssignee {
    User,
    Agent,
    #[default]
    Both,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadAnnotationsSnapshot {
    #[serde(default)]
    pub pinned_items: Vec<PinnedTimelineItem>,
    #[serde(default)]
    pub highlighted_items: Vec<HighlightedTimelineItem>,
    #[serde(default)]
    pub todos: Vec<TodoItem>,
    #[serde(default)]
    pub review_comments: Vec<ReviewCommentItem>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectActionKind {
    Tests,
    Lint,
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
            composer_histories: HashMap::new(),
            composer_history_positions: HashMap::new(),
            composer_history_scratch: HashMap::new(),
            persisted_messages: HashMap::new(),
            terminal_sessions: HashMap::new(),
            terminal_inputs: HashMap::new(),
            terminal_errors: HashMap::new(),
            review_snapshots: HashMap::new(),
            worktree_snapshots: HashMap::new(),
            provider_registry: ProviderRegistryProjection::default(),
            runtime_status: RuntimeStatusProjection::default(),
            approval_registry: ApprovalRegistryProjection::default(),
            model_registry: ModelRegistryProjection::default(),
            plugin_registry: ToolRegistryProjection {
                source: "plugin/installed",
                ..ToolRegistryProjection::default()
            },
            skill_registry: ToolRegistryProjection {
                source: "skills/list",
                ..ToolRegistryProjection::default()
            },
            browser: BrowserProjection::default(),
            browser_activities: Vec::new(),
            artifacts: Vec::new(),
            pinned_items: Vec::new(),
            highlighted_items: Vec::new(),
            todos: Vec::new(),
            review_comments: Vec::new(),
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
        self.artifacts.clear();
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
        self.apply_thread_annotation_counts(&mut sidebar);
        sidebar.total_thread_count = 0;
        for group in &mut sidebar.projects {
            group.project.thread_count = self
                .thread_counts
                .get(&group.project.id)
                .copied()
                .unwrap_or(group.threads.len());
            sidebar.total_thread_count += group.project.thread_count;
            for thread in &mut group.threads {
                self.apply_thread_message_preview(thread);
            }
        }
        let active_thread = self.active_thread().cloned();
        let composer = self
            .metadata
            .active_thread_id
            .as_ref()
            .and_then(|id| self.composer_drafts.get(id))
            .cloned();
        let composer_commands = composer
            .as_ref()
            .map(|draft| self.composer_commands_for_prompt(&draft.prompt))
            .unwrap_or_default();
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
            search: self.search_projection(),
            host: self.host_projection(),
            host_options: self.host_options_projection(),
            active_project_default_model: self.active_project_default_model_label(),
            services: self.service_readiness(),
            terminal: self.terminal_projection(),
            editor: self.editor_projection(),
            review: self.review_projection(),
            worktrees: self.worktree_projection(),
            sources: self.sources_projection(),
            providers: self.provider_registry.clone(),
            runtime_status: self.runtime_status.clone(),
            approvals: self.approval_registry.clone(),
            run: self.run_projection(),
            models: self.model_registry.clone(),
            plugins: self.plugin_registry.clone(),
            skills: self.skill_registry.clone(),
            browser: self.browser_projection(),
            composer_commands,
            summary: self.summary_projection(),
            annotations: self.annotations_projection(),
        }
    }

    fn search_projection(&self) -> SearchProjection {
        let project_names = self
            .projects
            .iter()
            .map(|project| (project.id, project.title.clone()))
            .collect::<HashMap<_, _>>();
        let threads = self
            .threads
            .iter()
            .map(|thread| (thread.id.clone(), thread))
            .collect::<HashMap<_, _>>();
        let mut messages = Vec::new();

        for (thread_id, thread_messages) in &self.persisted_messages {
            let Some(thread) = threads.get(thread_id) else {
                continue;
            };
            if thread.archived {
                continue;
            }
            let project_name = project_names
                .get(&thread.project_id)
                .cloned()
                .unwrap_or_else(|| "Unknown project".to_string());
            for message in thread_messages
                .iter()
                .rev()
                .filter(|message| {
                    message
                        .text
                        .as_deref()
                        .is_some_and(|text| !text.trim().is_empty())
                })
                .take(3)
            {
                messages.push(MessageSearchResultProjection {
                    thread_id: thread_id.clone(),
                    message_id: message.id.clone(),
                    thread_title: thread.title.clone(),
                    project_name: project_name.clone(),
                    role: message.role,
                    excerpt: message_excerpt(message),
                    updated_at: thread.latest_activity_at.clone(),
                });
                if messages.len() >= 256 {
                    messages.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
                    return SearchProjection { messages };
                }
            }
        }

        messages.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        SearchProjection { messages }
    }

    fn apply_thread_annotation_counts(&self, sidebar: &mut SidebarProjection) {
        for group in &mut sidebar.projects {
            for thread in &mut group.threads {
                thread.pinned_item_count = self
                    .pinned_items
                    .iter()
                    .filter(|item| item.thread_id == thread.id)
                    .count();
                thread.highlighted_count = self
                    .highlighted_items
                    .iter()
                    .filter(|item| item.thread_id == thread.id)
                    .count();
                thread.todo_count = self
                    .todos
                    .iter()
                    .filter(|todo| todo.thread_id == thread.id)
                    .count();
                thread.open_todo_count = self
                    .todos
                    .iter()
                    .filter(|todo| todo.thread_id == thread.id)
                    .filter(|todo| !matches!(todo.status, TodoStatus::Done | TodoStatus::Canceled))
                    .count();
            }
        }
    }

    fn apply_thread_message_preview(&self, thread: &mut ThreadSummary) {
        if let Some(preview) = thread
            .latest_message_preview
            .as_ref()
            .map(|preview| preview.trim())
            .filter(|preview| !preview.is_empty())
        {
            thread.latest_message_preview = Some(truncate_preview(preview, 160));
            return;
        }

        thread.latest_message_preview =
            self.persisted_messages
                .get(&thread.id)
                .and_then(|messages| {
                    messages
                        .iter()
                        .rev()
                        .map(message_excerpt)
                        .find(|excerpt| !excerpt.is_empty())
                });
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
    pub fn host_options_projection(&self) -> Vec<HostOptionProjection> {
        let mut hosts = self
            .runtime
            .remote_connections
            .iter()
            .filter(|connection| connection.execution_location == ExecutionLocation::RemoteHost)
            .map(host_option_projection)
            .collect::<Vec<_>>();
        hosts.sort_by(|left, right| {
            right
                .connected
                .cmp(&left.connected)
                .then_with(|| left.label.cmp(&right.label))
                .then_with(|| left.host_id.cmp(&right.host_id))
        });
        hosts
    }

    #[must_use]
    pub fn active_project_default_model_label(&self) -> Option<String> {
        let thread = self.active_thread()?;
        let selection = self
            .projects
            .iter()
            .find(|project| project.id == thread.project_id)?
            .default_model_selection
            .as_ref()?;
        Some(model_selection_label(selection))
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
            worktrees: ServiceStatus::Ready,
            approvals: ServiceStatus::Ready,
            browser: self.browser_service_status(),
            editor: self.editor_service_status(),
            summary: ServiceStatus::Ready,
            providers: ServiceStatus::Ready,
            plugins: ServiceStatus::Ready,
            skills: ServiceStatus::Ready,
        }
    }

    fn browser_service_status(&self) -> ServiceStatus {
        if self
            .browser
            .bridge
            .as_ref()
            .is_some_and(|bridge| bridge.status == "connected")
        {
            return ServiceStatus::Ready;
        }

        let reason = self.browser.bridge.as_ref().map_or(
            "Browser bridge status has not been refreshed from the host runtime.",
            |bridge| match bridge.status.as_str() {
                "unavailable" => {
                    "Browser bridge contract exists, but no Chromium bridge handler is attached."
                }
                "missing" => "Host runtime did not advertise a Browser bridge contract.",
                _ => "Browser bridge is not connected.",
            },
        );
        ServiceStatus::Missing { reason }
    }

    fn editor_service_status(&self) -> ServiceStatus {
        let projection = self.editor_projection();
        if projection.can_sync_buffers {
            ServiceStatus::Ready
        } else {
            ServiceStatus::Missing {
                reason: "Select a thread with a project workspace before opening editor buffers.",
            }
        }
    }

    fn browser_projection(&self) -> BrowserProjection {
        BrowserProjection {
            bridge: self.browser.bridge.clone(),
            activities: self.browser_activities.clone(),
            previews: self.browser_previews_projection(),
            error: self.browser.error.clone(),
            updated_at: self.browser.updated_at.clone(),
        }
    }

    fn browser_previews_projection(&self) -> Vec<BrowserPreviewProjection> {
        let Some(active_thread_id) = self.metadata.active_thread_id.as_ref() else {
            return Vec::new();
        };
        self.artifacts
            .iter()
            .filter(|artifact| &artifact.thread_id == active_thread_id)
            .filter(|artifact| artifact_is_browser_preview(artifact))
            .rev()
            .take(6)
            .map(browser_preview_from_artifact)
            .collect()
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
    pub fn editor_projection(&self) -> EditorProjection {
        let Some(thread) = self.active_thread() else {
            return EditorProjection {
                diagnostics_topic: "editor.diagnostics",
                error: Some("No active thread is selected.".to_string()),
                ..EditorProjection::default()
            };
        };
        let workspace_root = self
            .projects
            .iter()
            .find(|project| project.id == thread.project_id)
            .map(|project| project.workspace_root.clone());
        let Some(workspace_root) = workspace_root else {
            return EditorProjection {
                active_thread_id: Some(thread.id.clone()),
                diagnostics_topic: "editor.diagnostics",
                error: Some("No project workspace is available for this thread.".to_string()),
                ..EditorProjection::default()
            };
        };

        let candidate_files = self
            .review_snapshots
            .get(&thread.project_id)
            .map(|review| {
                review
                    .files
                    .iter()
                    .take(48)
                    .map(|file| EditorFileProjection {
                        path: file.path.clone(),
                        status: file.status.clone(),
                        additions: file.additions,
                        deletions: file.deletions,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        EditorProjection {
            active_thread_id: Some(thread.id.clone()),
            workspace_root: Some(workspace_root),
            candidate_files,
            can_sync_buffers: self.host.is_some(),
            diagnostics_topic: "editor.diagnostics",
            error: None,
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
    pub fn worktree_projection(&self) -> WorktreeProjection {
        let Some(thread) = self.active_thread() else {
            return WorktreeProjection::default();
        };
        self.worktree_snapshots
            .get(&thread.project_id)
            .cloned()
            .unwrap_or_else(|| WorktreeProjection {
                repo_path: self.review_repo_path(thread),
                ..WorktreeProjection::default()
            })
    }

    #[must_use]
    pub fn sources_projection(&self) -> SourcesProjection {
        let active_thread_id = self.active_thread().map(|thread| thread.id.clone());
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
                detail: todo_context_line(todo),
                added_at: todo.created_at.clone(),
            });
        }

        for comment in &annotations.review_comments {
            items.push(SourceItemProjection {
                id: format!("review:{}", comment.id),
                kind: "diff_comment".to_string(),
                title: comment.file_path.clone(),
                detail: review_comment_detail(comment),
                added_at: comment.created_at.clone(),
            });
        }

        let artifact_count = active_thread_id.as_ref().map_or(0, |thread_id| {
            self.artifacts
                .iter()
                .filter(|artifact| &artifact.thread_id == thread_id)
                .count()
        });
        if let Some(thread_id) = active_thread_id.as_ref() {
            for artifact in self
                .artifacts
                .iter()
                .filter(|artifact| &artifact.thread_id == thread_id)
            {
                items.push(SourceItemProjection {
                    id: format!("artifact:{}", artifact.id),
                    kind: "artifact".to_string(),
                    title: artifact.title.clone(),
                    detail: artifact.detail.clone(),
                    added_at: artifact.observed_at.clone(),
                });
            }
        }

        SourcesProjection {
            changed_files: review.files.len(),
            terminal_sessions: usize::from(terminal.session.is_some()),
            context_items: annotations.pinned_items.len()
                + annotations.highlighted_items.len()
                + annotations.todos.len()
                + annotations.review_comments.len(),
            artifacts: artifact_count,
            items,
        }
    }

    #[must_use]
    pub fn run_projection(&self) -> RunProjection {
        let Some(thread) = self.active_thread() else {
            return RunProjection {
                status_label: "No active thread".to_string(),
                mode_label: "None".to_string(),
                provider_label: "No provider".to_string(),
                model_label: "No model".to_string(),
                ..RunProjection::default()
            };
        };
        let thread_keys = self.runtime_thread_keys(thread);
        let active_turn = self
            .runtime
            .active_turns
            .iter()
            .find(|turn| thread_keys.iter().any(|key| key == &turn.thread_id));
        let plan_session = self
            .runtime
            .plan_sessions
            .iter()
            .find(|plan| thread_keys.iter().any(|key| key == &plan.thread_id));
        let active = active_turn.is_some_and(|turn| turn.active)
            || matches!(
                thread.status,
                ThreadStatus::Working | ThreadStatus::Connecting
            );
        let mode_label = active_turn
            .map(|turn| turn_mode_label(turn.mode).to_string())
            .or_else(|| {
                plan_session.map(|plan| format!("Plan {}", plan_session_status_label(plan.status)))
            })
            .unwrap_or_else(|| thread_run_mode_label(thread));
        let status_label = plan_session
            .map(|plan| format!("Plan {}", plan_session_status_label(plan.status)))
            .unwrap_or_else(|| thread.status.label().to_string());
        RunProjection {
            active,
            status_label,
            mode_label,
            provider_label: thread.provider.display_name().to_string(),
            model_label: thread
                .model
                .clone()
                .unwrap_or_else(|| "No model selected".to_string()),
            turn_id: active_turn
                .and_then(|turn| turn.turn_id.clone())
                .or_else(|| plan_session.and_then(|plan| plan.turn_id.clone())),
            plan_status: plan_session
                .map(|plan| plan_session_status_label(plan.status).to_string()),
            pending_approvals: thread
                .pending_approvals
                .max(self.approval_registry.pending.len()),
            pending_user_inputs: thread.pending_user_inputs,
        }
    }

    fn runtime_thread_keys(&self, thread: &ThreadSummary) -> Vec<String> {
        let mut keys = vec![thread.id.0.clone()];
        if let Some(provider_thread_id) = thread.provider_thread_id.as_ref()
            && provider_thread_id != &thread.id.0
        {
            keys.push(provider_thread_id.clone());
        }
        keys
    }

    fn runtime_relationships_for_thread(&self, thread: &ThreadSummary) -> Vec<String> {
        let keys = self.runtime_thread_keys(thread);
        let matches_thread = |id: &str| keys.iter().any(|key| key == id);
        let mut relationships = Vec::new();

        relationships.extend(
            self.runtime
                .fork_points
                .iter()
                .filter(|fork| {
                    matches_thread(&fork.parent_thread_id) || matches_thread(&fork.child_thread_id)
                })
                .map(|fork| {
                    let turn = fork
                        .turn_id
                        .as_deref()
                        .map(|turn| format!(" · turn {turn}"))
                        .unwrap_or_default();
                    format!(
                        "Fork {} -> {}{}",
                        fork.parent_thread_id, fork.child_thread_id, turn
                    )
                }),
        );

        relationships.extend(
            self.runtime
                .side_chats
                .iter()
                .filter(|side_chat| {
                    matches_thread(&side_chat.parent_thread_id)
                        || matches_thread(&side_chat.thread_id)
                })
                .map(|side_chat| {
                    format!(
                        "Side chat {} -> {} · {}",
                        side_chat.parent_thread_id,
                        side_chat.thread_id,
                        if side_chat.ephemeral {
                            "ephemeral"
                        } else {
                            "persistent"
                        }
                    )
                }),
        );

        relationships.extend(
            self.runtime
                .subagents
                .iter()
                .filter(|subagent| {
                    matches_thread(&subagent.parent_thread_id)
                        || matches_thread(&subagent.thread_id)
                })
                .map(|subagent| {
                    let role = subagent
                        .role
                        .as_deref()
                        .or(subagent.nickname.as_deref())
                        .unwrap_or("agent");
                    format!(
                        "Subagent {role} · {} -> {}",
                        subagent.parent_thread_id, subagent.thread_id
                    )
                }),
        );

        relationships.extend(
            self.runtime
                .handoffs
                .iter()
                .filter(|handoff| {
                    matches_thread(&handoff.source_thread_id)
                        || handoff
                            .target_thread_id
                            .as_deref()
                            .is_some_and(matches_thread)
                })
                .map(|handoff| {
                    let target = handoff
                        .target_thread_id
                        .as_deref()
                        .or(handoff.worktree_path.as_deref())
                        .or(handoff.remote_host.as_deref())
                        .unwrap_or("pending target");
                    let branch = handoff
                        .branch
                        .as_deref()
                        .map(|branch| format!(" · {branch}"))
                        .unwrap_or_default();
                    format!(
                        "Handoff {} -> {} · {}{}",
                        handoff.source_thread_id,
                        target,
                        handoff_status_label(handoff.status),
                        branch
                    )
                }),
        );

        relationships.extend(
            self.runtime
                .subagent_actions
                .iter()
                .filter(|action| {
                    matches_thread(&action.parent_thread_id)
                        || matches_thread(&action.subagent_thread_id)
                })
                .map(|action| {
                    format!(
                        "Subagent action {} · {} -> {}",
                        subagent_action_label(action.action),
                        action.parent_thread_id,
                        action.subagent_thread_id
                    )
                }),
        );

        relationships.truncate(12);
        relationships
    }

    fn runtime_signals_for_thread(&self, thread: &ThreadSummary) -> Vec<String> {
        let keys = self.runtime_thread_keys(thread);
        let matches_thread = |id: &str| keys.iter().any(|key| key == id);
        let matches_optional_thread = |id: Option<&str>| id.is_some_and(&matches_thread);
        let mut signals = Vec::new();

        signals.extend(
            self.runtime
                .goals
                .iter()
                .filter(|goal| matches_thread(&goal.thread_id))
                .map(goal_signal_summary),
        );

        signals.extend(
            self.runtime
                .warnings
                .iter()
                .filter(|warning| matches_optional_thread(warning.thread_id.as_deref()))
                .map(|warning| format!("Warning {} · {}", warning.provider, warning.message)),
        );

        signals.extend(
            self.runtime
                .model_reroutes
                .iter()
                .filter(|reroute| matches_optional_thread(reroute.thread_id.as_deref()))
                .map(|reroute| {
                    let from = reroute.from_model.as_deref().unwrap_or("unknown model");
                    let to = reroute.to_model.as_deref().unwrap_or("unknown model");
                    let reason = reroute
                        .reason
                        .as_deref()
                        .map(|reason| format!(" · {reason}"))
                        .unwrap_or_default();
                    format!("Model reroute {from} -> {to}{reason}")
                }),
        );

        signals.extend(
            self.runtime
                .process_exits
                .iter()
                .filter(|process| matches_optional_thread(process.thread_id.as_deref()))
                .map(|process| {
                    let process_id = process.process_id.as_deref().unwrap_or("process");
                    let code = process
                        .exit_code
                        .map_or("unknown".to_string(), |code| code.to_string());
                    format!("Process exit {process_id} · code {code}")
                }),
        );

        signals.extend(
            self.runtime
                .turn_diffs
                .iter()
                .filter(|diff| matches_thread(&diff.thread_id))
                .map(|diff| {
                    let file_count = json_collection_len(&diff.files);
                    let detail = if file_count > 0 {
                        format!("{file_count} file{}", plural(file_count))
                    } else if diff
                        .diff
                        .as_ref()
                        .is_some_and(|diff| !diff.trim().is_empty())
                    {
                        "diff available".to_string()
                    } else {
                        "diff metadata".to_string()
                    };
                    let turn = diff
                        .turn_id
                        .as_deref()
                        .map(|turn| format!(" · turn {turn}"))
                        .unwrap_or_default();
                    format!("Turn diff updated · {detail}{turn}")
                }),
        );

        signals.extend(
            self.runtime
                .approval_retries
                .iter()
                .filter(|retry| matches_thread(&retry.thread_id))
                .map(|retry| {
                    let outcome = if retry.approved { "approved" } else { "denied" };
                    let reason = retry
                        .reason
                        .as_deref()
                        .map(|reason| format!(" · {reason}"))
                        .unwrap_or_default();
                    format!("Approval retry {outcome}{reason}")
                }),
        );

        signals.extend(
            self.runtime
                .realtime_sessions
                .iter()
                .filter(|session| matches_optional_thread(session.thread_id.as_deref()))
                .map(|session| {
                    let message = session
                        .message
                        .as_deref()
                        .map(|message| format!(" · {message}"))
                        .unwrap_or_default();
                    format!(
                        "Realtime session {} · {}{}",
                        session.provider, session.status, message
                    )
                }),
        );

        signals.truncate(16);
        signals
    }

    #[must_use]
    pub fn summary_projection(&self) -> SummaryProjection {
        let Some(thread) = self.active_thread() else {
            return SummaryProjection {
                current_status: "No active thread is selected.".to_string(),
                ..SummaryProjection::default()
            };
        };
        let annotations = self.annotations_projection();
        let review = self.review_projection();
        let terminal = self.terminal_projection();
        let editor = self.editor_projection();
        let browser = &self.browser;
        let run = self.run_projection();
        let composer_status = self
            .composer_drafts
            .get(&thread.id)
            .map(composer_status_line);
        let runtime_relationships = self.runtime_relationships_for_thread(thread);
        let runtime_signals = self.runtime_signals_for_thread(thread);
        let messages = self
            .persisted_messages
            .get(&thread.id)
            .cloned()
            .unwrap_or_default();

        let current_goal = messages
            .iter()
            .find(|message| message.role == ChatMessageRole::User)
            .map(message_excerpt)
            .filter(|goal| !goal.is_empty())
            .or_else(|| (!thread.title.trim().is_empty()).then(|| thread.title.clone()));
        let mut plan = Vec::new();
        if thread.has_actionable_plan {
            plan.push("Active thread reports an actionable plan.".to_string());
        }
        if !review.files.is_empty() {
            plan.push(format!(
                "Review {} changed file{} before commit.",
                review.files.len(),
                plural(review.files.len())
            ));
        }
        if annotations.open_todo_count > 0 {
            plan.push(format!(
                "Work through {} open todo{}.",
                annotations.open_todo_count,
                plural(annotations.open_todo_count)
            ));
        }
        if !thread_status_is_terminal(thread.status) {
            plan.push("Monitor the active run until it reaches a terminal state.".to_string());
        }

        let todos = annotations
            .todos
            .iter()
            .take(12)
            .map(todo_context_line)
            .collect::<Vec<_>>();
        let pinned_context = annotations
            .pinned_items
            .iter()
            .take(8)
            .map(|item| format!("{}: {}", item.display_title, item.display_excerpt))
            .collect::<Vec<_>>();
        let highlighted_context = annotations
            .highlighted_items
            .iter()
            .take(8)
            .map(|item| format!("{}: {}", item.display_title, item.display_excerpt))
            .collect::<Vec<_>>();
        let files_changed = review
            .files
            .iter()
            .take(16)
            .map(review_file_summary)
            .collect::<Vec<_>>();
        let commands_run = terminal
            .session
            .as_ref()
            .and_then(|session| {
                (!session.history.trim().is_empty()).then(|| {
                    vec![format!(
                        "{} · {}",
                        short_status(&session.status),
                        tail_chars(&session.history, 240)
                    )]
                })
            })
            .unwrap_or_default();
        let mut browser_pages = self
            .browser_activities
            .iter()
            .rev()
            .filter(|activity| activity.thread_id == thread.id)
            .take(8)
            .map(browser_activity_summary)
            .collect::<Vec<_>>();
        if browser_pages.is_empty()
            && let Some(bridge) = browser.bridge.as_ref()
        {
            browser_pages.push(format!(
                "Browser bridge {} with {} action{}.",
                bridge.status,
                bridge.actions.len(),
                plural(bridge.actions.len())
            ));
        }
        let artifacts = self
            .artifacts
            .iter()
            .filter(|artifact| artifact.thread_id == thread.id)
            .take(8)
            .map(|artifact| format!("{} · {}", artifact.title, artifact.detail))
            .collect::<Vec<_>>();
        let mut decisions = Vec::new();
        if let Some(selection) = thread.model.as_deref() {
            decisions.push(format!(
                "Thread is using {} on {}.",
                selection,
                thread.provider.display_name()
            ));
        }
        if let Some(workspace_root) = editor.workspace_root.as_deref() {
            decisions.push(format!("Active workspace is {workspace_root}."));
        }
        decisions.push(format!(
            "Run is {} in {} mode using {} on {}.",
            run.status_label, run.mode_label, run.model_label, run.provider_label
        ));
        if let Some(turn_id) = run.turn_id.as_deref() {
            decisions.push(format!("Active turn id is {turn_id}."));
        }
        let mut blockers = Vec::new();
        if thread.pending_approvals > 0 || !self.approval_registry.pending.is_empty() {
            blockers.push(format!(
                "{} approval{} pending.",
                thread
                    .pending_approvals
                    .max(self.approval_registry.pending.len()),
                plural(
                    thread
                        .pending_approvals
                        .max(self.approval_registry.pending.len())
                )
            ));
        }
        if thread.pending_user_inputs > 0 {
            blockers.push(format!(
                "{} user input prompt{} pending.",
                thread.pending_user_inputs,
                plural(thread.pending_user_inputs)
            ));
        }
        if let Some(error) = review.error.as_deref() {
            blockers.push(format!("Review: {error}"));
        }
        if let Some(error) = self.runtime_status.error.as_deref() {
            blockers.push(format!("Runtime: {error}"));
        }
        let next_action = if !blockers.is_empty() {
            Some("Resolve the listed blocker before continuing agent execution.".to_string())
        } else if annotations.open_todo_count > 0 {
            Some("Pick the next open todo or attach it to the composer with @todo.".to_string())
        } else if !review.files.is_empty() {
            Some(
                "Review changed files and either ask the agent for follow-up changes or commit."
                    .to_string(),
            )
        } else if thread.status == ThreadStatus::Idle {
            Some("Ask for follow-up changes in the composer.".to_string())
        } else {
            Some("Monitor the active thread status and latest timeline message.".to_string())
        };

        let source_count = self.sources_projection().items.len();
        let run_status = Some(format!(
            "{} · {} mode · {} on {}",
            run.status_label, run.mode_label, run.model_label, run.provider_label
        ));
        SummaryProjection {
            current_goal,
            current_status: format!(
                "{} · {} message{} · {} source{}",
                thread.status.label(),
                messages.len(),
                plural(messages.len()),
                source_count,
                plural(source_count)
            ),
            run_status,
            composer_status,
            runtime_relationships,
            runtime_signals,
            plan,
            todos,
            pinned_context,
            highlighted_context,
            files_changed,
            commands_run,
            browser_pages,
            artifacts,
            decisions,
            blockers,
            next_action,
        }
    }

    #[must_use]
    pub fn annotations_snapshot(&self) -> ThreadAnnotationsSnapshot {
        ThreadAnnotationsSnapshot {
            pinned_items: self.pinned_items.clone(),
            highlighted_items: self.highlighted_items.clone(),
            todos: self.todos.clone(),
            review_comments: self.review_comments.clone(),
        }
    }

    pub fn restore_annotations(&mut self, snapshot: ThreadAnnotationsSnapshot) {
        self.pinned_items = snapshot.pinned_items;
        self.highlighted_items = snapshot.highlighted_items;
        self.todos = snapshot.todos;
        self.review_comments = snapshot.review_comments;
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
        let review_comments = self
            .review_comments
            .iter()
            .filter(|comment| &comment.thread_id == thread_id)
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
        let open_review_comment_count = review_comments
            .iter()
            .filter(|comment| !comment.resolved)
            .count();

        ThreadAnnotationsProjection {
            pinned_items,
            highlighted_items,
            todos,
            review_comments,
            open_todo_count,
            open_review_comment_count,
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
            description: None,
            status: TodoStatus::Open,
            priority: TodoPriority::Normal,
            created_by: TodoCreatedBy::User,
            assigned_to: TodoAssignee::Both,
            created_at: now.clone(),
            updated_at: now,
            completed_at: None,
            related_files: Vec::new(),
            related_tool_events: Vec::new(),
            related_diff_comments: Vec::new(),
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

    pub fn update_todo_priority(&mut self, todo_id: &str, priority: TodoPriority) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let now = self.next_timestamp();
        if let Some(todo) = self
            .todos
            .iter_mut()
            .find(|todo| todo.thread_id == thread_id && todo.id == todo_id)
        {
            todo.priority = priority;
            todo.updated_at = now;
        }
    }

    pub fn update_todo_assignee(&mut self, todo_id: &str, assignee: TodoAssignee) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let now = self.next_timestamp();
        if let Some(todo) = self
            .todos
            .iter_mut()
            .find(|todo| todo.thread_id == thread_id && todo.id == todo_id)
        {
            todo.assigned_to = assignee;
            todo.updated_at = now;
        }
    }

    pub fn link_todo_to_current_diff(&mut self, todo_id: &str) {
        let Some(thread) = self.active_thread().cloned() else {
            return;
        };
        let Some(review) = self.review_snapshots.get(&thread.project_id) else {
            return;
        };
        let related_files = review
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        let related_diff_comments = self
            .review_comments
            .iter()
            .filter(|comment| {
                comment.thread_id == thread.id && comment.project_id == thread.project_id
            })
            .map(|comment| comment.id.clone())
            .collect::<Vec<_>>();
        if related_files.is_empty() && related_diff_comments.is_empty() {
            return;
        }

        let now = self.next_timestamp();
        if let Some(todo) = self
            .todos
            .iter_mut()
            .find(|todo| todo.thread_id == thread.id && todo.id == todo_id)
        {
            extend_unique(&mut todo.related_files, related_files);
            extend_unique(&mut todo.related_diff_comments, related_diff_comments);
            todo.updated_at = now;
        }
    }

    pub fn create_review_comment_for_file(&mut self, file_path: String) {
        let Some(thread) = self.active_thread().cloned() else {
            return;
        };
        if file_path.trim().is_empty() {
            return;
        }

        let now = self.next_timestamp();
        let body = format!("Review the changes in {file_path}.");
        self.review_comments.push(ReviewCommentItem {
            id: format!("review-{now}-{}", stable_token(&file_path)),
            thread_id: thread.id,
            project_id: thread.project_id,
            file_path,
            line: None,
            body,
            created_at: now.clone(),
            updated_at: now,
            resolved: false,
        });
    }

    pub fn toggle_review_comment_resolved(&mut self, comment_id: &str) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let now = self.next_timestamp();
        if let Some(comment) = self
            .review_comments
            .iter_mut()
            .find(|comment| comment.thread_id == thread_id && comment.id == comment_id)
        {
            comment.resolved = !comment.resolved;
            comment.updated_at = now;
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
            self.approval_registry = ApprovalRegistryProjection {
                error: Some(
                    "Connect to a local or remote host runtime to inspect approvals.".to_string(),
                ),
                updated_at: self.runtime_status.updated_at.clone(),
                ..ApprovalRegistryProjection::default()
            };
            self.model_registry = ModelRegistryProjection {
                error: Some(
                    "Connect to a local or remote host runtime to inspect models.".to_string(),
                ),
                updated_at: self.runtime_status.updated_at.clone(),
                ..ModelRegistryProjection::default()
            };
            self.browser = BrowserProjection {
                error: Some(
                    "Connect to a host runtime to inspect Browser bridge state.".to_string(),
                ),
                updated_at: Some(self.next_timestamp()),
                ..BrowserProjection::default()
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
                self.approval_registry = ApprovalRegistryProjection {
                    error: Some(format!("Provider approval state unavailable: {error}")),
                    updated_at: self.provider_registry.updated_at.clone(),
                    ..ApprovalRegistryProjection::default()
                };
                self.model_registry = ModelRegistryProjection {
                    error: Some(format!("Provider model catalog unavailable: {error}")),
                    updated_at: self.provider_registry.updated_at.clone(),
                    ..ModelRegistryProjection::default()
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
                self.approval_registry = ApprovalRegistryProjection {
                    error: Some(format!("Provider approval state unavailable: {error}")),
                    updated_at: Some(now.clone()),
                    ..ApprovalRegistryProjection::default()
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
        let host_tools_response = match host.call::<_, ProviderHostToolsListResponse>(
            methods::PROVIDER_RUNTIME_HOST_TOOLS_LIST,
            &serde_json::Value::Null,
        ) {
            Ok(response) => Some(response),
            Err(error) => {
                partial_errors.push(format!("host tools unavailable: {error}"));
                self.browser = BrowserProjection {
                    error: Some(format!("Browser bridge status unavailable: {error}")),
                    updated_at: Some(now.clone()),
                    ..BrowserProjection::default()
                };
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
        let commands = slash_response
            .as_ref()
            .map(slash_command_projections)
            .unwrap_or_default();

        self.provider_registry = ProviderRegistryProjection {
            providers,
            commands,
            total_slash_commands,
            error: (!partial_errors.is_empty()).then(|| partial_errors.join("; ")),
            updated_at: Some(now.clone()),
        };
        self.model_registry = self.refresh_model_registry_for_providers(
            &host,
            &providers_response.runtime,
            self.provider_registry
                .updated_at
                .clone()
                .unwrap_or_default(),
        );
        if let Some(response) = host_tools_response {
            self.browser = browser_projection_from_host_tools(&response, now.clone());
        }
        if let Some(response) = state_response {
            let updated_at = self
                .provider_registry
                .updated_at
                .clone()
                .unwrap_or_default();
            self.runtime_status = runtime_status_projection_from_state(
                &response,
                providers_response.runtime.len(),
                updated_at.clone(),
            );
            self.approval_registry = approval_registry_projection_from_state(&response, updated_at);
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

    fn refresh_model_registry_for_providers(
        &self,
        host: &BackendHostClient,
        providers: &[ProviderRuntimeProviderInfo],
        updated_at: String,
    ) -> ModelRegistryProjection {
        let mut model_providers = Vec::new();
        let mut errors = Vec::new();
        for provider in providers
            .iter()
            .filter(|provider| provider.readiness.ready || provider.summary.selectable)
        {
            match host.call::<_, ProviderRuntimeModelsListResponse>(
                methods::PROVIDER_RUNTIME_MODELS_LIST,
                &ProviderRuntimeModelsListRequest {
                    provider: provider.runtime_id.clone(),
                    params: serde_json::Value::Null,
                    timeout_ms: 30_000,
                },
            ) {
                Ok(response) => model_providers.push(model_provider_projection(response)),
                Err(error) => errors.push(format!("{}: {error}", provider.display_name)),
            }
        }
        let total_models = model_providers
            .iter()
            .map(|provider| provider.models.len())
            .sum();

        ModelRegistryProjection {
            providers: model_providers,
            total_models,
            error: (!errors.is_empty()).then(|| errors.join("; ")),
            updated_at: Some(updated_at),
        }
    }

    pub fn refresh_developer_registries(&mut self, host: Option<&BackendHostClient>) {
        self.refresh_provider_registry(host);
        self.refresh_plugin_registry(host);
        self.refresh_skill_registry(host);
    }

    pub fn refresh_approvals(&mut self, host: Option<&BackendHostClient>) {
        self.refresh_provider_registry(host);
    }

    pub fn approve_provider_request(
        &mut self,
        host: Option<&BackendHostClient>,
        provider: String,
        request_id: String,
    ) {
        self.resolve_provider_request(host, provider, request_id, true);
    }

    pub fn deny_provider_request(
        &mut self,
        host: Option<&BackendHostClient>,
        provider: String,
        request_id: String,
    ) {
        self.resolve_provider_request(host, provider, request_id, false);
    }

    fn resolve_provider_request(
        &mut self,
        host: Option<&BackendHostClient>,
        provider: String,
        request_id: String,
        approved: bool,
    ) {
        let Some(host) = self.host.clone().or_else(|| host.cloned()) else {
            self.approval_registry.error =
                Some("Connect to a host runtime before resolving approvals.".to_string());
            self.approval_registry.updated_at = Some(self.next_timestamp());
            return;
        };

        let response = if approved {
            host.call::<_, serde_json::Value>(
                methods::PROVIDER_RUNTIME_SERVER_REQUEST_RESULT,
                &ProviderServerRequestResult {
                    provider: provider.clone(),
                    request_id: request_id.clone(),
                    result: serde_json::json!({ "approved": true }),
                    audit: approval_audit("approved from desktop"),
                },
            )
        } else {
            host.call::<_, serde_json::Value>(
                methods::PROVIDER_RUNTIME_SERVER_REQUEST_ERROR,
                &ProviderServerRequestError {
                    provider: provider.clone(),
                    request_id: request_id.clone(),
                    error: ProviderServerRequestErrorInfo {
                        code: 403,
                        message: "Denied by user from desktop".to_string(),
                    },
                    audit: approval_audit("denied from desktop"),
                },
            )
        };

        match response {
            Ok(_) => self.refresh_provider_registry(Some(&host)),
            Err(error) => {
                self.approval_registry.error =
                    Some(format!("Failed to resolve approval {request_id}: {error}"));
                self.approval_registry.updated_at = Some(self.next_timestamp());
            }
        }
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

    pub fn refresh_active_worktrees(&mut self, host: Option<&BackendHostClient>) {
        let Some(thread) = self.active_thread().cloned() else {
            return;
        };
        let Some(repo_path) = self.review_repo_path(&thread) else {
            self.worktree_snapshots.insert(
                thread.project_id,
                WorktreeProjection {
                    error: Some("No project workspace is available for this thread.".to_string()),
                    ..WorktreeProjection::default()
                },
            );
            return;
        };

        let Some(host) = self.host.clone().or_else(|| host.cloned()) else {
            self.worktree_snapshots.insert(
                thread.project_id,
                WorktreeProjection {
                    repo_path: Some(repo_path),
                    error: Some(
                        "Connect to a host runtime before listing Git worktrees.".to_string(),
                    ),
                    ..WorktreeProjection::default()
                },
            );
            return;
        };

        let now = self.next_timestamp();
        let response = host.call::<_, serde_json::Value>(
            methods::GIT_WORKTREES,
            &GitWorktreesRequest {
                repo_path: repo_path.clone(),
            },
        );
        let projection = match response {
            Ok(value) => WorktreeProjection {
                entries: parse_worktree_entries(value, &repo_path, thread.worktree_path.as_deref()),
                repo_path: Some(repo_path),
                error: None,
                updated_at: Some(now),
                last_created_path: self
                    .worktree_snapshots
                    .get(&thread.project_id)
                    .and_then(|projection| projection.last_created_path.clone()),
            },
            Err(error) => WorktreeProjection {
                repo_path: Some(repo_path),
                error: Some(format!("Failed to list Git worktrees: {error}")),
                updated_at: Some(now),
                ..WorktreeProjection::default()
            },
        };
        self.worktree_snapshots
            .insert(thread.project_id, projection);
    }

    pub fn create_active_worktree(&mut self, host: Option<&BackendHostClient>) {
        let Some(thread) = self.active_thread().cloned() else {
            return;
        };
        let Some(repo_path) = self.review_repo_path(&thread) else {
            self.worktree_snapshots.insert(
                thread.project_id,
                WorktreeProjection {
                    error: Some("No project workspace is available for this thread.".to_string()),
                    ..WorktreeProjection::default()
                },
            );
            return;
        };
        let Some(host) = self.host.clone().or_else(|| host.cloned()) else {
            self.worktree_snapshots.insert(
                thread.project_id,
                WorktreeProjection {
                    repo_path: Some(repo_path),
                    error: Some(
                        "Connect to a host runtime before creating a Git worktree.".to_string(),
                    ),
                    ..WorktreeProjection::default()
                },
            );
            return;
        };

        let preferred_branch = suggested_worktree_branch(&thread);
        let start_point = thread.branch.clone();
        match host.call::<_, serde_json::Value>(
            methods::GIT_WORKTREES_CREATE,
            &GitWorktreeCreateRequest {
                repo_path: repo_path.clone(),
                preferred_branch,
                start_point,
            },
        ) {
            Ok(value) => {
                let created_path = value
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string);
                self.refresh_active_worktrees(Some(&host));
                if let Some(created_path) = created_path {
                    self.worktree_snapshots
                        .entry(thread.project_id)
                        .or_insert_with(|| WorktreeProjection {
                            repo_path: Some(repo_path),
                            ..WorktreeProjection::default()
                        })
                        .last_created_path = Some(created_path);
                }
            }
            Err(error) => {
                let updated_at = self.next_timestamp();
                self.worktree_snapshots.insert(
                    thread.project_id,
                    WorktreeProjection {
                        repo_path: Some(repo_path),
                        error: Some(format!("Failed to create Git worktree: {error}")),
                        updated_at: Some(updated_at),
                        ..WorktreeProjection::default()
                    },
                );
            }
        }
    }

    pub fn remove_active_worktree(
        &mut self,
        host: Option<&BackendHostClient>,
        path: String,
        force: bool,
    ) {
        let Some(thread) = self.active_thread().cloned() else {
            return;
        };
        let Some(repo_path) = self.review_repo_path(&thread) else {
            self.worktree_snapshots.insert(
                thread.project_id,
                WorktreeProjection {
                    error: Some("No project workspace is available for this thread.".to_string()),
                    ..WorktreeProjection::default()
                },
            );
            return;
        };
        let Some(host) = self.host.clone().or_else(|| host.cloned()) else {
            self.worktree_snapshots.insert(
                thread.project_id,
                WorktreeProjection {
                    repo_path: Some(repo_path),
                    error: Some(
                        "Connect to a host runtime before removing a Git worktree.".to_string(),
                    ),
                    ..WorktreeProjection::default()
                },
            );
            return;
        };

        match host.call::<_, serde_json::Value>(
            methods::GIT_WORKTREES_REMOVE,
            &GitWorktreeRemoveRequest {
                repo_path: repo_path.clone(),
                path,
                force,
            },
        ) {
            Ok(_) => self.refresh_active_worktrees(Some(&host)),
            Err(error) => {
                let updated_at = self.next_timestamp();
                self.worktree_snapshots.insert(
                    thread.project_id,
                    WorktreeProjection {
                        repo_path: Some(repo_path),
                        error: Some(format!("Failed to remove Git worktree: {error}")),
                        updated_at: Some(updated_at),
                        ..WorktreeProjection::default()
                    },
                );
            }
        }
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

    pub fn run_active_project_tests(&mut self, host: Option<&BackendHostClient>) {
        self.run_active_project_command(host, ProjectActionKind::Tests);
    }

    pub fn run_active_project_lint(&mut self, host: Option<&BackendHostClient>) {
        self.run_active_project_command(host, ProjectActionKind::Lint);
    }

    fn run_active_project_command(
        &mut self,
        host: Option<&BackendHostClient>,
        action: ProjectActionKind,
    ) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let Some(command) = self.active_project_action_command(&thread_id, action) else {
            self.terminal_errors.insert(
                thread_id,
                "No active project is available for this action.".to_string(),
            );
            return;
        };
        self.terminal_inputs.insert(thread_id, command);
        self.send_active_terminal_input(host);
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
        let inherited_composer = self.active_composer_draft_for_project(project_id);
        let mut options = resolve_thread_creation_options(
            project_id,
            active,
            &CreationContext {
                active_thread_id: self.metadata.active_thread_id.clone(),
                active_draft,
                default_env_mode: ExecutionLocation::Local,
            },
        );
        if let Some(composer) = inherited_composer.as_ref() {
            options.runtime_mode = composer.runtime_mode;
            options.interaction_mode = composer.interaction_mode;
        }

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
            pinned_item_count: 0,
            highlighted_count: 0,
            todo_count: 0,
            open_todo_count: 0,
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
        let mut composer = ComposerDraft::empty(thread_id.clone(), created_at);
        composer.runtime_mode = options.runtime_mode;
        composer.interaction_mode = options.interaction_mode;
        if let Some(source) = inherited_composer.as_ref() {
            copy_composer_turn_settings(&mut composer, source);
        }
        if let Some(selection) = self
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .and_then(|project| project.default_model_selection.clone())
        {
            composer.model_selection = selection.into();
        }
        self.composer_drafts.insert(thread_id.clone(), composer);
        self.threads.push(thread);
        *self.thread_counts.entry(project_id).or_insert(0) += 1;
        self.project_thread_limits
            .entry(project_id)
            .and_modify(|limit| *limit = (*limit + 1).max(INITIAL_PROJECT_THREAD_LIMIT))
            .or_insert(INITIAL_PROJECT_THREAD_LIMIT);
        self.open_thread(thread_id.clone());
        thread_id
    }

    fn active_composer_draft_for_project(&self, project_id: ProjectId) -> Option<ComposerDraft> {
        let active_thread_id = self.metadata.active_thread_id.as_ref()?;
        self.threads
            .iter()
            .find(|thread| &thread.id == active_thread_id)
            .filter(|thread| thread.project_id == project_id)?;
        self.composer_drafts.get(active_thread_id).cloned()
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
        let draft = self
            .composer_drafts
            .get(&thread_id)
            .cloned()
            .unwrap_or_else(|| ComposerDraft::empty(thread_id.clone(), now.clone()));
        let model_selection = draft.model_selection.clone();
        let reasoning_effort = draft.reasoning_effort;
        let permission_mode = draft.permission_mode;
        let host_selection = draft.host_selection.clone();
        let traits = draft.traits.clone();
        let context = draft.context.clone();

        if let Some(thread) = self
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id && !thread.archived)
        {
            thread.provider = model_selection.provider;
            thread.model = Some(model_selection.model.clone());
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

        let input_items = self.composer_turn_input(&thread_id, trimmed, &draft);
        self.persisted_messages
            .entry(thread_id.clone())
            .or_default()
            .push(chat_message_with_settings(
                format!("{now}-user"),
                ChatMessageRole::User,
                trimmed.to_string(),
                Some(composer_status_line(&draft)),
            ));

        let turn_result = self.start_backend_turn(&thread_id, &draft, input_items);
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

        self.record_composer_history(&thread_id, trimmed);
        self.project_drafts.retain(|_, id| id != &thread_id);
        self.thread_drafts.remove(&thread_id);
        let mut next_draft = ComposerDraft::empty(thread_id.clone(), now);
        next_draft.model_selection = model_selection;
        next_draft.host_selection = host_selection;
        next_draft.reasoning_effort = reasoning_effort;
        next_draft.permission_mode = permission_mode;
        next_draft.traits = traits;
        next_draft.context = context;
        next_draft.runtime_mode = draft.runtime_mode;
        next_draft.interaction_mode = draft.interaction_mode;
        self.composer_drafts.insert(thread_id, next_draft);
    }

    fn composer_turn_input(
        &self,
        thread_id: &ThreadId,
        prompt: &str,
        draft: &ComposerDraft,
    ) -> Vec<serde_json::Value> {
        let mut input = Vec::new();
        if let Some(traits) = composer_traits_text(&draft.traits) {
            input.push(serde_json::json!({ "type": "text", "text": traits }));
        }
        if let Some(commands) = self.composer_command_context_text(prompt) {
            input.push(serde_json::json!({ "type": "text", "text": commands }));
        }
        if let Some(context) = self.composer_context_text(thread_id, &draft.context) {
            input.push(serde_json::json!({ "type": "text", "text": context }));
        }
        if let Some(context) = self.composer_mention_context_text(thread_id, prompt) {
            input.push(serde_json::json!({ "type": "text", "text": context }));
        }
        input.push(serde_json::json!({ "type": "text", "text": prompt }));
        input
    }

    #[must_use]
    pub fn composer_commands_for_prompt(&self, prompt: &str) -> Vec<ComposerCommandProjection> {
        composer_command_tokens(prompt)
            .into_iter()
            .filter_map(|token| self.composer_command_for_token(&token))
            .collect()
    }

    fn composer_command_context_text(&self, prompt: &str) -> Option<String> {
        let commands = self.composer_commands_for_prompt(prompt);
        if commands.is_empty() {
            return None;
        }

        let lines = commands
            .iter()
            .map(|command| {
                let provider = command
                    .provider
                    .as_deref()
                    .map(|provider| format!(" · {provider}"))
                    .unwrap_or_default();
                format!(
                    "- {}{}: {}",
                    command.source.label(),
                    provider,
                    command.description
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        Some(format!(
            "Composer command selections for this turn:\n{lines}\nTreat these as explicit user-selected tool, skill, plugin, or provider command context."
        ))
    }

    fn composer_command_for_token(&self, token: &str) -> Option<ComposerCommandProjection> {
        if token.starts_with('/') {
            return self.provider_slash_command_for_token(token);
        }
        if let Some(name) = token.strip_prefix('$') {
            return registry_command_for_token(
                token,
                name,
                ComposerCommandSource::Skill,
                &self.skill_registry,
            );
        }
        let name = token.strip_prefix('@')?;
        if composer_context_mention_token(token) {
            return None;
        }
        registry_command_for_token(
            token,
            name,
            ComposerCommandSource::Plugin,
            &self.plugin_registry,
        )
    }

    fn provider_slash_command_for_token(&self, token: &str) -> Option<ComposerCommandProjection> {
        let normalized = token.trim_end_matches('/').to_ascii_lowercase();
        self.provider_registry
            .commands
            .iter()
            .find(|command| {
                let name = format!("/{}", command.name).to_ascii_lowercase();
                let prompt_prefix = command
                    .prompt_prefix
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                normalized == name || (!prompt_prefix.is_empty() && normalized == prompt_prefix)
            })
            .map(|command| {
                let description = command.input_hint.as_ref().map_or_else(
                    || command.description.clone(),
                    |hint| format!("{} · {}", command.description, hint),
                );
                ComposerCommandProjection {
                    token: token.to_string(),
                    source: ComposerCommandSource::ProviderSlash,
                    name: command.name.clone(),
                    description,
                    provider: Some(command.provider.clone()),
                }
            })
    }

    fn composer_context_text(
        &self,
        thread_id: &ThreadId,
        context: &[ComposerContextKind],
    ) -> Option<String> {
        if context.is_empty() {
            return None;
        }

        let mut sections = Vec::new();
        if context.contains(&ComposerContextKind::Pinned) {
            let items = self
                .pinned_items
                .iter()
                .filter(|item| &item.thread_id == thread_id)
                .take(8)
                .map(|item| format!("- {}: {}", item.display_title, item.display_excerpt))
                .collect::<Vec<_>>();
            if !items.is_empty() {
                sections.push(format!("Pinned context:\n{}", items.join("\n")));
            }
        }
        if context.contains(&ComposerContextKind::Highlights) {
            let items = self
                .highlighted_items
                .iter()
                .filter(|item| &item.thread_id == thread_id)
                .take(8)
                .map(|item| format!("- {}: {}", item.display_title, item.display_excerpt))
                .collect::<Vec<_>>();
            if !items.is_empty() {
                sections.push(format!("Highlighted context:\n{}", items.join("\n")));
            }
        }
        if context.contains(&ComposerContextKind::Todos) {
            let items = self
                .todos
                .iter()
                .filter(|todo| &todo.thread_id == thread_id)
                .take(12)
                .map(|todo| format!("- {}", todo_context_line(todo)))
                .collect::<Vec<_>>();
            if !items.is_empty() {
                sections.push(format!("Todo context:\n{}", items.join("\n")));
            }
        }
        if context.contains(&ComposerContextKind::Terminal) {
            let terminal = self
                .terminal_sessions
                .iter()
                .find(|(key, session)| {
                    key.thread_id == thread_id.0 && !session.history.trim().is_empty()
                })
                .map(|(_, session)| tail_chars(&session.history, 2_000));
            if let Some(terminal) = terminal.filter(|terminal| !terminal.trim().is_empty()) {
                sections.push(format!("Recent terminal output:\n{terminal}"));
            }
        }

        (!sections.is_empty()).then(|| {
            format!(
                "Attached composer context for this turn:\n\n{}",
                sections.join("\n\n")
            )
        })
    }

    fn composer_mention_context_text(&self, thread_id: &ThreadId, prompt: &str) -> Option<String> {
        let mentions = composer_mentions(prompt);
        if mentions.is_empty() {
            return None;
        }

        let mut sections = Vec::new();
        for mention in mentions {
            if let Some(id) = mention.strip_prefix("@todo:") {
                if let Some(todo) = self
                    .todos
                    .iter()
                    .find(|todo| &todo.thread_id == thread_id && todo.id == id)
                {
                    sections.push(format!(
                        "Mentioned todo {}: {}",
                        todo.id,
                        todo_context_line(todo)
                    ));
                }
            } else if let Some(id) = mention.strip_prefix("@pin:") {
                if let Some(item) = self
                    .pinned_items
                    .iter()
                    .find(|item| &item.thread_id == thread_id && item.id == id)
                {
                    sections.push(format!(
                        "Mentioned pinned context {}: {} - {}",
                        item.id, item.display_title, item.display_excerpt
                    ));
                }
            } else if let Some(id) = mention.strip_prefix("@highlight:") {
                if let Some(item) = self
                    .highlighted_items
                    .iter()
                    .find(|item| &item.thread_id == thread_id && item.id == id)
                {
                    sections.push(format!(
                        "Mentioned highlighted context {}: {} - {}",
                        item.id, item.display_title, item.display_excerpt
                    ));
                }
            } else if let Some(id) = mention.strip_prefix("@review:") {
                if let Some(comment) = self
                    .review_comments
                    .iter()
                    .find(|comment| &comment.thread_id == thread_id && comment.id == id)
                {
                    sections.push(format!(
                        "Mentioned review comment {} on {}: {}",
                        comment.id,
                        comment.file_path,
                        review_comment_detail(comment)
                    ));
                }
            } else if mention == "@terminal" {
                if let Some(session) = self
                    .terminal_sessions
                    .get(&TerminalKey::default_for_thread(thread_id))
                    .filter(|session| !session.history.trim().is_empty())
                {
                    sections.push(format!(
                        "Mentioned terminal output from {}:\n{}",
                        session.cwd,
                        tail_chars(&session.history, 4_000)
                    ));
                }
            } else if mention == "@diff"
                && let Some(thread) = self.threads.iter().find(|thread| &thread.id == thread_id)
                && let Some(review) = self.review_snapshots.get(&thread.project_id)
                && !review.files.is_empty()
            {
                let files = review
                    .files
                    .iter()
                    .map(|file| {
                        format!(
                            "- {} (+{} -{})",
                            file.path,
                            file.additions.unwrap_or_default(),
                            file.deletions.unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                sections.push(format!("Mentioned diff context:\n{files}"));
            }
        }

        (!sections.is_empty()).then(|| {
            format!(
                "Mentioned composer context for this turn:\n\n{}",
                sections.join("\n\n")
            )
        })
    }

    fn start_backend_turn(
        &mut self,
        thread_id: &ThreadId,
        draft: &ComposerDraft,
        input: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        let Some(host) = self.host.clone() else {
            return Ok(());
        };
        let provider_thread_id =
            self.ensure_provider_thread(&host, thread_id, &draft.model_selection.model)?;
        let permissions = permission_payload(draft.permission_mode);
        let reasoning_effort = draft.reasoning_effort.map(ReasoningEffort::provider_value);
        let collaboration_mode = composer_collaboration_mode(draft, reasoning_effort, &permissions);
        let mut payload = serde_json::json!({
            "thread_id": provider_thread_id,
            "input": input,
            "model": draft.model_selection.model,
            "sandbox_policy": permissions.sandbox_policy.clone(),
            "approval_policy": permissions.approval_policy.clone(),
            "collaboration_mode": collaboration_mode,
        });
        if let Some(reviewer) = permissions.approvals_reviewer {
            payload["approvals_reviewer"] = serde_json::Value::String(reviewer.to_string());
        }
        if let Some(effort) = reasoning_effort {
            payload["reasoning_effort"] = serde_json::Value::String(effort.to_string());
        }
        if let Some(cwd) = self.composer_cwd_for_thread(thread_id, draft.runtime_mode) {
            payload["cwd"] = serde_json::Value::String(cwd);
        }
        match draft.runtime_mode {
            RuntimeMode::Local => {
                payload["executionLocation"] = serde_json::Value::String("local".to_string());
            }
            RuntimeMode::Worktree => {
                payload["executionLocation"] = serde_json::Value::String("worktree".to_string());
            }
            RuntimeMode::Remote => {
                let Some(selection) = draft.host_selection.as_ref() else {
                    return Err(
                        "Select a connected remote host before sending in Remote mode.".to_string(),
                    );
                };
                if !self.remote_host_is_connected(selection) {
                    return Err(format!(
                        "Remote host {} is not connected.",
                        selection.host_id
                    ));
                }
                payload["executionLocation"] = serde_json::Value::String("remote_host".to_string());
                payload["remoteHost"] = serde_json::Value::String(selection.host_id.clone());
            }
            RuntimeMode::Normal => {}
        }
        host.call::<_, serde_json::Value>(methods::CODEX_TURN_START, &payload)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn ensure_provider_thread(
        &mut self,
        host: &BackendHostClient,
        thread_id: &ThreadId,
        model: &str,
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
                    "model": model,
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
        match event {
            ProviderRuntimeEvent::ThreadItem { item } => {
                self.apply_provider_thread_item(*item, sequence)
            }
            ProviderRuntimeEvent::ServerRequest { request } => {
                self.upsert_pending_approval(*request);
            }
            ProviderRuntimeEvent::ServerRequestResolved {
                provider,
                request_id,
                ..
            } => {
                self.resolve_pending_approval(&provider, &request_id);
            }
            ProviderRuntimeEvent::ToolStarted { tool }
            | ProviderRuntimeEvent::ToolUpdated { tool }
            | ProviderRuntimeEvent::ToolCompleted { tool }
            | ProviderRuntimeEvent::ToolFailed { tool, .. }
            | ProviderRuntimeEvent::ToolApprovalRequested { tool } => {
                self.apply_semantic_tool(*tool, sequence);
            }
            ProviderRuntimeEvent::ToolOutputDelta { tool, .. } => {
                self.apply_semantic_tool(*tool, sequence);
            }
            _ => {}
        }
    }

    fn apply_semantic_tool(&mut self, tool: SemanticToolCall, sequence: Option<i64>) {
        if tool.surface != ToolSurface::Browser {
            return;
        }
        let Some(thread_id) = tool
            .provider
            .thread_id
            .as_deref()
            .and_then(|id| self.local_thread_id_for_provider(id))
            .or_else(|| self.metadata.active_thread_id.clone())
        else {
            return;
        };
        let activity =
            browser_activity_from_tool(thread_id, &tool, sequence, self.next_timestamp());
        if let Some(existing) = self
            .browser_activities
            .iter_mut()
            .find(|existing| existing.id == activity.id)
        {
            *existing = activity;
        } else {
            self.browser_activities.push(activity);
        }
        if self.browser_activities.len() > MAX_BROWSER_ACTIVITIES {
            let overflow = self.browser_activities.len() - MAX_BROWSER_ACTIVITIES;
            self.browser_activities.drain(0..overflow);
        }
        self.browser.updated_at = Some(self.next_timestamp());
    }

    fn apply_provider_thread_item(
        &mut self,
        item: ace_runtime::provider::NormalizedThreadItem,
        sequence: Option<i64>,
    ) {
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
        let id = item
            .item_id
            .clone()
            .unwrap_or_else(|| format!("provider-{}", sequence.unwrap_or_default()));
        self.upsert_provider_artifacts(
            &thread_id,
            &id,
            item.attachments.as_ref(),
            sequence,
            item.title.as_deref(),
            item.url.as_deref(),
        );
        let Some(text) = item.text.clone().filter(|text| !text.trim().is_empty()) else {
            return;
        };
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
            turn_settings_summary: None,
        });
        self.mark_thread_status(&thread_id, ThreadStatus::Working);
    }

    fn upsert_provider_artifacts(
        &mut self,
        thread_id: &ThreadId,
        message_id: &str,
        attachments: Option<&serde_json::Value>,
        sequence: Option<i64>,
        fallback_title: Option<&str>,
        fallback_url: Option<&str>,
    ) {
        let Some(attachments) = attachments else {
            return;
        };
        let observed_at = sequence
            .map(|sequence| sequence.to_string())
            .unwrap_or_else(|| self.next_timestamp());
        for artifact in parse_artifact_items(
            thread_id,
            message_id,
            attachments,
            &observed_at,
            fallback_title,
            fallback_url,
        ) {
            if let Some(existing) = self
                .artifacts
                .iter_mut()
                .find(|existing| existing.id == artifact.id)
            {
                *existing = artifact;
            } else {
                self.artifacts.push(artifact);
            }
        }
    }

    fn upsert_pending_approval(&mut self, request: NormalizedServerRequest) {
        let item = approval_item_from_request(&request);
        if let Some(existing) = self.approval_registry.pending.iter_mut().find(|approval| {
            approval.provider == item.provider && approval.request_id == item.request_id
        }) {
            *existing = item;
        } else {
            self.approval_registry.pending.push(item);
        }
        self.runtime_status.pending_approvals = self.approval_registry.pending.len();
        self.approval_registry.updated_at = Some(self.next_timestamp());
    }

    fn resolve_pending_approval(&mut self, provider: &str, request_id: &str) {
        let before = self.approval_registry.pending.len();
        self.approval_registry.pending.retain(|approval| {
            !(approval.provider == provider && approval.request_id == request_id)
        });
        if self.approval_registry.pending.len() != before {
            self.approval_registry.resolved += 1;
        }
        self.runtime_status.pending_approvals = self.approval_registry.pending.len();
        self.approval_registry.updated_at = Some(self.next_timestamp());
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
        let now = self.next_timestamp();
        let Some(thread_id) = ({
            let draft = self.ensure_active_composer_draft(now.clone());
            draft.map(|draft| {
                let thread_id = draft.thread_id.clone();
                draft.prompt.push_str(input);
                draft.updated_at = now;
                thread_id
            })
        }) else {
            return;
        };
        self.clear_composer_history_cursor(&thread_id);
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
        self.clear_composer_history_cursor(&thread_id);
    }

    pub fn recall_active_composer_history(&mut self, previous: bool) {
        let Some(thread_id) = self.metadata.active_thread_id.clone() else {
            return;
        };
        let Some(history) = self.composer_histories.get(&thread_id).cloned() else {
            return;
        };
        if history.is_empty() {
            return;
        }

        let now = self.next_timestamp();
        let history_len = history.len();
        let current_position = self
            .composer_history_positions
            .get(&thread_id)
            .copied()
            .unwrap_or(history_len);
        let entering_history = !self.composer_history_positions.contains_key(&thread_id);
        if entering_history {
            let scratch = self
                .composer_drafts
                .get(&thread_id)
                .map(|draft| draft.prompt.clone())
                .unwrap_or_default();
            self.composer_history_scratch
                .insert(thread_id.clone(), scratch);
        }

        let next_position = if previous {
            current_position.saturating_sub(1)
        } else {
            (current_position + 1).min(history_len)
        };

        let prompt = if next_position == history_len {
            self.composer_history_positions.remove(&thread_id);
            self.composer_history_scratch
                .remove(&thread_id)
                .unwrap_or_default()
        } else if let Some(prompt) = history.get(next_position) {
            self.composer_history_positions
                .insert(thread_id.clone(), next_position);
            prompt.clone()
        } else {
            return;
        };

        let Some(draft) = self.ensure_active_composer_draft(now.clone()) else {
            return;
        };
        draft.prompt = prompt;
        draft.updated_at = now;
    }

    pub fn complete_active_composer_token(&mut self, completion: &str) {
        let completion = completion.trim();
        if completion.is_empty() {
            return;
        }
        let now = self.next_timestamp();
        let Some(thread_id) = ({
            let draft = self.ensure_active_composer_draft(now.clone());
            draft.map(|draft| {
                let token_start = draft
                    .prompt
                    .char_indices()
                    .rev()
                    .find(|(_, ch)| ch.is_whitespace())
                    .map_or(0, |(index, ch)| index + ch.len_utf8());
                draft.prompt.truncate(token_start);
                draft.prompt.push_str(completion);
                if !draft.prompt.ends_with(' ') {
                    draft.prompt.push(' ');
                }
                draft.updated_at = now;
                draft.thread_id.clone()
            })
        }) else {
            return;
        };
        self.clear_composer_history_cursor(&thread_id);
    }

    pub fn set_active_composer_model(&mut self, provider: ProviderKind, model: String) {
        let supports_reasoning = self.model_supports_reasoning(provider, &model);
        let now = self.next_timestamp();
        let Some(draft) = self.ensure_active_composer_draft(now.clone()) else {
            return;
        };
        draft.model_selection = ProviderModelSelection { provider, model };
        match supports_reasoning {
            Some(true) if draft.reasoning_effort.is_none() => {
                draft.reasoning_effort = Some(ReasoningEffort::Medium);
            }
            Some(false) => {
                draft.reasoning_effort = None;
            }
            _ => {}
        }
        draft.updated_at = now;
    }

    pub fn set_active_project_default_model(&mut self, host: Option<&BackendHostClient>) {
        let Some(thread) = self.active_thread().cloned() else {
            return;
        };
        let Some(selection) = self.active_model_selection_for_thread(&thread) else {
            return;
        };
        let now = self.next_timestamp();
        if let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.id == thread.project_id)
        {
            project.default_model_selection = Some(selection.clone());
            project.updated_at = now;
        }

        let Some(host) = self.host.clone().or_else(|| host.cloned()) else {
            return;
        };
        let request = ProjectUpdateRequest {
            project_id: thread.project_id,
            title: None,
            workspace_root: None,
            default_model_selection: Some(Some(selection)),
            scripts: None,
            icon: None,
            archived_at: None,
        };
        if let Err(error) = host.call::<_, serde_json::Value>(methods::PROJECTS_UPDATE, &request) {
            self.runtime_status.error =
                Some(format!("Failed to save project default model: {error}"));
            self.runtime_status.updated_at = Some(self.next_timestamp());
        }
    }

    pub fn set_active_composer_reasoning(&mut self, effort: Option<ReasoningEffort>) {
        let now = self.next_timestamp();
        let Some(draft) = self.ensure_active_composer_draft(now.clone()) else {
            return;
        };
        draft.reasoning_effort = effort;
        draft.updated_at = now;
    }

    pub fn set_active_composer_permission(&mut self, permission: ComposerPermissionMode) {
        let now = self.next_timestamp();
        let Some(draft) = self.ensure_active_composer_draft(now.clone()) else {
            return;
        };
        draft.permission_mode = permission;
        draft.updated_at = now;
    }

    pub fn toggle_active_composer_trait(&mut self, trait_kind: ComposerTrait) {
        let now = self.next_timestamp();
        let Some(draft) = self.ensure_active_composer_draft(now.clone()) else {
            return;
        };
        toggle_vec_value(&mut draft.traits, trait_kind);
        draft.updated_at = now;
    }

    pub fn toggle_active_composer_context(&mut self, context: ComposerContextKind) {
        let now = self.next_timestamp();
        let Some(draft) = self.ensure_active_composer_draft(now.clone()) else {
            return;
        };
        toggle_vec_value(&mut draft.context, context);
        draft.updated_at = now;
    }

    pub fn set_active_composer_runtime_mode(&mut self, runtime_mode: RuntimeMode) {
        let now = self.next_timestamp();
        let Some(thread_id) = self.ensure_active_thread() else {
            return;
        };
        let default_remote = (runtime_mode == RuntimeMode::Remote)
            .then(|| self.first_connected_remote_host())
            .flatten();
        let draft = self
            .composer_drafts
            .entry(thread_id.clone())
            .or_insert_with(|| ComposerDraft::empty(thread_id.clone(), now.clone()));
        draft.runtime_mode = runtime_mode;
        if runtime_mode == RuntimeMode::Remote {
            if draft.host_selection.is_none() {
                draft.host_selection = default_remote;
            }
        } else {
            draft.host_selection = None;
        }
        draft.updated_at = now.clone();
        if let Some(thread_draft) = self.thread_drafts.get_mut(&thread_id) {
            thread_draft.runtime_mode = runtime_mode;
        }
    }

    pub fn set_active_composer_interaction_mode(&mut self, interaction_mode: InteractionMode) {
        let now = self.next_timestamp();
        let Some(thread_id) = self.ensure_active_thread() else {
            return;
        };
        let draft = self
            .composer_drafts
            .entry(thread_id.clone())
            .or_insert_with(|| ComposerDraft::empty(thread_id.clone(), now.clone()));
        draft.interaction_mode = interaction_mode;
        draft.updated_at = now.clone();
        if let Some(thread_draft) = self.thread_drafts.get_mut(&thread_id) {
            thread_draft.interaction_mode = interaction_mode;
        }
    }

    pub fn set_active_composer_host(&mut self, selection: Option<ComposerHostSelection>) {
        if selection
            .as_ref()
            .is_some_and(|selection| !self.remote_host_is_connected(selection))
        {
            return;
        }

        let now = self.next_timestamp();
        let Some(thread_id) = self.ensure_active_thread() else {
            return;
        };
        let draft = self
            .composer_drafts
            .entry(thread_id.clone())
            .or_insert_with(|| ComposerDraft::empty(thread_id.clone(), now.clone()));
        draft.host_selection = selection;
        draft.runtime_mode = if draft.host_selection.is_some() {
            RuntimeMode::Remote
        } else if draft.runtime_mode == RuntimeMode::Remote {
            RuntimeMode::Local
        } else {
            draft.runtime_mode
        };
        let runtime_mode = draft.runtime_mode;
        draft.updated_at = now.clone();
        if let Some(thread_draft) = self.thread_drafts.get_mut(&thread_id) {
            thread_draft.runtime_mode = runtime_mode;
        }
    }

    fn ensure_active_thread(&mut self) -> Option<ThreadId> {
        if let Some(thread_id) = self.metadata.active_thread_id.clone() {
            return Some(thread_id);
        }
        let project_id = self.projects.first().map(|project| project.id)?;
        Some(self.new_thread(project_id))
    }

    fn ensure_active_composer_draft(&mut self, now: String) -> Option<&mut ComposerDraft> {
        let thread_id = self.ensure_active_thread()?;
        Some(
            self.composer_drafts
                .entry(thread_id.clone())
                .or_insert_with(|| ComposerDraft::empty(thread_id, now)),
        )
    }

    fn model_supports_reasoning(&self, provider: ProviderKind, model: &str) -> Option<bool> {
        self.model_registry
            .providers
            .iter()
            .find(|catalog| ProviderKind::from_runtime_id(&catalog.runtime_id) == Some(provider))
            .and_then(|catalog| {
                catalog
                    .models
                    .iter()
                    .find(|entry| entry.id == model)
                    .map(|entry| entry.supports_reasoning)
            })
    }

    fn active_model_selection_for_thread(&self, thread: &ThreadSummary) -> Option<ModelSelection> {
        self.composer_drafts
            .get(&thread.id)
            .map(|draft| ModelSelection {
                provider: draft.model_selection.provider.runtime_id().to_string(),
                model: draft.model_selection.model.clone(),
            })
            .or_else(|| {
                thread.model.as_ref().map(|model| ModelSelection {
                    provider: thread.provider.runtime_id().to_string(),
                    model: model.clone(),
                })
            })
    }

    fn composer_cwd_for_thread(
        &self,
        thread_id: &ThreadId,
        runtime_mode: RuntimeMode,
    ) -> Option<String> {
        let thread = self.threads.iter().find(|thread| &thread.id == thread_id)?;
        match runtime_mode {
            RuntimeMode::Worktree => thread.worktree_path.clone().or_else(|| {
                self.projects
                    .iter()
                    .find(|project| project.id == thread.project_id)
                    .map(|project| project.workspace_root.clone())
            }),
            RuntimeMode::Local => self
                .projects
                .iter()
                .find(|project| project.id == thread.project_id)
                .map(|project| project.workspace_root.clone()),
            RuntimeMode::Normal | RuntimeMode::Remote => None,
        }
    }

    fn first_connected_remote_host(&self) -> Option<ComposerHostSelection> {
        self.runtime
            .remote_connections
            .iter()
            .filter(|connection| connection.execution_location == ExecutionLocation::RemoteHost)
            .filter(|connection| {
                connection
                    .status
                    .as_deref()
                    .is_some_and(is_connected_remote_status)
            })
            .min_by(|left, right| {
                left.display_name
                    .as_deref()
                    .unwrap_or(&left.host_id)
                    .cmp(right.display_name.as_deref().unwrap_or(&right.host_id))
                    .then_with(|| left.host_id.cmp(&right.host_id))
            })
            .map(|connection| ComposerHostSelection {
                provider: connection.provider.clone(),
                host_id: connection.host_id.clone(),
            })
    }

    fn remote_host_is_connected(&self, selection: &ComposerHostSelection) -> bool {
        self.runtime.remote_connections.iter().any(|connection| {
            connection.provider == selection.provider
                && connection.host_id == selection.host_id
                && connection.execution_location == ExecutionLocation::RemoteHost
                && connection
                    .status
                    .as_deref()
                    .is_some_and(is_connected_remote_status)
        })
    }

    fn record_composer_history(&mut self, thread_id: &ThreadId, prompt: &str) {
        let history = self
            .composer_histories
            .entry(thread_id.clone())
            .or_default();
        if history.last().is_none_or(|last| last != prompt) {
            history.push(prompt.to_string());
        }
        const MAX_COMPOSER_HISTORY: usize = 100;
        if history.len() > MAX_COMPOSER_HISTORY {
            let overflow = history.len() - MAX_COMPOSER_HISTORY;
            history.drain(0..overflow);
        }
        self.clear_composer_history_cursor(thread_id);
    }

    fn clear_composer_history_cursor(&mut self, thread_id: &ThreadId) {
        self.composer_history_positions.remove(thread_id);
        self.composer_history_scratch.remove(thread_id);
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
        self.composer_histories.remove(&thread_id);
        self.composer_history_positions.remove(&thread_id);
        self.composer_history_scratch.remove(&thread_id);
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
            self.toggle_pin_thread(thread_id);
        }
    }

    pub fn toggle_pin_thread(&mut self, thread_id: ThreadId) {
        let pinned = !self.metadata.pinned_thread_ids.contains(&thread_id);
        self.pin_thread(thread_id, pinned);
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
        self.composer_histories
            .retain(|thread_id, _| self.threads.iter().any(|thread| &thread.id == thread_id));
        self.composer_history_positions
            .retain(|thread_id, _| self.threads.iter().any(|thread| &thread.id == thread_id));
        self.composer_history_scratch
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
                        turn_settings_summary: None,
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
                        turn_settings_summary: None,
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

    fn active_project_action_command(
        &self,
        thread_id: &ThreadId,
        action: ProjectActionKind,
    ) -> Option<String> {
        let thread = self.threads.iter().find(|thread| &thread.id == thread_id)?;
        let project = self
            .projects
            .iter()
            .find(|project| project.id == thread.project_id)?;
        project
            .scripts
            .iter()
            .find(|script| project_script_matches_action(script, action))
            .map(|script| script.command.clone())
            .or_else(|| Some(default_project_action_command(action).to_string()))
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
    chat_message_with_settings(id, role, text, None)
}

fn chat_message_with_settings(
    id: String,
    role: ChatMessageRole,
    text: String,
    turn_settings_summary: Option<String>,
) -> ChatMessageProjection {
    ChatMessageProjection {
        id,
        role,
        status: ThreadItemStatus::Completed,
        title: None,
        text: Some(text),
        turn_settings_summary,
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

fn host_option_projection(connection: &RemoteConnectionRecord) -> HostOptionProjection {
    let status = connection
        .status
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let project_count = json_collection_len(&connection.projects);
    let label = connection
        .display_name
        .clone()
        .or_else(|| connection.host.clone())
        .unwrap_or_else(|| connection.host_id.clone());
    let mut detail = connection.host.as_ref().map_or_else(
        || format!("{} · {}", connection.provider, status),
        |host| format!("{} · {} · {}", connection.provider, host, status),
    );
    if project_count > 0 {
        detail.push_str(&format!(
            " · {project_count} project{}",
            plural(project_count)
        ));
    }

    HostOptionProjection {
        provider: connection.provider.clone(),
        host_id: connection.host_id.clone(),
        label,
        detail,
        connected: is_connected_remote_status(&status),
        status,
        execution_location: connection.execution_location,
        project_count,
    }
}

fn is_connected_remote_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "connected" | "online" | "ready"
    )
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

fn approval_registry_projection_from_state(
    response: &ProviderRuntimeStateGetResponse,
    updated_at: String,
) -> ApprovalRegistryProjection {
    let mut pending = Vec::new();
    let mut resolved = 0;
    for provider in &response.providers {
        for approval in &provider.state.approvals {
            match approval.status {
                ApprovalStatus::Pending => pending.push(approval_item_projection(approval)),
                ApprovalStatus::Resolved => resolved += 1,
            }
        }
    }
    pending.sort_by(|left, right| {
        left.provider
            .cmp(&right.provider)
            .then_with(|| left.request_id.cmp(&right.request_id))
    });

    ApprovalRegistryProjection {
        pending,
        resolved,
        error: None,
        updated_at: Some(updated_at),
    }
}

fn approval_item_projection(approval: &ApprovalRecord) -> ApprovalItemProjection {
    approval_item_from_request(&approval.request)
}

fn approval_item_from_request(request: &NormalizedServerRequest) -> ApprovalItemProjection {
    ApprovalItemProjection {
        provider: request.provider.provider.clone(),
        request_id: request.request_id.clone(),
        title: request
            .title
            .clone()
            .unwrap_or_else(|| server_request_kind_label(request.kind).to_string()),
        prompt: request
            .prompt
            .clone()
            .or_else(|| approval_detail_label(request))
            .unwrap_or_else(|| "Provider request is awaiting a decision.".to_string()),
        kind: server_request_kind_label(request.kind).to_string(),
        method: request.method.clone(),
        scope: request.scope.clone(),
        selected_policy: request.selected_policy.clone(),
        detail: approval_detail_label(request),
    }
}

fn server_request_kind_label(kind: ServerRequestKind) -> &'static str {
    match kind {
        ServerRequestKind::CommandApproval => "Command approval",
        ServerRequestKind::FileChangeApproval => "File change approval",
        ServerRequestKind::ToolUserInput => "Tool input",
        ServerRequestKind::McpElicitation => "MCP elicitation",
        ServerRequestKind::PermissionApproval => "Permission approval",
        ServerRequestKind::DynamicToolCall => "Dynamic tool",
        ServerRequestKind::AccountTokenRefresh => "Account token refresh",
        ServerRequestKind::Attestation => "Attestation",
        ServerRequestKind::ApplyPatchApproval => "Patch approval",
        ServerRequestKind::ExecApproval => "Command approval",
        ServerRequestKind::Unknown => "Provider request",
    }
}

fn approval_detail_label(request: &NormalizedServerRequest) -> Option<String> {
    request
        .detail
        .command
        .clone()
        .or_else(|| request.detail.argv.as_ref().map(|argv| argv.join(" ")))
        .or_else(|| request.detail.path.clone())
        .or_else(|| request.detail.paths.as_ref().map(|paths| paths.join(", ")))
        .or_else(|| request.detail.tool_name.clone())
        .or_else(|| request.detail.server_name.clone())
        .or_else(|| request.detail.operation.clone())
        .or_else(|| request.detail.permission.clone())
        .or_else(|| request.detail.resource.clone())
}

fn approval_audit(reason: &'static str) -> ProviderServerRequestAudit {
    ProviderServerRequestAudit {
        decided_by: Some("user".to_string()),
        reason: Some(reason.to_string()),
        metadata: serde_json::json!({ "surface": "desktop" }),
        ..ProviderServerRequestAudit::default()
    }
}

fn model_provider_projection(
    response: ProviderRuntimeModelsListResponse,
) -> ModelProviderProjection {
    let models = response
        .catalog
        .models
        .into_iter()
        .map(|model| ModelProjection {
            id: model.id,
            display_name: model.display_name,
            provider: model.provider,
            family: model.family,
            context_window: model.capabilities.context_window,
            max_output_tokens: model.capabilities.max_output_tokens,
            supports_reasoning: model.capabilities.supports_reasoning,
            supports_vision: model.capabilities.supports_vision,
            supports_tools: model.capabilities.supports_tools,
            supports_attachments: model.capabilities.supports_attachments,
        })
        .collect();

    ModelProviderProjection {
        runtime_id: response.runtime_id,
        display_name: response.display_name,
        provider: response.catalog.provider,
        models,
    }
}

fn model_selection_label(selection: &ModelSelection) -> String {
    ProviderKind::from_runtime_id(&selection.provider).map_or_else(
        || format!("{} · {}", selection.provider, selection.model),
        |provider| format!("{} · {}", provider.display_name(), selection.model),
    )
}

fn browser_projection_from_host_tools(
    response: &ProviderHostToolsListResponse,
    updated_at: String,
) -> BrowserProjection {
    let bridge = response
        .bridges
        .iter()
        .find(|bridge| bridge.surface == ToolSurface::Browser)
        .map(|bridge| BrowserBridgeProjection {
            status: match bridge.status {
                ProviderHostToolBridgeStatus::Connected => "connected",
                ProviderHostToolBridgeStatus::Unavailable => "unavailable",
                ProviderHostToolBridgeStatus::Missing => "missing",
            }
            .to_string(),
            descriptor_name: bridge.descriptor_name.clone(),
            aliases: bridge.aliases.clone(),
            actions: bridge
                .actions
                .iter()
                .map(|action| serde_name(*action))
                .collect(),
            capability_keys: bridge.capability_keys.clone(),
        });

    BrowserProjection {
        bridge,
        activities: Vec::new(),
        previews: Vec::new(),
        error: None,
        updated_at: Some(updated_at),
    }
}

fn browser_activity_from_tool(
    thread_id: ThreadId,
    tool: &SemanticToolCall,
    sequence: Option<i64>,
    observed_at: String,
) -> BrowserActivityProjection {
    let id = tool
        .provider
        .item_id
        .clone()
        .or_else(|| {
            tool.provider
                .turn_id
                .as_ref()
                .map(|turn| format!("{turn}:browser"))
        })
        .or_else(|| sequence.map(|sequence| format!("browser-seq-{sequence}")))
        .unwrap_or_else(|| format!("browser-{}", stable_store_id(&tool.display.title)));
    let mut detail = tool
        .display
        .summary
        .clone()
        .unwrap_or_else(|| serde_name(tool.action));
    if let Some(operation) = tool.provider.operation.as_deref().filter(|operation| {
        !operation.trim().is_empty() && !detail.to_ascii_lowercase().contains(operation)
    }) {
        detail = format!("{detail} · {operation}");
    }
    BrowserActivityProjection {
        id,
        thread_id,
        title: tool.display.title.clone(),
        detail,
        target: tool
            .display
            .target
            .as_ref()
            .map(|target| target.label.clone()),
        status: tool_status_label(tool.display.status).to_string(),
        turn_id: tool.provider.turn_id.clone(),
        observed_at,
    }
}

fn tool_status_label(status: ToolRunStatus) -> &'static str {
    match status {
        ToolRunStatus::Started => "started",
        ToolRunStatus::Updated => "updated",
        ToolRunStatus::Completed => "completed",
        ToolRunStatus::Failed => "failed",
        ToolRunStatus::ApprovalRequested => "approval requested",
    }
}

fn slash_command_projections(
    response: &ProviderRuntimeSlashCommandsListResponse,
) -> Vec<ProviderSlashCommandProjection> {
    response
        .providers
        .iter()
        .flat_map(|provider| {
            provider
                .commands
                .iter()
                .map(|command| ProviderSlashCommandProjection {
                    provider: provider.runtime_id.clone(),
                    name: command.name.clone(),
                    description: command
                        .description
                        .clone()
                        .unwrap_or_else(|| "Provider command".to_string()),
                    prompt_prefix: command.prompt_prefix.clone(),
                    input_hint: command.input_hint.clone(),
                    kind: command.kind.as_ref().map(|kind| format!("{kind:?}")),
                })
        })
        .collect()
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

fn parse_artifact_items(
    thread_id: &ThreadId,
    message_id: &str,
    value: &serde_json::Value,
    observed_at: &str,
    fallback_title: Option<&str>,
    fallback_url: Option<&str>,
) -> Vec<ArtifactItemProjection> {
    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                parse_artifact_item(
                    thread_id,
                    message_id,
                    item,
                    index,
                    observed_at,
                    fallback_title,
                    fallback_url,
                )
            })
            .collect(),
        _ => parse_artifact_item(
            thread_id,
            message_id,
            value,
            0,
            observed_at,
            fallback_title,
            fallback_url,
        )
        .into_iter()
        .collect(),
    }
}

fn parse_artifact_item(
    thread_id: &ThreadId,
    message_id: &str,
    value: &serde_json::Value,
    index: usize,
    observed_at: &str,
    fallback_title: Option<&str>,
    fallback_url: Option<&str>,
) -> Option<ArtifactItemProjection> {
    let (kind, title, url, path, mime_type) = match value {
        serde_json::Value::String(value) => {
            let title = value
                .rsplit(['/', '\\'])
                .next()
                .filter(|part| !part.is_empty())
                .unwrap_or("Attachment")
                .to_string();
            let url = value.contains("://").then(|| value.clone());
            let path = (!value.contains("://")).then(|| value.clone());
            ("artifact".to_string(), title, url, path, None)
        }
        serde_json::Value::Object(object) => {
            let url = string_field(object, &["url", "src", "href"]);
            let path = string_field(object, &["path", "file", "relative_path", "relativePath"]);
            let mime_type = string_field(object, &["mime_type", "mimeType", "contentType"]);
            let kind = string_field(object, &["kind", "type"])
                .or_else(|| artifact_kind_from_mime(mime_type.as_deref()).map(ToString::to_string))
                .unwrap_or_else(|| "artifact".to_string());
            let title = string_field(object, &["title", "name", "filename", "file_name"])
                .or_else(|| {
                    path.as_deref()
                        .or(url.as_deref())
                        .and_then(|value| value.rsplit(['/', '\\']).next())
                        .filter(|part| !part.is_empty())
                        .map(ToString::to_string)
                })
                .or_else(|| fallback_title.map(ToString::to_string))
                .unwrap_or_else(|| format!("Artifact {}", index + 1));
            (kind, title, url, path, mime_type)
        }
        _ => return None,
    };

    let url = url.or_else(|| fallback_url.map(ToString::to_string));
    let location = path
        .as_deref()
        .or(url.as_deref())
        .unwrap_or("provider attachment");
    let mime = mime_type
        .as_deref()
        .map(|mime| format!(" · {mime}"))
        .unwrap_or_default();
    Some(ArtifactItemProjection {
        id: format!("{message_id}:{index}"),
        thread_id: thread_id.clone(),
        message_id: message_id.to_string(),
        kind: kind.clone(),
        title,
        detail: format!("{kind} · {location}{mime}"),
        url,
        path,
        mime_type,
        observed_at: observed_at.to_string(),
    })
}

fn artifact_kind_from_mime(mime_type: Option<&str>) -> Option<&'static str> {
    let mime_type = mime_type?;
    if mime_type.starts_with("image/") {
        Some("image")
    } else if mime_type.starts_with("audio/") {
        Some("audio")
    } else if mime_type == "application/pdf" || mime_type.starts_with("text/") {
        Some("document")
    } else {
        None
    }
}

fn artifact_is_browser_preview(artifact: &ArtifactItemProjection) -> bool {
    artifact.kind.eq_ignore_ascii_case("image")
        || artifact
            .mime_type
            .as_deref()
            .is_some_and(|mime| mime.starts_with("image/"))
        || artifact.title.to_ascii_lowercase().contains("screenshot")
        || artifact.detail.to_ascii_lowercase().contains("screenshot")
}

fn browser_preview_from_artifact(artifact: &ArtifactItemProjection) -> BrowserPreviewProjection {
    let location = artifact
        .url
        .clone()
        .or_else(|| artifact.path.clone())
        .unwrap_or_else(|| "provider attachment".to_string());
    BrowserPreviewProjection {
        id: artifact.id.clone(),
        title: artifact.title.clone(),
        detail: artifact.detail.clone(),
        location,
        mime_type: artifact.mime_type.clone(),
        observed_at: artifact.observed_at.clone(),
    }
}

fn parse_worktree_entries(
    value: serde_json::Value,
    repo_path: &str,
    active_worktree_path: Option<&str>,
) -> Vec<WorktreeEntryProjection> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let path = entry.get("path")?.as_str()?.to_string();
                    let primary = path == repo_path;
                    let active_thread =
                        active_worktree_path.map_or(primary, |active_path| active_path == path);
                    Some(WorktreeEntryProjection {
                        path,
                        branch: entry
                            .get("branch")
                            .and_then(serde_json::Value::as_str)
                            .map(ToString::to_string),
                        head: entry
                            .get("head")
                            .and_then(serde_json::Value::as_str)
                            .map(ToString::to_string),
                        detached: entry
                            .get("detached")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        bare: entry
                            .get("bare")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        active_thread,
                        primary,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn suggested_worktree_branch(thread: &ThreadSummary) -> String {
    let title = thread
        .title
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    let normalized = title
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '/') {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if normalized.is_empty() {
        format!("ace/{}", thread.id.0)
    } else {
        format!("ace/{normalized}")
    }
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
                disabled_reason: registry_entry_disabled_reason(object, enabled),
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
        disabled_reason: None,
    }
}

fn registry_entry_available(entry: &ToolRegistryEntryProjection) -> bool {
    if entry.enabled == Some(false) || entry.disabled_reason.is_some() {
        return false;
    }

    !matches!(
        entry.status.to_ascii_lowercase().as_str(),
        "disabled" | "unavailable" | "missing" | "error" | "failed"
    )
}

fn registry_entry_disabled_reason(
    object: &serde_json::Map<String, serde_json::Value>,
    enabled: Option<bool>,
) -> Option<String> {
    string_field(
        object,
        &[
            "disabled_reason",
            "disabledReason",
            "unavailable_reason",
            "unavailableReason",
            "last_error",
            "lastError",
            "error",
        ],
    )
    .or_else(|| {
        (enabled == Some(false)).then(|| {
            "This registry entry is disabled by the host runtime and cannot be attached to composer turns.".to_string()
        })
    })
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

fn review_file_summary(file: &ReviewFileProjection) -> String {
    let stat = match (file.additions, file.deletions) {
        (Some(additions), Some(deletions)) => format!("+{additions} -{deletions}"),
        _ => "diff stat unavailable".to_string(),
    };
    format!("{} · {} · {stat}", file.path, file.status)
}

fn browser_activity_summary(activity: &BrowserActivityProjection) -> String {
    match activity.target.as_deref() {
        Some(target) if !target.trim().is_empty() => {
            format!("{} · {} · {target}", activity.status, activity.title)
        }
        _ => format!("{} · {}", activity.status, activity.title),
    }
}

fn thread_status_is_terminal(status: ThreadStatus) -> bool {
    matches!(
        status,
        ThreadStatus::Error | ThreadStatus::Completed | ThreadStatus::Idle | ThreadStatus::Archived
    )
}

fn turn_mode_label(mode: TurnMode) -> &'static str {
    match mode {
        TurnMode::Normal => "Run",
        TurnMode::Plan => "Plan",
    }
}

fn plan_session_status_label(status: PlanSessionStatus) -> &'static str {
    match status {
        PlanSessionStatus::Active => "active",
        PlanSessionStatus::Completed => "completed",
        PlanSessionStatus::Rejected => "rejected",
        PlanSessionStatus::Implementing => "implementing",
    }
}

fn handoff_status_label(status: HandoffStatus) -> &'static str {
    match status {
        HandoffStatus::Requested => "requested",
        HandoffStatus::Interrupted => "interrupted",
        HandoffStatus::Transferring => "transferring",
        HandoffStatus::Completed => "completed",
        HandoffStatus::Failed => "failed",
    }
}

fn subagent_action_label(action: SubagentActionKind) -> &'static str {
    match action {
        SubagentActionKind::Steer => "steer",
        SubagentActionKind::Stop => "stop",
        SubagentActionKind::Close => "close",
    }
}

fn thread_run_mode_label(thread: &ThreadSummary) -> String {
    if thread.worktree_path.is_some() {
        "Worktree".to_string()
    } else {
        "Thread".to_string()
    }
}

fn composer_status_line(draft: &ComposerDraft) -> String {
    let host = draft.host_selection.as_ref().map_or_else(
        || "This computer".to_string(),
        |host| format!("{}:{}", host.provider, host.host_id),
    );
    let reasoning = draft
        .reasoning_effort
        .map_or("No reasoning".to_string(), |effort| {
            format!("{} reasoning", effort.label())
        });
    let traits = if draft.traits.is_empty() {
        "No traits".to_string()
    } else {
        draft
            .traits
            .iter()
            .map(|trait_kind| trait_kind.label())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let context = if draft.context.is_empty() {
        "No context".to_string()
    } else {
        draft
            .context
            .iter()
            .map(|context| context.label())
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "{} {} · {} · {} · {} · {} · {}",
        interaction_mode_label(draft.interaction_mode),
        runtime_mode_label(draft.runtime_mode),
        draft.model_selection.model,
        draft.permission_mode.label(),
        reasoning,
        host,
        if traits == "No traits" && context == "No context" {
            "No extra context".to_string()
        } else {
            format!("{traits} · {context}")
        }
    )
}

fn copy_composer_turn_settings(target: &mut ComposerDraft, source: &ComposerDraft) {
    target.model_selection = source.model_selection.clone();
    target.host_selection = source.host_selection.clone();
    target.reasoning_effort = source.reasoning_effort;
    target.permission_mode = source.permission_mode;
    target.traits = source.traits.clone();
    target.context = source.context.clone();
    target.runtime_mode = source.runtime_mode;
    target.interaction_mode = source.interaction_mode;
}

fn interaction_mode_label(mode: InteractionMode) -> &'static str {
    match mode {
        InteractionMode::Chat => "Chat",
        InteractionMode::Plan => "Plan",
    }
}

fn runtime_mode_label(mode: RuntimeMode) -> &'static str {
    match mode {
        RuntimeMode::Normal => "normal",
        RuntimeMode::Local => "local",
        RuntimeMode::Worktree => "worktree",
        RuntimeMode::Remote => "remote",
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

fn goal_signal_summary(goal: &ace_runtime::threads::GoalState) -> String {
    let objective = goal.objective.as_deref().unwrap_or("No objective");
    let budget = match (goal.tokens_used, goal.token_budget) {
        (Some(used), Some(budget)) => format!(" · {used}/{budget} tokens"),
        (Some(used), None) => format!(" · {used} tokens used"),
        (None, Some(budget)) => format!(" · {budget} token budget"),
        (None, None) => String::new(),
    };
    let time = goal
        .time_used_seconds
        .map(|seconds| format!(" · {seconds}s"))
        .unwrap_or_default();
    format!(
        "Goal {} · {}{}{}",
        goal_status_label(goal.status),
        objective,
        budget,
        time
    )
}

fn goal_status_label(status: GoalStatus) -> &'static str {
    match status {
        GoalStatus::Active => "active",
        GoalStatus::Paused => "paused",
        GoalStatus::Blocked => "blocked",
        GoalStatus::UsageLimited => "usage limited",
        GoalStatus::BudgetLimited => "budget limited",
        GoalStatus::Complete => "complete",
        GoalStatus::Cleared => "cleared",
    }
}

fn json_collection_len(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(items) => items.len(),
        serde_json::Value::Object(entries) => entries.len(),
        _ => 0,
    }
}

fn message_excerpt(message: &ChatMessageProjection) -> String {
    let raw = message
        .text
        .as_deref()
        .or(message.title.as_deref())
        .unwrap_or_default()
        .trim();
    truncate_preview(raw, 160)
}

fn truncate_preview(raw: &str, limit: usize) -> String {
    if raw.len() <= limit {
        return raw.to_string();
    }

    let mut end = limit;
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &raw[..end])
}

fn review_comment_detail(comment: &ReviewCommentItem) -> String {
    let status = if comment.resolved { "resolved" } else { "open" };
    match comment.line {
        Some(line) => format!("{status} · line {line} · {}", comment.body),
        None => format!("{status} · {}", comment.body),
    }
}

fn stable_token(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-")
}

fn serde_name<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn composer_traits_text(traits: &[ComposerTrait]) -> Option<String> {
    if traits.is_empty() {
        return None;
    }

    let instructions = traits
        .iter()
        .map(|trait_kind| format!("- {}: {}", trait_kind.label(), trait_kind.instruction()))
        .collect::<Vec<_>>()
        .join("\n");

    Some(format!(
        "Agent traits selected for this turn:\n{instructions}\nFollow these traits unless they conflict with higher-priority system, developer, or user instructions."
    ))
}

fn composer_mentions(prompt: &str) -> Vec<String> {
    prompt
        .split_whitespace()
        .filter_map(|token| {
            let token = token.trim_matches(|ch: char| {
                matches!(
                    ch,
                    ',' | '.'
                        | ';'
                        | ':'
                        | '!'
                        | '?'
                        | ')'
                        | '('
                        | '['
                        | ']'
                        | '{'
                        | '}'
                        | '"'
                        | '\''
                )
            });
            token.starts_with('@').then(|| token.to_string())
        })
        .collect()
}

fn composer_command_tokens(prompt: &str) -> Vec<String> {
    prompt
        .split_whitespace()
        .filter_map(|token| {
            let token = trim_composer_token(token);
            matches!(token.chars().next(), Some('/' | '$' | '@')).then(|| token.to_string())
        })
        .collect()
}

fn trim_composer_token(token: &str) -> &str {
    token.trim_matches(|ch: char| {
        matches!(
            ch,
            ',' | '.' | ';' | ':' | '!' | '?' | ')' | '(' | '[' | ']' | '{' | '}' | '"' | '\''
        )
    })
}

fn composer_context_mention_token(token: &str) -> bool {
    matches!(token, "@terminal" | "@diff")
        || token.starts_with("@todo:")
        || token.starts_with("@pin:")
        || token.starts_with("@highlight:")
        || token.starts_with("@review:")
}

fn registry_command_for_token(
    token: &str,
    name: &str,
    source: ComposerCommandSource,
    registry: &ToolRegistryProjection,
) -> Option<ComposerCommandProjection> {
    let normalized = name.to_ascii_lowercase();
    registry
        .entries
        .iter()
        .find(|entry| {
            registry_entry_available(entry)
                && (entry.name.to_ascii_lowercase() == normalized
                    || entry.id.to_ascii_lowercase() == normalized)
        })
        .map(|entry| ComposerCommandProjection {
            token: token.to_string(),
            source,
            name: entry.name.clone(),
            description: entry
                .description
                .clone()
                .unwrap_or_else(|| format!("{} registry entry", source.label())),
            provider: entry.source.clone(),
        })
}

fn project_script_matches_action(script: &ProjectScript, action: ProjectActionKind) -> bool {
    let id = script.id.to_ascii_lowercase();
    let label = script.label.to_ascii_lowercase();
    match action {
        ProjectActionKind::Tests => {
            id == "test"
                || id == "tests"
                || label == "test"
                || label == "tests"
                || label.contains("test")
        }
        ProjectActionKind::Lint => {
            id == "lint"
                || id == "clippy"
                || label == "lint"
                || label == "clippy"
                || label.contains("lint")
                || label.contains("clippy")
        }
    }
}

fn default_project_action_command(action: ProjectActionKind) -> &'static str {
    match action {
        ProjectActionKind::Tests => "cargo test --workspace --all-targets",
        ProjectActionKind::Lint => "cargo clippy --workspace --all-targets -- -D warnings",
    }
}

struct PermissionPayload {
    sandbox_policy: serde_json::Value,
    approval_policy: serde_json::Value,
    approvals_reviewer: Option<&'static str>,
}

fn permission_payload(permission: ComposerPermissionMode) -> PermissionPayload {
    match permission {
        ComposerPermissionMode::Strict => PermissionPayload {
            sandbox_policy: serde_json::json!({
                "mode": "read-only",
                "networkAccess": "restricted",
            }),
            approval_policy: serde_json::json!({ "mode": "on-request" }),
            approvals_reviewer: Some("user"),
        },
        ComposerPermissionMode::Auto => PermissionPayload {
            sandbox_policy: serde_json::json!({
                "mode": "workspace-write",
                "networkAccess": "restricted",
            }),
            approval_policy: serde_json::json!({ "mode": "on-request" }),
            approvals_reviewer: Some("user"),
        },
        ComposerPermissionMode::AutoReview => PermissionPayload {
            sandbox_policy: serde_json::json!({
                "mode": "workspace-write",
                "networkAccess": "restricted",
            }),
            approval_policy: serde_json::json!({ "mode": "on-request" }),
            approvals_reviewer: Some("auto_review"),
        },
        ComposerPermissionMode::FullAccess => PermissionPayload {
            sandbox_policy: serde_json::json!({
                "mode": "danger-full-access",
                "networkAccess": "enabled",
            }),
            approval_policy: serde_json::json!({ "mode": "never" }),
            approvals_reviewer: None,
        },
    }
}

fn composer_collaboration_mode(
    draft: &ComposerDraft,
    reasoning_effort: Option<&'static str>,
    permissions: &PermissionPayload,
) -> serde_json::Value {
    let mut settings = serde_json::json!({
        "model": draft.model_selection.model,
        "model_provider": draft.model_selection.provider.runtime_id(),
        "reasoning_effort": reasoning_effort,
        "interaction_mode": interaction_mode_value(draft.interaction_mode),
        "runtime_mode": runtime_mode_value(draft.runtime_mode),
        "permission_mode": permission_mode_value(draft.permission_mode),
        "sandbox_policy": permissions.sandbox_policy,
        "approval_policy": permissions.approval_policy,
        "approvals_reviewer": permissions.approvals_reviewer,
        "traits": draft
            .traits
            .iter()
            .map(|trait_kind| composer_trait_value(*trait_kind))
            .collect::<Vec<_>>(),
        "context": draft
            .context
            .iter()
            .map(|context| composer_context_value(*context))
            .collect::<Vec<_>>(),
        "developer_instructions": null,
    });

    if let Some(host) = draft.host_selection.as_ref() {
        settings["host"] = serde_json::json!({
            "provider": host.provider,
            "host_id": host.host_id,
        });
    }

    serde_json::json!({
        "mode": if draft.interaction_mode == InteractionMode::Plan {
            "plan"
        } else {
            "default"
        },
        "settings": settings,
    })
}

fn interaction_mode_value(mode: InteractionMode) -> &'static str {
    match mode {
        InteractionMode::Chat => "chat",
        InteractionMode::Plan => "plan",
    }
}

fn runtime_mode_value(mode: RuntimeMode) -> &'static str {
    match mode {
        RuntimeMode::Normal => "normal",
        RuntimeMode::Local => "local",
        RuntimeMode::Worktree => "worktree",
        RuntimeMode::Remote => "remote",
    }
}

fn permission_mode_value(permission: ComposerPermissionMode) -> &'static str {
    match permission {
        ComposerPermissionMode::Strict => "strict",
        ComposerPermissionMode::Auto => "auto",
        ComposerPermissionMode::AutoReview => "auto_review",
        ComposerPermissionMode::FullAccess => "full_access",
    }
}

fn composer_trait_value(trait_kind: ComposerTrait) -> &'static str {
    match trait_kind {
        ComposerTrait::Precise => "precise",
        ComposerTrait::Fast => "fast",
        ComposerTrait::TestFocused => "test_focused",
        ComposerTrait::ReviewFocused => "review_focused",
    }
}

fn composer_context_value(context: ComposerContextKind) -> &'static str {
    match context {
        ComposerContextKind::Pinned => "pinned",
        ComposerContextKind::Highlights => "highlights",
        ComposerContextKind::Todos => "todos",
        ComposerContextKind::Terminal => "terminal",
    }
}

fn toggle_vec_value<T: Copy + PartialEq>(values: &mut Vec<T>, value: T) {
    if let Some(index) = values.iter().position(|candidate| *candidate == value) {
        values.remove(index);
    } else {
        values.push(value);
    }
}

fn todo_status_label(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Open => "open",
        TodoStatus::InProgress => "in progress",
        TodoStatus::Blocked => "blocked",
        TodoStatus::Done => "done",
        TodoStatus::Canceled => "canceled",
    }
}

fn todo_priority_label(priority: TodoPriority) -> &'static str {
    match priority {
        TodoPriority::Low => "low",
        TodoPriority::Normal => "normal",
        TodoPriority::High => "high",
    }
}

fn todo_assignee_label(assignee: TodoAssignee) -> &'static str {
    match assignee {
        TodoAssignee::User => "user",
        TodoAssignee::Agent => "agent",
        TodoAssignee::Both => "user and agent",
    }
}

fn todo_context_line(todo: &TodoItem) -> String {
    let mut parts = vec![
        format!("[{}]", todo_status_label(todo.status)),
        format!("priority {}", todo_priority_label(todo.priority)),
        format!("assigned to {}", todo_assignee_label(todo.assigned_to)),
        todo.title.clone(),
    ];
    if !todo.related_files.is_empty() {
        parts.push(format!("files: {}", todo.related_files.join(", ")));
    }
    if !todo.related_diff_comments.is_empty() {
        parts.push(format!(
            "diff comments: {}",
            todo.related_diff_comments.join(", ")
        ));
    }
    parts.join(" · ")
}

fn extend_unique(target: &mut Vec<String>, values: Vec<String>) {
    for value in values {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

fn tail_chars(value: &str, max_chars: usize) -> String {
    let total = value.chars().count();
    if total <= max_chars {
        return value.to_string();
    }
    value.chars().skip(total - max_chars).collect()
}

fn stable_store_id(value: &str) -> u64 {
    value
        .bytes()
        .fold(14_695_981_039_346_656_037, |hash, byte| {
            hash.wrapping_mul(1_099_511_628_211) ^ u64::from(byte)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote_connection(host_id: &str, status: Option<&str>) -> RemoteConnectionRecord {
        RemoteConnectionRecord {
            provider: "codex".to_string(),
            host_id: host_id.to_string(),
            host: Some(format!("{host_id}.internal")),
            display_name: Some(host_id.to_string()),
            status: status.map(ToString::to_string),
            execution_location: ExecutionLocation::RemoteHost,
            projects: serde_json::Value::Null,
            metadata: serde_json::Value::Null,
        }
    }

    fn browser_tool(thread_id: &str, item_id: &str, title: &str) -> SemanticToolCall {
        SemanticToolCall {
            transport: ace_runtime::tools::ToolTransport::BrowserBridge,
            surface: ToolSurface::Browser,
            action: ace_runtime::tools::ToolActionKind::BrowserNavigate,
            display: ace_runtime::tools::ToolDisplay {
                title: title.to_string(),
                summary: Some("Opened page".to_string()),
                target: Some(ace_runtime::tools::ToolTarget {
                    kind: ace_runtime::tools::ToolTargetKind::Url,
                    label: "http://localhost:5173".to_string(),
                }),
                status: ToolRunStatus::Completed,
                icon_key: "browser".to_string(),
                technical_metadata: serde_json::Value::Null,
            },
            provider: ace_runtime::tools::ProviderToolMetadata {
                provider: Some("codex".to_string()),
                method: Some("item/tool/call".to_string()),
                item_id: Some(item_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                thread_id: Some(thread_id.to_string()),
                server_name: Some("browser".to_string()),
                tool_name: Some("ace_browser".to_string()),
                operation: Some("navigate".to_string()),
                raw_args: serde_json::Value::Null,
                raw_result: serde_json::Value::Null,
                raw_payload: serde_json::Value::Null,
            },
        }
    }

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
        store.toggle_pin_thread(active.clone());
        assert!(store.metadata.pinned_thread_ids.contains(&active));
        assert!(
            store
                .projection()
                .sidebar
                .projects
                .iter()
                .flat_map(|group| group.threads.iter())
                .any(|thread| thread.id == active && thread.pinned)
        );
        store.toggle_pin_thread(active.clone());
        assert!(!store.metadata.pinned_thread_ids.contains(&active));

        store.toggle_pin_thread(active.clone());
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
        assert_eq!(plugins[0].disabled_reason, None);

        let skills = parse_tool_registry_entries(
            serde_json::json!({
                "rust": {
                    "description": "Rust workflow context",
                    "state": "disabled",
                    "disabledReason": "Project skills are disabled for this workspace."
                }
            }),
            RegistrySurface::Skill,
        );
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "rust");
        assert_eq!(skills[0].name, "rust");
        assert_eq!(skills[0].status, "disabled");
        assert_eq!(
            skills[0].disabled_reason.as_deref(),
            Some("Project skills are disabled for this workspace.")
        );
    }

    #[test]
    fn browser_projection_reads_host_tool_bridge_status() {
        let response = ProviderHostToolsListResponse {
            tools: Vec::new(),
            bridges: vec![
                ace_protocol::provider_runtime::ProviderHostToolBridgeSummary {
                    surface: ToolSurface::Browser,
                    status: ProviderHostToolBridgeStatus::Connected,
                    descriptor_name: Some("browser.bridge".to_string()),
                    aliases: vec!["ace_browser".to_string(), "browser".to_string()],
                    actions: vec![
                        ace_runtime::tools::ToolActionKind::BrowserNavigate,
                        ace_runtime::tools::ToolActionKind::BrowserScreenshot,
                    ],
                    capability_keys: vec!["host_tool.bridge.status.connected".to_string()],
                },
            ],
        };

        let projection = browser_projection_from_host_tools(&response, "updated".to_string());

        let bridge = projection.bridge.expect("browser bridge");
        assert_eq!(bridge.status, "connected");
        assert_eq!(bridge.descriptor_name.as_deref(), Some("browser.bridge"));
        assert_eq!(bridge.aliases, vec!["ace_browser", "browser"]);
        assert_eq!(
            bridge.actions,
            vec!["browser.navigate", "browser.screenshot"]
        );
        assert_eq!(projection.updated_at.as_deref(), Some("updated"));
    }

    #[test]
    fn browser_service_readiness_follows_bridge_status() {
        let mut store = DesktopStore::new();
        assert!(!store.browser_service_status().is_ready());

        store.browser = BrowserProjection {
            bridge: Some(BrowserBridgeProjection {
                status: "connected".to_string(),
                descriptor_name: Some("browser.bridge".to_string()),
                aliases: Vec::new(),
                actions: Vec::new(),
                capability_keys: Vec::new(),
            }),
            activities: Vec::new(),
            previews: Vec::new(),
            error: None,
            updated_at: Some("now".to_string()),
        };
        assert!(store.browser_service_status().is_ready());

        store.browser.bridge.as_mut().expect("bridge").status = "unavailable".to_string();
        assert_eq!(
            store.browser_service_status().missing_reason(),
            Some("Browser bridge contract exists, but no Chromium bridge handler is attached.")
        );
    }

    #[test]
    fn browser_projection_records_semantic_browser_tool_activity() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
            .expect("thread should exist")
            .provider_thread_id = Some("provider-thread-1".to_string());

        store.apply_provider_runtime_event(
            ProviderRuntimeEvent::tool(browser_tool(
                "provider-thread-1",
                "browser-1",
                "Opened http://localhost:5173 in Browser",
            )),
            Some(7),
        );

        let projection = store.projection();
        let activity = projection
            .browser
            .activities
            .first()
            .expect("browser activity");

        assert_eq!(activity.thread_id, thread_id);
        assert_eq!(activity.id, "browser-1");
        assert_eq!(activity.status, "completed");
        assert_eq!(activity.target.as_deref(), Some("http://localhost:5173"));
        assert!(activity.detail.contains("Opened page"));
        assert!(
            projection
                .summary
                .browser_pages
                .iter()
                .any(|item| item.contains("Opened http://localhost:5173"))
        );
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
        assert!(!services.worktrees.is_ready());
        assert!(!services.approvals.is_ready());
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
    fn project_action_command_prefers_configured_scripts() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        let project = store
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
            .expect("project");
        project.scripts = vec![
            ProjectScript {
                id: "test".to_string(),
                label: "Test".to_string(),
                command: "cargo nextest run".to_string(),
            },
            ProjectScript {
                id: "lint".to_string(),
                label: "Lint".to_string(),
                command: "cargo clippy --workspace".to_string(),
            },
        ];

        assert_eq!(
            store.active_project_action_command(&thread_id, ProjectActionKind::Tests),
            Some("cargo nextest run".to_string())
        );
        assert_eq!(
            store.active_project_action_command(&thread_id, ProjectActionKind::Lint),
            Some("cargo clippy --workspace".to_string())
        );
    }

    #[test]
    fn project_action_command_defaults_to_rust_workspace_commands() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);

        assert_eq!(
            store.active_project_action_command(&thread_id, ProjectActionKind::Tests),
            Some("cargo test --workspace --all-targets".to_string())
        );
        assert_eq!(
            store.active_project_action_command(&thread_id, ProjectActionKind::Lint),
            Some("cargo clippy --workspace --all-targets -- -D warnings".to_string())
        );
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
        store.create_review_comment_for_file("src/lib.rs".to_string());

        let sources = store.projection().sources;
        assert_eq!(sources.changed_files, 1);
        assert_eq!(sources.terminal_sessions, 1);
        assert_eq!(sources.context_items, 2);
        assert!(sources.items.iter().any(|item| item.kind == "file"));
        assert!(sources.items.iter().any(|item| item.kind == "terminal"));
        assert!(sources.items.iter().any(|item| item.kind == "pinned"));
        assert!(sources.items.iter().any(|item| item.kind == "diff_comment"));
    }

    #[test]
    fn sources_projection_reads_provider_artifacts() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.apply_provider_thread_item(
            ace_runtime::provider::NormalizedThreadItem {
                kind: ThreadItemKind::AgentMessage,
                status: ThreadItemStatus::Completed,
                thread_id: Some(thread_id.0.clone()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                parent_thread_id: None,
                child_thread_id: None,
                sender: None,
                role: None,
                title: Some("Screenshot captured".to_string()),
                text: Some("Captured the login screenshot".to_string()),
                status_text: None,
                model: None,
                target: None,
                url: None,
                files: None,
                attachments: Some(serde_json::json!([
                    {
                        "kind": "image",
                        "title": "Login screenshot",
                        "url": "codex://attachment/login.png",
                        "mimeType": "image/png"
                    }
                ])),
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
                metadata: serde_json::Value::Null,
                provider: ace_runtime::provider::ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/agentMessage".to_string()),
                    schema_version: None,
                    raw_payload: serde_json::Value::Null,
                },
            },
            Some(42),
        );

        let sources = store.projection().sources;

        assert_eq!(sources.artifacts, 1);
        assert!(sources.items.iter().any(|item| {
            item.kind == "artifact"
                && item.title == "Login screenshot"
                && item.detail.contains("image/png")
        }));
        let summary = store.summary_projection();
        assert!(
            summary
                .artifacts
                .iter()
                .any(|artifact| artifact.contains("Login screenshot"))
        );
    }

    #[test]
    fn browser_projection_surfaces_provider_screenshot_artifacts() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.apply_provider_thread_item(
            ace_runtime::provider::NormalizedThreadItem {
                kind: ThreadItemKind::ImageView,
                status: ThreadItemStatus::Completed,
                thread_id: Some(thread_id.0.clone()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("image-view-1".to_string()),
                parent_thread_id: None,
                child_thread_id: None,
                sender: None,
                role: None,
                title: Some("Login screenshot".to_string()),
                text: Some("Captured browser viewport".to_string()),
                status_text: None,
                model: None,
                target: None,
                url: Some("codex://attachment/login.png".to_string()),
                files: None,
                attachments: Some(serde_json::json!({
                    "kind": "image",
                    "title": "Login screenshot",
                    "url": "codex://attachment/login.png",
                    "mimeType": "image/png"
                })),
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
                metadata: serde_json::Value::Null,
                provider: ace_runtime::provider::ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/imageView".to_string()),
                    schema_version: None,
                    raw_payload: serde_json::Value::Null,
                },
            },
            Some(7),
        );

        let browser = store.projection().browser;

        assert_eq!(browser.previews.len(), 1);
        assert_eq!(browser.previews[0].title, "Login screenshot");
        assert_eq!(browser.previews[0].location, "codex://attachment/login.png");
        assert_eq!(browser.previews[0].mime_type.as_deref(), Some("image/png"));
        assert_eq!(browser.previews[0].observed_at, "7");
    }

    #[test]
    fn artifact_only_provider_thread_items_are_not_dropped() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.apply_provider_thread_item(
            ace_runtime::provider::NormalizedThreadItem {
                kind: ThreadItemKind::ImageGeneration,
                status: ThreadItemStatus::Completed,
                thread_id: Some(thread_id.0.clone()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("artifact-only".to_string()),
                parent_thread_id: None,
                child_thread_id: None,
                sender: None,
                role: None,
                title: Some("Generated report".to_string()),
                text: None,
                status_text: None,
                model: None,
                target: None,
                url: Some("codex://attachment/report.pdf".to_string()),
                files: None,
                attachments: Some(serde_json::json!({
                    "path": "reports/report.pdf",
                    "mimeType": "application/pdf"
                })),
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
                metadata: serde_json::Value::Null,
                provider: ace_runtime::provider::ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/artifact".to_string()),
                    schema_version: None,
                    raw_payload: serde_json::Value::Null,
                },
            },
            Some(43),
        );

        let projection = store.projection();

        assert!(projection.chat.messages.is_empty());
        assert_eq!(projection.sources.artifacts, 1);
        assert!(projection.sources.items.iter().any(|item| {
            item.kind == "artifact"
                && item.title == "report.pdf"
                && item.detail.contains("reports/report.pdf")
        }));
    }

    #[test]
    fn editor_projection_reads_active_workspace_and_review_files() {
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
                    additions: Some(4),
                    deletions: Some(2),
                }],
                ..ReviewProjection::default()
            },
        );

        let editor = store.editor_projection();

        assert_eq!(editor.active_thread_id, Some(thread_id));
        assert_eq!(editor.workspace_root.as_deref(), Some("/tmp/project"));
        assert_eq!(editor.diagnostics_topic, "editor.diagnostics");
        assert_eq!(editor.candidate_files.len(), 1);
        assert_eq!(editor.candidate_files[0].path, "src/lib.rs");
        assert_eq!(editor.candidate_files[0].additions, Some(4));
        assert_eq!(
            store.editor_service_status().missing_reason(),
            Some("Select a thread with a project workspace before opening editor buffers.")
        );
    }

    #[test]
    fn summary_projection_uses_observed_thread_state() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Fix the checkout regression".to_string(),
            },
        );
        let message_id = store.projection().chat.messages[0].id.clone();
        store.create_todo_from_timeline_item(thread_id.clone(), &message_id);
        store.pin_timeline_item(thread_id.clone(), &message_id);
        store.review_snapshots.insert(
            project_id,
            ReviewProjection {
                repo_path: Some("/tmp/project".to_string()),
                files: vec![ReviewFileProjection {
                    path: "src/checkout.rs".to_string(),
                    original_path: None,
                    status: "modified".to_string(),
                    additions: Some(8),
                    deletions: Some(3),
                }],
                total_additions: 8,
                total_deletions: 3,
                ..ReviewProjection::default()
            },
        );
        store.terminal_sessions.insert(
            TerminalKey::default_for_thread(&thread_id),
            TerminalSessionProjection {
                thread_id: thread_id.0.clone(),
                terminal_id: DEFAULT_TERMINAL_ID.to_string(),
                cwd: "/tmp/project".to_string(),
                title: None,
                status: TerminalSessionStatus::Running,
                pid: Some(7),
                history: "cargo test checkout failed".to_string(),
                exit_code: None,
                exit_signal: None,
                cols: DEFAULT_TERMINAL_COLS,
                rows: DEFAULT_TERMINAL_ROWS,
                updated_at: "terminal".to_string(),
                next_sequence: 1,
                truncated_before_sequence: None,
            },
        );

        let summary = store.summary_projection();

        assert_eq!(
            summary.current_goal.as_deref(),
            Some("Fix the checkout regression")
        );
        assert!(summary.current_status.contains("message"));
        assert_eq!(
            summary.composer_status.as_deref(),
            Some(
                "Chat normal · gpt-5.3-codex · Auto · Medium reasoning · This computer · No extra context"
            )
        );
        assert!(
            summary
                .plan
                .iter()
                .any(|item| item.contains("Review 1 changed file"))
        );
        assert!(
            summary
                .todos
                .iter()
                .any(|item| item.contains("Fix the checkout regression"))
        );
        assert!(
            summary
                .pinned_context
                .iter()
                .any(|item| item.contains("Fix the checkout"))
        );
        assert!(
            summary
                .files_changed
                .iter()
                .any(|item| item.contains("src/checkout.rs"))
        );
        assert!(
            summary
                .commands_run
                .iter()
                .any(|item| item.contains("cargo test checkout failed"))
        );
        assert_eq!(
            summary.next_action.as_deref(),
            Some("Pick the next open todo or attach it to the composer with @todo.")
        );
    }

    #[test]
    fn summary_projection_surfaces_configured_composer_state() {
        let mut store = DesktopStore::new();
        store.add_project("/tmp/project".to_string());

        store.set_active_composer_interaction_mode(InteractionMode::Plan);
        store.set_active_composer_runtime_mode(RuntimeMode::Local);
        store.set_active_composer_permission(ComposerPermissionMode::AutoReview);
        store.set_active_composer_reasoning(Some(ReasoningEffort::High));
        store.toggle_active_composer_trait(ComposerTrait::Precise);
        store.toggle_active_composer_trait(ComposerTrait::TestFocused);
        store.toggle_active_composer_context(ComposerContextKind::Todos);
        store.set_active_composer_model(ProviderKind::Codex, "gpt-5-large".to_string());

        let summary = store.summary_projection();

        assert_eq!(
            summary.composer_status.as_deref(),
            Some(
                "Plan local · gpt-5-large · Auto review · High reasoning · This computer · Precise, Tested · Todos"
            )
        );
    }

    #[test]
    fn summary_projection_surfaces_runtime_relationships() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
            .expect("thread should exist")
            .provider_thread_id = Some("provider-thread-1".to_string());
        store.runtime.fork_points = vec![ace_runtime::threads::ForkPoint {
            parent_thread_id: "provider-thread-1".to_string(),
            child_thread_id: "fork-thread-1".to_string(),
            turn_id: Some("turn-1".to_string()),
        }];
        store.runtime.side_chats = vec![ace_runtime::threads::SideChat {
            parent_thread_id: "provider-thread-1".to_string(),
            thread_id: "side-thread-1".to_string(),
            ephemeral: true,
        }];
        store.runtime.subagents = vec![ace_runtime::threads::SubagentThread {
            parent_thread_id: "provider-thread-1".to_string(),
            thread_id: "subagent-1".to_string(),
            role: Some("reviewer".to_string()),
            nickname: None,
        }];
        store.runtime.handoffs = vec![ace_runtime::threads::HandoffPlan {
            source_thread_id: "provider-thread-1".to_string(),
            target_location: ExecutionLocation::Worktree,
            status: HandoffStatus::Completed,
            target_thread_id: Some("handoff-thread-1".to_string()),
            repo_root: Some("/tmp/project".to_string()),
            worktree_path: Some("/tmp/project-feature".to_string()),
            branch: Some("feature/runtime".to_string()),
            start_point: Some("main".to_string()),
            checkpoint_ref: None,
            remote_host: None,
            transfer_status: None,
            interrupted_active_turn: Some(true),
            metadata: serde_json::Value::Null,
        }];
        store.runtime.subagent_actions = vec![ace_runtime::threads::SubagentActionRecord {
            parent_thread_id: "provider-thread-1".to_string(),
            subagent_thread_id: "subagent-1".to_string(),
            action: SubagentActionKind::Steer,
            prompt: Some("Review the diff".to_string()),
            provider_response: serde_json::Value::Null,
        }];

        let relationships = store.summary_projection().runtime_relationships;

        assert!(
            relationships
                .iter()
                .any(|item| item == "Fork provider-thread-1 -> fork-thread-1 · turn turn-1")
        );
        assert!(
            relationships
                .iter()
                .any(|item| item == "Side chat provider-thread-1 -> side-thread-1 · ephemeral")
        );
        assert!(
            relationships
                .iter()
                .any(|item| item == "Subagent reviewer · provider-thread-1 -> subagent-1")
        );
        assert!(relationships.iter().any(|item| {
            item == "Handoff provider-thread-1 -> handoff-thread-1 · completed · feature/runtime"
        }));
        assert!(
            relationships
                .iter()
                .any(|item| { item == "Subagent action steer · provider-thread-1 -> subagent-1" })
        );
    }

    #[test]
    fn summary_projection_surfaces_runtime_operational_signals() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
            .expect("thread should exist")
            .provider_thread_id = Some("provider-thread-1".to_string());
        store.runtime.goals = vec![ace_runtime::threads::GoalState {
            thread_id: "provider-thread-1".to_string(),
            status: GoalStatus::UsageLimited,
            objective: Some("finish adapter parity".to_string()),
            token_budget: Some(1000),
            tokens_used: Some(1200),
            time_used_seconds: Some(55),
        }];
        store.runtime.warnings = vec![ace_runtime::threads::RuntimeWarningRecord {
            provider: "codex".to_string(),
            thread_id: Some("provider-thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            message: "event stream lagged".to_string(),
            metadata: serde_json::Value::Null,
        }];
        store.runtime.model_reroutes = vec![ace_runtime::threads::ModelRerouteRecord {
            provider: "codex".to_string(),
            thread_id: Some("provider-thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            from_model: Some("gpt-5".to_string()),
            to_model: Some("gpt-5-mini".to_string()),
            reason: Some("context_limit".to_string()),
        }];
        store.runtime.process_exits = vec![ace_runtime::threads::ProcessExitRecord {
            thread_id: Some("provider-thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            process_id: Some("cargo-test".to_string()),
            exit_code: Some(101),
            metadata: serde_json::Value::Null,
        }];
        store.runtime.turn_diffs = vec![ace_runtime::threads::TurnDiffRecord {
            thread_id: "provider-thread-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            diff: None,
            files: serde_json::json!([{ "path": "src/lib.rs" }]),
            metadata: serde_json::Value::Null,
        }];
        store.runtime.approval_retries = vec![ace_runtime::threads::ApprovalRetryRecord {
            thread_id: "provider-thread-1".to_string(),
            item_id: Some("approval-1".to_string()),
            action_id: Some("run-tests".to_string()),
            approved: true,
            reason: Some("retry after approval".to_string()),
            audit: serde_json::Value::Null,
            provider_response: serde_json::Value::Null,
        }];
        store.runtime.realtime_sessions = vec![ace_runtime::threads::RealtimeSessionRecord {
            provider: "codex".to_string(),
            thread_id: Some("provider-thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            status: "failed".to_string(),
            message: Some("Realtime session failed".to_string()),
            metadata: serde_json::Value::Null,
        }];

        let signals = store.summary_projection().runtime_signals;

        assert!(
            signals.iter().any(|item| item
                == "Goal usage limited · finish adapter parity · 1200/1000 tokens · 55s")
        );
        assert!(
            signals
                .iter()
                .any(|item| item == "Warning codex · event stream lagged")
        );
        assert!(
            signals
                .iter()
                .any(|item| item == "Model reroute gpt-5 -> gpt-5-mini · context_limit")
        );
        assert!(
            signals
                .iter()
                .any(|item| item == "Process exit cargo-test · code 101")
        );
        assert!(
            signals
                .iter()
                .any(|item| item == "Turn diff updated · 1 file · turn turn-1")
        );
        assert!(
            signals
                .iter()
                .any(|item| item == "Approval retry approved · retry after approval")
        );
        assert!(
            signals.iter().any(|item| {
                item == "Realtime session codex · failed · Realtime session failed"
            })
        );
    }

    #[test]
    fn run_projection_matches_provider_thread_runtime_state() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
            .expect("thread should exist")
            .provider_thread_id = Some("provider-thread-1".to_string());
        store.runtime.active_turns = vec![ace_runtime::threads::Turn {
            thread_id: "provider-thread-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            mode: TurnMode::Plan,
            active: true,
        }];
        store.runtime.plan_sessions = vec![ace_runtime::threads::PlanSession {
            thread_id: "provider-thread-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("plan-1".to_string()),
            status: PlanSessionStatus::Implementing,
            title: Some("Implementation plan".to_string()),
            text: None,
            status_text: None,
            questions: None,
            completion: None,
            metadata: serde_json::Value::Null,
            provider: None,
        }];

        let run = store.run_projection();

        assert!(run.active);
        assert_eq!(run.status_label, "Plan implementing");
        assert_eq!(run.mode_label, "Plan");
        assert_eq!(run.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(run.plan_status.as_deref(), Some("implementing"));

        let summary = store.summary_projection();

        assert_eq!(
            summary.run_status.as_deref(),
            Some("Plan implementing · Plan mode · gpt-5.3-codex on Codex")
        );
        assert!(summary.decisions.iter().any(|item| {
            item == "Run is Plan implementing in Plan mode using gpt-5.3-codex on Codex."
        }));
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
    fn worktree_parser_marks_primary_and_active_entries() {
        let entries = parse_worktree_entries(
            serde_json::json!([
                {
                    "path": "/repo",
                    "branch": "main",
                    "head": "abc",
                    "detached": false,
                    "bare": false
                },
                {
                    "path": "/repo-worktrees/feature",
                    "branch": "feature/task",
                    "head": "def",
                    "detached": false,
                    "bare": false
                }
            ]),
            "/repo",
            Some("/repo-worktrees/feature"),
        );

        assert_eq!(entries.len(), 2);
        assert!(entries[0].primary);
        assert!(!entries[0].active_thread);
        assert!(!entries[1].primary);
        assert!(entries[1].active_thread);
        assert_eq!(entries[1].branch.as_deref(), Some("feature/task"));
    }

    #[test]
    fn approval_registry_projection_reads_pending_requests() {
        let request = NormalizedServerRequest {
            kind: ServerRequestKind::CommandApproval,
            request_id: "approval-1".to_string(),
            method: "command/approvalRequest".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("item-1".to_string()),
            scope: Some("command".to_string()),
            title: Some("Approve command execution".to_string()),
            prompt: Some("Run cargo test?".to_string()),
            selected_policy: Some("on-request".to_string()),
            detail: ace_runtime::provider::ServerRequestDetail {
                command: Some("cargo test".to_string()),
                ..ace_runtime::provider::ServerRequestDetail::default()
            },
            metadata: serde_json::Value::Null,
            provider: ace_runtime::provider::ProviderMetadata {
                provider: "codex".to_string(),
                method: Some("command/approvalRequest".to_string()),
                schema_version: None,
                raw_payload: serde_json::json!({ "command": "cargo test" }),
            },
        };
        let response = ProviderRuntimeStateGetResponse {
            providers: vec![
                ace_protocol::provider_runtime::ProviderRuntimeProviderState {
                    provider: ace_core::ProviderKind::Codex,
                    runtime_id: "codex".to_string(),
                    display_name: "Codex".to_string(),
                    source: ace_protocol::provider_runtime::ProviderRuntimeStateSource::Live,
                    persisted_replay_available: false,
                    last_persisted_sequence: None,
                    summary: ace_protocol::provider_runtime::ProviderRuntimeStateSummary::default(),
                    state: AgentRuntimeSnapshot {
                        approvals: vec![ApprovalRecord {
                            provider: "codex".to_string(),
                            request_id: "approval-1".to_string(),
                            request,
                            status: ApprovalStatus::Pending,
                            decision: None,
                        }],
                        ..AgentRuntimeSnapshot::default()
                    },
                },
            ],
        };

        let projection = approval_registry_projection_from_state(&response, "updated".to_string());

        assert_eq!(projection.pending.len(), 1);
        assert_eq!(projection.pending[0].provider, "codex");
        assert_eq!(projection.pending[0].request_id, "approval-1");
        assert_eq!(projection.pending[0].detail.as_deref(), Some("cargo test"));
        assert_eq!(projection.resolved, 0);
        assert_eq!(projection.updated_at.as_deref(), Some("updated"));
    }

    #[test]
    fn model_provider_projection_reads_catalog_capabilities() {
        let projection = model_provider_projection(ProviderRuntimeModelsListResponse {
            provider: ace_core::ProviderKind::Codex,
            runtime_id: "codex".to_string(),
            display_name: "Codex".to_string(),
            catalog: ace_runtime::models::ProviderModelCatalog {
                provider: "codex".to_string(),
                models: vec![ace_runtime::models::ProviderModel {
                    id: "gpt-5".to_string(),
                    display_name: "GPT-5".to_string(),
                    provider: Some("openai".to_string()),
                    family: Some("gpt".to_string()),
                    capabilities: ace_runtime::models::ProviderModelCapabilities {
                        context_window: Some(256_000),
                        max_output_tokens: Some(32_000),
                        supports_reasoning: true,
                        supports_vision: false,
                        supports_tools: true,
                        supports_parallel_tool_calls: true,
                        supports_subagents: false,
                        supports_attachments: true,
                        default_reasoning_effort: Some("medium".to_string()),
                    },
                    metadata: Default::default(),
                    raw: serde_json::json!({ "id": "gpt-5" }),
                }],
                metadata: Default::default(),
                raw_payload: serde_json::json!({ "models": [] }),
            },
        });

        assert_eq!(projection.runtime_id, "codex");
        assert_eq!(projection.models.len(), 1);
        assert_eq!(projection.models[0].display_name, "GPT-5");
        assert_eq!(projection.models[0].context_window, Some(256_000));
        assert!(projection.models[0].supports_tools);
        assert!(projection.models[0].supports_attachments);
    }

    #[test]
    fn suggested_worktree_branch_uses_thread_title() {
        let thread = ThreadSummary {
            id: ThreadId("thread-1".to_string()),
            provider_thread_id: None,
            project_id: ProjectId::new(),
            title: "Implement Worktree Manager!".to_string(),
            status: ThreadStatus::Idle,
            provider: ace_core::ProviderKind::Codex,
            model: None,
            pinned: false,
            archived: false,
            pinned_item_count: 0,
            highlighted_count: 0,
            todo_count: 0,
            open_todo_count: 0,
            unseen_completion: false,
            latest_activity_at: "now".to_string(),
            latest_message_preview: None,
            pending_approvals: 0,
            pending_user_inputs: 0,
            has_actionable_plan: false,
            branch: Some("main".to_string()),
            worktree_path: None,
        };

        assert_eq!(
            suggested_worktree_branch(&thread),
            "ace/implement-worktree-manager"
        );
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
        assert_eq!(projection.todos[0].priority, TodoPriority::Normal);
        assert_eq!(projection.todos[0].created_by, TodoCreatedBy::User);
        assert_eq!(projection.todos[0].assigned_to, TodoAssignee::Both);
        let todo_id = projection.todos[0].id.clone();

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
                ..ReviewProjection::default()
            },
        );
        store.create_review_comment_for_file("src/lib.rs".to_string());
        let projection = store.projection().annotations;
        assert_eq!(projection.review_comments.len(), 1);
        assert_eq!(projection.open_review_comment_count, 1);
        let review_comment_id = projection.review_comments[0].id.clone();

        store.toggle_review_comment_resolved(&review_comment_id);
        let projection = store.projection().annotations;
        assert!(projection.review_comments[0].resolved);
        assert_eq!(projection.open_review_comment_count, 0);

        store.update_todo_priority(&todo_id, TodoPriority::High);
        store.update_todo_assignee(&todo_id, TodoAssignee::Agent);
        store.link_todo_to_current_diff(&todo_id);
        let projection = store.projection().annotations;
        assert_eq!(projection.todos[0].priority, TodoPriority::High);
        assert_eq!(projection.todos[0].assigned_to, TodoAssignee::Agent);
        assert_eq!(projection.todos[0].related_files, vec!["src/lib.rs"]);
        assert_eq!(
            projection.todos[0].related_diff_comments,
            vec![review_comment_id.clone()]
        );

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
        assert_eq!(projection.todos[0].priority, TodoPriority::High);
        assert_eq!(projection.todos[0].assigned_to, TodoAssignee::Agent);
        assert_eq!(projection.todos[0].related_files, vec!["src/lib.rs"]);
        assert_eq!(projection.review_comments.len(), 1);
        assert!(projection.review_comments[0].resolved);
    }

    #[test]
    fn sidebar_threads_include_annotation_counts() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Track sidebar context".to_string(),
            },
        );
        let first_message_id = store.projection().chat.messages[0].id.clone();

        store.pin_timeline_item(thread_id.clone(), &first_message_id);
        store.toggle_highlight_timeline_item(thread_id.clone(), &first_message_id);
        store.create_todo_from_timeline_item(thread_id.clone(), &first_message_id);

        let projection = store.projection();
        let thread = projection
            .sidebar
            .projects
            .iter()
            .flat_map(|group| group.threads.iter())
            .find(|thread| thread.id == thread_id)
            .expect("sidebar thread");
        assert_eq!(thread.pinned_item_count, 1);
        assert_eq!(thread.highlighted_count, 1);
        assert_eq!(thread.todo_count, 1);
        assert_eq!(thread.open_todo_count, 1);

        let todo_id = projection.annotations.todos[0].id.clone();
        store.update_todo_status(&todo_id, TodoStatus::Done);

        let projection = store.projection();
        let thread = projection
            .sidebar
            .projects
            .iter()
            .flat_map(|group| group.threads.iter())
            .find(|thread| thread.id == thread_id)
            .expect("sidebar thread");
        assert_eq!(thread.todo_count, 1);
        assert_eq!(thread.open_todo_count, 0);
    }

    #[test]
    fn sidebar_threads_include_latest_message_preview() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let direct_thread_id = store.new_thread(project_id);
        let long_prompt = format!("{}é", "a".repeat(180));
        store.send_message(
            direct_thread_id.clone(),
            ComposerPayload {
                prompt: long_prompt,
            },
        );

        let derived_thread_id = store.new_thread(project_id);
        store
            .threads
            .iter_mut()
            .find(|thread| thread.id == derived_thread_id)
            .expect("thread")
            .latest_message_preview = None;
        store.persisted_messages.insert(
            derived_thread_id.clone(),
            vec![chat_message(
                "assistant-1".to_string(),
                ChatMessageRole::Assistant,
                "Derived from persisted assistant state".to_string(),
            )],
        );

        let projection = store.projection();
        let direct = projection
            .sidebar
            .projects
            .iter()
            .flat_map(|group| group.threads.iter())
            .find(|thread| thread.id == direct_thread_id)
            .expect("direct thread");
        let direct_preview = direct
            .latest_message_preview
            .as_deref()
            .expect("direct preview");
        assert!(direct_preview.ends_with("..."));
        assert!(std::str::from_utf8(direct_preview.as_bytes()).is_ok());

        let derived = projection
            .sidebar
            .projects
            .iter()
            .flat_map(|group| group.threads.iter())
            .find(|thread| thread.id == derived_thread_id)
            .expect("derived thread");
        assert_eq!(
            derived.latest_message_preview.as_deref(),
            Some("Derived from persisted assistant state")
        );
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
    fn composer_selection_updates_draft_and_survives_send() {
        let mut store = DesktopStore::new();
        store.add_project("/tmp/project".to_string());
        store.new_thread_for_first_project();

        store.set_active_composer_model(ProviderKind::Codex, "gpt-5".to_string());
        store.set_active_composer_reasoning(Some(ReasoningEffort::High));
        store.set_active_composer_permission(ComposerPermissionMode::FullAccess);
        store.toggle_active_composer_trait(ComposerTrait::Precise);
        store.toggle_active_composer_context(ComposerContextKind::Todos);
        store.push_active_composer_input("implement model selection");

        let draft = store.projection().chat.composer.expect("draft");
        assert_eq!(draft.model_selection.model, "gpt-5");
        assert_eq!(draft.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(draft.permission_mode, ComposerPermissionMode::FullAccess);
        assert_eq!(draft.traits, vec![ComposerTrait::Precise]);
        assert_eq!(draft.context, vec![ComposerContextKind::Todos]);

        store.send_active_composer();

        let projection = store.projection();
        let user_message = projection
            .chat
            .messages
            .iter()
            .find(|message| message.role == ChatMessageRole::User)
            .expect("user message");
        let summary = user_message
            .turn_settings_summary
            .as_deref()
            .expect("turn settings summary");
        assert!(summary.contains("gpt-5"), "{summary}");
        assert!(summary.contains("Full access"), "{summary}");
        assert!(summary.contains("High reasoning"), "{summary}");
        assert!(summary.contains("Precise"), "{summary}");
        assert!(summary.contains("Todos"), "{summary}");
        let thread = projection.chat.active_thread.expect("active thread");
        assert_eq!(thread.provider, ProviderKind::Codex);
        assert_eq!(thread.model.as_deref(), Some("gpt-5"));
        let next_draft = projection.chat.composer.expect("next draft");
        assert!(next_draft.prompt.is_empty());
        assert_eq!(next_draft.model_selection.model, "gpt-5");
        assert_eq!(next_draft.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(
            next_draft.permission_mode,
            ComposerPermissionMode::FullAccess
        );
        assert_eq!(next_draft.traits, vec![ComposerTrait::Precise]);
        assert_eq!(next_draft.context, vec![ComposerContextKind::Todos]);
    }

    #[test]
    fn new_thread_inherits_active_composer_turn_settings_for_project() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        store.new_thread_for_first_project();

        store.set_active_composer_model(ProviderKind::Codex, "gpt-5".to_string());
        store.set_active_composer_reasoning(Some(ReasoningEffort::High));
        store.set_active_composer_permission(ComposerPermissionMode::FullAccess);
        store.set_active_composer_runtime_mode(RuntimeMode::Local);
        store.set_active_composer_interaction_mode(InteractionMode::Plan);
        store.toggle_active_composer_trait(ComposerTrait::Precise);
        store.toggle_active_composer_context(ComposerContextKind::Todos);
        store.push_active_composer_input("implement inherited composer settings");
        store.send_active_composer();

        let next_thread_id = store.new_thread(project_id);
        let next_draft = store
            .composer_drafts
            .get(&next_thread_id)
            .expect("next composer draft");

        assert!(next_draft.prompt.is_empty());
        assert_eq!(next_draft.model_selection.model, "gpt-5");
        assert_eq!(next_draft.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(
            next_draft.permission_mode,
            ComposerPermissionMode::FullAccess
        );
        assert_eq!(next_draft.runtime_mode, RuntimeMode::Local);
        assert_eq!(next_draft.interaction_mode, InteractionMode::Plan);
        assert_eq!(next_draft.traits, vec![ComposerTrait::Precise]);
        assert_eq!(next_draft.context, vec![ComposerContextKind::Todos]);
    }

    #[test]
    fn composer_turn_input_includes_selected_traits_and_context() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Create the initial implementation".to_string(),
            },
        );
        let first_message_id = store.projection().chat.messages[0].id.clone();
        store.pin_timeline_item(thread_id.clone(), &first_message_id);
        store.create_todo_from_timeline_item(thread_id.clone(), &first_message_id);
        store.toggle_active_composer_trait(ComposerTrait::TestFocused);
        store.toggle_active_composer_context(ComposerContextKind::Pinned);
        store.toggle_active_composer_context(ComposerContextKind::Todos);

        let draft = store
            .composer_drafts
            .get(&thread_id)
            .expect("composer draft")
            .clone();
        let input = store.composer_turn_input(&thread_id, "Use the selected context", &draft);
        let joined = input
            .iter()
            .filter_map(|item| item.get("text").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(joined.contains("Agent traits selected for this turn"));
        assert!(joined.contains("verifiable behavior"));
        assert!(joined.contains("Pinned context"));
        assert!(joined.contains("Todo context"));
        assert!(joined.contains("Use the selected context"));
    }

    #[test]
    fn active_project_default_model_is_reused_by_new_threads() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        store.new_thread(project_id);
        store.set_active_composer_model(ProviderKind::Codex, "gpt-5".to_string());

        store.set_active_project_default_model(None);

        let project = store
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .expect("project");
        assert_eq!(
            project.default_model_selection,
            Some(ModelSelection {
                provider: "codex".to_string(),
                model: "gpt-5".to_string(),
            })
        );
        assert_eq!(
            store.projection().active_project_default_model.as_deref(),
            Some("Codex · gpt-5")
        );

        let next_thread_id = store.new_thread(project_id);
        let next_draft = store
            .composer_drafts
            .get(&next_thread_id)
            .expect("next draft");
        assert_eq!(next_draft.model_selection.model, "gpt-5");
    }

    #[test]
    fn composer_turn_input_includes_mentioned_thread_context() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Investigate the regression".to_string(),
            },
        );
        let first_message_id = store.projection().chat.messages[0].id.clone();
        store.pin_timeline_item(thread_id.clone(), &first_message_id);
        store.create_todo_from_timeline_item(thread_id.clone(), &first_message_id);
        store.create_review_comment_for_file("src/lib.rs".to_string());
        let pin_id = store.projection().annotations.pinned_items[0].id.clone();
        let todo_id = store.projection().annotations.todos[0].id.clone();
        let review_comment_id = store.projection().annotations.review_comments[0].id.clone();
        store.terminal_sessions.insert(
            TerminalKey::default_for_thread(&thread_id),
            TerminalSessionProjection {
                thread_id: thread_id.0.clone(),
                terminal_id: DEFAULT_TERMINAL_ID.to_string(),
                cwd: "/tmp/project".to_string(),
                title: None,
                status: TerminalSessionStatus::Running,
                pid: Some(42),
                history: "cargo test failed".to_string(),
                exit_code: None,
                exit_signal: None,
                cols: DEFAULT_TERMINAL_COLS,
                rows: DEFAULT_TERMINAL_ROWS,
                updated_at: "now".to_string(),
                next_sequence: 1,
                truncated_before_sequence: None,
            },
        );
        store.review_snapshots.insert(
            project_id,
            ReviewProjection {
                repo_path: Some("/tmp/project".to_string()),
                files: vec![ReviewFileProjection {
                    path: "src/lib.rs".to_string(),
                    original_path: None,
                    status: "modified".to_string(),
                    additions: Some(3),
                    deletions: Some(1),
                }],
                total_additions: 3,
                total_deletions: 1,
                ..ReviewProjection::default()
            },
        );

        let draft = store
            .composer_drafts
            .get(&thread_id)
            .expect("composer draft")
            .clone();
        let prompt = format!(
            "Use @todo:{todo_id} @pin:{pin_id} @review:{review_comment_id} @terminal @diff"
        );
        let input = store.composer_turn_input(&thread_id, &prompt, &draft);
        let joined = input
            .iter()
            .filter_map(|item| item.get("text").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(joined.contains("Mentioned composer context"));
        assert!(joined.contains("Mentioned todo"));
        assert!(joined.contains("Mentioned pinned context"));
        assert!(joined.contains("Mentioned review comment"));
        assert!(joined.contains("cargo test failed"));
        assert!(joined.contains("src/lib.rs"));
    }

    #[test]
    fn composer_history_recalls_prompts_and_restores_scratch() {
        let mut store = DesktopStore::new();
        store.add_project("/tmp/project".to_string());
        store.push_active_composer_input("first prompt");
        store.send_active_composer();
        store.push_active_composer_input("second prompt");
        store.send_active_composer();
        store.push_active_composer_input("scratch prompt");

        store.recall_active_composer_history(true);
        assert_eq!(
            store.projection().chat.composer.unwrap().prompt,
            "second prompt"
        );

        store.recall_active_composer_history(true);
        assert_eq!(
            store.projection().chat.composer.unwrap().prompt,
            "first prompt"
        );

        store.recall_active_composer_history(false);
        assert_eq!(
            store.projection().chat.composer.unwrap().prompt,
            "second prompt"
        );

        store.recall_active_composer_history(false);
        assert_eq!(
            store.projection().chat.composer.unwrap().prompt,
            "scratch prompt"
        );
    }

    #[test]
    fn composer_token_completion_replaces_active_token() {
        let mut store = DesktopStore::new();
        store.add_project("/tmp/project".to_string());
        store.push_active_composer_input("please /mo");

        store.complete_active_composer_token("/model");

        assert_eq!(
            store.projection().chat.composer.unwrap().prompt,
            "please /model "
        );
    }

    #[test]
    fn composer_commands_are_resolved_from_registries() {
        let mut store = DesktopStore::new();
        store
            .provider_registry
            .commands
            .push(ProviderSlashCommandProjection {
                provider: "codex".to_string(),
                name: "model".to_string(),
                description: "Choose the active model".to_string(),
                prompt_prefix: Some("/model".to_string()),
                input_hint: Some("<model>".to_string()),
                kind: Some("Provider".to_string()),
            });
        store
            .skill_registry
            .entries
            .push(ToolRegistryEntryProjection {
                id: "review".to_string(),
                name: "review".to_string(),
                description: Some("Run the review skill".to_string()),
                version: None,
                source: Some("skills".to_string()),
                status: "enabled".to_string(),
                enabled: Some(true),
                disabled_reason: None,
            });
        store
            .plugin_registry
            .entries
            .push(ToolRegistryEntryProjection {
                id: "browser".to_string(),
                name: "browser".to_string(),
                description: Some("Use browser automation".to_string()),
                version: None,
                source: Some("plugins".to_string()),
                status: "enabled".to_string(),
                enabled: Some(true),
                disabled_reason: None,
            });

        let commands = store
            .composer_commands_for_prompt("Use /model $review @browser @todo:todo-1 @terminal");

        assert_eq!(commands.len(), 3);
        assert!(commands.iter().any(|command| {
            command.source == ComposerCommandSource::ProviderSlash
                && command.name == "model"
                && command.provider.as_deref() == Some("codex")
        }));
        assert!(
            commands
                .iter()
                .any(|command| command.source == ComposerCommandSource::Skill
                    && command.name == "review")
        );
        assert!(
            commands
                .iter()
                .any(|command| command.source == ComposerCommandSource::Plugin
                    && command.name == "browser")
        );
    }

    #[test]
    fn composer_commands_ignore_disabled_registry_entries() {
        let mut store = DesktopStore::new();
        store
            .skill_registry
            .entries
            .push(ToolRegistryEntryProjection {
                id: "review".to_string(),
                name: "review".to_string(),
                description: Some("Run the review skill".to_string()),
                version: None,
                source: Some("skills".to_string()),
                status: "disabled".to_string(),
                enabled: Some(false),
                disabled_reason: Some("Project policy disables review automation.".to_string()),
            });
        store
            .plugin_registry
            .entries
            .push(ToolRegistryEntryProjection {
                id: "browser".to_string(),
                name: "browser".to_string(),
                description: Some("Use browser automation".to_string()),
                version: None,
                source: Some("plugins".to_string()),
                status: "unavailable".to_string(),
                enabled: None,
                disabled_reason: Some("Browser bridge is not connected.".to_string()),
            });
        store
            .plugin_registry
            .entries
            .push(ToolRegistryEntryProjection {
                id: "github".to_string(),
                name: "github".to_string(),
                description: Some("Use GitHub tooling".to_string()),
                version: None,
                source: Some("plugins".to_string()),
                status: "enabled".to_string(),
                enabled: Some(true),
                disabled_reason: None,
            });

        let commands = store.composer_commands_for_prompt("Use $review @browser @github");

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "github");
        assert_eq!(commands[0].source, ComposerCommandSource::Plugin);
    }

    #[test]
    fn composer_turn_input_includes_command_context() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store
            .provider_registry
            .commands
            .push(ProviderSlashCommandProjection {
                provider: "codex".to_string(),
                name: "plan".to_string(),
                description: "Create an implementation plan".to_string(),
                prompt_prefix: Some("/plan".to_string()),
                input_hint: None,
                kind: Some("Provider".to_string()),
            });
        let draft = store
            .composer_drafts
            .get(&thread_id)
            .expect("composer draft")
            .clone();

        let input = store.composer_turn_input(&thread_id, "Please /plan the work", &draft);

        assert!(
            input.iter().any(|item| {
                item.get("text")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|text| {
                        text.contains("Composer command selections")
                            && text.contains("Provider slash command")
                            && text.contains("Create an implementation plan")
                    })
            }),
            "{input:?}"
        );
        assert_eq!(
            input.last().and_then(|item| item.get("text")),
            Some(&serde_json::json!("Please /plan the work"))
        );
    }

    #[test]
    fn projection_exposes_detected_composer_commands() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        store.new_thread(project_id);
        store
            .skill_registry
            .entries
            .push(ToolRegistryEntryProjection {
                id: "audit".to_string(),
                name: "audit".to_string(),
                description: Some("Audit current changes".to_string()),
                version: None,
                source: Some("skills".to_string()),
                status: "enabled".to_string(),
                enabled: Some(true),
                disabled_reason: None,
            });
        store.push_active_composer_input("Run $audit");

        let projection = store.projection();

        assert_eq!(projection.composer_commands.len(), 1);
        assert_eq!(
            projection.composer_commands[0].source,
            ComposerCommandSource::Skill
        );
        assert_eq!(projection.composer_commands[0].token, "$audit");
    }

    #[test]
    fn composer_runtime_mode_resolves_backend_cwd() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);

        assert_eq!(
            store.composer_cwd_for_thread(&thread_id, RuntimeMode::Normal),
            None
        );
        assert_eq!(
            store.composer_cwd_for_thread(&thread_id, RuntimeMode::Local),
            Some("/tmp/project".to_string())
        );

        let thread = store
            .threads
            .iter_mut()
            .find(|thread| thread.id == thread_id)
            .expect("thread");
        thread.worktree_path = Some("/tmp/project-worktree".to_string());

        assert_eq!(
            store.composer_cwd_for_thread(&thread_id, RuntimeMode::Worktree),
            Some("/tmp/project-worktree".to_string())
        );
        assert_eq!(
            store.composer_cwd_for_thread(&thread_id, RuntimeMode::Remote),
            None
        );
    }

    #[test]
    fn host_options_project_connected_remote_hosts_first() {
        let mut store = DesktopStore::new();
        store.runtime.remote_connections = vec![
            remote_connection("devbox-b", Some("offline")),
            RemoteConnectionRecord {
                execution_location: ExecutionLocation::Local,
                ..remote_connection("local-bridge", Some("connected"))
            },
            remote_connection("devbox-a", Some("connected")),
        ];

        let hosts = store.projection().host_options;

        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].host_id, "devbox-a");
        assert!(hosts[0].connected);
        assert_eq!(hosts[1].host_id, "devbox-b");
        assert!(!hosts[1].connected);
    }

    #[test]
    fn host_options_include_remote_project_counts() {
        let mut store = DesktopStore::new();
        store.runtime.remote_connections = vec![RemoteConnectionRecord {
            projects: serde_json::json!([
                { "path": "/srv/app" },
                { "path": "/srv/worker" }
            ]),
            ..remote_connection("devbox", Some("connected"))
        }];

        let hosts = store.projection().host_options;

        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].project_count, 2);
        assert!(hosts[0].detail.contains("2 projects"));
    }

    #[test]
    fn remote_composer_mode_selects_and_clears_connected_host() {
        let mut store = DesktopStore::new();
        store.runtime.remote_connections = vec![remote_connection("devbox", Some("online"))];
        store.add_project("/tmp/project".to_string());

        store.set_active_composer_runtime_mode(RuntimeMode::Remote);
        let draft = store.projection().chat.composer.expect("composer");
        assert_eq!(draft.runtime_mode, RuntimeMode::Remote);
        assert_eq!(
            draft.host_selection,
            Some(ComposerHostSelection {
                provider: "codex".to_string(),
                host_id: "devbox".to_string(),
            })
        );

        store.set_active_composer_host(None);
        let draft = store.projection().chat.composer.expect("composer");
        assert_eq!(draft.runtime_mode, RuntimeMode::Local);
        assert_eq!(draft.host_selection, None);
    }

    #[test]
    fn composer_permission_modes_map_to_codex_turn_policies() {
        let strict = permission_payload(ComposerPermissionMode::Strict);
        assert_eq!(strict.sandbox_policy["mode"], "read-only");
        assert_eq!(strict.approval_policy["mode"], "on-request");
        assert_eq!(strict.approvals_reviewer, Some("user"));

        let full_access = permission_payload(ComposerPermissionMode::FullAccess);
        assert_eq!(full_access.sandbox_policy["mode"], "danger-full-access");
        assert_eq!(full_access.approval_policy["mode"], "never");
        assert_eq!(full_access.approvals_reviewer, None);
    }

    #[test]
    fn composer_collaboration_mode_carries_structured_runtime_settings() {
        let mut draft = ComposerDraft::empty(ThreadId::new(), "1");
        draft.model_selection = ProviderModelSelection {
            provider: ProviderKind::Codex,
            model: "gpt-5-large".to_string(),
        };
        draft.host_selection = Some(ace_runtime::chat::ComposerHostSelection {
            provider: "codex".to_string(),
            host_id: "ssh-prod".to_string(),
        });
        draft.reasoning_effort = Some(ReasoningEffort::High);
        draft.permission_mode = ComposerPermissionMode::AutoReview;
        draft.traits = vec![ComposerTrait::Precise, ComposerTrait::TestFocused];
        draft.context = vec![ComposerContextKind::Pinned, ComposerContextKind::Todos];
        draft.runtime_mode = RuntimeMode::Remote;
        draft.interaction_mode = InteractionMode::Plan;

        let permissions = permission_payload(draft.permission_mode);
        let collaboration_mode = composer_collaboration_mode(
            &draft,
            draft.reasoning_effort.map(ReasoningEffort::provider_value),
            &permissions,
        );

        assert_eq!(collaboration_mode["mode"], "plan");
        assert_eq!(collaboration_mode["settings"]["model"], "gpt-5-large");
        assert_eq!(collaboration_mode["settings"]["model_provider"], "codex");
        assert_eq!(collaboration_mode["settings"]["reasoning_effort"], "high");
        assert_eq!(collaboration_mode["settings"]["interaction_mode"], "plan");
        assert_eq!(collaboration_mode["settings"]["runtime_mode"], "remote");
        assert_eq!(
            collaboration_mode["settings"]["permission_mode"],
            "auto_review"
        );
        assert_eq!(
            collaboration_mode["settings"]["sandbox_policy"]["mode"],
            "workspace-write"
        );
        assert_eq!(
            collaboration_mode["settings"]["approval_policy"]["mode"],
            "on-request"
        );
        assert_eq!(
            collaboration_mode["settings"]["approvals_reviewer"],
            "auto_review"
        );
        assert_eq!(
            collaboration_mode["settings"]["traits"],
            serde_json::json!(["precise", "test_focused"])
        );
        assert_eq!(
            collaboration_mode["settings"]["context"],
            serde_json::json!(["pinned", "todos"])
        );
        assert_eq!(collaboration_mode["settings"]["host"]["provider"], "codex");
        assert_eq!(
            collaboration_mode["settings"]["host"]["host_id"],
            "ssh-prod"
        );
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
                pinned_item_count: 0,
                highlighted_count: 0,
                todo_count: 0,
                open_todo_count: 0,
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
