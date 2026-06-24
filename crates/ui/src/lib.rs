mod backend;
mod components;
mod icons;
mod panels;
mod shell;
mod shell_regions;
mod state;
mod theme;

pub use backend::DesktopBackend;
pub use components::{
    AlertTone, ButtonSize, ButtonVariant, alert, badge, button, card, panel_title, tab,
};
pub use icons::{IconKind, icon};
pub use shell::{APP_TITLE, AppShell, ShellViewModel, app_shell};
pub use theme::{colors, metrics};
