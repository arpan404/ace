use crate::{
    components::{ButtonSize, ButtonVariant, badge, button},
    panels,
    shell::ShellViewModel,
    theme::{colors, metrics},
};
use gpui::{
    AnyElement, FontWeight, InteractiveElement, IntoElement, ParentElement, Styled, div, px, rgb,
};

pub(super) fn top_bar(model: &ShellViewModel) -> AnyElement {
    div()
        .id("ace-topbar")
        .h(px(metrics::TOP_BAR_HEIGHT))
        .flex()
        .items_center()
        .justify_between()
        .px(px(14.0))
        .border_b_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::SURFACE))
        .child(window_title(model))
        .child(top_actions(model))
        .into_any_element()
}

pub(super) fn workbench() -> AnyElement {
    div()
        .id("ace-workbench")
        .flex()
        .flex_1()
        .min_h_0()
        .child(panels::left_sidebar())
        .child(panels::editor_area())
        .child(panels::right_panel())
        .into_any_element()
}

pub(super) fn bottom_panel(model: &ShellViewModel) -> AnyElement {
    div()
        .id("ace-bottom-panel")
        .h(px(metrics::BOTTOM_PANEL_HEIGHT))
        .min_h(px(metrics::BOTTOM_PANEL_HEIGHT))
        .flex()
        .flex_col()
        .border_t_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::APP))
        .child(panels::bottom_panel_header(model))
        .child(panels::bottom_panel_body())
        .into_any_element()
}

fn window_title(model: &ShellViewModel) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(10.0))
        .child(dot(colors::DANGER))
        .child(dot(colors::WARNING))
        .child(dot(colors::SUCCESS))
        .child(
            div()
                .ml(px(8.0))
                .font_weight(FontWeight(700.0))
                .child(model.title.clone()),
        )
        .into_any_element()
}

fn top_actions(model: &ShellViewModel) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .child(badge(&model.workspace_name))
        .child(badge(&model.branch_name))
        .child(button("Run", ButtonVariant::Secondary, ButtonSize::Small))
        .into_any_element()
}

fn dot(color: u32) -> AnyElement {
    div()
        .size(px(11.0))
        .rounded_full()
        .bg(rgb(color))
        .into_any_element()
}
