use crate::{layout::shell_layout, theme::Theme};
use gpui::{Context, FocusHandle, IntoElement, Render, Window, div, prelude::*};

pub struct RootView {
    focus_handle: FocusHandle,
}

impl RootView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window);
        Self { focus_handle }
    }
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::default();

        div()
            .id("ace-root")
            .track_focus(&self.focus_handle)
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .font_family(theme.font_family)
            .child(shell_layout(theme))
    }
}
