use crate::ui::theme::Theme;
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::{
    Icon, IconName, Sizable as _, Size,
    button::{Button, ButtonVariants as _},
    scroll::ScrollableElement as _,
};

pub(super) fn access_chip(theme: Theme) -> AnyElement {
    div()
        .h(px(28.0))
        .rounded_md()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(12.0))
        .text_color(theme.accent_warning)
        .hover(|this| this.bg(theme.button))
        .child(icon_svg(IconName::TriangleAlert, theme.accent_warning))
        .child("Full access")
        .child(icon_svg(IconName::ChevronDown, theme.accent_warning))
        .into_any_element()
}

pub(super) fn model_chip(theme: Theme, model: &'static str, effort: &'static str) -> AnyElement {
    div()
        .h(px(28.0))
        .rounded_md()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button))
        .child(icon_svg(IconName::Bot, theme.muted))
        .child(model)
        .child(effort)
        .child(icon_svg(IconName::ChevronDown, theme.muted))
        .into_any_element()
}

pub(super) fn meta_chip(icon: IconName, label: &'static str, theme: Theme) -> AnyElement {
    div()
        .h(px(24.0))
        .rounded_md()
        .px_1()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .child(icon_svg(icon, theme.muted))
        .child(label)
        .child(icon_svg(IconName::ChevronDown, theme.muted))
        .into_any_element()
}

pub(super) fn send_button(theme: Theme) -> AnyElement {
    div()
        .w(px(28.0))
        .h(px(28.0))
        .rounded_md()
        .bg(theme.button)
        .hover(|this| this.bg(theme.button_hover))
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.foreground.opacity(0.70))
        .child(icon_svg(IconName::ArrowUp, theme.foreground.opacity(0.70)))
        .on_mouse_up(MouseButton::Left, |_, window, cx| {
            window.dispatch_action(Box::new(crate::actions::SendActiveComposer), cx);
        })
        .into_any_element()
}

pub(super) fn scroll_y(element: gpui::Stateful<gpui::Div>) -> impl IntoElement {
    element.overflow_y_scrollbar()
}

pub(super) fn icon_svg(icon: IconName, color: gpui::Hsla) -> AnyElement {
    Icon::new(icon)
        .with_size(Size::Small)
        .text_color(color)
        .into_any_element()
}

pub(super) fn nav_button(icon: IconName, theme: Theme) -> AnyElement {
    div()
        .w(px(28.0))
        .h(px(28.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button).text_color(theme.foreground))
        .child(icon_svg(icon, theme.muted))
        .into_any_element()
}

pub(super) fn icon_tile(icon: IconName, theme: Theme) -> AnyElement {
    div()
        .w(px(18.0))
        .h(px(18.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .flex()
        .items_center()
        .justify_center()
        .child(icon_svg(icon, theme.muted))
        .into_any_element()
}

pub(super) fn project_action_button<F>(icon: IconName, theme: Theme, action: F) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .w(px(22.0))
        .h(px(22.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button_hover).text_color(theme.foreground))
        .child(icon_svg(icon, theme.muted))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

pub(super) fn project_icon(icon: Option<String>, _project_name: &str, theme: Theme) -> AnyElement {
    let icon = match icon.as_deref() {
        Some("github") => IconName::GitHub,
        Some("globe") => IconName::Globe,
        Some("terminal") => IconName::SquareTerminal,
        Some("package" | "folder") => IconName::Folder,
        Some("bot") => IconName::Bot,
        _ => IconName::FolderClosed,
    };
    div()
        .w(px(24.0))
        .h(px(24.0))
        .rounded_md()
        .bg(theme.background_elevated)
        .border_1()
        .border_color(theme.border)
        .flex()
        .items_center()
        .justify_center()
        .child(icon_svg(icon, theme.accent_pink))
        .into_any_element()
}

pub(super) fn info_row(theme: Theme, label: &'static str, value: &str) -> AnyElement {
    div()
        .h(px(32.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .child(
            div()
                .text_color(theme.muted)
                .text_size(px(12.0))
                .child(label),
        )
        .child(div().text_size(px(12.0)).child(value.to_string()))
        .into_any_element()
}

pub(super) fn panel_tab(
    icon: IconName,
    label: &'static str,
    active: bool,
    theme: Theme,
) -> AnyElement {
    div()
        .h(px(30.0))
        .rounded_md()
        .px_2()
        .bg(if active {
            theme.button
        } else {
            theme.panel_deep
        })
        .border_1()
        .border_color(if active {
            theme.border
        } else {
            theme.border.opacity(0.0)
        })
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .text_color(if active {
            theme.foreground.opacity(0.84)
        } else {
            theme.muted
        })
        .child(icon_svg(
            icon,
            if active {
                theme.foreground
            } else {
                theme.muted
            },
        ))
        .child(label)
        .into_any_element()
}

pub(super) fn icon_button(icon: IconName, theme: Theme) -> AnyElement {
    div()
        .w(px(28.0))
        .h(px(28.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button).text_color(theme.foreground))
        .child(icon_svg(icon, theme.muted))
        .into_any_element()
}

pub(super) fn action_button<F>(
    icon: IconName,
    label: &'static str,
    _theme: Theme,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    Button::new(label)
        .label(label)
        .icon(icon)
        .small()
        .ghost()
        .on_click(move |_, window, cx| window.dispatch_action(action(), cx))
        .into_any_element()
}

pub(super) fn collapse_button(icon: IconName, theme: Theme) -> AnyElement {
    div()
        .id("sidebar-toggle")
        .w(px(28.0))
        .h(px(28.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button).text_color(theme.foreground))
        .child(icon_svg(icon, theme.muted))
        .on_mouse_up(MouseButton::Left, |_, window, cx| {
            window.dispatch_action(Box::new(crate::actions::ToggleSidebar), cx);
        })
        .into_any_element()
}

pub(super) fn kbd(label: &'static str, theme: Theme) -> AnyElement {
    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .px_1()
        .py_1()
        .text_size(px(10.0))
        .text_color(theme.muted_subtle)
        .child(label)
        .into_any_element()
}

pub(super) fn section_label(label: &'static str) -> AnyElement {
    div()
        .mt_2()
        .text_size(px(11.0))
        .text_color(gpui::white().opacity(0.50))
        .child(label)
        .into_any_element()
}
