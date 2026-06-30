use crate::{
    actions::SelectSearchPaletteItem,
    stores::{
        ApprovalItemProjection, DesktopProjection, ModelProjection, ReviewProjection,
        SearchContextKind, TodoAssignee, TodoItem, TodoPriority, TodoStatus, ui::RightPanelTab,
    },
    ui::{
        components::*,
        theme::{CodeFont, Theme, ThemeAccent, ThemeDensity, ThemeMotion, ThemePreset, UiFont},
    },
};
use ace_core::{ProjectId, ProviderKind, ThreadId};
use ace_runtime::chat::{
    ComposerContextKind, ComposerPermissionMode, ComposerTrait, InteractionMode, ReasoningEffort,
    RuntimeMode, ThreadSummary,
};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::{IconName, scroll::ScrollableElement as _};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchPaletteMode {
    Root,
    NewThreadProject,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchPaletteItem {
    NewThread,
    NewProject,
    OpenScheduled,
    OpenSettings,
    OpenTerminals,
    OpenBrowser,
    ToggleRightPanel,
    RefreshActiveTab,
    CreateWorktree,
    ShowPinned,
    ShowTodos,
    ManagePlugins,
    ManageSkills,
    ConfigureProviders,
    ShowApprovals,
    SwitchModel,
    SetProjectDefaultModel,
    RunTests,
    RunLint,
    Inspector {
        tab: RightPanelTab,
        label: &'static str,
        description: &'static str,
    },
    ActiveThreadAction {
        action: ActiveThreadPaletteAction,
        label: String,
        description: String,
    },
    ComposerModel {
        provider: Option<ProviderKind>,
        model: String,
        label: String,
        description: String,
        selectable: bool,
    },
    ComposerTrait {
        trait_kind: ComposerTrait,
        label: String,
        description: String,
    },
    ComposerReasoning {
        effort: ReasoningEffort,
        label: String,
        description: String,
    },
    ComposerPermission {
        permission: ComposerPermissionMode,
        label: String,
        description: String,
    },
    ComposerRuntimeMode {
        runtime_mode: RuntimeMode,
        label: String,
        description: String,
        selectable: bool,
    },
    ComposerInteractionMode {
        interaction_mode: InteractionMode,
        label: String,
        description: String,
    },
    ComposerContext {
        context: ComposerContextKind,
        label: String,
        description: String,
        count: usize,
    },
    ComposerHost {
        provider: Option<String>,
        host_id: Option<String>,
        label: String,
        description: String,
        selectable: bool,
    },
    ThemePreset {
        preset: ThemePreset,
        label: String,
        description: String,
    },
    ThemeAccent {
        accent: ThemeAccent,
        label: String,
        description: String,
    },
    ThemeDensity {
        density: ThemeDensity,
        label: String,
        description: String,
    },
    ThemeMotion {
        motion: ThemeMotion,
        label: String,
        description: String,
    },
    UiFont {
        font: UiFont,
        label: String,
        description: String,
    },
    CodeFont {
        font: CodeFont,
        label: String,
        description: String,
    },
    Panel {
        tab: RightPanelTab,
        label: String,
        description: String,
        result_kind: SearchPaletteResultKind,
    },
    Message {
        thread_id: ThreadId,
        message_id: String,
        label: String,
        description: String,
    },
    Context {
        thread_id: Option<ThreadId>,
        tab: RightPanelTab,
        label: String,
        description: String,
    },
    ProjectAction {
        project_id: ProjectId,
        action: ProjectPaletteAction,
        label: String,
        description: String,
    },
    ApprovalAction {
        action: ApprovalPaletteAction,
        provider: String,
        request_id: String,
        label: String,
        description: String,
    },
    ReviewAction {
        action: ReviewPaletteAction,
        label: String,
        description: String,
    },
    TodoAction {
        todo_id: String,
        action: TodoPaletteAction,
        label: String,
        description: String,
    },
    Project {
        project_id: ProjectId,
        label: String,
        description: String,
    },
    Thread {
        thread_id: ThreadId,
        label: String,
        description: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveThreadPaletteAction {
    TogglePin,
    Archive,
    OpenTerminal,
    OpenBrowser,
    ShowPinned,
    ShowTodos,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectPaletteAction {
    NewThread,
    OpenTerminal,
    ShowWorktrees,
    CreateWorktree,
    Archive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalPaletteAction {
    Approve,
    Deny,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewPaletteAction {
    Refresh,
    StageAll,
    UnstageAll,
    Commit,
    Push,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TodoPaletteAction {
    Open,
    Start,
    Block,
    Complete,
    Cancel,
    Priority(TodoPriority),
    Assign(TodoAssignee),
    LinkCurrentDiff,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchPaletteResultKind {
    Source,
    Context,
    Registry,
}

fn inspector_palette_actions() -> Vec<SearchPaletteItem> {
    [
        (
            RightPanelTab::Environment,
            "Open environment",
            "Inspect host runtime, services, remote hosts, and operational signals.",
        ),
        (
            RightPanelTab::Summary,
            "Open summary",
            "Open thread summary, run state, model, context, and decisions.",
        ),
        (
            RightPanelTab::Review,
            "Open review",
            "Open Git-backed diff review and changed-file actions.",
        ),
        (
            RightPanelTab::Terminal,
            "Open terminal",
            "Open the PTY-backed terminal inspector.",
        ),
        (
            RightPanelTab::Worktrees,
            "Open worktrees",
            "Open Git worktree status and creation controls.",
        ),
        (
            RightPanelTab::Approvals,
            "Open approvals",
            "Open pending provider and tool approval requests.",
        ),
        (
            RightPanelTab::Browser,
            "Open browser",
            "Open host-driven browser bridge state and activity.",
        ),
        (
            RightPanelTab::Editor,
            "Open editor",
            "Open editor RPC capability and buffer candidate state.",
        ),
        (
            RightPanelTab::Sources,
            "Open sources",
            "Open files, terminal sessions, artifacts, and attached context sources.",
        ),
        (
            RightPanelTab::Pinned,
            "Open pinned",
            "Open pinned and highlighted thread context.",
        ),
        (
            RightPanelTab::Todos,
            "Open todos",
            "Open structured thread todos and review-linked tasks.",
        ),
        (
            RightPanelTab::Scheduled,
            "Open scheduled",
            "Open scheduled tasks and active thread todos.",
        ),
        (
            RightPanelTab::Providers,
            "Open providers",
            "Open provider runtime and model registry state.",
        ),
        (
            RightPanelTab::Plugins,
            "Open plugins",
            "Open plugin registry entries from the host runtime.",
        ),
        (
            RightPanelTab::Skills,
            "Open skills",
            "Open skill registry entries from the host runtime.",
        ),
        (
            RightPanelTab::Settings,
            "Open settings",
            "Adjust centralized theme, density, motion, UI font, and code font.",
        ),
    ]
    .into_iter()
    .map(|(tab, label, description)| SearchPaletteItem::Inspector {
        tab,
        label,
        description,
    })
    .collect()
}

impl SearchPaletteItem {
    fn label(&self) -> &str {
        match self {
            Self::NewThread => "New thread in...",
            Self::NewProject => "New project",
            Self::OpenScheduled => "Open scheduled tasks",
            Self::OpenSettings => "Open settings",
            Self::OpenTerminals => "Open terminals",
            Self::OpenBrowser => "Open browser",
            Self::ToggleRightPanel => "Toggle right panel",
            Self::RefreshActiveTab => "Refresh active tab",
            Self::CreateWorktree => "Create worktree",
            Self::ShowPinned => "Show pinned messages",
            Self::ShowTodos => "Show todos",
            Self::ManagePlugins => "Manage plugins",
            Self::ManageSkills => "Manage skills",
            Self::ConfigureProviders => "Configure providers/models",
            Self::ShowApprovals => "Show approvals",
            Self::SwitchModel => "Switch model",
            Self::SetProjectDefaultModel => "Set project default model",
            Self::RunTests => "Run tests",
            Self::RunLint => "Run lint",
            Self::Inspector { label, .. } => label,
            Self::ActiveThreadAction { label, .. } => label,
            Self::ComposerModel { label, .. }
            | Self::ComposerTrait { label, .. }
            | Self::ComposerReasoning { label, .. }
            | Self::ComposerPermission { label, .. }
            | Self::ComposerRuntimeMode { label, .. }
            | Self::ComposerInteractionMode { label, .. }
            | Self::ComposerContext { label, .. }
            | Self::ComposerHost { label, .. }
            | Self::ThemePreset { label, .. }
            | Self::ThemeAccent { label, .. }
            | Self::ThemeDensity { label, .. }
            | Self::ThemeMotion { label, .. }
            | Self::UiFont { label, .. }
            | Self::CodeFont { label, .. } => label,
            Self::Panel { label, .. } => label,
            Self::Message { label, .. } => label,
            Self::Context { label, .. } => label,
            Self::ProjectAction { label, .. } => label,
            Self::ApprovalAction { label, .. } => label,
            Self::ReviewAction { label, .. } => label,
            Self::TodoAction { label, .. } => label,
            Self::Project { label, .. } | Self::Thread { label, .. } => label,
        }
    }

    fn description(&self) -> &str {
        match self {
            Self::NewThread => "Choose a project for a new thread.",
            Self::NewProject => "Add the current workspace as a project.",
            Self::OpenScheduled => "Open scheduled and active thread todos.",
            Self::OpenSettings => "Adjust theme, density, UI font, code font, and motion.",
            Self::OpenTerminals => "Manage running terminal processes.",
            Self::OpenBrowser => {
                "Open the browser inspector; Chromium service state is shown there."
            }
            Self::ToggleRightPanel => "Show or hide the contextual inspector.",
            Self::RefreshActiveTab => "Refresh data for the selected inspector tab.",
            Self::CreateWorktree => "Create a Git worktree for the active thread.",
            Self::ShowPinned => "Open pinned timeline context.",
            Self::ShowTodos => "Open structured thread todos.",
            Self::ManagePlugins => "Open the plugin registry.",
            Self::ManageSkills => "Open the skill registry.",
            Self::ConfigureProviders => "Open provider and model settings.",
            Self::ShowApprovals => "Open pending provider approvals.",
            Self::SwitchModel => {
                "Search provider model catalog entries and select one for the composer."
            }
            Self::SetProjectDefaultModel => {
                "Persist the current composer model as the active project's default."
            }
            Self::RunTests => "Run the configured test script or Rust workspace test command.",
            Self::RunLint => "Run the configured lint script or Rust workspace clippy command.",
            Self::Inspector { description, .. } => description,
            Self::ActiveThreadAction { description, .. } => description,
            Self::ComposerModel { description, .. }
            | Self::ComposerTrait { description, .. }
            | Self::ComposerReasoning { description, .. }
            | Self::ComposerPermission { description, .. }
            | Self::ComposerRuntimeMode { description, .. }
            | Self::ComposerInteractionMode { description, .. }
            | Self::ComposerContext { description, .. }
            | Self::ComposerHost { description, .. }
            | Self::ThemePreset { description, .. }
            | Self::ThemeAccent { description, .. }
            | Self::ThemeDensity { description, .. }
            | Self::ThemeMotion { description, .. }
            | Self::UiFont { description, .. }
            | Self::CodeFont { description, .. } => description,
            Self::Panel { description, .. } => description,
            Self::Message { description, .. } => description,
            Self::Context { description, .. } => description,
            Self::ProjectAction { description, .. } => description,
            Self::ApprovalAction { description, .. } => description,
            Self::ReviewAction { description, .. } => description,
            Self::TodoAction { description, .. } => description,
            Self::Project { description, .. } | Self::Thread { description, .. } => description,
        }
    }

    fn kind(&self) -> PaletteItemKind {
        match self {
            Self::NewThread
            | Self::NewProject
            | Self::OpenScheduled
            | Self::OpenSettings
            | Self::OpenTerminals
            | Self::OpenBrowser
            | Self::ToggleRightPanel
            | Self::RefreshActiveTab
            | Self::CreateWorktree
            | Self::ShowPinned
            | Self::ShowTodos
            | Self::ManagePlugins
            | Self::ManageSkills
            | Self::ConfigureProviders
            | Self::ShowApprovals
            | Self::SwitchModel
            | Self::SetProjectDefaultModel
            | Self::RunTests
            | Self::RunLint
            | Self::Inspector { .. }
            | Self::ActiveThreadAction { .. } => PaletteItemKind::Action,
            Self::ComposerTrait { .. }
            | Self::ComposerReasoning { .. }
            | Self::ComposerPermission { .. }
            | Self::ComposerRuntimeMode { .. }
            | Self::ComposerInteractionMode { .. }
            | Self::ComposerContext { .. }
            | Self::ComposerHost { .. }
            | Self::ThemePreset { .. }
            | Self::ThemeAccent { .. }
            | Self::ThemeDensity { .. }
            | Self::ThemeMotion { .. }
            | Self::UiFont { .. }
            | Self::CodeFont { .. } => PaletteItemKind::Action,
            Self::ComposerModel { .. } => PaletteItemKind::Registry,
            Self::Panel { result_kind, .. } => match result_kind {
                SearchPaletteResultKind::Source => PaletteItemKind::Source,
                SearchPaletteResultKind::Context => PaletteItemKind::Context,
                SearchPaletteResultKind::Registry => PaletteItemKind::Registry,
            },
            Self::Message { .. } => PaletteItemKind::Context,
            Self::Context { .. } => PaletteItemKind::Context,
            Self::ProjectAction { .. } => PaletteItemKind::Action,
            Self::ApprovalAction { .. } => PaletteItemKind::Action,
            Self::ReviewAction { .. } => PaletteItemKind::Action,
            Self::TodoAction { .. } => PaletteItemKind::Action,
            Self::Project { .. } => PaletteItemKind::Project,
            Self::Thread { .. } => PaletteItemKind::Thread,
        }
    }

    pub fn disabled_reason(&self) -> Option<&'static str> {
        match self {
            Self::ComposerRuntimeMode {
                runtime_mode: RuntimeMode::Remote,
                selectable: false,
                ..
            } => Some("No connected remote host is available yet."),
            Self::ComposerModel { selectable, .. } if !selectable => Some(
                "This provider is visible in the catalog, but desktop send routing currently uses the Codex runtime.",
            ),
            Self::ComposerHost {
                selectable: false, ..
            } => Some("Remote host is not connected."),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PaletteItemKind {
    Action,
    Project,
    Thread,
    Source,
    Context,
    Registry,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchPaletteState {
    pub open: bool,
    pub mode: SearchPaletteMode,
    pub query: String,
    pub active_index: usize,
}

impl Default for SearchPaletteState {
    fn default() -> Self {
        Self {
            open: false,
            mode: SearchPaletteMode::Root,
            query: String::new(),
            active_index: 0,
        }
    }
}

impl SearchPaletteState {
    pub fn open(&mut self) {
        self.open = true;
        self.mode = SearchPaletteMode::Root;
        self.query.clear();
        self.active_index = 0;
    }

    pub fn close(&mut self) {
        *self = Self::default();
    }

    pub fn back(&mut self) {
        self.mode = SearchPaletteMode::Root;
        self.query.clear();
        self.active_index = 0;
    }
}

pub fn palette_items(
    projection: &DesktopProjection,
    mode: SearchPaletteMode,
    query: &str,
) -> Vec<SearchPaletteItem> {
    let normalized = query.trim().to_lowercase();
    let mut project_items = Vec::new();
    let mut thread_items = Vec::new();
    let mut source_items = Vec::new();
    let mut context_items = Vec::new();
    let mut registry_items = Vec::new();
    let mut active_thread_actions = Vec::new();
    let mut project_action_items = Vec::new();

    if let Some(thread) = projection.chat.active_thread.as_ref() {
        active_thread_actions.extend(active_thread_palette_actions(thread));
    }
    registry_items.extend(review_palette_actions(&projection.review));

    for group in &projection.sidebar.projects {
        project_items.push(SearchPaletteItem::Project {
            project_id: group.project.id,
            label: group.project.name.clone(),
            description: group.project.workspace_root.clone(),
        });
        project_action_items.extend(project_palette_actions(
            group.project.id,
            &group.project.name,
            &group.project.workspace_root,
            group.project.thread_count,
        ));

        for thread in &group.threads {
            thread_items.push(SearchPaletteItem::Thread {
                thread_id: thread.id.clone(),
                label: thread.title.clone(),
                description: thread_palette_description(&group.project.name, thread),
            });
        }
    }

    for source in &projection.sources.items {
        source_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Sources,
            label: source.title.clone(),
            description: format!("{} · {}", source.kind, source.detail),
            result_kind: SearchPaletteResultKind::Source,
        });
    }
    for worktree in &projection.worktrees.entries {
        source_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Worktrees,
            label: worktree
                .branch
                .clone()
                .unwrap_or_else(|| short_path(&worktree.path)),
            description: format!("Worktree · {}", worktree.path),
            result_kind: SearchPaletteResultKind::Source,
        });
    }

    for item in &projection.annotations.pinned_items {
        context_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Pinned,
            label: item.display_title.clone(),
            description: item.display_excerpt.clone(),
            result_kind: SearchPaletteResultKind::Context,
        });
    }
    for item in &projection.annotations.highlighted_items {
        context_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Summary,
            label: item.display_title.clone(),
            description: format!("Highlighted · {}", item.display_excerpt),
            result_kind: SearchPaletteResultKind::Context,
        });
    }
    let has_review_context =
        !projection.review.files.is_empty() || !projection.annotations.review_comments.is_empty();
    for todo in &projection.annotations.todos {
        context_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Todos,
            label: todo.title.clone(),
            description: format!("Todo · {:?}", todo.status),
            result_kind: SearchPaletteResultKind::Context,
        });
        context_items.extend(todo_palette_actions(todo, has_review_context));
    }
    for approval in &projection.approvals.pending {
        context_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Approvals,
            label: approval.title.clone(),
            description: format!("{} · {}", approval.provider, approval.prompt),
            result_kind: SearchPaletteResultKind::Context,
        });
        context_items.extend(approval_palette_actions(approval));
    }
    for message in &projection.search.messages {
        context_items.push(SearchPaletteItem::Message {
            thread_id: message.thread_id.clone(),
            message_id: message.message_id.clone(),
            label: format!(
                "{} message in {}",
                message_role_label(message.role),
                message.thread_title
            ),
            description: format!(
                "{} · {} · {}",
                message.project_name,
                message_role_label(message.role),
                message.excerpt
            ),
        });
    }
    for context in &projection.search.contexts {
        context_items.push(SearchPaletteItem::Context {
            thread_id: context.thread_id.clone(),
            tab: search_context_tab(context.kind),
            label: context.label.clone(),
            description: context.description.clone(),
        });
    }

    registry_items.push(SearchPaletteItem::Panel {
        tab: crate::stores::ui::RightPanelTab::Environment,
        label: projection.host.label.clone(),
        description: projection
            .host
            .endpoint
            .clone()
            .unwrap_or_else(|| "Host runtime is not connected".to_string()),
        result_kind: SearchPaletteResultKind::Registry,
    });

    if projection.runtime_status.providers > 0
        || projection.runtime_status.threads > 0
        || projection.runtime_status.error.is_some()
    {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Environment,
            label: "Runtime status".to_string(),
            description: format!(
                "{} provider{} · {} active thread{} · {} warning{}",
                projection.runtime_status.providers,
                plural(projection.runtime_status.providers),
                projection.runtime_status.active_threads,
                plural(projection.runtime_status.active_threads),
                projection.runtime_status.warnings,
                plural(projection.runtime_status.warnings)
            ),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    if projection.runtime_status.remote_connections > 0 {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Environment,
            label: "Remote connections".to_string(),
            description: format!(
                "{} connected / {} total · {} remote host{}",
                projection.runtime_status.connected_remote_connections,
                projection.runtime_status.remote_connections,
                projection.runtime_status.remote_host_connections,
                plural(projection.runtime_status.remote_host_connections)
            ),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    if projection.runtime_status.pending_approvals > 0 {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Approvals,
            label: "Pending approvals".to_string(),
            description: format!(
                "{} runtime approval{} awaiting action",
                projection.runtime_status.pending_approvals,
                plural(projection.runtime_status.pending_approvals)
            ),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    if projection.runtime_status.handoffs > 0 {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Environment,
            label: "Runtime handoffs".to_string(),
            description: format!(
                "{} handoff{} recorded",
                projection.runtime_status.handoffs,
                plural(projection.runtime_status.handoffs)
            ),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }

    for provider in &projection.providers.providers {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Providers,
            label: provider.display_name.clone(),
            description: format!("Provider · {}", provider.health),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    for provider in &projection.models.providers {
        let provider_kind = ProviderKind::from_runtime_id(&provider.runtime_id);
        let selectable = provider_kind == Some(ProviderKind::Codex);
        for model in &provider.models {
            registry_items.push(SearchPaletteItem::ComposerModel {
                provider: provider_kind,
                model: model.id.clone(),
                label: model.display_name.clone(),
                description: format!(
                    "Model · {} · {} · {}",
                    provider.display_name,
                    model.id,
                    model_capability_summary(model)
                ),
                selectable,
            });
        }
    }
    for trait_kind in ComposerTrait::ALL {
        registry_items.push(SearchPaletteItem::ComposerTrait {
            trait_kind,
            label: format!("Trait: {}", trait_kind.label()),
            description: trait_kind.detail().to_string(),
        });
    }
    for effort in ReasoningEffort::ALL {
        registry_items.push(SearchPaletteItem::ComposerReasoning {
            effort,
            label: format!("Reasoning: {}", effort.label()),
            description: "Set composer reasoning intensity for supported models.".to_string(),
        });
    }
    for permission in ComposerPermissionMode::ALL {
        registry_items.push(SearchPaletteItem::ComposerPermission {
            permission,
            label: format!("Permission: {}", permission.label()),
            description: permission.detail().to_string(),
        });
    }
    let has_connected_remote = projection.host_options.iter().any(|host| host.connected);
    for runtime_mode in [
        RuntimeMode::Normal,
        RuntimeMode::Local,
        RuntimeMode::Worktree,
        RuntimeMode::Remote,
    ] {
        registry_items.push(SearchPaletteItem::ComposerRuntimeMode {
            runtime_mode,
            label: format!("Runtime: {}", runtime_mode_label(runtime_mode)),
            description: runtime_mode_description(runtime_mode).to_string(),
            selectable: runtime_mode != RuntimeMode::Remote || has_connected_remote,
        });
    }
    for interaction_mode in [InteractionMode::Chat, InteractionMode::Plan] {
        registry_items.push(SearchPaletteItem::ComposerInteractionMode {
            interaction_mode,
            label: format!("Mode: {}", interaction_mode_label(interaction_mode)),
            description: interaction_mode_description(interaction_mode).to_string(),
        });
    }
    for context in ComposerContextKind::ALL {
        let count = composer_context_count(projection, context);
        if count > 0 {
            registry_items.push(SearchPaletteItem::ComposerContext {
                context,
                label: format!("Context: {}", context.label()),
                description: format!(
                    "{} · toggle composer context attachment",
                    composer_context_count_label(context, count)
                ),
                count,
            });
        }
    }
    registry_items.push(SearchPaletteItem::ComposerHost {
        provider: None,
        host_id: None,
        label: "Host: This computer".to_string(),
        description: projection.host.label.clone(),
        selectable: true,
    });
    for host in &projection.host_options {
        registry_items.push(SearchPaletteItem::ComposerHost {
            provider: Some(host.provider.clone()),
            host_id: Some(host.host_id.clone()),
            label: format!("Host: {}", host.label),
            description: format!(
                "{} · {} · {} project{}",
                host.detail,
                host.status,
                host.project_count,
                plural(host.project_count)
            ),
            selectable: host.connected,
        });
    }
    for (preset, label, description) in [
        (
            ThemePreset::AceDark,
            "Theme: Ace Dark",
            "Default low-contrast workstation theme.",
        ),
        (
            ThemePreset::HighContrast,
            "Theme: High Contrast",
            "Sharper text, borders, and panels.",
        ),
    ] {
        registry_items.push(SearchPaletteItem::ThemePreset {
            preset,
            label: label.to_string(),
            description: description.to_string(),
        });
    }
    for (accent, label, description) in [
        (
            ThemeAccent::Sky,
            "Accent: Sky",
            "Cool blue highlights and activity states.",
        ),
        (
            ThemeAccent::Emerald,
            "Accent: Emerald",
            "Green highlights for calm review sessions.",
        ),
        (
            ThemeAccent::Amber,
            "Accent: Amber",
            "Warm highlights for high-signal monitoring.",
        ),
        (
            ThemeAccent::Rose,
            "Accent: Rose",
            "High-contrast rose highlights.",
        ),
    ] {
        registry_items.push(SearchPaletteItem::ThemeAccent {
            accent,
            label: label.to_string(),
            description: description.to_string(),
        });
    }
    for (density, label, description) in [
        (
            ThemeDensity::Comfortable,
            "Density: Comfortable",
            "Roomier panels and controls.",
        ),
        (
            ThemeDensity::Compact,
            "Density: Compact",
            "Tighter panels for dense agent sessions.",
        ),
    ] {
        registry_items.push(SearchPaletteItem::ThemeDensity {
            density,
            label: label.to_string(),
            description: description.to_string(),
        });
    }
    for (motion, label, description) in [
        (
            ThemeMotion::Standard,
            "Motion: Standard",
            "Full hover and emphasis response.",
        ),
        (
            ThemeMotion::Reduced,
            "Motion: Reduced",
            "Lower emphasis and motion intensity.",
        ),
    ] {
        registry_items.push(SearchPaletteItem::ThemeMotion {
            motion,
            label: label.to_string(),
            description: description.to_string(),
        });
    }
    for (font, label, description) in [
        (
            UiFont::System,
            "UI Font: System",
            "Native app chrome and controls.",
        ),
        (
            UiFont::Monospace,
            "UI Font: Monospace",
            "Monospaced chrome for dense scanning.",
        ),
    ] {
        registry_items.push(SearchPaletteItem::UiFont {
            font,
            label: label.to_string(),
            description: description.to_string(),
        });
    }
    for (font, label, description) in [
        (
            CodeFont::SystemMono,
            "Code Font: SF Mono",
            "Code snippets, diffs, editor, and terminal.",
        ),
        (
            CodeFont::Menlo,
            "Code Font: Menlo",
            "Code snippets, diffs, editor, and terminal.",
        ),
    ] {
        registry_items.push(SearchPaletteItem::CodeFont {
            font,
            label: label.to_string(),
            description: description.to_string(),
        });
    }
    for plugin in &projection.plugins.entries {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Plugins,
            label: plugin.name.clone(),
            description: plugin
                .description
                .clone()
                .unwrap_or_else(|| format!("Plugin · {}", plugin.status)),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    for skill in &projection.skills.entries {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Skills,
            label: skill.name.clone(),
            description: skill
                .description
                .clone()
                .unwrap_or_else(|| format!("Skill · {}", skill.status)),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }

    project_items.sort_by(|left, right| left.label().cmp(right.label()));
    thread_items.sort_by(|left, right| right.label().cmp(left.label()));
    source_items.sort_by(|left, right| left.label().cmp(right.label()));
    context_items.sort_by(|left, right| left.label().cmp(right.label()));
    registry_items.sort_by(|left, right| left.label().cmp(right.label()));

    let matches = |item: &SearchPaletteItem| {
        let label = item.label().to_lowercase();
        let description = item.description().to_lowercase();
        let haystack = format!("{label} {description}");
        normalized.is_empty()
            || haystack.contains(&normalized)
            || normalized
                .split_whitespace()
                .all(|token| haystack.contains(token))
    };

    if mode == SearchPaletteMode::NewThreadProject {
        return project_items
            .into_iter()
            .filter(matches)
            .take(if normalized.is_empty() { 12 } else { 24 })
            .collect();
    }

    let mut actions = vec![
        SearchPaletteItem::NewThread,
        SearchPaletteItem::NewProject,
        SearchPaletteItem::OpenScheduled,
        SearchPaletteItem::OpenSettings,
        SearchPaletteItem::OpenTerminals,
        SearchPaletteItem::OpenBrowser,
        SearchPaletteItem::ToggleRightPanel,
        SearchPaletteItem::RefreshActiveTab,
        SearchPaletteItem::CreateWorktree,
        SearchPaletteItem::ShowPinned,
        SearchPaletteItem::ShowTodos,
        SearchPaletteItem::ManagePlugins,
        SearchPaletteItem::ManageSkills,
        SearchPaletteItem::ConfigureProviders,
        SearchPaletteItem::ShowApprovals,
        SearchPaletteItem::SwitchModel,
        SearchPaletteItem::RunTests,
        SearchPaletteItem::RunLint,
    ];
    actions.extend(inspector_palette_actions());
    if projection.chat.active_thread.is_some() && projection.chat.composer.is_some() {
        actions.push(SearchPaletteItem::SetProjectDefaultModel);
    }

    if normalized.is_empty() {
        return actions
            .into_iter()
            .chain(active_thread_actions)
            .chain(project_action_items)
            .chain(project_items.into_iter().take(8))
            .chain(thread_items.into_iter().take(8))
            .collect();
    }

    actions
        .into_iter()
        .chain(active_thread_actions)
        .chain(project_action_items)
        .chain(project_items)
        .chain(thread_items)
        .chain(source_items)
        .chain(context_items)
        .chain(registry_items)
        .filter(matches)
        .take(40)
        .collect()
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

fn composer_context_count(projection: &DesktopProjection, context: ComposerContextKind) -> usize {
    match context {
        ComposerContextKind::Pinned => projection.annotations.pinned_items.len(),
        ComposerContextKind::Highlights => projection.annotations.highlighted_items.len(),
        ComposerContextKind::Todos => projection.annotations.todos.len(),
        ComposerContextKind::Terminal => projection
            .terminal
            .session
            .as_ref()
            .filter(|session| !session.history.trim().is_empty())
            .map(|_| 1)
            .unwrap_or(0),
    }
}

fn composer_context_count_label(context: ComposerContextKind, count: usize) -> String {
    match context {
        ComposerContextKind::Pinned => format!("{count} pinned item{}", plural(count)),
        ComposerContextKind::Highlights => format!("{count} highlight{}", plural(count)),
        ComposerContextKind::Todos => format!("{count} todo{}", plural(count)),
        ComposerContextKind::Terminal => "terminal history available".to_string(),
    }
}

fn active_thread_palette_actions(thread: &ThreadSummary) -> Vec<SearchPaletteItem> {
    let mut items = Vec::new();
    let thread_context = format!(
        "{} · {} · {}",
        thread.title,
        thread.status.label(),
        thread
            .model
            .as_deref()
            .unwrap_or(thread.provider.display_name())
    );
    items.push(SearchPaletteItem::ActiveThreadAction {
        action: ActiveThreadPaletteAction::TogglePin,
        label: if thread.pinned {
            "Unpin active thread".to_string()
        } else {
            "Pin active thread".to_string()
        },
        description: format!("{thread_context} · update sidebar pin state"),
    });
    items.push(SearchPaletteItem::ActiveThreadAction {
        action: ActiveThreadPaletteAction::Archive,
        label: "Archive active thread".to_string(),
        description: format!("{thread_context} · hide from active sidebar lists"),
    });
    items.push(SearchPaletteItem::ActiveThreadAction {
        action: ActiveThreadPaletteAction::OpenTerminal,
        label: "Open terminal for active thread".to_string(),
        description: format!("{thread_context} · open or create the backed PTY session"),
    });
    items.push(SearchPaletteItem::ActiveThreadAction {
        action: ActiveThreadPaletteAction::OpenBrowser,
        label: "Open browser for active thread".to_string(),
        description: format!("{thread_context} · inspect Browser bridge activity"),
    });
    items.push(SearchPaletteItem::ActiveThreadAction {
        action: ActiveThreadPaletteAction::ShowPinned,
        label: "Show active thread pinned items".to_string(),
        description: format!(
            "{thread_context} · {} pinned item{}",
            thread.pinned_item_count,
            plural(thread.pinned_item_count)
        ),
    });
    items.push(SearchPaletteItem::ActiveThreadAction {
        action: ActiveThreadPaletteAction::ShowTodos,
        label: "Show active thread todos".to_string(),
        description: format!(
            "{thread_context} · {} open todo{}",
            thread.open_todo_count,
            plural(thread.open_todo_count)
        ),
    });
    items
}

fn project_palette_actions(
    project_id: ProjectId,
    name: &str,
    workspace_root: &str,
    thread_count: usize,
) -> Vec<SearchPaletteItem> {
    let project_context = format!(
        "{name} · {} thread{} · {workspace_root}",
        thread_count,
        plural(thread_count)
    );
    vec![
        SearchPaletteItem::ProjectAction {
            project_id,
            action: ProjectPaletteAction::NewThread,
            label: format!("New thread in {name}"),
            description: format!("{project_context} · create a backed project thread"),
        },
        SearchPaletteItem::ProjectAction {
            project_id,
            action: ProjectPaletteAction::OpenTerminal,
            label: format!("Open terminal for {name}"),
            description: format!("{project_context} · open or create a backed PTY session"),
        },
        SearchPaletteItem::ProjectAction {
            project_id,
            action: ProjectPaletteAction::ShowWorktrees,
            label: format!("Show {name} worktrees"),
            description: format!("{project_context} · open Git worktree inspector"),
        },
        SearchPaletteItem::ProjectAction {
            project_id,
            action: ProjectPaletteAction::CreateWorktree,
            label: format!("Create worktree for {name}"),
            description: format!("{project_context} · call the host Git worktree service"),
        },
        SearchPaletteItem::ProjectAction {
            project_id,
            action: ProjectPaletteAction::Archive,
            label: format!("Archive {name}"),
            description: format!(
                "{project_context} · remove project registration without deleting files"
            ),
        },
    ]
}

fn approval_palette_actions(approval: &ApprovalItemProjection) -> Vec<SearchPaletteItem> {
    let detail = approval
        .detail
        .as_deref()
        .filter(|detail| !detail.is_empty())
        .unwrap_or(&approval.prompt);
    let context = format!(
        "{} · {} · {} · request {}",
        approval.provider, approval.kind, detail, approval.request_id
    );
    vec![
        SearchPaletteItem::ApprovalAction {
            action: ApprovalPaletteAction::Approve,
            provider: approval.provider.clone(),
            request_id: approval.request_id.clone(),
            label: format!("Approve {}", approval.title),
            description: format!("{context} · allow the pending provider request"),
        },
        SearchPaletteItem::ApprovalAction {
            action: ApprovalPaletteAction::Deny,
            provider: approval.provider.clone(),
            request_id: approval.request_id.clone(),
            label: format!("Deny {}", approval.title),
            description: format!("{context} · reject the pending provider request"),
        },
    ]
}

fn review_palette_actions(review: &ReviewProjection) -> Vec<SearchPaletteItem> {
    let Some(repo_path) = review.repo_path.as_deref() else {
        return Vec::new();
    };
    let context = format!(
        "{} · {} changed file{} · +{} -{}",
        repo_path,
        review.files.len(),
        plural(review.files.len()),
        review.total_additions,
        review.total_deletions
    );
    let mut items = vec![
        SearchPaletteItem::ReviewAction {
            action: ReviewPaletteAction::Refresh,
            label: "Refresh Git review".to_string(),
            description: format!("{context} · reload changed files and diff preview"),
        },
        SearchPaletteItem::ReviewAction {
            action: ReviewPaletteAction::StageAll,
            label: "Stage all review changes".to_string(),
            description: format!("{context} · stage all tracked and untracked changes"),
        },
        SearchPaletteItem::ReviewAction {
            action: ReviewPaletteAction::UnstageAll,
            label: "Unstage all review changes".to_string(),
            description: format!("{context} · unstage all currently staged changes"),
        },
    ];

    if !review.files.is_empty() {
        items.push(SearchPaletteItem::ReviewAction {
            action: ReviewPaletteAction::Commit,
            label: "Commit staged review changes".to_string(),
            description: format!("{context} · commit with generated review summary"),
        });
        items.push(SearchPaletteItem::ReviewAction {
            action: ReviewPaletteAction::Push,
            label: "Push review branch".to_string(),
            description: format!("{context} · push current branch with upstream"),
        });
    }

    items
}

fn todo_palette_actions(todo: &TodoItem, has_review_context: bool) -> Vec<SearchPaletteItem> {
    let transitions: &[(TodoPaletteAction, TodoStatus, &str)] = match todo.status {
        TodoStatus::Open => &[
            (TodoPaletteAction::Start, TodoStatus::InProgress, "Start"),
            (TodoPaletteAction::Complete, TodoStatus::Done, "Complete"),
            (TodoPaletteAction::Cancel, TodoStatus::Canceled, "Cancel"),
        ],
        TodoStatus::InProgress => &[
            (TodoPaletteAction::Block, TodoStatus::Blocked, "Block"),
            (TodoPaletteAction::Complete, TodoStatus::Done, "Complete"),
            (TodoPaletteAction::Cancel, TodoStatus::Canceled, "Cancel"),
        ],
        TodoStatus::Blocked => &[
            (TodoPaletteAction::Start, TodoStatus::InProgress, "Start"),
            (TodoPaletteAction::Complete, TodoStatus::Done, "Complete"),
            (TodoPaletteAction::Cancel, TodoStatus::Canceled, "Cancel"),
        ],
        TodoStatus::Done | TodoStatus::Canceled => &[
            (TodoPaletteAction::Open, TodoStatus::Open, "Reopen"),
            (TodoPaletteAction::Start, TodoStatus::InProgress, "Start"),
        ],
    };

    let mut items = transitions
        .iter()
        .map(
            |(action, next_status, verb)| SearchPaletteItem::TodoAction {
                todo_id: todo.id.clone(),
                action: *action,
                label: format!("{verb} todo: {}", todo.title),
                description: format!(
                    "{} · {:?} -> {:?} · {}",
                    todo.id, todo.status, next_status, todo.title
                ),
            },
        )
        .collect::<Vec<_>>();

    items.extend(
        next_todo_priority_actions(todo.priority)
            .into_iter()
            .map(|(priority, label)| SearchPaletteItem::TodoAction {
                todo_id: todo.id.clone(),
                action: TodoPaletteAction::Priority(priority),
                label: format!("Set todo priority {label}: {}", todo.title),
                description: format!(
                    "{} · priority {} -> {} · {}",
                    todo.id,
                    todo_priority_label(todo.priority),
                    todo_priority_label(priority),
                    todo.title
                ),
            }),
    );

    items.extend(
        next_todo_assignee_actions(todo.assigned_to)
            .into_iter()
            .map(|(assignee, label)| SearchPaletteItem::TodoAction {
                todo_id: todo.id.clone(),
                action: TodoPaletteAction::Assign(assignee),
                label: format!("Assign todo to {label}: {}", todo.title),
                description: format!(
                    "{} · assignee {} -> {} · {}",
                    todo.id,
                    todo_assignee_label(todo.assigned_to),
                    todo_assignee_label(assignee),
                    todo.title
                ),
            }),
    );

    if has_review_context {
        items.push(SearchPaletteItem::TodoAction {
            todo_id: todo.id.clone(),
            action: TodoPaletteAction::LinkCurrentDiff,
            label: format!("Link todo to current diff: {}", todo.title),
            description: format!("{} · attach active review files and comments", todo.id),
        });
    }

    items
}

fn next_todo_priority_actions(priority: TodoPriority) -> Vec<(TodoPriority, &'static str)> {
    match priority {
        TodoPriority::Low => vec![(TodoPriority::Normal, "normal")],
        TodoPriority::Normal => vec![(TodoPriority::Low, "low"), (TodoPriority::High, "high")],
        TodoPriority::High => vec![(TodoPriority::Normal, "normal")],
    }
}

fn next_todo_assignee_actions(assignee: TodoAssignee) -> Vec<(TodoAssignee, &'static str)> {
    match assignee {
        TodoAssignee::User => vec![(TodoAssignee::Agent, "agent"), (TodoAssignee::Both, "both")],
        TodoAssignee::Agent => vec![(TodoAssignee::User, "user"), (TodoAssignee::Both, "both")],
        TodoAssignee::Both => vec![(TodoAssignee::User, "user"), (TodoAssignee::Agent, "agent")],
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

fn thread_palette_description(project_name: &str, thread: &ThreadSummary) -> String {
    let mut parts = vec![project_name.to_string(), thread.status.label().to_string()];

    if let Some(model) = thread.model.as_deref().filter(|model| !model.is_empty()) {
        parts.push(model.to_string());
    } else {
        parts.push(thread.provider.display_name().to_string());
    }

    if let Some(branch) = thread.branch.as_deref().filter(|branch| !branch.is_empty()) {
        parts.push(branch.to_string());
    } else if let Some(worktree) = thread
        .worktree_path
        .as_deref()
        .filter(|worktree| !worktree.is_empty())
    {
        parts.push(short_path(worktree));
    }

    if thread.open_todo_count > 0 {
        parts.push(format!(
            "{} open todo{}",
            thread.open_todo_count,
            plural(thread.open_todo_count)
        ));
    } else if thread.todo_count > 0 {
        parts.push(format!(
            "{} todo{}",
            thread.todo_count,
            plural(thread.todo_count)
        ));
    }

    if thread.pinned_item_count > 0 {
        parts.push(format!(
            "{} pin{}",
            thread.pinned_item_count,
            plural(thread.pinned_item_count)
        ));
    }

    if let Some(preview) = thread
        .latest_message_preview
        .as_deref()
        .filter(|preview| !preview.is_empty())
    {
        parts.push(truncate_palette_preview(preview, 96));
    }

    parts.join(" · ")
}

fn message_role_label(role: ace_runtime::chat::ChatMessageRole) -> &'static str {
    match role {
        ace_runtime::chat::ChatMessageRole::User => "User",
        ace_runtime::chat::ChatMessageRole::Assistant => "Assistant",
        ace_runtime::chat::ChatMessageRole::Tool => "Tool",
        ace_runtime::chat::ChatMessageRole::Plan => "Plan",
        ace_runtime::chat::ChatMessageRole::Activity => "Activity",
    }
}

fn search_context_tab(kind: SearchContextKind) -> RightPanelTab {
    match kind {
        SearchContextKind::Terminal => RightPanelTab::Terminal,
        SearchContextKind::Browser => RightPanelTab::Browser,
        SearchContextKind::DiffComment => RightPanelTab::Review,
        SearchContextKind::Artifact => RightPanelTab::Sources,
    }
}

fn truncate_palette_preview(preview: &str, max_chars: usize) -> String {
    if preview.chars().count() <= max_chars {
        return preview.to_string();
    }

    let mut truncated = preview
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

fn runtime_mode_label(mode: RuntimeMode) -> &'static str {
    match mode {
        RuntimeMode::Normal => "Normal",
        RuntimeMode::Local => "Local",
        RuntimeMode::Worktree => "Worktree",
        RuntimeMode::Remote => "Remote",
    }
}

fn runtime_mode_description(mode: RuntimeMode) -> &'static str {
    match mode {
        RuntimeMode::Normal => "Use the active thread context.",
        RuntimeMode::Local => "Run on this project host.",
        RuntimeMode::Worktree => "Prefer the thread worktree.",
        RuntimeMode::Remote => "Run on the selected remote host.",
    }
}

fn interaction_mode_label(mode: InteractionMode) -> &'static str {
    match mode {
        InteractionMode::Chat => "Chat",
        InteractionMode::Plan => "Plan",
    }
}

fn interaction_mode_description(mode: InteractionMode) -> &'static str {
    match mode {
        InteractionMode::Chat => "General implementation and Q&A.",
        InteractionMode::Plan => "Plan first before implementation.",
    }
}

fn short_path(path: &str) -> String {
    path.rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn model_capability_summary(model: &ModelProjection) -> String {
    let mut capabilities = Vec::new();
    if model.supports_tools {
        capabilities.push("Tools");
    }
    if model.supports_vision {
        capabilities.push("Vision");
    }
    if model.supports_reasoning {
        capabilities.push("Reasoning");
    }
    if model.supports_computer_use {
        capabilities.push("Computer Use");
    }
    if model.context_window.is_some_and(|window| window >= 128_000) {
        capabilities.push("Long context");
    }
    if capabilities.is_empty() {
        "No advertised capabilities".to_string()
    } else {
        capabilities.join(", ")
    }
}

pub(super) fn search_palette_overlay(
    theme: Theme,
    state: &SearchPaletteState,
    projection: &DesktopProjection,
) -> AnyElement {
    if !state.open {
        return div().into_any_element();
    }

    let items = palette_items(projection, state.mode, &state.query);
    let active_index = state.active_index.min(items.len().saturating_sub(1));
    let normalized_empty = state.query.trim().is_empty();
    let mut rendered_index = 0usize;

    div()
        .absolute()
        .top(px(0.0))
        .left(px(0.0))
        .right(px(0.0))
        .bottom(px(0.0))
        .bg(theme.background.opacity(0.66))
        .flex()
        .items_start()
        .justify_center()
        .pt(px(96.0))
        .child(
            div()
                .w(px(720.0))
                .max_w(px(720.0))
                .max_h(px(560.0))
                .rounded_xl()
                .border_1()
                .border_color(theme.border)
                .bg(theme.background_elevated.opacity(0.98))
                .shadow_lg()
                .overflow_hidden()
                .flex()
                .flex_col()
                .child(palette_header(theme, state))
                .child(
                    div()
                        .flex_1()
                        .min_h(px(300.0))
                        .max_h(px(420.0))
                        .overflow_y_scrollbar()
                        .px_4()
                        .py_3()
                        .children(section(
                            theme,
                            "Actions",
                            PaletteItemKind::Action,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            if state.mode == SearchPaletteMode::NewThreadProject {
                                "Projects"
                            } else if normalized_empty {
                                "Recent Projects"
                            } else {
                                "Projects"
                            },
                            PaletteItemKind::Project,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            if normalized_empty {
                                "Recent Threads"
                            } else {
                                "Threads"
                            },
                            PaletteItemKind::Thread,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            "Sources",
                            PaletteItemKind::Source,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            "Pinned & Todos",
                            PaletteItemKind::Context,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            "Registries",
                            PaletteItemKind::Registry,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .when(items.is_empty(), |this| {
                            this.child(
                                div()
                                    .h(px(160.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .text_size(px(13.0))
                                    .text_color(theme.muted)
                                    .child("No matching results"),
                            )
                        }),
                )
                .child(palette_footer(theme)),
        )
        .into_any_element()
}

fn palette_header(theme: Theme, state: &SearchPaletteState) -> AnyElement {
    let display_text = if state.query.is_empty() {
        if state.mode == SearchPaletteMode::NewThreadProject {
            "Select project for a new thread...".to_string()
        } else {
            "Search commands, projects, threads, sources, and registries...".to_string()
        }
    } else {
        state.query.clone()
    };

    div()
        .h(px(72.0))
        .border_b_1()
        .border_color(theme.border_subtle)
        .px_5()
        .flex()
        .items_center()
        .gap_3()
        .child(if state.mode == SearchPaletteMode::NewThreadProject {
            ace_icon_svg(AceIconName::PanelLeftOpen, theme.muted)
        } else {
            icon_svg(IconName::Search, theme.muted)
        })
        .child(
            div()
                .h(px(40.0))
                .flex_1()
                .rounded_lg()
                .border_1()
                .border_color(if state.open {
                    theme.accent_blue.opacity(0.62)
                } else {
                    theme.border
                })
                .bg(theme.panel)
                .px_3()
                .flex()
                .items_center()
                .text_size(px(18.0))
                .text_color(theme.foreground)
                .child(display_text),
        )
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn section(
    theme: Theme,
    title: &'static str,
    kind: PaletteItemKind,
    items: &[SearchPaletteItem],
    rendered_index: &mut usize,
    active_index: usize,
    normalized_empty: bool,
    mode: SearchPaletteMode,
) -> Vec<AnyElement> {
    if mode == SearchPaletteMode::NewThreadProject && kind != PaletteItemKind::Project {
        return Vec::new();
    }

    let section_items = items
        .iter()
        .filter(|item| item.kind() == kind)
        .cloned()
        .collect::<Vec<_>>();
    if section_items.is_empty() {
        return Vec::new();
    }
    if kind == PaletteItemKind::Action && !normalized_empty {
        // Keep filtered actions visually grouped only when they are present.
    }

    let mut children = vec![
        div()
            .pt(if *rendered_index == 0 {
                px(0.0)
            } else {
                px(14.0)
            })
            .pb_2()
            .text_size(px(11.0))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .text_color(theme.muted_subtle)
            .child(title)
            .into_any_element(),
    ];

    for item in section_items {
        let index = *rendered_index;
        *rendered_index += 1;
        children.push(palette_row(theme, item, index == active_index));
    }

    children
}

fn palette_row(theme: Theme, item: SearchPaletteItem, active: bool) -> AnyElement {
    let action_item = item.clone();
    let disabled = item.disabled_reason().is_some();
    div()
        .h(px(46.0))
        .rounded_lg()
        .px_3()
        .flex()
        .items_center()
        .gap_3()
        .bg(if active && !disabled {
            theme.button_hover
        } else {
            theme.background_elevated
        })
        .text_color(if disabled {
            theme.muted_subtle
        } else if active {
            theme.foreground
        } else {
            theme.foreground.opacity(0.78)
        })
        .when(!disabled, |this| this.hover(|this| this.bg(theme.button)))
        .child(palette_icon(theme, &item, active))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(14.0))
                        .line_height(px(18.0))
                        .child(item.label().to_string()),
                )
                .when(disabled || item.kind() != PaletteItemKind::Action, |this| {
                    this.child(
                        div()
                            .text_size(px(12.0))
                            .line_height(px(16.0))
                            .text_color(theme.muted)
                            .child(item.description().to_string()),
                    )
                }),
        )
        .when(!disabled, |this| {
            this.on_mouse_up(MouseButton::Left, move |_, window, cx| {
                window.dispatch_action(
                    Box::new(SelectSearchPaletteItem {
                        item: action_item.clone(),
                    }),
                    cx,
                );
            })
        })
        .into_any_element()
}

fn palette_icon(theme: Theme, item: &SearchPaletteItem, active: bool) -> AnyElement {
    let color = if item.disabled_reason().is_some() {
        theme.muted_subtle
    } else if active {
        theme.accent_blue
    } else {
        theme.muted
    };
    match item {
        SearchPaletteItem::NewThread | SearchPaletteItem::Thread { .. } => {
            ace_icon_svg(AceIconName::Editor, color)
        }
        SearchPaletteItem::NewProject | SearchPaletteItem::Project { .. } => {
            icon_svg(IconName::Folder, color)
        }
        SearchPaletteItem::OpenScheduled => ace_icon_svg(AceIconName::ListChecks, color),
        SearchPaletteItem::OpenSettings => ace_icon_svg(AceIconName::TablerSettings, color),
        SearchPaletteItem::OpenTerminals => ace_icon_svg(AceIconName::Terminal, color),
        SearchPaletteItem::OpenBrowser => ace_icon_svg(AceIconName::Browser, color),
        SearchPaletteItem::ToggleRightPanel => ace_icon_svg(AceIconName::PanelRightOpen, color),
        SearchPaletteItem::RefreshActiveTab => ace_icon_svg(AceIconName::Summary, color),
        SearchPaletteItem::CreateWorktree => ace_icon_svg(AceIconName::Review, color),
        SearchPaletteItem::ShowPinned => ace_icon_svg(AceIconName::PinFilled, color),
        SearchPaletteItem::ShowTodos => ace_icon_svg(AceIconName::ListChecks, color),
        SearchPaletteItem::ManagePlugins => ace_icon_svg(AceIconName::Box, color),
        SearchPaletteItem::ManageSkills => ace_icon_svg(AceIconName::FlaskConical, color),
        SearchPaletteItem::ConfigureProviders
        | SearchPaletteItem::SwitchModel
        | SearchPaletteItem::SetProjectDefaultModel => ace_icon_svg(AceIconName::Code2, color),
        SearchPaletteItem::ShowApprovals => ace_icon_svg(AceIconName::ListChecks, color),
        SearchPaletteItem::RunTests | SearchPaletteItem::RunLint => {
            ace_icon_svg(AceIconName::TablerTerminal, color)
        }
        SearchPaletteItem::Inspector { tab, .. } => match tab {
            RightPanelTab::Review => ace_icon_svg(AceIconName::Review, color),
            RightPanelTab::Environment => ace_icon_svg(AceIconName::PanelRightOpen, color),
            RightPanelTab::Terminal => ace_icon_svg(AceIconName::Terminal, color),
            RightPanelTab::Worktrees => ace_icon_svg(AceIconName::Review, color),
            RightPanelTab::Approvals => ace_icon_svg(AceIconName::ListChecks, color),
            RightPanelTab::Browser => ace_icon_svg(AceIconName::Browser, color),
            RightPanelTab::Editor => ace_icon_svg(AceIconName::Editor, color),
            RightPanelTab::Summary => ace_icon_svg(AceIconName::Summary, color),
            RightPanelTab::Sources => ace_icon_svg(AceIconName::Box, color),
            RightPanelTab::Providers => ace_icon_svg(AceIconName::Code2, color),
            RightPanelTab::Plugins => ace_icon_svg(AceIconName::Box, color),
            RightPanelTab::Skills => ace_icon_svg(AceIconName::FlaskConical, color),
            RightPanelTab::Settings => ace_icon_svg(AceIconName::TablerSettings, color),
            RightPanelTab::Pinned => ace_icon_svg(AceIconName::PinFilled, color),
            RightPanelTab::Todos | RightPanelTab::Scheduled => {
                ace_icon_svg(AceIconName::ListChecks, color)
            }
        },
        SearchPaletteItem::ActiveThreadAction { action, .. } => match action {
            ActiveThreadPaletteAction::TogglePin => ace_icon_svg(AceIconName::PinFilled, color),
            ActiveThreadPaletteAction::Archive => icon_svg(IconName::CircleX, color),
            ActiveThreadPaletteAction::OpenTerminal => ace_icon_svg(AceIconName::Terminal, color),
            ActiveThreadPaletteAction::OpenBrowser => ace_icon_svg(AceIconName::Browser, color),
            ActiveThreadPaletteAction::ShowPinned => ace_icon_svg(AceIconName::PinFilled, color),
            ActiveThreadPaletteAction::ShowTodos => ace_icon_svg(AceIconName::ListChecks, color),
        },
        SearchPaletteItem::ComposerModel { .. } => ace_icon_svg(AceIconName::Code2, color),
        SearchPaletteItem::ComposerTrait { .. } => icon_svg(IconName::Palette, color),
        SearchPaletteItem::ComposerReasoning { .. } => icon_svg(IconName::Check, color),
        SearchPaletteItem::ComposerPermission { .. } => icon_svg(IconName::TriangleAlert, color),
        SearchPaletteItem::ComposerRuntimeMode { .. } => ace_icon_svg(AceIconName::Terminal, color),
        SearchPaletteItem::ComposerInteractionMode { .. } => {
            ace_icon_svg(AceIconName::Editor, color)
        }
        SearchPaletteItem::ComposerContext { context, .. } => match context {
            ComposerContextKind::Pinned => ace_icon_svg(AceIconName::PinFilled, color),
            ComposerContextKind::Highlights => icon_svg(IconName::Star, color),
            ComposerContextKind::Todos => ace_icon_svg(AceIconName::ListChecks, color),
            ComposerContextKind::Terminal => ace_icon_svg(AceIconName::Terminal, color),
        },
        SearchPaletteItem::ComposerHost {
            provider: None,
            host_id: None,
            ..
        } => icon_svg(IconName::SquareTerminal, color),
        SearchPaletteItem::ComposerHost { .. } => icon_svg(IconName::Globe, color),
        SearchPaletteItem::ThemePreset { .. }
        | SearchPaletteItem::ThemeAccent { .. }
        | SearchPaletteItem::ThemeDensity { .. }
        | SearchPaletteItem::ThemeMotion { .. } => icon_svg(IconName::Palette, color),
        SearchPaletteItem::UiFont { .. } => icon_svg(IconName::ALargeSmall, color),
        SearchPaletteItem::CodeFont { .. } => icon_svg(IconName::SquareTerminal, color),
        SearchPaletteItem::Panel { result_kind, .. } => match result_kind {
            SearchPaletteResultKind::Source => icon_svg(IconName::File, color),
            SearchPaletteResultKind::Context => icon_svg(IconName::Star, color),
            SearchPaletteResultKind::Registry => ace_icon_svg(AceIconName::Box, color),
        },
        SearchPaletteItem::Message { .. } => ace_icon_svg(AceIconName::Summary, color),
        SearchPaletteItem::Context { tab, .. } => match tab {
            RightPanelTab::Terminal => ace_icon_svg(AceIconName::Terminal, color),
            RightPanelTab::Browser => ace_icon_svg(AceIconName::Browser, color),
            RightPanelTab::Review => ace_icon_svg(AceIconName::Review, color),
            _ => icon_svg(IconName::File, color),
        },
        SearchPaletteItem::ProjectAction { action, .. } => match action {
            ProjectPaletteAction::NewThread => ace_icon_svg(AceIconName::SquarePen, color),
            ProjectPaletteAction::OpenTerminal => ace_icon_svg(AceIconName::Terminal, color),
            ProjectPaletteAction::ShowWorktrees | ProjectPaletteAction::CreateWorktree => {
                ace_icon_svg(AceIconName::Review, color)
            }
            ProjectPaletteAction::Archive => icon_svg(IconName::CircleX, color),
        },
        SearchPaletteItem::ApprovalAction { action, .. } => match action {
            ApprovalPaletteAction::Approve => icon_svg(IconName::ThumbsUp, color),
            ApprovalPaletteAction::Deny => icon_svg(IconName::ThumbsDown, color),
        },
        SearchPaletteItem::ReviewAction { action, .. } => match action {
            ReviewPaletteAction::Refresh => icon_svg(IconName::Info, color),
            ReviewPaletteAction::StageAll => icon_svg(IconName::Plus, color),
            ReviewPaletteAction::UnstageAll => icon_svg(IconName::Check, color),
            ReviewPaletteAction::Commit => icon_svg(IconName::CircleCheck, color),
            ReviewPaletteAction::Push => icon_svg(IconName::ArrowUp, color),
        },
        SearchPaletteItem::TodoAction { action, .. } => match action {
            TodoPaletteAction::Open => icon_svg(IconName::Check, color),
            TodoPaletteAction::Start => icon_svg(IconName::LoaderCircle, color),
            TodoPaletteAction::Block => icon_svg(IconName::TriangleAlert, color),
            TodoPaletteAction::Complete => icon_svg(IconName::CircleCheck, color),
            TodoPaletteAction::Cancel => icon_svg(IconName::CircleX, color),
            TodoPaletteAction::Priority(TodoPriority::Low) => icon_svg(IconName::ArrowDown, color),
            TodoPaletteAction::Priority(TodoPriority::Normal) => icon_svg(IconName::Check, color),
            TodoPaletteAction::Priority(TodoPriority::High) => icon_svg(IconName::ArrowUp, color),
            TodoPaletteAction::Assign(TodoAssignee::User) => icon_svg(IconName::User, color),
            TodoPaletteAction::Assign(TodoAssignee::Agent) => icon_svg(IconName::Bot, color),
            TodoPaletteAction::Assign(TodoAssignee::Both) => icon_svg(IconName::User, color),
            TodoPaletteAction::LinkCurrentDiff => icon_svg(IconName::File, color),
        },
    }
}

fn palette_footer(theme: Theme) -> AnyElement {
    div()
        .h(px(44.0))
        .border_t_1()
        .border_color(theme.border_subtle)
        .px_4()
        .flex()
        .items_center()
        .gap_4()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .child(hint("↑ ↓", "Navigate", theme))
        .child(hint("Enter", "Select", theme))
        .child(hint("Esc", "Close", theme))
        .into_any_element()
}

fn hint(keys: &'static str, label: &'static str, theme: Theme) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap_2()
        .child(kbd(keys, theme))
        .child(label)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::desktop::{ComposerPayload, DesktopStore};
    use ace_protocol::provider_runtime::{
        ProviderRuntimeEvent, ProviderRuntimeEventBatch, ProviderRuntimeProjectionDelta,
    };
    use ace_protocol::terminal::{
        DEFAULT_TERMINAL_ID, SequencedTerminalEvent, TerminalEvent, TerminalSessionSnapshot,
        TerminalSessionStatus,
    };
    use ace_runtime::provider::{
        NormalizedServerRequest, ProviderMetadata, ServerRequestDetail, ServerRequestKind,
    };
    use ace_runtime::threads::{ExecutionLocation, RemoteConnectionRecord};

    #[test]
    fn palette_search_includes_persisted_context_results() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Keep this context".to_string(),
            },
        );
        let user_message_id = store.projection().chat.messages[0].id.clone();
        store.pin_timeline_item(thread_id, &user_message_id);

        let items = palette_items(&store.projection(), SearchPaletteMode::Root, "context");
        assert!(items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::Panel {
                result_kind: SearchPaletteResultKind::Context,
                ..
            }
        )));
    }

    #[test]
    fn palette_thread_results_include_backed_summary_metadata() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.set_active_composer_model(ProviderKind::Codex, "gpt-5".to_string());
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Implement rich palette metadata".to_string(),
            },
        );
        let user_message_id = store.projection().chat.messages[0].id.clone();
        store.pin_timeline_item(thread_id.clone(), &user_message_id);
        store.create_todo_from_timeline_item(thread_id.clone(), &user_message_id);

        let items = palette_items(&store.projection(), SearchPaletteMode::Root, "rich palette");
        let description = items
            .iter()
            .find_map(|item| match item {
                SearchPaletteItem::Thread {
                    thread_id: item_thread_id,
                    ..
                } if *item_thread_id == thread_id => Some(item.description()),
                _ => None,
            })
            .expect("thread result");

        assert!(description.contains("project"), "{description}");
        assert!(description.contains("Error"), "{description}");
        assert!(description.contains("gpt-5"), "{description}");
        assert!(description.contains("1 open todo"), "{description}");
        assert!(description.contains("1 pin"), "{description}");
        assert!(
            description.contains("Implement rich palette metadata"),
            "{description}"
        );

        let mut projection = store.projection();
        projection.sidebar.projects[0].threads[0].branch =
            Some("feature/palette-branch".to_string());
        let branch_items = palette_items(
            &projection,
            SearchPaletteMode::Root,
            "feature/palette-branch",
        );
        assert!(branch_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::Thread {
                thread_id: item_thread_id,
                ..
            } if *item_thread_id == thread_id
        )));
    }

    #[test]
    fn palette_search_includes_persisted_messages_across_threads() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let earlier_thread_id = store.new_thread(project_id);
        store.send_message(
            earlier_thread_id.clone(),
            ComposerPayload {
                prompt: "Remember the buried orbital semaphore".to_string(),
            },
        );
        let _active_thread_id = store.new_thread(project_id);

        let items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "orbital semaphore",
        );
        let message_result = items
            .iter()
            .find(|item| {
                matches!(
                    item,
                    SearchPaletteItem::Message { thread_id, .. }
                        if *thread_id == earlier_thread_id
                            && item
                                .description()
                                .contains("Remember the buried orbital semaphore")
                )
            })
            .expect("message search result");

        assert!(
            message_result
                .description()
                .contains("Remember the buried orbital semaphore"),
            "{}",
            message_result.description()
        );
    }

    #[test]
    fn palette_search_includes_backed_operational_contexts() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let context_thread_id = store.new_thread(project_id);
        store.create_review_comment_for_file("src/lib.rs".to_string());
        store.apply_terminal_event(SequencedTerminalEvent {
            sequence: 1,
            event: TerminalEvent::Started {
                thread_id: context_thread_id.0.clone(),
                terminal_id: DEFAULT_TERMINAL_ID.to_string(),
                created_at: "now".to_string(),
                snapshot: TerminalSessionSnapshot {
                    thread_id: context_thread_id.0.clone(),
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
        store.apply_terminal_event(SequencedTerminalEvent {
            sequence: 2,
            event: TerminalEvent::Output {
                thread_id: context_thread_id.0.clone(),
                terminal_id: DEFAULT_TERMINAL_ID.to_string(),
                created_at: "now".to_string(),
                data: "cargo test --workspace\n".to_string(),
            },
        });
        let _active_thread_id = store.new_thread(project_id);

        let review_items = palette_items(&store.projection(), SearchPaletteMode::Root, "src/lib");
        assert!(review_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::Context {
                thread_id: Some(thread_id),
                tab: RightPanelTab::Review,
                ..
            } if *thread_id == context_thread_id
        )));

        let terminal_items =
            palette_items(&store.projection(), SearchPaletteMode::Root, "cargo test");
        assert!(terminal_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::Context {
                thread_id: Some(thread_id),
                tab: RightPanelTab::Terminal,
                ..
            } if *thread_id == context_thread_id
        )));
    }

    #[test]
    fn palette_search_includes_active_thread_overflow_actions() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Tune overflow command actions".to_string(),
            },
        );

        let pin_items = palette_items(&store.projection(), SearchPaletteMode::Root, "pin active");
        assert!(pin_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ActiveThreadAction {
                action: ActiveThreadPaletteAction::TogglePin,
                label,
                ..
            } if label == "Pin active thread"
        )));

        store.toggle_pin_thread(thread_id);
        let unpin_items = palette_items(&store.projection(), SearchPaletteMode::Root, "unpin");
        assert!(unpin_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ActiveThreadAction {
                action: ActiveThreadPaletteAction::TogglePin,
                label,
                ..
            } if label == "Unpin active thread"
        )));

        let terminal_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "terminal active",
        );
        assert!(terminal_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ActiveThreadAction {
                action: ActiveThreadPaletteAction::OpenTerminal,
                ..
            }
        )));

        let archive_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "archive active",
        );
        assert!(archive_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ActiveThreadAction {
                action: ActiveThreadPaletteAction::Archive,
                ..
            }
        )));
    }

    #[test]
    fn palette_search_includes_backed_project_actions() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        store.new_thread(project_id);

        let terminal_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "terminal project",
        );
        assert!(terminal_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ProjectAction {
                project_id: item_project_id,
                action: ProjectPaletteAction::OpenTerminal,
                ..
            } if *item_project_id == project_id
        )));

        let worktree_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "create worktree project",
        );
        assert!(worktree_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ProjectAction {
                project_id: item_project_id,
                action: ProjectPaletteAction::CreateWorktree,
                ..
            } if *item_project_id == project_id
        )));

        let archive_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "archive project",
        );
        assert!(archive_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ProjectAction {
                project_id: item_project_id,
                action: ProjectPaletteAction::Archive,
                ..
            } if *item_project_id == project_id
        )));
    }

    #[test]
    fn palette_search_includes_pending_approval_decisions() {
        let mut store = DesktopStore::new();
        store.apply_provider_runtime_event_batch(ProviderRuntimeEventBatch {
            provider: "codex".to_string(),
            last_persisted_sequence: Some(1),
            max_batch_size: 512,
            events: vec![ProviderRuntimeEvent::ServerRequest {
                request: Box::new(NormalizedServerRequest {
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
                    detail: ServerRequestDetail {
                        command: Some("cargo test".to_string()),
                        ..ServerRequestDetail::default()
                    },
                    metadata: serde_json::Value::Null,
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("command/approvalRequest".to_string()),
                        schema_version: None,
                        raw_payload: serde_json::json!({ "command": "cargo test" }),
                    },
                }),
            }],
            projection_deltas: Vec::new(),
            raw_event_summaries: Vec::new(),
            raw_events: None,
        });

        let approve_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "approve cargo",
        );
        assert!(approve_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ApprovalAction {
                action: ApprovalPaletteAction::Approve,
                provider,
                request_id,
                ..
            } if provider == "codex" && request_id == "approval-1"
        )));

        let deny_items = palette_items(&store.projection(), SearchPaletteMode::Root, "deny cargo");
        assert!(deny_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ApprovalAction {
                action: ApprovalPaletteAction::Deny,
                provider,
                request_id,
                ..
            } if provider == "codex" && request_id == "approval-1"
        )));
    }

    #[test]
    fn palette_search_includes_backed_review_actions() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        store.new_thread(project_id);
        store.refresh_active_review(None);

        let stage_items =
            palette_items(&store.projection(), SearchPaletteMode::Root, "stage review");
        assert!(stage_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ReviewAction {
                action: ReviewPaletteAction::StageAll,
                ..
            }
        )));

        let refresh_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "refresh git review",
        );
        assert!(refresh_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ReviewAction {
                action: ReviewPaletteAction::Refresh,
                ..
            }
        )));

        let commit_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "commit staged review",
        );
        assert!(!commit_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ReviewAction {
                action: ReviewPaletteAction::Commit,
                ..
            }
        )));
    }

    #[test]
    fn palette_search_includes_backed_todo_status_actions() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id,
            ComposerPayload {
                prompt: "Track todo palette actions".to_string(),
            },
        );
        store.create_todo_from_latest_timeline_item();
        let todo_id = store.projection().annotations.todos[0].id.clone();

        let complete_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "complete todo",
        );
        assert!(complete_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::TodoAction {
                todo_id: item_todo_id,
                action: TodoPaletteAction::Complete,
                ..
            } if *item_todo_id == todo_id
        )));

        store.update_todo_status(&todo_id, TodoStatus::Done);
        let reopen_items =
            palette_items(&store.projection(), SearchPaletteMode::Root, "reopen todo");
        assert!(reopen_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::TodoAction {
                todo_id: item_todo_id,
                action: TodoPaletteAction::Open,
                ..
            } if *item_todo_id == todo_id
        )));
    }

    #[test]
    fn palette_search_includes_backed_todo_metadata_actions() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id,
            ComposerPayload {
                prompt: "Track todo metadata palette actions".to_string(),
            },
        );
        store.create_todo_from_latest_timeline_item();
        store.create_review_comment_for_file("src/lib.rs".to_string());
        let todo_id = store.projection().annotations.todos[0].id.clone();

        let priority_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "priority high todo",
        );
        assert!(priority_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::TodoAction {
                todo_id: item_todo_id,
                action: TodoPaletteAction::Priority(TodoPriority::High),
                ..
            } if *item_todo_id == todo_id
        )));

        let assignee_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "assign todo agent",
        );
        assert!(assignee_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::TodoAction {
                todo_id: item_todo_id,
                action: TodoPaletteAction::Assign(TodoAssignee::Agent),
                ..
            } if *item_todo_id == todo_id
        )));

        let link_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "link todo current diff",
        );
        assert!(link_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::TodoAction {
                todo_id: item_todo_id,
                action: TodoPaletteAction::LinkCurrentDiff,
                ..
            } if *item_todo_id == todo_id
        )));
    }

    #[test]
    fn palette_root_includes_command_center_actions() {
        let store = DesktopStore::new();
        let items = palette_items(&store.projection(), SearchPaletteMode::Root, "");

        for expected in [
            SearchPaletteItem::NewThread,
            SearchPaletteItem::NewProject,
            SearchPaletteItem::OpenScheduled,
            SearchPaletteItem::OpenTerminals,
            SearchPaletteItem::OpenBrowser,
            SearchPaletteItem::ToggleRightPanel,
            SearchPaletteItem::RefreshActiveTab,
            SearchPaletteItem::CreateWorktree,
            SearchPaletteItem::ShowPinned,
            SearchPaletteItem::ShowTodos,
            SearchPaletteItem::ManagePlugins,
            SearchPaletteItem::ManageSkills,
            SearchPaletteItem::ConfigureProviders,
            SearchPaletteItem::ShowApprovals,
        ] {
            assert!(items.contains(&expected), "missing {expected:?}");
        }
        for tab in [
            RightPanelTab::Environment,
            RightPanelTab::Summary,
            RightPanelTab::Review,
            RightPanelTab::Terminal,
            RightPanelTab::Worktrees,
            RightPanelTab::Approvals,
            RightPanelTab::Browser,
            RightPanelTab::Editor,
            RightPanelTab::Sources,
            RightPanelTab::Pinned,
            RightPanelTab::Todos,
            RightPanelTab::Scheduled,
            RightPanelTab::Providers,
            RightPanelTab::Plugins,
            RightPanelTab::Skills,
            RightPanelTab::Settings,
        ] {
            assert!(
                items
                    .iter()
                    .any(|item| matches!(item, SearchPaletteItem::Inspector { tab: item_tab, .. } if *item_tab == tab)),
                "missing inspector action for {tab:?}"
            );
        }
        assert!(!items.contains(&SearchPaletteItem::SetProjectDefaultModel));
    }

    #[test]
    fn palette_root_includes_project_default_model_only_when_backed() {
        let empty = DesktopStore::new();
        let empty_items = palette_items(
            &empty.projection(),
            SearchPaletteMode::Root,
            "set project default model",
        );
        assert!(
            !empty_items
                .iter()
                .any(|item| matches!(item, SearchPaletteItem::SetProjectDefaultModel))
        );

        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        store.new_thread(project_id);
        store.set_active_composer_model(ProviderKind::Codex, "gpt-5".to_string());

        let backed_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "set project default model",
        );
        assert!(
            backed_items
                .iter()
                .any(|item| matches!(item, SearchPaletteItem::SetProjectDefaultModel))
        );
    }

    #[test]
    fn unavailable_palette_commands_explain_missing_services_without_dead_remote_action() {
        let store = DesktopStore::new();
        let remote_items = palette_items(&store.projection(), SearchPaletteMode::Root, "remote");

        assert!(
            remote_items
                .iter()
                .any(|item| matches!(item, SearchPaletteItem::ComposerRuntimeMode { .. })),
            "remote search should expose backed composer runtime controls instead of a no-op connect action"
        );
        let scheduled = palette_items(&store.projection(), SearchPaletteMode::Root, "scheduled")
            .into_iter()
            .find(|item| matches!(item, SearchPaletteItem::OpenScheduled))
            .expect("scheduled command remains searchable");
        assert_eq!(scheduled.disabled_reason(), None);

        assert_eq!(SearchPaletteItem::SwitchModel.disabled_reason(), None);
        assert_eq!(SearchPaletteItem::RunTests.disabled_reason(), None);
        assert_eq!(SearchPaletteItem::RunLint.disabled_reason(), None);
    }

    #[test]
    fn palette_search_includes_composer_traits() {
        let store = DesktopStore::new();
        let items = palette_items(&store.projection(), SearchPaletteMode::Root, "precise");

        assert!(items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ComposerTrait {
                trait_kind: ComposerTrait::Precise,
                ..
            }
        )));
    }

    #[test]
    fn palette_search_includes_backed_composer_turn_controls() {
        let store = DesktopStore::new();
        let projection = store.projection();

        let reasoning = palette_items(&projection, SearchPaletteMode::Root, "high reasoning");
        assert!(reasoning.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ComposerReasoning {
                effort: ReasoningEffort::High,
                ..
            }
        )));

        let permissions = palette_items(&projection, SearchPaletteMode::Root, "full access");
        assert!(permissions.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ComposerPermission {
                permission: ComposerPermissionMode::FullAccess,
                ..
            }
        )));

        let remote = palette_items(&projection, SearchPaletteMode::Root, "runtime remote")
            .into_iter()
            .find(|item| {
                matches!(
                    item,
                    SearchPaletteItem::ComposerRuntimeMode {
                        runtime_mode: RuntimeMode::Remote,
                        ..
                    }
                )
            })
            .expect("remote runtime mode");
        assert_eq!(
            remote.disabled_reason(),
            Some("No connected remote host is available yet.")
        );

        let plan = palette_items(&projection, SearchPaletteMode::Root, "mode plan");
        assert!(plan.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ComposerInteractionMode {
                interaction_mode: InteractionMode::Plan,
                ..
            }
        )));
    }

    #[test]
    fn palette_search_includes_backed_composer_context_controls() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Track composer context palette controls".to_string(),
            },
        );
        let message_id = store.projection().chat.messages[0].id.clone();
        store.pin_timeline_item(thread_id.clone(), &message_id);
        store.create_todo_from_latest_timeline_item();
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
                    history: "cargo test --workspace\n".to_string(),
                    exit_code: None,
                    exit_signal: None,
                    cols: 120,
                    rows: 32,
                    updated_at: "terminal".to_string(),
                    next_sequence: 1,
                    truncated_before_sequence: None,
                },
            },
        });

        let pinned_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "context pinned",
        );
        assert!(pinned_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ComposerContext {
                context: ComposerContextKind::Pinned,
                count: 1,
                ..
            }
        )));

        let todo_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "context todos",
        );
        assert!(todo_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ComposerContext {
                context: ComposerContextKind::Todos,
                count: 1,
                ..
            }
        )));

        let terminal_items = palette_items(
            &store.projection(),
            SearchPaletteMode::Root,
            "context terminal",
        );
        assert!(terminal_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ComposerContext {
                context: ComposerContextKind::Terminal,
                count: 1,
                ..
            }
        )));
    }

    #[test]
    fn palette_search_includes_backed_composer_host_controls() {
        let mut store = DesktopStore::new();
        store.apply_provider_runtime_event_batch(ProviderRuntimeEventBatch {
            provider: "codex".to_string(),
            last_persisted_sequence: Some(1),
            max_batch_size: 512,
            events: Vec::new(),
            projection_deltas: vec![
                ProviderRuntimeProjectionDelta::RemoteConnectionUpdated {
                    provider: "codex".to_string(),
                    connection: RemoteConnectionRecord {
                        provider: "codex".to_string(),
                        host_id: "devbox-a".to_string(),
                        host: Some("devbox-a.internal".to_string()),
                        display_name: Some("Devbox A".to_string()),
                        status: Some("connected".to_string()),
                        execution_location: ExecutionLocation::RemoteHost,
                        projects: serde_json::json!([{ "path": "/srv/ace" }]),
                        metadata: serde_json::Value::Null,
                    },
                },
                ProviderRuntimeProjectionDelta::RemoteConnectionUpdated {
                    provider: "codex".to_string(),
                    connection: RemoteConnectionRecord {
                        provider: "codex".to_string(),
                        host_id: "devbox-b".to_string(),
                        host: Some("devbox-b.internal".to_string()),
                        display_name: Some("Devbox B".to_string()),
                        status: Some("offline".to_string()),
                        execution_location: ExecutionLocation::RemoteHost,
                        projects: serde_json::json!([]),
                        metadata: serde_json::Value::Null,
                    },
                },
            ],
            raw_event_summaries: Vec::new(),
            raw_events: None,
        });

        let projection = store.projection();
        let local_items = palette_items(&projection, SearchPaletteMode::Root, "host this computer");
        assert!(local_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ComposerHost {
                provider: None,
                host_id: None,
                selectable: true,
                ..
            }
        )));

        let connected_items = palette_items(&projection, SearchPaletteMode::Root, "host devbox a");
        assert!(connected_items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ComposerHost {
                provider: Some(provider),
                host_id: Some(host_id),
                selectable: true,
                ..
            } if provider == "codex" && host_id == "devbox-a"
        )));

        let offline = palette_items(&projection, SearchPaletteMode::Root, "host devbox b")
            .into_iter()
            .find(|item| {
                matches!(
                    item,
                    SearchPaletteItem::ComposerHost {
                        host_id: Some(host_id),
                        ..
                    } if host_id == "devbox-b"
                )
            })
            .expect("offline remote host");
        assert_eq!(
            offline.disabled_reason(),
            Some("Remote host is not connected.")
        );
    }

    #[test]
    fn palette_search_includes_centralized_theme_and_font_settings() {
        let store = DesktopStore::new();
        let projection = store.projection();

        let compact = palette_items(&projection, SearchPaletteMode::Root, "density compact");
        assert!(compact.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ThemeDensity {
                density: ThemeDensity::Compact,
                ..
            }
        )));

        let menlo = palette_items(&projection, SearchPaletteMode::Root, "code font menlo");
        assert!(menlo.iter().any(|item| matches!(
            item,
            SearchPaletteItem::CodeFont {
                font: CodeFont::Menlo,
                ..
            }
        )));

        let rose = palette_items(&projection, SearchPaletteMode::Root, "accent rose");
        assert!(rose.iter().any(|item| matches!(
            item,
            SearchPaletteItem::ThemeAccent {
                accent: ThemeAccent::Rose,
                ..
            }
        )));
    }
}
