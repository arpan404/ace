use crate::actions::{
    FocusPanel, InterruptActiveTurn, NewThread, OpenSearchPalette, RefreshActiveTab,
    SendActiveComposer, ShowBrowserTab, ShowPinnedTab, ShowTerminalTab, ShowTodosTab,
    ToggleEnvironmentPanel, ToggleRightPanel, ToggleSidebar,
};
use crate::stores::ui::FocusedPanel;
use gpui::KeyBinding;

pub const TOGGLE_SIDEBAR: &str = "cmd-b";
pub const TOGGLE_ENVIRONMENT_PANEL: &str = "cmd-e";
pub const SHOW_TERMINAL_TAB: &str = "cmd-j";
pub const TOGGLE_RIGHT_PANEL: &str = "cmd-\\";
pub const NEW_THREAD: &str = "cmd-n";
pub const OPEN_SEARCH_PALETTE: &str = "cmd-k";
pub const SEARCH_ACTIVE_PANEL: &str = "cmd-f";
pub const SHOW_BROWSER_TAB: &str = "cmd-shift-b";
pub const SHOW_PINNED_TAB: &str = "cmd-p";
pub const SHOW_TODOS_TAB: &str = "cmd-shift-t";
pub const REFRESH_ACTIVE_TAB: &str = "cmd-r";
pub const SEND_ACTIVE_COMPOSER: &str = "cmd-enter";
pub const INTERRUPT_ACTIVE_TURN: &str = "cmd-.";
pub const FOCUS_LEFT_PANEL: &str = "cmd-1";
pub const FOCUS_CENTER_PANEL: &str = "cmd-2";
pub const FOCUS_RIGHT_PANEL: &str = "cmd-3";

pub fn app_key_bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new(TOGGLE_SIDEBAR, ToggleSidebar, None),
        KeyBinding::new(TOGGLE_ENVIRONMENT_PANEL, ToggleEnvironmentPanel, None),
        KeyBinding::new(SHOW_TERMINAL_TAB, ShowTerminalTab, None),
        KeyBinding::new(TOGGLE_RIGHT_PANEL, ToggleRightPanel, None),
        KeyBinding::new(NEW_THREAD, NewThread, None),
        KeyBinding::new(OPEN_SEARCH_PALETTE, OpenSearchPalette, None),
        KeyBinding::new(SEARCH_ACTIVE_PANEL, OpenSearchPalette, None),
        KeyBinding::new(SHOW_BROWSER_TAB, ShowBrowserTab, None),
        KeyBinding::new(SHOW_PINNED_TAB, ShowPinnedTab, None),
        KeyBinding::new(SHOW_TODOS_TAB, ShowTodosTab, None),
        KeyBinding::new(REFRESH_ACTIVE_TAB, RefreshActiveTab, None),
        KeyBinding::new(SEND_ACTIVE_COMPOSER, SendActiveComposer, None),
        KeyBinding::new(INTERRUPT_ACTIVE_TURN, InterruptActiveTurn, None),
        KeyBinding::new(
            FOCUS_LEFT_PANEL,
            FocusPanel {
                panel: FocusedPanel::Sidebar,
            },
            None,
        ),
        KeyBinding::new(
            FOCUS_CENTER_PANEL,
            FocusPanel {
                panel: FocusedPanel::Center,
            },
            None,
        ),
        KeyBinding::new(
            FOCUS_RIGHT_PANEL,
            FocusPanel {
                panel: FocusedPanel::Right,
            },
            None,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_shortcut_matches_product_requirement() {
        assert_eq!(SHOW_TERMINAL_TAB, "cmd-j");
    }

    #[test]
    fn app_key_bindings_cover_declared_shortcuts() {
        assert_eq!(app_key_bindings().len(), 16);
    }
}
