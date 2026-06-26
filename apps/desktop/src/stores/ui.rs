use crate::{persistence::PersistenceStore, ui::layout::PanelLayout};
use ace_core::ProjectId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiState {
    pub sidebar_width: f32,
    pub right_panel_width: f32,
    pub sidebar_collapsed: bool,
    #[serde(default)]
    pub expanded_project_ids: Vec<ProjectId>,
}

impl Default for UiState {
    fn default() -> Self {
        let layout = PanelLayout::new(Default::default());
        Self {
            sidebar_width: f32::from(layout.sidebar_width),
            right_panel_width: f32::from(layout.right_panel_width),
            sidebar_collapsed: false,
            expanded_project_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct UiStore {
    state: UiState,
}

impl UiStore {
    #[must_use]
    pub fn state(&self) -> &UiState {
        &self.state
    }

    #[must_use]
    pub fn panel_layout(&self) -> PanelLayout {
        let mut layout = PanelLayout::new(Default::default());
        layout.sidebar_width = gpui::px(self.state.sidebar_width);
        layout.right_panel_width = gpui::px(self.state.right_panel_width);
        layout
    }

    pub fn set_panel_layout(&mut self, layout: PanelLayout) {
        self.state.sidebar_width = f32::from(layout.sidebar_width);
        self.state.right_panel_width = f32::from(layout.right_panel_width);
    }

    pub fn toggle_sidebar(&mut self) {
        self.state.sidebar_collapsed = !self.state.sidebar_collapsed;
    }
}

impl PersistenceStore for UiStore {
    type Snapshot = UiState;
    const KEY: &'static str = "ui-state";

    fn snapshot(&self) -> Self::Snapshot {
        self.state.clone()
    }

    fn restore(snapshot: Self::Snapshot) -> Self {
        Self { state: snapshot }
    }
}
