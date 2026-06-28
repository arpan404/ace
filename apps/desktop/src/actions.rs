use crate::{
    stores::ui::{BottomPanelTab, RightPanelTab},
    ui::layout::SplitterKind,
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
        InterruptActiveTurn,
        TogglePinActiveThread,
        PinLatestTimelineItem,
        ToggleHighlightLatestTimelineItem,
        CreateTodoFromLatestTimelineItem,
        ToggleFirstOpenTodo,
        RefreshReview,
        StageReviewAll,
        UnstageReviewAll,
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
