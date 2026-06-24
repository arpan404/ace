use crate::{
    components::{icon_button, tab},
    icons::IconKind,
    shell::ShellViewModel,
    theme::{colors, metrics},
};
use gpui::{AnyElement, InteractiveElement, IntoElement, ParentElement, Styled, div, px, rgb};

pub(super) fn terminal_panel(model: &ShellViewModel) -> AnyElement {
    div()
        .id("ace-terminal-panel")
        .h(px(metrics::TERMINAL_HEIGHT))
        .min_h(px(metrics::TERMINAL_HEIGHT))
        .flex()
        .flex_col()
        .bg(rgb(colors::TERMINAL))
        .child(terminal_header(model))
        .child(terminal_body())
        .into_any_element()
}

fn terminal_header(model: &ShellViewModel) -> AnyElement {
    div()
        .h(px(38.0))
        .flex()
        .items_center()
        .justify_between()
        .px(px(12.0))
        .border_b_1()
        .border_color(rgb(colors::BORDER))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(tab("arpanbhandari@A", true))
                .child(icon_button(IconKind::Add)),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(12.0))
                .text_color(rgb(colors::TEXT_SUBTLE))
                .child(model.status.clone())
                .child(icon_button(IconKind::Menu)),
        )
        .into_any_element()
}

fn terminal_body() -> AnyElement {
    div()
        .flex_1()
        .p(px(16.0))
        .bg(rgb(colors::SHELL_BLACK))
        .text_size(px(14.0))
        .text_color(rgb(0xd8d8d8))
        .flex()
        .flex_col()
        .gap(px(8.0))
        .child("codex")
        .child(
            div()
                .flex()
                .items_center()
                .child(prompt_segment(
                    "~/.codex/worktrees/f34d/t3code",
                    colors::BLUE,
                ))
                .child(prompt_segment(" on rust-port *1 !3 ?1 ", colors::WARNING))
                .child(prompt_segment(" base ", 0xffffff)),
        )
        .into_any_element()
}

fn prompt_segment(text: &str, color: u32) -> AnyElement {
    div()
        .px(px(6.0))
        .py(px(2.0))
        .bg(rgb(color))
        .text_color(rgb(if color == 0xffffff {
            colors::APP
        } else {
            colors::TEXT
        }))
        .child(text.to_owned())
        .into_any_element()
}
