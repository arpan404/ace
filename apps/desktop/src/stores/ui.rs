use crate::{
    persistence::PersistenceStore,
    ui::{
        layout::PanelLayout,
        theme::{CodeFont, Theme, ThemeDensity, ThemeMotion, ThemePreset, ThemeSettings, UiFont},
    },
};
use ace_core::ProjectId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RightPanelTab {
    #[default]
    Review,
    Environment,
    Terminal,
    Worktrees,
    Approvals,
    Browser,
    Editor,
    Summary,
    Sources,
    Providers,
    Plugins,
    Skills,
    Settings,
    Pinned,
    Todos,
    Scheduled,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BottomPanelTab {
    #[default]
    Terminal,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FocusedPanel {
    Sidebar,
    #[default]
    Center,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiState {
    pub sidebar_width: f32,
    pub right_panel_width: f32,
    #[serde(default = "default_bottom_panel_height")]
    pub bottom_panel_height: f32,
    pub sidebar_collapsed: bool,
    #[serde(default = "default_right_panel_visible")]
    pub right_panel_visible: bool,
    #[serde(default)]
    pub bottom_panel_visible: bool,
    #[serde(default = "default_environment_panel_visible")]
    pub environment_panel_visible: bool,
    #[serde(default)]
    pub right_panel_tab: RightPanelTab,
    #[serde(default)]
    pub bottom_panel_tab: BottomPanelTab,
    #[serde(default)]
    pub expanded_project_ids: Vec<ProjectId>,
    #[serde(default)]
    pub theme: ThemeSettings,
    #[serde(default)]
    pub focused_panel: FocusedPanel,
}

fn default_right_panel_visible() -> bool {
    true
}

fn default_bottom_panel_height() -> f32 {
    f32::from(PanelLayout::new(Default::default()).bottom_panel_height)
}

fn default_environment_panel_visible() -> bool {
    true
}

impl Default for UiState {
    fn default() -> Self {
        let theme_settings = ThemeSettings::default();
        let layout = PanelLayout::new(Theme::from_settings(&theme_settings));
        Self {
            sidebar_width: f32::from(layout.sidebar_width),
            right_panel_width: f32::from(layout.right_panel_width),
            bottom_panel_height: f32::from(layout.bottom_panel_height),
            sidebar_collapsed: false,
            right_panel_visible: true,
            bottom_panel_visible: false,
            environment_panel_visible: true,
            right_panel_tab: RightPanelTab::Review,
            bottom_panel_tab: BottomPanelTab::Terminal,
            expanded_project_ids: Vec::new(),
            theme: theme_settings,
            focused_panel: FocusedPanel::Center,
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
        let mut layout = PanelLayout::new(self.theme());
        layout.sidebar_width = gpui::px(self.state.sidebar_width);
        layout.right_panel_width = gpui::px(self.state.right_panel_width);
        layout.bottom_panel_height = gpui::px(self.state.bottom_panel_height);
        layout
    }

    #[must_use]
    pub fn theme(&self) -> Theme {
        Theme::from_settings(&self.state.theme)
    }

    pub fn set_panel_layout(&mut self, layout: PanelLayout) {
        self.state.sidebar_width = f32::from(layout.sidebar_width);
        self.state.right_panel_width = f32::from(layout.right_panel_width);
        self.state.bottom_panel_height = f32::from(layout.bottom_panel_height);
    }

    pub fn toggle_sidebar(&mut self) {
        self.state.sidebar_collapsed = !self.state.sidebar_collapsed;
    }

    pub fn toggle_right_panel(&mut self) {
        self.state.right_panel_visible = !self.state.right_panel_visible;
        if self.state.right_panel_visible {
            self.state.focused_panel = FocusedPanel::Right;
        } else if self.state.focused_panel == FocusedPanel::Right {
            self.state.focused_panel = FocusedPanel::Center;
        }
    }

    pub fn toggle_bottom_panel(&mut self) {
        self.state.bottom_panel_visible = !self.state.bottom_panel_visible;
    }

    pub fn toggle_environment_panel(&mut self) {
        self.state.environment_panel_visible = !self.state.environment_panel_visible;
    }

    pub fn select_right_panel_tab(&mut self, tab: RightPanelTab) {
        self.state.right_panel_tab = tab;
        self.state.right_panel_visible = true;
        self.state.focused_panel = FocusedPanel::Right;
    }

    pub fn select_bottom_panel_tab(&mut self, tab: BottomPanelTab) {
        self.state.bottom_panel_tab = tab;
        self.state.bottom_panel_visible = true;
        self.state.focused_panel = FocusedPanel::Center;
    }

    pub fn focus_panel(&mut self, panel: FocusedPanel) {
        match panel {
            FocusedPanel::Sidebar => {
                self.state.sidebar_collapsed = false;
            }
            FocusedPanel::Center => {}
            FocusedPanel::Right => {
                self.state.right_panel_visible = true;
            }
        }
        self.state.focused_panel = panel;
    }

    pub fn set_theme_preset(&mut self, preset: ThemePreset) {
        self.state.theme.preset = preset;
    }

    pub fn set_theme_density(&mut self, density: ThemeDensity) {
        self.state.theme.density = density;
    }

    pub fn set_ui_font(&mut self, ui_font: UiFont) {
        self.state.theme.ui_font = ui_font;
    }

    pub fn set_code_font(&mut self, code_font: CodeFont) {
        self.state.theme.code_font = code_font;
    }

    pub fn set_theme_motion(&mut self, motion: ThemeMotion) {
        self.state.theme.motion = motion;
    }

    pub fn set_theme_accent(&mut self, accent: crate::ui::theme::ThemeAccent) {
        self.state.theme.accent = accent;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::theme::{CodeFont, ThemeAccent, ThemeDensity, ThemeMotion, ThemePreset, UiFont};

    #[test]
    fn ui_store_theme_uses_persisted_font_motion_and_density_settings() {
        let store = UiStore::restore(UiState {
            theme: ThemeSettings {
                preset: ThemePreset::HighContrast,
                density: ThemeDensity::Compact,
                ui_font: UiFont::Monospace,
                code_font: CodeFont::Menlo,
                motion: ThemeMotion::Reduced,
                accent: ThemeAccent::Amber,
            },
            ..UiState::default()
        });

        let theme = store.theme();

        assert_eq!(theme.ui_font_family, "SF Mono");
        assert_eq!(theme.code_font_family, "Menlo");
        assert_eq!(theme.accent_blue, gpui::rgb(0xf59e0b).into());
        assert_eq!(theme.center_header_height, gpui::px(52.0));
        assert_eq!(theme.motion_fast_ms, 0);
    }

    #[test]
    fn ui_store_updates_theme_settings_through_typed_setters() {
        let mut store = UiStore::default();

        store.set_theme_preset(ThemePreset::HighContrast);
        store.set_theme_density(ThemeDensity::Compact);
        store.set_ui_font(UiFont::Monospace);
        store.set_code_font(CodeFont::Menlo);
        store.set_theme_motion(ThemeMotion::Reduced);
        store.set_theme_accent(ThemeAccent::Rose);

        assert_eq!(store.state().theme.preset, ThemePreset::HighContrast);
        assert_eq!(store.state().theme.density, ThemeDensity::Compact);
        assert_eq!(store.state().theme.ui_font, UiFont::Monospace);
        assert_eq!(store.state().theme.code_font, CodeFont::Menlo);
        assert_eq!(store.state().theme.motion, ThemeMotion::Reduced);
        assert_eq!(store.state().theme.accent, ThemeAccent::Rose);
    }

    #[test]
    fn ui_store_focus_panel_reveals_target_panels() {
        let mut store = UiStore::restore(UiState {
            sidebar_collapsed: true,
            right_panel_visible: false,
            focused_panel: FocusedPanel::Center,
            ..UiState::default()
        });

        store.focus_panel(FocusedPanel::Sidebar);
        assert!(!store.state().sidebar_collapsed);
        assert_eq!(store.state().focused_panel, FocusedPanel::Sidebar);

        store.focus_panel(FocusedPanel::Right);
        assert!(store.state().right_panel_visible);
        assert_eq!(store.state().focused_panel, FocusedPanel::Right);
    }

    #[test]
    fn ui_store_right_panel_selection_tracks_keyboard_focus() {
        let mut store = UiStore::restore(UiState {
            right_panel_visible: false,
            focused_panel: FocusedPanel::Center,
            ..UiState::default()
        });

        store.select_right_panel_tab(RightPanelTab::Summary);
        assert!(store.state().right_panel_visible);
        assert_eq!(store.state().right_panel_tab, RightPanelTab::Summary);
        assert_eq!(store.state().focused_panel, FocusedPanel::Right);

        store.toggle_right_panel();
        assert!(!store.state().right_panel_visible);
        assert_eq!(store.state().focused_panel, FocusedPanel::Center);

        store.toggle_right_panel();
        assert!(store.state().right_panel_visible);
        assert_eq!(store.state().focused_panel, FocusedPanel::Right);
    }
}
