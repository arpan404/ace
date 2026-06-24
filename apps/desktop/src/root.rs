use crate::{app::ToggleSidebar, layout::shell_layout, theme::Theme};
use gpui::{Context, FocusHandle, IntoElement, Render, Window, div, prelude::*};

pub struct RootView {
    focus_handle: FocusHandle,
    sidebar_collapsed: bool,
}

impl RootView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window);
        Self {
            focus_handle,
            sidebar_collapsed: false,
        }
    }

    fn toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_collapsed = !self.sidebar_collapsed;
        cx.notify();
    }
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::default();

        div()
            .id("ace-root")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::toggle_sidebar))
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .font_family(theme.font_family)
            .child(shell_layout(theme, self.sidebar_collapsed))
    }
}
