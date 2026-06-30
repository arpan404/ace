use crate::ui::theme::Theme;
use gpui::{
    Action, AnyElement, IntoElement, MouseButton, StatefulInteractiveElement as _, div, prelude::*,
    px,
};
use gpui_component::{
    Icon, IconName, IconNamed, Sizable as _, Size,
    button::{Button, ButtonVariants as _},
    scroll::ScrollableElement as _,
    tooltip::Tooltip,
};

#[derive(Clone, Copy)]
pub(super) enum AceIconName {
    Box,
    Code2,
    FlaskConical,
    Browser,
    Editor,
    Environment,
    ListChecks,
    PanelBottomClosed,
    PanelBottomOpen,
    PanelLeftClosed,
    PanelLeftOpen,
    PanelRightClosed,
    PanelRightOpen,
    Review,
    Summary,
    Terminal,
    PinFilled,
    Rocket,
    TablerSettings,
    TablerTerminal,
    SquarePen,
}

impl IconNamed for AceIconName {
    fn path(self) -> gpui::SharedString {
        match self {
            Self::Box => "icons/box.svg",
            Self::Code2 => "icons/code-2.svg",
            Self::FlaskConical => "icons/flask-conical.svg",
            Self::Browser => "icons/browser.svg",
            Self::Editor => "icons/editor.svg",
            Self::Environment => "icons/environment.svg",
            Self::ListChecks => "icons/lucide/list-checks.svg",
            Self::PanelBottomClosed => "icons/panel-bottom-closed.svg",
            Self::PanelBottomOpen => "icons/panel-bottom-open.svg",
            Self::PanelLeftClosed => "icons/panel-left-closed.svg",
            Self::PanelLeftOpen => "icons/panel-left-open.svg",
            Self::PanelRightClosed => "icons/panel-right-closed.svg",
            Self::PanelRightOpen => "icons/panel-right-open.svg",
            Self::Review => "icons/review.svg",
            Self::Summary => "icons/summary.svg",
            Self::Terminal => "icons/terminal.svg",
            Self::PinFilled => "icons/pin-filled.svg",
            Self::Rocket => "icons/rocket.svg",
            Self::TablerSettings => "icons/tabler-settings.svg",
            Self::TablerTerminal => "icons/tabler-terminal.svg",
            Self::SquarePen => "icons/square-pen.svg",
        }
        .into()
    }
}

pub(super) fn model_chip(theme: Theme, model: &str, effort: &str) -> AnyElement {
    div()
        .h(theme.composer_meta_chip_height)
        .rounded_md()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .child(icon_svg(IconName::Bot, theme.muted))
        .child(model.to_string())
        .child(effort.to_string())
        .into_any_element()
}

pub(super) fn meta_chip(icon: IconName, label: &str, theme: Theme) -> AnyElement {
    div()
        .h(theme.composer_command_chip_height)
        .rounded_md()
        .px_1()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .child(icon_svg(icon, theme.muted))
        .child(label.to_string())
        .into_any_element()
}

pub(super) fn send_button(theme: Theme) -> AnyElement {
    div()
        .w(px(30.0))
        .h(px(30.0))
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
        .with_size(Size::Size(px(18.0)))
        .text_color(color)
        .into_any_element()
}

pub(super) fn header_icon_svg(icon: IconName, color: gpui::Hsla) -> AnyElement {
    Icon::new(icon)
        .with_size(Size::Size(px(20.0)))
        .text_color(color)
        .into_any_element()
}

pub(super) fn ace_icon_svg(icon: AceIconName, color: gpui::Hsla) -> AnyElement {
    Icon::new(icon)
        .with_size(Size::Size(px(20.0)))
        .text_color(color)
        .into_any_element()
}

pub(super) fn header_ace_icon_svg(icon: AceIconName, color: gpui::Hsla) -> AnyElement {
    Icon::new(icon)
        .with_size(Size::Size(px(22.0)))
        .text_color(color)
        .into_any_element()
}

pub(super) fn icon_tile(icon: IconName, theme: Theme) -> AnyElement {
    div()
        .w(px(28.0))
        .h(px(28.0))
        .rounded_lg()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .flex()
        .items_center()
        .justify_center()
        .child(header_icon_svg(icon, theme.muted))
        .into_any_element()
}

pub(super) fn ace_icon_tile(icon: AceIconName, theme: Theme) -> AnyElement {
    div()
        .w(px(24.0))
        .h(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .child(ace_icon_svg(icon, theme.muted))
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

pub(super) fn ace_icon_toggle_button<F>(
    icon: AceIconName,
    active: bool,
    theme: Theme,
    tooltip: &'static str,
    tooltip_action: impl Action + Clone + 'static,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    let color = if active {
        theme.foreground.opacity(0.86)
    } else {
        theme.muted
    };

    div()
        .id(tooltip)
        .w(px(28.0))
        .h(px(28.0))
        .rounded_lg()
        .flex()
        .items_center()
        .justify_center()
        .bg(if active {
            theme.button
        } else {
            theme.panel_deep.opacity(0.0)
        })
        .text_color(color)
        .hover(|this| this.bg(theme.button).text_color(theme.foreground))
        .child(header_ace_icon_svg(icon, color))
        .tooltip(move |window, cx| {
            Tooltip::new(tooltip)
                .action(&tooltip_action, None)
                .build(window, cx)
        })
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
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

pub(super) fn kbd(label: impl Into<gpui::SharedString>, theme: Theme) -> AnyElement {
    div()
        .rounded_lg()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.background_elevated)
        .px_1()
        .py_1()
        .text_size(px(10.0))
        .text_color(theme.muted_subtle)
        .child(label.into())
        .into_any_element()
}
