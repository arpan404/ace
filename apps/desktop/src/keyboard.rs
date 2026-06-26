use crate::actions::{
    InterruptActiveTurn, NewThread, OpenSearchPalette, SendActiveComposer, ToggleBottomPanel,
    ToggleEnvironmentPanel, ToggleRightPanel, ToggleSidebar,
};
use gpui::KeyBinding;

pub const TOGGLE_SIDEBAR: &str = "cmd-b";
pub const TOGGLE_ENVIRONMENT_PANEL: &str = "cmd-e";
pub const TOGGLE_BOTTOM_PANEL: &str = "cmd-j";
pub const TOGGLE_RIGHT_PANEL: &str = "cmd-\\";
pub const NEW_THREAD: &str = "cmd-n";
pub const OPEN_SEARCH_PALETTE: &str = "cmd-k";
pub const SEND_ACTIVE_COMPOSER: &str = "cmd-enter";
pub const INTERRUPT_ACTIVE_TURN: &str = "cmd-.";

pub fn app_key_bindings() -> [KeyBinding; 8] {
    [
        KeyBinding::new(TOGGLE_SIDEBAR, ToggleSidebar, None),
        KeyBinding::new(TOGGLE_ENVIRONMENT_PANEL, ToggleEnvironmentPanel, None),
        KeyBinding::new(TOGGLE_BOTTOM_PANEL, ToggleBottomPanel, None),
        KeyBinding::new(TOGGLE_RIGHT_PANEL, ToggleRightPanel, None),
        KeyBinding::new(NEW_THREAD, NewThread, None),
        KeyBinding::new(OPEN_SEARCH_PALETTE, OpenSearchPalette, None),
        KeyBinding::new(SEND_ACTIVE_COMPOSER, SendActiveComposer, None),
        KeyBinding::new(INTERRUPT_ACTIVE_TURN, InterruptActiveTurn, None),
    ]
}
