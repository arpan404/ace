use crate::{shell_regions, theme::colors};
use gpui::{
    App, AppContext, Context, InteractiveElement, IntoElement, ParentElement, Render, Styled,
    Window, div, px, rgb,
};

pub const APP_TITLE: &str = "Ace";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellViewModel {
    pub title: String,
    pub workspace_name: String,
    pub branch_name: String,
    pub status: String,
}

impl Default for ShellViewModel {
    fn default() -> Self {
        Self {
            title: APP_TITLE.to_owned(),
            workspace_name: "t3code".to_owned(),
            branch_name: "rust-port".to_owned(),
            status: "Backend ready".to_owned(),
        }
    }
}

pub struct AppShell {
    model: ShellViewModel,
}

impl AppShell {
    pub fn new(model: ShellViewModel) -> Self {
        Self { model }
    }
}

impl Render for AppShell {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("ace-root")
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(colors::APP))
            .text_color(rgb(colors::TEXT))
            .text_size(px(13.0))
            .child(shell_regions::top_bar(&self.model))
            .child(shell_regions::workbench())
            .child(shell_regions::bottom_panel(&self.model))
    }
}

pub fn app_shell(cx: &mut App) -> gpui::Entity<AppShell> {
    cx.new(|_| AppShell::new(ShellViewModel::default()))
}
