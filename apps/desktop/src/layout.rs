use crate::theme::Theme;
use gpui::{IntoElement, MouseButton, div, prelude::*};

pub fn shell_layout(theme: Theme, sidebar_collapsed: bool) -> impl IntoElement {
    div()
        .id("ace-shell")
        .size_full()
        .flex()
        .flex_row()
        .when(!sidebar_collapsed, |this| {
            this.child(
                div()
                    .id("ace-sidebar")
                    .w(theme.sidebar_width)
                    .h_full()
                    .border_r_1()
                    .border_color(theme.border)
                    .bg(theme.sidebar)
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .child("Ace")
                            .child(collapse_button("Hide", theme)),
                    )
                    .child("Sidebar"),
            )
        })
        .child(
            div().id("ace-workspace").flex_1().h_full().p_4().child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .when(!sidebar_collapsed, |this| this.hidden())
                            .child(collapse_button("Show", theme)),
                    )
                    .child("Desktop scaffold"),
            ),
        )
}

fn collapse_button(label: &'static str, theme: Theme) -> impl IntoElement {
    div()
        .id(if label == "Hide" {
            "sidebar-toggle-hide"
        } else {
            "sidebar-toggle-show"
        })
        .px_2()
        .py_1()
        .rounded_md()
        .border_1()
        .border_color(theme.border)
        .bg(theme.button)
        .hover(|this| this.bg(theme.button_hover))
        .child(label)
        .on_mouse_up(MouseButton::Left, |_, window, cx| {
            window.dispatch_action(Box::new(crate::app::ToggleSidebar), cx);
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_collapsed_and_expanded_shell_states() {
        let theme = Theme::default();
        let _ = shell_layout(theme, false);
        let _ = shell_layout(theme, true);
    }
}
