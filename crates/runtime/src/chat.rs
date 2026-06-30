use crate::{
    provider::{ThreadItemKind, ThreadItemStatus},
    threads::{AgentRuntimeSnapshot, ExecutionLocation, PlanSessionStatus, TurnMode},
};
use ace_core::{IsoDateTime, ModelSelection, Project, ProjectId, ProviderKind, ThreadId};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeMode {
    #[default]
    Normal,
    Local,
    Worktree,
    Remote,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionMode {
    #[default]
    Chat,
    Plan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderModelSelection {
    pub provider: ProviderKind,
    pub model: String,
}

impl Default for ProviderModelSelection {
    fn default() -> Self {
        Self {
            provider: ProviderKind::Codex,
            model: "gpt-5.3-codex".to_string(),
        }
    }
}

impl From<ModelSelection> for ProviderModelSelection {
    fn from(selection: ModelSelection) -> Self {
        Self {
            provider: ProviderKind::from_runtime_id(&selection.provider)
                .unwrap_or(ProviderKind::Codex),
            model: selection.model,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComposerHostSelection {
    pub provider: String,
    pub host_id: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Low,
    #[default]
    Medium,
    High,
}

impl ReasoningEffort {
    pub const ALL: [Self; 3] = [Self::Low, Self::Medium, Self::High];

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Medium => "Medium",
            Self::High => "High",
        }
    }

    #[must_use]
    pub fn provider_value(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposerPermissionMode {
    Strict,
    #[default]
    Auto,
    AutoReview,
    FullAccess,
}

impl ComposerPermissionMode {
    pub const ALL: [Self; 4] = [Self::Strict, Self::Auto, Self::AutoReview, Self::FullAccess];

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Strict => "Ask first",
            Self::Auto => "Auto",
            Self::AutoReview => "Auto review",
            Self::FullAccess => "Full access",
        }
    }

    #[must_use]
    pub fn detail(self) -> &'static str {
        match self {
            Self::Strict => "Read-only with user approvals",
            Self::Auto => "Workspace edits with approvals",
            Self::AutoReview => "Workspace edits with auto review",
            Self::FullAccess => "No approval sandbox",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposerTrait {
    Precise,
    Fast,
    TestFocused,
    ReviewFocused,
}

impl ComposerTrait {
    pub const ALL: [Self; 4] = [
        Self::Precise,
        Self::Fast,
        Self::TestFocused,
        Self::ReviewFocused,
    ];

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Precise => "Precise",
            Self::Fast => "Fast",
            Self::TestFocused => "Tested",
            Self::ReviewFocused => "Review",
        }
    }

    #[must_use]
    pub fn detail(self) -> &'static str {
        match self {
            Self::Precise => "Prefer correctness and narrow edits",
            Self::Fast => "Prioritize direct implementation",
            Self::TestFocused => "Add or run relevant checks",
            Self::ReviewFocused => "Surface risks while coding",
        }
    }

    #[must_use]
    pub fn instruction(self) -> &'static str {
        match self {
            Self::Precise => "Make narrow, coherent changes and state assumptions explicitly.",
            Self::Fast => "Prioritize direct progress and avoid unnecessary detours.",
            Self::TestFocused => {
                "Design the change around verifiable behavior and run relevant checks."
            }
            Self::ReviewFocused => {
                "Call out risks, regressions, and follow-up test gaps while implementing."
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposerContextKind {
    Pinned,
    Highlights,
    Todos,
    Terminal,
}

impl ComposerContextKind {
    pub const ALL: [Self; 4] = [Self::Pinned, Self::Highlights, Self::Todos, Self::Terminal];

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Pinned => "Pinned",
            Self::Highlights => "Highlights",
            Self::Todos => "Todos",
            Self::Terminal => "Terminal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: ProjectId,
    pub name: String,
    pub workspace_root: String,
    pub icon: Option<String>,
    #[serde(default)]
    pub icon_color: Option<String>,
    pub archived: bool,
    pub thread_count: usize,
    pub updated_at: IsoDateTime,
}

impl ProjectSummary {
    #[must_use]
    pub fn from_project(project: &Project, thread_count: usize) -> Self {
        Self {
            id: project.id,
            name: project.title.clone(),
            workspace_root: project.workspace_root.clone(),
            icon: project.icon.as_ref().map(|icon| icon.kind.clone()),
            icon_color: project.icon.as_ref().map(|icon| icon.value.clone()),
            archived: project.archived_at.is_some(),
            thread_count,
            updated_at: project.updated_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Error,
    Working,
    Connecting,
    PendingApproval,
    AwaitingInput,
    PlanReady,
    Completed,
    Draft,
    Idle,
    Archived,
}

impl ThreadStatus {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Error => "Error",
            Self::Working => "Working",
            Self::Connecting => "Connecting",
            Self::PendingApproval => "Pending Approval",
            Self::AwaitingInput => "Awaiting Input",
            Self::PlanReady => "Plan Ready",
            Self::Completed => "Completed",
            Self::Draft => "Draft",
            Self::Idle => "Idle",
            Self::Archived => "Archived",
        }
    }

    #[must_use]
    pub fn priority(self) -> u8 {
        match self {
            Self::Error => 0,
            Self::Working => 1,
            Self::Connecting => 2,
            Self::PendingApproval => 3,
            Self::AwaitingInput => 4,
            Self::PlanReady => 5,
            Self::Completed => 6,
            Self::Draft => 7,
            Self::Idle => 8,
            Self::Archived => 9,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadDraft {
    pub thread_id: ThreadId,
    pub project_id: ProjectId,
    pub created_at: IsoDateTime,
    pub runtime_mode: RuntimeMode,
    pub interaction_mode: InteractionMode,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub env_mode: ExecutionLocation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComposerDraft {
    pub thread_id: ThreadId,
    pub prompt: String,
    pub model_selection: ProviderModelSelection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_selection: Option<ComposerHostSelection>,
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub permission_mode: ComposerPermissionMode,
    #[serde(default)]
    pub traits: Vec<ComposerTrait>,
    #[serde(default)]
    pub context: Vec<ComposerContextKind>,
    pub runtime_mode: RuntimeMode,
    pub interaction_mode: InteractionMode,
    pub image_paths: Vec<String>,
    pub terminal_contexts: Vec<String>,
    pub updated_at: IsoDateTime,
}

impl ComposerDraft {
    #[must_use]
    pub fn empty(thread_id: ThreadId, updated_at: impl Into<IsoDateTime>) -> Self {
        Self {
            thread_id,
            prompt: String::new(),
            model_selection: ProviderModelSelection::default(),
            host_selection: None,
            reasoning_effort: Some(ReasoningEffort::Medium),
            permission_mode: ComposerPermissionMode::default(),
            traits: Vec::new(),
            context: Vec::new(),
            runtime_mode: RuntimeMode::default(),
            interaction_mode: InteractionMode::default(),
            image_paths: Vec::new(),
            terminal_contexts: Vec::new(),
            updated_at: updated_at.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub provider_thread_id: Option<String>,
    pub project_id: ProjectId,
    pub title: String,
    pub status: ThreadStatus,
    pub provider: ProviderKind,
    pub model: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    #[serde(default)]
    pub pinned_item_count: usize,
    #[serde(default)]
    pub highlighted_count: usize,
    #[serde(default)]
    pub todo_count: usize,
    #[serde(default)]
    pub open_todo_count: usize,
    pub unseen_completion: bool,
    pub latest_activity_at: IsoDateTime,
    pub latest_message_preview: Option<String>,
    pub pending_approvals: usize,
    pub pending_user_inputs: usize,
    pub has_actionable_plan: bool,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarMetadata {
    pub pinned_thread_ids: HashSet<ThreadId>,
    pub archived_thread_ids: HashSet<ThreadId>,
    pub unseen_completed_thread_ids: HashSet<ThreadId>,
    pub project_order: Vec<ProjectId>,
    pub active_thread_id: Option<ThreadId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarProjectGroup {
    pub project: ProjectSummary,
    pub threads: Vec<ThreadSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarProjection {
    pub projects: Vec<SidebarProjectGroup>,
    pub selected_thread_ids: Vec<ThreadId>,
    pub active_thread_id: Option<ThreadId>,
    pub total_thread_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessageProjection {
    pub id: String,
    pub role: ChatMessageRole,
    pub status: ThreadItemStatus,
    pub title: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageRole {
    User,
    Assistant,
    Tool,
    Plan,
    Activity,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatProjection {
    pub active_thread: Option<ThreadSummary>,
    pub messages: Vec<ChatMessageProjection>,
    pub composer: Option<ComposerDraft>,
    pub can_send: bool,
    pub can_interrupt: bool,
    pub queued_messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreationContext {
    pub active_thread_id: Option<ThreadId>,
    pub active_draft: Option<ThreadDraft>,
    pub default_env_mode: ExecutionLocation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadCreationOptions {
    pub runtime_mode: RuntimeMode,
    pub interaction_mode: InteractionMode,
    pub env_mode: ExecutionLocation,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
}

#[must_use]
pub fn resolve_thread_creation_options(
    project_id: ProjectId,
    active_thread: Option<&ThreadSummary>,
    context: &CreationContext,
) -> ThreadCreationOptions {
    if let Some(draft) = context
        .active_draft
        .as_ref()
        .filter(|draft| draft.project_id == project_id)
    {
        return ThreadCreationOptions {
            runtime_mode: draft.runtime_mode,
            interaction_mode: draft.interaction_mode,
            env_mode: draft.env_mode,
            branch: draft.branch.clone(),
            worktree_path: draft.worktree_path.clone(),
        };
    }

    if let Some(thread) = active_thread.filter(|thread| thread.project_id == project_id) {
        return ThreadCreationOptions {
            runtime_mode: RuntimeMode::Normal,
            interaction_mode: InteractionMode::Chat,
            env_mode: if thread.worktree_path.is_some() {
                ExecutionLocation::Worktree
            } else {
                context.default_env_mode
            },
            branch: thread.branch.clone(),
            worktree_path: thread.worktree_path.clone(),
        };
    }

    ThreadCreationOptions {
        runtime_mode: RuntimeMode::Normal,
        interaction_mode: InteractionMode::Chat,
        env_mode: context.default_env_mode,
        branch: None,
        worktree_path: None,
    }
}

#[must_use]
pub fn build_sidebar_projection(
    projects: &[Project],
    threads: &[ThreadSummary],
    metadata: &SidebarMetadata,
) -> SidebarProjection {
    let mut threads_by_project: HashMap<ProjectId, Vec<ThreadSummary>> = HashMap::new();
    for thread in threads {
        if thread.archived && !metadata.archived_thread_ids.contains(&thread.id) {
            continue;
        }
        threads_by_project
            .entry(thread.project_id)
            .or_default()
            .push(thread.clone());
    }

    for project_threads in threads_by_project.values_mut() {
        project_threads.sort_by_key(|thread| {
            (
                !thread.pinned,
                thread.status.priority(),
                Reverse(thread.latest_activity_at.clone()),
                thread.title.clone(),
            )
        });
    }

    let order_index = metadata
        .project_order
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect::<HashMap<_, _>>();

    let mut projects = projects
        .iter()
        .filter(|project| project.deleted_at.is_none())
        .map(|project| {
            let project_threads = threads_by_project.remove(&project.id).unwrap_or_default();
            SidebarProjectGroup {
                project: ProjectSummary::from_project(project, project_threads.len()),
                threads: project_threads,
            }
        })
        .collect::<Vec<_>>();

    projects.sort_by_key(|group| {
        (
            order_index
                .get(&group.project.id)
                .copied()
                .unwrap_or(usize::MAX),
            group.project.archived,
            group.project.name.clone(),
        )
    });

    let total_thread_count = projects.iter().map(|group| group.threads.len()).sum();
    SidebarProjection {
        projects,
        selected_thread_ids: metadata.active_thread_id.iter().cloned().collect(),
        active_thread_id: metadata.active_thread_id.clone(),
        total_thread_count,
    }
}

#[must_use]
pub fn build_chat_projection(
    thread: Option<ThreadSummary>,
    composer: Option<ComposerDraft>,
    runtime: &AgentRuntimeSnapshot,
) -> ChatProjection {
    let active_id = thread.as_ref().map(|thread| thread.id.0.as_str());
    let messages = runtime
        .thread_items
        .iter()
        .filter(|item| {
            active_id.is_none_or(|id| item.thread_id.as_deref() == Some(id))
                || item.thread_id.is_none() && thread.is_some()
        })
        .map(|item| ChatMessageProjection {
            id: item
                .item_id
                .clone()
                .unwrap_or_else(|| format!("thread-item:{:?}", item.kind)),
            role: message_role(item.kind),
            status: item.status,
            title: item.title.clone(),
            text: item.text.clone(),
        })
        .collect::<Vec<_>>();

    let can_interrupt = thread.as_ref().is_some_and(|thread| {
        matches!(
            thread.status,
            ThreadStatus::Working | ThreadStatus::Connecting
        )
    });
    let can_send = composer
        .as_ref()
        .is_some_and(|draft| !draft.prompt.trim().is_empty());

    ChatProjection {
        active_thread: thread,
        messages,
        composer,
        can_send,
        can_interrupt,
        queued_messages: Vec::new(),
    }
}

#[must_use]
pub fn thread_summary_from_runtime_thread(
    project_id: ProjectId,
    thread: &crate::threads::AgentThread,
    snapshot: &AgentRuntimeSnapshot,
    metadata: &SidebarMetadata,
) -> ThreadSummary {
    let pending_approvals = snapshot
        .approvals
        .iter()
        .filter(|approval| approval.request.thread_id.as_deref() == Some(thread.thread_id.as_str()))
        .count();
    let has_actionable_plan = thread
        .plan_session
        .as_ref()
        .is_some_and(|plan| plan.status == PlanSessionStatus::Completed);
    let active = thread
        .active_turn
        .as_ref()
        .is_some_and(|turn| turn.active || turn.mode == TurnMode::Plan);
    let provider = ProviderKind::from_runtime_id(&thread.provider).unwrap_or(ProviderKind::Codex);
    let id = ThreadId(thread.thread_id.clone());
    let archived = thread.archived.unwrap_or(false) || metadata.archived_thread_ids.contains(&id);
    ThreadSummary {
        id: id.clone(),
        provider_thread_id: Some(thread.thread_id.clone()),
        project_id,
        title: thread
            .name
            .clone()
            .unwrap_or_else(|| "Untitled thread".to_string()),
        status: if archived {
            ThreadStatus::Archived
        } else if pending_approvals > 0 {
            ThreadStatus::PendingApproval
        } else if has_actionable_plan {
            ThreadStatus::PlanReady
        } else if active {
            ThreadStatus::Working
        } else {
            ThreadStatus::Idle
        },
        provider,
        model: thread
            .settings
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string),
        pinned: metadata.pinned_thread_ids.contains(&id),
        archived,
        pinned_item_count: 0,
        highlighted_count: 0,
        todo_count: 0,
        open_todo_count: 0,
        unseen_completion: metadata.unseen_completed_thread_ids.contains(&id),
        latest_activity_at: "now".to_string(),
        latest_message_preview: None,
        pending_approvals,
        pending_user_inputs: 0,
        has_actionable_plan,
        branch: thread
            .metadata
            .get("branch")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string),
        worktree_path: thread
            .metadata
            .get("worktreePath")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string),
    }
}

fn message_role(kind: ThreadItemKind) -> ChatMessageRole {
    match kind {
        ThreadItemKind::UserMessage => ChatMessageRole::User,
        ThreadItemKind::AgentMessage | ThreadItemKind::Reasoning => ChatMessageRole::Assistant,
        ThreadItemKind::Plan => ChatMessageRole::Plan,
        ThreadItemKind::CommandExecution
        | ThreadItemKind::McpToolCall
        | ThreadItemKind::DynamicToolCall
        | ThreadItemKind::CollabAgentToolCall => ChatMessageRole::Tool,
        _ => ChatMessageRole::Activity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_core::ProjectId;

    fn project(id: ProjectId, title: &str) -> Project {
        Project {
            id,
            title: title.to_string(),
            workspace_root: format!("/tmp/{title}"),
            default_model_selection: None,
            scripts: Vec::new(),
            icon: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            archived_at: None,
            deleted_at: None,
        }
    }

    fn thread(
        project_id: ProjectId,
        title: &str,
        status: ThreadStatus,
        pinned: bool,
    ) -> ThreadSummary {
        ThreadSummary {
            id: ThreadId::new(),
            provider_thread_id: None,
            project_id,
            title: title.to_string(),
            status,
            provider: ProviderKind::Codex,
            model: Some("gpt-5.3-codex".to_string()),
            pinned,
            archived: false,
            pinned_item_count: 0,
            highlighted_count: 0,
            todo_count: 0,
            open_todo_count: 0,
            unseen_completion: false,
            latest_activity_at: "2026-01-01T00:00:00Z".to_string(),
            latest_message_preview: None,
            pending_approvals: 0,
            pending_user_inputs: 0,
            has_actionable_plan: false,
            branch: None,
            worktree_path: None,
        }
    }

    #[test]
    fn sidebar_sorts_pinned_and_status_priority_before_title() {
        let project_id = ProjectId::new();
        let threads = vec![
            thread(project_id, "Idle", ThreadStatus::Idle, false),
            thread(project_id, "Pinned", ThreadStatus::Idle, true),
            thread(project_id, "Working", ThreadStatus::Working, false),
        ];
        let projection = build_sidebar_projection(
            &[project(project_id, "ace")],
            &threads,
            &SidebarMetadata::default(),
        );
        let titles = projection.projects[0]
            .threads
            .iter()
            .map(|thread| thread.title.as_str())
            .collect::<Vec<_>>();
        assert_eq!(titles, ["Pinned", "Working", "Idle"]);
    }

    #[test]
    fn thread_creation_reuses_same_project_draft_context() {
        let project_id = ProjectId::new();
        let draft = ThreadDraft {
            thread_id: ThreadId::new(),
            project_id,
            created_at: "now".to_string(),
            runtime_mode: RuntimeMode::Normal,
            interaction_mode: InteractionMode::Plan,
            branch: Some("feature/sidebar".to_string()),
            worktree_path: Some("/tmp/worktree".to_string()),
            env_mode: ExecutionLocation::Worktree,
        };
        let options = resolve_thread_creation_options(
            project_id,
            None,
            &CreationContext {
                active_thread_id: Some(draft.thread_id.clone()),
                active_draft: Some(draft),
                default_env_mode: ExecutionLocation::Local,
            },
        );
        assert_eq!(options.interaction_mode, InteractionMode::Plan);
        assert_eq!(options.env_mode, ExecutionLocation::Worktree);
        assert_eq!(options.branch.as_deref(), Some("feature/sidebar"));
    }
}
