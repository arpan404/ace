use crate::ui::layout::SplitterKind;
use gpui::{Point, actions};

actions!(
    ace,
    [
        Quit,
        ToggleSidebar,
        NewThread,
        SendActiveComposer,
        InterruptActiveTurn,
        TogglePinActiveThread,
        ArchiveActiveThread,
        AddCurrentDirectoryProject
    ]
);

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ace, no_json)]
pub struct BeginPanelResize {
    pub kind: SplitterKind,
    pub position: Point<gpui::Pixels>,
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
