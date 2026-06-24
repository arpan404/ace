use crate::theme::Theme;
use gpui::{IntoElement, div, prelude::*};

pub fn shell_layout(theme: Theme) -> impl IntoElement {
    div()
        .id("ace-shell")
        .size_full()
        .flex()
        .flex_row()
        .child(
            div()
                .id("ace-sidebar")
                .w(theme.sidebar_width)
                .h_full()
                .border_r_1()
                .border_color(theme.border)
                .bg(theme.sidebar)
                .p_4()
                .child("Ace"),
        )
        .child(
            div()
                .id("ace-workspace")
                .flex_1()
                .h_full()
                .p_4()
                .child("Desktop scaffold"),
        )
}
