use crate::{
    stores::ui::{BottomPanelTab, RightPanelTab},
    ui::layout::SplitterKind,
};
use ace_runtime::chat::{
    ComposerContextKind, ComposerPermissionMode, ComposerTrait, InteractionMode, ReasoningEffort,
    RuntimeMode,
};
use gpui::{Point, actions};

actions!(
    ace,
    [
        Quit,
        ToggleSidebar,
        ToggleEnvironmentPanel,
        ToggleRightPanel,
        ToggleBottomPanel,
        NewThread,
        SendActiveComposer,
        SetActiveProjectDefaultModel,
        InterruptActiveTurn,
        TogglePinActiveThread,
        PinLatestTimelineItem,
        ToggleHighlightLatestTimelineItem,
        CreateTodoFromLatestTimelineItem,
        ToggleFirstOpenTodo,
        RefreshReview,
        StageReviewAll,
        UnstageReviewAll,
        CommitReview,
        PushReview,
        RefreshWorktrees,
        CreateWorktree,
        RefreshApprovals,
        RefreshActiveTab,
        RunTests,
        RunLint,
        ShowBrowserTab,
        ShowPinnedTab,
        ShowTodosTab,
        ShowProvidersTab,
        ShowPluginsTab,
        ShowSkillsTab,
        ArchiveActiveThread,
        AddCurrentDirectoryProject,
        OpenSearchPalette,
        CloseSearchPalette
    ]
);

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SelectSearchPaletteItem {
    pub item: crate::ui::search_palette::SearchPaletteItem,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct BeginPanelResize {
    pub kind: SplitterKind,
    pub position: Point<gpui::Pixels>,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SelectRightPanelTab {
    pub tab: RightPanelTab,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SelectBottomPanelTab {
    pub tab: BottomPanelTab,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetThemePreset {
    pub preset: crate::ui::theme::ThemePreset,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetThemeDensity {
    pub density: crate::ui::theme::ThemeDensity,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetUiFont {
    pub ui_font: crate::ui::theme::UiFont,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetCodeFont {
    pub code_font: crate::ui::theme::CodeFont,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetThemeMotion {
    pub motion: crate::ui::theme::ThemeMotion,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetThemeAccent {
    pub accent: crate::ui::theme::ThemeAccent,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SelectComposerModel {
    pub provider: ace_core::ProviderKind,
    pub model: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetComposerReasoning {
    pub effort: Option<ReasoningEffort>,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetComposerPermission {
    pub permission: ComposerPermissionMode,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct ToggleComposerTrait {
    pub trait_kind: ComposerTrait,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct ToggleComposerContext {
    pub context: ComposerContextKind,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetComposerRuntimeMode {
    pub runtime_mode: RuntimeMode,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SetComposerInteractionMode {
    pub interaction_mode: InteractionMode,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct SelectComposerHost {
    pub provider: Option<String>,
    pub host_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct CompleteComposerToken {
    pub completion: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct PinTimelineItem {
    pub thread_id: ace_core::ThreadId,
    pub message_id: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct ToggleHighlightTimelineItem {
    pub thread_id: ace_core::ThreadId,
    pub message_id: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct CreateTodoFromTimelineItem {
    pub thread_id: ace_core::ThreadId,
    pub message_id: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct UpdateTodoStatus {
    pub todo_id: String,
    pub status: crate::stores::TodoStatus,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct UpdateTodoPriority {
    pub todo_id: String,
    pub priority: crate::stores::TodoPriority,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct UpdateTodoAssignee {
    pub todo_id: String,
    pub assignee: crate::stores::TodoAssignee,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct LinkTodoToCurrentDiff {
    pub todo_id: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct StageReviewFile {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct UnstageReviewFile {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct CreateReviewComment {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct ToggleReviewCommentResolved {
    pub comment_id: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct RemoveWorktree {
    pub path: String,
    pub force: bool,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct ApproveProviderRequest {
    pub provider: String,
    pub request_id: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct DenyProviderRequest {
    pub provider: String,
    pub request_id: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct OpenThread {
    pub thread_id: ace_core::ThreadId,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct NewThreadForProject {
    pub project_id: ace_core::ProjectId,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct ArchiveProject {
    pub project_id: ace_core::ProjectId,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct ShowMoreProjectThreads {
    pub project_id: ace_core::ProjectId,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct ShowLessProjectThreads {
    pub project_id: ace_core::ProjectId,
}
