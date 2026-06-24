use crate::{
    components::{AlertTone, alert, card, panel_title, tab},
    shell::ShellViewModel,
    theme::{colors, metrics},
};
use gpui::{AnyElement, InteractiveElement, IntoElement, ParentElement, Styled, div, px, rgb};

pub(super) fn left_sidebar() -> AnyElement {
    div()
        .id("ace-sidebar")
        .w(px(metrics::SIDEBAR_WIDTH))
        .min_w(px(metrics::SIDEBAR_WIDTH))
        .h_full()
        .flex()
        .flex_col()
        .border_r_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::SURFACE))
        .child(panel_title("Workspace"))
        .child(nav_row("Projects", true))
        .child(nav_row("Threads", false))
        .child(nav_row("Changes", false))
        .child(nav_row("Providers", false))
        .child(panel_title("Recent"))
        .child(card("ace", "Rust monorepo"))
        .child(card("codex", "Provider adapter"))
        .into_any_element()
}

pub(super) fn editor_area() -> AnyElement {
    div()
        .id("ace-editor-area")
        .flex()
        .flex_1()
        .min_w_0()
        .min_h_0()
        .flex_col()
        .bg(rgb(0x0f1218))
        .child(editor_tabs())
        .child(editor_canvas())
        .into_any_element()
}

pub(super) fn right_panel() -> AnyElement {
    div()
        .id("ace-side-panel")
        .w(px(metrics::SIDE_PANEL_WIDTH))
        .min_w(px(metrics::SIDE_PANEL_WIDTH))
        .h_full()
        .flex()
        .flex_col()
        .border_l_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::SURFACE))
        .child(panel_title("Assistant"))
        .child(alert(
            "Plan",
            "Ready for the next instruction",
            AlertTone::Info,
        ))
        .child(card("Tools", "Semantic timeline"))
        .child(card("Runtime", "WS connected"))
        .into_any_element()
}

pub(super) fn bottom_panel_body() -> AnyElement {
    div()
        .flex_1()
        .px(px(14.0))
        .py(px(12.0))
        .text_color(rgb(0xaab3c2))
        .child("$ ace desktop --port=3773")
        .into_any_element()
}

pub(super) fn bottom_panel_header(model: &ShellViewModel) -> AnyElement {
    div()
        .h(px(34.0))
        .flex()
        .items_center()
        .justify_between()
        .px(px(12.0))
        .border_b_1()
        .border_color(rgb(colors::BORDER))
        .child(
            div()
                .flex()
                .gap(px(8.0))
                .child(tab("Terminal", true))
                .child(tab("Output", false)),
        )
        .child(
            div()
                .text_color(rgb(colors::TEXT_MUTED))
                .child(model.status.clone()),
        )
        .into_any_element()
}

fn editor_tabs() -> AnyElement {
    div()
        .h(px(38.0))
        .flex()
        .items_center()
        .border_b_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::SURFACE_2))
        .child(tab("main.rs", true))
        .child(tab("runtime.rs", false))
        .child(tab("provider.rs", false))
        .into_any_element()
}

fn editor_canvas() -> AnyElement {
    div()
        .flex_1()
        .flex()
        .items_center()
        .justify_center()
        .text_color(rgb(colors::TEXT_MUTED))
        .child("Editor canvas")
        .into_any_element()
}

fn nav_row(label: &str, active: bool) -> AnyElement {
    div()
        .mx(px(8.0))
        .mb(px(3.0))
        .h(px(30.0))
        .flex()
        .items_center()
        .px(px(10.0))
        .rounded(px(metrics::RADIUS))
        .bg(rgb(if active {
            colors::ACCENT
        } else {
            colors::SURFACE
        }))
        .text_color(rgb(if active {
            colors::TEXT
        } else {
            colors::TEXT_MUTED
        }))
        .child(label.to_owned())
        .into_any_element()
}
